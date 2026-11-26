/**
 * R59 Phase 1b: reconcile the naming state with the host (startup / reload /
 * first live event).
 *
 * A session can drift from its intent without any plugin bug: the host was
 * restarted between the intent and the write (the write stayed deferred), a cold
 * session never got its rename, or a human renamed the session in the host GUI.
 * Reconcile is idempotent and NEVER resumes a session:
 *   - user-locked → no-op (a human owns the name);
 *   - host == desired → named, and the id leaves the migration pending set;
 *   - host neutral → re-assert the SAME desiredTitle (deferred out of any
 *     publication stack);
 *   - host topic-bearing and different from lastWrittenTitle → external rename
 *     → user-locked;
 *   - cold → keep the intent deferred (the first live event retries it).
 *
 * @module supermemory/session-title/reconcile
 */
import type { SessionTitleRow } from '../schema.ts'
import type { Store } from '../store.ts'
import { applySessionTitle } from './gate.ts'
import { isSessionLive, readHostTitle } from './host.ts'
import { settleSessionTitlePendingId } from './migrate.ts'
import { isNeutralTitle } from './policy.ts'
import { mirrorHubTitle, patchTitleRow, titleRow } from './state.ts'
import type { TitleDeps, TitleResult } from './types.ts'

/** How many rows one reconcile pass looks at (a runaway table must stay bounded). */
const RECONCILE_LIMIT = 300

/**
 * Reconcile ONE session. Returns undefined when there is nothing to do.
 * The host write (if any) still goes through the SINGLE gate entry; this module
 * only decides what the intent is.
 */
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
  const live = isSessionLive(deps.ctx, sessionId)
  const host = readHostTitle(deps.ctx, sessionId)
  const hostTitle = host?.title ?? ''
  const desired = String(row.desiredTitle ?? '').trim()
  const hostNeutral = !hostTitle || isNeutralTitle(hostTitle, workspace)

  // ---- user-locked: a human owns the name ----
  if (row.state === 'user-locked') {
    // Adopt a NEW outside name for display/mirror only (never write the host,
    // never unlock). This keeps the persisted intent current for a future
    // explicit "restore auto naming".
    if (host && !hostNeutral && hostTitle !== row.lastWrittenTitle && hostTitle !== row.desiredTitle) {
      // Keep the auto intent; only the human name / last-written marker move.
      await patchTitleRow(store, sessionId, {
        lastWrittenTitle: hostTitle,
        lastTitleSeq: host.seq,
        lockedReason: row.lockedReason || 'manual',
      })
      if (row.kind === 'hub') await mirrorHubTitle(store, sessionId, hostTitle, workspace)
    }
    return undefined
  }

  // No stored intent (a provisional row with no topic yet): nothing to align.
  if (!desired) return undefined

  // ---- cold: keep the intent deferred, never resume ----
  if (!live) {
    if (row.state !== 'deferred') {
      await patchTitleRow(store, sessionId, {
        state: 'deferred',
        lastError: row.lastError || 'session-not-live',
      })
      return { outcome: 'deferred', title: desired, state: 'deferred', reason: 'session-not-live' }
    }
    return undefined
  }

  // ---- host already holds the intent ----
  if (hostTitle === desired) {
    if (row.state !== 'named') {
      await patchTitleRow(store, sessionId, {
        state: 'named',
        autoTitle: row.autoTitle || desired,
        lastWrittenTitle: desired,
        lastTitleSeq: host?.seq,
        attempts: 0,
        lastError: '',
      })
    }
    await settleSessionTitlePendingId(store, sessionId)
    return { outcome: 'already', title: desired, state: 'named' }
  }

  // ---- a different topic-bearing host title we did not write = external rename ----
  if (!hostNeutral && hostTitle !== row.lastWrittenTitle) {
    const autoTitle = String(row.autoTitle ?? '').trim()
      || (row.desiredTitle && row.desiredTitle !== hostTitle ? row.desiredTitle : '')
    await patchTitleRow(store, sessionId, {
      state: 'user-locked',
      ...(autoTitle ? { autoTitle, desiredTitle: autoTitle } : {}),
      lastWrittenTitle: hostTitle,
      lastTitleSeq: host?.seq,
      lockedReason: 'external-rename',
    })
    if (row.kind === 'hub') await mirrorHubTitle(store, sessionId, hostTitle, workspace)
    await settleSessionTitlePendingId(store, sessionId)
    deps.logger.info('supermemory: reconcile locked ' + sessionId + ' (renamed outside the plugin)')
    return { outcome: 'locked', title: hostTitle, state: 'user-locked', reason: 'external-rename' }
  }

  // ---- host neutral (or our own previous write): re-assert the SAME intent ----
  const result = await applySessionTitle(deps, {
    sessionId,
    kind: row.kind,
    workspaceKey: workspace,
    explicitTitle: desired,
    source: 'reconcile',
    force: true,
    defer: options.defer ?? true,
  })
  if (result.outcome === 'host' || result.outcome === 'fallback' || result.outcome === 'already') {
    await settleSessionTitlePendingId(store, sessionId)
  } else if (result.outcome === 'locked') {
    // The gate saw a race with a human rename; the row is locked and settled.
    await settleSessionTitlePendingId(store, sessionId)
  }
  deps.logger.info(
    'supermemory: reconcile ' + (options.reason ? '(' + options.reason + ') ' : '')
    + sessionId + ' → ' + result.outcome,
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
 * Reconcile every naming row (bounded). Safe on startup/reload and from the
 * panel's explicit repair action. Cold sessions are counted but never resumed.
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
    if (row.kind === 'other') continue
    if (row.state === 'user-locked') continue
    if (row.state === 'provisional') continue
    if (!isSessionLive(deps.ctx, row.sessionId)) {
      if (row.state === 'deferred') summary.deferred += 1
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
  if (summary.checked > 0 || summary.deferred > 0 || summary.locked > 0 || summary.failed > 0) {
    deps.logger.info(
      'supermemory: title reconcile — checked ' + summary.checked + ', repaired ' + summary.repaired
      + ', deferred ' + summary.deferred + ', locked ' + summary.locked + ', failed ' + summary.failed,
    )
  }
  return summary
}
