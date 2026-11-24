/**
 * One-time rename of plugin-created session titles to DIRECT work descriptions.
 *
 * History:
 *   - pre-R31: `createHubSession` titled a hub `新会话 · <id4>`;
 *   - R31: hubs became `SuperMemory 中枢 · <id4>` (a brand prefix);
 *   - R41 需求③: session names must describe the WORK — no brand prefix, no id
 *     token, no 「R31：」「任务：」「分支 · 」 lead-ins. New rows are generated
 *     directly (see hubSessionTitle / branchTitleFor); this module refreshes the
 *     EXISTING rows:
 *       - hub candidates (top-level, not a subagent, not a plugin branch) whose
 *         live title still carries the old flavour: prefer the session's first
 *         user message (readSurface) as the description, else the neutral
 *         「新会话」. A title somebody edited by hand is never matched, so it is
 *         never overwritten;
 *       - work-branch candidates (plugin `branch-*`/`fork-*` ids): strip a
 *         KNOWN topic-set prefix (`<set> · `) and any descriptive lead-in;
 *       - durable titles (dispatch rows + branch member rows) are cleaned with
 *         the same rule, so the panel / hub cards / web console show the same
 *         direct description even before the host title is read again.
 *     Before a branded hub is renamed, a positive `hub_sessions` record is
 *     written (source 'title-migration'): the R35 hub-record migration used the
 *     brand prefix as its evidence, and that evidence disappears with the
 *     rename. The record keeps role resolution correct regardless of order.
 *
 * The plan is content-idempotent (renamed rows no longer match), and a persisted
 * marker (store meta row `hub-titles`, version 2) keeps the startup pass from
 * rescanning. When a candidate cannot be renamed yet (not attached, outcome
 * `none`) the marker is NOT written, so the next startup retries it.
 *
 * R42 (v3): the v2 marker never converged. A COLD session (one the user has not
 * opened since the pass) cannot be renamed — applySessionTitle needs an
 * attached session — so pending stayed above zero forever and every startup
 * rescanned the whole corpus. The v3 marker records id SETS instead:
 *   - hubTitlesProcessedIds: renamed, or verified clean / human-renamed;
 *   - hubTitlesPendingIds: matched a legacy pattern but was not attachable.
 * The marker is ALWAYS written at the end of a pass (converged: "no live
 * renamable item left"), and the pending ids are finished by
 * attachPendingHubTitleRename the first time their session goes live — so the
 * pass is idempotent AND eventually completes without a rescan loop.
 * @module supermemory/hub-title-migration
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import { HUB_TITLE_PREFIX, LEGACY_HUB_TITLE_PREFIX, isLegacyHubTitle, isPluginBranchId } from './hub-sessions.ts'
import { recordHubSession } from './role.ts'
import { TITLE_FALLBACK, applySessionTitle, currentSessionTitle, describeSessionTitle, stripLeadingDescription } from './title.ts'

/**
 * Bump when the rename rules change; a marker of an older version re-runs.
 * v2 (R41): direct-description renames + durable cleanup.
 * v3 (R42): converged marker with processed/pending id sets; a cold session
 * waits for its first live event instead of blocking the marker.
 */
export const HUB_TITLES_MIGRATION_VERSION = 3

/**
 * R42: the persisted migration marker. Version 3 added the id sets: a cold
 * session no longer blocks convergence (it waits in hubTitlesPendingIds for
 * its first live event instead of keeping the marker unwritten).
 */
export interface HubTitlesMarker {
  hubTitlesMigratedAt?: number
  hubTitlesMigrationVersion?: number
  hubTitlesProcessedIds?: string[]
  hubTitlesPendingIds?: string[]
}

/** Bound on the recorded id sets: the marker is diagnostics, not an archive. */
const MARKER_ID_CAP = 500

/** The meta-table row key of the migration marker. */
const MARKER_KEY = 'hub-titles'

/** Historical hub titles this pass owns: the brand prefix or「新会话 · <id>」. */
const BRANDED_HUB_TITLE = new RegExp('^' + HUB_TITLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s*·.*)?$')
const LEGACY_HUB_TITLE = new RegExp('^' + LEGACY_HUB_TITLE_PREFIX + '\\s*·\\s*.+$')

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
  /** Durable dispatch/member titles rewritten to direct descriptions. */
  cleaned: number
  plan: HubTitlePlanItem[]
}

const zeros = { scanned: 0, renamed: 0, skipped: 0, pending: 0, cleaned: 0 }

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

interface SurfaceEventLike {
  type?: string
  data?: { message?: { content?: unknown } }
}

interface SessionQueryLike {
  listSessions?(signal?: AbortSignal): Promise<SessionRecordLike[]>
  readTitleSnapshots?(sessionIds: readonly string[], signal?: AbortSignal): Promise<TitleObservationLike[]>
  /** R41: read the first user message — the best available work description. */
  readSurface?(sessionId: string): Promise<{ events?: SurfaceEventLike[] }>
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
 * offers it, otherwise the per-session `sessionTitle` read.
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

/** Join one message's text blocks (the readSurface event shape). */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const row = block as { type?: string; text?: string }
    if (row.type === 'text' && typeof row.text === 'string' && row.text.trim()) parts.push(row.text)
  }
  return parts.join(String.fromCharCode(10)).trim()
}

/** The first user message of one session, or '' when unreadable. */
async function firstUserMessageText(ctx: Context, sessionId: string): Promise<string> {
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (!query || typeof query.readSurface !== 'function') return ''
  try {
    const surface = await query.readSurface(sessionId)
    for (const event of surface?.events ?? []) {
      if (event?.type !== 'user/message') continue
      const text = contentText(event.data?.message?.content)
      if (text) return text
    }
  } catch { /* unreadable message = no content evidence */ }
  return ''
}

/** Strip a KNOWN topic-set prefix (`<set> · `) from a branch title. */
function stripTopicPrefix(title: string, topicTitles: readonly string[]): string {
  const value = String(title ?? '').trim()
  for (const topic of topicTitles) {
    const prefix = String(topic ?? '').trim() + ' · '
    if (prefix.length > 3 && value.startsWith(prefix)) return value.slice(prefix.length).trim()
  }
  return value
}

/** All topic-set titles in the store (any workspace; prefixes are discriminative). */
function topicTitlesOf(store: Store | undefined): string[] {
  const titles: string[] = []
  if (!store) return titles
  try {
    for (const [, record] of store.topicsets.entries()) {
      const title = String(record?.title ?? '').trim()
      if (title) titles.push(title)
    }
  } catch { /* a partly materialized table only narrows the prefix set */ }
  return titles
}

/**
 * Rewrite durable titles (dispatch rows + branch member rows) to direct
 * descriptions. Content-idempotent; returns how many rows changed.
 */
async function cleanDurableTitles(store: Store | undefined, topicTitles: readonly string[]): Promise<number> {
  if (!store) return 0
  let cleaned = 0
  const cleanOnce = (title: string): string | undefined => {
    const raw = String(title ?? '').trim()
    if (!raw) return undefined
    const next = describeSessionTitle(stripTopicPrefix(raw, topicTitles))
    return next && next !== raw ? next : undefined
  }
  try {
    for (const [id, row] of store.dispatches.entries()) {
      const next = cleanOnce(row.title)
      if (!next) continue
      await store.dispatches.update(id, (record) => ({ ...record, title: next }))
      cleaned += 1
    }
  } catch { /* durable cleanup is best-effort */ }


  try {
    for (const [id, record] of store.topicsets.entries()) {
      let changed = false
      const members = record.members.map((member) => {
        if (member.kind !== 'fork' && !isPluginBranchId(member.sessionId)) return member
        const next = cleanOnce(member.title)
        if (!next) return member
        changed = true
        return { ...member, title: next }
      })
      if (!changed) continue
      await store.topicsets.update(id, (row) => ({ ...row, members }))
      cleaned += 1
    }
  } catch { /* durable cleanup is best-effort */ }
  // R42: positive hub records carry a title too (the rail fallback reads it),
  // so a pre-R42 row like 「背景：仓库 …」 is cleaned by the same rule.
  try {
    for (const [id, row] of store.hubs.entries()) {
      const next = cleanOnce(row.title)
      if (!next) continue
      await store.hubs.update(id, (record) => ({ ...record, title: next }))
      cleaned += 1
    }
  } catch { /* durable cleanup is best-effort */ }
  return cleaned
}

/** The persisted migration marker (undefined when never run). */
export async function hubTitlesMigrationMarker(store: Store | undefined): Promise<HubTitlesMarker | undefined> {
  return store?.meta?.get(MARKER_KEY)
}

/**
 * Record a converged pass. R42: the id sets are MERGED with the persisted ones
 * (a later pass never forgets an earlier settle), bounded by MARKER_ID_CAP, and
 * an empty pending set is stored as absent so the row stays small.
 */
async function writeHubTitlesMigrationMarker(
  store: Store | undefined,
  ids: { settled?: readonly string[]; pending?: readonly string[] } = {},
): Promise<void> {
  if (!store?.meta) return
  const marker = await hubTitlesMigrationMarker(store)
  const processed = [...new Set([...(marker?.hubTitlesProcessedIds ?? []), ...(ids.settled ?? [])])]
  const pending = [...new Set([...(marker?.hubTitlesPendingIds ?? []), ...(ids.pending ?? [])])]
    .filter((id) => !processed.includes(id))
  await store.meta.put(MARKER_KEY, {
    hubTitlesMigratedAt: Date.now(),
    hubTitlesMigrationVersion: HUB_TITLES_MIGRATION_VERSION,
    ...(processed.length ? { hubTitlesProcessedIds: processed.slice(-MARKER_ID_CAP) } : {}),
    ...(pending.length ? { hubTitlesPendingIds: pending.slice(-MARKER_ID_CAP) } : {}),
  })
}

/**
 * Move one id out of the pending set: it was renamed, or its title is no
 * longer legacy (human rename / already clean). Merges into the persisted
 * marker so a restart never re-opens a settled id.
 */
async function settlePendingId(store: Store | undefined, sessionId: string): Promise<void> {
  if (!store?.meta) return
  const marker = await hubTitlesMigrationMarker(store)
  const pending = (marker?.hubTitlesPendingIds ?? []).filter((id) => id !== sessionId)
  const processed = [...new Set([...(marker?.hubTitlesProcessedIds ?? []), sessionId])]
  await store.meta.put(MARKER_KEY, {
    hubTitlesMigratedAt: Date.now(),
    hubTitlesMigrationVersion: HUB_TITLES_MIGRATION_VERSION,
    ...(processed.length ? { hubTitlesProcessedIds: processed.slice(-MARKER_ID_CAP) } : {}),
    ...(pending.length ? { hubTitlesPendingIds: pending } : {}),
  })
}

/**
 * The direct title for one legacy hub row: its first user message, or the
 * neutral fallback when there is no readable content.
 */
export async function hubTitleFor(ctx: Context, sessionId: string): Promise<string> {
  const content = await firstUserMessageText(ctx, sessionId)
  return content ? describeSessionTitle(content) : TITLE_FALLBACK
}

/**
 * R42: finish a PENDING rename once its session is live. The startup pass
 * cannot rename a session that is not attached (applySessionTitle needs the
 * live session object), so such ids wait in the marker's pending set; this
 * runs on the session's first event and settles the id either way.
 *
 * A title the human renamed in the meantime is never overwritten: the live
 * title no longer matches a legacy pattern, which settles the id as clean.
 *
 * @returns what happened; never throws.
 */
export async function finishPendingHubTitle(
  deps: HubTitleMigrationDeps,
  sessionId: string,
): Promise<'renamed' | 'skipped' | 'not-pending' | 'no-host' | 'failed'> {
  const { ctx, store, logger } = deps
  const id = String(sessionId ?? '')
  if (!ctx || !store || !id) return 'no-host'
  try {
    const marker = await hubTitlesMigrationMarker(store)
    if (!(marker?.hubTitlesPendingIds ?? []).includes(id)) return 'not-pending'
    const current = currentSessionTitle(ctx, id)
    if (!current) return 'no-host'
    if (!isLegacyHubTitle(current)) {
      await settlePendingId(store, id)
      return 'skipped'
    }
    const to = await hubTitleFor(ctx, id)
    if (!to || to === current) {
      await settlePendingId(store, id)
      return 'skipped'
    }
    const outcome = applySessionTitle(ctx, id, to, logger, { force: true })
    if (outcome !== 'host' && outcome !== 'fallback') return 'failed'
    await settlePendingId(store, id)
    logger.info('supermemory: pending hub title renamed for ' + id)
    return 'renamed'
  } catch (error) {
    logger.warn('supermemory: pending hub title rename failed for ' + id + ': ' + String(error).slice(0, 160))
    return 'failed'
  }
}

/**
 * R42: attach the first-event rename hook for pending legacy titles. The
 * pending set is loaded lazily — after the startup pass finished when its
 * promise is supplied — and kept in memory as ids settle, so the steady-state
 * cost per event is one Set lookup.
 *
 * @param startupPass - the startup migrateHubSessionTitles promise (optional);
 *   awaited once before the pending set is first read, so a session that goes
 *   live during the pass is not missed.
 * @returns the listener disposer.
 */
export function attachPendingHubTitleRename(
  ctx: Context | undefined,
  store: Store | undefined,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
  startupPass?: Promise<unknown>,
): () => void {
  if (!ctx || !store || typeof ctx.on !== 'function') return () => {}
  let cache: Set<string> | undefined
  const load = async (): Promise<Set<string>> => {
    if (cache) return cache
    try { await startupPass } catch { /* the pass already logged its own failure */ }
    const marker = await hubTitlesMigrationMarker(store)
    cache = new Set(marker?.hubTitlesPendingIds ?? [])
    return cache
  }
  const off = ctx.on('session/event', (session: { id?: unknown }) => {
    const id = String(session?.id ?? '')
    if (!id) return
    void load()
      .then((pending) => {
        if (!pending.has(id)) return undefined
        return finishPendingHubTitle({ ctx, store, logger }, id).then((outcome) => {
          if (outcome === 'renamed' || outcome === 'skipped') pending.delete(id)
        })
      })
      .catch((error) => {
        logger.warn('supermemory: pending hub title hook failed: ' + String(error).slice(0, 160))
      })
  })
  return off
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
  const topicTitles = topicTitlesOf(store)

  // Durable titles first: no host needed, and the result is observable even when
  // a session is currently detached.
  const cleaned = options.dryRun ? 0 : await cleanDurableTitles(store, topicTitles)

  if (!ctx) return { status: 'no-host', ...zeros, cleaned: 0, plan: [] }
  const records = await listSessionRecords(ctx)
  if (!records) return { status: 'no-host', ...zeros, cleaned, plan: [] }

  // Hub candidates: top-level, not a subagent, not a plugin work branch.
  const hubCandidates: Array<{ sessionId: string; workspaceKey: string }> = []
  // Branch candidates: plugin-minted work sessions (a fork may still carry a
  // parentSession, so only the subagent origin excludes it).
  const branchCandidates: string[] = []
  for (const record of records) {
    const header = record?.header ?? {}
    const sessionId = String(header.id ?? '')
    if (!sessionId) continue
    if (header.origin === 'subagent') continue
    if (isPluginBranchId(sessionId)) {
      branchCandidates.push(sessionId)
      continue
    }
    if (header.parentSession) continue
    hubCandidates.push({ sessionId, workspaceKey: workspaceKeyOf(header.cwd) })
  }
  const scanned = hubCandidates.length + branchCandidates.length
  if (scanned === 0) {
    if (!options.dryRun) await writeHubTitlesMigrationMarker(store)
    return { status: 'applied', scanned: 0, renamed: 0, skipped: 0, pending: 0, cleaned, plan: [] }
  }

  const titles = await readTitles(ctx, [...hubCandidates.map((row) => row.sessionId), ...branchCandidates])
  const plan: HubTitlePlanItem[] = []
  const hubTargets: Array<{ sessionId: string; workspaceKey: string; from: string; to: string }> = []

  for (const candidate of hubCandidates) {
    const title = titles.get(candidate.sessionId)
    if (!title) continue
    if (!BRANDED_HUB_TITLE.test(title) && !LEGACY_HUB_TITLE.test(title)) continue
    const to = await hubTitleFor(ctx, candidate.sessionId)
    if (!to || to === title) continue
    plan.push({ sessionId: candidate.sessionId, from: title, to })
    hubTargets.push({ ...candidate, from: title, to })
  }
  for (const sessionId of branchCandidates) {
    const title = titles.get(sessionId)
    if (!title) continue
    const to = describeSessionTitle(stripTopicPrefix(title, topicTitles))
    if (!to || to === title) continue
    plan.push({ sessionId, from: title, to })
  }
  if (options.dryRun) return { status: 'planned', scanned, renamed: 0, skipped: 0, pending: 0, cleaned: 0, plan }

  // Preserve the R35 evidence before the brand prefix disappears: a legacy hub
  // becomes a positive hub record even if the host rename is still pending.
  for (const target of hubTargets) {
    await recordHubSession(store, {
      sessionId: target.sessionId,
      workspaceKey: target.workspaceKey,
      title: target.to,
      source: 'title-migration',
    })
  }

  let renamed = 0
  let skipped = 0
  let pending = 0
  // R42: which ids this pass SETTLED (renamed / human-renamed / verified clean)
  // and which it could not reach (not attached). The marker records both, so a
  // cold session waits for its first live event instead of blocking convergence.
  const settled = new Set<string>()
  const unfinished = new Set<string>()
  for (const item of plan) {
    try {
      // Re-read the LIVE title: the batch read above may be stale, and a title
      // somebody renamed in between must never be overwritten.
      const current = currentSessionTitle(ctx, item.sessionId)
      if (current && current !== item.from) {
        skipped += 1
        settled.add(item.sessionId)
        logger.info(`supermemory: title migration skipped ${item.sessionId} — the host title was renamed by somebody else`)
        continue
      }
      const outcome = applySessionTitle(ctx, item.sessionId, item.to, logger, { force: true })
      if (outcome === 'host' || outcome === 'fallback') {
        renamed += 1
        settled.add(item.sessionId)
      } else {
        pending += 1
        unfinished.add(item.sessionId)
      }
    } catch (error) {
      pending += 1
      unfinished.add(item.sessionId)
      logger.warn('supermemory: title migration failed for ' + item.sessionId + ': ' + String(error).slice(0, 160))
    }
  }
  // R42: CONVERGE. The marker is written on every non-dry pass — "no live
  // renamable item left" is the completion condition, not "nothing pending".
  // Unfinished ids stay in hubTitlesPendingIds for the session/event hook
  // (attachPendingHubTitleRename), which renames them once they go live.
  await writeHubTitlesMigrationMarker(store, { settled: [...settled], pending: [...unfinished] })
  logger.info(
    `supermemory: title migration applied — scanned ${scanned}, renamed ${renamed}`
    + `, skipped ${skipped}, pending ${pending}, durable cleaned ${cleaned}`,
  )
  return { status: 'applied', scanned, renamed, skipped, pending, cleaned, plan }
}
