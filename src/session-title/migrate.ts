/**
 * R59: one-time migration of the existing title corpus into the naming service.
 *
 * STATUS (Phase 1a): DRAFT, NOT WIRED. The plugin does not call
 * `startupSessionTitles`, so no marker is written and no corpus is touched in
 * this round; Phase 1b reviews this pass, writes docs and wires the startup run.
 * The module is kept because it typechecks and is the reviewed starting point.
 *
 * The pre-R59 world had three generations of names and one broken upgrade hook:
 *   - host titles with the old brand prefix or `新会话 · <id>` (legacy);
 *   - plugin hubs whose host title is a bare/qualified neutral name while the
 *     `hub_sessions` mirror already carries the topic (the R43 failure state);
 *   - host titles a human or the host's LLM chose (topic-bearing) — these are
 *     ADOPTED and never rewritten.
 *
 * The pass is marker-guarded (meta row `session-titles`, version 1) and
 * idempotent by content:
 *   - durable dispatch/member/hub titles are normalized to the 80-byte rule;
 *   - a topic-bearing host title is adopted as-is;
 *   - a neutral/legacy host title is renamed to the composed title when the
 *     session is LIVE (deferred out of any publication stack), or recorded as
 *     `deferred` (cold) so the first live event / panel repair finishes it;
 *   - user-locked rows (none before R59, but a panel rename may race the pass)
 *     are never touched.
 * @module supermemory/session-title/migrate
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from '../store.ts'
import { workspaceKeyOf } from '../store.ts'
import { isPluginBranchId } from '../hub-sessions.ts'
import { applySessionTitle } from './gate.ts'
import { isSessionLive, readHostTitle } from './host.ts'
import {
  composeBranchTitle,
  composeBranchTitleFull,
  composeHubTitle,
  composeHubTitleFull,
  isLegacyTitle,
  isNeutralTitle,
  clipTitleBytes,
} from './policy.ts'
import { ensureTitleRow, mirrorHubTitle, patchTitleRow, titleRow } from './state.ts'
import type { TitleDeps, TitleKind } from './types.ts'
import { describeSessionTitle } from '../title.ts'

/** Bump when the migration rules change; an older marker re-runs the pass. */
export const SESSION_TITLES_MIGRATION_VERSION = 1

/** The meta-table row key of the migration marker. */
const MARKER_KEY = 'session-titles'

/** Bound on scanned candidates (a diagnostics pass, not an archive walk). */
const CANDIDATE_LIMIT = 300

/** Marker shape (declared fields live in schema.ts `meta`). */
export interface SessionTitlesMarker {
  sessionTitlesMigrationVersion?: number
  sessionTitlesMigratedAt?: number
  sessionTitlesMigrated?: number
  sessionTitlesAdopted?: number
  sessionTitlesDeferred?: number
}

export interface SessionTitlesMigrationResult {
  status: 'applied' | 'already-done' | 'no-store'
  scanned: number
  adopted: number
  renamed: number
  deferred: number
  skipped: number
  cleaned: number
}

interface Candidate {
  sessionId: string
  kind: TitleKind
  workspaceKey: string
  /** The durable mirror title this session already has (hub record / dispatch row). */
  mirrorTitle: string
}

interface TitleSnapshotLike {
  sessionId?: string
  status?: 'fulfilled' | 'rejected'
  value?: { title?: { title?: string } }
}

interface SessionQueryLike {
  readTitleSnapshots?(sessionIds: readonly string[]): Promise<TitleSnapshotLike[]>
  readSurface?(sessionId: string): Promise<{ events?: Array<{ type?: string; seq?: number; data?: unknown }> }>
}

function serviceOf<T>(ctx: Context | undefined, name: string): T | undefined {
  if (!ctx) return undefined
  try {
    return (ctx as unknown as { get?: (key: string) => unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/** All topic-set titles (prefix stripping evidence). */
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
 * Normalize the durable copies (dispatch rows, fork member titles, hub records)
 * to the direct-description + 80-byte rule. Content-idempotent.
 */
async function normalizeDurableTitles(store: Store | undefined, topicTitles: readonly string[]): Promise<number> {
  if (!store) return 0
  let cleaned = 0
  const cleanOnce = (title: string): string | undefined => {
    const raw = String(title ?? '').trim()
    if (!raw) return undefined
    const next = clipTitleBytes(describeSessionTitle(stripTopicPrefix(raw, topicTitles)))
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
  try {
    for (const [id, row] of store.hubs.entries()) {
      const next = cleanOnce(row.title)
      if (!next) continue
      await store.hubs.update(id, (record) => ({ ...record, title: next }))
      cleaned += 1
    }
  } catch { /* best effort */ }
  return cleaned
}

/** Join one message's text blocks. */
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

/** The first user message of one session (cold sessions included). */
async function firstUserMessageText(ctx: Context | undefined, sessionId: string): Promise<string> {
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (!query || typeof query.readSurface !== 'function') return ''
  try {
    const surface = await query.readSurface(sessionId)
    for (const event of surface?.events ?? []) {
      if (event?.type !== 'user/message') continue
      const data = event.data as { content?: unknown } | undefined
      const text = contentText(data?.content)
      if (text) return text
    }
  } catch { /* unreadable message = no content evidence */ }
  return ''
}

/** Batch host titles (live snapshot preferred, cold titles from the query seam). */
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
        if (id && typeof title === 'string' && title.trim()) titles.set(id, title.trim())
      }
    } catch { /* fall back to the live registry below */ }
  }
  for (const sessionId of sessionIds) {
    if (titles.has(sessionId)) continue
    const live = readHostTitle(ctx, sessionId)?.title
    if (live) titles.set(sessionId, live)
  }
  return titles
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
  const push = (candidate: Candidate): void => {
    if (!candidate.sessionId || seen.has(candidate.sessionId) || out.length >= CANDIDATE_LIMIT) return
    seen.add(candidate.sessionId)
    out.push(candidate)
  }
  if (!store) return out
  try {
    for (const [, row] of store.hubs.entries()) {
      push({
        sessionId: String(row.sessionId ?? ''),
        kind: 'hub',
        workspaceKey: String(row.workspaceKey ?? ''),
        mirrorTitle: String(row.title ?? ''),
      })
    }
  } catch { /* no hub table */ }
  try {
    for (const [, topicSet] of store.topicsets.entries()) {
      for (const member of topicSet.members ?? []) {
        push({
          sessionId: member.sessionId,
          kind: member.kind === 'fork' ? 'branch' : 'hub',
          workspaceKey: String(topicSet.workspaceKey ?? ''),
          mirrorTitle: String(member.title ?? ''),
        })
      }
    }
  } catch { /* no topic-set table */ }
  try {
    for (const [, row] of store.dispatches.entries()) {
      const branch = String(row.branchSessionId ?? '')
      if (!branch) continue
      let workspaceKey = ''
      try { workspaceKey = String(store.topicsets.get(row.topicSetId ?? '')?.workspaceKey ?? '') } catch { /* keep '' */ }
      push({ sessionId: branch, kind: 'branch', workspaceKey, mirrorTitle: String(row.title ?? '') })
    }
  } catch { /* no dispatch table */ }
  return out
}

/** A mirror title usable as a topic (topic-bearing, non-legacy). */
function usableTitle(title: string, workspaceKey: string): string {
  const value = String(title ?? '').trim()
  if (!value) return ''
  if (isNeutralTitle(value, workspaceKey) || isLegacyTitle(value)) return ''
  return value
}

/**
 * Run the migration pass. Startup calls it with no options (marker-guarded and
 * best-effort); tests call it with `ignoreMarker` / `dryRun`.
 */
export async function migrateSessionTitles(
  deps: TitleDeps,
  options: { dryRun?: boolean; ignoreMarker?: boolean } = {},
): Promise<SessionTitlesMigrationResult> {
  const { store } = deps
  const empty: SessionTitlesMigrationResult = {
    status: 'applied', scanned: 0, adopted: 0, renamed: 0, deferred: 0, skipped: 0, cleaned: 0,
  }
  if (!store) return { ...empty, status: 'no-store' }
  if (!options.ignoreMarker) {
    const marker = store.meta?.get?.(MARKER_KEY) as SessionTitlesMarker | undefined
    if (marker && (marker.sessionTitlesMigrationVersion ?? 0) >= SESSION_TITLES_MIGRATION_VERSION) {
      return { ...empty, status: 'already-done' }
    }
  }
  const topicTitles = topicTitlesOf(store)
  const cleaned = options.dryRun ? 0 : await normalizeDurableTitles(store, topicTitles)
  const candidates = candidatesOf(store)
  const titles = await readTitles(deps.ctx, candidates.map((candidate) => candidate.sessionId))
  let adopted = 0
  let renamed = 0
  let deferred = 0
  let skipped = 0

  for (const candidate of candidates) {
    const existing = titleRow(store, candidate.sessionId)
    if (existing) {
      // The new service already owns this session (a previous partial pass or a
      // panel rename): reconcile — never re-decide here.
      skipped += 1
      continue
    }
    const workspaceKey = candidate.workspaceKey || liveWorkspaceKey(deps.ctx, candidate.sessionId)
    const hostTitle = String(titles.get(candidate.sessionId) ?? '').trim()
    if (hostTitle && !isNeutralTitle(hostTitle, workspaceKey) && !isLegacyTitle(hostTitle)) {
      // A topic-bearing title (host LLM / human / a good older generation): ADOPT.
      await ensureTitleRow(store, {
        sessionId: candidate.sessionId, workspaceKey, kind: candidate.kind, source: 'migration',
      })
      await patchTitleRow(store, candidate.sessionId, {
        state: 'named',
        desiredTitle: hostTitle,
        desiredFull: hostTitle,
        lastWrittenTitle: hostTitle,
        lastTitleSeq: readHostTitle(deps.ctx, candidate.sessionId)?.seq,
        source: 'migration',
        attempts: 0,
        lastError: '',
      })
      if (candidate.kind === 'hub') await mirrorHubTitle(store, candidate.sessionId, hostTitle, workspaceKey)
      adopted += 1
      continue
    }

    const mirrorTopic = usableTitle(candidate.mirrorTitle, workspaceKey)
    const firstMessage = mirrorTopic ? '' : await firstUserMessageText(deps.ctx, candidate.sessionId)
    const topic = mirrorTopic || firstMessage
    const desired = candidate.kind === 'hub'
      ? composeHubTitle(workspaceKey, topic)
      : composeBranchTitle(topic || candidate.mirrorTitle)
    const full = candidate.kind === 'hub'
      ? composeHubTitleFull(workspaceKey, topic)
      : composeBranchTitleFull(topic || candidate.mirrorTitle)
    await ensureTitleRow(store, {
      sessionId: candidate.sessionId, workspaceKey, kind: candidate.kind, source: 'migration',
    })
    await patchTitleRow(store, candidate.sessionId, {
      topic,
      desiredTitle: desired,
      desiredFull: full,
      source: 'migration',
      state: isNeutralTitle(desired, workspaceKey) ? 'provisional' : 'named',
    })
    if (candidate.kind === 'hub' && desired !== hostTitle) {
      await mirrorHubTitle(store, candidate.sessionId, desired, workspaceKey)
    }
    if (!desired || desired === hostTitle) {
      if (desired === hostTitle) {
        await patchTitleRow(store, candidate.sessionId, {
          state: isNeutralTitle(desired, workspaceKey) ? 'provisional' : 'named',
          lastWrittenTitle: desired,
        })
      }
      skipped += 1
      continue
    }
    if (!isSessionLive(deps.ctx, candidate.sessionId)) {
      await patchTitleRow(store, candidate.sessionId, { state: 'deferred', lastError: 'session-not-live' })
      deferred += 1
      continue
    }
    if (options.dryRun) continue
    const result = await applySessionTitle(deps, {
      sessionId: candidate.sessionId,
      kind: candidate.kind,
      workspaceKey,
      explicitTitle: desired,
      topicText: topic,
      source: 'migration',
      force: true,
      defer: true,
    })
    if (result.outcome === 'host' || result.outcome === 'fallback') renamed += 1
    else deferred += 1
  }

  if (!options.dryRun) {
    try {
      await store.meta.put(MARKER_KEY, {
        sessionTitlesMigrationVersion: SESSION_TITLES_MIGRATION_VERSION,
        sessionTitlesMigratedAt: Date.now(),
        sessionTitlesMigrated: renamed,
        sessionTitlesAdopted: adopted,
        sessionTitlesDeferred: deferred,
      } satisfies SessionTitlesMarker)
    } catch { /* the next start re-plans; the pass is content-idempotent */ }
  }
  deps.logger.info(
    'supermemory: session titles migrated — scanned ' + candidates.length + ', adopted ' + adopted
    + ', renamed ' + renamed + ', deferred ' + deferred + ', skipped ' + skipped + ', cleaned ' + cleaned,
  )
  return {
    status: 'applied',
    scanned: candidates.length,
    adopted,
    renamed,
    deferred,
    skipped,
    cleaned,
  }
}
