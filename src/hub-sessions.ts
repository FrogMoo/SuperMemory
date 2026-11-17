/**
 * Hub-session discovery for the SuperMemory panel's left rail (R18, 需求①).
 *
 * A "hub session" is a top-level session of ONE workspace that is not a work
 * branch: it is where the user talks to the model directly rather than being a
 * dispatched branch. It MAY be the root conversation of a topic set (the
 * `hub-set` badge case); it is never a `branch-*`/`fork-*` dispatch. The list is
 * deliberately NOT derived from the sidebar snapshot (that one also carries
 * subagents/forks and has no topic-set membership), and branch membership is
 * checked against the FULL topic-set member set — an archived set still owns its
 * branches, so a branch never turns into a hub because its set was archived.
 *
 * Identity rule (R19 需求①③④ — the R18 conflation fixed): a topic-set member is
 * NOT automatically a branch. `createTopicSetSession` adds the session it
 * creates as `kind: 'root'` (the topic-set's own main conversation — a hub that
 * belongs to a set), while dispatch adds `kind: 'fork'` work branches. Only a
 * FORK member is a branch; a root member stays a hub and carries its set title
 * so the rail/sidebar can badge it as 「话题集」. R18 filtered every member (and
 * the badge marked every member as a branch), which hid set-owning hubs from the
 * rail and put a wrong 「分支」 badge on them.
 *
 * Identity rule (why the id prefix still matters): `branch-*` ids are always
 * plugin-created dispatches ({@link BRANCH_ID_PREFIX}); a dispatch whose set was
 * never created (or a freshly created branch not yet joined to a set) has no
 * member row, so the membership check alone would misreport it as a hub. The
 * prefix is a static fact and is therefore also the cycle-free alternative to
 * importing `branchHandles` from dispatch.ts into this module.
 *
 * Reads go through `ctx.sessionQuery` (get, not inject: optional seam). Titles
 * come from one `readTitleSnapshots` batch, so a workspace with 50 sessions is
 * one read, not 50.
 * @module supermemory/hub-sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import { isOpenDispatch } from './hub-branches.ts'

/** One hub-session row of the panel's left rail. */
export interface HubSessionView {
  sessionId: string
  title: string
  live: boolean
  updatedAt: number
  createdAt: number
  origin: 'hub'
  /** The session's own cwd (R19 需求①: rows are workspace-filtered and carry it). */
  cwd: string
  /** Canonical workspace key of `cwd` (same key every store table uses). */
  workspaceKey: string
  /** Set this hub belongs to as its root member (R19 需求③), when any. */
  topicSetId?: string
  topicSetTitle?: string
  /**
   * R19 协同②: how many branches this hub has dispatched into (distinct branch
   * sessions), and how many of them still owe a relay. The rail can therefore
   * show "3 分支 · 1 工作中" without a second request per row.
   */
  branches: number
  workingBranches: number
}

/** Default row cap (the rail is a launcher, not an archive browser). */
export const HUB_SESSION_LIMIT = 50

/** Prefix of every plugin-created branch session (`newId('branch')` in dispatch.ts). */
export const BRANCH_ID_PREFIX = 'branch-'

/** Prefix of every plugin-created fork session (`newId('fork')` in dispatch.ts). */
export const FORK_ID_PREFIX = 'fork-'

/** Prefix of every host-native session the plugin creates as a hub (`newId('session')` in panel.ts). */
export const HUB_ID_PREFIX = 'session-'

/**
 * Is this id minted by the plugin as a WORK BRANCH? Fresh dispatches use
 * `branch-*` and forks `fork-*`. This is the static half of the hub/branch
 * rule: dispatch records a fresh branch with `kind:'root'` (it is a root of its
 * own new session, not a fork), so `kind` alone cannot distinguish it from a
 * topic-set hub. The prefix can.
 */
export function isPluginBranchId(sessionId: string): boolean {
  return sessionId.startsWith(BRANCH_ID_PREFIX) || sessionId.startsWith(FORK_ID_PREFIX)
}

interface SessionHeaderLike {
  id?: string
  cwd?: string
  createdAt?: number
  parentSession?: unknown
  origin?: string
}

interface SessionRecordLike {
  header: SessionHeaderLike
  live?: boolean
  persisted?: boolean
}

interface TitleObservationLike {
  sessionId?: string
  status?: 'fulfilled' | 'rejected'
  value?: { title?: { title?: string; updatedAt?: number } }
}

interface SessionQueryLike {
  listSessions?(signal?: AbortSignal): Promise<SessionRecordLike[]>
  readTitleSnapshots?(sessionIds: readonly string[], signal?: AbortSignal): Promise<TitleObservationLike[]>
}

interface LiveSessionsLike {
  list?(): Array<{ id?: string; header?: SessionHeaderLike }>
}

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get?: (key: string) => unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Every FORK member id of any topic set (archived sets included) — the actual
 * branch sessions. Root members are the topic-set's own hub conversation and
 * must stay in the rail.
 */
export function topicSetBranchIds(store: Store | undefined): Set<string> {
  const ids = new Set<string>()
  if (!store) return ids
  for (const [, topicSet] of store.topicsets.entries()) {
    for (const member of topicSet.members) if (member.kind === 'fork') ids.add(member.sessionId)
  }
  return ids
}

/**
 * The active topic set that owns one session as its ROOT member, newest
 * `lastActiveAt` first. Used to badge a hub conversation with its set.
 */
export function topicSetOfRootMember(store: Store | undefined, sessionId: string): { id: string; title: string } | undefined {
  if (!store) return undefined
  let best: { id: string; title: string; at: number } | undefined
  for (const [id, topicSet] of store.topicsets.entries()) {
    if (topicSet.status !== 'active') continue
    for (const member of topicSet.members) {
      if (member.sessionId !== sessionId || member.kind !== 'root') continue
      if (!best || member.lastActiveAt > best.at) best = { id, title: topicSet.title, at: member.lastActiveAt }
    }
  }
  return best ? { id: best.id, title: best.title } : undefined
}

/** A fallback title when the title seam is unavailable. */
function fallbackTitle(sessionId: string): string {
  return `未命名会话 ${sessionId.slice(-4)}`
}

/**
 * Distinct branch sessions one hub dispatched into, and how many of those still
 * have an open dispatch. Reads the dispatch table (the existing hub↔branch
 * relation) instead of adding a second bookkeeping row.
 */
function branchStatsOf(store: Store | undefined, hubSessionId: string): { total: number; working: number } {
  if (!store) return { total: 0, working: 0 }
  const all = new Set<string>()
  const working = new Set<string>()
  for (const [, row] of store.dispatches.entries()) {
    if (row.hubSessionId !== hubSessionId) continue
    const branchId = String(row.branchSessionId ?? '')
    if (!branchId) continue
    all.add(branchId)
    if (isOpenDispatch(row)) working.add(branchId)
  }
  return { total: all.size, working: working.size }
}

/**
 * List the hub sessions of one workspace, newest activity first.
 *
 * @param ctx - host context (sessionQuery/sessions are read with `get`).
 * @param store - the plugin store (topic-set membership + workspace facts).
 * @param cwd - workspace root the panel currently points at.
 * @param limit - maximum rows (default {@link HUB_SESSION_LIMIT}).
 */
export async function listHubSessions(
  ctx: Context | undefined,
  store: Store | undefined,
  cwd: string,
  limit = HUB_SESSION_LIMIT,
): Promise<HubSessionView[]> {
  if (!ctx || !cwd) return []
  const workspaceKey = workspaceKeyOf(cwd)
  const branchIds = topicSetBranchIds(store)

  // ---- the logical corpus: sessionQuery first, live sessions as a fallback ----
  let records: SessionRecordLike[] | undefined
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (query && typeof query.listSessions === 'function') {
    try {
      records = await query.listSessions()
    } catch {
      records = undefined
    }
  }
  if (!records) {
    try {
      const live = serviceOf<LiveSessionsLike>(ctx, 'sessions')
      const rows = typeof live?.list === 'function' ? live.list() : []
      records = rows.map((session) => ({ header: session.header ?? { id: session.id }, live: true, persisted: false }))
    } catch {
      records = []
    }
  }

  const hubs: Array<{ record: SessionRecordLike; sessionId: string }> = []
  for (const record of records) {
    const header = record?.header ?? {}
    const sessionId = String(header.id ?? '')
    if (!sessionId) continue
    if (!header.cwd || workspaceKeyOf(header.cwd) !== workspaceKey) continue
    // A subagent child or an ordinary fork is never a hub: `parentSession` is
    // the direct creator and `origin` the product classification.
    if (header.parentSession) continue
    if (header.origin === 'subagent') continue
    // A plugin-minted branch id is never a hub, whether or not it ever joined a
    // topic set (a dispatch without a set has no member row to catch it).
    if (isPluginBranchId(sessionId)) continue
    // Only a FORK member (archived sets included) is a branch. A root member
    // is the set's own hub conversation and remains a hub (R19 需求③④).
    if (branchIds.has(sessionId)) continue
    hubs.push({ record, sessionId })
  }
  if (hubs.length === 0) return []

  // ---- titles: one batch read for every remaining id ----
  const titles = new Map<string, { title: string; updatedAt?: number }>()
  if (query && typeof query.readTitleSnapshots === 'function') {
    try {
      const observations = await query.readTitleSnapshots(hubs.map((hub) => hub.sessionId))
      for (const observation of observations) {
        if (!observation || observation.status !== 'fulfilled') continue
        const sessionId = String(observation.sessionId ?? '')
        const title = observation.value?.title?.title
        if (!sessionId || typeof title !== 'string' || !title.trim()) continue
        titles.set(sessionId, {
          title: title.trim(),
          ...(typeof observation.value?.title?.updatedAt === 'number'
            ? { updatedAt: observation.value.title.updatedAt }
            : {}),
        })
      }
    } catch { /* a title failure keeps the fallback names */ }
  }

  const rows: HubSessionView[] = hubs.map(({ record, sessionId }) => {
    const title = titles.get(sessionId)
    const createdAt = typeof record.header.createdAt === 'number' ? record.header.createdAt : 0
    const sessionCwd = String(record.header.cwd ?? cwd)
    const owner = topicSetOfRootMember(store, sessionId)
    const branchStats = branchStatsOf(store, sessionId)
    return {
      sessionId,
      title: title?.title ?? fallbackTitle(sessionId),
      live: record.live === true,
      // The header has no updatedAt; the latest title event is the only cheap
      // activity fact, so it wins and creation time is the fallback.
      updatedAt: title?.updatedAt ?? createdAt,
      createdAt,
      origin: 'hub',
      cwd: sessionCwd,
      workspaceKey: workspaceKeyOf(sessionCwd),
      ...(owner ? { topicSetId: owner.id, topicSetTitle: owner.title } : {}),
      branches: branchStats.total,
      workingBranches: branchStats.working,
    }
  })
  rows.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  const cap = Math.max(1, Math.min(HUB_SESSION_LIMIT, Number(limit) || HUB_SESSION_LIMIT))
  return rows.slice(0, cap)
}
