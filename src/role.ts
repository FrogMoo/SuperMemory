/**
 * R33 需求②④⑤ — ONE role resolution for the whole plugin.
 *
 * The R32 guard inferred "hub" from "top-level session with no parentSession".
 * That is not a hub fact: every ordinary user conversation is a top-level
 * session, so the guard denied bash/write/edit/subagent in all of them. It also
 * contradicted the branch rule: a topic-set ROOT member could be a recorded
 * branch (continued through `mode: continue`), and `auto` could even reuse it
 * as a branch, leaving one session that was both a hub and a branch.
 *
 * This module is the single authority:
 *
 *   branch  — plugin-minted `branch-*`/`fork-*` id, a topic-set FORK member, or
 *             any `dispatches.branchSessionId` hit. BRANCH WINS: if a session
 *             carries both a branch fact and a hub mark, it is a branch.
 *   hub     — POSITIVE mark only, in this agent's workspace:
 *               * a `hub_sessions` record (plugin-created hub / topic-set root /
 *                 a session that has dispatched);
 *               * a topic-set `kind:'root'` member whose set is in this workspace;
 *               * `dispatches.hubSessionId` (dispatching is a durable hub act)
 *                 whose topic set is in this workspace.
 *   other   — everything else (ordinary conversations, subagent children, a
 *             mark belonging to another workspace). Never denied execution.
 *
 * Every store read is guarded: a closing/reloading store must degrade to
 * `other`, never throw through the guard (which would fail EVERY tool call).
 * @module supermemory/role
 */
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import type { HubSession } from './schema.ts'

/** The three roles a session can have for this plugin. */
export type SessionRole = 'hub' | 'branch' | 'other'

/** Why a role was chosen (diagnostics + tests; never model-facing). */
export type RoleReason =
  | 'plugin-branch-id'
  | 'fork-member'
  | 'dispatch-branch'
  | 'hub-record'
  | 'topic-set-root'
  | 'dispatch-hub'
  | 'no-session-id'
  | 'subagent-child'
  | 'workspace-mismatch'
  | 'no-positive-marker'
  | 'resolution-error'

/** One resolved role, with the evidence class that decided it. */
export interface RoleResolution {
  role: SessionRole
  reason: RoleReason
  sessionId: string
  /** Canonical workspace key of the agent's cwd, when the header carries one. */
  workspaceKey?: string
}

/** Structural view of an Agent (no host runtime import). */
export interface RoleAgentLike {
  id?: string
  session?: {
    id?: string
    header?: {
      cwd?: string
      parentSession?: unknown
      origin?: string
      delegationDepth?: number
    }
  }
}

/** The id a role decision should use for an Agent. */
export function agentSessionId(agent: unknown): string {
  const shaped = agent as RoleAgentLike | undefined
  return String(shaped?.id ?? shaped?.session?.id ?? '')
}

/** Canonical workspace key of an Agent's session cwd (undefined when absent). */
export function agentWorkspaceKey(agent: unknown): string | undefined {
  const shaped = agent as RoleAgentLike | undefined
  const cwd = shaped?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() ? workspaceKeyOf(cwd) : undefined
}

/**
 * A marker's workspace agrees with the agent's. Unknown on either side is not a
 * mismatch (an old record may predate workspace fields); a known disagreement
 * IS one — the hub role is deliberately workspace-scoped.
 */
function workspaceAgrees(markerKey: string | undefined, agentKey: string | undefined): boolean {
  if (!markerKey || !agentKey) return true
  return markerKey === agentKey
}

/** Safe iterable view of a table (missing table in a fixture/host-free run). */
function entriesOf<T>(table: { entries(): IterableIterator<[string, T]> } | undefined): Array<[string, T]> {
  if (!table) return []
  try {
    return [...table.entries()]
  } catch {
    return []
  }
}

/**
 * Resolve one agent's role. Never throws: a store read failure answers
 * `other / resolution-error` so the caller's guard can stay total.
 */
export function resolveRole(store: Store | undefined, agent: unknown): RoleResolution {
  const sessionId = agentSessionId(agent)
  const shaped = agent as RoleAgentLike | undefined
  const header = shaped?.session?.header
  const workspaceKey = agentWorkspaceKey(agent)
  const base = (role: SessionRole, reason: RoleReason): RoleResolution => ({
    role, reason, sessionId, ...(workspaceKey ? { workspaceKey } : {}),
  })
  if (!store) return base('other', 'no-session-id')
  if (!sessionId) return base('other', 'no-session-id')
  try {
    // ---- 1. branch facts win (a session cannot be both) ----
    if (sessionId.startsWith('branch-') || sessionId.startsWith('fork-')) {
      return base('branch', 'plugin-branch-id')
    }
    let sawFork = false
    for (const [, topicSet] of entriesOf(store.topicsets)) {
      const member = (topicSet.members ?? []).find((row) => row.sessionId === sessionId)
      if (!member) continue
      if (member.kind === 'fork') {
        sawFork = true
        break
      }
    }
    if (sawFork) return base('branch', 'fork-member')
    for (const [, dispatch] of entriesOf(store.dispatches)) {
      if (dispatch.branchSessionId === sessionId) return base('branch', 'dispatch-branch')
    }

    // A subagent child is never a hub, even if a stale mark exists.
    if (header?.origin === 'subagent') return base('other', 'subagent-child')

    // ---- 2. positive hub marks (workspace-scoped) ----
    let sawForeignHub = false
    const hubs = store.hubs as { get?(key: string): HubSession | undefined } | undefined
    try {
      const record = hubs?.get?.(sessionId)
      if (record) {
        if (workspaceAgrees(record.workspaceKey, workspaceKey)) return base('hub', 'hub-record')
        sawForeignHub = true
      }
    } catch { /* a missing hub table is simply no record */ }

    for (const [, topicSet] of entriesOf(store.topicsets)) {
      const root = (topicSet.members ?? []).find(
        (row) => row.sessionId === sessionId && row.kind === 'root',
      )
      if (!root) continue
      if (workspaceAgrees(String(topicSet.workspaceKey ?? ''), workspaceKey)) return base('hub', 'topic-set-root')
      sawForeignHub = true
    }

    for (const [, dispatch] of entriesOf(store.dispatches)) {
      if (dispatch.hubSessionId !== sessionId) continue
      let markerWorkspace: string | undefined
      if (dispatch.topicSetId) {
        try {
          markerWorkspace = store.topicsets?.get?.(dispatch.topicSetId)?.workspaceKey
        } catch { /* an unreadable set stays unknown, not foreign */ }
      }
      if (workspaceAgrees(markerWorkspace, workspaceKey)) return base('hub', 'dispatch-hub')
      sawForeignHub = true
    }

    return base('other', sawForeignHub ? 'workspace-mismatch' : 'no-positive-marker')
  } catch {
    // A closing store must not turn into a thrown guard: unknown = ordinary.
    return base('other', 'resolution-error')
  }
}

/**
 * Write (or refresh) one positive hub record. Best-effort: a missing table or a
 * closing store loses only the audit row — resolution still sees root members
 * and dispatch references.
 */
export async function recordHubSession(
  store: Store | undefined,
  input: {
    sessionId: string
    workspaceKey: string
    title?: string
    source?: HubSession['source']
  },
): Promise<void> {
  const sessionId = String(input.sessionId ?? '').trim()
  if (!store || !sessionId) return
  try {
    const table = store.hubs
    if (!table || typeof table.put !== 'function') return
    const existing = typeof table.get === 'function' ? table.get(sessionId) : undefined
    const now = Date.now()
    // R59: the FIRST writer owns the provenance (a later dispatch/refresh does
    // not relabel a panel-created hub); the most recent writer is audited in
    // lastSource.
    const source = existing?.source ?? input.source ?? 'panel'
    await table.put(sessionId, {
      workspaceKey: String(input.workspaceKey || existing?.workspaceKey || 'unknown'),
      sessionId,
      title: String(input.title ?? existing?.title ?? ''),
      source,
      lastSource: input.source ?? existing?.lastSource ?? source,
      createdAt: Number(existing?.createdAt) || now,
      updatedAt: now,
    })
  } catch {
    // marker is best-effort; never fail the caller (hub creation/dispatch)
  }
}

/**
 * Seed hub records from durable positive evidence (root members + dispatch hub
 * references) so the R33 table is populated for media written by earlier
 * rounds. Idempotent; returns the number of rows written.
 */
export async function backfillHubRecords(
  store: Store | undefined,
  logger?: { warn: (msg: string) => void },
): Promise<number> {
  if (!store) return 0
  let written = 0
  try {
    const existing = new Set<string>()
    try {
      for (const [id] of store.hubs.entries()) existing.add(id)
    } catch { /* no table = nothing recorded yet */ }
    for (const [, topicSet] of entriesOf(store.topicsets)) {
      for (const member of topicSet.members ?? []) {
        if (member.kind !== 'root' || existing.has(member.sessionId)) continue
        // A root member with a branch fact (a session reused through
        // mode:continue, or a panel-created branch-* row) is a BRANCH: never
        // seed a competing hub record for it (branch priority would ignore it,
        // and the audit row would lie).
        if (resolveRole(store, { id: member.sessionId }).role === 'branch') continue
        await recordHubSession(store, {
          sessionId: member.sessionId,
          workspaceKey: String(topicSet.workspaceKey ?? 'unknown'),
          title: member.title,
          source: 'topicset-root',
        })
        existing.add(member.sessionId)
        written += 1
      }
    }
    for (const [, dispatch] of entriesOf(store.dispatches)) {
      const id = String(dispatch.hubSessionId ?? '')
      if (!id || existing.has(id)) continue
      let workspaceKey = 'unknown'
      try {
        workspaceKey = String(store.topicsets?.get?.(dispatch.topicSetId ?? '')?.workspaceKey ?? 'unknown')
      } catch { /* keep unknown */ }
      await recordHubSession(store, { sessionId: id, workspaceKey, source: 'dispatch' })
      existing.add(id)
      written += 1
    }
  } catch (error) {
    logger?.warn('supermemory: hub record backfill failed: ' + String(error).slice(0, 160))
  }
  return written
}
