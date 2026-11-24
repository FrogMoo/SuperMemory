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
 * R35 boundary — DISCOVERY VIEW, NOT ROLE AUTHORITY: this list answers "which
 * top-level conversations of this workspace can I open from the panel rail?".
 * Its rules (no parent, not a subagent, not a plugin branch, workspace of the
 * session cwd) are a LAYOUT heuristic, not a role decision. The role decision
 * lives only in src/role.ts (`resolveRole`: positive hub marks, branch wins); a
 * session appearing here may resolve to `other`. Do NOT feed this list into
 * guards, prompts or dispatch — and do not "fix" role gaps by narrowing or
 * widening it (pre-R33 panel hubs are handled by the one-time
 * hub-records migration, never by treating "no parent" as proof). The rail
 * label/tooltip says so explicitly in the client dictionaries (side.authority).
 *
 * Reads go through `ctx.sessionQuery` (get, not inject: optional seam). Titles
 * come from one `readTitleSnapshots` batch, so a workspace with 50 sessions is
 * one read, not 50.
 *
 * Activity rule (R22 需求⑧ — the permanent-green-dot bug): the rail's dot means
 * "this session is ACTIVE NOW" (locale label 「运行中」), not "this session is
 * loaded". `sessionQuery`'s `live` fact only says the id currently exists in
 * `ctx.sessions`; a conversation that finished its turn stays attached, so the
 * old mapping kept the dot green on every session the user had opened that day.
 * The only positive activity fact the host exposes is `Agent.status` (`idle` ⇄
 * `running`, see @deepseek-ai/dsh-agent): the dot is lit ONLY while the agent is
 * running a turn, and an unknown state (no agent registry, a throwing lookup)
 * is dark — never optimistically green. Attachment is still reported as
 * {@link HubSessionView.online} for a future 「在线」 indicator.
 * @module supermemory/hub-sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import { describeSessionTitle } from './title.ts'
import { isOpenDispatch } from './hub-branches.ts'

/** One hub-session row of the panel's left rail. */
export interface HubSessionView {
  sessionId: string
  title: string
  /**
   * R22 需求⑧: the session is RUNNING a turn right now — the green dot. This is
   * `Agent.status === 'running'`, not "attached to the host": a finished but
   * still-attached conversation is {@link online} and must NOT be green. When
   * the activity state is unknown (host without an agent registry) this is
   * `false` — the requirement is "unknown stays dark".
   */
  live: boolean
  /**
   * R22 需求⑧: the session is currently attached to the host (the session-query
   * corpus `live` fact) — it can be messaged without a cold resume, but it may
   * be idle/completed. Informational only: the rail's dot keys off {@link live}.
   * A future 「在线」 indicator can map this field without changing the host.
   */
  online: boolean
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
 * R31 需求①: the historical flavour prefix of plugin hub titles
 * (`SuperMemory 中枢 · <id4>`). R41 stopped GENERATING it — a session name is now
 * a direct description of its work — but the constant stays because the one-time
 * migrations still recognize those old rows (hub records + rename pass).
 */
export const HUB_TITLE_PREFIX = 'SuperMemory 中枢'

/** The pre-R31 hub title prefix ('新会话 · <id4>'); hub-title-migration renames it. */
export const LEGACY_HUB_TITLE_PREFIX = '新会话'

/**
 * R41 需求③: the title a plugin-created hub session gets — the first user
 * message / work summary itself (markup stripped, descriptive lead-ins removed,
 * 48-char ellipsis clip), or the neutral 「新会话」 when there is no content
 * yet. No brand prefix and no id token: the sidebar reads as the work.
 *
 * @param _sessionId - kept in the signature for callers/tests; no longer used
 *   for the title (an id suffix is not a description).
 * @param firstMessage - opening message used as the work summary.
 */
export function hubSessionTitle(_sessionId: string, firstMessage = ''): string {
  return describeSessionTitle(firstMessage)
}

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

/** Structural view of one host Agent (activity only; no host import needed). */
interface AgentLike {
  id?: string
  status?: string
}

/** Structural view of `ctx.agents` (the host agent registry). */
interface AgentsLike {
  get?(sessionId: string): AgentLike | undefined
  list?(): AgentLike[]
}

/**
 * Build the "is this session running right now?" probe for the rail's dot.
 *
 * `Agent.status` is the host's ONLY positive activity signal (`idle` ⇄
 * `running`; agent disposal removes the registry entry — see dsh-agent
 * runtime-types). Session attachment (`ctx.sessions` / `sessionQuery` `live`) is
 * NOT activity: a session that ended its turn stays attached, which is exactly
 * why the old `live` mapping showed green dots on ended conversations.
 *
 * One `agents.list()` enumeration is preferred (O(sessions)); a host that only
 * exposes `agents.get()` degrades to one lookup per row. Every failure mode —
 * no agents service, a thrown lookup, a malformed value — answers `false`,
 * because the requirement is "unknown stays dark".
 */
function runningProbe(ctx: Context | undefined): (sessionId: string) => boolean {
  if (!ctx) return () => false
  const agents = serviceOf<AgentsLike>(ctx, 'agents')
  if (!agents) return () => false
  try {
    if (typeof agents.list === 'function') {
      const rows = agents.list()
      if (Array.isArray(rows)) {
        const running = new Set<string>()
        for (const agent of rows as AgentLike[]) {
          if (agent?.status !== 'running') continue
          const id = String(agent.id ?? '')
          if (id) running.add(id)
        }
        return (sessionId) => running.has(sessionId)
      }
    }
  } catch { /* fall through to the per-session lookup */ }
  const get = agents.get
  if (typeof get !== 'function') return () => false
  return (sessionId) => {
    try {
      return get.call(agents, sessionId)?.status === 'running'
    } catch {
      return false
    }
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
 * R35: despite the historical name/field (`origin: 'hub'`), this is a discovery
 * list — see the module header ("DISCOVERY VIEW, NOT ROLE AUTHORITY"). Role
 * authority is resolveRole only.
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

  // R22 需求⑧: the dot is "running NOW", resolved through the agent registry;
  // attachment (`record.live`) becomes the informational `online` field.
  const isRunning = runningProbe(ctx)
  const rows: HubSessionView[] = hubs.map(({ record, sessionId }) => {
    const title = titles.get(sessionId)
    const createdAt = typeof record.header.createdAt === 'number' ? record.header.createdAt : 0
    const sessionCwd = String(record.header.cwd ?? cwd)
    const owner = topicSetOfRootMember(store, sessionId)
    const branchStats = branchStatsOf(store, sessionId)
    return {
      sessionId,
      title: title?.title ?? fallbackTitle(sessionId),
      live: isRunning(sessionId),
      online: record.live === true,
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
