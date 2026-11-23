/**
 * One-time rename of hub sessions created by the PRE-R31 title format.
 *
 * History: `createHubSession` used to title a new hub `新会话 · <id4>` — a
 * generic name that told the user nothing about which app the session belonged
 * to. R31 需求① changed the generation path to `SuperMemory 中枢 · <id4>`
 * (see {@link hubSessionTitle}); this module refreshes the EXISTING rows:
 *   - enumerate the session corpus through the host `sessionQuery` seam
 *     (live `ctx.sessions` as a fallback), keeping only plausible plugin hub
 *     sessions: no `parentSession`, `origin !== 'subagent'`, and not a
 *     plugin-minted `branch-*`/`fork-*` id (those are work branches, and a
 *     branch that has not joined a topic set must never be renamed);
 *   - read each candidate's LIVE host title and rename only when it still
 *     matches the legacy pattern `^新会话 · ` — a title somebody else edited
 *     is left alone (the same guard applyPlanToHost uses, via
 *     {@link currentSessionTitle});
 *   - rename through `applySessionTitle(..., { force: true })`, the same host
 *     write the generation path uses.
 * The plan is content-idempotent (a renamed row no longer matches the pattern,
 * so a second plan is empty), and a persisted marker (store meta row
 * `hub-titles`) keeps the startup pass from rescanning after every candidate
 * was either renamed or deliberately skipped. When a candidate cannot be
 * renamed yet (the session is not attached to the host, outcome `none`) the
 * marker is NOT written, so the next startup retries it — the pass is
 * self-healing rather than one-shot lossy.
 * @module supermemory/hub-title-migration
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { isPluginBranchId } from './hub-sessions.ts'
import { applySessionTitle, currentSessionTitle } from './title.ts'

/** Bump when the rename rules change; a marker of an older version re-runs. */
export const HUB_TITLES_MIGRATION_VERSION = 1

/** The meta-table row key of the migration marker. */
const MARKER_KEY = 'hub-titles'

/**
 * The legacy hub title: `新会话 · <id suffix>`. Only `createHubSession` ever
 * wrote it — the topic-set member fallback is the bare `新会话`
 * (`TITLE_FALLBACK` in title.ts) without a suffix, so a host session never
 * collides with this pattern.
 */
const LEGACY_HUB_TITLE = /^新会话 · (.+)$/

export interface HubTitleMigrationDeps {
  ctx: Context | undefined
  store: Store | undefined
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

/** One planned rename (session id + the titles it moves between). */
export interface HubTitlePlanItem {
  sessionId: string
  from: string
  to: string
}

export interface HubTitleMigrationResult {
  status: 'applied' | 'already-done' | 'planned' | 'no-host'
  /** Sessions inspected through the seam (before the title filter). */
  scanned: number
  /** Rows renamed on the host this run. */
  renamed: number
  /** Rows skipped because the live title was changed by somebody else. */
  skipped: number
  /** Rows that matched but could not be written (session not attached). */
  pending: number
  plan: HubTitlePlanItem[]
}

const zeros = { scanned: 0, renamed: 0, skipped: 0, pending: 0 }

/** Structural view of the host session-query seam (same shape hub-sessions reads). */
interface SessionHeaderLike {
  id?: string
  cwd?: string
  createdAt?: number
  parentSession?: string
  origin?: string
}

interface SessionRecordLike {
  header: SessionHeaderLike
}

interface TitleObservationLike {
  sessionId?: string
  status?: 'fulfilled' | 'rejected'
  value?: { title?: { title?: string } }
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

/** The session corpus: sessionQuery first, live sessions as a fallback. */
async function listSessionRecords(ctx: Context): Promise<SessionRecordLike[] | undefined> {
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (query && typeof query.listSessions === 'function') {
    try {
      const rows = await query.listSessions()
      if (Array.isArray(rows)) return rows
    } catch { /* fall through to the live registry */ }
  }
  try {
    const live = serviceOf<LiveSessionsLike>(ctx, 'sessions')
    const rows = typeof live?.list === 'function' ? live.list() : []
    return rows.map((session) => ({ header: session.header ?? { id: session.id } }))
  } catch {
    return undefined
  }
}

/**
 * Live titles for a batch of ids: one `readTitleSnapshots` read when the host
 * offers it, otherwise the per-session `sessionTitle` read. Ids without a
 * readable title are simply absent from the map.
 */
async function readTitles(ctx: Context, sessionIds: readonly string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (query && typeof query.readTitleSnapshots === 'function') {
    try {
      const observations = await query.readTitleSnapshots(sessionIds)
      for (const observation of observations) {
        if (!observation || observation.status !== 'fulfilled') continue
        const sessionId = String(observation.sessionId ?? '')
        const title = observation.value?.title?.title
        if (!sessionId || typeof title !== 'string' || !title.trim()) continue
        titles.set(sessionId, title.trim())
      }
      return titles
    } catch { /* fall back to the per-session read */ }
  }
  for (const sessionId of sessionIds) {
    const current = currentSessionTitle(ctx, sessionId)
    if (current && current.trim()) titles.set(sessionId, current.trim())
  }
  return titles
}

/** The persisted migration marker (undefined when never run). */
export async function hubTitlesMigrationMarker(store: Store | undefined): Promise<{ hubTitlesMigratedAt?: number; hubTitlesMigrationVersion?: number } | undefined> {
  return store?.meta?.get(MARKER_KEY)
}

/** Record a successful run so a restart does not rescan. */
async function writeHubTitlesMigrationMarker(store: Store | undefined): Promise<void> {
  if (!store?.meta) return
  await store.meta.put(MARKER_KEY, { hubTitlesMigratedAt: Date.now(), hubTitlesMigrationVersion: HUB_TITLES_MIGRATION_VERSION })
}

/** The new title for one hub session: same suffix, explicit flavour prefix. */
export function hubTitleFor(sessionId: string, currentTitle: string): string {
  const suffix = LEGACY_HUB_TITLE.exec(currentTitle)?.[1] ?? sessionId.slice(-4)
  return `SuperMemory 中枢 · ${suffix}`
}

/**
 * Run (or preview) the rename. Startup calls it with no options (marker-
 * guarded and best-effort); tests call it with `ignoreMarker` to force a pass.
 */
export async function migrateHubSessionTitles(
  deps: HubTitleMigrationDeps,
  options: { dryRun?: boolean; ignoreMarker?: boolean } = {},
): Promise<HubTitleMigrationResult> {
  const { ctx, store, logger } = deps
  if (!options.ignoreMarker) {
    const marker = await hubTitlesMigrationMarker(store)
    if (marker && (marker.hubTitlesMigrationVersion ?? 0) >= HUB_TITLES_MIGRATION_VERSION) {
      return { status: 'already-done', ...zeros, plan: [] }
    }
  }
  if (!ctx) return { status: 'no-host', ...zeros, plan: [] }
  const records = await listSessionRecords(ctx)
  if (!records) return { status: 'no-host', ...zeros, plan: [] }

  // Candidates: plausible plugin hub sessions only. A subagent child, a
  // parented fork or a plugin work branch is never a hub, whatever its title.
  const candidates: string[] = []
  for (const record of records) {
    const header = record?.header ?? {}
    const sessionId = String(header.id ?? '')
    if (!sessionId) continue
    if (header.parentSession) continue
    if (header.origin === 'subagent') continue
    if (isPluginBranchId(sessionId)) continue
    candidates.push(sessionId)
  }
  const scanned = candidates.length
  if (scanned === 0) {
    if (!options.dryRun) await writeHubTitlesMigrationMarker(store)
    return { status: 'applied', scanned: 0, renamed: 0, skipped: 0, pending: 0, plan: [] }
  }

  const titles = await readTitles(ctx, candidates)
  const plan: HubTitlePlanItem[] = []
  for (const sessionId of candidates) {
    const title = titles.get(sessionId)
    if (!title || !LEGACY_HUB_TITLE.test(title)) continue
    plan.push({ sessionId, from: title, to: hubTitleFor(sessionId, title) })
  }
  if (options.dryRun) return { status: 'planned', scanned, renamed: 0, skipped: 0, pending: 0, plan }

  let renamed = 0
  let skipped = 0
  let pending = 0
  for (const item of plan) {
    try {
      // Re-read the LIVE title: the batch read above may be stale, and a title
      // somebody renamed in between must never be overwritten.
      const current = currentSessionTitle(ctx, item.sessionId)
      if (current && current !== item.from) {
        skipped += 1
        logger.info(`supermemory: hub title migration skipped ${item.sessionId} — the host title was renamed by somebody else`)
        continue
      }
      const outcome = applySessionTitle(ctx, item.sessionId, item.to, logger, { force: true })
      if (outcome === 'host' || outcome === 'fallback') renamed += 1
      else pending += 1
    } catch (error) {
      pending += 1
      logger.warn('supermemory: hub title migration failed for ' + item.sessionId + ': ' + String(error).slice(0, 160))
    }
  }
  // Only mark done when nothing is left to retry: a not-yet-attached session
  // keeps the pass open so the next startup picks it up.
  if (pending === 0) await writeHubTitlesMigrationMarker(store)
  logger.info(
    `supermemory: hub title migration applied — scanned ${scanned}, renamed ${renamed}`
    + `, skipped ${skipped}, pending ${pending}`,
  )
  return { status: 'applied', scanned, renamed, skipped, pending, plan }
}
