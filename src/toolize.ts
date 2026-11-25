/**
 * Auto-proposals and one-shot cleanup (R50; replaces the R49 tool-ization module).
 *
 * R50 deleted the composite-tool mechanism for good. Nothing in this module can
 * compile a tool sequence into a tool, register a tool, or mint an executable
 * capability from tool order. The only automatic product is a PENDING
 * KNOWLEDGE PROPOSAL for a repeated TASK (six sections from real samples). The
 * execution face is created only when a human accepts the proposal, and an
 * entry command is drafted only from the high-confidence rule
 * (capability.highConfidenceEntryDraft) — stored as entryDraft, never runnable
 * until the panel's enable-execution step.
 *
 * - recordTurnSequences: records one TASK observation per turn; on crossing the
 *   threshold (>=3 occurrences, >=2 sessions, 30-day window) it writes/updates a
 *   proposal (capability kind='proposal'), never a SKILL.md file.
 * - sweepTaskProposals: boot counterpart for durable task signals that already
 *   crossed (idempotent).
 * - cleanupToolize: idempotent cleanup of legacy sequence rows, pending
 *   proposals, broad sequence signals and R48 tool-sequence shell skills.
 * @module supermemory/toolize
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  capabilityRows, capabilitySkillName, createProposal, expireProposals, highConfidenceEntryDraft,
  retireShellUnits, saveCapabilityRecord, setCapabilityEnabled, syncCapabilitySkill,
  type CapabilityFacts,
} from './capability.ts'
import type { Store } from './store.ts'
import {
  archiveShellSkills, draftSkillFromTaskSignal, extractWorkflowFacts,
  parseTaskSamples, recordTaskObservation, resolveSkillRoot, signalSessionCount,
  taskSignalKey, type ArchivedSkill, type SkillArchiveRoot,
} from './skill-forge.ts'
import type { Signal } from './schema.ts'

/** Tool-ization knobs (kept for config compatibility; no field registers a tool). */
export interface ToolizeConfig {
  /** Legacy pair: R50 ignores it (sequence proposals no longer exist). */
  enabled: boolean
  threshold: number
  cooldownMs: number
  maxActive: number
  minSteps: number
  minDistinctTools: number
  nearMissHint: boolean
  recycleIdleDays: number
  /** Repeated TASK -> pending knowledge proposal (the only automatic path). */
  autoSkill?: boolean
  skillMinSessions?: number
  skillRecencyDays?: number
}

/** Turn context the maintenance loop attaches to a recorded task observation. */
export interface TurnSequenceContext {
  sessionId?: string
  task?: string
  dispatchId?: string
  topicSetId?: string
  now?: number
  /** Per-call success flags (aligned with tools); used for the entry draft rule. */
  successes?: boolean[]
}

// ---------------------------------------------------------------------------
// Broad-tool-order filter (legacy cleanup only). These predicates never create
// anything; they keep retired junk signals out of the pending list and let the
// cleanup classify old rows.
// ---------------------------------------------------------------------------

const GENERIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'run_code', 'bash', 'read', 'edit', 'write', 'glob', 'grep',
  'todo_write', 'present', 'skill', 'read_image', 'working_directory',
  'wait_agent', 'send_message', 'list_agents', 'subagent', 'subagent_fork',
  'ask_user_question', 'web_search', 'web_fetch',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
  'job_list', 'job_output', 'job_kill',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
])

const GENERIC_TOOL_PREFIXES: readonly string[] = [
  'memory_', 'sm_cap_', 'job_', 'schedule_', 'session_', 'cordis_', 'plugin_',
]

export function isGenericToolName(name: string): boolean {
  const tool = String(name ?? '').trim()
  if (!tool) return true
  if (GENERIC_TOOL_NAMES.has(tool)) return true
  return GENERIC_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix))
}

export interface ProposalVerdict {
  valuable: boolean
  reason: string
}

export function proposalVerdict(tools: readonly string[]): ProposalVerdict {
  const steps = tools.map((tool) => String(tool ?? '').trim()).filter(Boolean)
  if (steps.length < 2) return { valuable: false, reason: '步数不足（至少 2 步）' }
  if (new Set(steps).size < 2) return { valuable: false, reason: '同一工具重复不构成流程' }
  const generic = steps.find((tool) => isGenericToolName(tool))
  if (generic) return { valuable: false, reason: '宽泛工具序列：' + generic + ' 是通用工具，没有业务对象/命令/文件/入口' }
  return { valuable: true, reason: 'ok' }
}

export function isBroadSequence(tools: readonly string[]): boolean {
  return !proposalVerdict(tools).valuable
}

// ---------------------------------------------------------------------------
// Task observation -> pending proposal
// ---------------------------------------------------------------------------

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

function factsOf(samples: ReturnType<typeof parseTaskSamples>): CapabilityFacts {
  const facts = extractWorkflowFacts(samples)
  const verify = facts.commands.filter((command) => /typecheck|build|smoke|test|lint|check/i.test(command))
  return {
    commands: facts.commands,
    files: facts.files,
    ...(verify.length > 0 ? { verify } : {}),
    pitfalls: facts.patterns.slice(0, 5),
  }
}

/** Compatibility alias (tests/config keep the R48 name). */
export interface TaskObservationReport {
  signature: string
  count: number
  sessions: number
  crossed: boolean
}

/**
 * Write/refresh the pending knowledge proposal for one crossed TASK signature.
 * If a capability with the same taskKey already exists, refresh its facts
 * instead (facts-block merge; human prose is preserved by skill-forge).
 */
export async function proposeTaskCapability(
  store: Store,
  workspaceKey: string,
  signatureKey: string,
  options: { threshold: number; minSessions?: number; recencyDays?: number; now?: number; root?: string } = { threshold: 3 },
): Promise<{ status: 'created' | 'updated' | 'refreshed' | 'unchanged' | 'skipped'; name?: string; message: string }> {
  if (!workspaceKey || workspaceKey === 'unknown') return { status: 'skipped', message: '没有工作区事实，不生成提案。' }
  const signalKey = taskSignalKey(workspaceKey, signatureKey)
  const signal = store.signals.get(signalKey)
  if (!signal) return { status: 'skipped', message: '任务信号不存在。' }
  const samples = parseTaskSamples(signal.samples ?? [])
  const sessions = signalSessionCount(signal, samples)
  const draft = draftSkillFromTaskSignal(signal, samples, { sessions })
  if (!draft) return { status: 'skipped', message: '任务样本不足，不生成提案。' }
  const now = options.now ?? Date.now()
  const facts = factsOf(samples)
  const existing = capabilityRows(store).find((entry) => entry.record.kind !== 'proposal'
    && entry.record.taskKey === signatureKey
    && (!entry.row.workspaceKey || entry.row.workspaceKey === workspaceKey))
  if (existing) {
    const next = {
      ...existing.record,
      description: draft.description,
      facts,
      version: existing.record.version + 1,
      updatedAt: now,
      changelog: ['重复任务有新样本：刷新能力事实块（正文散文保留）', ...existing.record.changelog].slice(0, 20),
    }
    await saveCapabilityRecord(store, next, { id: existing.id, workspaceKey: existing.row.workspaceKey, createdAt: existing.row.createdAt })
    let root = options.root
    if (!root) { try { root = resolveSkillRoot(workspaceKey).root } catch { root = undefined } }
    if (root) {
      const updated = capabilityRows(store).find((entry) => entry.id === existing.id)
      if (updated) { try { await syncCapabilitySkill(store, updated, root, { now, changelog: '重复任务有新样本：刷新事实块' }) } catch { /* advisory */ } }
    }
    return { status: 'refreshed', name: existing.record.name, message: '已有能力，已刷新事实块。' }
  }
  const entryDraft = highConfidenceEntryDraft(samples, { scope: workspaceKey, workspaceRoot: workspaceKey })
  const result = await createProposal(store, {
    workspaceKey,
    name: capabilitySkillName(draft.name).replace(/^sm-/, ''),
    title: draft.title,
    description: draft.description,
    body: draft.body,
    facts,
    taskKey: signatureKey,
    ...(entryDraft.status === 'ok' ? { scope: workspaceKey, entryDraft: entryDraft.entry, dryRunArg: entryDraft.dryRunArg, writeConfirm: entryDraft.writeConfirm } : {}),
    source: 'auto',
    now,
  })
  return { status: result.status === 'created' ? 'created' : result.status === 'updated' ? 'updated' : 'unchanged', ...(result.name ? { name: result.name } : {}), message: result.message }
}

/**
 * Durable per-turn recording (R50): one TASK observation per turn, no sliding
 * tool-sequence windows, no registration. config.enabled is accepted for
 * compatibility and ignored.
 */
export async function recordTurnSequences(
  ctx: Context | undefined,
  store: Store,
  workspaceKey: string,
  tools: string[],
  args: Array<Record<string, unknown>>,
  config: ToolizeConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  _deps?: unknown,
  context: TurnSequenceContext = {},
): Promise<TaskObservationReport | undefined> {
  if (tools.length < 2) return undefined
  if (!config.autoSkill) return undefined
  try {
    const dispatch = dispatchOf(store, context.sessionId)
    const taskParts = [dispatch?.task, context.task].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    const task = taskParts.join('\n').trim()
    if (!task) return undefined
    const ok = Array.isArray(context.successes) && context.successes.length === tools.length
      ? context.successes.every(Boolean)
      : undefined
    const observation = await recordTaskObservation(store, workspaceKey, {
      tools,
      args,
      task,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.dispatchId ?? dispatch?.id ? { dispatchId: context.dispatchId ?? dispatch?.id } : {}),
      ...(context.topicSetId ?? dispatch?.topicSetId ? { topicSetId: context.topicSetId ?? dispatch?.topicSetId } : {}),
      ...(context.now !== undefined ? { at: context.now } : {}),
      ...(ok !== undefined ? { ok } : {}),
    }, {
      threshold: config.threshold,
      ...(config.skillMinSessions !== undefined ? { minSessions: config.skillMinSessions } : {}),
      ...(context.now !== undefined ? { now: context.now } : {}),
    })
    if (!observation) return undefined
    const report: TaskObservationReport = { signature: observation.key, count: observation.count, sessions: observation.sessions, crossed: observation.crossed }
    if (!observation.crossed) return report
    const written = await proposeTaskCapability(store, workspaceKey, observation.key, {
      threshold: config.threshold,
      ...(config.skillMinSessions !== undefined ? { minSessions: config.skillMinSessions } : {}),
      ...(config.skillRecencyDays !== undefined ? { recencyDays: config.skillRecencyDays } : {}),
      ...(context.now !== undefined ? { now: context.now } : {}),
    })
    if (written.status !== 'unchanged' && written.status !== 'skipped') {
      logger.info('supermemory: task proposal ' + (written.name ?? observation.key) + ' ' + written.status)
    }
    return report
  } catch (error) {
    logger.warn('supermemory: task proposal recording failed: ' + String(error).slice(0, 160))
    return undefined
  }
}

/** Boot sweep: durable task signals that already crossed become pending proposals. */
export async function sweepTaskProposals(
  store: Store,
  config: ToolizeConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<number> {
  if (!config.autoSkill) return 0
  const threshold = Math.max(1, config.threshold)
  let created = 0
  for (const [key, signal] of [...store.signals.entries()]) {
    if (!signal.pattern.startsWith('task:')) continue
    if (signal.count < threshold) continue
    if ((signal.sessions ?? []).length < Math.max(1, config.skillMinSessions ?? 2)) continue
    if (!signal.workspaceKey || signal.workspaceKey === 'unknown') continue
    const signatureKey = signal.pattern.slice(5)
    try {
      const result = await proposeTaskCapability(store, signal.workspaceKey, signatureKey, {
        threshold,
        ...(config.skillMinSessions !== undefined ? { minSessions: config.skillMinSessions } : {}),
        ...(config.skillRecencyDays !== undefined ? { recencyDays: config.skillRecencyDays } : {}),
      })
      if (result.status === 'created' || result.status === 'updated') created += 1
    } catch (error) {
      logger.warn('supermemory: task proposal sweep failed for ' + key + ': ' + String(error).slice(0, 160))
    }
  }
  if (created > 0) logger.info('supermemory: task proposal sweep created ' + created + ' proposal(s)')
  return created
}

/** Compatibility alias for callers/tests that still use the R48 name. */
export const sweepSkillDrafts = sweepTaskProposals

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function sequenceOf(signal: Signal, key: string): string[] {
  if (Array.isArray(signal.sequence) && signal.sequence.length > 0) return signal.sequence.map((tool) => String(tool))
  const match = /\/seq\/([^/]+)$/.exec(key)
  return match ? match[1].split('>').filter(Boolean) : []
}

function isSequenceSignal(key: string): boolean {
  return /\/seq\//.test(key)
}

export interface ProposalCleanup {
  pendingBefore: number
  clearedProposals: number
  prunedSignals: number
  pendingAfter: number
  dryRun: boolean
}

/** Clear legacy tool-sequence signals (idempotent; no tool is created). */
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
    if (!dryRun) { try { await store.signals.delete(key) } catch { continue } }
    if (pending) clearedProposals += 1
    else prunedSignals += 1
  }
  let pendingAfter = 0
  for (const [, signal] of store.signals.entries()) if (signal.proposalStatus === 'pending') pendingAfter += 1
  return { pendingBefore, clearedProposals, prunedSignals, pendingAfter, dryRun }
}

/** One retired legacy sequence row. */
export interface RetiredSequenceRow {
  id: string
  name: string
  steps: string[]
  reason: string
}

/** Every ACTIVE legacy sequence row (kind=composite/workflow, no capability entry). */
export function legacySequenceRows(store: Store): RetiredSequenceRow[] {
  const out: RetiredSequenceRow[] = []
  for (const [id, row] of store.toolMemory.entries()) {
    if (row.kind !== 'composite' && row.kind !== 'workflow') continue
    if (row.status !== 'active') continue
    let raw: Record<string, unknown>
    try { raw = JSON.parse(row.entry) as Record<string, unknown> } catch { continue }
    if (!raw || raw.kind === 'capability' || raw.schema === 'sm.capability/1') continue
    const steps = Array.isArray(raw.steps) ? (raw.steps as Array<Record<string, unknown>>).map((step) => String(step.tool ?? '')).filter(Boolean) : []
    out.push({ id, name: String(raw.name ?? id), steps, reason: '历史工具序列行：R50 已删除组合工具机制，仅保留退役记录' })
  }
  return out
}

/** Retire every legacy sequence row (idempotent). */
export async function retireLegacySequenceRows(
  store: Store,
  logger?: { info: (msg: string) => void },
  options: { dryRun?: boolean } = {},
): Promise<RetiredSequenceRow[]> {
  const candidates = legacySequenceRows(store)
  if (options.dryRun) return candidates
  const retired: RetiredSequenceRow[] = []
  for (const item of candidates) {
    try {
      await store.toolMemory.update(item.id, (row) => ({ ...row, status: 'retired' }))
      retired.push(item)
      logger?.info('supermemory: retired legacy sequence row ' + item.name)
    } catch { /* one broken row never blocks cleanup */ }
  }
  return retired
}

/** Decline every pending proposal (idempotent; never deletes the audit row). */
export async function clearPendingProposals(store: Store, options: { dryRun?: boolean } = {}): Promise<{ before: number; cleared: number }> {
  const pending = capabilityRows(store).filter((entry) => entry.record.kind === 'proposal' && entry.record.proposalStatus === 'pending')
  if (options.dryRun) return { before: pending.length, cleared: pending.length }
  let cleared = 0
  for (const entry of pending) {
    const next = { ...entry.record, proposalStatus: 'declined' as const, updatedAt: Date.now(), changelog: ['清理：待处理提案已清空', ...entry.record.changelog].slice(0, 20) }
    try { await saveCapabilityRecord(store, next, { id: entry.id, workspaceKey: entry.row.workspaceKey, createdAt: entry.row.createdAt }); cleared += 1 } catch { /* advisory */ }
  }
  return { before: pending.length, cleared }
}

export interface ToolizeCleanupResult {
  retired: RetiredSequenceRow[]
  retiredCount: number
  clearedProposals: number
  prunedSignals: number
  pendingBefore: number
  pendingAfter: number
  archived: ArchivedSkill[]
  archiveRoots: SkillArchiveRoot[]
  archivedCount: number
  scannedSkills: number
  expiredProposals: number
  /** R51: adopted shell units (knowledge rows) retired in this pass. */
  retiredShellUnits: number
  retiredShellNames: string[]
  dryRun: boolean
}

/** One idempotent cleanup pass (boot + memory_toolize cleanup). */
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
  const expiredProposals = dryRun ? 0 : await expireProposals(options.store, now)
  const retired = await retireLegacySequenceRows(options.store, options.logger, { dryRun })
  const proposals = dropPending
    ? await clearPendingProposals(options.store, { dryRun })
    : { before: capabilityRows(options.store).filter((entry) => entry.record.kind === 'proposal' && entry.record.proposalStatus === 'pending').length, cleared: 0 }
  const signals = await clearSequenceSignals(options.store, { dropAllPending: dropPending, dryRun })
  let archived: ArchivedSkill[] = []
  let archiveRoots: SkillArchiveRoot[] = []
  let scannedSkills = 0
  if (options.roots !== undefined && options.roots.length > 0) {
    const result = await archiveShellSkills({ roots: options.roots, store: options.store, now, dryRun })
    archived = result.archived
    archiveRoots = result.roots
    scannedSkills = result.totalScanned
  }
  // R51: shell rows that were adopted as knowledge units but have no directory
  // left to archive (e.g. the archive already happened on an earlier boot) are
  // retired here; archiveShellSkills only retires rows whose directory it moved.
  const shellUnits = await retireShellUnits(options.store, { dryRun })
  return {
    retired,
    retiredCount: retired.length,
    clearedProposals: Math.max(proposals.cleared, signals.clearedProposals),
    prunedSignals: signals.prunedSignals,
    pendingBefore: Math.max(proposals.before, signals.pendingBefore),
    pendingAfter: signals.pendingAfter,
    archived,
    archiveRoots,
    archivedCount: archived.length,
    scannedSkills,
    expiredProposals,
    retiredShellUnits: shellUnits.length,
    retiredShellNames: shellUnits.map((item) => item.name),
    dryRun,
  }
}

/** Idle capability recycle (default OFF via recycleIdleDays 0). */
let lastRecycleAt = 0

export async function recycleIdleCapabilities(
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
  for (const entry of capabilityRows(store)) {
    if (entry.record.kind !== 'capability' || entry.record.loadCount > 0 || entry.record.runCount > 0) continue
    if (now - entry.record.updatedAt < config.recycleIdleDays * 86400000) continue
    try {
      await setCapabilityEnabled(ctx, store, entry.id, false)
      retired += 1
      logger.info('supermemory: recycled idle capability ' + entry.record.name)
    } catch { /* one bad row never blocks the sweep */ }
  }
  return retired
}

/** Compatibility alias (maintenance imports the old name). */
export const recycleIdleComposites = recycleIdleCapabilities
