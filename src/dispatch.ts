/**
 * Async dispatch (§1.3): the hub model calls `memory_dispatch`, the plugin
 * records the dispatch, acquires a branch (continue / fork / new), wakes it
 * with `followup`, and returns a receipt immediately — the hub never blocks.
 * Observation and delivery live in observe.ts; startup retries in reconcile.ts.
 * @module supermemory/dispatch
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage, createUserMessage as CreateUserMessage } from '@deepseek-ai/dsh-llm'
import { loadHostModule } from './host.ts'
import type { Dispatch, TopicSet } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import {
  createTopicSet, getRouting, getTopicSet, rankMembers, setRouting, touchTopicSet, updateMember,
} from './topicsets.ts'
import {
  TOPIC_SET_TITLE_MAX_CHARS, applySessionTitle, cleanTitleText, clipEllipsis, ensureMemberTitle, firstLine,
} from './title.ts'
import { hubSelection, type ModelSelection } from './model.ts'
import { groupComplete, groupEpisodeSummaries, groupRelayExists, groupRelayText, newGroupId } from './group.ts'
import { attachBranchToWorkspace } from './workspace.ts'
import { noteTopicSetActivated } from './topic-shape.ts'
import { applyCapabilities, resolveCapabilities, type CapabilityProfile, type ResolvedCapability } from './capabilities.ts'
import { buildDispatchScript } from './script-delegation.ts'
import { isOpenDispatch } from './hub-branches.ts'

export interface DispatchConfig {
  enabled: boolean
  idleReleaseMs: number
}

export interface DispatchDeps {
  ctx: Context
  store: Store
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

interface ToolExec {
  agent?: { id?: string; session?: { header?: { cwd?: string } } }
}

/** The receipt/error shape `memory_dispatch` returns. */
export interface DispatchResult {
  status: 'dispatched' | 'error'
  dispatchId?: string
  branchSessionId?: string
  groupId?: string
  topicSetId?: string
  message?: string
  /** R19 协同①: one row per task of a parallel group (receipts are observable). */
  branches?: Array<{ branchSessionId?: string; task: string; status: 'dispatched' | 'error' }>
}

/** Live branch registry: sessionId → AgentHandle-ish { agent, dispose }. */
export interface BranchHandle {
  agent: Agent
  dispose(): Promise<void>
}


export const branchHandles = new Map<string, BranchHandle>()

let createMessage: typeof CreateUserMessage | undefined
async function messageFactory(): Promise<typeof CreateUserMessage> {
  if (!createMessage) {
    const llm = await loadHostModule('@deepseek-ai/dsh-llm')
    createMessage = llm.createUserMessage as typeof CreateUserMessage
  }
  return createMessage
}

/** Parse the "provider/model" text stored on a topic-set member. */
function parseMemberModel(raw: string | undefined): ModelSelection | undefined {
  if (!raw) return undefined
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

function agentCwd(agent: unknown): string | undefined {
  return (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
}

/**
 * Capability inheritance for branches (R9).
 *
 * A session created bare by `ctx.agents.create()` composes only the HOST
 * plugins: it gets `memory_*`, shell-independent session tools, and whatever
 * the Host registers — but NOT the tools its preset contributes (file tools,
 * bash, …). That is why a dispatched branch could not read, edit, or build
 * anything. The fix is the ordinary host composition path: name the preset in
 * `meta.agentPreset` and mount it onto the agent's scoped context inside the
 * creation/resume `setup` callback (exactly what the session controller and
 * the headless runner do).
 *
 * The permission mode travels the same way. Sandbox mode and approval policy
 * are durable session events (`sandbox/mode`, `approval/policy`), so appending
 * the hub's effective values makes the branch as capable as the hub — an
 * unattended branch must not stall on an approval the hub would auto-answer.
 */
interface PresetRegistryLike {
  presetForSession(session: unknown): string | null
  mount(agentCtx: Context, id: string): Promise<unknown>
}

interface PermissionPresetsLike {
  current(session: unknown): string
}

interface SandboxPolicyLike {
  resolve(request: { session?: unknown }): { mode?: string }
  overrideOf?(session: unknown): string | undefined
}

interface ApprovalLike {
  overrideOf(session: unknown): string | undefined
  config?: { policy?: string }
}

/** One session's durable append channel (structural view of the host Session). */
interface AppendableSession {
  append(type: string, data: unknown): void
}

/** Composition facts copied from the hub into every branch it dispatches. */
export interface HubComposition {
  /** Agent preset the hub runs under (undefined when the host composes no roster). */
  presetId?: string
  /** Effective sandbox mode of the hub session. */
  sandboxMode?: string
  /** Effective approval policy of the hub session. */
  approvalPolicy?: string
}

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get?(key: string): unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

function sessionOf(agent: unknown): unknown {
  return (agent as { session?: unknown } | undefined)?.session
}

/** Read the hub's preset and permission facts, each independently optional. */
export function hubComposition(ctx: Context, hubAgent: unknown): HubComposition {
  const session = sessionOf(hubAgent)
  if (!session) return {}
  const out: HubComposition = {}
  try {
    const presetId = serviceOf<PresetRegistryLike>(ctx, 'agentPresets')
      ?.presetForSession(session)
      ?? (session as { header?: { agentPreset?: string } }).header?.agentPreset
    if (presetId) out.presetId = presetId
  } catch { /* no projection: the header read above already covered the common case */ }
  try {
    const sandbox = serviceOf<SandboxPolicyLike>(ctx, 'sandboxPolicy')
    const mode = sandbox?.resolve?.({ session }).mode ?? sandbox?.overrideOf?.(session)
    if (mode) out.sandboxMode = mode
  } catch { /* permission services absent (headless/minimal profiles) */ }
  try {
    const approval = serviceOf<ApprovalLike>(ctx, 'approval')
    const policy = approval?.overrideOf?.(session) ?? approval?.config?.policy
    if (policy) out.approvalPolicy = policy
  } catch { /* same: degrade to the deployment default */ }
  return out
}

/**
 * Build the pre-publication `setup` callback that mounts the preset onto the
 * fresh agent scope and copies the hub's permission facts.
 *
 * Exported as the seam scripts/mechanism-smoke.mjs drives (F5): the branch
 * capability contract must hold without a DSH host.
 *
 * Mount is best-effort on purpose: a roster that lost the preset must not fail
 * the dispatch (the branch still gets the Host tools and the relay channel),
 * but the degradation is logged so the cause is visible.
 */
export function compositionSetup(
  ctx: Context,
  wanted: HubComposition,
  logger: { warn: (msg: string) => void; info?: (msg: string) => void },
  capabilities?: ResolvedCapability,
): (agentCtx: Context, agent: unknown) => Promise<void> {
  return async (agentCtx, agent) => {
    const session = sessionOf(agent)
    const presets = serviceOf<PresetRegistryLike>(ctx, 'agentPresets')
    let presetId = wanted.presetId
    try {
      // A resumed branch logs the preset it actually ran under; that record
      // wins over the hub's so a resumed session keeps one composition.
      const recorded = session ? presets?.presetForSession(session) : null
      if (recorded) presetId = recorded
    } catch { /* projection unreadable: keep the requested preset */ }
    if (presets && presetId) {
      try {
        await presets.mount(agentCtx, presetId)
      } catch (error) {
        logger.warn(`supermemory: agent preset「${presetId}」mount failed for a branch (${String(error).slice(0, 160)}); the branch keeps host tools only`)
      }
    }
    // R18: the capability profile is enforced on the BRANCH scope only. The
    // preset was mounted above, so `definitions(agent)` now reports the tools
    // the branch would really see; the static deny list is intersected with
    // them because tools.restrict() rejects unknown names outright.
    if (capabilities) {
      const applied = applyCapabilities(
        (agentCtx as unknown as { tools?: unknown }).tools,
        agent,
        capabilities,
        logger,
      )
      if (applied.status === 'applied' && applied.denied.length > 0) {
        logger.info?.(`supermemory: branch capability「${capabilities.profile}」applied (${applied.denied.length} tools denied)`)
      }
    }
    if (!(session as AppendableSession | undefined)?.append) return
    try {
      if (wanted.sandboxMode) (session as AppendableSession).append('sandbox/mode', { mode: wanted.sandboxMode, source: 'delegation' })
      if (wanted.approvalPolicy) (session as AppendableSession).append('approval/policy', { policy: wanted.approvalPolicy, source: 'delegation' })
    } catch (error) {
      logger.warn(`supermemory: permission inheritance failed for a branch (${String(error).slice(0, 160)})`)
    }
  }
}

/**
 * The dispatch tool body. `tasks[]` (2+) becomes one parallel group (D6);
 * a single `task` is the single-dispatch path. Returns receipts immediately;
 * the hub never blocks beyond branch acquisition.
 *
 * R19 协同①: parallel groups were silently weaker than advertised. The old code
 * mapped every group task to `new` (so `continue`/`auto` reuse was impossible)
 * and acquisition always ranked `members[0]`, so two similar tasks could be
 * steered at one branch and merged into a single conversation. Group tasks now
 * CLAIM distinct branches (`claimed`), each task reuses an idle topic-set branch
 * when one ranks and otherwise gets its own fresh branch, and one task's
 * exception no longer aborts the remaining tasks (it becomes an annotated
 * failure member, so the single group relay still accounts for every task).
 *
 * R19 协同③: a branch belongs to its TOPIC SET, not to the hub that created it.
 * `acquireBranch` never scopes reuse by `hubSessionId`; any hub of the same set
 * can continue an idle branch (that is what "共享" means here), while a busy
 * branch is never silently merged into — `auto` falls back to a fresh branch and
 * only an explicit `mode=continue` queues behind the busy branch.
 */
export async function runDispatch(
  deps: DispatchDeps,
  args: {
    topicSetId?: string
    task?: string
    tasks?: string[]
    mode?: 'auto' | 'continue' | 'fork' | 'new'
    /** R18: capability boundary granted to the branch(es); default 'read-write'. */
    capabilities?: CapabilityProfile | string
  },
  exec: ToolExec,
): Promise<DispatchResult> {
  const { ctx, store, logger } = deps
  const hubSessionId = String(exec.agent?.id ?? '')
  const cwd = agentCwd(exec.agent)
  if (!hubSessionId || !cwd) {
    return { status: 'error', message: '无法确定中枢会话或工作区（agent 会话缺少 cwd），已拒绝派发。' }
  }
  const workspaceKey = workspaceKeyOf(cwd)

  // ---- resolve the topic set ----
  let topicSetId = args.topicSetId?.trim()
  if (topicSetId && !getTopicSet(store, topicSetId)) {
    return { status: 'error', message: `话题集 ${topicSetId} 不存在。` }
  }
  if (!topicSetId) {
    topicSetId = getRouting(store, hubSessionId)?.activeTopicSetId
  }
  const firstTask = (args.task ?? args.tasks?.[0] ?? '').trim()
  if (!topicSetId) {
    topicSetId = await createTopicSet(store, {
      workspaceKey,
      // An auto-created set is named after the task that created it: first
      // line, markup stripped, shown whole up to TOPIC_SET_TITLE_MAX_CHARS
      // and clipped with "…" beyond that (the old slice(0, 12) cut every
      // auto-created title at 12 characters with no marker).
      title: clipEllipsis(firstLine(cleanTitleText(firstTask)), TOPIC_SET_TITLE_MAX_CHARS),
    })
    await setRouting(store, hubSessionId, { activeTopicSetId: topicSetId, driftCount: 0 })
    // R19 需求⑥: a dispatch that auto-created/bound a set activates it; the
    // shape refresh is content-gated and throttled, so this is cheap.
    noteTopicSetActivated({ ctx, store, logger }, topicSetId)
    logger.info(`supermemory: dispatch auto-created topic set ${topicSetId}`)
  }
  const topicSet = getTopicSet(store, topicSetId)
  if (!topicSet) return { status: 'error', message: '话题集解析失败。' }
  await touchTopicSet(store, topicSetId)

  const hubModel = hubSelection(exec.agent)
  const composition = hubComposition(ctx, exec.agent)
  const capabilities = resolveCapabilities(args.capabilities)
  const mode = args.mode ?? 'auto'
  const tasks = (args.tasks ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
  if (tasks.length >= 2) {
    // ---- parallel group (D6): one DISTINCT branch per task, single relay later ----
    const groupId = newGroupId()
    // `continue` inside a group would queue two parallel tasks into one branch,
    // which is exactly the merge this round removes; treat it as `auto` (reuse an
    // idle branch, else create a fresh one). `fork`/`new` keep their meaning.
    const groupMode: 'auto' | 'fork' | 'new' = mode === 'fork' ? 'fork' : mode === 'new' ? 'new' : 'auto'
    const claimed = new Set<string>()
    const receipts: Array<{ task: string; result: DispatchResult }> = []
    for (const task of tasks) {
      let result: DispatchResult
      try {
        result = await dispatchOne(deps, {
          topicSetId, topicSet, task, cwd, hubSessionId, hubModel, composition, capabilities,
          mode: groupMode, groupId, excludeBranches: claimed,
        })
      } catch (error) {
        // One task must not abort the group: record it as a failed member so
        // groupComplete() waits for every task and the relay annotates it.
        const failed = await recordGroupFailure(deps, {
          topicSetId, task, hubSessionId, groupId, error,
        })
        result = {
          status: 'error', dispatchId: failed, groupId, topicSetId,
          message: `分支派发异常：${String(error).slice(0, 200)}`,
        }
      }
      if (result.branchSessionId) claimed.add(result.branchSessionId)
      receipts.push({ task, result })
    }
    const ok = receipts.filter((row) => row.result.status === 'dispatched').length
    logger.info(`supermemory: group ${groupId} dispatched ${ok}/${tasks.length} (distinct branches: ${claimed.size})`)
    const firstId = receipts[0]?.result.dispatchId
    return {
      status: ok > 0 ? 'dispatched' : 'error',
      ...(firstId ? { dispatchId: firstId } : {}),
      groupId,
      topicSetId,
      branches: receipts.map((row) => ({
        ...(row.result.branchSessionId ? { branchSessionId: row.result.branchSessionId } : {}),
        task: row.task,
        status: row.result.status,
      })),
      message: ok > 0
        ? `已派发 ${ok}/${tasks.length} 个分支任务（组 ${groupId}，每个任务独占一个分支并行执行）；`
          + '全部到达终态后只回送一次汇总，失败成员会单独标注。'
        : `全部任务派发失败（组 ${groupId}）。`,
    }
  }

  const task = firstTask
  if (!task) return { status: 'error', message: 'task 不能为空。' }
  const one = await dispatchOne(deps, { topicSetId, topicSet, task, cwd, hubSessionId, hubModel, composition, capabilities, mode })
  return one
}

/**
 * Record a group member whose dispatch threw before a record was written. A
 * missing row would make `groupComplete` skip the task entirely (the relay then
 * claims "N 成功 / 0 失败" while a task silently vanished). Returns the id.
 */
async function recordGroupFailure(
  deps: DispatchDeps,
  input: { topicSetId: string; task: string; hubSessionId: string; groupId: string; error: unknown },
): Promise<string> {
  const dispatchId = newId('dsp')
  const now = Date.now()
  try {
    await deps.store.dispatches.put(dispatchId, {
      topicSetId: input.topicSetId,
      groupId: input.groupId,
      branchSessionId: '',
      task: input.task,
      hubSessionId: input.hubSessionId,
      startSeq: 0,
      status: 'failed',
      turnEndReason: `dispatch-error: ${String(input.error).slice(0, 120)}`,
      createdAt: now,
      updatedAt: now,
    })
  } catch (error) {
    deps.logger.warn(`supermemory: group failure record failed: ${String(error).slice(0, 160)}`)
  }
  return dispatchId
}

/** One dispatch: record → acquire → wake → receipt. Shared by both paths. */
async function dispatchOne(
  deps: DispatchDeps,
  input: {
    topicSetId: string
    topicSet: TopicSet
    task: string
    cwd: string
    hubSessionId: string
    hubModel?: ModelSelection
    composition: HubComposition
    /** R18: capability profile enforced on the branch scope + written into the script. */
    capabilities: ResolvedCapability
    mode: 'auto' | 'continue' | 'fork' | 'new'
    groupId?: string
    /** R19 协同①: branches already claimed by this group (never reuse them). */
    excludeBranches?: Set<string>
  },
): Promise<DispatchResult> {
  const { ctx, store, logger } = deps
  const { topicSetId, topicSet, task, cwd, hubSessionId, hubModel, composition, capabilities, mode, groupId, excludeBranches } = input

  const dispatchId = newId('dsp')
  const now = Date.now()
  const record: Dispatch = {
    topicSetId,
    groupId,
    branchSessionId: '',
    task,
    hubSessionId,
    // filled after acquisition: the branch log position this dispatch starts from
    startSeq: 0,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  }
  await store.dispatches.put(dispatchId, record)

  // ---- acquire the branch ----
  let branchSessionId: string
  let handle: BranchHandle | undefined
  let kind: 'root' | 'fork' = 'root'
  try {
    const acquired = await acquireBranch(deps, {
      topicSetId, topicSet, task, cwd, mode, hubModel, composition, capabilities,
      ...(excludeBranches && excludeBranches.size > 0 ? { exclude: excludeBranches } : {}),
    })
    branchSessionId = acquired.sessionId
    handle = acquired.handle
    kind = acquired.kind
  } catch (error) {
    await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'failed', updatedAt: Date.now() }))
    return { status: 'error', dispatchId, ...(groupId ? { groupId } : {}), message: `分支获取失败：${String(error).slice(0, 200)}` }
  }

  await store.dispatches.update(dispatchId, (r) => ({
    ...r,
    branchSessionId,
    // §2.2: startSeq is the BRANCH log position this dispatch's input starts from
    startSeq: (ctx.sessions.get(branchSessionId as never) as { seq?: number } | undefined)?.seq ?? 0,
    status: 'dispatched',
    updatedAt: Date.now(),
  }))

  // ---- membership + naming + workspace visibility ----
  // Bookkeeping only: a failed member write must not lose the dispatch that is
  // already recorded and about to be woken. Requirement C: the member title AND
  // the host session title are set here, so a NEW branch, a resumed branch and a
  // fork all leave the unnamed state behind (a reused member keeps its first
  // stable title; the host title is only applied while the session has none).
  try {
    const named = await ensureMemberTitle(store, topicSetId, { sessionId: branchSessionId, kind }, topicSet.title, task)
    const applied = applySessionTitle(ctx, branchSessionId, named, logger)
    if (applied === 'host' || applied === 'fallback') {
      logger.info(`supermemory: named branch ${branchSessionId.slice(0, 20)} 「${named}」 via ${applied}`)
    }
  } catch (error) {
    logger.warn(`supermemory: branch naming failed for ${branchSessionId}: ${String(error).slice(0, 160)}`)
  }
  try {
    await attachBranchToWorkspace(ctx, branchSessionId, cwd, logger)
  } catch (error) {
    logger.warn(`supermemory: workspace attach failed for ${branchSessionId}: ${String(error).slice(0, 160)}`)
  }

  // ---- wake the branch ----
  try {
    const factory = await messageFactory()
    // R18 需求④: the capability boundary is written into the branch's own first
    // message (not only enforced by the scope), so a host without the restrict
    // seam still sees the contract. R19: group membership is stated too, so the
    // branch knows its result is aggregated with sibling tasks.
    const script = buildDispatchScript({
      task,
      capabilities: capabilities.profile,
      topicTitle: topicSet.title,
      branchSessionId,
      dispatchId,
    })
    const message = factory({
      content: [{
        type: 'text',
        text: groupId
          ? `${script}\n\n本任务是并行组 ${groupId} 的一员：只负责这一个任务；全部成员到达终态后由中枢统一汇总，不要等待其他分支。`
          : script,
      }],
      source: { kind: 'supermemory' },
    })
    if (!handle) throw new Error('分支句柄缺失（acquireBranch 未返回 handle）')
    const seqBefore = (ctx.sessions.get(branchSessionId as never) as { seq?: number } | undefined)?.seq
    handle.agent.followup(message as UserMessage)
    await new Promise((r) => setTimeout(r, 300))
    const seqAfter = (ctx.sessions.get(branchSessionId as never) as { seq?: number } | undefined)?.seq
    if (typeof seqBefore === 'number' && typeof seqAfter === 'number' && seqAfter > seqBefore) {
      // §2.2: the dispatch input landed at seqBefore+1, so the ownership window
      // must start at that pre-append position — otherwise a later turn/end
      // would be matched against a stale (often 0) startSeq.
      await store.dispatches.update(dispatchId, (r) => ({ ...r, startSeq: seqBefore, updatedAt: Date.now() }))
      logger.info(`supermemory: branch ${branchSessionId.slice(0, 20)} input landed (seq ${seqBefore} → ${seqAfter})`)
    } else {
      // A busy branch may queue the followup past this 300ms probe. Failing the
      // dispatch here stranded work that DID land later (observe settled only
      // open dispatches). Leave it dispatched: observe settles it when the
      // turn/end arrives, and reconcile path 3 re-follows an untraced input.
      logger.info(`supermemory: branch ${branchSessionId.slice(0, 20)} input not observed yet (seq ${seqBefore} → ${seqAfter}); leaving it to observation/reconciliation`)
    }
  } catch (error) {
    logger.warn(`supermemory: branch followup threw: ${String(error).slice(0, 300)}`)
    await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'failed', updatedAt: Date.now() }))
    return { status: 'error', dispatchId, ...(groupId ? { groupId } : {}), branchSessionId, message: `分支唤醒失败：${String(error).slice(0, 200)}` }
  }

  logger.info(`supermemory: dispatched ${dispatchId} → ${branchSessionId}`)
  return {
    dispatchId, branchSessionId, status: 'dispatched', topicSetId,
    ...(groupId ? { groupId } : {}),
  }
}

/**
 * Pure branch-selection plan (R19 协同①③), exported as the test seam.
 *
 * `busy` is the set of branches with an open dispatch; `exclude` the branches a
 * parallel group already claimed. The rules are:
 *  - `new`: never reuse (candidates empty);
 *  - `fork`: fork the best ranked member (when any);
 *  - `continue`: rank order as-is, INCLUDING busy branches (explicit queueing);
 *  - `auto`: rank order restricted to IDLE branches — a busy branch is never
 *    merged into implicitly. No idle candidate means a fresh branch.
 * Hub identity is deliberately absent: branches belong to the topic set and any
 * hub of that set may continue one (cross-hub sharing).
 */
export function branchCandidates(
  topicSet: TopicSet,
  task: string,
  mode: 'auto' | 'continue' | 'fork' | 'new',
  busy: ReadonlySet<string>,
  exclude?: ReadonlySet<string>,
): { forkParent?: TopicSet['members'][number]; candidates: TopicSet['members'] } {
  const taskTokens = new Set(task.toLowerCase().split(/[\s,，。;；:：]+/).filter(Boolean))
  const ranked = rankMembers(topicSet, taskTokens)
    .filter((member) => !exclude?.has(member.sessionId))
  if (mode === 'new') return { candidates: [] }
  return {
    ...(mode === 'fork' && ranked.length > 0 ? { forkParent: ranked[0] } : {}),
    // Only `continue` may queue behind a busy branch; `auto` and a fork's
    // fallback reuse IDLE branches only (a failed fork must not merge tasks).
    candidates: mode === 'continue'
      ? ranked
      : ranked.filter((member) => !busy.has(member.sessionId)),
  }
}

/** Branches with at least one open dispatch (the `busy` input of the plan). */
export function busyBranches(store: Store): Set<string> {
  const busy = new Set<string>()
  for (const [, record] of store.dispatches.entries()) {
    if (record.branchSessionId && isOpenDispatch(record)) busy.add(record.branchSessionId)
  }
  return busy
}

/**
 * Branch acquisition order (§1.3): live handle → live registry agent → resume;
 * `fork` builds a seeded child from the parent's last completed turn.
 * Model resolution: topicset default → hub's current selection (so a branch
 * without a set default follows the hub) → deployment default.
 *
 * R19 协同①③: the plan above decides WHICH branches are eligible; this function
 * only executes it. `auto` therefore never forks (that split a set-owned branch
 * instead of continuing it) and never merges into a busy branch; only explicit
 * `continue` queues behind one.
 */
async function acquireBranch(
  deps: DispatchDeps,
  input: {
    topicSetId: string
    topicSet: TopicSet
    task: string
    cwd: string
    mode: 'auto' | 'continue' | 'fork' | 'new'
    hubModel?: ModelSelection
    composition: HubComposition
    capabilities: ResolvedCapability
    /** R19 协同①: branches claimed by the current group (skip them). */
    exclude?: Set<string>
  },
): Promise<{ sessionId: string; handle?: BranchHandle; kind: 'root' | 'fork' }> {
  const { ctx, store, logger } = deps
  const { topicSetId, topicSet, task, cwd, mode, hubModel, composition, capabilities, exclude } = input
  const agentOptions = topicSet.defaultModel ?? hubModel
  const plan = branchCandidates(topicSet, task, mode, busyBranches(store), exclude)

  // A fork needs a parent member. With an empty topic set (or no ranked member)
  // there is nothing to fork from, so fall through to a fresh branch instead of
  // dereferencing an absent member.
  if (mode === 'fork' && plan.forkParent) {
    const forked = await forkFromParent(ctx, plan.forkParent.sessionId, cwd, topicSet.defaultModel, composition, capabilities, logger)
    if (forked) return { ...forked, kind: 'fork' as const }
  }

  for (const target of plan.candidates) {
    // live handle held by this plugin
    const held = branchHandles.get(target.sessionId)
    if (held) return { sessionId: target.sessionId, handle: held, kind: target.kind }
    // Live registry agent (e.g. the user opened this branch session in the
    // GUI, or a topic-set session was created through the panel). It is
    // host-owned, so it must be driven without being disposed — and the caller
    // REQUIRES a handle: returning none made dispatchOne dereference undefined
    // and fail the dispatch with a TypeError.
    const live = ctx.agents.get(target.sessionId as never)
    if (live) {
      await updateMember(store, topicSetId, target.sessionId, { status: 'live' })
      return {
        sessionId: target.sessionId,
        handle: { agent: live, dispose: async () => { /* host-owned: never disposed here */ } },
        kind: target.kind,
      }
    }
    // resume the persisted session
    try {
      // A per-member model override (panel / `/memory model branch`) only exists
      // as durable text: it must WIN on resume, otherwise the recorded override
      // silently degrades to the topic-set default.
      const memberModel = parseMemberModel(target.model)
      const resumeOptions = memberModel ?? agentOptions
      const handle = await ctx.agents.resume({
        resumeSessionId: target.sessionId as never,
        ...(resumeOptions ? { agentOptions: { ...resumeOptions } } : {}),
        setup: compositionSetup(ctx, composition, logger, capabilities),
      })
      const branch: BranchHandle = { agent: handle.agent, dispose: () => handle.dispose() }
      branchHandles.set(target.sessionId, branch)
      await updateMember(store, topicSetId, target.sessionId, { status: 'live' })
      return { sessionId: target.sessionId, handle: branch, kind: target.kind }
    } catch (error) {
      logger.warn(`supermemory: resume ${target.sessionId} failed: ${String(error).slice(0, 160)}`)
      // try the next candidate: one unreadable persisted branch must not turn
      // a reusable-work dispatch into a brand-new branch if a sibling is idle.
    }
  }

  // fresh session: the hub's preset is named in the header (a creation fact)
  // and mounted during setup, so the branch composes the same tool set.
  const sessionId = newId('branch')
  const handle = await ctx.agents.create({
    sessionId: sessionId as never,
    meta: { cwd, ...(composition.presetId ? { agentPreset: composition.presetId } : {}) },
    setup: compositionSetup(ctx, composition, logger, capabilities),
    ...(agentOptions ? { agentOptions: { ...agentOptions } } : {}),
  })
  const branch: BranchHandle = { agent: handle.agent, dispose: () => handle.dispose() }
  branchHandles.set(sessionId, branch)
  return { sessionId, handle: branch, kind: 'root' as const }
}

/** Fork a seeded child from the parent's last completed-turn prefix (§1.3). */
async function forkFromParent(
  ctx: Context,
  parentSessionId: string,
  cwd: string,
  defaultModel: TopicSet['defaultModel'],
  composition: HubComposition,
  capabilities: ResolvedCapability,
  logger: { warn: (msg: string) => void },
): Promise<{ sessionId: string; handle?: BranchHandle } | undefined> {
  try {
    const parent = ctx.agents.get(parentSessionId as never)
    if (!parent) return undefined
    const boundary = ctx.agents.turnBoundaryOf(parent.session as never) as {
      openTurnStartSeq: number | null
      lastTurn: number
    }
    if (boundary.openTurnStartSeq === null || boundary.openTurnStartSeq === undefined) {
      logger.warn(`supermemory: fork skipped — parent ${parentSessionId} has no closed-turn boundary`)
      return undefined
    }
    const cut = boundary.openTurnStartSeq
    const persistence = ctx.sessionPersistence as unknown as {
      open(id: string, access: 'read'): Promise<{
        read(offset?: number, length?: number): Promise<{ events: unknown[] }>
        close(): Promise<void>
      }>
    }
    const handle = await persistence.open(parentSessionId, 'read')
    const { events } = await handle.read(0, cut)
    await handle.close()
    const sessionId = newId('fork')
    const created = await ctx.agents.create({
      sessionId: sessionId as never,
      seed: events as never,
      inheritedEventCount: cut as never,
      meta: {
        cwd,
        isSeeded: true,
        parentSession: parentSessionId as never,
        ...(composition.presetId ? { agentPreset: composition.presetId } : {}),
      },
      setup: compositionSetup(ctx, composition, logger, capabilities),
      ...(defaultModel ? { agentOptions: { ...defaultModel } } : {}),
    })
    const branch: BranchHandle = { agent: created.agent, dispose: () => created.dispose() }
    branchHandles.set(sessionId, branch)
    return { sessionId, handle: branch }
  } catch (error) {
    logger.warn(`supermemory: fork from ${parentSessionId} failed: ${String(error).slice(0, 200)}`)
    return undefined
  }
}

/** Release idle branch handles (decision D5: never before outbox is empty). */
export function releasableBranches(store: Store, now: number, idleReleaseMs: number): string[] {
  const out: string[] = []
  // dispatchId → branchSessionId, for the D5 outbox check
  const dispatchBranch = new Map<string, string>()
  for (const [dispatchId, record] of store.dispatches.entries()) {
    if (record.branchSessionId) dispatchBranch.set(dispatchId, record.branchSessionId)
  }
  const blocked = new Set<string>()
  for (const [deliveryId, item] of store.outbox.entries()) {
    if (item.status !== 'pending' && item.status !== 'relayed') continue
    const branch = item.dispatchId ? dispatchBranch.get(item.dispatchId) : undefined
    if (branch) blocked.add(branch)
    void deliveryId
  }
  for (const [sessionId] of branchHandles) {
    if (blocked.has(sessionId)) continue
    const member = findMember(store, sessionId)
    if (!member) continue
    if (now - member.lastActiveAt < idleReleaseMs) continue
    out.push(sessionId)
  }
  return out
}

/**
 * E: 保留分支会话——空闲分支只释放插件侧 handle（从 branchHandles 摘除），
 * 绝不调用 handle.dispose()：宿主语义是停 loop、关闭写句柄、注销 agent，而分支
 * 会话的持久日志与可恢复性必须留下（acquireBranch 的 live→resume 路径随时续接，
 * memory_resume 也依赖它继续被中断的任务）。判定沿用 releasableBranches
 * （D5：有未交付 outbox 的分支不释放）。
 */
export function detachIdleBranches(
  store: Store,
  now: number,
  idleReleaseMs: number,
  logger: { info: (msg: string) => void },
): string[] {
  const detached: string[] = []
  for (const sessionId of releasableBranches(store, now, idleReleaseMs)) {
    if (branchHandles.delete(sessionId)) {
      detached.push(sessionId)
      logger.info(`supermemory: detached idle branch ${sessionId.slice(0, 13)}（会话保留，可续接）`)
    }
  }
  return detached
}

function findMember(store: Store, sessionId: string): { lastActiveAt: number } | undefined {
  for (const [, topicSet] of store.topicsets.entries()) {
    const member = topicSet.members.find((m) => m.sessionId === sessionId)
    if (member) return member
  }
  return undefined
}
