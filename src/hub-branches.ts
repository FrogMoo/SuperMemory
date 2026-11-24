/**
 * Hub → branch association (R19 协同需求②③).
 *
 * Until now the only durable hub/branch link was the `hubSessionId` field of a
 * dispatch row, and nothing projected it back: a hub could not answer "which
 * branches did I start, which are still working, are any of them shared with
 * another hub?", and the panel could not show that relation at all. This module
 * is the single read model over the dispatch table for every consumer:
 *
 *  - `prestep.ts` injects the hub-facing card (`renderHubBranchesCard`);
 *  - `panel.ts` exposes `listHubBranches` to the in-app panel;
 *  - `webui.ts` renders the same relation in the standalone console;
 *  - `hub-sessions.ts` counts a hub's branches in the left rail.
 *
 * Why a projection and not a new table: a branch ALREADY belongs to its topic
 * set (`TopicSet.members`, kind 'fork') and every dispatch already records
 * `hubSessionId`. A second relation store would be a second source of truth
 * (the exact split-brain §18.4 chased for badges). A branch shared by several
 * hubs is therefore just a branch whose dispatch rows carry more than one
 * `hubSessionId`.
 *
 * Status semantics: `working` means at least one dispatch into the branch is
 * still open (queued/dispatched/observed/summarized) — i.e. the branch owes the
 * hub a relay. A branch whose latest terminal dispatch failed/interrupted is
 * `failed` even though it is idle (a retryable dead end). Everything else is
 * `idle` (delivered and quiet). Only terminal dispatch states are trusted; the
 * member's `live` flag is a handle fact, not a work fact.
 * @module supermemory/hub-branches
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Dispatch, TopicSet } from './schema.ts'
import type { Store } from './store.ts'
import { resolveRole } from './role.ts'

/** One branch as a hub sees it. */
export interface HubBranchView {
  branchSessionId: string
  /**
   * The branch's display title (R30 需求④): the newest dispatch's explicit
   * title (the task's first line) when recorded, else the topic-set member
   * title, else the task excerpt. One field, so the hub card, the panel rows
   * and the web console show the same name.
   */
  title: string
  /** R30 需求④: the branch's tags (话题集标签 + 轮次 + 任务性质 + 能力档位). */
  tags: string[]
  /** The latest task dispatched into the branch. */
  task: string
  /** Hub that owns the row being projected (for a shared branch: one of them). */
  hubSessionId: string
  topicSetId?: string
  topicSetTitle?: string
  status: 'working' | 'idle' | 'failed'
  /** Open dispatches into this branch (the hub owes a relay). */
  openDispatches: number
  /** Total dispatches into this branch, across every hub. */
  dispatches: number
  /** Latest group id when the latest dispatch was part of a parallel group. */
  groupId?: string
  lastActivityAt: number
  /** Every hub that ever dispatched into this branch (newest activity order). */
  hubs: string[]
  /** True when more than one hub dispatched into the same branch (跨中枢共享). */
  shared: boolean
}

/** Default cap for a hub card/railing (the hub is a launcher, not an archive). */
export const HUB_BRANCH_LIMIT = 20

/** Dispatch states that still owe the hub a relay (see observe.ts settle rules). */
const OPEN_STATUSES = new Set<Dispatch['status']>(['queued', 'dispatched', 'observed', 'summarized'])

/** Terminal failure states: the branch is idle, but the work did NOT land. */
const FAILED_STATUSES = new Set<Dispatch['status']>(['failed', 'interrupted'])

/** True while a branch still has work that must reach the hub. */
export function isOpenDispatch(record: Pick<Dispatch, 'status'>): boolean {
  return OPEN_STATUSES.has(record.status)
}

/** The first topic-set member row for a branch (archived sets included). */
function memberOf(store: Store, branchSessionId: string): {
  topicSetId: string
  topicSet: TopicSet
  member: TopicSet['members'][number]
} | undefined {
  for (const [topicSetId, topicSet] of store.topicsets.entries()) {
    const member = topicSet.members.find((row) => row.sessionId === branchSessionId)
    if (member) return { topicSetId, topicSet, member }
  }
  return undefined
}

/** A one-line task excerpt (the branch has no title yet / not a member). */
export function taskExcerpt(task: string, max = 32): string {
  const text = String(task ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return '（无任务描述）'
  return Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}…` : text
}

/**
 * Card-title fallback length for a branch that has no member title yet. 48
 * characters match the session-title task budget, and taskExcerpt already
 * marks a cut with "…" (the previous call site passed 20, which clipped most
 * one-line tasks mid-word).
 */
export const BRANCH_CARD_EXCERPT_CHARS = 48

/** Human relative time for cards (coarse on purpose: the card is context, not a log). */
export function relativeAgo(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return '未知时间'
  const delta = Math.max(0, now - at)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  return `${Math.floor(delta / day)} 天前`
}

/**
 * Project one group of dispatch rows into one branch row.
 *
 * `hubSessionId` only scopes the projection (which rows are considered); the
 * resulting row still reports every hub that dispatched into the branch, so a
 * shared branch is visibly shared rather than silently re-labelled per hub.
 */
function projectBranch(
  store: Store,
  branchSessionId: string,
  rows: Dispatch[],
): HubBranchView | undefined {
  if (rows.length === 0) return undefined
  const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  const latest = sorted[0]
  const memberInfo = memberOf(store, branchSessionId)
  const member = memberInfo?.member
  // A dispatch always records its topic set; the member row can be missing (a
  // member write failed, or a fixture predates membership). Fall back to the
  // dispatch's own topicSetId so the branch still names its owning set.
  const topicSetId = memberInfo?.topicSetId ?? latest.topicSetId
  const topicSet = memberInfo?.topicSet ?? (topicSetId ? store.topicsets.get(topicSetId) : undefined)

  const hubs: string[] = []
  for (const row of sorted) {
    if (row.hubSessionId && !hubs.includes(row.hubSessionId)) hubs.push(row.hubSessionId)
  }
  const openDispatches = rows.filter(isOpenDispatch).length
  const lastTerminal = sorted.find((row) => !isOpenDispatch(row))
  const status: HubBranchView['status'] = openDispatches > 0
    ? 'working'
    : lastTerminal && FAILED_STATUSES.has(lastTerminal.status)
      ? 'failed'
      : 'idle'
  const lastActivityAt = Math.max(
    ...rows.map((row) => Math.max(Number(row.updatedAt) || 0, Number(row.lastActivityAt) || 0)),
    Number(member?.lastActiveAt) || 0,
  )
  // R30 需求④: the newest dispatch row carries the explicit title/tags
  // (schema.ts). Newest NON-EMPTY wins: a row without them (pre-R30 media, an
  // externally written row) must not erase a title the branch already earned.
  const titled = sorted.find((row) => String(row.title ?? '').trim())
  const tagged = sorted.find((row) => (row.tags ?? []).length > 0)
  const explicitTitle = String(titled?.title ?? '').trim()
  const title = explicitTitle || (member?.title ?? '').trim() || taskExcerpt(latest.task, BRANCH_CARD_EXCERPT_CHARS)
  const tags = [...(tagged?.tags ?? [])]
  const view: HubBranchView = {
    branchSessionId,
    title,
    tags,
    task: latest.task,
    hubSessionId: latest.hubSessionId,
    status,
    openDispatches,
    dispatches: rows.length,
    lastActivityAt,
    hubs,
    shared: hubs.length > 1,
  }
  if (topicSetId) view.topicSetId = topicSetId
  if (topicSet) view.topicSetTitle = topicSet.title
  if (latest.groupId) view.groupId = latest.groupId
  return view
}

/** Group dispatch rows by branch session id (insertion order of first sighting). */
function groupByBranch(rows: Array<[string, Dispatch]>): Map<string, Dispatch[]> {
  const out = new Map<string, Dispatch[]>()
  for (const [, row] of rows) {
    const branchId = String(row.branchSessionId ?? '')
    if (!branchId) continue
    const bucket = out.get(branchId)
    if (bucket) bucket.push(row)
    else out.set(branchId, [row])
  }
  return out
}

/** Every branch of the store, keyed by branch id, carrying ALL hubs' rows. */
function allBranches(store: Store): Map<string, Dispatch[]> {
  return groupByBranch([...store.dispatches.entries()])
}

/**
 * Project the selected branch ids against the COMPLETE row set of each branch.
 *
 * This is what makes sharing honest: `listHubBranches` selects branches by the
 * caller's hub, but a branch's status/activity/hub set must include dispatches
 * from every hub, otherwise a shared branch would look idle to hub B while hub A
 * is still working in it (and `shared` would always be false).
 */
function projectSelected(
  store: Store,
  all: Map<string, Dispatch[]>,
  branchIds: Iterable<string>,
  limit: number,
  cap: number,
): HubBranchView[] {
  const out: HubBranchView[] = []
  for (const branchSessionId of branchIds) {
    const view = projectBranch(store, branchSessionId, all.get(branchSessionId) ?? [])
    if (view) out.push(view)
  }
  out.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return out.slice(0, Math.max(1, Math.min(cap, Number(limit) || cap)))
}

/**
 * Branches one hub dispatched into, newest activity first.
 *
 * @param store - plugin store (dispatch rows + topic-set membership).
 * @param hubSessionId - the hub whose association is projected.
 * @param limit - maximum rows (default {@link HUB_BRANCH_LIMIT}).
 */
export function listHubBranches(
  store: Store | undefined,
  hubSessionId: string,
  limit = HUB_BRANCH_LIMIT,
): HubBranchView[] {
  const id = String(hubSessionId ?? '').trim()
  if (!store || !id) return []
  const all = allBranches(store)
  const selected = new Set<string>()
  for (const [dispatchId, row] of store.dispatches.entries()) {
    if (row.hubSessionId === id && row.branchSessionId) selected.add(String(row.branchSessionId))
    void dispatchId
  }
  return projectSelected(store, all, selected, limit, HUB_BRANCH_LIMIT)
}

/** Every branch of one topic set, whoever dispatched into it (共享视图). */
export function listTopicSetBranches(
  store: Store | undefined,
  topicSetId: string,
  limit = HUB_BRANCH_LIMIT,
): HubBranchView[] {
  const id = String(topicSetId ?? '').trim()
  if (!store || !id) return []
  const all = allBranches(store)
  const selected = new Set<string>()
  for (const [dispatchId, row] of store.dispatches.entries()) {
    if (row.topicSetId === id && row.branchSessionId) selected.add(String(row.branchSessionId))
    void dispatchId
  }
  return projectSelected(store, all, selected, limit, HUB_BRANCH_LIMIT)
}

/**
 * Every branch of one workspace's topic sets (the console's cross-hub view).
 *
 * A dispatch row carries a topicSetId, not a workspaceKey, so the workspace is
 * resolved through the set (sets are workspace-scoped since v1).
 */
export function listWorkspaceBranches(
  store: Store | undefined,
  workspaceKey: string,
  limit = 100,
): HubBranchView[] {
  if (!store || !workspaceKey) return []
  const all = allBranches(store)
  const selected = new Set<string>()
  for (const [dispatchId, row] of store.dispatches.entries()) {
    if (!row.topicSetId || !row.branchSessionId) continue
    const topicSet = store.topicsets.get(row.topicSetId)
    if (!topicSet || topicSet.workspaceKey !== workspaceKey) continue
    selected.add(String(row.branchSessionId))
    void dispatchId
  }
  return projectSelected(store, all, selected, limit, 1000)
}

/**
 * branchSessionId → the latest task dispatched into it (newest row wins).
 *
 * The panel's topic-set branch rows carry this excerpt so a preserved branch
 * stays identifiable after a restart: title + owning set + task summary, read
 * from the durable ledger alone (no live handle required).
 */
export function latestTaskByBranch(store: Store | undefined): Map<string, string> {
  const latest = new Map<string, { task: string; at: number }>()
  if (store) {
    for (const [, row] of store.dispatches.entries()) {
      const branchId = String(row.branchSessionId ?? '')
      if (!branchId) continue
      const at = Math.max(Number(row.updatedAt) || 0, Number(row.createdAt) || 0)
      const current = latest.get(branchId)
      if (!current || at >= current.at) latest.set(branchId, { task: String(row.task ?? ''), at })
    }
  }
  const out = new Map<string, string>()
  for (const [branchId, row] of latest) out.set(branchId, row.task)
  return out
}

/** branchSessionId → the hubs that dispatched into it (panel branch cards). */
export function hubsByBranch(store: Store | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!store) return map
  for (const [, row] of store.dispatches.entries()) {
    const branchId = String(row.branchSessionId ?? '')
    if (!branchId || !row.hubSessionId) continue
    const list = map.get(branchId)
    if (list) {
      if (!list.includes(row.hubSessionId)) list.push(row.hubSessionId)
    } else {
      map.set(branchId, [row.hubSessionId])
    }
  }
  return map
}

/** Branch ids of one hub with work still open (a hub should not be told "all done"). */
export function openBranchIds(store: Store | undefined, hubSessionId: string): Set<string> {
  const out = new Set<string>()
  if (!store) return out
  for (const [, row] of store.dispatches.entries()) {
    if (row.hubSessionId !== hubSessionId) continue
    if (!row.branchSessionId || !isOpenDispatch(row)) continue
    out.add(row.branchSessionId)
  }
  return out
}

/**
 * The hub-facing context card (R19 需求②): "these are your branches right now".
 *
 * Deliberately terse and bounded: the card is appended on every user step, so a
 * 20-branch list would tax every turn. It is omitted entirely when the hub has
 * no associated branch, and it always ends with the dispatch rule that keeps the
 * hub from re-dispatching a branch that is merely idle.
 *
 * R30 需求⑤.2: when the round's recall matched topic sets, the card also carries
 * those sets' branch lists (标题/标签/状态/最后活动) — the "按话题集检索其下分支
 * 会话" half of the retrieval routing, read from the durable ledger (no host
 * call). Bounded like the hub section: at most the caller's sections, each
 * capped at `maxItems` rows.
 */
export function renderHubBranchesCard(
  rows: HubBranchView[],
  options: {
    now?: number
    maxItems?: number
    /** Matched topic sets whose branches ride the same card (R30 需求⑤.2). */
    topicSets?: Array<{ title: string; rows: HubBranchView[] }>
  } = {},
): string {
  const now = options.now ?? Date.now()
  const maxItems = Math.max(1, Math.min(HUB_BRANCH_LIMIT, options.maxItems ?? 8))
  const setSections = (options.topicSets ?? []).filter((section) => section.rows.length > 0)
  if (rows.length === 0 && setSections.length === 0) return ''
  const lines: string[] = []
  if (rows.length > 0) {
    const working = rows.filter((row) => row.status === 'working').length
    const failed = rows.filter((row) => row.status === 'failed').length
    lines.push('[supermemory 关联分支] 本会话在该话题集拉起的分支：')
    for (const row of rows.slice(0, maxItems)) {
      const status = row.status === 'working' ? '工作中' : row.status === 'failed' ? '失败待处理' : '空闲'
      const parts = [
        `${status}`,
        row.topicSetTitle ? `话题集「${row.topicSetTitle}」` : '无话题集',
        relativeAgo(row.lastActivityAt, now),
      ]
      // R30 需求④: tags are part of the branch's identity now (标题 + 标签).
      if (row.tags.length > 0) parts.push(`标签 ${row.tags.join(' / ')}`)
      if (row.shared) parts.push(`与另外 ${row.hubs.length - 1} 个中枢共享`)
      lines.push(`- ${row.title}（${parts.join(' · ')}）`)
    }
    if (rows.length > maxItems) lines.push(`- …另有 ${rows.length - maxItems} 个分支（面板可查看全部）`)
    lines.push(`共 ${rows.length} 个分支：${working} 工作中 / ${failed} 失败 / ${rows.length - working - failed} 空闲。`)
    lines.push('继续同一分支用 mode=continue（忙则排队）；并行新任务用 tasks[]，每个任务独占一个分支并统一汇总。')
  }
  for (const section of setSections) {
    lines.push('')
    lines.push(`话题集「${section.title}」的分支（按话题集检索，可继续/复用）：`)
    for (const row of section.rows.slice(0, maxItems)) {
      const status = row.status === 'working' ? '工作中' : row.status === 'failed' ? '失败待处理' : '空闲'
      const parts = [status, relativeAgo(row.lastActivityAt, now)]
      if (row.tags.length > 0) parts.push(`标签 ${row.tags.join(' / ')}`)
      if (row.shared) parts.push(`与另外 ${row.hubs.length - 1} 个中枢共享`)
      lines.push(`- ${row.title}（${parts.join(' · ')}）`)
    }
    if (section.rows.length > maxItems) lines.push(`- …另有 ${section.rows.length - maxItems} 个分支（面板可查看全部）`)
  }
  return lines.join('\n')
}

/**
 * Is this agent a HUB session of its workspace?
 *
 * R33 需求②: a hub is a POSITIVE mark, never "a top-level session with no
 * parentSession". That negation classified every ordinary conversation as a hub
 * (the guard then denied bash/write/subagent in all of them) and contradicted
 * the branch rule for a root member reused as a branch. {@link resolveRole}
 * owns the single decision: branch facts win, hub marks are workspace-scoped,
 * everything else is an ordinary session.
 *
 * Never throws: a store read failure answers `false` (ordinary), which keeps the
 * prompt gate and the guard total.
 */
export function isHubSession(store: Store | undefined, agent: unknown): boolean {
  try {
    return resolveRole(store, agent).role === 'hub'
  } catch {
    return false
  }
}

/** Convenience for callers that only have the Context's agents service. */
export function isHubAgent(ctx: Context | undefined, store: Store | undefined, agent: unknown): boolean {
  void ctx
  return isHubSession(store, agent)
}
