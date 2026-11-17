/**
 * New-session choice layer (R3): offers 中枢会话 (the shell's plain new session)
 * or 话题集会话 (a fresh session bound to one or more topic sets, created
 * host-side and opened immediately).
 *
 * Mounted in `shell.overlay` (a global render slot) because this shell exposes
 * no sidebar "new session action" slot to hook into — the verified sidebar slot
 * vocabulary is sidebar.panellist / sidebar.session.row.leading /
 * sidebar.workspaces.session.row.action / sidebar.footer.action. The component
 * therefore installs a capture-phase document listener and intercepts the click
 * on the shell's 新建会话 control by its accessible name (aria-label / title /
 * text). If that label is renamed upstream the listener never matches, nothing
 * is prevented, and the shell's default plain new session keeps working — the
 * failure mode is a missing dialog, never a dead button.
 * @module supermemory/client/new-session
 */
import { createElement as h, useCallback, useEffect, useState, type ReactElement } from 'react'
import type { PanelApi, TopicSetView } from './panel-page.tsx'

export interface NewSessionChoiceProps {
  /** Locale-bound translator injected by the shell slot owner. */
  t: (key: string, params?: Record<string, string | number>) => string
  /** Host panel API (remote namespace wrapper). */
  api: PanelApi
  /** Resolve the workspace path the new session should be created in. */
  cwd?: () => string
}

const CHOICE_CSS = [
  '.sm-ns-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}',
  '.sm-ns-card{width:380px;max-width:92vw;max-height:70vh;overflow:auto;border-radius:12px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#1c1c20);color:var(--dsh-color-text,#e8e8ea);padding:16px;font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,.5)}',
  '.sm-ns-card h2{margin:0 0 12px;font-size:15px}',
  '.sm-ns-option{display:flex;gap:8px;align-items:flex-start;padding:10px;border:1px solid var(--dsh-color-border,#2c2c31);border-radius:8px;margin-bottom:8px;cursor:pointer}',
  '.sm-ns-option[data-active="true"]{border-color:var(--dsh-color-primary,#5b8def)}',
  '.sm-ns-option .sm-ns-name{font-weight:600}',
  '.sm-ns-option .sm-ns-desc{opacity:.6;font-size:11px;margin-top:2px}',
  '.sm-ns-list{max-height:180px;overflow:auto;border:1px solid var(--dsh-color-border,#2c2c31);border-radius:8px;padding:6px;margin:8px 0}',
  '.sm-ns-check{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;cursor:pointer}',
  '.sm-ns-check:hover{background:var(--dsh-color-bg-soft,#222228)}',
  '.sm-ns-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}',
  '.sm-ns-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#222228);color:inherit;cursor:pointer;font-size:12px}',
  '.sm-ns-btn[data-variant="primary"]{background:var(--dsh-color-primary,#3d6fd8);border-color:transparent;color:#fff}',
  '.sm-ns-btn:disabled{opacity:.45;cursor:default}',
  '.sm-ns-input{width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#121215);color:inherit;font-size:12px;font-family:inherit}',
  '.sm-ns-error{color:#e0736a;font-size:12px;margin-top:6px}',
].join('\n')

let cssInstalled = false
function installCss(): void {
  if (cssInstalled || typeof document === 'undefined') return
  cssInstalled = true
  const style = document.createElement('style')
  style.setAttribute('data-plugin', 'dsh-supermemory')
  style.textContent = CHOICE_CSS
  document.head.append(style)
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

/** The New-session choice layer. */
export function NewSessionChoice(props: NewSessionChoiceProps): ReactElement | null {
  installCss()
  // Defensive: a slot owner that does not bind the locale dictionary still
  // renders the layer (keys shown raw) instead of throwing on the first click.
  const t = typeof props.t === 'function' ? props.t : (key: string): string => key
  const { api } = props
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<'hub' | 'topic'>('hub')
  const [topicSets, setTopicSets] = useState<TopicSetView[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const cwd = typeof props.cwd === 'function' ? props.cwd() : ''

  const openDialog = useCallback(() => {
    setOpen(true)
    setError(undefined)
    setChoice('hub')
    setSelected([])
    setNewTitle('')
    void api.loadTopicSets(cwd).then(setTopicSets, () => setTopicSets([]))
  }, [api, cwd])

  // Capture-phase interception of the shell's New-session control. Capture runs
  // before any bubble handler, so stopping propagation here keeps the shell from
  // creating its plain session behind the dialog.
  useEffect(() => {
    if (typeof document === 'undefined' || !api) return
    const onCapture = (event: MouseEvent): void => {
      if (open) return
      const target = event.target
      if (!(target instanceof Element)) return
      // The dialog itself, and our own panel, must never re-trigger the layer.
      if (target.closest('.sm-ns-backdrop') !== null) return
      if (target.closest('[data-sm-panel]') !== null) return
      const control = target.closest('button, [role="button"], a')
      if (control === null) return
      const name = [
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
        control.textContent,
      ].filter((value): value is string => typeof value === 'string').join(' ')
      if (!isNewSessionControl(name)) return
      event.preventDefault()
      event.stopPropagation()
      openDialog()
    }
    document.addEventListener('click', onCapture, true)
    return () => document.removeEventListener('click', onCapture, true)
  }, [api, open, openDialog])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = (id: string): void => {
    setSelected((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      if (choice === 'hub') {
        api.startSession()
        setOpen(false)
        return
      }
      let ids = selected
      if (newTitle.trim()) {
        const created = await api.createTopicSet(cwd, newTitle.trim())
        if (created.status !== 'ok' || !created.id) {
          setError(created.message)
          return
        }
        ids = [...ids, created.id]
      }
      if (ids.length === 0) {
        setError(t('newSession.pick'))
        return
      }
      const result = await api.createTopicSetSession(cwd, ids)
      if (result.status !== 'ok' || !result.id) {
        setError(result.message)
        return
      }
      api.openSession(result.id)
      setOpen(false)
    } catch (startError) {
      setError(String(startError instanceof Error ? startError.message : startError))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return h('div', {
    key: 'backdrop', className: 'sm-ns-backdrop', 'data-sm-panel': 'true',
    onClick: (event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
      if (event.target === event.currentTarget) setOpen(false)
    },
  },
    h('div', { key: 'card', className: 'sm-ns-card', role: 'dialog', 'aria-modal': true },
      h('h2', { key: 'title' }, t('newSession.title')),
      h('div', {
        key: 'hub', className: 'sm-ns-option', 'data-active': String(choice === 'hub'),
        onClick: () => setChoice('hub'),
      },
        h('input', { key: 'radio', type: 'radio', checked: choice === 'hub', onChange: () => setChoice('hub') }),
        h('div', { key: 'text' },
          h('div', { key: 'name', className: 'sm-ns-name' }, t('newSession.hub')),
          h('div', { key: 'desc', className: 'sm-ns-desc' }, t('newSession.hub.desc')),
        ),
      ),
      h('div', {
        key: 'topic', className: 'sm-ns-option', 'data-active': String(choice === 'topic'),
        onClick: () => setChoice('topic'),
      },
        h('input', { key: 'radio', type: 'radio', checked: choice === 'topic', onChange: () => setChoice('topic') }),
        h('div', { key: 'text' },
          h('div', { key: 'name', className: 'sm-ns-name' }, t('newSession.topic')),
          h('div', { key: 'desc', className: 'sm-ns-desc' }, t('newSession.topic.desc')),
        ),
      ),
      choice === 'topic'
        ? h('div', { key: 'picker' },
            h('div', { key: 'label', className: 'sm-ns-desc' }, t('newSession.pick')),
            h('div', { key: 'list', className: 'sm-ns-list' },
              topicSets.length === 0
                ? h('div', { key: 'empty', className: 'sm-ns-desc' }, t('hub.empty'))
                : topicSets.map((topicSet) =>
                    h('label', { key: topicSet.id, className: 'sm-ns-check' },
                      h('input', {
                        key: 'box', type: 'checkbox', checked: selected.includes(topicSet.id),
                        onChange: () => toggle(topicSet.id),
                      }),
                      h('span', { key: 'name' }, topicSet.title),
                    ),
                  ),
            ),
            h('input', {
              key: 'newTitle', className: 'sm-ns-input', value: newTitle,
              placeholder: t('newSession.create'),
              onChange: (event: { target: { value: string } }) => setNewTitle(event.target.value),
            }),
          )
        : null,
      error ? h('div', { key: 'error', className: 'sm-ns-error' }, error) : null,
      h('div', { key: 'actions', className: 'sm-ns-actions' },
        h('button', { key: 'cancel', className: 'sm-ns-btn', onClick: () => setOpen(false) }, t('newSession.cancel')),
        h('button', {
          key: 'start', className: 'sm-ns-btn', 'data-variant': 'primary', disabled: busy,
          onClick: () => void start(),
        }, t('newSession.start')),
      ),
    ),
  )
}
