/**
 * R59: the SINGLE durable state entry for session naming.
 *
 * Every reader/writer of `session_titles` goes through this module; the gate
 * composes intent + host writes on top of it. Rows are created lazily (an old
 * medium has no rows at all), so the storage domain stays backward compatible.
 * @module supermemory/session-title/state
 */
import type { Store } from '../store.ts'
import { recordHubSession } from '../role.ts'
import type { HubSession, SessionTitleRow } from '../schema.ts'
import type { TitleKind, TitleSource, TitleState } from './types.ts'

/** One table row, or undefined when the session was never named by the plugin. */
export function titleRow(store: Store | undefined, sessionId: string): SessionTitleRow | undefined {
  if (!store || !sessionId) return undefined
  try {
    const table = store.sessionTitles
    return table && typeof table.get === 'function' ? table.get(sessionId) : undefined
  } catch {
    // A partly materialized table loses the state, never the caller.
    return undefined
  }
}

/** The positive hub record of one session, when any. */
export function hubRecord(store: Store | undefined, sessionId: string): HubSession | undefined {
  if (!store || !sessionId) return undefined
  try {
    const table = store.hubs
    return table && typeof table.get === 'function' ? table.get(sessionId) : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the row or create it with the given identity. Idempotent: a concurrent
 * create (two paths racing) is resolved by re-reading after the write.
 */
export async function ensureTitleRow(
  store: Store,
  input: { sessionId: string; workspaceKey?: string; kind?: TitleKind; source?: TitleSource },
): Promise<SessionTitleRow> {
  const existing = titleRow(store, input.sessionId)
  if (existing) return existing
  const now = Date.now()
  const row: SessionTitleRow = {
    workspaceKey: String(input.workspaceKey ?? ''),
    sessionId: input.sessionId,
    kind: input.kind ?? 'other',
    state: 'provisional',
    desiredTitle: '',
    autoTitle: '',
    desiredFull: '',
    topic: '',
    lastWrittenTitle: '',
    source: input.source ?? '',
    attempts: 0,
    lastError: '',
    lockedReason: '',
    createdAt: now,
    updatedAt: now,
  }
  try {
    await store.sessionTitles.put(input.sessionId, row)
  } catch {
    // The store is closing: return the in-memory row so the caller degrades
    // without throwing (a title write is never worth a tool failure).
    return row
  }
  return titleRow(store, input.sessionId) ?? row
}

/** Merge a patch into one row (creating it when absent). */
export async function patchTitleRow(
  store: Store,
  sessionId: string,
  patch: Partial<Omit<SessionTitleRow, 'sessionId' | 'createdAt'>>,
): Promise<SessionTitleRow | undefined> {
  const current = titleRow(store, sessionId)
  if (!current) return undefined
  const next: SessionTitleRow = { ...current, ...patch, sessionId, createdAt: current.createdAt, updatedAt: Date.now() }
  try {
    await store.sessionTitles.put(sessionId, next)
  } catch {
    // Best effort: the host title already landed and is the visible truth.
    return next
  }
  return next
}

/** Convenience: set the state (and optional reason) in one write. */
export async function setTitleState(
  store: Store,
  sessionId: string,
  state: TitleState,
  extra: Partial<Omit<SessionTitleRow, 'sessionId' | 'createdAt'>> = {},
): Promise<SessionTitleRow | undefined> {
  return patchTitleRow(store, sessionId, { ...extra, state })
}

/** The recorded title of one topic-set member (root or fork), if any. */
export function memberTitleOf(store: Store | undefined, sessionId: string): string {
  if (!store || !sessionId) return ''
  try {
    for (const [, topicSet] of store.topicsets.entries()) {
      const member = (topicSet.members ?? []).find((row) => row.sessionId === sessionId)
      if (member && typeof member.title === 'string' && member.title.trim()) return member.title.trim()
    }
  } catch {
    // A partly materialized table only loses the fallback.
  }
  return ''
}

/**
 * Mirror the accepted title into the positive hub record (the panel rail's
 * fallback). Never creates a record for a non-hub session; the record keeps
 * its original provenance (recordHubSession preserves `source`).
 */
export async function mirrorHubTitle(
  store: Store | undefined,
  sessionId: string,
  title: string,
  workspaceKey = '',
): Promise<void> {
  if (!store || !sessionId || !title) return
  const record = hubRecord(store, sessionId)
  if (!record) return
  await recordHubSession(store, {
    sessionId,
    workspaceKey: workspaceKey || record.workspaceKey,
    title,
  })
}
