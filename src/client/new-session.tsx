/**
 * New-session entry (派发改回卡片, requirement ①): the shell's 新建会话 control
 * now opens THIS plugin's panel on its dispatch card instead of a modal choice
 * layer (the 中枢会话 / 话题集会话 dialog this module used to render).
 *
 * Mounted in `shell.overlay` (a global render slot) because this shell exposes
 * no sidebar "new session action" slot to hook into — the verified sidebar slot
 * vocabulary is sidebar.panellist / sidebar.session.row.leading /
 * sidebar.workspaces.session.row.action / sidebar.footer.action. The component
 * therefore installs a capture-phase document listener and intercepts the click
 * on the shell's 新建会话 control by its accessible name (aria-label / title /
 * text). If that label is renamed upstream the listener never matches, nothing
 * is prevented, and the shell's default plain new session keeps working — the
 * failure mode is a missing interception, never a dead button.
 *
 * Why no dialog: the dispatch card already lives in the panel (composerView:
 * task text, workspace / Agent preset / model / permission, topic-set chips,
 * ＋新话题集, 开始对话 / 仅创建会话, Ctrl/Cmd+Enter, in-place receipt), and a
 * second copy in a modal drifted from it. So the click only (1) asks the host
 * layout service to open the SuperMemory panel in the main column — the same
 * call the plugin-manager launcher makes — and (2) broadcasts the
 * open-dispatch signal, which switches an already-mounted panel page back to
 * the hub tab. Degradation is explicit: without the layout service the click is
 * NOT prevented, so the shell's own new-session behaviour runs untouched; an
 * asynchronous selectPanel failure falls back to uiWorkspace.startSession().
 * @module supermemory/client/new-session
 */
import { useEffect, type ReactElement } from 'react'
import { broadcastOpenDispatch } from './open-dispatch.ts'

export interface NewSessionChoiceProps {
  /** Locale-bound translator injected by the shell slot owner (kept for the slot contract; the layer renders no text). */
  t?: (key: string, params?: Record<string, string | number>) => string
  /**
   * Open the SuperMemory panel in the shell's main column. Returns false when
   * the host layout service is unavailable, so the caller lets the shell's own
   * new-session behaviour run instead of swallowing the click.
   */
  selectPanel?: () => boolean
}

/**
 * The shell's New-session control, in the shipped zh and en dictionaries plus
 * the plausible variants. Matched against aria-label + title + textContent.
 */
const NEW_SESSION_CONTROL = /(新建|新的?)\s*会话|新建对话|新对话|new\s+(session|chat|conversation)/i

/** Whether an accessible name/value describes the shell's New-session control. */
function isNewSessionControl(value: string): boolean {
  if (!value) return false
  return NEW_SESSION_CONTROL.test(value)
}

/** The New-session entry: an interceptor that renders nothing. */
export function NewSessionChoice(props: NewSessionChoiceProps): ReactElement | null {
  const selectPanel = props.selectPanel
  // Capture-phase interception of the shell's New-session control. Capture runs
  // before any bubble handler, so stopping propagation here keeps the shell from
  // creating its plain session behind the panel we are about to open.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onCapture = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      // Our own panel must never re-trigger the layer: its 「＋ 新中枢会话」
      // button and every in-panel control already act locally.
      if (target.closest('[data-sm-panel]') !== null) return
      const control = target.closest('button, [role="button"], a')
      if (control === null) return
      const name = [
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
        control.textContent,
      ].filter((value): value is string => typeof value === 'string').join(' ')
      if (!isNewSessionControl(name)) return
      // The host layout service decides: unavailable (older shell) means no
      // preventDefault here, and the shell's default new session keeps working.
      if (typeof selectPanel !== 'function' || !selectPanel()) return
      event.preventDefault()
      event.stopPropagation()
      broadcastOpenDispatch()
    }
    document.addEventListener('click', onCapture, true)
    return () => document.removeEventListener('click', onCapture, true)
  }, [selectPanel])
  return null
}
