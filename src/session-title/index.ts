/**
 * R59: the session-naming service — public surface.
 *
 * One authority (the host title), one durable intent (`session_titles`), one
 * write entry ({@link applySessionTitle}), and one automatic observer. Callers
 * must never import `host.ts` directly; everything goes through the gate.
 * @module supermemory/session-title
 */
import { attachSessionTitleObserver } from './observe.ts'
import { reconcileTitles, type ReconcileSummary } from './reconcile.ts'
import { migrateSessionTitles, type SessionTitlesMigrationResult } from './migrate.ts'
import type { TitleDeps } from './types.ts'

export * from './types.ts'
export { applySessionTitle, renameSession, resetAutoTitle, claimHostWrite, pendingWrite, takeOwnWrite, clearPendingWrite } from './gate.ts'
export { deferTitleTask, retryReentrant, MAX_TITLE_WRITE_ATTEMPTS } from './defer.ts'
export { attachSessionTitleObserver, firstUserMessageSeq, contentText } from './observe.ts'
export { reconcileSessionTitle, reconcileTitles, type ReconcileSummary } from './reconcile.ts'
export { migrateSessionTitles, SESSION_TITLES_MIGRATION_VERSION, type SessionTitlesMigrationResult, type SessionTitlesMarker } from './migrate.ts'
export { resolveSessionTitle, resolveDisplayTitle } from './resolve.ts'
export {
  TITLE_MAX_BYTES,
  composeHubTitle,
  composeBranchTitle,
  composeTopicSetTitle,
  clipTitleBytes,
  isNeutralTitle,
  isLegacyTitle,
  isUpgradeableTitle,
  validateManualTitle,
  workspaceLabel,
} from './policy.ts'

/** What one startup naming pass produced (diagnostics only). */
export interface SessionTitlesStartupResult {
  migration?: SessionTitlesMigrationResult
  reconcile?: ReconcileSummary
}

/**
 * Startup (and plugin reload) entry: migrate the corpus, then reconcile every
 * row. Both halves are best-effort — a naming failure must never keep the
 * plugin from loading.
 *
 * Phase 1a: NOT CALLED by the plugin yet (Phase 1b wires it); the plugin only
 * attaches the observer below. Both halves are drafts pending Phase 1b review.
 */
export async function startupSessionTitles(deps: TitleDeps): Promise<SessionTitlesStartupResult> {
  const result: SessionTitlesStartupResult = {}
  try {
    result.migration = await migrateSessionTitles(deps)
  } catch (error) {
    deps.logger.warn('supermemory: session-title migration failed: ' + String(error).slice(0, 200))
  }
  try {
    result.reconcile = await reconcileTitles(deps, { reason: 'startup' })
  } catch (error) {
    deps.logger.warn('supermemory: session-title reconcile failed: ' + String(error).slice(0, 200))
  }
  return result
}

/** Attach the automatic observer (once per plugin load). */
export function attachSessionTitles(deps: TitleDeps): () => void {
  return attachSessionTitleObserver(deps)
}
