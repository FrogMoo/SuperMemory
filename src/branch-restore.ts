/**
 * 重启后分支会话恢复（需求 E 续：分支会话在 GUI 中保持可见）。
 *
 * 背景：插件的分支注册表 `branchHandles`（dispatch.ts）是进程内 Map，插件重启
 * （fiber 重新 apply）后从空开始；而启动路径里只有 reconcile 会 resume 分支——
 * 且只针对「queued/dispatched 且分支日志里没有执行痕迹」的派发行。已交付/已中断/
 * 空闲的分支（台账里的绝大多数）没有任何路径重新 attach：宿主持有的会话不会被
 * 销毁（会话日志与 workspace 绑定都是持久的），但插件侧既不持有 handle，也不会
 * 重新点亮它们，于是分支会话在 GUI 会话列表里消失、标题无法恢复
 * （applySessionTitle 只对 live 会话生效）、成员状态停留在上一个进程的陈旧值。
 *
 * 本模块在启动时从持久台账重建分支注册表：
 *   1. `collectBranchRestoreTargets`——纯函数，从 topicsets.members（fork 成员或
 *      plugin 铸造的 branch- 与 fork- 前缀 id）与 dispatches.branchSessionId 汇总所有
 *      分支会话（含所属话题集、成员标题、最近任务、最近活动时间）；
 *   2. `restoreBranchSessions`——对每个目标：已 live 的直接采用；否则经
 *      `ctx.agents.resume({resumeSessionId})` 重新 attach（宿主官方重接入口，
 *      同一会话同一段日志），把 handle 登记回 `branchHandles`，恢复成员状态与
 *      标题（ensureMemberTitle + applySessionTitle，'already' 守卫不会覆盖人工
 *      改名），并幂等重绑 workspace 可见性。
 *
 * 语义边界（与需求 E 一致，绝不回归）：
 *   - 只 attach，绝不 dispose：恢复路径不调用任何 handle.dispose()；
 *   - 恢复不投递任何消息：resume 只点亮会话（loop 处于 maintenance），不消耗
 *     token、不改变分支的工作内容；
 *   - 全程 best-effort：单个会话恢复失败只记录并继续，插件启动永不因此失败；
 *   - 话题集 root 成员（session-* 的中枢会话）不是分支，绝不在恢复范围里。
 * @module supermemory/branch-restore
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Store } from './store.ts'
import { branchHandles, compositionSetup, hubComposition, parseMemberModel } from './dispatch.ts'
import { isPluginBranchId } from './hub-sessions.ts'
import { ensureMemberTitle } from './title.ts'
import { applySessionTitle } from './session-title/gate.ts'
import { attachBranchToWorkspace } from './workspace.ts'
import { updateMember } from './topicsets.ts'

/** Default cap on sessions re-attached in one pass (ledger safety valve). */
export const BRANCH_RESTORE_LIMIT = 200

/** Default parallel resumes (host disk read + loop start per session). */
export const BRANCH_RESTORE_CONCURRENCY = 3

export interface BranchRestoreDeps {
  ctx: Context
  store: Store
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

/** One branch session the ledger says must exist, with its restore facts. */
export interface BranchRestoreTarget {
  sessionId: string
  /** Owning topic set (member row or dispatch row), when the ledger has one. */
  topicSetId?: string
  /** Topic-set title (title fallback for an unnamed member). */
  topicTitle: string
  /** Member title already stored on the ledger ('' when none). */
  memberTitle: string
  /** Latest task dispatched into the branch ('' when none). */
  task: string
  /** Latest activity time (member.lastActiveAt ?? dispatch.updatedAt). */
  lastActiveAt: number
}

export interface BranchRestoreOptions {
  /** Maximum sessions to re-attach in one pass. */
  limit?: number
  /** Parallel resumes. */
  concurrency?: number
}

export interface BranchRestoreResult {
  /** Already live in this process (nothing to do). */
  live: string[]
  /** Re-attached through ctx.agents.resume in this pass. */
  resumed: string[]
  /** Resume threw; the session stays persisted and retryable later. */
  failed: Array<{ sessionId: string; reason: string }>
  /** Not attempted (no agents seam, or beyond the cap). */
  skipped: string[]
}

/** Structural view of the host agents service (get is optional in old hosts). */
interface AgentsLike {
  get?(sessionId: string): Agent | undefined
  resume(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: Context, agent: unknown) => Promise<void>
  }): Promise<{ agent: Agent; dispose(): Promise<void> }>
}

function agentsOf(ctx: Context): AgentsLike | undefined {
  try {
    return (ctx as unknown as { get?(key: string): unknown }).get?.('agents') as AgentsLike | undefined
  } catch {
    return undefined
  }
}

/** A member row is a WORK BRANCH when it is a fork or a plugin-minted branch id. */
function isBranchMember(sessionId: string, kind: string): boolean {
  return kind === 'fork' || isPluginBranchId(sessionId)
}

/**
 * Every branch session the durable ledger knows about, newest activity first.
 *
 * Sources (deduplicated by session id, member facts preferred):
 *   - topic-set members that are work branches (kind 'fork' or a plugin-minted
 *     branch-/fork- prefixed id);
 *   - dispatch rows whose branchSessionId is a plugin-minted branch id (covers a
 *     member write that failed after the dispatch was recorded).
 * A topic-set ROOT member (session-* hub conversation) is deliberately NOT a
 * target: it is an ordinary session the user opens from the GUI, not a branch.
 */
export function collectBranchRestoreTargets(
  store: Store | undefined,
  options: { limit?: number } = {},
): BranchRestoreTarget[] {
  const out = new Map<string, BranchRestoreTarget>()
  if (!store) return []
  const upsert = (target: BranchRestoreTarget): void => {
    const existing = out.get(target.sessionId)
    if (!existing) {
      out.set(target.sessionId, target)
      return
    }
    // Member facts win over dispatch-only facts; keep the freshest activity.
    if (target.memberTitle) {
      existing.memberTitle = target.memberTitle
      if (target.topicSetId) {
        existing.topicSetId = target.topicSetId
        existing.topicTitle = target.topicTitle
      }
    } else if (target.topicSetId && !existing.topicSetId) {
      existing.topicSetId = target.topicSetId
      existing.topicTitle = target.topicTitle
    }
    if (target.task && target.lastActiveAt >= existing.lastActiveAt) existing.task = target.task
    if (target.lastActiveAt > existing.lastActiveAt) existing.lastActiveAt = target.lastActiveAt
  }
  // ---- dispatch rows first: the task/activity facts every branch carries ----
  for (const [, row] of store.dispatches.entries()) {
    const sessionId = String(row.branchSessionId ?? '')
    if (!sessionId || !isPluginBranchId(sessionId)) continue
    const topicSet = row.topicSetId ? store.topicsets.get(row.topicSetId) : undefined
    upsert({
      sessionId,
      ...(row.topicSetId ? { topicSetId: row.topicSetId } : {}),
      topicTitle: topicSet?.title ?? '',
      memberTitle: '',
      task: String(row.task ?? ''),
      lastActiveAt: Math.max(Number(row.updatedAt) || 0, Number(row.lastActivityAt) || 0, Number(row.createdAt) || 0),
    })
  }
  // ---- member rows: identity + title + owning set ----
  for (const [topicSetId, topicSet] of store.topicsets.entries()) {
    for (const member of topicSet.members) {
      if (!isBranchMember(member.sessionId, member.kind)) continue
      upsert({
        sessionId: member.sessionId,
        topicSetId,
        topicTitle: topicSet.title,
        memberTitle: member.title ?? '',
        task: '',
        lastActiveAt: Number(member.lastActiveAt) || 0,
      })
    }
  }
  const limit = Math.max(1, Math.floor(options.limit ?? BRANCH_RESTORE_LIMIT))
  return [...out.values()]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.sessionId.localeCompare(b.sessionId))
    .slice(0, limit)
}

/** Mark the member row live/idle so the panel's live count stays truthful. */
async function markMemberStatus(
  store: Store,
  target: BranchRestoreTarget,
  status: 'live' | 'idle',
): Promise<void> {
  if (!target.topicSetId) return
  try {
    const current = store.topicsets.get(target.topicSetId)
      ?.members.find((m) => m.sessionId === target.sessionId)
    // Idempotence: a re-run of the pass must not rewrite unchanged rows
    // (updateMember also refreshes lastActiveAt on every write).
    if (current && current.status === status) return
    await updateMember(store, target.topicSetId, target.sessionId, { status })
  } catch { /* membership bookkeeping is best-effort */ }
}

/** Re-attach one branch session; every step after the resume is bookkeeping. */
async function restoreOne(
  deps: BranchRestoreDeps,
  agents: AgentsLike,
  target: BranchRestoreTarget,
  result: BranchRestoreResult,
): Promise<void> {
  const { ctx, store, logger } = deps
  const id = target.sessionId
  if (branchHandles.has(id)) {
    result.live.push(id)
    await markMemberStatus(store, target, 'live')
    return
  }
  let agent: Agent | undefined
  try {
    agent = agents.get?.(id)
  } catch {
    agent = undefined
  }
  if (agent) {
    result.live.push(id)
    await markMemberStatus(store, target, 'live')
    return
  }
  // No hub agent exists at startup: composition is the resumed session's own
  // recorded preset (compositionSetup prefers the session-logged preset), and
  // no capability boundary is re-imposed here — a dispatch/resume that drives
  // the branch re-applies its own contract (R18).
  // A per-member model override (panel / /memory model branch) lives only as
  // durable text: it must WIN on resume, exactly as acquireBranch does.
  const memberModel = parseMemberModel(
    target.topicSetId
      ? store.topicsets.get(target.topicSetId)?.members.find((m) => m.sessionId === id)?.model
      : undefined,
  )
  const handle = await agents.resume({
    resumeSessionId: id,
    ...(memberModel ? { agentOptions: { ...memberModel } } : {}),
    setup: compositionSetup(ctx, hubComposition(ctx, undefined), logger),
  })
  branchHandles.set(id, { agent: handle.agent, dispose: () => handle.dispose() })
  result.resumed.push(id)
  logger.info('supermemory: restored branch ' + id.slice(0, 13) + '（重启后重新 attach，会话保留）')
  await markMemberStatus(store, target, 'live')
  // ---- title + workspace visibility: idempotent, never blocks the restore ----
  try {
    const named = await ensureMemberTitle(
      store,
      target.topicSetId ?? '',
      { sessionId: id, kind: 'fork' },
      target.topicTitle,
      target.task,
      { taskOnly: true },
    )
    // R59: one write entry. The gate keeps a human rename from being
    // overwritten and defers the host write out of any publication stack.
    await applySessionTitle({ ctx, store, logger }, {
      sessionId: id,
      kind: 'branch',
      explicitTitle: named || target.memberTitle,
      source: 'restore',
      defer: true,
    })
  } catch (error) {
    logger.warn('supermemory: branch restore naming skipped for ' + id.slice(0, 13) + ': ' + String(error).slice(0, 140))
  }
  if (target.topicSetId) {
    const workspaceKey = store.topicsets.get(target.topicSetId)?.workspaceKey
    if (workspaceKey) {
      try {
        await attachBranchToWorkspace(ctx, id, workspaceKey, logger)
      } catch { /* workspace visibility is best-effort; the durable record stands */ }
    }
  }
}

/**
 * Re-attach every preserved branch session of the ledger (startup pass).
 *
 * Idempotent: a live session is adopted as-is, so re-running the pass only
 * retries what failed before. Never throws — the caller treats restoration as
 * best-effort visibility work, and a failed resume leaves the session
 * persisted (memory_resume / the panel can still continue it later).
 */
export async function restoreBranchSessions(
  deps: BranchRestoreDeps,
  options: BranchRestoreOptions = {},
): Promise<BranchRestoreResult> {
  const { store, logger } = deps
  const result: BranchRestoreResult = { live: [], resumed: [], failed: [], skipped: [] }
  const targets = collectBranchRestoreTargets(store, { limit: options.limit })
  if (targets.length === 0) return result
  const agents = agentsOf(deps.ctx)
  if (!agents || typeof agents.resume !== 'function') {
    // No host seam (minimal profile): the ledger keeps the branches enumerable
    // in the panel/webui; nothing can be re-attached here.
    result.skipped.push(...targets.map((target) => target.sessionId))
    return result
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? BRANCH_RESTORE_CONCURRENCY, targets.length))
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= targets.length) return
      const target = targets[index]
      try {
        await restoreOne(deps, agents, target, result)
      } catch (error) {
        result.failed.push({ sessionId: target.sessionId, reason: String(error).slice(0, 160) })
        // The session may have become live MEANWHILE (reconcile path 3 resumed
        // the same branch): only mark idle when it is really not live.
        let live = false
        try {
          live = !!agents.get?.(target.sessionId)
        } catch { /* treat an unreadable registry as not-live */ }
        if (!live) await markMemberStatus(store, target, 'idle')
        logger.warn('supermemory: branch restore failed for ' + target.sessionId.slice(0, 13)
          + ': ' + String(error).slice(0, 140))
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return result
}

/** One-line summary for the startup log (kept terse; details live per-session). */
export function renderBranchRestoreSummary(result: BranchRestoreResult): string {
  const parts = [
    'resumed ' + result.resumed.length,
    'live ' + result.live.length,
    'failed ' + result.failed.length,
  ]
  if (result.skipped.length > 0) parts.push('skipped ' + result.skipped.length)
  return 'supermemory: branch restore — ' + parts.join(' / ')
}

