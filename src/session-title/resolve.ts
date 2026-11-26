/**
 * R59: the display-layer title resolver.
 *
 * The host title is the only authority for what the GUI shows, but it can be
 * NEUTRAL (`新会话`) for a session whose durable mirror already carries the
 * topic — the exact state the pre-R59 broken hook left behind. Every in-plugin
 * surface (branch cards "来自 …", the panel chat header, the rail, the web
 * console) must resolve through this module so they agree.
 *
 * Order:
 *   1. the host title, when it carries a topic;
 *   2. the naming row's intent (desired/last written), when topic-bearing;
 *   3. the positive hub record's mirror title;
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
  const intent = usable(row?.desiredTitle, workspace) || usable(row?.lastWrittenTitle, workspace)
  if (intent) return intent
  const mirror = usable(hubRecord(store, sessionId)?.title, workspace)
  if (mirror) return mirror
  return memberTitle(store, sessionId)
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
