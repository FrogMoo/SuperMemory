/**
 * Tool-ization hard mechanism (requirement B, re-scoped by R49).
 *
 * R49 (2026-11-26) removed the "auto-register a composite" entrances for good:
 * crossing a durable threshold, the boot sweep and the in-request activity
 * window may at most leave a PENDING proposal — and only for a sequence that
 * names a business object. Generic tool orders (run_code>run_code, bash>edit,
 * memory_recall>memory_dispatch, …) are not candidates at all: they get no
 * signal row either, so an old junk pending cannot resurface.
 *
 * A composite tool is created by exactly two explicit user entrances:
 *   1. memory_toolize accept — accepts ONE pending proposal (acceptProposal);
 *   2. memory_toolize register — a capability (entry command + doc + scope).
 *
 * Why the rule is structural: before R49 the "auto" path was reachable even with
 * maintenance.autoComposite=false. attachProposals asked a user question on every
 * user turn whose FIRST option was "固化为组合工具"; the host settled that question
 * synchronously (4 ms in the 2026-11-26 incident), so the answer minted a
 * composite + a visible notice from a stale run_code>run_code pending left over
 * from v1.2.0's autoToolize=true default. Anything that can mint a composite from
 * a generic tool order is a junk factory.
 *
 * Registration still reuses ctx.tools.register(defineTool(...)), so a composite
 * is a normal model-visible tool: it appears in the tool table with name,
 * description and parameters, and a call to a name that is not live still fails
 * as UNKNOWN_TOOL (we never advertise a name that is not registered).
 * @module supermemory/toolize
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  compileComposite,
  editCompositeTool,
  liveCompositeSpecs,
  persistComposite,
  registerComposite,
  retireComposite,
  type CompositeSpec,
  type SequenceSample,
} from './composite.ts'
import type { Signal } from './schema.ts'
import type { Store } from './store.ts'
import {
  archiveShellSkills,
  persistTaskSkillForSignature,
  recordTaskObservation,
  type ArchivedSkill,
  type SkillArchiveRoot,
} from './skill-forge.ts'

/** Tool-ization knobs (all surfaced in the plugin Config schema). */
export interface ToolizeConfig {
  /**
   * R49: may a crossing sequence leave a PENDING proposal? It never registers a
   * composite either way; the flag is the legacy autoComposite/autoToolize pair
   * and defaults to false, so with default config the sequence pipeline writes
   * nothing at all.
   */
  enabled: boolean
  threshold: number
  /** R49: kept for config compatibility; automatic registration is gone. */
  cooldownMs: number
  /** R49: kept for config compatibility; an explicit accept is never capped. */
  maxActive: number
  minSteps: number
  minDistinctTools: number
  nearMissHint: boolean
  recycleIdleDays: number
  /**
   * R45: 重复事务同时沉淀为 DSH skill（默认路径）。缺省 false，保持旧调用点的
   * 行为不变（只生成组合工具）；真实配置由 index.ts 显式打开。
   */
  autoSkill?: boolean
  /** R48: 同一任务至少跨几个会话/派发才自动生成（默认 2）。 */
  skillMinSessions?: number
  /** R48: 任务签名的时间衰减窗口（天）；超窗不再自动新增/升版（默认 30）。 */
  skillRecencyDays?: number
}

/** Injectable seam so unit tests can drive the explicit accept path without a host. */
export interface ToolizeDeps {
  register: (ctx: Context, store: Store, spec: CompositeSpec) => Promise<() => void>
  persist: (store: Store, spec: CompositeSpec, key: string) => Promise<string>
  toolExists: (ctx: Context, name: string) => boolean
  now: () => number
}

/** Default seam: the real host registry and the real durable table. */
export function defaultToolizeDeps(): ToolizeDeps {
  return {
    register: registerComposite,
    persist: persistComposite,
    toolExists: (ctx, name) => Boolean(ctx.tools.get(name)),
    now: () => Date.now(),
  }
}

/** One durable composite definition plus its usage counter. */
export interface ActiveComposite {
  id: string
  spec: CompositeSpec
  useCount: number
}

/** Every durable active composite (broken JSON is skipped, never thrown). */
export function activeComposites(store: Store): ActiveComposite[] {
  const out: ActiveComposite[] = []
  for (const [id, record] of store.toolMemory.entries()) {
    if (record.kind !== 'composite' || record.status !== 'active' || !record.entry) continue
    try {
      const spec = JSON.parse(record.entry) as CompositeSpec
      if (!spec || !Array.isArray(spec.steps) || spec.steps.length === 0) continue
      out.push({ id, spec, useCount: record.useCount })
    } catch {
      // one corrupt row never blocks a request
    }
  }
  return out
}

/** Longest suffix of recent tool names that is a prefix of one composite. */
export function longestPrefixMatch(recent: string[], steps: string[]): number {
  const max = Math.min(recent.length, steps.length)
  for (let len = max; len > 0; len -= 1) {
    const tail = recent.slice(recent.length - len)
    let same = true
    for (let index = 0; index < len; index += 1) {
      if (tail[index] !== steps[index]) {
        same = false
        break
      }
    }
    if (same) return len
  }
  return 0
}

/** A composite whose leading steps the model just executed by hand. */
export interface CompositeMatch {
  spec: CompositeSpec
  hits: number
  recent: string[]
}

/** Pick the composite with the longest matching prefix; only LIVE names qualify. */
export function pickCompositeMatch(recent: string[], candidates: ActiveComposite[], live: ReadonlySet<string> = liveCompositeSpecs): CompositeMatch | undefined {
  let best: CompositeMatch | undefined
  for (const candidate of candidates) {
    if (!live.has(candidate.spec.name)) continue
    const steps = candidate.spec.steps.map((step) => step.tool)
    const hits = longestPrefixMatch(recent, steps)
    if (hits === 0) continue
    if (!best || hits > best.hits) {
      best = { spec: candidate.spec, hits, recent: recent.slice(-hits) }
    }
  }
  return best
}

/** One entry of the structured catalog appended to a repeat-recall card. */
export interface CatalogEntry {
  name: string
  steps: string[]
  description: string
  parameters: string[]
  hits: number
}

/** Catalog of LIVE composites, best (longest just-executed prefix) first. */
export function catalogFor(recent: string[], candidates: ActiveComposite[], live: ReadonlySet<string> = liveCompositeSpecs, limit = 3): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const candidate of candidates) {
    if (!live.has(candidate.spec.name)) continue
    const steps = candidate.spec.steps.map((step) => step.tool)
    const hits = longestPrefixMatch(recent, steps)
    entries.push({
      name: candidate.spec.name,
      steps,
      description: candidate.spec.description,
      parameters: candidate.spec.parameters.map((parameter) => parameter.name),
      hits,
    })
  }
  entries.sort((left, right) => right.hits - left.hits)
  return entries.slice(0, Math.max(1, limit))
}

/** Structured, model-facing catalog block (form: catalog vocabulary in prose). */
export function renderCatalog(entries: CatalogEntry[]): string {
  if (entries.length === 0) return ''
  const lines = ['[SuperMemory 可用组合工具]', '以下组合工具已注册，可一次调用完成固定子序列；步骤匹配时优先直接调用它们。']
  for (const entry of entries) {
    const params = entry.parameters.length > 0 ? '（参数：' + entry.parameters.join(', ') + '）' : ''
    const hint = entry.hits >= 2 ? '；刚执行的步骤与其前 ' + entry.hits + ' 步一致，建议直接调用它' : ''
    lines.push('- ' + entry.name + '：' + entry.steps.join(' → ') + params + hint)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// R49: broad-sequence filter. A "business" tool answers a domain question
// (erp_sync_orders, crm_pull_contacts, deploy_release …); a HOST tool is the
// workflow itself. Their order is a habit, not a transaction, so recording it
// as a composite would only teach the model to skip thinking.
// ---------------------------------------------------------------------------

/** Host tools whose order is a workflow, never a business transaction. */
const GENERIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'run_code', 'bash', 'read', 'edit', 'write', 'glob', 'grep',
  'todo_write', 'present', 'skill', 'read_image', 'working_directory',
  'wait_agent', 'send_message', 'list_agents', 'subagent', 'subagent_fork',
  'ask_user_question', 'web_search', 'web_fetch',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
  'job_list', 'job_output', 'job_kill',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
])

/** Whole families that are generic by construction (memory_* is the plugin itself). */
const GENERIC_TOOL_PREFIXES: readonly string[] = [
  'memory_', 'sm_composite_', 'job_', 'schedule_', 'session_', 'cordis_', 'plugin_',
]

/** True when the name is a generic host tool (shell/file/session/memory plumbing). */
export function isGenericToolName(name: string): boolean {
  const tool = String(name ?? '').trim()
  if (!tool) return true
  if (GENERIC_TOOL_NAMES.has(tool)) return true
  return GENERIC_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix))
}

/** Why one sequence is (not) a proposal candidate; valuable gates the pending list. */
export interface ProposalVerdict {
  valuable: boolean
  reason: string
}

/**
 * Decide whether a tool sequence names a business object at all.
 *
 * R49 rule: EVERY step must be non-generic. One host tool in the chain makes the
 * whole pattern a workflow shell, and such a sequence must never become a
 * candidate (no pending proposal, no composite) — see the module header.
 */
export function proposalVerdict(tools: readonly string[]): ProposalVerdict {
  const steps = tools.map((tool) => String(tool ?? '').trim()).filter(Boolean)
  if (steps.length < 2) return { valuable: false, reason: '步数不足（至少 2 步）' }
  if (new Set(steps).size < 2) return { valuable: false, reason: '同一工具重复不构成流程' }
  const generic = steps.find((tool) => isGenericToolName(tool))
  if (generic) return { valuable: false, reason: '宽泛工具序列：' + generic + ' 是通用工具，没有业务对象/命令/文件/入口' }
  return { valuable: true, reason: 'ok' }
}

/** Convenience: the sequence is a broad tool order (never a candidate). */
export function isBroadSequence(tools: readonly string[]): boolean {
  return !proposalVerdict(tools).valuable
}

/** Minimal durable Signal compileComposite needs for one sequence. */
function signalOf(workspaceKey: string, tools: string[], samples: SequenceSample[], now: number): Signal {
  return {
    workspaceKey,
    pattern: tools.join('>'),
    count: 1,
    lastSeen: now,
    examples: [tools.join(' → ')],
    sequence: tools,
    samples: samples.map((sample) => JSON.stringify(sample)),
    proposedAt: now,
    proposalStatus: 'accepted',
  }
}

/** Result of one explicit accept (memory_toolize accept). */
export interface AcceptProposalResult {
  status: 'accepted' | 'error'
  tool?: string
  message: string
}

/**
 * R49 explicit entrance #1: turn ONE pending proposal into a composite.
 *
 * This is the ONLY code path that may register a sequence composite, and it is
 * only reachable from the model-facing memory_toolize tool after a user asked for
 * it. Broad sequences are refused here too (defence in depth: the pending list
 * already filters them).
 *
 * origin:'manual' is stamped on the definition so the cleanup classifier can tell
 * a user-accepted sequence from a legacy auto shell and leave it alone.
 */
export async function acceptProposal(
  ctx: Context,
  store: Store,
  key: string,
  signal: Signal,
  deps?: ToolizeDeps,
): Promise<AcceptProposalResult> {
  const seam = deps ?? defaultToolizeDeps()
  const tools = sequenceOf(signal, key)
  const verdict = proposalVerdict(tools)
  if (!verdict.valuable) {
    try { await store.signals.update(key, (record) => ({ ...record, proposalStatus: 'declined' })) } catch { /* advisory */ }
    return { status: 'error', message: '宽泛工具序列不生成组合工具：' + verdict.reason }
  }
  try {
    const samples = parseSamples(signal.samples ?? [])
    const usable = samples.length > 0 ? samples : [{ tools, args: tools.map(() => ({} as Record<string, unknown>)) }]
    const spec: CompositeSpec = { ...compileComposite(signalOf(signal.workspaceKey, tools, usable, seam.now()), usable), origin: 'manual' }
    await seam.register(ctx, store, spec)
    // Idempotent accept: an earlier accept of the SAME proposal updates that row
    // instead of leaving a second row with the same name behind.
    const existing = [...store.toolMemory.entries()].find(([, record]) =>
      record.kind === 'composite' && record.status === 'active' && record.trigger === key)
    if (existing) {
      await store.toolMemory.update(existing[0], (record) => ({
        ...record,
        title: spec.title ?? record.title,
        tags: spec.tags ?? record.tags,
        description: spec.description,
        entry: JSON.stringify(spec),
        status: 'active',
      }))
    } else {
      await seam.persist(store, spec, key)
    }
    await store.signals.update(key, (record) => ({ ...record, proposalStatus: 'accepted' }))
    return { status: 'accepted', tool: spec.name, message: '已固化为组合工具 ' + spec.name }
  } catch (error) {
    return { status: 'error', message: '生成失败：' + String(error).slice(0, 200) }
  }
}

/** One sliding window of a turn's tool calls. */
export interface SequenceWindow {
  tools: string[]
  indexes: number[]
}

/** Every sliding window of minSteps..maxSteps calls, in turn order. */
export function sequenceWindows(tools: string[], minSteps: number, maxSteps: number): SequenceWindow[] {
  const out: SequenceWindow[] = []
  const low = Math.max(2, minSteps)
  const high = Math.max(low, Math.min(tools.length, maxSteps))
  for (let len = low; len <= high; len += 1) {
    for (let start = 0; start + len <= tools.length; start += 1) {
      const indexes: number[] = []
      for (let offset = 0; offset < len; offset += 1) indexes.push(start + offset)
      out.push({ tools: indexes.map((index) => tools[index]), indexes })
    }
  }
  return out
}

/** Parse the samples recorded on a durable signal. */
export function parseSamples(raw: string[]): SequenceSample[] {
  const out: SequenceSample[] = []
  for (const entry of raw) {
    try {
      const parsed = JSON.parse(entry) as SequenceSample
      if (parsed && Array.isArray(parsed.tools) && Array.isArray(parsed.args)) out.push(parsed)
    } catch {
      // one broken sample is skipped
    }
  }
  return out
}

/** Turn context the maintenance loop attaches to a recorded task observation. */
export interface TurnSequenceContext {
  sessionId?: string
  /** User request text of this turn (the primary task feature). */
  task?: string
  dispatchId?: string
  topicSetId?: string
  now?: number
}

/** Find the dispatch row of one branch session (no host dependency). */
function dispatchOf(store: Store, sessionId: string | undefined): { id: string; task: string; topicSetId?: string } | undefined {
  if (!sessionId) return undefined
  const table = (store as unknown as { dispatches?: { entries?: () => IterableIterator<[string, { branchSessionId?: string; task?: string; topicSetId?: string }]> } }).dispatches
  if (!table || typeof table.entries !== 'function') return undefined
  try {
    for (const [id, row] of table.entries()) {
      if (row?.branchSessionId !== sessionId) continue
      return { id, task: String(row.task ?? ''), ...(row.topicSetId ? { topicSetId: row.topicSetId } : {}) }
    }
  } catch { /* cold dispatch table never blocks the turn */ }
  return undefined
}

/**
 * Durable per-turn sequence counting (R49 semantics).
 *
 * R48's task-level observation is unchanged and is the only fixation path: a
 * repeated TASK becomes a skill. The sliding windows below are kept solely as the
 * optional proposal entrance: they only count when the legacy
 * autoComposite/autoToolize switch is on, only for valuable sequences, and a
 * crossing writes a PENDING proposal — never a composite, never a question.
 */
export async function recordTurnSequences(
  ctx: Context,
  store: Store,
  workspaceKey: string,
  tools: string[],
  args: Array<Record<string, unknown>>,
  config: ToolizeConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  deps?: ToolizeDeps,
  context: TurnSequenceContext = {},
): Promise<void> {
  if (tools.length < 2) return
  // ---- R48: task-level observation (once per turn, never per window) ----
  if (config.autoSkill) {
    try {
      const dispatch = dispatchOf(store, context.sessionId)
      // Dispatch task text is curated (title + task); the raw user message can
      // carry injected cards, so it comes second when both exist.
      const taskParts = [dispatch?.task, context.task].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      const task = taskParts.join('\n').trim()
      if (task) {
        const observation = await recordTaskObservation(store, workspaceKey, {
          tools,
          args,
          task,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.dispatchId ?? dispatch?.id ? { dispatchId: context.dispatchId ?? dispatch?.id } : {}),
          ...(context.topicSetId ?? dispatch?.topicSetId ? { topicSetId: context.topicSetId ?? dispatch?.topicSetId } : {}),
          ...(context.now !== undefined ? { at: context.now } : {}),
        }, {
          threshold: config.threshold,
          ...(config.skillMinSessions !== undefined ? { minSessions: config.skillMinSessions } : {}),
          ...(context.now !== undefined ? { now: context.now } : {}),
        })
        if (observation?.crossed) {
          const written = await persistTaskSkillForSignature(store, workspaceKey, observation.key, {
            threshold: config.threshold,
            ...(config.skillMinSessions !== undefined ? { minSessions: config.skillMinSessions } : {}),
            ...(config.skillRecencyDays !== undefined ? { recencyDays: config.skillRecencyDays } : {}),
            ...(context.now !== undefined ? { now: context.now } : {}),
          })
          if (written && written.status !== 'unchanged' && written.status !== 'preserved') {
            logger.info('supermemory: task skill ' + written.name + ' ' + written.status + ' (v' + written.version + ')')
          }
        }
      }
    } catch (error) {
      logger.warn('supermemory: task skill recording failed: ' + String(error).slice(0, 160))
    }
  }
  // ---- R49: sequence windows may only leave a pending proposal ----
  // With the legacy switch off (the default) nothing is written at all, so a
  // default install can neither create nor grow a pending proposal.
  if (!config.enabled) return
  const jobs = new Map<string, { tools: string[]; args: Array<Record<string, unknown>>; occurrences: number }>()
  const add = (jobTools: string[], jobArgs: Array<Record<string, unknown>>): void => {
    const key = jobTools.join('>')
    const existing = jobs.get(key)
    if (existing) {
      existing.occurrences += 1
      return
    }
    jobs.set(key, { tools: jobTools, args: jobArgs, occurrences: 1 })
  }
  const low = Math.max(2, config.minSteps)
  for (const window of sequenceWindows(tools, low, Math.min(4, low + 2))) {
    add(window.tools, window.indexes.map((index) => args[index] ?? {}))
    if (jobs.size >= 40) break
  }
  if (tools.length <= 6) add(tools, args)
  const now = context.now ?? Date.now()
  for (const [key, job] of jobs) {
    const signalKey = 'ws/' + workspaceKey + '/seq/' + key
    const verdict = proposalVerdict(job.tools)
    if (!verdict.valuable) {
      // Never a candidate. Drop a legacy row so an old pending cannot resurface.
      if (store.signals.get(signalKey) !== undefined) {
        try { await store.signals.delete(signalKey) } catch { /* the row is advisory */ }
      }
      continue
    }
    const existing = store.signals.get(signalKey)
    const count = (existing?.count ?? 0) + job.occurrences
    const samples = [...(existing?.samples ?? []), JSON.stringify({ tools: job.tools, args: job.args })].slice(-3)
    const crossed = count >= Math.max(1, config.threshold)
    const signal: Signal = {
      workspaceKey,
      pattern: key,
      count,
      lastSeen: now,
      examples: [...(existing?.examples ?? []), job.tools.join(' → ')].slice(-3),
      sequence: job.tools,
      samples,
      proposedAt: crossed ? (existing?.proposedAt ?? now) : existing?.proposedAt,
      proposalStatus: crossed ? 'pending' : existing?.proposalStatus,
    }
    await store.signals.put(signalKey, signal)
    // R49: a crossing never registers anything. memory_toolize accept is the
    // only sequence entrance (acceptProposal), and it is user-driven.
    if (crossed) logger.info('supermemory: sequence ' + key + ' crossed (count=' + count + ', pending proposal)')
  }
}

/** Tool names of one durable signal (falls back to the /seq/<a>b<c> key shape). */
function sequenceOf(signal: Signal, key: string): string[] {
  if (Array.isArray(signal.sequence) && signal.sequence.length > 0) return signal.sequence.map((tool) => String(tool))
  const match = /\/seq\/([^/]+)$/.exec(key)
  return match ? match[1].split('>').filter(Boolean) : []
}

/** True for a per-workspace tool-sequence signal row (ws/<ws>/seq/<a>b<c>). */
function isSequenceSignal(key: string): boolean {
  return /\/seq\//.test(key)
}

/** Pending proposals that are worth showing (valuable sequences only), best first. */
export function pendingProposals(store: Store): Array<[string, Signal]> {
  const out: Array<[string, Signal]> = []
  for (const [key, signal] of store.signals.entries()) {
    if (signal.proposalStatus !== 'pending' || signal.proposedAt === undefined) continue
    if (!proposalVerdict(sequenceOf(signal, key)).valuable) continue
    out.push([key, signal])
  }
  return out.sort((left, right) => right[1].count - left[1].count)
}

/** Outcome of one proposal cleanup pass. */
export interface ProposalCleanup {
  /** Pending proposals present before the pass. */
  pendingBefore: number
  /** Pending proposals removed (broad ones always; valuable ones when dropAllPending). */
  clearedProposals: number
  /** Non-pending broad sequence signal rows removed (declined legacy junk). */
  prunedSignals: number
  /** Pending proposals left after the pass. */
  pendingAfter: number
  dryRun: boolean
}

/**
 * Clear tool-sequence proposals (idempotent).
 *
 * - every BROAD sequence signal row is removed, whatever its status — those are
 *   the rows that kept run_code>run_code alive for 2700 crossings;
 * - pending proposals are removed too when dropAllPending is set (the default):
 *   the R49 rule is that a pending proposal is only meaningful while the legacy
 *   switch is on, and a one-shot clear must not need per-item decline.
 */
export async function clearSequenceSignals(
  store: Store,
  options: { dropAllPending?: boolean; dryRun?: boolean } = {},
): Promise<ProposalCleanup> {
  const dryRun = Boolean(options.dryRun)
  let pendingBefore = 0
  for (const [, signal] of store.signals.entries()) if (signal.proposalStatus === 'pending') pendingBefore += 1
  let clearedProposals = 0
  let prunedSignals = 0
  for (const [key, signal] of [...store.signals.entries()]) {
    if (!isSequenceSignal(key)) continue
    const pending = signal.proposalStatus === 'pending'
    const broad = !proposalVerdict(sequenceOf(signal, key)).valuable
    if (!broad && !(pending && options.dropAllPending === true)) continue
    if (!dryRun) {
      try { await store.signals.delete(key) } catch { continue }
    }
    if (pending) clearedProposals += 1
    else prunedSignals += 1
  }
  let pendingAfter = 0
  for (const [, signal] of store.signals.entries()) if (signal.proposalStatus === 'pending') pendingAfter += 1
  return { pendingBefore, clearedProposals, prunedSignals, pendingAfter, dryRun }
}

/** One durable sequence composite that only an automatic entrance could have made. */
export interface AutoSequenceComposite {
  id: string
  name: string
  steps: string[]
  reason: string
}

/**
 * Every ACTIVE composite row that is a legacy auto-generated broad tool-order
 * shell. Kept as a pure classifier so the panel/report and the cleanup agree.
 *
 * Judgement criteria (R49):
 *   1. tool_memory row kind='composite', status='active', definition parses;
 *   2. NOT a capability (spec.kind !== 'capability' and no entry) — a registered
 *      capability like sm_composite_git_sync_supermemory is manual by definition;
 *   3. NOT stamped origin:'manual' — an explicit memory_toolize accept;
 *   4. provenance is the automatic sequence shape (trigger matches
 *      <ws>/seq/<tools>) or the legacy origin:'auto' marker;
 *   5. the sequence itself is BROAD (every step must be non-generic), so a
 *      genuinely valuable sequence accepted before R49 is preserved.
 */
export function autoSequenceComposites(store: Store): AutoSequenceComposite[] {
  const out: AutoSequenceComposite[] = []
  for (const [id, record] of store.toolMemory.entries()) {
    if (record.kind !== 'composite' || record.status !== 'active' || !record.entry) continue
    let spec: CompositeSpec | undefined
    try {
      spec = JSON.parse(record.entry) as CompositeSpec
    } catch {
      continue // a corrupt definition cannot be judged; leave it alone
    }
    if (!spec || !Array.isArray(spec.steps)) continue
    if (spec.kind === 'capability' || spec.entry) continue
    if (spec.origin === 'manual') continue
    const autoTrigger = /(^|\/)seq\//.test(String(record.trigger ?? ''))
    if (!autoTrigger && spec.origin !== 'auto') continue
    const steps = spec.steps.map((step) => String(step.tool ?? '')).filter(Boolean)
    const verdict = proposalVerdict(steps)
    if (verdict.valuable) continue
    out.push({
      id,
      name: spec.name || id,
      steps,
      reason: '自动生成的宽泛工具序列壳子：' + verdict.reason,
    })
  }
  return out
}

/** Retire every legacy auto sequence composite (unregister + durable status). Idempotent. */
export async function retireAutoSequenceComposites(
  store: Store,
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void },
  options: { dryRun?: boolean } = {},
): Promise<AutoSequenceComposite[]> {
  const candidates = autoSequenceComposites(store)
  if (options.dryRun) return candidates
  const retired: AutoSequenceComposite[] = []
  for (const item of candidates) {
    try {
      const result = await retireComposite(store, item.id)
      if (result.status === 'ok') {
        retired.push(item)
        logger?.info('supermemory: retired auto sequence composite ' + item.name + ' (' + item.reason + ')')
      } else {
        logger?.warn?.('supermemory: retire failed for ' + item.name + ': ' + result.message)
      }
    } catch (error) {
      logger?.warn?.('supermemory: retire failed for ' + item.name + ': ' + String(error).slice(0, 120))
    }
  }
  return retired
}

/** Result of the one-shot maintenance entrance (memory_toolize cleanup + boot). */
export interface ToolizeCleanupResult {
  retired: AutoSequenceComposite[]
  retiredCount: number
  clearedProposals: number
  prunedSignals: number
  pendingBefore: number
  pendingAfter: number
  archived: ArchivedSkill[]
  archiveRoots: SkillArchiveRoot[]
  archivedCount: number
  scannedSkills: number
  dryRun: boolean
}

/**
 * R49 one-shot cleanup: legacy auto sequence composites + proposal junk + the
 * R48 shell skills, in one idempotent pass. Used by the boot path (so a reload
 * cleans the durable store before composites are rebuilt) and by
 * memory_toolize cleanup (same behaviour on demand).
 */
export async function cleanupToolize(options: {
  store: Store
  roots?: string[]
  now?: number
  dryRun?: boolean
  dropPending?: boolean
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
}): Promise<ToolizeCleanupResult> {
  const now = options.now ?? Date.now()
  const dryRun = Boolean(options.dryRun)
  const dropPending = options.dropPending !== false
  const retired = await retireAutoSequenceComposites(options.store, options.logger, { dryRun })
  const proposals = await clearSequenceSignals(options.store, { dropAllPending: dropPending, dryRun })
  let archived: ArchivedSkill[] = []
  let archiveRoots: SkillArchiveRoot[] = []
  let scannedSkills = 0
  if (options.roots !== undefined && options.roots.length > 0) {
    const result = await archiveShellSkills({ roots: options.roots, store: options.store, now, dryRun })
    archived = result.archived
    archiveRoots = result.roots
    scannedSkills = result.totalScanned
  }
  return {
    retired,
    retiredCount: retired.length,
    clearedProposals: proposals.clearedProposals,
    prunedSignals: proposals.prunedSignals,
    pendingBefore: proposals.pendingBefore,
    pendingAfter: proposals.pendingAfter,
    archived,
    archiveRoots,
    archivedCount: archived.length,
    scannedSkills,
    dryRun,
  }
}

/**
 * R48 boot sweep: durable TASK signals that already crossed the thresholds are
 * fixated as task skills. Legacy `<tool>><tool>` signals are ignored on
 * purpose — that is what keeps the cleaned-up shell skills from coming back.
 * Grouped per workspace so each lands in its own project skill root.
 */
export async function sweepSkillDrafts(
  store: Store,
  config: ToolizeConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<number> {
  if (!config.autoSkill) return 0
  const threshold = Math.max(1, config.threshold)
  const workspaces = new Set<string>()
  for (const [, signal] of store.signals.entries()) {
    if (!signal.pattern.startsWith('task:')) continue
    if (signal.count < threshold) continue
    if ((signal.sessions ?? []).length < Math.max(1, config.skillMinSessions ?? 2)) continue
    if (!signal.workspaceKey || signal.workspaceKey === 'unknown') continue
    workspaces.add(signal.workspaceKey)
  }
  if (workspaces.size === 0) return 0
  const { resolveSkillRoot, syncRepeatedTransactions } = await import('./skill-forge.ts')
  let created = 0
  for (const workspaceKey of workspaces) {
    try {
      const scope = resolveSkillRoot(workspaceKey)
      const { results } = await syncRepeatedTransactions(store, workspaceKey, scope, {
        threshold,
        ...(config.skillMinSessions !== undefined ? { minSessions: config.skillMinSessions } : {}),
        ...(config.skillRecencyDays !== undefined ? { recencyDays: config.skillRecencyDays } : {}),
      })
      for (const result of results) {
        if (result.status === 'created') created += 1
        else if (result.status === 'error') logger.warn('supermemory: skill sweep failed for ' + result.name + ': ' + result.message)
      }
    } catch (error) {
      logger.warn('supermemory: skill sweep failed for ' + workspaceKey + ': ' + String(error).slice(0, 160))
    }
  }
  if (created > 0) logger.info('supermemory: skill sweep created ' + created + ' skill(s)')
  return created
}

/** Rate limit of the idle-composite sweep (one pass per hour at most). */
let lastRecycleAt = 0

/**
 * Idle-composite recycle (requirement B2, default OFF via recycleIdleDays 0):
 * a composite with zero recorded use whose source flow has not been seen for
 * recycleIdleDays is retired (unregistered + durable status retired).
 */
export async function recycleIdleComposites(
  ctx: Context,
  store: Store,
  config: ToolizeConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  now: number = Date.now(),
): Promise<number> {
  if (config.recycleIdleDays <= 0) return 0
  if (now - lastRecycleAt < 3600000) return 0
  lastRecycleAt = now
  let retired = 0
  for (const entry of activeComposites(store)) {
    if (entry.useCount > 0) continue
    const record = store.toolMemory.get(entry.id)
    if (!record) continue
    const signal = record.trigger ? store.signals.get(record.trigger) : undefined
    const lastSeen = signal?.lastSeen ?? 0
    if (lastSeen === 0) continue
    if (now - lastSeen < config.recycleIdleDays * 86400000) continue
    try {
      await editCompositeTool(ctx, store, entry.id, { status: 'retired' })
      retired += 1
      logger.info('supermemory: recycled idle composite ' + entry.spec.name)
    } catch (error) {
      logger.warn('supermemory: recycle failed for ' + entry.spec.name + ': ' + String(error).slice(0, 120))
    }
  }
  return retired
}


