/**
 * New-session entry (需求①: 「新会话」 must have an immediate, visible effect).
 *
 * The click on the shell's 新建会话 control (sidebar header / sidebar new-session
 * row / a workspace row's 新会话 action) now CREATES a hub session right away
 * with host defaults — current workspace, default agent preset / model /
 * permission, no topic set (a hub session owns no set; the panel's dispatch
 * card still picks the sticky/auto set when dispatching) — and hands the
 * receipt to the panel, which renders it in place (message + session id +
 * 「打开会话」). No choice dialog, no type picker, no waiting for a form: one
 * click, one session.
 *
 * Why an interceptor instead of a slot: this shell exposes no "new session
 * action" slot to replace (the verified vocabulary is sidebar.panellist /
 * sidebar.session.row.leading / sidebar.workspaces.session.row.action /
 * sidebar.footer.action — the sidebar's own 新建会话 row renders
 * `sidebar.session.action`, which ADDS a control instead of replacing it), so
 * the entry lives in `shell.overlay` (a global render slot) and installs a
 * capture-phase document listener that matches the control by accessible name
 * (aria-label / title / text). Capture runs before the shell's own bubble
 * handler, so a matched click never creates the shell's plain session behind
 * the panel.
 *
 * Degradation is explicit and never a dead button: without the panel api, a
 * resolvable workspace, or a matching label, the click is NOT prevented and the
 * shell's own new-session flow runs untouched. If the session was created but
 * the panel could not be revealed (no layout service), the created session is
 * opened directly so the click still has a visible result.
 *
 * R43 ①: two surfaces are skipped because they are OUR OWN and merely contain
 * matching text — the panel (`[data-sm-panel]`, whose in-panel controls act
 * locally) and a SuperMemory chat card (`[data-supermemory-card]`), whose head
 * button's accessible name is 「来自 <来源会话> 的执行请求」 and therefore
 * matches the pattern whenever the source session is named 「新会话」.
 * @module supermemory/client/new-session
 */
import { useEffect, type ReactElement } from 'react'
import { publishHubReceipt } from './open-dispatch.ts'

/** The slice of the panel api the entry needs (host `createHubSession`). */
export interface NewSessionApi {
  createHubSession(
    cwd: string,
    options?: Record<string, unknown>,
    firstMessage?: string,
  ): Promise<{ status: string; message: string; id?: string }>
  /** Open a created session in the shell (fallback when the panel cannot open). */
  openSession?(sessionId: string): void
  /** Start the shell's own plain new session (last-resort fallback). */
  startSession?(): void
}

export interface NewSessionChoiceProps {
  /** Locale-bound translator injected by the shell slot owner (no text is rendered here). */
  t?: (key: string, params?: Record<string, string | number>) => string
  /** Panel api (host createHubSession + the two navigation fallbacks). */
  api?: NewSessionApi
  /** Current workspace path (main-view session cwd, else the first workspace). */
  cwd?: () => string
  /**
   * Open the SuperMemory panel in the shell's main column. Returns false when
   * the host layout service is unavailable, so the caller can fall back to
   * opening the created session directly.
   */
  selectPanel?: () => boolean
}

/**
 * The shell's New-session control, in the shipped zh and en dictionaries plus
 * the plausible variants (the sidebar uses 新建会话 / New session, a workspace
 * row uses 在“…”中新建会话).
 */
const NEW_SESSION_CONTROL = /(新建|新的?)\s*会话|新建对话|新对话|new\s+(session|chat|conversation)/i

/** Whether an accessible name/value describes the shell's New-session control. */
function isNewSessionControl(value: string): boolean {
  if (!value) return false
  if (PER_WORKSPACE_ACTION.test(value.trim())) return false
  return NEW_SESSION_CONTROL.test(value)
}

/**
 * A workspace ROW's own action ("在“X”中新建会话" / New session in "X"): that
 * control belongs to one workspace the overlay cannot see, so it keeps the
 * shell's own behaviour — intercepting it here would create the session in the
 * MAIN-VIEW workspace instead of the clicked one. Only the global 新建会话
 * control (sidebar header / new-session row / brand) is ours.
 */
const PER_WORKSPACE_ACTION = /^在.*中\s*(新建|新的?)\s*(会话|对话)/

/** The New-session entry: an interceptor that renders nothing. */
export function NewSessionChoice(props: NewSessionChoiceProps): ReactElement | null {
  const api = props.api
  const cwd = props.cwd
  const selectPanel = props.selectPanel
  // Capture-phase interception of the shell's New-session control. Capture runs
  // before any bubble handler, so a matched click never creates the shell's
  // plain session behind the panel we are about to open.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onCapture = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      // Our own panel must never re-trigger the entry: its 「＋ 新中枢会话」
      // button and every in-panel control already act locally.
      if (target.closest('[data-sm-panel]') !== null) return
      // R43 ①: a SuperMemory chat card lives in the shell's CONVERSATION area,
      // not inside the panel, so the guard above never covered it. Its head is
      // a <button> whose accessible name is 「来自 <来源会话> 的执行请求 …」 —
      // and a hub that still carries the neutral 「新会话」 name (or a task
      // that merely mentions 新建会话) makes that name match the New-session
      // pattern below, so collapsing/expanding the card CREATED a hub session
      // and opened the panel: the user's 「点卡片跳到新建」. The card marks its
      // own surface (data-supermemory-card); skipping it keeps the card's own
      // click handling intact.
      if (target.closest('[data-supermemory-card]') !== null) return
      const control = target.closest('button, [role="button"], a')
      if (control === null) return
      const name = [
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
        control.textContent,
      ].filter((value): value is string => typeof value === 'string').join(' ')
      if (!isNewSessionControl(name)) return
      // No api or no workspace: leave the click alone, the shell's own
      // new-session flow (with its workspace picker) is the honest fallback.
      if (typeof api?.createHubSession !== 'function') return
      const workspace = typeof cwd === 'function' ? String(cwd() ?? '') : ''
      if (!workspace) return
      event.preventDefault()
      event.stopPropagation()
      // Open the panel FIRST so the receipt has somewhere to render; a false
      // return (older shell without the layout service) is not fatal — the
      // created session is opened directly below.
      const panelOpened = typeof selectPanel === 'function' && selectPanel() === true
      void api.createHubSession(workspace, {}, '')
        .then((result) => {
          if (result && result.status === 'ok' && result.id) {
            publishHubReceipt({ id: result.id, message: result.message, kind: 'hub' })
            if (!panelOpened) api.openSession?.(result.id)
            return
          }
          publishHubReceipt({
            id: '',
            message: result?.message || '创建中枢会话失败',
            kind: 'hub',
          })
          if (!panelOpened) api.startSession?.()
        })
        .catch((error) => {
          publishHubReceipt({
            id: '',
            message: '创建中枢会话失败：' + String(error instanceof Error ? error.message : error),
            kind: 'hub',
          })
          if (!panelOpened) api.startSession?.()
        })
    }
    document.addEventListener('click', onCapture, true)
    return () => document.removeEventListener('click', onCapture, true)
  }, [api, cwd, selectPanel])
  return null
}
