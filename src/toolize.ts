/**
 * Tool-ization hard mechanism (requirement B): repeated flows become composite
 * tools WITHOUT a human confirmation step, and the registered composites are
 * advertised where the model can actually see them.
 *
 * Two trigger sources feed one mechanism:
 * 1. Durable per-turn sequences (maintenance, after turn/end): sliding windows of
 *    2..4 tool calls plus the whole short turn sequence. Crossing the threshold
 *    auto-registers the composite (maintenance.autoToolize, default true) under a
 *    per-workspace cooldown and an active cap; with auto off, the old pending
 *    proposal + memory_toolize confirmation path stays intact.
 * 2. Request-local repetition (activity, on tools/post-execute): the same window
 *    seen threshold times inside ONE request is already a hard signal, so it
 *    auto-registers immediately, with no user turn required.
 *
 * Registration reuses ctx.tools.register(defineTool(...)), so a composite is a
 * normal model-visible tool: it appears in the tool table with name, description
 * and parameters, and a call to a name that is not live still fails as
 * UNKNOWN_TOOL (we never advertise a name that is not registered).
 * @module supermemory/toolize
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  compileComposite,
  editCompositeTool,
  liveCompositeSpecs,
  parseArgs,
  persistComposite,
  registerComposite,
  type CompositeSpec,
  type SequenceSample,
} from './composite.ts'
import type { Signal } from './schema.ts'
import type { Store } from './store.ts'
import type { RequestState } from './inrequest.ts'

/** Tool-ization knobs (all surfaced in the plugin Config schema). */
export interface ToolizeConfig {
  enabled: boolean
  threshold: number
  cooldownMs: number
  maxActive: number
  minSteps: number
  minDistinctTools: number
  nearMissHint: boolean
  recycleIdleDays: number
}

/** Injectable seam so unit tests can drive auto-toolization without a host. */
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

/** Name compileComposite gives this sequence (single source of the naming rule). */
export function compositeNameOf(tools: string[]): string {
  const pattern = tools.join('>')
  return 'sm_composite_' + (pattern.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 24) || 'seq')
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

/** Pure decision inputs for one auto-toolization attempt. */
export interface AutoToolizePlanInput {
  tools: string[]
  existingNames: ReadonlySet<string>
  activeCount: number
  cooldown: boolean
  registered: ReadonlySet<string>
  config: ToolizeConfig
}

/** Decision of planAutoToolize; only 'create' registers anything. */
export interface AutoToolizePlan {
  action: 'create' | 'duplicate' | 'cooldown' | 'cap' | 'invalid' | 'disabled'
  reason: string
  name: string
}

/** Decide whether one sequence may become a composite right now (pure). */
export function planAutoToolize(input: AutoToolizePlanInput): AutoToolizePlan {
  const config = input.config
  const name = compositeNameOf(input.tools)
  if (!config.enabled) return { action: 'disabled', reason: 'autoToolize 关闭', name }
  if (input.tools.length < Math.max(2, config.minSteps)) return { action: 'invalid', reason: '步数不足', name }
  if (input.tools.length > 6) return { action: 'invalid', reason: '步数过多（只固化短流程）', name }
  const distinct = new Set(input.tools)
  if (distinct.size < Math.max(1, config.minDistinctTools)) return { action: 'invalid', reason: '同一工具重复不构成流程', name }
  for (const tool of input.tools) {
    if (tool.startsWith('sm_composite_')) return { action: 'invalid', reason: '序列包含组合工具本身', name }
    if (!input.registered.has(tool)) return { action: 'invalid', reason: '工具当前未注册：' + tool, name }
  }
  if (input.existingNames.has(name)) return { action: 'duplicate', reason: '组合工具已存在', name }
  if (input.activeCount >= Math.max(1, config.maxActive)) return { action: 'cap', reason: '已达组合工具上限', name }
  if (input.cooldown) return { action: 'cooldown', reason: '冷却窗口内', name }
  return { action: 'create', reason: 'ok', name }
}

/** Last successful auto-toolization time per workspace (cooldown state). */
const cooldownUntil = new Map<string, number>()

/** Outcome of one auto-toolization attempt (also records skipped reasons). */
export interface AutoToolizeOutcome {
  action: AutoToolizePlan['action'] | 'failed'
  name: string
  reason: string
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

/** Compile, register and persist one sequence under cooldown/cap/duplicate rules. */
export async function autoToolizeFromSequence(
  ctx: Context,
  store: Store,
  workspaceKey: string,
  tools: string[],
  samples: SequenceSample[],
  config: ToolizeConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  deps?: ToolizeDeps,
): Promise<AutoToolizeOutcome> {
  const seam = deps ?? defaultToolizeDeps()
  const candidates = activeComposites(store)
  const existingNames = new Set(candidates.map((candidate) => candidate.spec.name))
  const registered = new Set<string>()
  for (const tool of tools) if (seam.toolExists(ctx, tool)) registered.add(tool)
  const now = seam.now()
  const plan = planAutoToolize({
    tools,
    existingNames,
    activeCount: candidates.length,
    cooldown: (cooldownUntil.get(workspaceKey) ?? 0) > now,
    registered,
    config,
  })
  if (plan.action !== 'create') {
    if (plan.action !== 'duplicate' && plan.action !== 'disabled') {
      logger.info('supermemory: auto-toolize skipped (' + plan.action + '): ' + plan.reason + ' ' + tools.join('>'))
    }
    return { action: plan.action, name: plan.name, reason: plan.reason }
  }
  try {
    const fallback: SequenceSample = { tools, args: tools.map(() => ({} as Record<string, unknown>)) }
    const usable = samples.length > 0 ? samples : [fallback]
    const spec = compileComposite(signalOf(workspaceKey, tools, usable, now), usable)
    await seam.register(ctx, store, spec)
    await seam.persist(store, spec, 'ws/' + workspaceKey + '/seq/' + tools.join('>'))
    cooldownUntil.set(workspaceKey, now + Math.max(0, config.cooldownMs))
    logger.info('supermemory: auto-toolized ' + tools.join('>') + ' -> ' + spec.name)
    return { action: 'create', name: spec.name, reason: 'ok' }
  } catch (error) {
    logger.warn('supermemory: auto-toolize failed: ' + String(error).slice(0, 200))
    return { action: 'failed', name: plan.name, reason: String(error).slice(0, 160) }
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

/**
 * Durable per-turn sequence counting: sliding windows of 2..4 calls (each
 * occurrence counts) plus the whole turn when it is short (legacy signature).
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
): Promise<void> {
  if (tools.length < 2) return
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
  const now = Date.now()
  for (const [key, job] of jobs) {
    const signalKey = 'ws/' + workspaceKey + '/seq/' + key
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
    if (!crossed) continue
    const outcome = await autoToolizeFromSequence(ctx, store, workspaceKey, job.tools, parseSamples(samples), config, logger, deps)
    if (outcome.action === 'create' || outcome.action === 'duplicate') {
      await store.signals.update(signalKey, (record) => ({ ...record, proposalStatus: 'accepted' }))
    } else if (outcome.action !== 'disabled' && outcome.action !== 'failed') {
      // recorded skip (cap/cooldown/invalid): never turn it into a user question
      await store.signals.update(signalKey, (record) => ({ ...record, proposalStatus: 'declined' }))
    }
    logger.info('supermemory: sequence ' + key + ' crossed (count=' + count + ', auto=' + outcome.action + ')')
  }
}

/**
 * Startup sweep: auto-register every durable signal that already crossed the
 * threshold (upgrade path for signals recorded before autoToolize existed).
 */
export async function sweepAutoToolize(
  ctx: Context,
  store: Store,
  config: ToolizeConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  deps?: ToolizeDeps,
): Promise<number> {
  if (!config.enabled) return 0
  const threshold = Math.max(1, config.threshold)
  let created = 0
  for (const [key, signal] of [...store.signals.entries()]) {
    if (signal.count < threshold) continue
    if (signal.proposalStatus === 'accepted' || signal.proposalStatus === 'declined') continue
    const tools = signal.sequence ?? []
    if (tools.length < Math.max(2, config.minSteps) || tools.length > 6) continue
    const outcome = await autoToolizeFromSequence(ctx, store, signal.workspaceKey, tools, parseSamples(signal.samples ?? []), config, logger, deps)
    if (outcome.action === 'create' || outcome.action === 'duplicate') {
      await store.signals.update(key, (record) => ({ ...record, proposalStatus: 'accepted' }))
      if (outcome.action === 'create') created += 1
    }
  }
  const idle = activeComposites(store).filter((entry) => entry.useCount === 0).length
  if (idle > 0) logger.info('supermemory: ' + idle + ' composite tool(s) have zero recorded use')
  if (created > 0) logger.info('supermemory: startup sweep auto-toolized ' + created + ' sequence(s)')
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

/** The strongest same-window repetition inside ONE request (hard signal). */
export function repeatedWindow(state: RequestState, config: ToolizeConfig): { tools: string[]; samples: SequenceSample[]; count: number } | undefined {
  const names = state.recent.map((item) => item.name)
  if (names.length < 2) return undefined
  const low = Math.max(2, config.minSteps)
  const high = Math.min(4, low + 2)
  const need = Math.max(2, config.threshold)
  let best: { tools: string[]; samples: SequenceSample[]; count: number } | undefined
  for (let len = high; len >= low; len -= 1) {
    if (names.length < len) continue
    for (let start = 0; start + len <= names.length; start += 1) {
      const window = names.slice(start, start + len)
      let count = 0
      for (let probe = 0; probe + len <= names.length; probe += 1) {
        let same = true
        for (let offset = 0; offset < len; offset += 1) {
          if (names[probe + offset] !== window[offset]) {
            same = false
            break
          }
        }
        if (same) count += 1
      }
      if (count < need) continue
      if (best && best.tools.length >= len) continue
      const observations = state.recent.slice(start, start + len)
      best = { tools: window, samples: [{ tools: window, args: observations.map((item) => item.args) }], count }
    }
  }
  return best
}
