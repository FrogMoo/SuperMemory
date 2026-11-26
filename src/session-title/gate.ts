/**
 * R59: the SINGLE host-title write entry (gate).
 *
 * Every title write — panel creation, first user message, dispatch, restore,
 * migration, manual rename — goes through {@link applySessionTitle}. The gate
 * owns:
 *   - per-session serialization (two paths can race on one session);
 *   - the naming state machine (provisional / named / user-locked / deferred);
 *   - deferred writes ({@link deferTitleTask}): a `session/event` listener MUST
 *     NOT append synchronously — the host rejects a re-entrant append and the
 *     old R43 hook lost every write that way;
 *   - the pending-write registry the `session/title` observer uses to tell
 *     "our write" from "somebody renamed it";
 *   - outcome/attempts/lastError recording (no silent failures, no no-op loggers).
 * @module supermemory/session-title/gate
 */
import type { SessionTitleRow } from '../schema.ts'
import type { Store } from '../store.ts'
import { deferTitleTask, retryReentrant } from './defer.ts'
import { errorText, isSessionLive, readHostTitle, writeHostTitle, type HostWriteResult } from './host.ts'
import {
  clipTitleBytes,
  composeBranchTitle,
  composeBranchTitleFull,
  composeHubTitle,
  composeHubTitleFull,
  isLegacyTitle,
  isNeutralTitle,
  validateManualTitle,
} from './policy.ts'
import { ensureTitleRow, hubRecord, memberTitleOf, mirrorHubTitle, patchTitleRow, titleRow } from './state.ts'
import type { TitleDeps, TitleIntent, TitleKind, TitleResult, TitleState } from './types.ts'

/** Claims of writes this process started, so the observer can attribute them. */
interface PendingWrite {
  title: string
  at: number
}

/** How long an unconsumed claim stays authoritative (a title event is immediate). */
const PENDING_TTL_MS = 60_000

const chains = new Map<string, Promise<unknown>>()
const pendingWrites = new Map<string, PendingWrite>()

/** Serialize work per session (rejecting/erroring tasks never break the chain). */
function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve()
  const run = previous.then(() => task())
  let guard: Promise<void>
  guard = run.then(() => undefined, () => undefined).then(() => {
    if (chains.get(sessionId) === guard) chains.delete(sessionId)
  })
  chains.set(sessionId, guard)
  return run
}

/** Register the claim of the host write that is about to happen. */
export function claimHostWrite(sessionId: string, title: string): void {
  pendingWrites.set(sessionId, { title, at: Date.now() })
}

/** The current claim of one session (expired claims are dropped). */
export function pendingWrite(sessionId: string): PendingWrite | undefined {
  const claim = pendingWrites.get(sessionId)
  if (!claim) return undefined
  if (Date.now() - claim.at > PENDING_TTL_MS) {
    pendingWrites.delete(sessionId)
    return undefined
  }
  return claim
}

/** Consume the claim when the host event matches it (true = this was our write). */
export function takeOwnWrite(sessionId: string, title: string): boolean {
  const claim = pendingWrite(sessionId)
  if (!claim || claim.title !== title) return false
  pendingWrites.delete(sessionId)
  return true
}

/** Drop a stale claim (reconcile safety valve). */
export function clearPendingWrite(sessionId: string): void {
  pendingWrites.delete(sessionId)
}

/** The composition of one intent: final (byte-clipped) + full (diagnostics). */
function composeIntent(
  intent: TitleIntent,
  row: SessionTitleRow,
  kind: TitleKind,
): { desired: string; full: string; topic: string } {
  const workspace = String(intent.workspaceKey ?? row.workspaceKey ?? '')
  if (intent.explicitTitle !== undefined) {
    const full = String(intent.explicitTitle ?? '').trim()
    return { desired: clipTitleBytes(full), full, topic: String(intent.topicText ?? row.topic ?? '').trim() }
  }
  const topic = String(intent.topicText ?? intent.firstMessage ?? row.topic ?? '').trim()
  if (kind === 'hub') {
    return {
      desired: composeHubTitle(workspace, topic),
      full: composeHubTitleFull(workspace, topic),
      topic,
    }
  }
  if (kind === 'branch') {
    return {
      desired: composeBranchTitle(topic),
      full: composeBranchTitleFull(topic),
      topic,
    }
  }
  return { desired: clipTitleBytes(topic), full: topic, topic }
}

/**
 * The automatic title a reset should restore, or '' when none is known.
 *
 * Order: the preserved `autoTitle`, the stored desired (unless it is the human's
 * own lastWritten), the durable mirror, the topic-set member title, then the
 * stored topic recomposed under the current policy. A legacy user-locked row
 * (desired was overwritten with the human title) therefore still recovers.
 */
function recoverAutoTitle(store: Store, row: SessionTitleRow, kind: TitleKind, workspace: string): string {
  const preserved = String(row.autoTitle ?? '').trim()
  if (preserved) return preserved
  const desired = String(row.desiredTitle ?? '').trim()
  if (desired && (row.state !== 'user-locked' || desired !== row.lastWrittenTitle)) return desired
  const usable = (value: string): string => {
    const text = String(value ?? '').trim()
    if (!text || isNeutralTitle(text, workspace) || isLegacyTitle(text)) return ''
    return clipTitleBytes(text)
  }
  const mirror = usable(hubRecord(store, row.sessionId)?.title ?? '')
  if (mirror) return mirror
  const member = usable(memberTitleOf(store, row.sessionId))
  if (member) return member
  const topic = String(row.topic ?? '').trim()
  if (topic) {
    if (kind === 'branch') return composeBranchTitle(topic)
    if (kind === 'hub') return composeHubTitle(workspace, topic)
    return clipTitleBytes(topic)
  }
  return ''
}

/**
 * One host write with the re-entrant retry loop, optionally deferred out of the
 * current stack. The claim is registered immediately so the observer can
 * attribute the resulting `session/title` event even when the write is deferred.
 */
async function runHostWrite(
  deps: TitleDeps,
  sessionId: string,
  title: string,
  options: { defer?: boolean },
): Promise<{ result: HostWriteResult; tries: number }> {
  claimHostWrite(sessionId, title)
  const attempt = (): Promise<{ result: HostWriteResult; tries: number }> =>
    retryReentrant<HostWriteResult>(() => writeHostTitle(deps.ctx, sessionId, title))
  if (!options.defer) return attempt()
  return deferTitleTask(attempt)
}

/** Persist a failed write: keep the intent, record why, retry later. */
async function recordDeferred(
  deps: TitleDeps,
  sessionId: string,
  row: SessionTitleRow,
  composed: { desired: string; full: string; topic: string },
  intent: TitleIntent,
  result: HostWriteResult,
): Promise<TitleResult> {
  const reason = result.error ?? 'host-write-failed'
  const live = isSessionLive(deps.ctx, sessionId)
  await patchTitleRow(deps.store as Store, sessionId, {
    state: 'deferred',
    desiredTitle: composed.desired || row.desiredTitle,
    autoTitle: composed.desired || row.autoTitle,
    desiredFull: composed.full,
    topic: composed.topic || row.topic,
    ...(intent.kind ? { kind: intent.kind } : {}),
    ...(intent.workspaceKey ? { workspaceKey: intent.workspaceKey } : {}),
    attempts: (row.attempts ?? 0) + 1,
    lastError: reason.slice(0, 300),
    source: intent.source ?? row.source,
  })
  deps.logger.warn(
    'supermemory: title deferred for ' + sessionId + ' ('
    + (live ? 'host-write-failed' : 'session-not-live') + '): ' + reason,
  )
  return {
    outcome: 'deferred',
    title: composed.desired || row.desiredTitle,
    state: 'deferred',
    reason: live ? reason : 'session-not-live: ' + reason,
  }
}

/**
 * Apply one naming intent. The ONLY function that writes a host title.
 *
 * @returns what happened; never throws (a naming failure must never break the
 *   action that requested it — the caller's message/dispatch already happened).
 */
export async function applySessionTitle(deps: TitleDeps, intent: TitleIntent): Promise<TitleResult> {
  const sessionId = String(intent.sessionId ?? '').trim()
  if (!sessionId) return { outcome: 'skipped', title: '', reason: 'missing-session-id' }
  if (!deps.store) return { outcome: 'skipped', title: '', reason: 'no-store' }
  try {
    return await enqueue(sessionId, () => applyInner(deps, { ...intent, sessionId }))
  } catch (error) {
    deps.logger.warn('supermemory: title intent failed for ' + sessionId + ': ' + errorText(error))
    return { outcome: 'skipped', title: '', reason: errorText(error) }
  }
}

async function applyInner(deps: TitleDeps, intent: TitleIntent): Promise<TitleResult> {
  const store = deps.store as Store
  const sessionId = intent.sessionId
  let row = titleRow(store, sessionId)
  if (!row) {
    row = await ensureTitleRow(store, {
      sessionId,
      workspaceKey: intent.workspaceKey,
      kind: intent.kind,
      source: intent.source,
    })
  }
  const kind: TitleKind = intent.kind ?? row.kind
  const workspace = String(intent.workspaceKey ?? row.workspaceKey ?? '')

  // ---- manual rename: validate, lock, write; PRESERVE the automatic title ----
  if (intent.mode === 'manual') {
    const validated = validateManualTitle(intent.explicitTitle ?? intent.topicText ?? '')
    if (!validated.ok) return { outcome: 'skipped', title: row.desiredTitle, reason: validated.error }
    // The host cannot rename a cold session. Never resume it here: the panel
    // reports "open the session first" instead of pretending the rename landed.
    if (!isSessionLive(deps.ctx, sessionId)) {
      return { outcome: 'skipped', title: row.desiredTitle || row.autoTitle || '', reason: 'session-not-live' }
    }
    // Preserve the automatic title BEFORE the human title replaces the host name.
    // A row created from an existing host name keeps that name as the baseline.
    let autoTitle = recoverAutoTitle(store, row, kind, workspace)
    if (!autoTitle) {
      const before = readHostTitle(deps.ctx, sessionId)?.title
      if (before && !isNeutralTitle(before, workspace) && !isLegacyTitle(before)) autoTitle = clipTitleBytes(before)
    }
    const { result } = await runHostWrite(deps, sessionId, validated.title, { defer: intent.defer })
    if (result.outcome === 'none') {
      // Keep the prior state and the recovered intent: the manual rename did
      // not land, so the UI retries rather than showing a false success.
      await patchTitleRow(store, sessionId, {
        ...(autoTitle ? { autoTitle } : {}),
        attempts: (row.attempts ?? 0) + 1,
        lastError: (result.error ?? 'host-write-failed').slice(0, 300),
      })
      return {
        outcome: 'deferred',
        title: row.desiredTitle || autoTitle,
        state: row.state,
        reason: result.error ?? 'host-write-failed',
      }
    }
    const accepted = result.accepted ?? validated.title
    await patchTitleRow(store, sessionId, {
      state: 'user-locked',
      kind,
      ...(autoTitle ? { autoTitle, desiredTitle: autoTitle, desiredFull: row.desiredFull || autoTitle } : {}),
      lastWrittenTitle: accepted,
      lastTitleSeq: readHostTitle(deps.ctx, sessionId)?.seq,
      source: 'manual',
      lockedReason: 'manual',
      attempts: 0,
      lastError: '',
    })
    if (kind === 'hub' && intent.mirror !== false) await mirrorHubTitle(store, sessionId, accepted, workspace)
    deps.logger.info('supermemory: session ' + sessionId + ' renamed by hand 「' + accepted + '」')
    return { outcome: result.outcome, title: accepted, state: 'user-locked' }
  }

  // ---- reset: drop the lock and let the intent recompute ----
  if (intent.mode === 'reset') {
    row = (await patchTitleRow(store, sessionId, { state: row.topic ? 'named' : 'provisional', lockedReason: '' })) ?? row
  }

  const locked = row.state === 'user-locked'
  if (locked && !intent.force) {
    return { outcome: 'locked', title: row.desiredTitle || row.lastWrittenTitle, state: 'user-locked', reason: row.lockedReason || 'user-locked' }
  }

  const composed = composeIntent(intent, row, kind)
  if (!composed.desired) return { outcome: 'skipped', title: '', reason: 'no-title' }

  const host = readHostTitle(deps.ctx, sessionId)
  const current = host?.title ?? ''
  const currentNeutral = !current || isNeutralTitle(current, workspace)
  const desiredNeutral = isNeutralTitle(composed.desired, workspace)

  // ---- idempotence + external-rename detection (auto intents only) ----
  if (!intent.force) {
    // A topic-bearing host title we did not write → a human renamed the session
    // outside the plugin (the host pins on every rename, and our own writes are
    // claimed). Automatic naming stops for it; a manual reset can unlock later.
    if (current && current !== row.lastWrittenTitle && !currentNeutral && current !== composed.desired) {
      // Preserve the automatic intent: a human rename must not destroy the name
      // a later "restore auto naming" should bring back.
      const autoTitle = recoverAutoTitle(store, row, kind, workspace)
      await patchTitleRow(store, sessionId, {
        state: 'user-locked',
        kind,
        ...(autoTitle ? { autoTitle, desiredTitle: autoTitle } : {}),
        lastWrittenTitle: current,
        lastTitleSeq: host?.seq,
        lockedReason: 'external-rename',
      })
      if (kind === 'hub' && intent.mirror !== false) await mirrorHubTitle(store, sessionId, current, workspace)
      deps.logger.info('supermemory: session ' + sessionId + ' was renamed outside the plugin; auto-naming stops')
      return { outcome: 'locked', title: current, state: 'user-locked', reason: 'external-rename' }
    }
    // The FIRST final name wins: a named row is never re-finalized by an
    // automatic event (a second message must not keep renaming the session).
    // Only a host that fell back to a NEUTRAL title may be repaired — and only
    // with the stored intent, never with a different topic.
    if (row.state === 'named') {
      if (desiredNeutral || !currentNeutral || composed.desired !== row.desiredTitle) {
        return { outcome: 'already', title: current || row.desiredTitle, state: 'named' }
      }
    }
    // Provisional already in force: nothing to write.
    if (composed.desired === row.desiredTitle && current === composed.desired) {
      return { outcome: 'already', title: current, state: row.state === 'named' ? 'named' : 'provisional' }
    }
  }

  const { result } = await runHostWrite(deps, sessionId, composed.desired, { defer: intent.defer })
  if (result.outcome === 'none') return recordDeferred(deps, sessionId, row, composed, intent, result)

  const accepted = result.accepted ?? composed.desired
  // A neutral composition stays provisional (the first user message may still
  // finalize it once); a topic-bearing one is the final name.
  const acceptedNeutral = isNeutralTitle(accepted, workspace)
  const nextState: TitleState = locked
    ? 'user-locked'
    : (acceptedNeutral && row.state !== 'named' ? 'provisional' : 'named')
  await patchTitleRow(store, sessionId, {
    state: nextState,
    kind,
    ...(intent.workspaceKey ? { workspaceKey: intent.workspaceKey } : {}),
    desiredTitle: accepted,
    autoTitle: accepted,
    desiredFull: composed.full,
    topic: composed.topic || row.topic,
    lastWrittenTitle: accepted,
    lastTitleSeq: readHostTitle(deps.ctx, sessionId)?.seq,
    source: intent.source ?? row.source,
    ...(intent.source === 'manual' ? { lockedReason: 'manual' } : {}),
    attempts: 0,
    lastError: '',
  })
  if (kind === 'hub' && intent.mirror !== false) await mirrorHubTitle(store, sessionId, accepted, workspace)
  deps.logger.info('supermemory: session ' + sessionId + ' named 「' + accepted + '」 (' + result.outcome + ')')
  return { outcome: result.outcome, title: accepted, state: nextState }
}

/** Manual rename (panel / GUI-equivalent): user-locked + exact bytes. */
export async function renameSession(
  deps: TitleDeps,
  input: { sessionId: string; title: string; workspaceKey?: string; kind?: TitleKind; defer?: boolean },
): Promise<TitleResult> {
  return applySessionTitle(deps, {
    sessionId: input.sessionId,
    workspaceKey: input.workspaceKey,
    kind: input.kind,
    explicitTitle: input.title,
    mode: 'manual',
    force: true,
    defer: input.defer,
    source: 'manual',
  })
}

/** Drop the user lock and recompute from the stored topic (restore auto naming). */
export async function resetAutoTitle(
  deps: TitleDeps,
  input: { sessionId: string; workspaceKey?: string; kind?: TitleKind; defer?: boolean },
): Promise<TitleResult> {
  const store = deps.store as Store
  const row = titleRow(store, input.sessionId)
  if (!row) return { outcome: 'skipped', title: '', reason: 'no-row' }
  const kind = input.kind ?? row.kind
  const workspace = input.workspaceKey ?? row.workspaceKey
  const autoTitle = recoverAutoTitle(store, row, kind, workspace)
  if (!autoTitle) {
    return { outcome: 'skipped', title: '', state: row.state, reason: 'no-auto-title' }
  }
  if (!isSessionLive(deps.ctx, row.sessionId)) {
    return { outcome: 'skipped', title: autoTitle, state: row.state, reason: 'session-not-live' }
  }
  return applySessionTitle(deps, {
    sessionId: input.sessionId,
    workspaceKey: workspace,
    kind,
    explicitTitle: autoTitle,
    mode: 'reset',
    force: true,
    defer: input.defer,
    source: 'reset',
  })
}
