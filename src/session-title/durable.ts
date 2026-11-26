/**
 * R59 Phase 1b-2: keep the THREE title copies of one session in step.
 *
 * The host title is the GUI authority; the durable copies are
 * `dispatches.title` (work branches) and the topic-set member title. A manual
 * rename / restore must write ONE final string (≤ 80 UTF-8 bytes, composed by
 * the policy) to all of them — otherwise the rail, the branch card and the host
 * sidebar disagree. This module owns that projection; it never writes the host
 * itself (the gate does).
 * @module supermemory/session-title/durable
 */
import type { Store } from '../store.ts'
import { isPluginBranchId } from '../hub-sessions.ts'
import { renameSession, resetAutoTitle } from './gate.ts'
import { titleRow } from './state.ts'
import type { TitleDeps, TitleKind, TitleResult } from './types.ts'

/** How many durable rows were rewritten. */
export interface DurableSync {
  dispatches: number
  members: number
}

/** A title mutation plus its durable-copy counts (diagnostics for the panel). */
export interface TitleMutationResult extends TitleResult {
  dispatches?: number
  members?: number
}

/**
 * Write `title` into every durable copy of one session: all dispatch rows whose
 * branch is this session, and every topic-set member row for it. Idempotent;
 * a closing/partial store loses only the projection.
 */
export async function syncDurableTitles(
  store: Store | undefined,
  sessionId: string,
  title: string,
): Promise<DurableSync> {
  const counts: DurableSync = { dispatches: 0, members: 0 }
  const final = String(title ?? '').trim()
  if (!store || !sessionId || !final) return counts
  try {
    for (const [id, row] of store.dispatches.entries()) {
      if (row.branchSessionId !== sessionId || row.title === final) continue
      await store.dispatches.update(id, (record) => ({ ...record, title: final }))
      counts.dispatches += 1
    }
  } catch { /* best effort */ }
  try {
    for (const [setId, record] of store.topicsets.entries()) {
      let changed = false
      const members = (record.members ?? []).map((member) => {
        if (member.sessionId !== sessionId || member.title === final) return member
        changed = true
        return { ...member, title: final }
      })
      if (!changed) continue
      await store.topicsets.update(setId, (row) => ({ ...row, members }))
      counts.members += 1
    }
  } catch { /* best effort */ }
  return counts
}

/**
 * Align ONE dispatch row's title with the branch's stable durable title. A
 * CONTINUE/resume creates a new dispatch row; without this alignment the
 * newest row would carry the new task's title and the branch card/list would
 * silently rename a branch whose host/member title never changed.
 *
 * @returns true when the row was rewritten.
 */
export async function syncDispatchTitle(
  store: Store | undefined,
  dispatchId: string,
  title: string,
): Promise<boolean> {
  const final = String(title ?? '').trim()
  if (!store || !dispatchId || !final) return false
  const row = store.dispatches.get(dispatchId)
  if (!row || row.title === final) return false
  try {
    await store.dispatches.update(dispatchId, (record) => ({ ...record, title: final, updatedAt: Date.now() }))
    return true
  } catch {
    return false
  }
}

/** The session's naming kind (explicit > stored row > plugin id prefix). */
export function titleKindOf(store: Store | undefined, sessionId: string, explicit?: TitleKind): TitleKind {
  if (explicit && explicit !== 'other') return explicit
  const row = titleRow(store, sessionId)
  if (row && row.kind !== 'other') return row.kind
  return isPluginBranchId(sessionId) ? 'branch' : 'hub'
}

/**
 * Manual rename: host + hub mirror (gate) then dispatch/member copies.
 * Returns the gate result plus sync counts; a cold session is a `skipped`
 * `session-not-live` (never resumed).
 */
export async function renameSessionWithDurables(
  deps: TitleDeps,
  input: { sessionId: string; title: string; workspaceKey?: string; kind?: TitleKind; defer?: boolean },
): Promise<TitleMutationResult> {
  const kind = titleKindOf(deps.store, input.sessionId, input.kind)
  const result = await renameSession(deps, { ...input, kind })
  if (result.outcome !== 'host' && result.outcome !== 'fallback') return result
  const synced = await syncDurableTitles(deps.store, input.sessionId, result.title)
  return { ...result, ...synced }
}

/**
 * Restore the automatic title: host + mirror (gate) then dispatch/member copies.
 * A row with no recoverable automatic title is `skipped` `no-auto-title` and is
 * NOT written.
 */
export async function resetSessionWithDurables(
  deps: TitleDeps,
  input: { sessionId: string; workspaceKey?: string; kind?: TitleKind; defer?: boolean },
): Promise<TitleMutationResult> {
  const kind = titleKindOf(deps.store, input.sessionId, input.kind)
  const result = await resetAutoTitle(deps, { ...input, kind })
  if (result.outcome !== 'host' && result.outcome !== 'fallback') return result
  const synced = await syncDurableTitles(deps.store, input.sessionId, result.title)
  return { ...result, ...synced }
}
