/**
 * R27 需求④.2: 记忆整形——一条写入拆成 1..N 条原子记忆。
 *
 * 旧行为把一整段多事实正文塞进一条记忆（召回时只能整条命中，标签被揉成
 * 双字碎片）。本模块在**有模型可用时**把待存正文拆成原子记忆：每条独立
 * title/tags/text，单独判重、单独判定集合归属；无模型、调用失败或答案不可用
 * 时返回 undefined，调用方保持 1 条（与现状完全一致）。
 *
 * Token 护栏：
 * - 先用 {@link mayHoldMultipleFacts} 做零成本预判，明显单条不调用模型；
 * - 每次整形最多一次模型调用，不重试；
 * - 上限 {@link MEMORY_SPLIT_MAX} 条。
 * @module supermemory/memory-split
 */
import { askLlmJson, type LlmJsonDeps } from './llm-json.ts'
import { MEMORY_TEXT_MAX, TITLE_MAX, assessConclusion, deriveTitle, normalizeTags } from './retrieval.ts'

/** Hard cap of atomic entries one write may become. */
export const MEMORY_SPLIT_MAX = 5

/** Below this length a body is treated as one fact without asking the model. */
const MULTI_FACT_MIN_CHARS = 100

/** One atomic memory draft (title + tags + body, the R10 retrieval shape). */
export interface MemoryEntryDraft {
  title: string
  tags: string[]
  text: string
}

/** The caller's own shape, used when the model omits a layer. */
export interface MemorySplitFallback {
  title: string
  tags: readonly string[]
}

/**
 * Zero-cost pre-check: does this body even look like it holds several facts?
 * A short single-sentence conclusion (the common case) never burns a token.
 */
export function mayHoldMultipleFacts(text: string): boolean {
  const clean = String(text ?? '').trim()
  if (Array.from(clean).length < MULTI_FACT_MIN_CHARS) return false
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length >= 2) return true
  const clauses = clean.split(/[。；;！!？?]/).map((clause) => clause.trim()).filter(Boolean)
  return clauses.length >= 3
}

/**
 * Validate the model's answer into atomic drafts. Accepts a bare array or
 * `{entries: [...]}`; every entry keeps only what survives the conclusion
 * rule, and duplicates inside one answer are dropped. Returns undefined when
 * nothing usable remains (caller keeps the single original entry).
 */
export function normalizeSplitResult(
  raw: unknown,
  fallback: MemorySplitFallback,
  max = MEMORY_SPLIT_MAX,
): MemoryEntryDraft[] | undefined {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : undefined)
  if (!Array.isArray(list)) return undefined
  const out: MemoryEntryDraft[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as { title?: unknown; tags?: unknown; text?: unknown }
    const text = String(record.text ?? '').trim().slice(0, MEMORY_TEXT_MAX)
    if (text.length < 2) continue
    // R19 需求⑧: an atomic fragment is still a write — a step log or an
    // overlong chunk is dropped rather than stored as a "memory".
    if (!assessConclusion(text).ok) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const tags = normalizeTags(record.tags)
    const title = String(record.title ?? '').trim().slice(0, TITLE_MAX) || deriveTitle(text)
    out.push({
      title,
      tags: tags.length > 0 ? tags : normalizeTags(fallback.tags),
      text,
    })
    if (out.length >= Math.max(1, max)) break
  }
  return out.length > 0 ? out : undefined
}

const SPLIT_SYSTEM = [
  '你是 SuperMemory 的记忆整形器。用户给出一段待写入的结论材料，请把它拆成多条【原子记忆】：每条只讲一个可独立复用的事实/决策/约定。',
  '只输出一个 JSON 对象，不要代码围栏、不要解释：',
  '{"entries":[{"title":"一句可扫读的结论标题（≤48字）","tags":["3–8个检索短词"],"text":"自包含的一条结论正文"}]}',
  '规则：',
  '- 明显是单条事实时只返回 1 条，不要硬拆；最多 ' + MEMORY_SPLIT_MAX + ' 条。',
  '- 每条必须自包含：脱离原文也读得懂，保留具体命令/路径/端口/版本等关键信息。',
  '- 丢弃派发包装文本、寒暄、命令行片段、版本行、疑问句等非结论内容。',
  '- 标签是检索索引，与正文分离；不要生成「本任/务是」式双字碎片。',
].join('\n')

/**
 * Split one body into atomic entries with the model. Returns undefined — the
 * caller then keeps exactly one entry — when there is no model, the body does
 * not look multi-fact, the call fails, or the answer is unusable.
 */
export async function splitMemoryEntries(
  deps: LlmJsonDeps,
  text: string,
  fallback: MemorySplitFallback,
): Promise<MemoryEntryDraft[] | undefined> {
  const body = String(text ?? '').trim()
  if (!body) return undefined
  if (!mayHoldMultipleFacts(body)) return undefined
  const answer = await askLlmJson(deps, {
    system: SPLIT_SYSTEM,
    user: `待整形材料：\n\n${body}\n\n只返回 JSON。`,
    maxTokens: 900,
  })
  if (answer === undefined) return undefined
  return normalizeSplitResult(answer, fallback)
}

