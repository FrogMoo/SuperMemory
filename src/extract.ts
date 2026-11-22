/**
 * Rule-based fact extraction from user text (P0: no LLM in the loop).
 *
 * Conservative on purpose: only explicit "remember this" instructions and
 * clear "X 是 Y" definitions become memories. Everything else stays out of the
 * memories table — a wrong fact is worse than a missing one, and the hub model
 * can always call memory_remember explicitly.
 *
 * R27 需求④.3 净化（防垃圾再生）：自动抽取曾经把派发包装文本、纯命令行和用户
 * 疑问句写进记忆，标签还是 CJK 双字滑窗的碎片（「本任/务是/是并」）。本模块
 * 因此加了三层守卫：{@link isNonConclusion} 跳过非结论文本，
 * {@link subjectUsable} 要求定义主语有实质字符，{@link keywordsOf} 的 CJK
 * 取词从「逐字双字滑窗」改为「功能字切段取词」。
 * @module supermemory/extract
 */
export interface ExtractedFact {
  text: string
  keywords: string[]
}

const REMEMBER_PATTERNS: RegExp[] = [
  /(?:记住|记一下|请记住|帮忙记住|牢记)[:：\s]+(.{2,200})/,
  /(?:remember|note that|don'?t forget|keep in mind)\b[:：\s]+(.{2,200})/i,
]

const DEFINITION_PATTERNS: RegExp[] = [
  /^([\w\u4e00-\u9fff][\w\u4e00-\u9fff \-_/.]{1,30}?)(?:是|为|等于)(.{4,200})$/,
  /^([\w\u4e00-\u9fff][\w\u4e00-\u9fff \-_/.]{1,30}?)\s+(?:is|are)\s+(.{4,200})$/i,
]

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  '这个', '那个', '这些', '那些', '一下', '什么', '怎么', '如何', '请', '帮我把', '记得',
  '可以', '需要', '已经', '还有', '以及', '之后', '之前', '如果', '因为', '所以',
  '但是', '而且', '并且', '或者', '对于', '关于', '通过', '根据', '按照', '其中',
  '其它', '其他', '是否', '能否', '我们', '你们', '他们',
  '的一', '是一', '是不', '不是',
])

/**
 * CJK 功能字：CJK 关键词按这些字切段（替代逐字双字滑窗）。滑窗会跨词产出
 * 「本任/务是/是并」式碎片，切段取词至少保证每个关键词落在一个词的内部。
 */
const CJK_STOP_CHARS = new Set([...'的了和是在与及或等之于为以对这那又还就都也只再没不很被把将从向让其呢吗吧呀啊哦之乎者也'])
/** 段长上限：更长的段按前几个字截断（避免把整句当一个标签）。 */
const CJK_SEGMENT_MAX = 4
/** CJK 关键词只从前 N 个汉字里取（限制来源，长文不无限产出标签）。 */
const CJK_SOURCE_CHARS = 120
/** CJK 关键词数量上限。 */
const CJK_KEYWORD_MAX = 8

/**
 * 派发/续跑的包装文本与元数据：这些行是插件自己的信封，不是用户结论。
 * （命中任意一条即整条跳过，不再进入任何 pattern。）
 */
const WRAPPER_PATTERNS: RegExp[] = [
  /本任务是并行组/i,
  /并行组的一员/i,
  /只负责这一个任务/i,
  /全部成员到达终态/i,
  /原派发\s*dsp-/i,
  /派发Id/i,
  /dispatchId/i,
  /\bdsp-[a-z0-9]{4,}/i,
  /\bbranch-[a-z0-9]{4,}/i,
  /分支会话[:：]/,
  /supermemory-dispatch/i,
  /越界请汇报/i,
]

/** 命令行头（纯命令行/版本行判定：整行无汉字且以这些词开头）。 */
const COMMAND_HEADS = /^(?:git|pnpm|npm|npx|node|python3?|pip3?|cmd|powershell?|bash|sh|zsh|docker|kubectl|adb|tsc|eslint|prettier|vitest|jest|make|curl|wget|ssh|scp|rsync|sudo|cd|ls|cat|echo|grep|find|rm|cp|mv|mkdir|touch|chmod|chown|export|set|source)\b/i
/** 纯版本行：v1.2.3 / 1.2.3。 */
const VERSION_LINE = /^\s*v?\d+(?:\.\d+)+\s*$/
/** 疑问句尾巴。 */
const QUESTION_END = /[？?]\s*$/
/** 疑问句开头（且句中没有任何陈述动词时才算疑问）。 */
const QUESTION_HEAD = /^(?:怎么|怎样|如何|为什么|为啥|啥|哪些|哪个|哪几|是否|能不能|可不可以|可不可|请问|我想问|想问|问一下|帮忙问|有没有|是不是)/
const STATEMENT_MARK = /(?:是|为|等于|应该是|应当|应该|需要|必须|可以|要用|使用|采用|默认|约定|禁止|不要|支持|一律|务必)/

/** 定义主语必须至少有 2 个汉字或 3 个以上拉丁字符（避免 "1"/"12" 当标题）。 */
function subjectUsable(subject: string): boolean {
  const cjk = (subject.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (cjk >= 2) return true
  return (subject.match(/[a-z0-9]/gi) ?? []).length >= 3
}

/** 纯命令行 / 版本行：去掉可选的行首编号后整行是 ASCII 且以命令词开头。 */
function isCommandLine(line: string): boolean {
  const stripped = line.replace(/^\s*\d{1,2}[.)、]\s*/, '')
  return COMMAND_HEADS.test(stripped) && !/[\u4e00-\u9fff]/.test(stripped)
}

/** 非结论文本：派发包装、纯命令行/版本行、疑问句——一律不进记忆。 */
function isNonConclusion(clean: string): boolean {
  if (WRAPPER_PATTERNS.some((pattern) => pattern.test(clean))) return true
  if (isCommandLine(clean)) return true
  if (VERSION_LINE.test(clean)) return true
  if (QUESTION_END.test(clean)) return true
  return QUESTION_HEAD.test(clean.trim()) && !STATEMENT_MARK.test(clean)
}

/**
 * Extract keywords from a fact text (latin words + CJK segment words).
 *
 * R27: CJK 取词从「逐字双字滑窗」改为「功能字切段取词」——滑窗会跨功能字产出
 * 「本任/务是」式碎片；切段后每个关键词都落在一个词的内部，并限制来源长度
 * （前 {@link CJK_SOURCE_CHARS} 个汉字）与数量（{@link CJK_KEYWORD_MAX} 个）。
 */
export function keywordsOf(text: string): string[] {
  const body = String(text ?? '')
  const latin: string[] = []
  const lower = body.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_+#.\-]{2,}/g)) {
    if (!STOP_WORDS.has(m[0])) latin.push(m[0])
  }
  const chars = (body.match(/[\u4e00-\u9fff]/g) ?? []).slice(0, CJK_SOURCE_CHARS)
  const cjk: string[] = []
  let segment = ''
  const flush = (): void => {
    if (segment.length >= 2) cjk.push(segment.slice(0, CJK_SEGMENT_MAX))
    segment = ''
  }
  for (const char of chars) {
    if (CJK_STOP_CHARS.has(char)) flush()
    else segment += char
  }
  flush()
  return [...new Set([...latin.slice(0, 12), ...cjk.slice(0, CJK_KEYWORD_MAX)])].slice(0, 24)
}

/**
 * Extract memory-worthy facts from one user message.
 * @param text - the user message's plain text.
 * @returns zero or more facts; empty when nothing is memory-worthy.
 */
export function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const clean = raw.trim().replace(/\s+/g, ' ').replace(/["'」』]+$/, '').slice(0, 300)
    if (clean.length < 2) return
    // R27: 派发包装 / 命令行 / 版本行 / 疑问句都不是结论。
    if (isNonConclusion(clean)) return
    const key = clean.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    facts.push({ text: clean, keywords: keywordsOf(clean) })
  }
  for (const pattern of REMEMBER_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    for (const m of text.matchAll(new RegExp(pattern.source, flags))) push(m[1])
  }
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim()
    // Definition patterns only trust SHORT lines: real "X 是 Y" statements are
    // terse, while long prompt/instruction lines produce junk fragments.
    if (!trimmed || trimmed.length > 80) continue
    for (const pattern of DEFINITION_PATTERNS) {
      const m = trimmed.match(pattern)
      // R27: 主语至少要 2 个汉字或 3 个以上拉丁字符，否则 "1"/"12" 也会当标题。
      if (m && subjectUsable(m[1])) push(`${m[1].trim()}是${m[2].trim()}`)
    }
  }
  return facts
}
