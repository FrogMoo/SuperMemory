/**
 * Skill forge (R45 / R48): repeated WORK becomes a REAL DSH skill.
 *
 * 背景：P3 把重复流程编译成 `sm_composite_*` 组合工具——「按什么顺序调哪些
 * 工具」。R45 把沉淀改到 DSH 的 skill 机制（`<project>/.dsh/skills/<name>/SKILL.md`，
 * 项目根判定见 dsh-skill-filesystem：最近含 `.git` 的祖先），但自动生成退化成
 * 了按工具序列命名（`sm-flow-bash-bash-…`）：没有对象、没有参数、没有坑，还会
 * 挤占 available_skills 的路由注意力。
 *
 * R48 起识别的主体是「做过的事」，不是「连续调了哪些工具」：
 * - 任务签名来自任务/派发文本（动词 + 对象）、真实文件/目录族、命令家族与关键
 *   参数（`pnpm git:sync`、`pnpm typecheck`、`git push`…）；
 * - 同一任务签名跨 ≥N 次、≥2 个会话/派发才产出草稿；工具序列只作为正文里
 *   的历史事实，不参与命名与聚合；
 * - 名称是 `sm-<verb>-<object>`（`fix-skill-forge`、`sync-gitee-github`），
 *   描述写「做什么任务时加载」，正文六节全部来自真实样本，缺信息写「待补充」；
 * - 历史遗留的工具序列壳子由 archiveShellSkills 归档（不删除，写 manifest）。
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
import type { Store } from './store.ts'
import {
  extractCommandFamilies, extractFileFacts, extractTaskSignature, looksLikeToolFlowName,
  taskNameSimilarity, type TaskSample, type TaskSignature,
} from './task-signature.ts'

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
 * R48 tightened it from 12 to 8: the catalog is routing attention, and a busy
 * workspace must earn each entry with a repeated TASK, not a sliding window.
 */
export const SKILL_MAX_PER_ROOT = 8

/** Same task must recur in at least this many distinct sessions/dispatches. */
export const SKILL_MIN_SESSIONS = 2

/** Only recent task signatures auto-create/auto-update (time decay). */
export const SKILL_RECENCY_DAYS = 30

/** A draft this similar (name tokens) to an existing skill is a near-duplicate. */
export const SKILL_SIMILARITY_MAX = 0.85

/**
 * Where this skill record came from.
 * - task: repeated TASK (R48, the only auto path);
 * - capability: repeated executable capability (sm-cap-*);
 * - manual: memory_toolize register (never touched by automation);
 * - sequence: legacy R45 tool-sequence shells (readable for cleanup only).
 */
export type SkillSourceKind = 'task' | 'capability' | 'manual' | 'sequence'

export interface SkillSource {
  kind: SkillSourceKind
  /** Durable signal / capability key the draft was derived from. */
  key?: string
  /** Human-readable task label, e.g. `修复 skill-forge`. */
  label: string
  /** How many times the TASK was observed. */
  occurrences: number
  /** How many distinct sessions/dispatches the task was observed in. */
  sessions?: number
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
  /** Stable task signature key (`fix/skill-forge`); absent for manual/capability. */
  taskKey?: string
  /** Facts rendered into the body (kept for assertions / manual register). */
  facts?: {
    commands: string[]
    files: string[]
    patterns: string[]
    taskTexts?: string[]
    commandCounts?: Array<{ command: string; count: number }>
    fileCounts?: Array<{ file: string; count: number }>
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
  /** Task signature this file was generated from (R48 merge/dedupe key). */
  taskKey?: string
  /** Hash of the generated body we last wrote (detects human edits). */
  renderedHash?: string
  /** R50: hash of the prose (facts block excluded) and of the facts block. */
  bodyHash?: string
  factsHash?: string
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
  /** R52: workspace token when the capability root is under <DSH_HOME>/capabilities. */
  token?: string
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
  taskKey: 'sm-task-key',
  renderedHash: 'sm-rendered-hash',
  changelog: 'sm-changelog',
  enabled: 'sm-enabled',
  // R50 统一能力：事实块哈希与散文哈希（行级也镜像，用于检测人工编辑）。
  bodyHash: 'sm-body-hash',
  factsHash: 'sm-facts-hash',
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

/** `sm-<verb>-<object>` — stable for one repeated TASK (never a tool flow). */
export function skillNameForTask(signature: TaskSignature, sharedToken?: string): string {
  const base = 'sm-' + (sharedToken ? sharedToken + '-' : '') + signature.nameBase
  return clampName(kebabCase(base, 64), 64)
}

/**
 * Readability gate: a task skill name must talk about an OBJECT, not a tool
 * flow. Legacy shells (`sm-flow-bash-bash-…`) and names built only from tool
 * words are rejected outright.
 */
export function isReadableTaskSkillName(name: string): boolean {
  if (!isSkillName(name)) return false
  if (looksLikeToolFlowName(name)) return false
  const body = name.replace(/^sm-/, '').replace(/^ws[a-z0-9]{5}-/, '')
  const segments = body.split('-').filter(Boolean)
  return segments.length >= 2 && segments.some((segment) => segment.length >= 3)
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

/** Parse durable task samples (broken/legacy entries skipped). */
export function parseTaskSamples(raw: string[]): TaskSample[] {
  const out: TaskSample[] = []
  for (const entry of raw) {
    try {
      const parsed = JSON.parse(entry) as TaskSample
      if (parsed && Array.isArray(parsed.tools) && Array.isArray(parsed.args)) out.push(parsed)
    } catch { /* one broken sample is skipped */ }
  }
  return out
}

/** Rich facts used by the body, all derived from recorded samples. */
export interface WorkflowFacts {
  commands: string[]
  files: string[]
  patterns: string[]
  taskTexts: string[]
  commandCounts: Array<{ command: string; count: number }>
  fileCounts: Array<{ file: string; count: number }>
  commandFamilies: string[]
}

/** Extract human-relevant facts from recorded samples (no secrets copied). */
export function extractWorkflowFacts(samples: TaskSample[]): { commands: string[]; files: string[]; patterns: string[] } {
  const facts = workflowFacts(samples)
  return { commands: facts.commands, files: facts.files, patterns: facts.patterns }
}

function countMapPush(map: Map<string, number>, value: unknown, max = 160): void {
  if (typeof value !== 'string') return
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text || text.length > max) return
  map.set(text, (map.get(text) ?? 0) + 1)
}

function topEntries(map: Map<string, number>, limit: number): Array<{ value: string; count: number }> {
  // First-seen order (Map insertion), NOT frequency: a repeated turn must not
  // reshuffle the definition and bump the version just because a command ran
  // again. Counts are only used for the "seen more than once" pitfall.
  return [...map.entries()]
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }))
}

/** One sample's fact extraction (exported for smoke assertions). */
export function workflowFacts(samples: TaskSample[]): WorkflowFacts {
  const commands = new Map<string, number>()
  const files = new Map<string, number>()
  const patterns = new Map<string, number>()
  const taskTexts = new Set<string>()
  for (const sample of samples) {
    if (typeof sample.task === 'string' && sample.task.trim()) {
      const task = sample.task.replace(/\s+/g, ' ').trim()
      if (task) taskTexts.add(task.slice(0, 200))
    }
    sample.tools.forEach((tool, index) => {
      const args = sample.args[index] ?? {}
      if (tool === 'bash' || tool === 'terminal' || tool === 'shell') countMapPush(commands, args.command)
      if (tool === 'grep' || tool === 'glob') countMapPush(patterns, args.pattern, 120)
      if (tool === 'read' || tool === 'edit' || tool === 'write') {
        const path = args.file_path ?? args.path
        countMapPush(files, path, 200)
      }
    })
  }
  // Path facts also come from commands and task text (真实工作碰过的文件族).
  for (const file of extractFileFacts(samples).files) {
    if (!files.has(file)) files.set(file, 1)
  }
  const commandFamilies = extractCommandFamilies(samples).commands
  const commandEntries = topEntries(commands, 8)
  const fileEntries = topEntries(files, 10)
  return {
    commands: commandEntries.map((entry) => entry.value),
    files: fileEntries.map((entry) => entry.value),
    patterns: topEntries(patterns, 6).map((entry) => entry.value),
    taskTexts: [...taskTexts].slice(-4),
    commandCounts: commandEntries.map((entry) => ({ command: entry.value, count: entry.count })),
    fileCounts: fileEntries.map((entry) => ({ file: entry.value, count: entry.count })),
    commandFamilies,
  }
}

/**
 * Routing description: short, specific, "when to load", never a tool order.
 * Statistics deliberately stay OUT of the description/body so repeated
 * detection of the same facts stays byte-identical (frontmatter occurrences
 * carries the counters instead).
 */
export function taskSkillDescription(signature: TaskSignature, facts: WorkflowFacts): string {
  const scope = facts.files.length > 0 ? '涉及 ' + facts.files.slice(0, 2).join('、') : (signature.commands.length > 0 ? '常用命令 ' + signature.commands.slice(0, 2).join('、') : '任务对象 ' + signature.objects.join('、'))
  return clipDescription('当任务属于「' + signature.title + '」这一类（' + scope + '）时加载：真实步骤、关键坑与验证方式（任务级经验，不是工具序列）。')
}

/** Routing hint for the catalog (frontmatter whenToUse). */
function taskSkillWhenToUse(signature: TaskSignature): string {
  return '任务文本与对象和「' + signature.title + '」相近时加载；只是工具顺序相同、任务对象不同，不要套用。'
}

function confidenceWord(confidence: number): string {
  if (confidence >= 0.8) return '高'
  if (confidence >= 0.6) return '中'
  return '低'
}

function code(text: string): string {
  return '`' + text.replace(/`/g, '\\`') + '`'
}

/**
 * Markdown body for one repeated TASK. The six required sections are built
 * from recorded commands/files/requests; anything the samples do not justify
 * says 「待补充」 instead of inventing a trap or a step.
 */
export function renderTaskSkillBody(
  draft: SkillDraft,
  signature: TaskSignature,
  samples: TaskSample[],
  meta: { occurrences: number; sessions: number },
): string {
  const facts = workflowFacts(samples)
  const tools = new Set(samples.flatMap((sample) => sample.tools))
  const verification = facts.commands.filter((command) => extractCommandFamilies([{ tools: ['bash'], args: [{ command }] }]).commands.some((family) => /typecheck|build|smoke|test|lint|check/i.test(family)))
  const lines: string[] = []
  lines.push('# ' + draft.title)
  lines.push('')
  lines.push('> 由 SuperMemory 从重复任务自动沉淀（任务级经验，不是工具序列）。可以手工编辑：再次识别到同一任务时只更新统计，不会覆盖人工修改。')
  lines.push('> 置信度：' + confidenceWord(signature.confidence) + '（样本信息' + (signature.confidence >= 0.8 ? '充分' : '有限，缺的细节标为「待补充」') + '）。')
  lines.push('')
  lines.push('## 何时用（触发条件）')
  lines.push('')
  lines.push('- 任务属于「' + draft.title + '」这一类' + (facts.files.length > 0 ? '，通常涉及 ' + facts.files.slice(0, 3).map(code).join('、') : '') + '。')
  if (facts.taskTexts.length > 0) {
    lines.push('- 历史请求样本（原样截取，用于判断是否同类）：')
    for (const task of facts.taskTexts) lines.push('  - 「' + task.slice(0, 90) + (task.length > 90 ? '…' : '') + '」')
  } else {
    lines.push('- 待补充：样本没有记录任务文本，无法判断触发条件。')
  }
  if (facts.commandFamilies.length > 0) lines.push('- 历史命令家族：' + facts.commandFamilies.slice(0, 5).map(code).join('、') + '。')
  lines.push('- 只是工具顺序相同、任务对象不同（不同仓库/目录/文件族）时不要套用。')
  lines.push('')
  lines.push('## 决策清单')
  lines.push('')
  let step = 1
  if (facts.files.length > 0) {
    lines.push(step + '. 先核对当前实现/现状：读 ' + facts.files.slice(0, 3).map(code).join('、') + '，确认这次改动是否落在同一对象上。')
    step += 1
  } else {
    lines.push(step + '. 待补充：样本没有记录具体文件；先定位这次任务的真实对象，再决定是否复用。')
    step += 1
  }
  if (facts.commands.length > 0) {
    lines.push(step + '. 需要执行命令时优先复用历史命令形态：' + facts.commands.slice(0, 3).map(code).join('、') + '；先确认它们对当前目录/分支仍然成立。')
    step += 1
  } else {
    lines.push(step + '. 待补充：样本没有记录可复用命令。')
    step += 1
  }
  lines.push(step + '. 中途出现失败或与样本不同的分支时，按「关键坑」停下判断，不要机械跑完整个步骤。')
  step += 1
  lines.push(step + '. 完成后按「验证方式」核对，并把新发现的坑补进本文件（同名更新会升版并保留 changelog）。')
  lines.push('')
  lines.push('## 步骤纲要')
  lines.push('')
  let outline = 1
  if (facts.files.length > 0) {
    lines.push(outline + '. 读取/定位：' + facts.files.slice(0, 3).map((file) => code(file)).join('、') + '。')
    outline += 1
  }
  if (facts.commandCounts.length > 0) {
    lines.push(outline + '. 执行/修改：按历史命令形态推进，样本中的命令：')
    for (const entry of facts.commandCounts.slice(0, 6)) {
      lines.push('   - ' + code(entry.command))
    }
    outline += 1
  }
  if (verification.length > 0) {
    lines.push(outline + '. 验证：' + [...new Set(verification)].slice(0, 4).map(code).join('、') + '。')
    outline += 1
  }
  if (outline === 1) lines.push('1. 待补充：样本没有记录文件、命令或验证步骤，无法给出可复用纲要。')
  lines.push('')
  lines.push('## 关键坑')
  lines.push('')
  const repeated = facts.commandCounts.filter((entry) => entry.count >= 2)
  for (const entry of repeated.slice(0, 3)) {
    lines.push('- ' + code(entry.command) + ' 在样本里多次出现：重跑前先确认上一次是否失败/是否幂等，不要为了「重试」重复有副作用的命令。')
  }
  if (tools.has('edit') || tools.has('write')) lines.push('- 样本里有精确编辑：先读目标文件，再只改必要片段，避免整文件覆盖并行改动。')
  if (tools.has('grep') || tools.has('glob')) lines.push('- 检索空结果不等于不存在：换关键词，或直接读目标文件核对。')
  if (repeated.length === 0) lines.push('- 待补充：样本没有记录失败与回退细节，不要臆造具体报错或解决方式。')
  lines.push('- 把 skill 当成免确认的写操作快捷方式：写操作仍需按原流程确认与验证。')
  lines.push('')
  lines.push('## 验证方式')
  lines.push('')
  if (verification.length > 0) {
    lines.push('- 历史样本实际跑过的验证命令：' + [...new Set(verification)].slice(0, 5).map(code).join('、') + '。')
  } else {
    lines.push('- 待补充：历史样本没有记录验证命令；按仓库约定跑 typecheck / 相关 smoke 并记录结果。')
  }
  lines.push('- 用可观察结果核对（命令 exit code、文件内容、测试输出），不要凭印象宣称完成。')
  lines.push('')
  lines.push('## 反例（不要这样用）')
  lines.push('')
  lines.push('- 只是工具序列相同（例如同样是 read → edit → bash）但任务对象不同：这不是同一件事，不要加载。')
  lines.push('- 一次性任务、或目标文件/目录族明显不同：按新情况判断，不要套历史步骤。')
  lines.push('- 把 skill 当捷径跳过验证或用户确认：步骤可以复用，闸门不能跳过。')
  lines.push('')
  lines.push('## 调用与命中统计')
  lines.push('')
  lines.push('- 任务出现次数：由插件写入 frontmatter 的 sm-occurrences（面板可见）。')
  lines.push('- 模型加载次数：由宿主 skill 工具加载时累加。')
  lines.push('- 最近识别时间：见 frontmatter 的 sm-updated-at（插件更新，正文不随时间变化）。')
  return lines.join('\n')
}

/** Neutral six-section skeleton for a skill without sampled facts (manual). */
export function renderSkillBody(draft: SkillDraft): string {
  const facts = draft.facts ?? { commands: [], files: [], patterns: [] }
  const lines: string[] = []
  lines.push('# ' + draft.title)
  lines.push('')
  lines.push('> ' + (draft.source.kind === 'manual' ? '手工登记的 skill。' : '由 SuperMemory 生成的 skill。')
    + '可以手工编辑：再次识别到同一任务时只更新统计，不会覆盖人工修改。')
  lines.push('')
  lines.push('## 何时用（触发条件）')
  lines.push('')
  lines.push('- ' + (draft.description || '待补充：写清什么任务下加载它。'))
  lines.push('')
  lines.push('## 决策清单')
  lines.push('')
  lines.push('1. 待补充：先确认这次任务与 skill 描述是否同类。')
  lines.push('2. 待补充：列出执行前必须核对的事实。')
  lines.push('')
  lines.push('## 步骤纲要')
  lines.push('')
  if (facts.commands.length === 0 && facts.files.length === 0) {
    lines.push('1. 待补充：样本不足，没有可复用的步骤。')
  } else {
    let index = 1
    for (const file of facts.files) lines.push((index++) + '. 读取/定位 ' + code(file) + '。')
    for (const command of facts.commands) lines.push((index++) + '. 执行 ' + code(command) + '。')
  }
  lines.push('')
  lines.push('## 关键坑')
  lines.push('')
  lines.push('- 待补充：样本不足，未记录失败与回退细节。')
  lines.push('')
  lines.push('## 验证方式')
  lines.push('')
  lines.push('- 待补充：写清可观察的验证命令与预期结果。')
  lines.push('')
  lines.push('## 反例（不要这样用）')
  lines.push('')
  lines.push('- 一次性任务或对象不同：不要套用。')
  return lines.join('\n')
}

/** Full SKILL.md text: YAML frontmatter + body. */
export function renderSkillMarkdown(draft: SkillDraft, meta: { version: number; updatedAt: number; renderedHash: string; changelog: string[]; enabled: boolean; bodyHash?: string; factsHash?: string }): string {
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
    ...(draft.taskKey ? [META.taskKey + ': ' + q(draft.taskKey)] : []),
    META.renderedHash + ': ' + q(meta.renderedHash),
    ...(meta.bodyHash ? [META.bodyHash + ': ' + q(meta.bodyHash)] : []),
    ...(meta.factsHash ? [META.factsHash + ': ' + q(meta.factsHash)] : []),
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
    ...(str(META.taskKey) ? { taskKey: str(META.taskKey) } : {}),
    ...(str(META.renderedHash) ? { renderedHash: str(META.renderedHash) } : {}),
    ...(str(META.bodyHash) ? { bodyHash: str(META.bodyHash) } : {}),
    ...(str(META.factsHash) ? { factsHash: str(META.factsHash) } : {}),
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

/**
 * R52: capability KNOWLEDGE lives outside every skill provider root.
 *
 * Workspace: `<repo>/.dsh/capabilities/<name>.md` (never SKILL.md).
 * No git root: `<DSH_HOME>/capabilities/<workspace-token>/<name>.md`, so the
 * shared user root stays workspace-isolated without a skill-looking directory.
 */
export function resolveCapabilityRoot(workspaceKey: string | undefined, dshHome?: string): SkillRootInfo {
  const key = String(workspaceKey ?? '').trim()
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const projectRoot = key ? findProjectRoot(key) : undefined
  if (projectRoot) {
    return {
      root: join(projectRoot, '.dsh', 'capabilities'),
      scope: 'project',
      shared: false,
      note: '工作区能力知识面（<仓库根>/.dsh/capabilities，不在任何 skill provider 扫描根内）',
    }
  }
  const token = workspaceSkillToken(key || 'unknown')
  return {
    root: join(home, 'capabilities', token),
    scope: 'user',
    shared: false,
    token,
    note: '用户级能力知识面（<DSH_HOME>/capabilities/<workspace-token>；无 git 工作区按工作区隔离）',
  }
}

/** File name of one capability's knowledge face (never SKILL.md). */
export function capabilityDocFileName(name: string): string {
  const slug = kebabCase(String(name ?? '').replace(/^sm_cap_|^sm_composite_|^sm-/, ''), 60) || 'capability'
  return slug + '.md'
}

/** Absolute path of one capability knowledge file. */
export function capabilityDocPath(root: string, name: string): string {
  return join(root, capabilityDocFileName(name))
}

/** Find and parse one capability knowledge file (missing/invalid = undefined). */
export function findCapabilityDoc(root: string, name: string): { path: string; parsed: ParsedSkill } | undefined {
  const file = capabilityDocPath(root, name)
  if (!existsSync(file)) return undefined
  try {
    const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'), 'sm-' + capabilityDocFileName(name).slice(0, -3))
    if (!parsed) return undefined
    return { path: file, parsed }
  } catch {
    return undefined
  }
}

/** Read one capability body (frontmatter stripped) for the panel editor. */
export function readCapabilityDocBody(root: string, name: string): string | undefined {
  return findCapabilityDoc(root, name)?.parsed.body
}

/**
 * R54: sm-version of ONE knowledge-face file (0 when missing/unparsable).
 *
 * The version ledger is monotonic: a migration may only ever raise it. Callers
 * take max(record.version, current file, archived files) — see
 * `archivedCapabilityDocFiles` and `adoptCapabilityDocVersion`.
 */
export function readSkillVersionAt(file: string): number {
  const path = String(file ?? '').trim()
  if (!path || !existsSync(path)) return 0
  try {
    const parsed = parseSkillMarkdown(readFileSync(path, 'utf8'), '')
    return parsed && Number.isFinite(parsed.version) ? Math.max(0, Math.floor(parsed.version)) : 0
  } catch { return 0 }
}

/**
 * R54: archived knowledge-face files that can restore one capability's version.
 *
 * The R52 move copied <skills root>/sm-<name>/SKILL.md to
 * <capabilities root>/<name>.md and archived the directory FIRST in some boot
 * orders. When the live file was then regenerated from the (older) record
 * version, the file version regressed 8 → 6 while the archive still carried 8.
 * Discovery looks in both archive locations so `reconcileCapabilityVersions`
 * can restore the highest version instead of trusting the live file alone.
 */
export function archivedCapabilityDocFiles(root: string, name: string, skillsRoot?: string): string[] {
  const out: string[] = []
  const slug = capabilityDocFileName(name).replace(/\.md$/, '')
  const docArchive = archiveDirForRoot(root)
  try {
    if (existsSync(docArchive)) {
      for (const entry of readdirSync(docArchive)) {
        if (!entry.endsWith('.md')) continue
        const base = entry.slice(0, -3)
        if (base === slug || base.startsWith(slug + '-cap-')) out.push(join(docArchive, entry))
      }
    }
  } catch { /* an unreadable archive contributes nothing */ }
  if (skillsRoot) {
    const skillsArchive = archiveDirForRoot(skillsRoot)
    const skillName = capabilitySkillNames(name).skillName
    try {
      if (existsSync(skillsArchive)) {
        for (const entry of readdirSync(skillsArchive)) {
          if (entry !== skillName && !entry.startsWith(skillName + '-cap-') && !entry.startsWith(skillName + '-dup-')) continue
          const file = join(skillsArchive, entry, 'SKILL.md')
          if (existsSync(file)) out.push(file)
        }
      }
    } catch { /* same */ }
  }
  return out
}

/**
 * R54: rewrite one capability knowledge face at a MONOTONIC version.
 *
 * Only metadata changes: the prose is byte-identical, the facts block is kept,
 * and the migration is recorded in the file changelog. Idempotent — repeating
 * the call with the same version+line reports 'unchanged' and writes nothing,
 * which is what makes the boot migration safe to run on every start.
 */
export function adoptCapabilityDocVersion(options: {
  path: string
  name: string
  title: string
  tags?: string[]
  version: number
  /** One changelog line explaining WHY the version moved (newest first). */
  changelogLine: string
  /** Optional extra history (e.g. the archived file's changelog), oldest text last. */
  extraChangelog?: string[]
  now?: number
}): { status: 'adopted' | 'unchanged' | 'error'; version: number; path: string; bodyHash?: string; factsHash?: string; message: string } {
  const path = String(options.path ?? '').trim()
  const version = Math.max(1, Math.floor(Number(options.version) || 1))
  const line = String(options.changelogLine ?? '').trim().slice(0, 200)
  if (!path || !existsSync(path)) return { status: 'error', version, path, message: '知识面文件不存在：' + (path || '（未生成）') }
  let parsed: ParsedSkill | undefined
  try { parsed = parseSkillMarkdown(readFileSync(path, 'utf8'), capabilitySkillNames(options.name).skillName) } catch { parsed = undefined }
  if (!parsed) return { status: 'error', version, path, message: '知识面文件解析失败：' + path }
  const history = [...new Set([line, ...(options.extraChangelog ?? []), ...parsed.changelog].filter(Boolean))]
  if (parsed.version >= version && parsed.changelog[0] === line) {
    return { status: 'unchanged', version: parsed.version, path, ...(parsed.bodyHash ? { bodyHash: parsed.bodyHash } : {}), ...(parsed.factsHash ? { factsHash: parsed.factsHash } : {}), message: '版本已对齐，未改写。' }
  }
  const nextVersion = Math.max(parsed.version, version)
  const draft: SkillDraft = {
    name: parsed.name,
    title: options.title || parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
    tags: (options.tags && options.tags.length > 0 ? options.tags : ['skill', 'capability']).slice(0, 8),
    body: parsed.body,
    ...(parsed.taskKey ? { taskKey: parsed.taskKey } : {}),
    source: { kind: 'capability', key: 'capability/' + options.name, label: options.title, occurrences: Math.max(1, parsed.occurrences) },
  }
  try {
    writeFileAtomic(path, renderSkillMarkdown(draft, {
      version: nextVersion,
      updatedAt: options.now ?? Date.now(),
      renderedHash: skillContentHash(parsed.description, parsed.body),
      changelog: history,
      enabled: parsed.enabled,
      ...(parsed.bodyHash ? { bodyHash: parsed.bodyHash } : {}),
      ...(parsed.factsHash ? { factsHash: parsed.factsHash } : {}),
    }))
  } catch (error) {
    return { status: 'error', version, path, message: '写入知识面失败：' + String(error).slice(0, 160) }
  }
  return {
    status: 'adopted',
    version: nextVersion,
    path,
    ...(parsed.bodyHash ? { bodyHash: parsed.bodyHash } : {}),
    ...(parsed.factsHash ? { factsHash: parsed.factsHash } : {}),
    message: '知识面版本对齐为 v' + nextVersion + '。',
  }
}

/**
 * Archive one capability knowledge FILE (never hard-delete): move
 * `<root>/<name>.md` to `<root>-archive/<name>.md` and append a manifest row.
 * Idempotent: a missing file reports undefined; an existing target gets a suffix.
 */
export interface ArchivedCapabilityDoc {
  root: string
  name: string
  from: string
  archivePath: string
  archivedAt: number
  reason: string
}

export async function archiveCapabilityDoc(root: string, name: string, options: { now?: number; reason?: string } = {}): Promise<ArchivedCapabilityDoc | undefined> {
  const from = capabilityDocPath(root, name)
  if (!existsSync(from)) return undefined
  const archiveDir = archiveDirForRoot(root)
  mkdirSync(archiveDir, { recursive: true })
  const now = options.now ?? Date.now()
  let target = join(archiveDir, capabilityDocFileName(name))
  if (existsSync(target)) target = join(archiveDir, capabilityDocFileName(name).replace(/\.md$/, '') + '-cap-' + shortHash(from + ':' + now, 4) + '.md')
  try { renameSync(from, target) } catch { return undefined }
  const record: ArchivedCapabilityDoc = {
    root,
    name,
    from,
    archivePath: target,
    archivedAt: now,
    reason: options.reason ?? '能力删除：知识面文件归档（可回滚，不硬删）',
  }
  const manifestFile = join(archiveDir, 'manifest.json')
  const manifest = readArchiveManifest(manifestFile)
  manifest.entries.push({
    name,
    archivePath: target,
    version: 0,
    description: '',
    archivedAt: now,
    reason: record.reason,
    from,
  })
  try { writeFileAtomic(manifestFile, JSON.stringify({ version: 1, entries: manifest.entries.slice(-500) }, null, 2)) } catch { /* archive dir moved */ }
  return record
}

/** Durable row key for one generated skill. */
export function skillRowKey(workspaceKey: string, name: string): string {
  return 'ws/' + workspaceKey + '/skill/' + name
}

/** Recover the task signature stored in one durable task signal. */
export function signatureFromSignal(signal: Signal, samples: TaskSample[]): TaskSignature | undefined {
  const withTask = [...samples].reverse().find((sample) => typeof sample.task === 'string' && sample.task.trim().length >= 6)
  if (!withTask) return undefined
  // Use the latest wording as the anchor but ALL samples as evidence: a turn
  // that only read files must not lower the signature's confidence or split
  // the task from its sibling turns.
  const merged: TaskSample = {
    task: withTask.task,
    tools: samples.flatMap((sample) => sample.tools),
    args: samples.flatMap((sample) => sample.args),
  }
  const signature = extractTaskSignature(merged)
  if (!signature) return undefined
  // The pattern is the aggregation key; a mismatching signature means the
  // sample was rewritten/truncated, so do not silently create a second name.
  if (signal.pattern.startsWith('task:') && signal.pattern.slice(5) !== signature.key) return undefined
  return signature
}

/**
 * Build a draft from one repeated TASK signal. The tool sequence in the signal
 * is evidence for the body only — the name/description/aggregation all come
 * from the task signature.
 */
export function draftSkillFromTaskSignal(
  signal: Signal,
  samples: TaskSample[],
  options: { sharedToken?: string; signature?: TaskSignature; sessions?: number } = {},
): SkillDraft | undefined {
  const signature = options.signature ?? signatureFromSignal(signal, samples)
  if (!signature) return undefined
  const name = skillNameForTask(signature, options.sharedToken)
  if (!isReadableTaskSkillName(name)) return undefined
  const facts = workflowFacts(samples)
  const occurrences = Math.max(1, signal.count)
  const sessions = Math.max(1, options.sessions ?? (signal.sessions?.length ?? 1))
  const description = taskSkillDescription(signature, facts)
  const draft: SkillDraft = {
    name,
    title: signature.title,
    description,
    whenToUse: taskSkillWhenToUse(signature),
    tags: ['skill', 'task', ...signature.keywords].slice(0, 8),
    body: '',
    taskKey: signature.key,
    source: {
      kind: 'task',
      key: 'task/' + signature.key,
      label: signature.title,
      occurrences,
      sessions,
    },
    facts: {
      commands: facts.commands,
      files: facts.files,
      patterns: facts.patterns,
      taskTexts: facts.taskTexts,
      commandCounts: facts.commandCounts,
      fileCounts: facts.fileCounts,
    },
  }
  draft.body = renderTaskSkillBody(draft, signature, samples, { occurrences, sessions })
  return draft
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
    '> 由 SuperMemory 从重复执行的能力沉淀（已反复执行）。能力本身由 sm_cap_* 工具一键执行；本 skill 说明何时优先用它、以及失败时怎么判断。',
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
    '- 模型加载次数：由 sm_cap_doc 成功加载时累加（转化率分母）。',
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

/** Options shared by detection and the boot/runtime sweep. */
export interface DetectTaskOptions {
  threshold: number
  capabilityThreshold?: number
  /** Distinct sessions/dispatches required (default SKILL_MIN_SESSIONS). */
  minSessions?: number
  /** Recency window; stale signatures never auto-create or auto-update. */
  recencyDays?: number
  now?: number
  sharedToken?: string
  /** Existing skill files under the target root (near-duplicate rejection). */
  root?: string
}

/** Distinct sessions/dispatches recorded for one task signal. */
export function signalSessionCount(signal: Signal, samples: TaskSample[] = []): number {
  const recorded = signal.sessions ?? []
  if (recorded.length > 0) return recorded.length
  const fromSamples = samples.map((sample) => sample.sessionId).filter((value): value is string => Boolean(value))
  return new Set(fromSamples).size
}

/**
 * Repeated-TASK detection (R48). Only `task:<signature>` signals qualify:
 * legacy `<tool>><tool>` signals are deliberately ignored, which is what stops
 * the plugin from regenerating `sm-flow-bash-bash-…` shells after cleanup.
 * Capability rows remain a task-level path (sm-cap-*).
 */
export function detectRepeatedTransactions(
  store: Store,
  workspaceKey: string,
  options: DetectTaskOptions,
): SkillDraft[] {
  const threshold = Math.max(1, options.threshold)
  const capThreshold = Math.max(1, options.capabilityThreshold ?? threshold)
  const minSessions = Math.max(1, options.minSessions ?? SKILL_MIN_SESSIONS)
  const now = options.now ?? Date.now()
  const recencyMs = Math.max(0, options.recencyDays ?? SKILL_RECENCY_DAYS) * 86400000
  const existing = options.root ? readSkillFiles(options.root) : []
  const candidates: SkillDraft[] = []
  for (const [, signal] of store.signals.entries()) {
    if (signal.workspaceKey !== workspaceKey) continue
    if (!signal.pattern.startsWith('task:')) continue
    if (signal.count < threshold) continue
    if (recencyMs > 0 && now - signal.lastSeen > recencyMs) continue
    const samples = parseTaskSamples(signal.samples ?? [])
    const sessions = signalSessionCount(signal, samples)
    if (sessions < minSessions) continue
    const draft = draftSkillFromTaskSignal(signal, samples, {
      ...(options.sharedToken ? { sharedToken: options.sharedToken } : {}),
      sessions,
    })
    if (draft) candidates.push(draft)
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
    if (draft) candidates.push(draft)
  }
  // Merge by name (same task = one skill), then drop near-duplicates and
  // unreadable names. Existing files are the reference set: a new draft that
  // merely rephrases an existing skill is discarded on purpose.
  candidates.sort((left, right) => right.source.occurrences - left.source.occurrences)
  const accepted: SkillDraft[] = []
  const names = new Set(existing.map((entry) => entry.name))
  const tokenOf = (name: string): string | undefined => /^sm-(ws[a-z0-9]{5})-/.exec(name)?.[1]
  for (const candidate of candidates) {
    if (candidate.source.kind === 'task' && !isReadableTaskSkillName(candidate.name)) continue
    const candidateToken = tokenOf(candidate.name)
    const byTaskKey = candidate.taskKey
      ? existing.find((entry) => {
          if (entry.parsed.taskKey !== candidate.taskKey) return false
          const fileToken = tokenOf(entry.name)
          return !candidateToken || !fileToken || candidateToken === fileToken
        })
      : undefined
    if (byTaskKey) {
      // Same task already has a file: keep its name and let persistSkillDraft
      // run the idempotent/versioned update. This is the merge path, not a
      // duplicate to discard.
      accepted.push({ ...candidate, name: byTaskKey.name })
      continue
    }
    const draft = candidate
    if (names.has(draft.name)) continue
    // Workspace tokens make two same-task skills intentionally distinct in the
    // shared user-level root; never treat those as near duplicates.
    const draftToken = candidateToken
    const similar = [...names].some((name) => {
      const otherToken = tokenOf(name)
      if (draftToken && otherToken && draftToken !== otherToken) return false
      return taskNameSimilarity(name, draft.name) >= SKILL_SIMILARITY_MAX
    })
    if (similar) continue
    names.add(draft.name)
    accepted.push(draft)
  }
  return accepted
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
    kind: 'knowledge',
    title: draft.title,
    tags: draft.tags.slice(0, 8),
    trigger: draft.source.key ?? ('skill/' + draft.name),
    description: clipDescription(draft.description),
    entry: '',
    useCount,
    status,
    createdAt,
    skillPath: path,
    enabled: status === 'active',
    loadCount: 0,
    runCount: 0,
    source: draft.source.kind === 'manual' ? 'manual' : 'auto',
    ...(draft.taskKey ? { taskKey: draft.taskKey } : {}),
    entryDraft: '',
    entryVerified: false,
  }
  await store.toolMemory.put(key, row)
}

/** Auto-generated files only (manual register never consumes the cap). */
function countAutoSkills(entries: Array<{ name: string; parsed: ParsedSkill }>, sharedToken?: string): number {
  return entries.filter((entry) =>
    entry.parsed.source !== 'manual'
    && (!sharedToken || entry.name.startsWith('sm-' + sharedToken + '-'))).length
}

/**
 * Sync every detected repeated TASK into skill files. Returns the drafts and
 * per-draft results; one broken skill never blocks the rest. The per-root cap
 * counts AUTO skills only and is checked for NEW names (updates always pass).
 */
export async function syncRepeatedTransactions(
  store: Store,
  workspaceKey: string,
  scope: SkillRootInfo,
  options: { threshold: number; capabilityThreshold?: number; minSessions?: number; recencyDays?: number; now?: number },
): Promise<{ drafts: SkillDraft[]; results: SkillWriteResult[] }> {
  const sharedToken = scope.shared ? workspaceSkillToken(workspaceKey) : undefined
  const existing = readSkillFiles(scope.root)
  const drafts = detectRepeatedTransactions(store, workspaceKey, {
    threshold: options.threshold,
    ...(options.capabilityThreshold !== undefined ? { capabilityThreshold: options.capabilityThreshold } : {}),
    ...(options.minSessions !== undefined ? { minSessions: options.minSessions } : {}),
    ...(options.recencyDays !== undefined ? { recencyDays: options.recencyDays } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(sharedToken ? { sharedToken } : {}),
    root: scope.root,
  })
  const results: SkillWriteResult[] = []
  let fileCount = countAutoSkills(existing, sharedToken)
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

/** Durable signal key for one task signature. */
export function taskSignalKey(workspaceKey: string, signatureKey: string): string {
  return 'ws/' + workspaceKey + '/task/' + signatureKey
}

/** Only keep arguments the body can actually use; never store result blobs. */
function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['command', 'description', 'file_path', 'path', 'pattern', 'glob', 'cwd', 'query', 'name']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0 && value.length <= 400) out[key] = value
  }
  return out
}

function uniqueCompact(values: Array<string | undefined>, cap: number): string[] {
  const out: string[] = []
  for (const value of values) {
    if (!value || out.includes(value)) continue
    out.push(value)
  }
  return out.slice(-cap)
}

export interface TaskObservationResult {
  signature: TaskSignature
  key: string
  count: number
  sessions: number
  /** True when threshold + cross-session requirements are both met. */
  crossed: boolean
}

/**
 * Record ONE task occurrence for this workspace. Unlike the old tool-sequence
 * counter, the key is `<verb>/<object>` — different tool orders of the same
 * task land on the same signal and therefore merge into one skill.
 */
export async function recordTaskObservation(
  store: Store,
  workspaceKey: string,
  observation: TaskSample,
  options: { threshold?: number; minSessions?: number; now?: number } = {},
): Promise<TaskObservationResult | undefined> {
  if (!workspaceKey || workspaceKey === 'unknown') return undefined
  const signature = extractTaskSignature(observation)
  if (!signature) return undefined
  const now = options.now ?? Date.now()
  const key = signature.key
  const signalKey = taskSignalKey(workspaceKey, key)
  const existing = store.signals.get(signalKey)
  const sample: TaskSample = {
    tools: observation.tools.slice(0, 60),
    args: observation.args.slice(0, 60).map(compactArgs),
    ...(observation.task ? { task: observation.task.replace(/\s+/g, ' ').slice(0, 2000) } : {}),
    ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
    ...(observation.dispatchId ? { dispatchId: observation.dispatchId } : {}),
    ...(observation.topicSetId ? { topicSetId: observation.topicSetId } : {}),
    at: now,
  }
  const samples = [...(existing?.samples ?? []), JSON.stringify(sample)].slice(-5)
  const sessions = uniqueCompact([...(existing?.sessions ?? []), observation.sessionId], 20)
  const dispatches = uniqueCompact([...(existing?.dispatches ?? []), observation.dispatchId], 10)
  const count = (existing?.count ?? 0) + 1
  const signal: Signal = {
    workspaceKey,
    pattern: 'task:' + key,
    count,
    lastSeen: now,
    examples: [...(existing?.examples ?? []), signature.title].slice(-3),
    sequence: observation.tools.slice(0, 8),
    samples,
    sessions,
    dispatches,
  }
  await store.signals.put(signalKey, signal)
  const threshold = Math.max(1, options.threshold ?? 3)
  const minSessions = Math.max(1, options.minSessions ?? SKILL_MIN_SESSIONS)
  return { signature, key, count, sessions: sessions.length, crossed: count >= threshold && sessions.length >= minSessions }
}

/**
 * Persist the skill for one crossed task signal (runtime hook + tests).
 * Re-runs detection so cap / similarity / recency rules stay in ONE place.
 */
export async function persistTaskSkillForSignature(
  store: Store,
  workspaceKey: string,
  signatureKey: string,
  options: { threshold: number; minSessions?: number; recencyDays?: number; now?: number; root?: string; shared?: boolean },
): Promise<SkillWriteResult | undefined> {
  if (!workspaceKey || workspaceKey === 'unknown') return undefined
  const scope = options.root
    ? { root: options.root, scope: 'project' as const, shared: Boolean(options.shared), note: '' }
    : resolveSkillRoot(workspaceKey)
  const sharedToken = scope.shared ? workspaceSkillToken(workspaceKey) : undefined
  const drafts = detectRepeatedTransactions(store, workspaceKey, {
    threshold: options.threshold,
    ...(options.minSessions !== undefined ? { minSessions: options.minSessions } : {}),
    ...(options.recencyDays !== undefined ? { recencyDays: options.recencyDays } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(sharedToken ? { sharedToken } : {}),
    root: scope.root,
  })
  const draft = drafts.find((candidate) => candidate.taskKey === signatureKey)
  if (!draft) return undefined
  if (!findSkillFile(scope.root, draft.name)) {
    if (countAutoSkills(readSkillFiles(scope.root), sharedToken) >= SKILL_MAX_PER_ROOT) return undefined
  }
  return persistSkillDraft(store, workspaceKey, draft, {
    root: scope.root,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
}

/**
 * R51: names minted from a tool ORDER (R45 legacy): sm-flow-*, sm-tool-*,
 * sm-ws<token>-flow-*. Accepts the logical form without the sm- prefix too,
 * because capability records normalise names that way.
 */
export function isToolFlowName(name: string | undefined): boolean {
  return /^(?:sm-)?(?:ws[a-z0-9]{4,10}-)?(?:flow|tool)(?:-|$)/.test(String(name ?? '').trim().toLowerCase())
}

/** R51: the R45 shell prose signature (tool order, no business object). */
export function isToolOrderProse(text: string | undefined): boolean {
  const value = String(text ?? '')
  return /当任务需要按/.test(value) && /的顺序反复处理同类改动/.test(value)
}

/** R51: any identity shape that can identify a tool-order shell. */
export interface ShellIdentity {
  name?: string | undefined
  description?: string | undefined
  source?: string | undefined
  /** SKILL.md body (catches capability faces rewritten by R50). */
  body?: string | undefined
}

/**
 * R51 shell identity — survives R50's knowledge-face rewrite.
 *
 * R50's migration refreshed EVERY migrated row's SKILL.md, overwriting
 * `sm-source: sequence` with `sm-source: capability`; the old detector (source
 * only) then treated the shell as a fresh knowledge unit. Detection therefore
 * also keys on the generated name and the tool-order prose, both of which the
 * rewrite preserves.
 */
export function isShellIdentity(identity: ShellIdentity): boolean {
  if (String(identity.source ?? '') === 'sequence') return true
  if (isToolFlowName(identity.name)) return true
  if (isToolOrderProse(identity.description)) return true
  return isToolOrderProse(identity.body)
}

/**
 * Legacy shell detection (R48 cleanup, hardened in R51): an auto-generated
 * skill whose NAME or DESCRIPTION is just a tool order. Human/manual skills are
 * only reclassified when the NAME itself is a tool order — a body quote of the
 * shell template never archives a human file.
 */
export function isShellSkill(parsed: ParsedSkill): boolean {
  if (parsed.source === 'manual' && !isToolFlowName(parsed.name) && !isToolOrderProse(parsed.description)) return false
  return isShellIdentity({ name: parsed.name, description: parsed.description, source: parsed.source, body: parsed.body })
}

/** Archive directory is a SIBLING of the skill root: <root>-archive. */
export function archiveDirForRoot(root: string): string {
  return root + '-archive'
}

export interface ArchivedSkill {
  root: string
  name: string
  from: string
  archivePath: string
  version: number
  description: string
  archivedAt: number
  reason: string
}

export interface SkillArchiveRoot {
  root: string
  scanned: number
  archived: number
  skippedManual: number
  skippedOther: number
}

export interface SkillArchiveResult {
  archived: ArchivedSkill[]
  roots: SkillArchiveRoot[]
  totalScanned: number
  totalArchived: number
  dryRun: boolean
}

interface ArchiveManifest {
  version: number
  entries: Array<Omit<ArchivedSkill, 'root' | 'from'> & { from: string }>
}

function readArchiveManifest(file: string): ArchiveManifest {
  if (!existsSync(file)) return { version: 1, entries: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ArchiveManifest
    if (parsed && Array.isArray(parsed.entries)) return { version: 1, entries: parsed.entries }
  } catch { /* rebuild from this run */ }
  return { version: 1, entries: [] }
}

/**
 * Archive auto-generated tool-sequence shells under every given root.
 *
 * - moves `<root>/<name>` to `<root>-archive/<name>` (never deletes);
 * - appends a manifest entry (name/time/reason/version/description/from);
 * - retires the mirror tool_memory row when a store is supplied;
 * - IDEMPOTENT: a second run finds no shell skills and archives 0.
 */
export async function archiveShellSkills(options: {
  roots: string[]
  store?: Store
  now?: number
  dryRun?: boolean
}): Promise<SkillArchiveResult> {
  const now = options.now ?? Date.now()
  const dryRun = Boolean(options.dryRun)
  const archived: ArchivedSkill[] = []
  const rootReports: SkillArchiveRoot[] = []
  let totalScanned = 0
  for (const root of [...new Set(options.roots)]) {
    const entries = readSkillFiles(root)
    const report: SkillArchiveRoot = { root, scanned: entries.length, archived: 0, skippedManual: 0, skippedOther: 0 }
    totalScanned += entries.length
    const archiveDir = archiveDirForRoot(root)
    const toArchive: Array<{ name: string; parsed: ParsedSkill; from: string }> = []
    for (const entry of entries) {
      if (!isShellSkill(entry.parsed)) {
        if (entry.parsed.source === 'manual') report.skippedManual += 1
        else report.skippedOther += 1
        continue
      }
      toArchive.push({ name: entry.name, parsed: entry.parsed, from: dirname(entry.path) })
    }
    if (toArchive.length === 0) {
      rootReports.push(report)
      continue
    }
    if (!dryRun) mkdirSync(archiveDir, { recursive: true })
    const manifestFile = join(archiveDir, 'manifest.json')
    const manifest = readArchiveManifest(manifestFile)
    for (const item of toArchive) {
      let target = join(archiveDir, item.name)
      if (existsSync(target)) target = join(archiveDir, item.name + '-dup-' + shortHash(root + ':' + now + ':' + item.name, 4))
      if (!dryRun) {
        try {
          renameSync(item.from, target)
        } catch {
          report.skippedOther += 1
          continue
        }
      }
      const record: ArchivedSkill = {
        root,
        name: item.name,
        from: item.from,
        archivePath: target,
        version: item.parsed.version,
        description: item.parsed.description,
        archivedAt: now,
        reason: '自动生成的工具序列壳子（R48 清理：归档保留，可回滚）',
      }
      archived.push(record)
      report.archived += 1
      manifest.entries.push({
        name: record.name,
        archivePath: record.archivePath,
        version: record.version,
        description: record.description,
        archivedAt: record.archivedAt,
        reason: record.reason,
        from: record.from,
      })
      if (options.store !== undefined) await retireSkillRow(options.store, item.from)
    }
    if (!dryRun && manifest.entries.length > 0) {
      try { writeFileAtomic(manifestFile, JSON.stringify({ version: 1, entries: manifest.entries.slice(-500) }, null, 2)) } catch { /* archive files still moved */ }
    }
    rootReports.push(report)
  }
  return {
    archived,
    roots: rootReports,
    totalScanned,
    totalArchived: archived.length,
    dryRun,
  }
}

/** Skill path of a mirror row: dedicated column, legacy path entry, or JSON. */
function skillPathOfMirrorRow(row: ToolMemory): string {
  if (typeof row.skillPath === 'string' && row.skillPath) return row.skillPath
  const entry = String(row.entry ?? '')
  if (!entry.startsWith('{')) return entry
  try {
    const parsed = JSON.parse(entry) as Record<string, unknown>
    const path = parsed.skillPath ?? parsed.entryPath
    return typeof path === 'string' ? path : ''
  } catch {
    return ''
  }
}

/**
 * Retire the durable mirror row of an archived skill (best effort).
 *
 * R51: also covers kind='knowledge' rows (R50 migrated shell rows) and the
 * schema-JSON / skillPath column shapes — the old skill-only, entry-only check
 * left adopted shells active and they were re-materialised on the next boot.
 */
async function retireSkillRow(store: Store, fromDir: string): Promise<void> {
  const marker = normalizeDir(fromDir) + '/'
  const target = normalizeDir(join(fromDir, 'SKILL.md'))
  for (const [key, row] of store.toolMemory.entries()) {
    if (row.kind !== 'skill' && row.kind !== 'knowledge') continue
    const entry = normalizeDir(skillPathOfMirrorRow(row))
    if (!entry) continue
    if (entry !== target && !entry.startsWith(marker)) continue
    try {
      await store.toolMemory.update(key, (record) => ({ ...record, status: 'retired', enabled: false }))
    } catch { /* advisory */ }
  }
}

function normalizeDir(path: string): string {
  return resolve(String(path ?? '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Every skill root this machine is likely to have used: <DSH_HOME>/skills plus
 * `<project>/.dsh/skills` for every workspace key found in the store and the
 * caller's cwd. Missing roots are ignored.
 */
export function discoverSkillRoots(options: {
  dshHome?: string
  store?: Store
  workspaces?: string[]
  cwd?: string
} = {}): string[] {
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const workspaces = new Set<string>()
  if (options.cwd) workspaces.add(resolve(options.cwd))
  for (const workspace of options.workspaces ?? []) if (workspace) workspaces.add(workspace)
  const store = options.store as unknown as Record<string, { entries?: () => IterableIterator<[string, unknown]> }> | undefined
  if (store) {
    for (const table of ['memories', 'signals', 'toolMemory', 'filemap', 'topicsets']) {
      const handle = store[table]
      if (!handle || typeof handle.entries !== 'function') continue
      try {
        for (const [, row] of handle.entries()) {
          const workspaceKey = (row as { workspaceKey?: unknown } | null | undefined)?.workspaceKey
          if (typeof workspaceKey === 'string' && workspaceKey.length > 0) workspaces.add(workspaceKey)
        }
      } catch { /* one broken table never blocks discovery */ }
    }
  }
  const roots = new Set<string>()
  roots.add(join(dshHome, 'skills'))
  for (const workspace of workspaces) {
    const projectRoot = findProjectRoot(workspace) ?? (existsSync(join(workspace, '.git')) ? workspace : undefined)
    if (projectRoot) roots.add(join(projectRoot, '.dsh', 'skills'))
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    let key: string
    try { key = normalizeDir(root) } catch { continue }
    if (seen.has(key)) continue
    seen.add(key)
    try {
      if (existsSync(root) && statSync(root).isDirectory()) out.push(root)
    } catch { /* unreadable root is skipped */ }
  }
  return out.sort()
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
    ...(parsed.taskKey ? { taskKey: parsed.taskKey } : {}),
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


// ---------------------------------------------------------------------------
// R50 事实块（facts block）与统一能力知识面
//
// 知识面的正文以 SKILL.md 文件为事实来源：六节人工散文（何时用/决策/步骤/
// 关键坑/验证/反例）由人或首次生成写定，自动维护只替换两块标记之间的「事实
// 块」（入口、scope、预演参数、验证命令、涉及文件、失败坑）。块外散文一律保留；
// 没有标记的手工 skill 首次只追加事实块，不改正文。bodyHash 用于检测人工编辑
// （散文是否被改过），factsHash 用于判断事实是否过期。
// ---------------------------------------------------------------------------

/** One capability's fact block content (all fields optional; absent = 待补充). */
export interface CapabilityFacts {
  /** 入口命令（可执行能力）。 */
  entry?: string
  /** 适用范围目录。 */
  scope?: string
  /** 预演参数。 */
  dryRunArg?: string
  /** 真实执行是否写远端/改状态。 */
  writeConfirm?: boolean
  /** 验证命令（来自真实样本或能力文档）。 */
  verify?: string[]
  /** 涉及文件（文档/技能文件/样本里真实出现的文件）。 */
  files?: string[]
  /** 失败坑（来自 changelog/健康信号/真实样本）。 */
  pitfalls?: string[]
  /** 历史命令（知识草稿来自重复任务时）。 */
  commands?: string[]
}

export const FACTS_START = '<!-- sm:facts:start -->'
export const FACTS_END = '<!-- sm:facts:end -->'

/** Render the deterministic facts block (marker included, no surrounding prose). */
export function renderFactsBlock(facts: CapabilityFacts): string {
  const lines: string[] = [FACTS_START, '### 事实（自动维护）', '']
  const bullet = (label: string, value: string): void => {
    lines.push('- ' + label + '：' + value)
  }
  const inline = (values: Array<string | undefined>): string => values.filter((value): value is string => Boolean(value && value.trim())).join(' · ')
  if (facts.entry) bullet('入口', '`' + facts.entry + '`')
  else bullet('入口', '仅知识（无入口命令）')
  if (facts.scope) bullet('适用范围', '`' + facts.scope + '`')
  if (facts.dryRunArg) bullet('预演参数', '`' + facts.dryRunArg + '`（默认预演）')
  if (facts.writeConfirm !== undefined) bullet('写操作确认', facts.writeConfirm ? '真实执行必须 confirm=true' : '非写操作')
  if (facts.verify && facts.verify.length > 0) bullet('验证命令', facts.verify.map((item) => '`' + item + '`').join('、'))
  if (facts.commands && facts.commands.length > 0) bullet('历史命令', facts.commands.map((item) => '`' + item + '`').join('、'))
  if (facts.files && facts.files.length > 0) bullet('涉及文件', facts.files.map((item) => '`' + item + '`').join('、'))
  if (facts.pitfalls && facts.pitfalls.length > 0) bullet('失败坑', inline(facts.pitfalls))
  lines.push(FACTS_END)
  return lines.join('\n')
}

/** Stable hash of the fact block (order-normalised input). */
export function factsHashOf(facts: CapabilityFacts): string {
  return shortHash(JSON.stringify({
    entry: facts.entry ?? '',
    scope: facts.scope ?? '',
    dryRunArg: facts.dryRunArg ?? '',
    writeConfirm: facts.writeConfirm === undefined ? null : facts.writeConfirm,
    verify: [...(facts.verify ?? [])],
    commands: [...(facts.commands ?? [])],
    files: [...(facts.files ?? [])],
    pitfalls: [...(facts.pitfalls ?? [])],
  }), 8)
}

/** Split a body into prose and the facts block (no marker = hasBlock false). */
export function splitFactsBlock(body: string): { prose: string; facts: string; hasBlock: boolean } {
  const text = String(body ?? '')
  const start = text.indexOf(FACTS_START)
  const end = text.indexOf(FACTS_END)
  if (start < 0 || end < start) return { prose: text.trim(), facts: '', hasBlock: false }
  const prose = (text.slice(0, start) + text.slice(end + FACTS_END.length)).trim()
  return { prose, facts: text.slice(start, end + FACTS_END.length), hasBlock: true }
}

/** Replace (or append) the facts block; prose is never rewritten. */
export function applyFactsBlock(body: string, block: string): string {
  const split = splitFactsBlock(body)
  const head = split.prose.trim()
  if (split.hasBlock) return (head ? head + '\n\n' : '') + block
  const section = '## 事实（自动维护）'
  const existing = head.includes(section)
  if (existing) {
    // A previous generator wrote the section without markers: append the block
    // at the end instead of deleting anything the human wrote there.
    return (head ? head + '\n\n' : '') + block
  }
  return (head ? head + '\n\n' : '') + section + '\n\n' + block
}

/** Hash of the human prose (facts block excluded) — detects human edits. */
export function bodyHashOf(body: string): string {
  return shortHash(splitFactsBlock(body).prose.replace(/\s+/g, ' ').trim(), 8)
}

/** Draft/definition shape consumed by the unified capability knowledge face. */
export interface CapabilitySkillInput {
  /** Logical capability name, e.g. git-sync-supermemory. */
  name: string
  title: string
  description: string
  entry?: string
  entryDraft?: string
  scope?: string
  doc?: string
  dryRunArg?: string
  writeConfirm?: boolean
  runnable?: boolean
  taskKey?: string
  tags?: string[]
  source?: string
  version?: number
  routeNote?: string
  /** Extra facts from real samples (commands/files/verification/pitfalls). */
  facts?: CapabilityFacts
}

/** `git-sync-supermemory` → skill `sm-git-sync-supermemory`, tool `sm_cap_git_sync_supermemory`. */
export function capabilitySkillNames(name: string): { skillName: string; toolName: string } {
  const slug = kebabCase(String(name ?? '').replace(/^sm_cap_|^sm_composite_|^sm-/, ''), 40) || 'capability'
  return { skillName: 'sm-' + slug, toolName: 'sm_cap_' + slug.replace(/-/g, '_') }
}

/** Six-section prose for a capability skill (no facts block; facts are appended). */
export function renderCapabilityProse(input: CapabilitySkillInput): string {
  const entry = input.entry || input.entryDraft || ''
  const lines: string[] = []
  lines.push('# ' + input.title)
  lines.push('')
  lines.push('> 由 SuperMemory 固化为单一能力：本文件是知识面（何时用、怎么判断），执行面是 '
    + (input.runnable && input.entry ? '工具 `' + capabilitySkillNames(input.name).toolName + '`' : '未开放（仅知识）') + '。')
  lines.push('>')
  lines.push('> 本文件位于 `.dsh/capabilities/<name>.md`，不进入宿主 available_skills；模型在会话里按需调用 `sm_cap_doc` 读取。')
  lines.push('> 自动维护只刷新文末「事实」块；块外散文可以手工编辑，不会被自动覆盖。')
  lines.push('')
  lines.push('## 何时用（触发条件）')
  lines.push('')
  lines.push('- ' + (input.description || '待补充：写清什么任务下加载它。'))
  if (input.routeNote) lines.push('- ' + input.routeNote)
  if (input.scope) lines.push('- 当前工作区在适用范围 `' + input.scope + '` 内，且已有该能力的入口（或仅需要这套判断）。')
  lines.push('')
  lines.push('## 决策清单')
  lines.push('')
  lines.push('1. 先确认本能力与当前任务同类（对象/目录/文件族一致），再看事实块里的入口与范围。')
  lines.push('2. ' + (input.writeConfirm
    ? '真实执行可能写远端/改状态：先默认预演，确认真实执行时必须显式 confirm=true。'
    : '先默认预演（有 dryRunArg 时自动附加），确认输出与退出码符合预期后再实跑。'))
  lines.push('3. 连续失败或事实块与现状不符时，更新能力定义（version+1、changelog 记录原因），不要手敲命令绕过。')
  lines.push('4. 完成后按「验证方式」核对，并把新发现的坑补进本文件（自动刷新只动事实块）。')
  lines.push('')
  lines.push('## 步骤纲要')
  lines.push('')
  lines.push('1. 读取事实块，确认入口、scope、预演参数与验证命令。')
  lines.push('2. ' + (input.entry
    ? '调用 `' + capabilitySkillNames(input.name).toolName + '`（固定入口 `' + input.entry + '`，不接受任意参数透传）。'
    : '按事实块里的判断推进；本能力没有执行面，不要凭空执行命令。'))
  lines.push('3. 失败时按「关键坑」停下判断，不要机械重试。')
  lines.push('')
  lines.push('## 关键坑')
  lines.push('')
  lines.push('- scope 外的会话不会执行该能力（工作区隔离）；先确认当前目录在适用范围。')
  if (input.writeConfirm) lines.push('- writeConfirm 能力没有 confirm=true 时只返回「需要确认」，不会执行。')
  lines.push('- 连续失败时先更新能力定义/事实块，不要绕过闸门。')
  lines.push('')
  lines.push('## 验证方式')
  lines.push('')
  if (input.doc) lines.push('- 详细流程见 `' + input.doc + '`；执行结果看 exitCode/stdout/stderr，而不是「命令似乎跑了」。')
  else lines.push('- 看入口命令的 exitCode/stdout/stderr；没有可观察结果就不要宣称完成。')
  lines.push('- 事实块与文件内容不一致时，以文件/命令输出为准并更新事实块。')
  lines.push('')
  lines.push('## 反例（不要这样用）')
  lines.push('')
  lines.push('- 一次性任务、对象不同、或当前工作区不在 scope 内：不要套用。')
  lines.push('- 把知识面当免确认快捷方式：写操作仍需 confirm 与验证。')
  return lines.join('\n')
}

/** Deterministic six-section + facts bundle for one capability. */
export function buildCapabilitySkill(input: CapabilitySkillInput): {
  name: string
  title: string
  description: string
  whenToUse?: string
  prose: string
  body: string
  facts: CapabilityFacts
  factsBlock: string
  bodyHash: string
  factsHash: string
} {
  const names = capabilitySkillNames(input.name)
  const extra = input.facts ?? {}
  const union = (left: string[] | undefined, right: string[] | undefined): string[] => [...new Set([...(left ?? []), ...(right ?? [])])]
  const facts: CapabilityFacts = {
    ...(input.entry ? { entry: input.entry } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.dryRunArg ? { dryRunArg: input.dryRunArg } : {}),
    ...(input.writeConfirm !== undefined ? { writeConfirm: input.writeConfirm } : {}),
    verify: union(input.entry ? [input.entry] : [], extra.verify),
    commands: [...(extra.commands ?? [])],
    files: union(input.doc ? [input.doc] : [], extra.files),
    pitfalls: union(
      input.entry ? ['scope 外拒绝执行；连续失败先更新能力定义/事实块，不要绕过闸门。'] : ['仅知识能力：没有执行面，不要凭空执行命令。'],
      extra.pitfalls,
    ),
  }
  const factsBlock = renderFactsBlock(facts)
  const prose = renderCapabilityProse(input)
  const body = applyFactsBlock(prose, factsBlock)
  return {
    name: names.skillName,
    title: input.title,
    description: clipDescription(input.description),
    ...(input.scope ? { whenToUse: '在 ' + input.scope + ' 内遇到「' + input.title + '」类任务时加载。' } : {}),
    prose,
    body,
    facts,
    factsBlock,
    bodyHash: bodyHashOf(body),
    factsHash: factsHashOf(facts),
  }
}

/**
 * Write/update one capability's SKILL.md using facts-block merge.
 *
 * - existing file: prose kept, facts block replaced;
 * - no markers (manual skill): prose kept, block appended (first touch);
 * - changed description/facts: version+1 + changelog;
 * - human-edited prose: status 'preserved' (only the facts block is refreshed).
 */
export async function upsertCapabilitySkill(options: {
  store: Store
  workspaceKey: string
  root: string
  input: CapabilitySkillInput
  draftBody?: string
  now?: number
  changelog?: string
  previousBodyHash?: string
}): Promise<SkillWriteResult & { bodyHash?: string; factsHash?: string; body?: string; factsBlock?: string }> {
  const now = options.now ?? Date.now()
  const bundle = buildCapabilitySkill(options.input)
  // R52: the knowledge face is `<capabilities root>/<logical>.md` — NOT a
  // `<skills root>/sm-<name>/SKILL.md` directory the host would advertise.
  const found = findCapabilityDoc(options.root, options.input.name)
  const factsBlock = bundle.factsBlock
  const nextProse = found ? splitFactsBlock(found.parsed.body).prose : String(options.draftBody ?? '').trim() || bundle.prose
  const bodyHash = bodyHashOf(nextProse)
  const nextBody = applyFactsBlock(nextProse, factsBlock)
  const description = clipDescription(options.input.description || bundle.description)
  const path = capabilityDocPath(options.root, options.input.name)
  const humanEdited = Boolean(found && options.previousBodyHash && bodyHashOf(found.parsed.body) !== options.previousBodyHash)
  if (found && found.parsed.body === nextBody && found.parsed.description === description) {
    return { status: 'unchanged', name: bundle.name, version: found.parsed.version, path, message: '内容与事实块均未变化，未升版。', bodyHash, factsHash: bundle.factsHash, body: nextBody, factsBlock }
  }
  // R54: the version ledger is monotonic — never regress below either the file's
  // own sm-version or the record's version, even when a doc was recreated from a
  // stale record (the R52 regression: live v6 vs archived v8).
  const recordedVersion = Math.max(1, Number(options.input.version) || 1)
  let version = found ? Math.max(found.parsed.version, recordedVersion) + 1 : recordedVersion
  const line = String(options.changelog ?? '').trim().slice(0, 200)
    || (found ? '刷新事实块/路由描述（正文人工散文保留）' : '生成能力知识面（六节 + 事实块）')
  const changelog = [versionLine(version, line), ...(found?.parsed.changelog ?? [])].slice(0, SKILL_CHANGELOG_MAX)
  const draft: SkillDraft = {
    name: bundle.name,
    title: options.input.title,
    description,
    ...(bundle.whenToUse ? { whenToUse: bundle.whenToUse } : {}),
    tags: (options.input.tags ?? ['skill', 'capability']).slice(0, 8),
    body: nextBody,
    ...(options.input.taskKey ? { taskKey: options.input.taskKey } : {}),
    source: { kind: 'capability', key: 'capability/' + options.input.name, label: options.input.title, occurrences: 1 },
  }
  try {
    writeFileAtomic(path, renderSkillMarkdown(draft, {
      version,
      updatedAt: now,
      renderedHash: skillContentHash(description, nextBody),
      changelog,
      enabled: found?.parsed.enabled !== false,
      bodyHash,
      factsHash: bundle.factsHash,
    }))
  } catch (error) {
    return { status: 'error', name: bundle.name, version, path, message: '写入知识面文件失败：' + String(error).slice(0, 160) }
  }
  return {
    status: found ? (humanEdited ? 'preserved' : 'updated') : 'created',
    name: bundle.name,
    version,
    path,
    message: humanEdited ? '检测到人工编辑，保留正文，仅刷新事实块（已升版）。' : (found ? '已刷新事实块并升版。' : '已生成知识面。'),
    bodyHash,
    factsHash: bundle.factsHash,
    body: nextBody,
    factsBlock,
  }
}

/** Read one skill body (for panel "view skill"). */
export function readSkillBody(root: string, name: string): string | undefined {
  const found = findSkillFile(root, name)
  return found?.parsed.body
}

/** One archived capability skill directory. */
export interface ArchivedCapabilitySkill {
  root: string
  name: string
  from: string
  archivePath: string
  archivedAt: number
  reason: string
}

/**
 * Archive one capability skill directory (never hard-delete). Idempotent: a
 * missing directory reports undefined, an existing archive target gets a suffix.
 */
export async function archiveCapabilitySkill(root: string, name: string, options: { now?: number; reason?: string } = {}): Promise<ArchivedCapabilitySkill | undefined> {
  if (!isSkillName(name)) return undefined
  const from = join(root, name)
  if (!existsSync(from)) return undefined
  const archiveDir = archiveDirForRoot(root)
  mkdirSync(archiveDir, { recursive: true })
  const now = options.now ?? Date.now()
  let target = join(archiveDir, name)
  if (existsSync(target)) target = join(archiveDir, name + '-cap-' + shortHash(from + ':' + now, 4))
  try { renameSync(from, target) } catch { return undefined }
  const record: ArchivedCapabilitySkill = {
    root,
    name,
    from,
    archivePath: target,
    archivedAt: now,
    reason: options.reason ?? '能力删除：知识面目录归档（可回滚，不硬删）',
  }
  const manifestFile = join(archiveDir, 'manifest.json')
  const manifest = readArchiveManifest(manifestFile)
  manifest.entries.push({
    name,
    archivePath: target,
    version: 0,
    description: '',
    archivedAt: now,
    reason: record.reason,
    from,
  })
  try { writeFileAtomic(manifestFile, JSON.stringify({ version: 1, entries: manifest.entries.slice(-500) }, null, 2)) } catch { /* archive dir moved */ }
  return record
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
