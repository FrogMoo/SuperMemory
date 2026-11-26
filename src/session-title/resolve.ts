/**
 * R59: the display-layer title resolver.
 *
 * The host title is the only authority for what the GUI shows, but it can be
 * NEUTRAL (`新会话`) for a session whose durable mirror already carries the
 * topic — the exact state the pre-R59 broken hook left behind. Every in-plugin
 * surface (branch cards "来自 …", the panel chat header, the rail, the web
 * console) must resolve through this module so they agree.
 *
 * Order (R59 Phase 1b):
 *   1. the host title, when it carries a topic;
 *   2. the positive hub record's mirror title (a neutral host must not hide the
 *      topic the record already holds — the exact pre-R59 broken state);
 *   3. the naming row's intent (desired / last written), when topic-bearing;
 *   4. the topic-set member title;
 *   5. undecided ('' — the caller keeps its own id-tail/neutral fallback).
 * @module supermemory/session-title/resolve
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from '../store.ts'
import type { TopicSet } from '../schema.ts'
import { readHostTitle } from './host.ts'
import { isNeutralTitle } from './policy.ts'
import { hubRecord, titleRow } from './state.ts'

/** A topic-bearing, non-legacy title, trimmed; '' otherwise. */
function usable(title: string | undefined, workspace: string): string {
  const value = String(title ?? '').trim()
  if (!value) return ''
  if (isNeutralTitle(value, workspace)) return ''
  return value
}

/** The recorded title of one topic-set member, if any. */
function memberTitle(store: Store | undefined, sessionId: string): string {
  if (!store || !sessionId) return ''
  try {
    for (const [, topicSet] of store.topicsets.entries() as IterableIterator<[string, TopicSet]>) {
      const member = (topicSet.members ?? []).find((row) => row.sessionId === sessionId)
      if (member && typeof member.title === 'string' && member.title.trim()) return member.title.trim()
    }
  } catch {
    // A partly materialized table only loses the fallback.
  }
  return ''
}

/**
 * Best non-neutral title of one session (host → naming row → hub mirror →
 * topic-set member). Returns '' when nothing topic-bearing is known.
 */
export function resolveSessionTitle(ctx: Context | undefined, store: Store | undefined, sessionId: string): string {
  if (!sessionId) return ''
  const row = titleRow(store, sessionId)
  const workspace = row?.workspaceKey ?? hubRecord(store, sessionId)?.workspaceKey ?? ''
  const host = usable(readHostTitle(ctx, sessionId)?.title, workspace)
  if (host) return host
  // R59 Phase 1b: the mirror is the durable copy of the host title; when the
  // host is neutral/legacy it is the only topic-bearing authority we have.
  const mirror = usable(hubRecord(store, sessionId)?.title, workspace)
  if (mirror) return mirror
  const intent = usable(row?.desiredTitle, workspace) || usable(row?.lastWrittenTitle, workspace)
  if (intent) return intent
  // NO topic-set member fallback here: hub surfaces (rail/panel/web console) must
  // fall through to the caller's own fallback, exactly like before R59. Cards use
  // sessionTitleOf below, which adds the durable member label for branches.
  return ''
}

/**
 * Structural view of the title-read seam (a host Context or a test double).
 * Session titles are READ-ONLY here; every write stays in gate.ts.
 */
export interface TitleReadHost {
  get?(name: string): unknown
  sessions?: { get(id: string): unknown }
}

/**
 * R32 需求③ / R59: the best display title of a source session for a card or a
 * chat header. Delegates to {@link resolveSessionTitle} so a neutral host title
 * falls back to the hub mirror instead of showing 「新会话」.
 */
export function sessionTitleOf(ctx: TitleReadHost | undefined, store: Store | undefined, sessionId: string): string {
  const resolved = resolveSessionTitle(ctx as unknown as Context | undefined, store, sessionId)
  return resolved || memberTitle(store, sessionId)
}

/** Explicit alias for the display-layer entry (same resolution order). */
export function resolveTitle(ctx: Context | undefined, store: Store | undefined, sessionId: string): string {
  return resolveSessionTitle(ctx, store, sessionId)
}

/**
 * Display title for a surface that always needs something: the resolved title,
 * else the raw host title (even when neutral — it is what the user sees), else
 * the caller's fallback (usually the id tail or a locale label).
 */
export function resolveDisplayTitle(
  ctx: Context | undefined,
  store: Store | undefined,
  sessionId: string,
  fallback = '',
): string {
  const resolved = resolveSessionTitle(ctx, store, sessionId)
  if (resolved) return resolved
  const host = readHostTitle(ctx, sessionId)?.title
  return String(host ?? '').trim() || fallback
}
