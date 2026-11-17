/**
 * Sidebar session-row branch badge (GUI 问题③): marks the sessions that belong to
 * a SuperMemory topic set, so a hub session and the branch sessions it dispatched
 * to are visually distinguishable in the left sidebar.
 *
 * Seated in `sidebar.session.row.leading` — the same slot the host package
 * dsh-client-ui-schedule uses for its clock mark (id 'schedule-mark', order 10).
 * The shell renders that cell only for a non-archived, non-blank row whose primary
 * status is idle; a busy/approval row keeps its own status dot in the same cell
 * (upstream gating in dsh-client-ui-workspace's Rows component, verified
 * 2026-11-18: `!row.archived && !row.blank && (showStatus ? dots : renderSlot(...))`).
 *
 * R19 需求③④: two kinds are rendered —
 * - `branch` (a plugin-minted `branch-*`/`fork-*` session, or a fork member):
 *   the work branch badge. A fresh dispatch is recorded as `kind:'root'`, so
 *   the id prefix — not the member kind — decides this case;
 * - `hub-set` (a HOST session that is the set's root member, e.g. the session
 *   `createTopicSetSession` created): a 「话题集」 badge carrying the set name,
 *   so a topic-set hub is no longer mislabelled as a branch (the R18
 *   conflation) and is not left unmarked.
 * A plain hub session renders nothing. The badge is a pure projection of host
 * membership and never fabricates one when the read fails.
 * @module supermemory/client/session-badge
 */
import { createElement as h, useEffect, useState, type ReactElement } from 'react'
import type { PanelApi, SessionBadge } from './panel-page.tsx'

/** Props of the sidebar branch badge (shell-provided sessionId + locale t). */
export interface SupermemorySessionBadgeProps {
  /** The session this sidebar row shows (provided by the slot renderer). */
  sessionId: string
  /** Host panel API (remote namespace wrapper) built in apply(). */
  api: PanelApi
  /** Locale-bound translator injected by the shell slot owner. */
  t?: (key: string, params?: Record<string, string | number>) => string
}

const BADGE_CSS = [
  '.sm-sb-badge{display:inline-flex;align-items:center;gap:3px;flex:none;box-sizing:border-box;height:16px;padding:0 6px 0 4px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:10px;line-height:14px;opacity:.8;cursor:default;user-select:none;vertical-align:middle}',
  '.sm-sb-badge:hover{opacity:1}',
  '.sm-sb-badge[data-kind="hub-set"]{color:var(--dsw-alias-link,#7aaaff);border-color:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 45%,transparent)}',
  '.sm-sb-badge svg{display:block;flex:none}',
].join('\n')

let cssInstalled = false
function installCss(): void {
  if (cssInstalled || typeof document === 'undefined') return
  cssInstalled = true
  const style = document.createElement('style')
  style.setAttribute('data-plugin', 'dsh-supermemory')
  style.textContent = BADGE_CSS
  document.head.append(style)
}

/**
 * Module-level cache keyed by session id. Membership changes only when a topic
 * set gains/loses a member or is archived, and rows unmount while scrolling or
 * filtering, so one read per id keeps the sidebar cheap.
 *
 * R18 需求③ (根因): the old cache stored ANY successful answer forever. A session
 * that was a hub at read time stayed `{kind:'hub'}` in the cache even after it
 * became a topic-set branch (dispatch adds the member seconds later), so the
 * sidebar badge never appeared until a page refresh dropped the module. The fix
 * is asymmetric on purpose:
 * - `branch` is durable: membership is already true and only a real archive
 *   changes it (and a reload/re-scan re-reads it anyway);
 * - `hub` is a NEGATIVE observation with an 8 s TTL, so a newly joined branch
 *   shows up on the next row mount/refresh instead of staying invisible.
 */
interface BadgeCacheEntry {
  badge: SessionBadge
  at: number
}
const badgeCache = new Map<string, BadgeCacheEntry>()
/** Negative (`hub`) answers expire fast; a later dispatch may add the member. */
const HUB_BADGE_TTL_MS = 8000
/** Mounted rows subscribe here so invalidateBadge() updates them immediately. */
const listeners = new Set<() => void>()

function readBadgeCache(sessionId: string): SessionBadge | undefined {
  const entry = badgeCache.get(sessionId)
  if (!entry) return undefined
  if (entry.badge.kind === 'branch') return entry.badge
  return Date.now() - entry.at < HUB_BADGE_TTL_MS ? entry.badge : undefined
}

/**
 * Drop the cached membership for one session (or every session) and re-render
 * the mounted badges.
 *
 * Called after a panel hub refresh and after a dispatch receipt: both are
 * moments when a session may have just joined a topic set.
 */
export function invalidateBadge(sessionId?: string): void {
  if (sessionId) badgeCache.delete(sessionId)
  else badgeCache.clear()
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch { /* one broken row must not block the others */ }
  }
}

/**
 * Render the branch badge for one session row.
 * @returns the badge for a topic-set branch, null for a hub session.
 */
export function SupermemorySessionBadge(props: SupermemorySessionBadgeProps): ReactElement | null {
  installCss()
  // Defensive: a slot owner that does not bind the dictionary still renders
  // (keys shown raw) instead of throwing, like new-session.tsx.
  const t = typeof props.t === 'function' ? props.t : (key: string): string => key
  const { api, sessionId } = props
  const [badge, setBadge] = useState<SessionBadge | undefined>(() => readBadgeCache(sessionId))
  // Bumped by invalidateBadge(); forces the read effect to look again.
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const listener = (): void => {
      setBadge(readBadgeCache(sessionId))
      setRevision((value) => value + 1)
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [sessionId])
  useEffect(() => {
    let alive = true
    try {
      const cached = readBadgeCache(sessionId)
      if (cached !== undefined) {
        setBadge(cached)
        return () => { alive = false }
      }
      void api.sessionBadge(sessionId).then(
        (result) => {
          badgeCache.set(sessionId, { badge: result, at: Date.now() })
          if (alive) setBadge(result)
        },
        () => { /* an unreadable row stays unmarked: never fabricate a badge */ },
      )
    } catch {
      // A broken API surface must never take a sidebar row down.
    }
    return () => { alive = false }
  }, [api, sessionId, revision])
  if (!badge || (badge.kind !== 'branch' && badge.kind !== 'hub-set')) return null
  const isBranch = badge.kind === 'branch'
  // A press on the badge must not activate the session through the row own
  // click target; the host clock mark does the same.
  const stop = (event: { stopPropagation: () => void }): void => { event.stopPropagation() }
  const glyph = isBranch
    ? h('svg', {
        key: 'glyph', width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
      },
        h('path', { key: 'a', d: 'M6 3v12' }),
        h('circle', { key: 'b', cx: 18, cy: 6, r: 3 }),
        h('circle', { key: 'c', cx: 6, cy: 18, r: 3 }),
        h('path', { key: 'd', d: 'M18 9a9 9 0 0 1-9 9' }),
      )
    : h('svg', {
        key: 'glyph', width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
      },
        h('path', { key: 'a', d: 'M4 7a8 5 0 1 0 16 0 8 5 0 1 0-16 0' }),
        h('path', { key: 'b', d: 'M4 7v6a8 5 0 0 0 16 0V7' }),
      )
  return h('span', {
    key: 'badge',
    className: 'sm-sb-badge',
    'data-kind': badge.kind,
    title: isBranch
      ? t('badge.tip', { title: badge.topicSetTitle })
      : t('badge.hubSet.tip', { title: badge.topicSetTitle }),
    onClick: stop,
  },
    glyph,
    h('span', { key: 'text' }, isBranch ? t('badge.branch') : t('badge.hubSet')),
  )
}
