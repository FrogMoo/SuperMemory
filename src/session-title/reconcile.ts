/**
 * R59: reconcile the naming state with the host (startup / reload / repair).
 *
 * STATUS (Phase 1a): DRAFT, NOT WIRED. Nothing calls `reconcileTitles` yet;
 * the live paths (gate/observer) already repair a neutral host title. Phase 1b
 * reviews the full pass and wires it into startup and the panel repair action.
 *
 * A session can drift from its intent without any plugin bug: the host may
 * have been restarted between the intent and the write (the write was
 * `deferred`), a cold session never got its rename, or a human renamed the
 * session in the host GUI. Reconcile is idempotent:
 *   - `user-locked` + a pending manual write → flush it once the session is live;
 *   - `user-locked` + the host carries a different topic → adopt (a human rename);
 *   - `named` + the host went neutral → re-assert the intent;
 *   - `named` + the host carries a DIFFERENT topic → user-locked (external);
 *   - `deferred` / `provisional` → retry the write (live) or stay deferred (cold).
 *
 * It NEVER resumes a session (a bulk resume would start agents as a side
 * effect); cold sessions wait for their first live event or the panel's
 * explicit "repair" action.
 * @module supermemory/session-title/reconcile
 */
import type { SessionTitleRow } from '../schema.ts'
import type { Store } from '../store.ts'
import { applySessionTitle, clearPendingWrite, renameSession } from './gate.ts'
import { isSessionLive, readHostTitle } from './host.ts'
import { isNeutralTitle } from './policy.ts'
import { mirrorHubTitle, patchTitleRow, titleRow } from './state.ts'
import type { TitleDeps, TitleResult } from './types.ts'

/** How many rows one reconcile pass looks at (a runaway table must stay bounded). */
const RECONCILE_LIMIT = 200

/** Reconcile ONE session. Returns undefined when there is nothing to do. */
export async function reconcileSessionTitle(
  deps: TitleDeps,
  sessionId: string,
  options: { reason?: string; defer?: boolean } = {},
): Promise<TitleResult | undefined> {
  const store = deps.store
  if (!store || !sessionId) return undefined
  const row = titleRow(store, sessionId)
  if (!row) return undefined
  const workspace = row.workspaceKey
  const host = readHostTitle(deps.ctx, sessionId)

  // ---- user-locked: flush a pending manual write, adopt a human rename ----
  if (row.state === 'user-locked') {
    if (!host) {
      // Still cold: keep the intent for the first live event.
      if (row.desiredTitle && row.lastWrittenTitle !== row.desiredTitle) {
        deps.logger.info('supermemory: pending manual title for ' + sessionId + ' waits for the session to become live')
      }
      return undefined
    }
    const pendingManual = Boolean(row.desiredTitle) && row.lastWrittenTitle !== row.desiredTitle
    if (pendingManual) {
      clearPendingWrite(sessionId)
      return renameSession(deps, {
        sessionId,
        title: row.desiredTitle,
        workspaceKey: workspace,
        kind: row.kind,
        defer: options.defer,
      })
    }
    if (host.title !== row.lastWrittenTitle && !isNeutralTitle(host.title, workspace)) {
      // A human renamed it in the host GUI while the row was locked.
      await patchTitleRow(store, sessionId, {
        desiredTitle: host.title,
        desiredFull: host.title,
        lastWrittenTitle: host.title,
        lastTitleSeq: host.seq,
        lockedReason: row.lockedReason || 'manual',
      })
      if (row.kind === 'hub') await mirrorHubTitle(store, sessionId, host.title, workspace)
      return { outcome: 'locked', title: host.title, state: 'user-locked', reason: 'adopted-external' }
    }
    return undefined
  }

  // ---- cold session: keep the intent, mark it deferred ----
  if (!host) {
    if (row.desiredTitle && row.state !== 'deferred') {
      await patchTitleRow(store, sessionId, { state: 'deferred', lastError: row.lastError || 'session-not-live' })
      return { outcome: 'deferred', title: row.desiredTitle, state: 'deferred', reason: 'session-not-live' }
    }
    return undefined
  }

  const desired = String(row.desiredTitle ?? '').trim()
  if (!desired) return undefined

  const desiredNeutral = isNeutralTitle(desired, workspace)
  const hostNeutral = isNeutralTitle(host.title, workspace)

  if (host.title === desired) {
    if (row.state !== 'named' && !desiredNeutral) {
      await patchTitleRow(store, sessionId, { state: 'named', lastWrittenTitle: host.title, lastTitleSeq: host.seq, attempts: 0, lastError: '' })
      return { outcome: 'already', title: host.title, state: 'named' }
    }
    if (row.state === 'deferred') {
      await patchTitleRow(store, sessionId, { state: desiredNeutral ? 'provisional' : 'named', lastWrittenTitle: host.title, lastTitleSeq: host.seq, attempts: 0, lastError: '' })
    }
    return undefined
  }

  // A neutral INTENT is only re-asserted over a neutral host (never over a
  // topic-bearing name somebody else chose).
  if (desiredNeutral && !hostNeutral) {
    await patchTitleRow(store, sessionId, {
      state: 'user-locked',
      desiredTitle: host.title,
      desiredFull: host.title,
      lastWrittenTitle: host.title,
      lastTitleSeq: host.seq,
      lockedReason: 'external-rename',
    })
    return { outcome: 'locked', title: host.title, state: 'user-locked', reason: 'external-rename' }
  }

  // A topic-bearing host title we did not write → external rename.
  if (!hostNeutral && host.title !== row.lastWrittenTitle) {
    await patchTitleRow(store, sessionId, {
      state: 'user-locked',
      desiredTitle: host.title,
      desiredFull: host.title,
      lastWrittenTitle: host.title,
      lastTitleSeq: host.seq,
      lockedReason: 'external-rename',
    })
    if (row.kind === 'hub') await mirrorHubTitle(store, sessionId, host.title, workspace)
    deps.logger.info('supermemory: reconcile locked ' + sessionId + ' (renamed outside the plugin)')
    return { outcome: 'locked', title: host.title, state: 'user-locked', reason: 'external-rename' }
  }

  // Host neutral/legacy (or an older write of ours): re-assert the intent.
  const result = await applySessionTitle(deps, {
    sessionId,
    kind: row.kind,
    workspaceKey: workspace,
    explicitTitle: desired,
    topicText: row.topic,
    source: 'reconcile',
    force: true,
    defer: options.defer,
  })
  deps.logger.info(
    'supermemory: reconcile ' + (options.reason ? '(' + options.reason + ') ' : '')
    + 're-asserted ' + sessionId + ' → ' + result.outcome,
  )
  return result
}

/** How many rows one pass handled, by outcome (diagnostics for the startup log). */
export interface ReconcileSummary {
  checked: number
  repaired: number
  deferred: number
  locked: number
  failed: number
}

/**
 * Reconcile every naming row (bounded). Safe to run on startup/reload and from
 * the panel's explicit "repair" action.
 */
export async function reconcileTitles(
  deps: TitleDeps,
  options: { limit?: number; reason?: string } = {},
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, repaired: 0, deferred: 0, locked: 0, failed: 0 }
  const store: Store | undefined = deps.store
  if (!store) return summary
  const limit = Math.max(1, Math.min(RECONCILE_LIMIT, options.limit ?? RECONCILE_LIMIT))
  const rows: SessionTitleRow[] = []
  try {
    for (const [, row] of store.sessionTitles.entries()) {
      if (rows.length >= limit) break
      rows.push(row)
    }
  } catch {
    return summary
  }
  for (const row of rows) {
    if (row.kind === 'other' && row.state !== 'deferred') continue
    if (!isSessionLive(deps.ctx, row.sessionId) && row.state !== 'user-locked') {
      // Cold: reconcile still records the deferred state, but never resumes.
      if (row.desiredTitle && row.state !== 'deferred') {
        await patchTitleRow(store, row.sessionId, { state: 'deferred', lastError: row.lastError || 'session-not-live' })
        summary.deferred += 1
      }
      continue
    }
    summary.checked += 1
    try {
      const result = await reconcileSessionTitle(deps, row.sessionId, { reason: options.reason })
      if (!result) continue
      if (result.outcome === 'locked') summary.locked += 1
      else if (result.outcome === 'deferred') summary.deferred += 1
      else if (result.outcome === 'host' || result.outcome === 'fallback' || result.outcome === 'already') summary.repaired += 1
    } catch (error) {
      summary.failed += 1
      deps.logger.warn('supermemory: reconcile failed for ' + row.sessionId + ': ' + String(error).slice(0, 160))
    }
  }
  if (summary.checked > 0 || summary.deferred > 0) {
    deps.logger.info(
      'supermemory: title reconcile — checked ' + summary.checked + ', repaired ' + summary.repaired
      + ', deferred ' + summary.deferred + ', locked ' + summary.locked + ', failed ' + summary.failed,
    )
  }
  return summary
}
