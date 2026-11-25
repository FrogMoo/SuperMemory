/**
 * Skill forge (R45): repeated work becomes a REAL DSH skill.
 *
 * 背景：P3 把重复流程编译成 `sm_composite_*` 组合工具——「按什么顺序调哪些
 * 工具」。这类流水线写死在注册表里，容易生成、很难被模型想起来调用。R45 把
 * 重复工作的沉淀改到 DSH 的 skill 机制（`<project>/.dsh/skills/<name>/SKILL.md`，
 * 项目根判定见 dsh-skill-filesystem：最近含 `.git` 的祖先）：技能是给模型看的
 * 「何时用 / 怎么判断 / 有哪些坑」的指导，落在会话每步都可见的 available_skills
 * 目录里（只有 name + description 进目录，正文由 skill 工具按需加载）。
 *
 * 分工：
 * - skill：判断型、易变的重复工作（读哪些文件、先验证什么、失败怎么回退）；
 * - 组合工具：固定参数化的短子序列，保留为向后兼容的「一键入口」；
 * - capability：可执行入口命令（默认预演 + 写操作确认），不变。
 *
 * 文件是事实来源（重启后仍在），tool_memory 的 kind='skill' 行只承载版本号、
 * 使用计数与启用状态（不新增存储表，旧介质保持 v1 兼容）。同名更新 = version+1
 * 并保留 changelog；内容完全一致 = 幂等不升版；检测到人工编辑 = 只更新统计，
 * 绝不覆盖正文。
 * @module supermemory/skill-forge
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Signal, ToolMemory } from './schema.ts'
import type { SequenceSample } from './composite.ts'
import type { Store } from './store.ts'

/** Kebab-case contract enforced by the host skill registry. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Every generated skill carries this prefix (panel/list filter, safe namespace). */
export const SKILL_PREFIX = 'sm-'

/** DSH session catalog description bound (dsh-tool-skill catalogDescriptionMaxLength). */
export const SKILL_DESCRIPTION_MAX = 500

/** Changelog bound (newest first), same spirit as capabilities. */
const SKILL_CHANGELOG_MAX = 20

/**
 * Per-root growth cap for AUTO-generated skills (manual register bypasses it).
 * Without a cap a busy workspace would fixate dozens of sliding-window flows
 * at boot and drown the model's available_skills catalog.
 */
export const SKILL_MAX_PER_ROOT = 12

/** Where this skill record came from. */
export type SkillSourceKind = 'sequence' | 'capability' | 'manual'

export interface SkillSource {
  kind: SkillSourceKind
  /** Durable signal / capability key the draft was derived from. */
  key?: string
  /** Human-readable pattern, e.g. `read → grep → edit`. */
  label: string
  /** How many times the transaction was observed. */
  occurrences: number
}

/** One human-editable skill draft (rendered to SKILL.md). */
export interface SkillDraft {
  name: string
  title: string
  /** Catalog routing description: short, specific, "when to use". */
  description: string
  /** Optional extra routing guidance (frontmatter whenToUse). */
  whenToUse?: string
  tags: string[]
  /** Markdown body WITHOUT YAML frontmatter. */
  body: string
  source: SkillSource
  /** Facts rendered into the body (kept for assertions / manual register). */
  facts?: {
    commands: string[]
    files: string[]
    patterns: string[]
  }
}

/** Frontmatter + body parsed back from one SKILL.md. */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  enabled: boolean
  version: number
  updatedAt: number
  source?: string
  occurrences: number
  /** Hash of the generated body we last wrote (detects human edits). */
  renderedHash?: string
  changelog: string[]
  body: string
}

/** One row the panel renders. */
export interface SkillView {
  name: string
  title: string
  description: string
  whenToUse?: string
  version: number
  useCount: number
  enabled: boolean
  status: 'active' | 'retired'
  path: string
  source?: string
  occurrences: number
  updatedAt: number
  changelog: string[]
}

export interface SkillRootInfo {
  root: string
  /** project = <git root>/.dsh/skills (rank 100, workspace-scoped). */
  scope: 'project' | 'user'
  /** user scope is shared by every workspace → names carry a workspace token. */
  shared: boolean
  note: string
}

export interface SkillWriteResult {
  status: 'created' | 'updated' | 'unchanged' | 'preserved' | 'error'
  name: string
  version: number
  path?: string
  message: string
}

/** Reserved frontmatter keys (host ignores unknown metadata keys). */
const META = {
  version: 'sm-version',
  updatedAt: 'sm-updated-at',
  source: 'sm-source',
  occurrences: 'sm-occurrences',
  renderedHash: 'sm-rendered-hash',
  changelog: 'sm-changelog',
  enabled: 'sm-enabled',
} as const

/** Short deterministic hash (FNV-1a, base36) for stable names. */
export function shortHash(text: string, length = 6): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(Math.max(1, Math.min(8, length)), '0').slice(0, length)
}

/** Lower-case ASCII slug; empty when the source has no ASCII letters/digits. */
export function kebabCase(text: string, max = 40): string {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max)
  const boundary = cut.lastIndexOf('-')
  return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/g, '')
}

/** Clamp a name to the host's 64-ish practical bound without splitting a word. */
function clampName(name: string, max = 64): string {
  if (name.length <= max) return name
  const cut = name.slice(0, max)
  const boundary = cut.lastIndexOf('-')
  return (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/g, '')
}

/** True when the name satisfies the host's kebab-case contract. */
export function isSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && name.startsWith(SKILL_PREFIX)
}

/** `sm-flow-read-grep-edit-<hash>` — stable for one tool sequence. */
export function skillNameForFlow(tools: string[], sharedToken?: string): string {
  const parts = tools.map((tool) => kebabCase(tool.replace(/^sm_composite_/, ''), 12) || 'tool').join('-')
  const base = 'sm-flow-' + (parts || 'flow') + '-' + shortHash(tools.join('>'))
  return clampName(sharedToken ? 'sm-' + sharedToken + '-' + base.slice(3) : base)
}

/** `sm-cap-<capability-name>` — stable for one capability registration. */
export function skillNameForCapability(name: string, sharedToken?: string): string {
  const slug = kebabCase(name, 32) || 'capability'
  return clampName('sm-' + (sharedToken ? sharedToken + '-cap-' : 'cap-') + slug)
}

/** Name token that keeps the shared user-level skill dir workspace-isolated. */
export function workspaceSkillToken(workspaceKey: string): string {
  return 'ws' + shortHash(workspaceKey, 5)
}

/** Title of a repeated flow, readable in the catalog and the panel. */
export function flowTitle(tools: string[]): string {
  return tools.join(' → ') + ' 重复流程'
}

/** One-line step hint (tool semantics, not a command log). */
function stepHint(tool: string): string {
  const hints: Record<string, string> = {
    read: '读取目标文件，确认现状再改',
    write: '整文件写入前先 read，避免覆盖他人改动',
    edit: '只做精确替换，保留并发改动',
    glob: '先枚举候选文件',
    grep: '先定位，避免盲改',
    bash: '记录 exit code 与 stderr；失败先查原因',
    todo_write: '多步任务先列清单',
    memory_recall: '先检索既有结论，避免重复劳动',
    memory_remember: '只记结论，不记过程流水账',
    memory_dispatch: '把实质工作派发到分支会话',
    memory_scan: '刷新项目文件地图',
    skill: '加载对应 skill 的完整指导',
    present: '交付产物给用户',
    web_search: '先搜外部事实，再落地',
    web_fetch: '读取具体来源并引用 URL',
  }
  return hints[tool] ?? '按工具契约执行'
}

/** Extract human-relevant facts from recorded samples (no secrets copied). */
export function extractWorkflowFacts(samples: SequenceSample[]): { commands: string[]; files: string[]; patterns: string[] } {
  const commands = new Set<string>()
  const files = new Set<string>()
  const patterns = new Set<string>()
  const push = (set: Set<string>, value: unknown): void => {
    if (typeof value !== 'string') return
    const text = value.trim()
    if (!text || text.length > 200) return
    set.add(text)
  }
  for (const sample of samples) {
    sample.tools.forEach((tool, index) => {
      const args = sample.args[index] ?? {}
      if (tool === 'bash') {
        push(commands, args.command)
        push(commands, args.description)
      } else if (tool === 'grep' || tool === 'glob') {
        push(patterns, args.pattern)
      } else if (tool === 'read' || tool === 'edit' || tool === 'write') {
        push(files, args.file_path ?? args.path)
      }
    })
  }
  return {
    commands: [...commands].slice(0, 8),
    files: [...files].slice(0, 10),
    patterns: [...patterns].slice(0, 6),
  }
}

/** Pitfalls justified by the tools actually used. */
export function derivePitfalls(tools: string[]): string[] {
  const pitfalls: string[] = []
  if (tools.includes('bash')) pitfalls.push('bash 失败先看 exit code 与 stderr；不要为了「重试」再执行一次有副作用的命令。')
  if (tools.includes('edit') || tools.includes('write')) pitfalls.push('先 read 再 edit/write；并行工作区里只做精确编辑，禁止整文件覆盖他人改动。')
  if (tools.includes('grep') || tools.includes('glob')) pitfalls.push('空结果不等于不存在：换关键词，或直接 read 目标文件核对。')
  if (tools.some((tool) => tool.startsWith('memory_'))) pitfalls.push('先 memory_recall 取既有结论，避免把已经做过的调查再做一遍。')
  pitfalls.push('重复出现 ≠ 每次都套模板：工具、顺序或参数形态变了就按新情况判断。')
  pitfalls.push('skill 只提供判断与步骤，不免除写操作的确认与验证。')
  return pitfalls.slice(0, 6)
}

/** Markdown body for one repeated flow (human-editable, no command dumps). */
export function renderSkillBody(draft: SkillDraft): string {
  const tools = draft.source.label.split(' → ').map((part) => part.trim()).filter(Boolean)
  const facts = draft.facts ?? { commands: [], files: [], patterns: [] }
  const lines: string[] = []
  lines.push('# ' + draft.title)
  lines.push('')
  lines.push('> 由 SuperMemory 从重复事务自动沉淀（' + draft.source.label + '，已多次出现）。'
    + '可以手工编辑：再次识别到同一事务时只更新统计，不会覆盖人工修改。')
  lines.push('')
  lines.push('## 何时用（触发条件）')
  lines.push('')
  lines.push('- 任务需要按 **' + tools.join(' → ') + '** 的顺序反复完成同类改动时。')
  lines.push('- 近期多次出现过同一组合，说明是重复事务而不是一次性操作。')
  lines.push('- 只要有一步的工具或顺序明显不同，就不要套用本 skill（见「反例」）。')
  lines.push('')
  lines.push('## 决策清单')
  lines.push('')
  lines.push('1. 先确认这次是否真的是同类事务：对照「步骤纲要」的工具与参数形态，不要只看任务标题。')
  lines.push('2. 有更具体的 skill / 可执行能力（capability）时优先用它们；本 skill 只补充判断与步骤经验。')
  lines.push('3. 执行中若第 2 步就需要换路（文件不存在、命令失败），停下按「关键坑」处理，不要机械跑完。')
  lines.push('4. 完成后按「验证方式」核对，再把新发现的坑补进本文件（同名更新会升版并保留 changelog）。')
  lines.push('')
  lines.push('## 步骤纲要')
  lines.push('')
  tools.forEach((tool, index) => {
    lines.push((index + 1) + '. `' + tool + '` — ' + stepHint(tool) + '。')
  })
  if (facts.commands.length > 0) {
    lines.push('')
    lines.push('### 记录到的命令（历史样本，按需复用）')
    lines.push('')
    for (const command of facts.commands) lines.push('- `' + command.replace(/`/g, '\\`') + '`')
  }
  if (facts.files.length > 0) {
    lines.push('')
    lines.push('### 涉及文件（历史样本）')
    lines.push('')
    for (const file of facts.files) lines.push('- `' + file.replace(/`/g, '\\`') + '`')
  }
  if (facts.patterns.length > 0) {
    lines.push('')
    lines.push('### 检索模式（历史样本）')
    lines.push('')
    for (const pattern of facts.patterns) lines.push('- `' + pattern.replace(/`/g, '\\`') + '`')
  }
  lines.push('')
  lines.push('## 关键坑')
  lines.push('')
  for (const pitfall of derivePitfalls(tools)) lines.push('- ' + pitfall)
  lines.push('')
  lines.push('## 验证方式')
  lines.push('')
  if (tools.includes('edit') || tools.includes('write')) lines.push('- 改动后用 typecheck / 相关 smoke 或最小复现验证，别只看「命令退出 0」。')
  else lines.push('- 用可观察的结果核对（文件内容、命令输出、测试结果），不要凭印象宣称完成。')
  lines.push('- 若任务有既有闸门命令（如 `pnpm typecheck`、`pnpm smoke`），按仓库约定跑并记录结果。')
  lines.push('')
  lines.push('## 反例（不要这样用）')
  lines.push('')
  lines.push('- 一次性任务、或步骤顺序不同：不要强行套用本 skill。')
  lines.push('- 工具参数形态明显不同（不同仓库/目录/对象）：先确认适用性，再决定是否复用。')
  lines.push('- 把 skill 当成免确认的写操作快捷方式：写操作仍需按原流程确认与验证。')
  lines.push('')
  lines.push('## 调用与命中统计')
  lines.push('')
  lines.push('- 事务出现次数：由插件写入 frontmatter 的 sm-occurrences（面板可见），正文不随计数变化。')
  lines.push('- 模型加载次数：由插件在调用 skill 工具时累加（面板「设置 → 已生成的 skills」）。')
  lines.push('- 最近识别时间：见 frontmatter 的 sm-updated-at（插件更新，正文不随时间变化）。')
  return lines.join('\n')
}

/** Full SKILL.md text: YAML frontmatter + body. */
export function renderSkillMarkdown(draft: SkillDraft, meta: { version: number; updatedAt: number; renderedHash: string; changelog: string[]; enabled: boolean }): string {
  const q = (value: string): string => JSON.stringify(String(value ?? ''))
  const lines = [
    '---',
    'name: ' + draft.name,
    'description: ' + q(clipDescription(draft.description)),
    ...(draft.whenToUse ? ['whenToUse: ' + q(clipDescription(draft.whenToUse))] : []),
    'disable-model-invocation: ' + String(!meta.enabled),
    META.enabled + ': ' + String(meta.enabled),
    META.version + ': ' + String(meta.version),
    META.updatedAt + ': ' + String(meta.updatedAt),
    META.source + ': ' + q(draft.source.kind),
    META.occurrences + ': ' + String(Math.max(0, draft.source.occurrences)),
    META.renderedHash + ': ' + q(meta.renderedHash),
    META.changelog + ': ' + JSON.stringify(meta.changelog.slice(0, SKILL_CHANGELOG_MAX)),
    '---',
    '',
    draft.body.trim(),
    '',
  ]
  return lines.join('\n')
}

/** Description clamp shared by the catalog and the panel. */
export function clipDescription(text: string, max = SKILL_DESCRIPTION_MAX): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(1, max - 1)).replace(/[\s,，;；]\S*$/, '') + '…'
}

/** Parse one SKILL.md (missing/invalid metadata never throws). */
export function parseSkillMarkdown(text: string, fallbackName = ''): ParsedSkill | undefined {
  const raw = String(text ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return undefined
  const fields = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  const str = (key: string): string | undefined => {
    const value = fields.get(key)
    if (value === undefined) return undefined
    if (value.startsWith('"')) {
      try { return String(JSON.parse(value)) } catch { return value.replace(/^"|"$/g, '') }
    }
    return value
  }
  const num = (key: string, fallback: number): number => {
    const value = Number(fields.get(key))
    return Number.isFinite(value) ? value : fallback
  }
  const name = str('name') ?? fallbackName
  const description = str('description')
  if (!name || !SKILL_NAME_RE.test(name) || description === undefined) return undefined
  let changelog: string[] = []
  const rawChangelog = fields.get(META.changelog)
  if (rawChangelog) {
    try {
      const parsed = JSON.parse(rawChangelog) as unknown
      if (Array.isArray(parsed)) changelog = parsed.map((entry) => String(entry)).slice(0, SKILL_CHANGELOG_MAX)
    } catch { /* keep [] */ }
  }
  return {
    name,
    description,
    ...(str('whenToUse') ? { whenToUse: str('whenToUse') } : {}),
    enabled: fields.get('disable-model-invocation') !== 'true' && fields.get(META.enabled) !== 'false',
    version: num(META.version, 1),
    updatedAt: num(META.updatedAt, 0),
    ...(str(META.source) ? { source: str(META.source) } : {}),
    occurrences: num(META.occurrences, 0),
    ...(str(META.renderedHash) ? { renderedHash: str(META.renderedHash) } : {}),
    changelog,
    body: raw.slice(match[0].length).trim(),
  }
}

/** Content hash used to detect human edits (body only; metadata excluded). */
export function skillContentHash(description: string, body: string): string {
  return shortHash(description.trim() + '\u0000' + body.trim(), 8)
}

/** Nearest ancestor containing `.git` (the host's project-root rule). */
export function findProjectRoot(cwd: string): string | undefined {
  let dir = resolve(cwd)
  for (let depth = 0; depth < 24; depth += 1) {
    try {
      if (existsSync(join(dir, '.git'))) return dir
    } catch { /* unreadable ancestor */ }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Resolve the skill root for one workspace.
 *
 * Priority mirrors the host provider: `<projectRoot>/.dsh/skills` (rank 100) is
 * workspace-scoped, so a git workspace needs no name prefix. Without a git
 * root the user-level `<dshHome>/skills` is shared by every workspace, so
 * generated names carry a workspace token (isolation by namespace).
 */
export function resolveSkillRoot(cwd?: string, dshHome?: string): SkillRootInfo {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const projectRoot = cwd ? findProjectRoot(cwd) : undefined
  if (projectRoot) {
    return {
      root: join(projectRoot, '.dsh', 'skills'),
      scope: 'project',
      shared: false,
      note: '项目级 skill 目录（<仓库根>/.dsh/skills，宿主本地发现的最高优先级，按工作区隔离）',
    }
  }
  return {
    root: join(home, 'skills'),
    scope: 'user',
    shared: true,
    note: '用户级 skill 目录（<DSH_HOME>/skills；无 git 工作区共用，靠 sm-ws<token>- 前缀隔离）',
  }
}

/** Durable row key for one generated skill. */
export function skillRowKey(workspaceKey: string, name: string): string {
  return 'ws/' + workspaceKey + '/skill/' + name
}

/** Build a draft from one durable repeated-tool signal. */
export function draftSkillFromSignal(
  signal: Signal,
  samples: SequenceSample[],
  options: { sharedToken?: string } = {},
): SkillDraft | undefined {
  const tools = (signal.sequence ?? []).filter((tool) => typeof tool === 'string' && tool.length > 0)
  if (tools.length < 2) return undefined
  const facts = extractWorkflowFacts(samples)
  const name = skillNameForFlow(tools, options.sharedToken)
  const label = tools.join(' → ')
  const description = clipDescription('当任务需要按 ' + label + ' 的顺序反复处理同类改动时加载：含触发条件、决策清单、步骤纲要、关键坑与验证方式（自动化沉淀的重复事务）。')
  return {
    name,
    title: flowTitle(tools),
    description,
    whenToUse: '重复出现 ' + label + ' 组合、且本次任务的工具与顺序相近时；一次性任务或顺序不同则不要套用。',
    tags: ['skill', 'flow', ...tools.slice(0, 4)],
    body: renderSkillBody({
      name, title: flowTitle(tools), description, tags: [], body: '', source: {
        kind: 'sequence',
        key: signal.workspaceKey ? 'ws/' + signal.workspaceKey + '/seq/' + tools.join('>') : undefined,
        label,
        occurrences: Math.max(1, signal.count),
      },
      facts,
    }),
    source: {
      kind: 'sequence',
      key: signal.workspaceKey ? 'ws/' + signal.workspaceKey + '/seq/' + tools.join('>') : undefined,
      label,
      occurrences: Math.max(1, signal.count),
    },
    facts,
  }
}

/** Minimal capability shape skill-forge reads from a tool_memory row. */
interface CapabilityRowSpec {
  name?: string
  kind?: string
  title?: string
  description?: string
  entry?: string
  doc?: string
  scope?: string
  routeNote?: string
  dryRunArg?: string
  writeConfirm?: boolean
  version?: number
}

/** Build a routing skill for a repeated CAPABILITY execution (task type). */
export function draftSkillFromCapability(
  spec: CapabilityRowSpec,
  useCount: number,
  options: { sharedToken?: string } = {},
): SkillDraft | undefined {
  const name = String(spec.name ?? '').trim()
  if (!name) return undefined
  const title = String(spec.title ?? name)
  const entry = String(spec.entry ?? '').trim()
  const label = title
  const whenToUse = '再次遇到「' + title + '」类重复事务、且已有能力入口 ' + (entry || name) + ' 时加载；先预演、再按写操作确认规则实跑。'
  const description = clipDescription('遇到「' + title + '」类重复工作时加载：入口 ' + (entry || name) + '、预演/确认规则、关键坑与验证方式（已反复执行）。')
  const facts = { commands: entry ? [entry] : [], files: [], patterns: [] }
  const body = [
    '# ' + title,
    '',
    '> 由 SuperMemory 从重复执行的能力沉淀（已反复执行）。能力本身仍由 sm_composite_* 工具一键执行；本 skill 说明何时优先用它、以及失败时怎么判断。',
    '',
    '## 何时用（触发条件）',
    '',
    '- 任务属于「' + title + '」这一类，且已有能力入口 `' + (entry || name) + '`。',
    '- 需要先看计划、再决定是否真实执行（默认预演）。',
    '',
    '## 决策清单',
    '',
    '1. 先运行能力默认预演（' + (spec.dryRunArg || '若定义') + '），看输出与退出码。',
    '2. ' + (spec.writeConfirm ? '真实执行可能写远端/改状态：必须显式 confirm=true；不要绕过确认。' : '确认预演结果符合预期后再实跑。'),
    '3. 连续失败时不要手敲同一串命令绕过能力：用 memory_toolize register 同名更新能力或修订文档（version+1、changelog 记录原因）。',
    '4. 完成后按「验证方式」核对，并把新坑补进 ' + (spec.doc || '文档') + '。',
    '',
    '## 步骤纲要',
    '',
    '1. `' + (entry || name) + '` — 入口命令（在 ' + (spec.scope || '适用范围') + ' 内执行）。',
    '2. 预演 → 确认 → 实跑；失败按「关键坑」处理。',
    '',
    '## 关键坑',
    '',
    '- 能力未生效时先确认当前工作区在适用范围（' + (spec.scope || '未声明') + '）内。',
    '- 预演参数缺失而能力标记了写操作确认时，能力会拒绝预演；这不是故障。',
    '- 不要为了「快」跳过 dry-run 或 confirm 闸门。',
    '',
    '## 验证方式',
    '',
    '- 看能力返回的 exitCode / stdout / stderr，而不是只看「命令似乎跑了」。',
    '- 文档与现状不符时更新 ' + (spec.doc || '文档') + ' 并升版。',
    '',
    '## 反例（不要这样用）',
    '',
    '- 一次性任务或不同工作区：不要套用本 skill 的入口。',
    '- 能力连续失败仍反复执行：先更新能力定义或文档，不要绕过。',
    '',
    '## 调用与命中统计',
    '',
    '- 能力执行次数：' + Math.max(1, useCount) + '。',
    '- 模型加载次数：由插件在 skill 工具调用时累加。',
  ].join('\n')
  return {
    name: skillNameForCapability(name, options.sharedToken),
    title,
    description,
    whenToUse,
    tags: ['skill', 'capability', ...(spec.scope ? [kebabCase(spec.scope, 20)].filter(Boolean) : [])],
    body,
    facts,
    source: { kind: 'capability', key: 'capability/' + name, label, occurrences: Math.max(1, useCount) },
  }
}

/**
 * Repeated-transaction detection: durable tool-sequence signals plus
 * capability rows whose execution count crossed the threshold. Pure read.
 */
export function detectRepeatedTransactions(
  store: Store,
  workspaceKey: string,
  options: { threshold: number; capabilityThreshold?: number; sharedToken?: string },
): SkillDraft[] {
  const threshold = Math.max(1, options.threshold)
  const capThreshold = Math.max(1, options.capabilityThreshold ?? threshold)
  const drafts: SkillDraft[] = []
  const seen = new Set<string>()
  for (const [, signal] of store.signals.entries()) {
    if (signal.workspaceKey !== workspaceKey) continue
    if (signal.count < threshold) continue
    if (signal.pattern.startsWith('nearmiss:')) continue
    const tools = signal.sequence ?? []
    if (tools.length < 2 || tools.length > 8) continue
    const draft = draftSkillFromSignal(signal, parseSamples(signal.samples ?? []), { sharedToken: options.sharedToken })
    if (!draft || seen.has(draft.name)) continue
    seen.add(draft.name)
    drafts.push(draft)
  }
  for (const [, record] of store.toolMemory.entries()) {
    if (record.kind !== 'composite') continue
    if (record.status !== 'active' || record.useCount < capThreshold) continue
    let spec: CapabilityRowSpec
    try {
      spec = JSON.parse(record.entry) as CapabilityRowSpec
    } catch { continue }
    if (spec.kind !== 'capability') continue
    if (record.workspaceKey && record.workspaceKey !== workspaceKey) continue
    const draft = draftSkillFromCapability(spec, record.useCount, { sharedToken: options.sharedToken })
    if (!draft || seen.has(draft.name)) continue
    seen.add(draft.name)
    drafts.push(draft)
  }
  return drafts.sort((left, right) => right.source.occurrences - left.source.occurrences)
}

/** Parse durable signal samples (broken entries skipped). */
function parseSamples(raw: string[]): SequenceSample[] {
  const out: SequenceSample[] = []
  for (const entry of raw) {
    try {
      const parsed = JSON.parse(entry) as SequenceSample
      if (parsed && Array.isArray(parsed.tools) && Array.isArray(parsed.args)) out.push(parsed)
    } catch { /* one broken sample is skipped */ }
  }
  return out
}

/** Read every generated skill bundle under one root. */
export function readSkillFiles(root: string): Array<{ name: string; path: string; parsed: ParsedSkill }> {
  const out: Array<{ name: string; path: string; parsed: ParsedSkill }> = []
  if (!existsSync(root)) return out
  let entries: string[]
  try { entries = readdirSync(root) } catch { return out }
  for (const entry of entries) {
    if (!entry.startsWith(SKILL_PREFIX)) continue
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch { continue }
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const parsed = parseSkillMarkdown(text, entry)
    if (!parsed) continue
    out.push({ name: parsed.name, path: file, parsed })
  }
  return out
}

/** Atomic-ish write: temp file in the same directory, then rename. */
function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** Find one generated skill by name under a root. */
export function findSkillFile(root: string, name: string): { path: string; parsed: ParsedSkill } | undefined {
  // Never let a caller-supplied name escape the skill root (panel/tool input).
  if (!isSkillName(name)) return undefined
  const file = join(root, name, 'SKILL.md')
  if (!existsSync(file)) return undefined
  try {
    const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'), name)
    return parsed ? { path: file, parsed } : undefined
  } catch {
    return undefined
  }
}

/**
 * Write/update one skill. The FILE is authoritative; the store row only mirrors
 * version/useCount/status.
 *
 * - created: first write, version 1;
 * - unchanged: identical description+body → no write, no version bump (幂等);
 * - preserved: the current body differs from what we generated last time
 *   (human edit) → keep the human body, update statistics only;
 * - updated: content changed by a newer draft → version+1 + changelog.
 */
export async function persistSkillDraft(
  store: Store,
  workspaceKey: string,
  draft: SkillDraft,
  options: { root: string; now?: number; changelog?: string },
): Promise<SkillWriteResult> {
  if (!isSkillName(draft.name)) {
    return { status: 'error', name: draft.name, version: 0, message: 'skill 名不是合法 kebab-case：' + draft.name }
  }
  const now = options.now ?? Date.now()
  const key = skillRowKey(workspaceKey, draft.name)
  const row = store.toolMemory.get(key)
  const existing = findSkillFile(options.root, draft.name)
  const body = draft.body.trim()
  const description = clipDescription(draft.description)
  const nextHash = skillContentHash(description, body)
  let version = Math.max(existing?.parsed.version ?? 0, 1)
  let changelog = existing?.parsed.changelog ?? []
  const useCount = row?.useCount ?? 0
  const path = join(options.root, draft.name, 'SKILL.md')

  if (existing) {
    const same = existing.parsed.description === description && existing.parsed.body === body
    if (same) {
      // Idempotent: the DEFINITION did not change. Statistics may still move
      // (occurrences / updatedAt), so refresh those frontmatter fields without
      // a version bump; the body and changelog stay byte-identical.
      if (existing.parsed.occurrences !== Math.max(0, draft.source.occurrences)) {
        try {
          writeFileAtomic(path, renderSkillMarkdown({ ...draft, description }, {
            version, updatedAt: now, renderedHash: nextHash, changelog, enabled: existing.parsed.enabled,
          }))
        } catch { /* statistics are advisory; keep the existing file */ }
      }
      await putSkillRow(store, key, workspaceKey, draft, path, useCount, version, row?.createdAt ?? now, existing.parsed.enabled ? 'active' : 'retired')
      return { status: 'unchanged', name: draft.name, version, path, message: '内容相同，未升版。' }
    }
    const humanEdited = Boolean(existing.parsed.renderedHash)
      && existing.parsed.renderedHash !== skillContentHash(existing.parsed.description, existing.parsed.body)
    if (humanEdited) {
      // Human edits win: statistics only, body/description untouched.
      await putSkillRow(store, key, workspaceKey, { ...draft, description: existing.parsed.description }, path, useCount, version, row?.createdAt ?? now, existing.parsed.enabled ? 'active' : 'retired')
      return { status: 'preserved', name: draft.name, version, path, message: '检测到人工编辑，保留正文，仅更新统计。' }
    }
    version += 1
    changelog = [versionLine(version, options.changelog ?? '重复事务有新样本，刷新生成内容'), ...changelog].slice(0, SKILL_CHANGELOG_MAX)
  } else {
    version = Math.max(1, version)
    changelog = [versionLine(version, options.changelog ?? ('首次生成（' + draft.source.label + '，出现 ' + draft.source.occurrences + ' 次）')), ...changelog].slice(0, SKILL_CHANGELOG_MAX)
  }
  try {
    writeFileAtomic(path, renderSkillMarkdown({ ...draft, description }, { version, updatedAt: now, renderedHash: nextHash, changelog, enabled: true }))
  } catch (error) {
    return { status: 'error', name: draft.name, version, path, message: '写入 SKILL.md 失败：' + String(error).slice(0, 160) }
  }
  await putSkillRow(store, key, workspaceKey, draft, path, useCount, version, row?.createdAt ?? now, 'active')
  return { status: existing ? 'updated' : 'created', name: draft.name, version, path, message: existing ? '已升版。' : '已生成。' }
}

function versionLine(version: number, note: string): string {
  return 'v' + version + ': ' + note
}

/** Upsert the durable mirror row (kind='skill'; never touched by composites). */
async function putSkillRow(
  store: Store,
  key: string,
  workspaceKey: string,
  draft: SkillDraft,
  path: string,
  useCount: number,
  version: number,
  createdAt: number,
  status: 'active' | 'retired',
): Promise<void> {
  // NOTE: tool_memory's schema has no version/updatedAt fields (zod strips unknown
  // keys), so the FILE stays authoritative for version/changelog. The row only
  // mirrors what the panel needs: title/tags/description/path/useCount/status.
  const row: ToolMemory = {
    workspaceKey,
    kind: 'skill',
    title: draft.title,
    tags: draft.tags.slice(0, 8),
    trigger: draft.source.key ?? ('skill/' + draft.name),
    description: clipDescription(draft.description),
    entry: path,
    useCount,
    status,
    createdAt,
  }
  await store.toolMemory.put(key, row)
}

/**
 * Sync every detected repeated transaction into skill files. Returns the drafts
 * and per-draft results; one broken skill never blocks the rest.
 */
export async function syncRepeatedTransactions(
  store: Store,
  workspaceKey: string,
  scope: SkillRootInfo,
  options: { threshold: number; capabilityThreshold?: number; now?: number },
): Promise<{ drafts: SkillDraft[]; results: SkillWriteResult[] }> {
  const sharedToken = scope.shared ? workspaceSkillToken(workspaceKey) : undefined
  const drafts = detectRepeatedTransactions(store, workspaceKey, {
    threshold: options.threshold,
    ...(options.capabilityThreshold !== undefined ? { capabilityThreshold: options.capabilityThreshold } : {}),
    ...(sharedToken ? { sharedToken } : {}),
  })
  const results: SkillWriteResult[] = []
  // Shared with persistSequenceSkill: cap NEW names at boot-sweep time too.
  let fileCount = readSkillFiles(scope.root).filter((entry) => !scope.shared || entry.name.startsWith('sm-' + workspaceSkillToken(workspaceKey) + '-')).length
  for (const draft of drafts) {
    try {
      if (!findSkillFile(scope.root, draft.name)) {
        if (fileCount >= SKILL_MAX_PER_ROOT) continue
        fileCount += 1
      }
      results.push(await persistSkillDraft(store, workspaceKey, draft, { root: scope.root, ...(options.now !== undefined ? { now: options.now } : {}) }))
    } catch (error) {
      results.push({ status: 'error', name: draft.name, version: 0, message: String(error).slice(0, 160) })
    }
  }
  return { drafts, results }
}

/**
 * Convenience entry for the runtime hooks: persist one repeated tool sequence
 * as a skill. Returns undefined for sequences that are not worth a skill.
 */
export async function persistSequenceSkill(
  store: Store,
  workspaceKey: string,
  tools: string[],
  samples: SequenceSample[],
  occurrences: number,
  options: { root?: string; shared?: boolean; now?: number } = {},
): Promise<SkillWriteResult | undefined> {
  if (tools.length < 2) return undefined
  // A session without cwd has workspaceKey 'unknown'; never let it fall through
  // to the process cwd and write into whatever repository the host was started in.
  if (!options.root && (!workspaceKey || workspaceKey === 'unknown')) return undefined
  const scope = options.root
    ? { root: options.root, scope: 'project' as const, shared: Boolean(options.shared), note: '' }
    : resolveSkillRoot(workspaceKey)
  const signal: Signal = {
    workspaceKey,
    pattern: tools.join('>'),
    count: Math.max(1, occurrences),
    lastSeen: Date.now(),
    examples: [tools.join(' → ')],
    sequence: tools,
    samples: [],
  }
  const draft = draftSkillFromSignal(signal, samples, scope.shared ? { sharedToken: workspaceSkillToken(workspaceKey) } : {})
  if (!draft) return undefined
  // Auto growth cap: updating an existing skill is always allowed; a NEW name
  // beyond the cap is skipped (manual register still works).
  if (!findSkillFile(scope.root, draft.name) && readSkillFiles(scope.root).length >= SKILL_MAX_PER_ROOT) return undefined
  return persistSkillDraft(store, workspaceKey, draft, {
    root: scope.root,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
}

/** List generated skills of one workspace (files first, store row overlaid). */
export function listSkills(store: Store, workspaceKey: string, scope: SkillRootInfo): SkillView[] {
  const token = scope.shared ? workspaceSkillToken(workspaceKey) : undefined
  const views: SkillView[] = []
  for (const entry of readSkillFiles(scope.root)) {
    if (token && !entry.name.startsWith('sm-' + token + '-')) continue
    const key = skillRowKey(workspaceKey, entry.name)
    const row = store.toolMemory.get(key)
    views.push({
      name: entry.parsed.name,
      title: row?.title || entry.parsed.name,
      description: entry.parsed.description,
      ...(entry.parsed.whenToUse ? { whenToUse: entry.parsed.whenToUse } : {}),
      version: entry.parsed.version,
      useCount: row?.useCount ?? 0,
      enabled: entry.parsed.enabled,
      status: row?.status === 'retired' ? 'retired' : 'active',
      path: entry.path,
      ...(entry.parsed.source ? { source: entry.parsed.source } : {}),
      occurrences: entry.parsed.occurrences,
      updatedAt: entry.parsed.updatedAt,
      changelog: entry.parsed.changelog,
    })
  }
  return views.sort((left, right) => left.name.localeCompare(right.name))
}

/** Rewrite one file's frontmatter in place (body preserved). */
function rewriteFrontmatter(file: string, parsed: ParsedSkill, patch: { enabled?: boolean; description?: string; whenToUse?: string; changelogLine?: string }): ParsedSkill {
  const version = parsed.version + 1
  const changelog = [versionLine(version, patch.changelogLine ?? '更新 skill 元数据'), ...parsed.changelog].slice(0, SKILL_CHANGELOG_MAX)
  const description = clipDescription(patch.description ?? parsed.description)
  // Keep the generator's last body hash: metadata-only rewrites must not
  // "adopt" a human-edited body as generated (otherwise a later auto update
  // would be allowed to overwrite the human text).
  const renderedHash = parsed.renderedHash ?? skillContentHash(description, parsed.body)
  const text = renderSkillMarkdown({
    name: parsed.name,
    title: parsed.name,
    description,
    ...(patch.whenToUse ?? parsed.whenToUse ? { whenToUse: patch.whenToUse ?? parsed.whenToUse } : {}),
    tags: [],
    body: parsed.body,
    source: { kind: (parsed.source as SkillSourceKind) ?? 'manual', label: parsed.source ?? 'manual', occurrences: parsed.occurrences },
  }, {
    version,
    updatedAt: Date.now(),
    renderedHash,
    changelog,
    enabled: patch.enabled ?? parsed.enabled,
  })
  writeFileAtomic(file, text)
  const reparsed = parseSkillMarkdown(text, parsed.name)
  if (!reparsed) throw new Error('回写后的 SKILL.md 解析失败')
  return reparsed
}

/** Enable/disable one generated skill (host honors disable-model-invocation). */
export async function setSkillEnabled(
  store: Store,
  workspaceKey: string,
  scope: SkillRootInfo,
  name: string,
  enabled: boolean,
): Promise<SkillWriteResult> {
  if (!isSkillName(name)) return { status: 'error', name, version: 0, message: 'skill 名不合法：' + name }
  const found = findSkillFile(scope.root, name)
  if (!found) return { status: 'error', name, version: 0, message: '找不到该 skill 文件：' + name }
  try {
    const parsed = rewriteFrontmatter(found.path, found.parsed, {
      enabled,
      changelogLine: enabled ? '启用（模型可见）' : '停用（模型不可见）',
    })
    const key = skillRowKey(workspaceKey, name)
    const row = store.toolMemory.get(key)
    if (row) await store.toolMemory.update(key, (record) => ({ ...record, status: enabled ? 'active' : 'retired' }))
    return { status: 'updated', name, version: parsed.version, path: found.path, message: enabled ? '已启用。' : '已停用。' }
  } catch (error) {
    return { status: 'error', name, version: 0, message: '更新失败：' + String(error).slice(0, 160) }
  }
}

/** Update the routing description of one generated skill. */
export async function updateSkillDescription(
  store: Store,
  workspaceKey: string,
  scope: SkillRootInfo,
  name: string,
  description: string,
): Promise<SkillWriteResult> {
  if (!isSkillName(name)) return { status: 'error', name, version: 0, message: 'skill 名不合法：' + name }
  const found = findSkillFile(scope.root, name)
  if (!found) return { status: 'error', name, version: 0, message: '找不到该 skill 文件：' + name }
  try {
    const parsed = rewriteFrontmatter(found.path, found.parsed, {
      description,
      changelogLine: '更新路由描述（description）',
    })
    const key = skillRowKey(workspaceKey, name)
    const row = store.toolMemory.get(key)
    if (row) await store.toolMemory.update(key, (record) => ({ ...record, description: parsed.description }))
    return { status: 'updated', name, version: parsed.version, path: found.path, message: '描述已更新。' }
  } catch (error) {
    return { status: 'error', name, version: 0, message: '更新失败：' + String(error).slice(0, 160) }
  }
}

/**
 * Count one model-side skill load (called from the tools/post-execute hook when
 * the `skill` tool runs with one of our names). Best-effort.
 */
export async function bumpSkillUse(store: Store, workspaceKey: string, name: string): Promise<boolean> {
  const key = skillRowKey(workspaceKey, name)
  const row = store.toolMemory.get(key)
  if (!row || row.kind !== 'skill') return false
  await store.toolMemory.update(key, (record) => ({ ...record, useCount: record.useCount + 1 }))
  return true
}

/** Register input for a manual skill (memory_toolize register without entry). */
export interface ManualSkillInput {
  name: string
  title?: string
  description: string
  whenToUse?: string
  body?: string
  tags?: string[]
}

/**
 * Build one manual skill draft from memory_toolize.register. The body is the
 * caller's guidance; when absent, a skeleton with the required sections is
 * produced so the file is still a usable skill rather than an empty stub.
 */
export function draftSkillFromManual(input: ManualSkillInput, options: { sharedToken?: string } = {}): SkillDraft {
  const slug = kebabCase(input.name.replace(/^sm-/, ''), 32) || 'skill'
  const name = clampName('sm-' + (options.sharedToken ? options.sharedToken + '-' : '') + slug)
  const title = String(input.title ?? '').trim() || input.name
  const description = clipDescription(input.description)
  const body = String(input.body ?? '').trim()
  const facts = { commands: [], files: [], patterns: [] }
  return {
    name,
    title,
    description,
    ...(input.whenToUse ? { whenToUse: clipDescription(input.whenToUse) } : {}),
    tags: (input.tags && input.tags.length > 0 ? input.tags : ['skill', 'manual']).slice(0, 8),
    body: body || renderSkillBody({
      name, title, description, tags: [], body: '',
      source: { kind: 'manual', label: '手工登记', occurrences: 1 }, facts,
    }),
    source: { kind: 'manual', label: '手工登记', occurrences: 1 },
    facts,
  }
}
