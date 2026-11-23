/**
 * Sidebar session-row badge (GUI 问题③, R31 需求②): marks the sessions this
 * plugin knows about, so a hub session, the branches it dispatched to and a
 * topic-set hub stay distinguishable in the left sidebar.
 *
 * Seated in `sidebar.session.row.trailing`. The host gates that cell by
 * `!row.blank` only (upstream in dsh-client-ui-workspace's Rows component:
 * the trailing `rowResting` span wraps the time label, the slot render and the
 * pin mark, all inside `{!row.blank && …}`), so the badge stays visible while
 * the session runs and in approval states. It USED to sit in
 * `sidebar.session.row.leading`, whose gate is
 * `!row.archived && !row.blank && (showStatus ? <SessionStatusDots/> : renderSlot(...))`
 * with `showStatus = primary status is not idle` — a busy row kept its status
 * dot in that cell and the badge disappeared (the 「运行中隐藏」 report). The
 * trailing slot has no other registrant in the host bundle (verified in
 * app.asar). Known limitation, unchanged by the move: a blank row (no first
 * message) renders neither cell, so a brand-new empty hub session shows no
 * badge until it has a message.
 *
 * R19 需求③④ + R31 需求②: four kinds are projected by the host
 * `sessionBadge()` and rendered here —
 * - `branch` (a plugin-minted `branch-*`/`fork-*` session, or a fork member):
 *   the work branch badge. A fresh dispatch is recorded as `kind:'root'`, so
 *   the id prefix — not the member kind — decides this case;
 * - `hub-set` (a HOST session that is the set's root member, e.g. the session
 *   `createTopicSetSession` created): a 「话题集」 badge carrying the set name,
 *   so a topic-set hub is no longer mislabelled as a branch (the R18
 *   conflation) and is not left unmarked;
 * - `hub` (R31 需求②: a host-native `session-*` id in no topic set): a
 *   「中枢」 badge — a plugin hub conversation is now visible in the sidebar
 *   instead of being an unmarked row;
 * - `none` (R31 需求②: a plugin branch that has not joined a set yet, or an
 *   id the plugin cannot classify): renders nothing.
 * The badge is a pure projection of host membership and id shape; it never
 * fabricates one when the read fails.
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
  // R31 需求②: 「中枢」用主题的 done/violet 色（亮 violet-600 / 暗 violet-400），
  // 与 hub-set 的 link 蓝明显区分，两种主题下都看得清。
  '.sm-sb-badge[data-kind="hub"]{color:var(--dsw-alias-state-done-primary,#8b5cf6);border-color:color-mix(in srgb,var(--dsw-alias-state-done-primary,#8b5cf6) 45%,transparent)}',
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
 * - every NEGATIVE observation expires with a short TTL — R31 需求② widened
 *   that set from `hub` to `hub` AND `none`, because both are "not a member
 *   YET": a `hub` becomes the set's root member (「话题集」 badge) moments
 *   after its set is created, and a `none` branch-* id gets its member row
 *   seconds after its dispatch. A cached negative must not outlive that race,
 *   or the badge stays missing/invisible until a page refresh.
 */
interface BadgeCacheEntry {
  badge: SessionBadge
  at: number
}
const badgeCache = new Map<string, BadgeCacheEntry>()
/** Negative (`hub`/`none`) answers expire fast; a later dispatch may add the member. */
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
 * Render the badge for one session row.
 * @returns the badge for a topic-set branch / topic-set hub / plugin hub,
 * null for an unclassified session (`none`) or an unreadable row.
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
  // R31 需求②: `none` (a branch with no set yet, an unclassifiable id) and a
  // failed read render nothing — an explicit "no badge", not a hub.
  if (!badge || badge.kind === 'none') return null
  const isBranch = badge.kind === 'branch'
  const isHub = badge.kind === 'hub'
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
    : isHub
      // R31 需求②: 「中枢」——辐射状小图标（中心点 + 向外射线），与分支的
      // 「一线两圆」和话题集的「储物袋」形状明确区分。
      ? h('svg', {
          key: 'glyph', width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true, focusable: false,
        },
          h('circle', { key: 'a', cx: 12, cy: 12, r: 2.4 }),
          h('path', { key: 'b', d: 'M12 3.2v2.6' }),
          h('path', { key: 'c', d: 'M12 18.2v2.6' }),
          h('path', { key: 'd', d: 'M3.2 12h2.6' }),
          h('path', { key: 'e', d: 'M18.2 12h2.6' }),
          h('path', { key: 'f', d: 'M5.8 5.8l1.9 1.9' }),
          h('path', { key: 'g', d: 'M16.3 16.3l1.9 1.9' }),
          h('path', { key: 'h', d: 'M18.2 5.8l-1.9 1.9' }),
          h('path', { key: 'i', d: 'M7.7 16.3l-1.9 1.9' }),
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
      : isHub
        ? t('badge.hub.tip')
        : t('badge.hubSet.tip', { title: badge.topicSetTitle }),
    onClick: stop,
  },
    glyph,
    h('span', { key: 'text' }, isBranch ? t('badge.branch') : isHub ? t('badge.hub') : t('badge.hubSet')),
  )
}
