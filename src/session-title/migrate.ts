/**
 * R59 Phase 1b: one-time migration of the existing title corpus into the naming
 * service — MARKER v1 of the new 'session-titles' row (never the R42
 * 'hub-titles' v3 marker, which has already converged).
 *
 * Rules per hub_sessions row:
 *   a. a user-locked row is never touched;
 *   b. a topic-bearing, non-legacy host title is adopted (desired = host,
 *      lastWritten = host, mirror = host) with NO host write;
 *   c. a neutral/legacy host title + a topic-bearing mirror → desired is the
 *      policy-normalized composition (workspace prefix once, ≤ 80 UTF-8 bytes);
 *   d. a neutral host title + a topic-less mirror → provisional
 *      '<工作区> · 新会话';
 *   e. a LIVE session gets a deferred rename; a COLD session is stored as
 *      deferred and recorded in the marker's pending set. Cold sessions are
 *      NEVER resumed.
 *
 * Marker/convergence: version + processed/pending id sets. A processed id is
 * never scanned again; cold ids stay pending and are retried on their first live
 * event (see observe.ts / reconcile.ts). The marker is written even while
 * pending is non-empty, so "no renamable live item left" is the convergence
 * condition — not "pending is empty". Repeated startups are idempotent.
 * @module supermemory/session-title/migrate
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from '../store.ts'
import { workspaceKeyOf } from '../store.ts'
import { isPluginBranchId } from '../hub-sessions.ts'
import { cleanTitleText, stripLeadingDescription } from '../title.ts'
import { applySessionTitle } from './gate.ts'
import { isSessionLive, readHostTitle } from './host.ts'
import {
  clipTitleBytes,
  composeHubTitle,
  composeRecordedHubTitle,
  isLegacyTitle,
  isNeutralTitle,
} from './policy.ts'
import { ensureTitleRow, mirrorHubTitle, patchTitleRow, titleRow } from './state.ts'
import type { TitleDeps } from './types.ts'

/** Bump when the migration rules change; an older marker re-runs the pass. */
export const SESSION_TITLES_MIGRATION_VERSION = 1

/** The meta-table row key of the new migration marker. */
const MARKER_KEY = 'session-titles'

/** Bound on scanned candidates (a diagnostics pass, not an archive walk). */
const CANDIDATE_LIMIT = 300

/** Bound on the recorded id sets (diagnostics, not an archive). */
const ID_CAP = 500

/** Marker shape (declared fields live in schema.ts meta). */
export interface SessionTitlesMarker {
  sessionTitlesMigrationVersion?: number
  sessionTitlesMigratedAt?: number
  sessionTitlesMigrated?: number
  sessionTitlesAdopted?: number
  sessionTitlesDeferred?: number
  sessionTitlesSkipped?: number
  sessionTitlesCleaned?: number
  sessionTitlesProcessedIds?: string[]
  sessionTitlesPendingIds?: string[]
}

/** One planned mapping, exposed for dry-run and the read-only verification. */
export interface SessionTitlesPlanItem {
  sessionId: string
  kind: 'hub'
  workspaceKey: string
  hostTitle: string
  mirrorTitle: string
  desiredTitle: string
  action: 'adopt' | 'rename' | 'provisional' | 'deferred' | 'locked' | 'skip' | 'unknown'
  live: boolean
  reason: string
}

export interface SessionTitlesMigrationResult {
  status: 'applied' | 'already-done' | 'no-store'
  scanned: number
  adopted: number
  renamed: number
  deferred: number
  skipped: number
  cleaned: number
  processed: number
  pending: number
  plan: SessionTitlesPlanItem[]
}

interface Candidate {
  sessionId: string
  workspaceKey: string
  /** The durable mirror title this session already has (hub_sessions.title). */
  mirrorTitle: string
}

interface TitleSnapshotLike {
  sessionId?: string
  status?: 'fulfilled' | 'rejected'
  value?: { title?: { title?: string } }
}

interface SessionQueryLike {
  readTitleSnapshots?(sessionIds: readonly string[]): Promise<TitleSnapshotLike[]>
}

function serviceOf<T>(ctx: Context | undefined, name: string): T | undefined {
  if (!ctx) return undefined
  try {
    return (ctx as unknown as { get?: (key: string) => unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/** The persisted marker, or undefined when the pass never ran. */
export function sessionTitlesMarker(store: Store | undefined): SessionTitlesMarker | undefined {
  if (!store) return undefined
  try {
    return store.meta?.get?.(MARKER_KEY) as SessionTitlesMarker | undefined
  } catch {
    return undefined
  }
}

/**
 * Remove one id from the pending set after a successful live write (called by
 * the reconcile/first-event path). Content-idempotent; a missing marker is a
 * no-op.
 */
export async function settleSessionTitlePendingId(store: Store | undefined, sessionId: string): Promise<void> {
  if (!store || !sessionId) return
  const marker = sessionTitlesMarker(store)
  if (!marker) return
  // Only a PENDING id needs settling. This keeps a healthy startup from doing a
  // meta write per already-named row (reconcile calls this for every row).
  if (!(marker.sessionTitlesPendingIds ?? []).includes(sessionId)) return
  const pending = (marker.sessionTitlesPendingIds ?? []).filter((id) => id !== sessionId)
  const processed = [...new Set([...(marker.sessionTitlesProcessedIds ?? []), sessionId])].slice(-ID_CAP)
  try {
    await store.meta.put(MARKER_KEY, {
      ...marker,
      sessionTitlesMigratedAt: Date.now(),
      sessionTitlesProcessedIds: processed,
      sessionTitlesPendingIds: pending.slice(-ID_CAP),
    })
  } catch { /* a closing store keeps the row; the next live event retries */ }
}

/** All topic-set titles (prefix stripping evidence for durable titles). */
function topicTitlesOf(store: Store | undefined): string[] {
  const titles: string[] = []
  if (!store) return titles
  try {
    for (const [, record] of store.topicsets.entries()) {
      const title = String(record?.title ?? '').trim()
      if (title) titles.push(title)
    }
  } catch { /* best effort */ }
  return titles
}

/** Strip a known topic-set prefix from one title. */
export function stripTopicPrefix(title: string, topicTitles: readonly string[]): string {
  const value = String(title ?? '').trim()
  for (const topic of topicTitles) {
    const prefix = String(topic ?? '').trim() + ' · '
    if (prefix.length > 3 && value.startsWith(prefix)) return value.slice(prefix.length).trim()
  }
  return value
}

/**
 * Normalize the DURABLE copies (dispatch rows + fork member titles) to the
 * direct-description + 80-byte rule. Content-idempotent; hub mirrors are NOT
 * touched here — the hub rules below own that string.
 */
async function normalizeDurableTitles(store: Store | undefined, topicTitles: readonly string[]): Promise<number> {
  if (!store) return 0
  let cleaned = 0
  const cleanOnce = (title: string): string | undefined => {
    const raw = String(title ?? '').trim()
    if (!raw) return undefined
    const next = clipTitleBytes(stripLeadingDescription(cleanTitleText(stripTopicPrefix(raw, topicTitles))))
    return next && next !== raw ? next : undefined
  }
  try {
    for (const [id, row] of store.dispatches.entries()) {
      const next = cleanOnce(row.title)
      if (!next) continue
      await store.dispatches.update(id, (record) => ({ ...record, title: next }))
      cleaned += 1
    }
  } catch { /* best effort */ }
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
  } catch { /* best effort */ }
  return cleaned
}

/** Live workspace key of one session (header cwd), when readable. */
function liveWorkspaceKey(ctx: Context | undefined, sessionId: string): string {
  try {
    const sessions = (ctx as unknown as { sessions?: { get?(id: string): { header?: { cwd?: string } } | undefined } }).sessions
    const cwd = sessions?.get?.(sessionId)?.header?.cwd
    return typeof cwd === 'string' && cwd ? workspaceKeyOf(cwd) : ''
  } catch {
    return ''
  }
}

/** Every session the plugin ever named, with its durable mirror title. */
function candidatesOf(store: Store | undefined): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  if (!store) return out
  try {
    for (const [, row] of store.hubs.entries()) {
      const sessionId = String(row.sessionId ?? '')
      if (!sessionId || seen.has(sessionId) || out.length >= CANDIDATE_LIMIT) continue
      if (isPluginBranchId(sessionId)) continue
      seen.add(sessionId)
      out.push({
        sessionId,
        workspaceKey: String(row.workspaceKey ?? ''),
        mirrorTitle: String(row.title ?? ''),
      })
    }
  } catch { /* no hub table */ }
  return out
}

/**
 * Batch host titles (live snapshot preferred, cold titles from the query seam).
 * A missing/rejected observation stays UNKNOWN (undefined) — the pass never
 * renames a session whose current title cannot be read.
 */
async function readTitles(ctx: Context | undefined, sessionIds: readonly string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (query && typeof query.readTitleSnapshots === 'function') {
    try {
      const observations = await query.readTitleSnapshots(sessionIds)
      for (const observation of observations) {
        if (!observation || observation.status !== 'fulfilled') continue
        const id = String(observation.sessionId ?? '')
        const title = observation.value?.title?.title
        if (!id || typeof title !== 'string') continue
        titles.set(id, title.trim())
      }
    } catch { /* fall back to the live registry below */ }
  }
  for (const sessionId of sessionIds) {
    if (titles.has(sessionId)) continue
    const live = readHostTitle(ctx, sessionId)?.title
    if (live) titles.set(sessionId, live.trim())
  }
  return titles
}

/** A mirror title usable as a topic (topic-bearing, non-legacy). */
function usableMirror(title: string, workspaceKey: string): boolean {
  const value = String(title ?? '').trim()
  if (!value) return false
  if (isNeutralTitle(value, workspaceKey) || isLegacyTitle(value)) return false
  return true
}

/**
 * Run the migration pass.
 *
 * @param deps - host context + store + logger (the gate owns every host write).
 * @param options - dryRun returns the mapping without writing; ignoreMarker
 *   forces a full scan (manual re-run / tests).
 */
export async function migrateSessionTitles(
  deps: TitleDeps,
  options: { dryRun?: boolean; ignoreMarker?: boolean } = {},
): Promise<SessionTitlesMigrationResult> {
  const { store } = deps
  const empty: SessionTitlesMigrationResult = {
    status: 'applied', scanned: 0, adopted: 0, renamed: 0, deferred: 0,
    skipped: 0, cleaned: 0, processed: 0, pending: 0, plan: [],
  }
  if (!store) return { ...empty, status: 'no-store' }

  const marker = sessionTitlesMarker(store)
  const known = !options.ignoreMarker
    && (marker?.sessionTitlesMigrationVersion ?? 0) >= SESSION_TITLES_MIGRATION_VERSION
  const processed = new Set(marker?.sessionTitlesProcessedIds ?? [])
  const pending = new Set(marker?.sessionTitlesPendingIds ?? [])
  const candidates = candidatesOf(store)
  const byId = new Map(candidates.map((candidate) => [candidate.sessionId, candidate]))

  // A converged marker with an empty pending set has nothing to do.
  if (known && pending.size === 0) return { ...empty, status: 'already-done' }

  // Full scan on the first run (or a forced re-run); afterwards only pending ids.
  const scanIds: string[] = known
    ? [...pending].filter((id) => byId.has(id))
    : candidates.map((candidate) => candidate.sessionId).filter((id) => options.ignoreMarker || !processed.has(id))
  if (known) {
    for (const id of [...pending]) if (!byId.has(id)) pending.delete(id)
  }
  if (scanIds.length === 0) {
    if (!options.dryRun) {
      await writeMarker(store, marker, {
        processed, pending, cleaned: 0,
        counts: { migrated: 0, adopted: 0, deferred: 0, skipped: 0 },
      })
    }
    return { ...empty, status: 'applied', processed: processed.size, pending: pending.size }
  }

  const titles = await readTitles(deps.ctx, scanIds)
  const topicTitles = topicTitlesOf(store)
  const cleaned = options.dryRun || known ? 0 : await normalizeDurableTitles(store, topicTitles)
  const result: SessionTitlesMigrationResult = { ...empty, scanned: scanIds.length, cleaned }
  const plan = result.plan

  for (const sessionId of scanIds) {
    const candidate = byId.get(sessionId)
    if (!candidate) continue
    const workspaceKey = candidate.workspaceKey || liveWorkspaceKey(deps.ctx, sessionId)
    const hostTitle = titles.get(sessionId)
    const live = isSessionLive(deps.ctx, sessionId)
    const mirrorTitle = candidate.mirrorTitle
    const base = { sessionId, kind: 'hub' as const, workspaceKey, hostTitle: hostTitle ?? '', mirrorTitle, live }

    // ---- a. user-locked: never touched ----
    const row = titleRow(store, sessionId)
    if (row?.state === 'user-locked') {
      result.skipped += 1
      processed.add(sessionId)
      pending.delete(sessionId)
      plan.push({ ...base, desiredTitle: row.desiredTitle, action: 'locked', reason: row.lockedReason || 'user-locked' })
      continue
    }

    // Unknown host title: never rename what we cannot read. The observer adopts
    // a later session/title event and the first user message creates the row.
    if (hostTitle === undefined) {
      result.skipped += 1
      processed.add(sessionId)
      pending.delete(sessionId)
      plan.push({ ...base, desiredTitle: row?.desiredTitle ?? '', action: 'unknown', reason: 'host-title-unreadable' })
      continue
    }

    // ---- b. a topic-bearing host title is ADOPTED, never rewritten ----
    if (!isNeutralTitle(hostTitle, workspaceKey) && !isLegacyTitle(hostTitle)) {
      result.adopted += 1
      processed.add(sessionId)
      pending.delete(sessionId)
      plan.push({ ...base, desiredTitle: hostTitle, action: 'adopt', reason: 'host-title-topic-bearing' })
      if (!options.dryRun) {
        await ensureTitleRow(store, { sessionId, workspaceKey, kind: 'hub', source: 'migration' })
        await patchTitleRow(store, sessionId, {
          state: 'named',
          kind: 'hub',
          ...(workspaceKey ? { workspaceKey } : {}),
          desiredTitle: hostTitle,
          autoTitle: hostTitle,
          desiredFull: hostTitle,
          lastWrittenTitle: hostTitle,
          lastTitleSeq: readHostTitle(deps.ctx, sessionId)?.seq,
          source: 'migration',
          lockedReason: '',
          attempts: 0,
          lastError: '',
        })
        await mirrorHubTitle(store, sessionId, hostTitle, workspaceKey)
      }
      continue
    }

    // ---- c/d. neutral/legacy host: compose the intended final string ----
    const mirrorTopic = usableMirror(mirrorTitle, workspaceKey)
    const desiredTitle = mirrorTopic
      ? composeRecordedHubTitle(workspaceKey, mirrorTitle)
      : composeHubTitle(workspaceKey, '')
    const desiredNeutral = isNeutralTitle(desiredTitle, workspaceKey)
    const action: SessionTitlesPlanItem['action'] = live ? (desiredNeutral ? 'provisional' : 'rename') : 'deferred'
    plan.push({
      ...base,
      desiredTitle,
      action,
      reason: mirrorTopic ? 'neutral-host-mirror-topic' : 'neutral-host-no-topic',
    })

    if (options.dryRun) continue

    if (!live) {
      // ---- e. cold: store the intent, wait for the first live event ----
      await ensureTitleRow(store, { sessionId, workspaceKey, kind: 'hub', source: 'migration' })
      await patchTitleRow(store, sessionId, {
        state: 'deferred',
        kind: 'hub',
        ...(workspaceKey ? { workspaceKey } : {}),
        desiredTitle,
        autoTitle: desiredTitle,
        desiredFull: desiredTitle,
        topic: mirrorTopic ? String(mirrorTitle ?? '').trim() : '',
        source: 'migration',
        lastError: 'session-not-live',
      })
      if (!desiredNeutral) await mirrorHubTitle(store, sessionId, desiredTitle, workspaceKey)
      pending.add(sessionId)
      processed.add(sessionId)
      result.deferred += 1
      continue
    }

    const applied = await applySessionTitle(deps, {
      sessionId,
      kind: 'hub',
      workspaceKey,
      explicitTitle: desiredTitle,
      source: 'migration',
      force: true,
      defer: true,
    })
    if (applied.outcome === 'locked') {
      result.skipped += 1
      processed.add(sessionId)
      pending.delete(sessionId)
      continue
    }
    if (applied.outcome === 'deferred' || applied.outcome === 'none' || applied.outcome === 'skipped') {
      pending.add(sessionId)
      processed.add(sessionId)
      result.deferred += 1
      continue
    }
    result.renamed += 1
    processed.add(sessionId)
    pending.delete(sessionId)
  }

  if (!options.dryRun) {
    await writeMarker(store, marker, {
      processed,
      pending,
      cleaned,
      counts: {
        migrated: result.renamed,
        adopted: result.adopted,
        deferred: result.deferred,
        skipped: result.skipped,
      },
    })
  }
  result.processed = processed.size
  result.pending = pending.size
  deps.logger.info(
    'supermemory: session titles migrated — scanned ' + result.scanned + ', adopted ' + result.adopted
    + ', renamed ' + result.renamed + ', deferred ' + result.deferred + ', skipped ' + result.skipped
    + ', cleaned ' + result.cleaned + ', pending ' + result.pending,
  )
  return result
}

/** Write the converged marker (always, even while pending is non-empty). */
async function writeMarker(
  store: Store,
  previous: SessionTitlesMarker | undefined,
  input: {
    processed: Set<string>
    pending: Set<string>
    cleaned: number
    counts: {
      migrated?: number
      adopted?: number
      deferred?: number
      skipped?: number
    }
  },
): Promise<void> {
  try {
    await store.meta.put(MARKER_KEY, {
      ...previous,
      sessionTitlesMigrationVersion: SESSION_TITLES_MIGRATION_VERSION,
      sessionTitlesMigratedAt: Date.now(),
      sessionTitlesMigrated: input.counts.migrated ?? 0,
      sessionTitlesAdopted: input.counts.adopted ?? 0,
      sessionTitlesDeferred: input.counts.deferred ?? 0,
      sessionTitlesSkipped: input.counts.skipped ?? 0,
      sessionTitlesCleaned: input.cleaned,
      sessionTitlesProcessedIds: [...input.processed].slice(-ID_CAP),
      sessionTitlesPendingIds: [...input.pending].slice(-ID_CAP),
    })
  } catch { /* the next start re-plans; the pass is content-idempotent */ }
}
