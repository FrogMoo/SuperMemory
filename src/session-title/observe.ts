/**
 * R59: the session-title observer — the ONLY automatic naming entry.
 *
 * Two host events matter:
 *   - `user/message` (source.kind empty/user): the FIRST user message of a
 *     provisional hub finalizes its name ONCE;
 *   - `session/title`: tells the service whether the host title still matches
 *     our intent, was reset to a neutral name, or was renamed by somebody else
 *     (a human in the host GUI) — the latter locks the session.
 *
 * Every host write initiated here is DEFERRED out of the event-publication
 * stack ({@link deferTitleTask}); writing inline is forbidden by the host
 * (`session append cannot reenter while another append is being published`),
 * which is exactly how the R43 hook lost every write.
 * @module supermemory/session-title/observe
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLike } from '../events.ts'
import type { UserMessageLike } from '../events.ts'
import { deferTitleTask } from './defer.ts'
import { applySessionTitle, takeOwnWrite } from './gate.ts'
import { reconcileSessionTitle } from './reconcile.ts'
import { hubRecord, ensureTitleRow, mirrorHubTitle, patchTitleRow, titleRow } from './state.ts'
import { isNeutralTitle } from './policy.ts'
import type { TitleDeps } from './types.ts'
import type { SessionTitleRow } from '../schema.ts'

/** Join one message's text blocks. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const row = block as { type?: string; text?: string }
    if (row.type === 'text' && typeof row.text === 'string' && row.text.trim()) parts.push(row.text)
  }
  return parts.join(String.fromCharCode(10)).trim()
}

/** Structural view of the session-query seam (first-message detection). */
interface SessionQueryLike {
  readSurface?(sessionId: string): Promise<{ events?: Array<{ type?: string; seq?: number }> }>
}

/**
 * The seq of a session's FIRST user message, or undefined when unreadable.
 * Used to avoid naming a session after a LATE message: a legacy hub whose
 * first message predates this service must not be renamed by today's prompt.
 */
export async function firstUserMessageSeq(ctx: Context | undefined, sessionId: string): Promise<number | undefined> {
  if (!ctx) return undefined
  let query: SessionQueryLike | undefined
  try {
    query = (ctx as unknown as { get?: (key: string) => unknown }).get?.('sessionQuery') as SessionQueryLike | undefined
  } catch {
    return undefined
  }
  if (!query || typeof query.readSurface !== 'function') return undefined
  try {
    const surface = await query.readSurface(sessionId)
    for (const event of surface?.events ?? []) {
      if (event?.type === 'user/message' && typeof event.seq === 'number') return event.seq
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Adopt a topic-bearing host title we did not write (no rename, just state). */
async function adoptHostTitle(deps: TitleDeps, row: SessionTitleRow | undefined, sessionId: string, title: string, seq?: number): Promise<void> {
  const store = deps.store
  if (!store) return
  const base = row ?? (await ensureTitleRow(store, { sessionId }))
  await patchTitleRow(store, sessionId, {
    state: 'named',
    desiredTitle: title,
    desiredFull: title,
    lastWrittenTitle: title,
    ...(typeof seq === 'number' ? { lastTitleSeq: seq } : {}),
    source: base.source || 'observer',
  })
  if ((base.kind ?? 'other') === 'hub') await mirrorHubTitle(store, sessionId, title, base.workspaceKey)
}

/** One `session/title` event (already deferred out of the publication stack). */
async function onHostTitle(deps: TitleDeps, sessionId: string, title: string, seq?: number): Promise<void> {
  const store = deps.store
  if (!store) return
  const row = titleRow(store, sessionId)
  if (!row) {
    // A hub the naming service has not seen yet (pre-R59 row): adopt the host
    // title so later automatic events never fight it.
    const record = hubRecord(store, sessionId)
    if (!record) return
    if (isNeutralTitle(title, record.workspaceKey)) return
    await adoptHostTitle(deps, undefined, sessionId, title, seq)
    return
  }
  if (takeOwnWrite(sessionId, title)) {
    if (row.lastWrittenTitle !== title || (typeof seq === 'number' && row.lastTitleSeq !== seq)) {
      await patchTitleRow(store, sessionId, {
        lastWrittenTitle: title,
        ...(typeof seq === 'number' ? { lastTitleSeq: seq } : {}),
      })
    }
    return
  }
  if (row.lastWrittenTitle === title) {
    if (typeof seq === 'number' && row.lastTitleSeq !== seq) await patchTitleRow(store, sessionId, { lastTitleSeq: seq })
    return
  }
  if (row.state === 'user-locked') {
    // A human renamed again (or a pending manual write landed): keep the lock,
    // adopt the new text as the intent so "restore auto naming" still knows it.
    if (row.desiredTitle !== title) {
      await patchTitleRow(store, sessionId, {
        desiredTitle: title,
        desiredFull: title,
        lastWrittenTitle: title,
        ...(typeof seq === 'number' ? { lastTitleSeq: seq } : {}),
        lockedReason: row.lockedReason || 'manual',
      })
    }
    if (row.kind === 'hub') await mirrorHubTitle(store, sessionId, title, row.workspaceKey)
    return
  }
  if (isNeutralTitle(title, row.workspaceKey)) {
    // The host fell back to a neutral name: re-assert our intent (a repair,
    // not a rename). The gate defers again, so this is safe from a listener.
    if (row.desiredTitle && !isNeutralTitle(row.desiredTitle, row.workspaceKey)) {
      deps.logger.info('supermemory: host title of ' + sessionId + ' went neutral; re-asserting 「' + row.desiredTitle + '」')
      await applySessionTitle(deps, {
        sessionId,
        kind: row.kind,
        workspaceKey: row.workspaceKey,
        explicitTitle: row.desiredTitle,
        source: 'reconcile',
        force: true,
        defer: true,
      })
    }
    return
  }
  // A topic-bearing title the plugin did not write → a human renamed the
  // session outside the plugin. Automatic naming stops for it.
  await patchTitleRow(store, sessionId, {
    state: 'user-locked',
    desiredTitle: title,
    desiredFull: title,
    lastWrittenTitle: title,
    ...(typeof seq === 'number' ? { lastTitleSeq: seq } : {}),
    lockedReason: 'external-rename',
  })
  if (row.kind === 'hub') await mirrorHubTitle(store, sessionId, title, row.workspaceKey)
  deps.logger.info('supermemory: session ' + sessionId + ' renamed outside the plugin; auto-naming stops')
}

/** One first-user-message event (already deferred). */
async function onUserMessage(deps: TitleDeps, sessionId: string, seq: number, text: string): Promise<void> {
  const store = deps.store
  if (!store) return
  const row = titleRow(store, sessionId)
  const record = hubRecord(store, sessionId)
  if (!row && !record) return
  // A deferred row (a host write that failed while the session was cold) is
  // retried here: the first message is the only chance to finalize a hub.
  if (row && (row.state === 'user-locked' || row.state === 'named')) return
  const kind = row?.kind ?? 'hub'
  if (kind !== 'hub') return
  // A LATE message must not name a legacy hub: only the session's first user
  // message may finalize a provisional name.
  const firstSeq = await firstUserMessageSeq(deps.ctx, sessionId)
  const isFirst = firstSeq === undefined ? row?.state === 'provisional' : firstSeq === seq
  if (!isFirst) {
    // Adopt the durable mirror title when the host still carries a neutral
    // name (the pre-R59 broken-hook state), without renaming to today's prompt.
    const mirror = String(record?.title ?? '').trim()
    if (mirror && !isNeutralTitle(mirror, record?.workspaceKey ?? row?.workspaceKey ?? '')) {
      await applySessionTitle(deps, {
        sessionId,
        kind: 'hub',
        workspaceKey: record?.workspaceKey ?? row?.workspaceKey,
        explicitTitle: mirror,
        source: 'migration',
        defer: true,
      })
    }
    return
  }
  await applySessionTitle(deps, {
    sessionId,
    kind: 'hub',
    workspaceKey: row?.workspaceKey || record?.workspaceKey || '',
    topicText: text,
    source: 'first-message',
    defer: true,
  })
}

/**
 * Attach the observer (once per plugin load). Returns the disposer.
 *
 * The listener only SCHEDULES work: the host forbids writes while it publishes
 * an event, so every handler runs after a microtask boundary.
 */
export function attachSessionTitleObserver(deps: TitleDeps): () => void {
  const ctx: Context | undefined = deps.ctx
  if (!ctx || typeof ctx.on !== 'function' || !deps.store) return () => {}
  // One retry per session per plugin load (the migration marker keeps the
  // durable pending set; this is only the in-process fast path).
  const retried = new Set<string>()
  return ctx.on('session/event', (session: { id?: unknown }, event: SessionEventLike) => {
    const sessionId = String(session?.id ?? '')
    if (!sessionId) return
    // R59 Phase 1b: the first activity of a DEFERRED (cold migration) row
    // retries its stored intent; the write is deferred out of this stack and
    // the gate settles the migration pending id on success.
    if (!retried.has(sessionId)) {
      const pendingRow = titleRow(deps.store, sessionId)
      if (pendingRow?.state === 'deferred') {
        retried.add(sessionId)
        void deferTitleTask(() => reconcileSessionTitle(deps, sessionId, { reason: 'first-event', defer: true })).catch((error) => {
          deps.logger.warn('supermemory: deferred title retry failed for ' + sessionId + ': ' + String(error).slice(0, 160))
        })
      }
    }
    if (event?.type === 'user/message') {
      const data = event.data as UserMessageLike | undefined
      const kind = data?.source?.kind
      if (kind && kind !== 'user') return
      const text = contentText(data?.content)
      if (!text.trim()) return
      void deferTitleTask(() => onUserMessage(deps, sessionId, event.seq, text)).catch((error) => {
        deps.logger.warn('supermemory: first-message naming failed for ' + sessionId + ': ' + String(error).slice(0, 160))
      })
      return
    }
    if (event?.type === 'session/title') {
      const data = event.data as { title?: unknown } | undefined
      const title = typeof data?.title === 'string' ? data.title.trim() : ''
      if (!title) return
      void deferTitleTask(() => onHostTitle(deps, sessionId, title, event.seq)).catch((error) => {
        deps.logger.warn('supermemory: title observer failed for ' + sessionId + ': ' + String(error).slice(0, 160))
      })
    }
  })
}
