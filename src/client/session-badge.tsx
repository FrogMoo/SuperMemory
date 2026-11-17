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
 * The badge is a pure projection of host topic-set membership: it reads
 * `supermemoryPanel.sessionBadge(sessionId)` once per mount (module-level cache),
 * renders nothing for a hub session, and never fabricates a badge when the read
 * fails.
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
  '.sm-sb-badge{display:inline-flex;align-items:center;gap:3px;flex:none;box-sizing:border-box;height:16px;padding:0 6px 0 4px;border-radius:99px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg-soft,#222228);color:var(--dsh-color-text,#c9c9d1);font-size:10px;line-height:14px;opacity:.8;cursor:default;user-select:none;vertical-align:middle}',
  '.sm-sb-badge:hover{opacity:1}',
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
 */
const badgeCache = new Map<string, SessionBadge>()

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
  const [badge, setBadge] = useState<SessionBadge | undefined>(() => badgeCache.get(sessionId))
  useEffect(() => {
    let alive = true
    const cached = badgeCache.get(sessionId)
    if (cached !== undefined) {
      setBadge(cached)
      return () => { alive = false }
    }
    void api.sessionBadge(sessionId).then(
      (result) => {
        badgeCache.set(sessionId, result)
        if (alive) setBadge(result)
      },
      () => { /* an unreadable row stays unmarked: never fabricate a badge */ },
    )
    return () => { alive = false }
  }, [api, sessionId])
  if (!badge || badge.kind !== 'branch') return null
  return h('span', {
    key: 'badge',
    className: 'sm-sb-badge',
    title: t('badge.tip', { title: badge.topicSetTitle }),
    // A press on the badge must not activate the session through the row own
    // click target; the host clock mark does the same.
    onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation() },
  },
    h('svg', {
      key: 'glyph', width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    },
      h('path', { key: 'a', d: 'M6 3v12' }),
      h('circle', { key: 'b', cx: 18, cy: 6, r: 3 }),
      h('circle', { key: 'c', cx: 6, cy: 18, r: 3 }),
      h('path', { key: 'd', d: 'M18 9a9 9 0 0 1-9 9' }),
    ),
    h('span', { key: 'text' }, t('badge.branch')),
  )
}
