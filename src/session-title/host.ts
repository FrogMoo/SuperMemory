/**
 * R59: the ONLY module that touches the host session title.
 *
 * Host contract (verified against dsh-session / dsh-session-title sources):
 *   - `ctx.sessionTitle.rename(session, title)` appends `session/title` with
 *     `source:{kind:'user'}` and PINS the session (the host's own LLM titler
 *     then never runs);
 *   - rename requires a LIVE session (`ctx.sessions.get(id) === session`);
 *   - the host truncates every title to `maxTitleBytes` (80) silently;
 *   - a session append inside a `session/event` listener throws
 *     `session append cannot reenter while another append is being published`,
 *     so callers must defer (see gate.deferTitleTask).
 *
 * This module exposes the read + write primitives; policy owns composition and
 * the gate owns WHEN to write.
 * @module supermemory/session-title/host
 */
import type { Context } from '@deepseek-ai/cordis'

/** Structural view of the host session title service. */
interface SessionTitleServiceLike {
  get?(session: unknown): { title?: string; eventSeq?: number; messageSeqs?: readonly number[]; source?: { kind?: string } } | undefined
  rename?(session: unknown, title: string): unknown
}

/** Structural view of a live session (only what the title path needs). */
export interface HostSessionLike {
  id?: string
  seq?: number
  append?(type: string, data: unknown): unknown
}

/** What the host currently holds for one session. */
export interface HostTitleSnapshot {
  title: string
  /** Seq of the accepted `session/title` event (when the host reports it). */
  seq?: number
  /** `user` for a plugin/user rename; `fallback`/`provider` for host titling. */
  sourceKind?: string
}

/** Result of one host write attempt. */
export interface HostWriteResult {
  outcome: 'host' | 'fallback' | 'none'
  /** The title the host actually accepted (may differ: the host re-normalizes). */
  accepted?: string
  /** Why the write failed (kept for diagnostics, never swallowed silently). */
  error?: string
  /** True when the failure is the re-entrant-append rule. */
  reentrant?: boolean
}

function serviceOf<T>(ctx: Context | undefined, name: string): T | undefined {
  if (!ctx) return undefined
  try {
    return (ctx as unknown as { get?: (key: string) => unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/** The live session object, or undefined when the session is not attached. */
export function hostSession(ctx: Context | undefined, sessionId: string): HostSessionLike | undefined {
  if (!ctx || !sessionId) return undefined
  try {
    const sessions = (ctx as unknown as { sessions?: { get?(id: string): unknown } }).sessions
    return sessions?.get?.(sessionId) as HostSessionLike | undefined
  } catch {
    return undefined
  }
}

/** Is the session attached (so a rename can land)? */
export function isSessionLive(ctx: Context | undefined, sessionId: string): boolean {
  return hostSession(ctx, sessionId) !== undefined
}

/**
 * Read the latest folded title of one live session. Cold sessions are invisible
 * here by design (the host folds only live logs); use `sessionQuery` for cold
 * reads.
 */
export function readHostTitle(ctx: Context | undefined, sessionId: string): HostTitleSnapshot | undefined {
  const session = hostSession(ctx, sessionId)
  if (!session) return undefined
  const service = serviceOf<SessionTitleServiceLike>(ctx, 'sessionTitle')
  if (!service || typeof service.get !== 'function') return undefined
  try {
    const snapshot = service.get(session)
    const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
    if (!title) return undefined
    return {
      title,
      ...(typeof snapshot?.eventSeq === 'number' ? { seq: snapshot.eventSeq } : {}),
      ...(snapshot?.source && typeof snapshot.source.kind === 'string' ? { sourceKind: snapshot.source.kind } : {}),
    }
  } catch {
    return undefined
  }
}

/** Normalize one error into a one-line diagnostic. */
export function errorText(error: unknown): string {
  try {
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      return String((error as { message: string }).message).slice(0, 300)
    }
    return String(error).slice(0, 300)
  } catch {
    return 'unknown error'
  }
}

/** Is this failure the host's re-entrant append guard? */
export function isReentrantError(error: unknown): boolean {
  return /cannot reenter/i.test(errorText(error))
}

/**
 * Write one host title.
 *
 * Tries `sessionTitle.rename` first (the host's own normalization + pin), then
 * the exact `session/title` log append as the degraded path. NEVER throws: a
 * failed write is reported (with its reason) so the gate can defer/retry and
 * the panel can show it.
 */
export function writeHostTitle(ctx: Context | undefined, sessionId: string, title: string): HostWriteResult {
  const clean = String(title ?? '').trim()
  if (!clean) return { outcome: 'none', error: 'empty title' }
  const session = hostSession(ctx, sessionId)
  if (!session) return { outcome: 'none', error: 'session-not-live' }
  const service = serviceOf<SessionTitleServiceLike>(ctx, 'sessionTitle')
  if (service && typeof service.rename === 'function') {
    try {
      service.rename(session, clean)
      const accepted = readHostTitle(ctx, sessionId)
      return { outcome: 'host', accepted: accepted?.title ?? clean }
    } catch (error) {
      if (isReentrantError(error)) {
        return { outcome: 'none', error: errorText(error), reentrant: true }
      }
      // Fall through to the log-append path (host service present but refused).
    }
  }
  try {
    const append = session.append
    if (typeof append === 'function') {
      append.call(session, 'session/title', {
        title: clean,
        messageSeqs: [],
        source: { kind: 'user' },
      })
      const accepted = readHostTitle(ctx, sessionId)
      return { outcome: 'fallback', accepted: accepted?.title ?? clean }
    }
  } catch (error) {
    return {
      outcome: 'none',
      error: errorText(error),
      ...(isReentrantError(error) ? { reentrant: true } : {}),
    }
  }
  return { outcome: 'none', error: 'no-title-seam' }
}
