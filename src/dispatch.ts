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
  addMember, createTopicSet, getRouting, getTopicSet, rankMembers, setRouting, touchTopicSet, updateMember,
} from './topicsets.ts'
import { hubSelection, type ModelSelection } from './model.ts'
import { groupComplete, groupEpisodeSummaries, groupRelayExists, groupRelayText, newGroupId } from './group.ts'
import { attachBranchToWorkspace } from './workspace.ts'

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

function agentCwd(agent: unknown): string | undefined {
  return (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
}

/**
 * The dispatch tool body. `tasks[]` (2+) becomes one parallel group (D6);
 * a single `task` is the single-dispatch path. Returns receipts immediately;
 * the hub never blocks beyond branch acquisition.
 */
export async function runDispatch(
  deps: DispatchDeps,
  args: { topicSetId?: string; task?: string; tasks?: string[]; mode?: 'auto' | 'continue' | 'fork' | 'new' },
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
    topicSetId = await createTopicSet(store, { workspaceKey, title: firstTask.slice(0, 12) })
    await setRouting(store, hubSessionId, { activeTopicSetId: topicSetId, driftCount: 0 })
    logger.info(`supermemory: dispatch auto-created topic set ${topicSetId}`)
  }
  const topicSet = getTopicSet(store, topicSetId)
  if (!topicSet) return { status: 'error', message: '话题集解析失败。' }
  await touchTopicSet(store, topicSetId)

  const hubModel = hubSelection(exec.agent)
  const mode = args.mode ?? 'auto'
  const tasks = (args.tasks ?? []).map((t) => String(t ?? '').trim()).filter(Boolean)
  if (tasks.length >= 2) {
    // ---- parallel group (D6): one branch per task, single group relay later ----
    const groupId = newGroupId()
    const receipts: Array<Record<string, unknown>> = []
    for (const task of tasks) {
      const one = await dispatchOne(deps, {
        topicSetId, topicSet, task, cwd, hubSessionId, hubModel, mode: mode === 'fork' ? 'fork' : 'new', groupId,
      })
      receipts.push(one as unknown as Record<string, unknown>)
    }
    const ok = receipts.filter((r) => r.status === 'dispatched').length
    logger.info(`supermemory: group ${groupId} dispatched ${ok}/${tasks.length}`)
    const firstId = receipts[0]?.dispatchId as string | undefined
    return {
      status: ok > 0 ? 'dispatched' : 'error',
      ...(firstId ? { dispatchId: firstId } : {}),
      groupId,
      topicSetId,
      message: ok > 0
        ? `已派发 ${ok}/${tasks.length} 个分支任务（组 ${groupId}）；全部完成后只回送一次汇总，失败成员会标注。`
        : '全部任务派发失败。',
    }
  }

  const task = firstTask
  if (!task) return { status: 'error', message: 'task 不能为空。' }
  const one = await dispatchOne(deps, { topicSetId, topicSet, task, cwd, hubSessionId, hubModel, mode })
  return one
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
    mode: 'auto' | 'continue' | 'fork' | 'new'
    groupId?: string
  },
): Promise<DispatchResult> {
  const { ctx, store, logger } = deps
  const { topicSetId, topicSet, task, cwd, hubSessionId, hubModel, mode, groupId } = input

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
    const acquired = await acquireBranch(deps, { topicSetId, topicSet, task, cwd, mode, hubModel })
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

  // ---- membership + workspace visibility ----
  if (!topicSet.members.some((m) => m.sessionId === branchSessionId)) {
    await addMember(store, topicSetId, { sessionId: branchSessionId, kind, title: task.slice(0, 16) })
  }
  try {
    await attachBranchToWorkspace(ctx, branchSessionId, cwd, logger)
  } catch (error) {
    logger.warn(`supermemory: workspace attach failed for ${branchSessionId}: ${String(error).slice(0, 160)}`)
  }

  // ---- wake the branch ----
  try {
    const factory = await messageFactory()
    const message = factory({
      content: [{
        type: 'text',
        text: `[supermemory-dispatch ${dispatchId}]\n话题集：${topicSet.title}\n任务：${task}\n\n`
          + '你是该话题集的一个工作分支：完成实质工作并汇报结果。不要向用户提问，遇到分歧按最合理解释执行。',
      }],
      source: { kind: 'supermemory' },
    })
    const seqBefore = (ctx.sessions.get(branchSessionId as never) as { seq?: number } | undefined)?.seq
    handle!.agent.followup(message as UserMessage)
    await new Promise((r) => setTimeout(r, 300))
    const seqAfter = (ctx.sessions.get(branchSessionId as never) as { seq?: number } | undefined)?.seq
    logger.info(`supermemory: branch ${branchSessionId.slice(0, 20)} input landed (seq ${seqBefore} → ${seqAfter})`)
    if (seqAfter === seqBefore) {
      // the input never reached the log — surface it instead of a false receipt
      await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'failed', updatedAt: Date.now() }))
      return { status: 'error', dispatchId, ...(groupId ? { groupId } : {}), branchSessionId, message: '分支唤醒后输入未落账（followup 未生效）。' }
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
 * Branch acquisition order (§1.3): live handle → live registry agent → resume;
 * `fork` builds a seeded child from the parent's last completed turn.
 * Model resolution: topicset default → hub's current selection (so a branch
 * without a set default follows the hub) → deployment default.
 */
async function acquireBranch(
  deps: DispatchDeps,
  input: { topicSetId: string; topicSet: TopicSet; task: string; cwd: string; mode: 'auto' | 'continue' | 'fork' | 'new'; hubModel?: ModelSelection },
): Promise<{ sessionId: string; handle?: BranchHandle; kind: 'root' | 'fork' }> {
  const { ctx, store, logger } = deps
  const { topicSetId, topicSet, task, cwd, mode, hubModel } = input
  const taskTokens = new Set(task.toLowerCase().split(/[\s,，。;；:：]+/).filter(Boolean))
  const ranked = rankMembers(topicSet, taskTokens)
  const agentOptions = topicSet.defaultModel ?? hubModel

  if (mode === 'fork' || (mode === 'auto' && ranked.length > 0 && ranked[0].kind === 'fork')) {
    const parent = ranked[0]
    const forked = await forkFromParent(ctx, parent.sessionId, cwd, topicSet.defaultModel, logger)
    if (forked) return { ...forked, kind: 'fork' as const }
  }

  if (mode !== 'new' && ranked.length > 0) {
    const target = ranked[0]
    // live handle held by this plugin
    const held = branchHandles.get(target.sessionId)
    if (held) return { sessionId: target.sessionId, handle: held, kind: target.kind }
    // live registry agent
    const live = ctx.agents.get(target.sessionId as never)
    if (live) return { sessionId: target.sessionId, kind: target.kind }
    // resume the persisted session
    try {
      const handle = await ctx.agents.resume({
        resumeSessionId: target.sessionId as never,
        ...(agentOptions ? { agentOptions: { ...agentOptions } } : {}),
      })
      const branch: BranchHandle = { agent: handle.agent, dispose: () => handle.dispose() }
      branchHandles.set(target.sessionId, branch)
      await updateMember(store, topicSetId, target.sessionId, { status: 'live' })
      return { sessionId: target.sessionId, handle: branch, kind: target.kind }
    } catch (error) {
      logger.warn(`supermemory: resume ${target.sessionId} failed: ${String(error).slice(0, 160)}`)
    }
  }

  // fresh session
  const sessionId = newId('branch')
  const handle = await ctx.agents.create({
    sessionId: sessionId as never,
    meta: { cwd },
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
      meta: { cwd, isSeeded: true, parentSession: parentSessionId as never },
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

function findMember(store: Store, sessionId: string): { lastActiveAt: number } | undefined {
  for (const [, topicSet] of store.topicsets.entries()) {
    const member = topicSet.members.find((m) => m.sessionId === sessionId)
    if (member) return member
  }
  return undefined
}
