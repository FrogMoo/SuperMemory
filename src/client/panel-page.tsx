/**
 * SuperMemory main panel (the `main` slot keyed by panel id 'supermemory').
 * Level 1 shows the hub session and the workspace's topic sets; level 2
 * opens one topic set (its branch sessions, reply box and summary); the
 * Memories tab browses/edits memories and locates their source sessions;
 * the Tools tab lists and edits composite tools (R6).
 * @module supermemory/client/panel-page
 */
import { createElement as h, useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'

export interface TopicSetView {
  id: string
  title: string
  summary: string
  branches: Array<{ sessionId: string; title: string; status: string; model?: string }>
  model?: string
}

export interface MemoryView {
  id: string
  text: string
  key?: string
  status: string
  sourceSessionId: string
  createdAt: number
  updatedAt: number
}

export interface ToolView {
  id: string
  name: string
  description: string
  steps: string[]
  parameters: string[]
  useCount: number
  status: string
  live: boolean
}

export interface HubState {
  sessionId: string
  workspaceKey: string
  activeTopicSetId?: string
  topicSets: TopicSetView[]
  memories: MemoryView[]
  counts: { memories: number; requirements: number; episodes: number; dispatches: number; tools: number }
}

export interface MutationResult {
  status: 'ok' | 'error'
  message: string
  id?: string
}

/** Injected face: host-panel calls plus navigation, built in apply(). */
export interface PanelApi {
  loadHub(cwd: string, sessionId: string): Promise<HubState>
  listMemories(cwd: string, query?: string): Promise<MemoryView[]>
  createMemory(cwd: string, text: string, key?: string): Promise<MutationResult>
  updateMemory(cwd: string, id: string, text: string, key?: string): Promise<MutationResult>
  deleteMemory(cwd: string, id: string): Promise<MutationResult>
  setMemoryStatus(cwd: string, id: string, status: string): Promise<MutationResult>
  createTopicSet(cwd: string, title: string): Promise<MutationResult>
  activate(sessionId: string, topicSetId: string): Promise<boolean>
  updateTopicSetSummary(id: string, summary: string): Promise<MutationResult>
  createTopicSetSession(cwd: string, ids: string[]): Promise<MutationResult>
  followupTopicSet(cwd: string, topicSetId: string, text: string): Promise<MutationResult>
  listTools(): Promise<ToolView[]>
  editTool(id: string, patch: Record<string, unknown>): Promise<MutationResult>
  openSession(sessionId: string): void
  startSession(): void
  loadTopicSets(cwd: string): Promise<TopicSetView[]>
}

export interface PanelPageProps {
  useWorkspaces: <S>(selector: (state: { items: Array<{ id: string; path: string; title?: string }> }) => S) => S
  useSessions: <S>(selector: (state: { byId: Record<string, { id: string; retainedBy?: { mainView?: number } }> }) => S) => S
  t: (key: string, params?: Record<string, string | number>) => string
  api: PanelApi
}

type View = { kind: 'hub' } | { kind: 'topic'; id: string } | { kind: 'memories' } | { kind: 'tools' }

const PANEL_CSS = `
.sm-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsh-color-text,#e8e8ea);background:var(--dsh-color-bg,#17171a);font-size:13px}
.sm-panel *{box-sizing:border-box}
.sm-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsh-color-border,#2c2c31)}
.sm-head h1{font-size:15px;margin:0;font-weight:600}
.sm-counts{margin-left:auto;opacity:.65;font-size:11px}
.sm-tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid var(--dsh-color-border,#2c2c31)}
.sm-tab{padding:6px 12px;border:none;background:transparent;color:inherit;opacity:.6;cursor:pointer;border-radius:6px 6px 0 0;font-size:12px}
.sm-tab[data-active="true"]{opacity:1;background:var(--dsh-color-bg-soft,#1f1f24);font-weight:600}
.sm-body{flex:1;min-height:0;overflow:auto;padding:12px 16px}
.sm-card{border:1px solid var(--dsh-color-border,#2c2c31);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--dsh-color-bg-soft,#1c1c20)}
.sm-card h3{margin:0 0 4px;font-size:13px}
.sm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sm-muted{opacity:.6;font-size:11px}
.sm-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#222228);color:inherit;cursor:pointer;font-size:12px}
.sm-btn:hover{border-color:var(--dsh-color-primary,#5b8def)}
.sm-btn[data-variant="primary"]{background:var(--dsh-color-primary,#3d6fd8);border-color:transparent;color:#fff}
.sm-btn[data-variant="danger"]{border-color:#a8443c;color:#e0736a}
.sm-btn:disabled{opacity:.45;cursor:default}
.sm-input{width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#121215);color:inherit;font-size:12px;font-family:inherit}
.sm-textarea{width:100%;min-height:56px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsh-color-border,#3a3a42);background:var(--dsh-color-bg,#121215);color:inherit;font-size:12px;font-family:inherit;resize:vertical}
.sm-list{display:flex;flex-direction:column;gap:6px}
.sm-item{border:1px solid var(--dsh-color-border,#2c2c31);border-radius:8px;padding:8px 10px;background:var(--dsh-color-bg-soft,#1c1c20)}
.sm-item[data-clickable="true"]{cursor:pointer}
.sm-item[data-clickable="true"]:hover{border-color:var(--dsh-color-primary,#5b8def)}
.sm-item .sm-title{font-weight:600;font-size:12.5px}
.sm-item .sm-sub{opacity:.6;font-size:11px;margin-top:2px;word-break:break-all}
.sm-actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.sm-error{color:#e0736a;font-size:12px;padding:8px 0}
.sm-ok{color:#6fbf73;font-size:12px;padding:4px 0}
.sm-badge{display:inline-block;padding:1px 6px;border-radius:99px;font-size:10px;border:1px solid var(--dsh-color-border,#3a3a42);opacity:.8;margin-right:4px}
.sm-empty{opacity:.55;padding:16px 0;text-align:center}
.sm-form{display:flex;gap:6px;margin-bottom:10px}
.sm-form .sm-input{flex:1}
.sm-back{margin-bottom:8px}
`

let cssInstalled = false
function installCss(): void {
  if (cssInstalled || typeof document === 'undefined') return
  cssInstalled = true
  const style = document.createElement('style')
  style.setAttribute('data-plugin', 'dsh-supermemory')
  style.textContent = PANEL_CSS
  document.head.append(style)
}

function Button(props: {
  label: string
  onClick?: () => void
  variant?: 'primary' | 'danger'
  disabled?: boolean
  title?: string
}): ReactElement {
  return h('button', {
    type: 'button',
    className: 'sm-btn',
    'data-variant': props.variant,
    disabled: props.disabled,
    title: props.title,
    onClick: props.onClick,
  }, props.label)
}

/** The SuperMemory main panel page. */
export function SupermemoryPanelPage(props: PanelPageProps): ReactElement {
  installCss()
  const { t, api } = props
  const [view, setView] = useState<View>({ kind: 'hub' })
  const [hub, setHub] = useState<HubState | undefined>()
  const [memories, setMemories] = useState<MemoryView[]>([])
  const [tools, setTools] = useState<ToolView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [newMemory, setNewMemory] = useState('')
  const [newTopicTitle, setNewTopicTitle] = useState('')
  const [reply, setReply] = useState('')
  const [summaryDraft, setSummaryDraft] = useState<string | undefined>()
  const [editingMemory, setEditingMemory] = useState<{ id: string; text: string } | undefined>()
  const [editingTool, setEditingTool] = useState<{ id: string; description: string } | undefined>()

  const workspaces = props.useWorkspaces((state) => state.items)
  const sessionId = props.useSessions((state) => {
    for (const session of Object.values(state.byId)) {
      if ((session.retainedBy?.mainView ?? 0) > 0) return session.id
    }
    return ''
  })
  // Prefer the MAIN-VIEW session's own cwd: with more than one workspace open,
  // workspaces[0] points the whole panel (and every write) at the wrong
  // project. The primitives keep the selectors reference-stable; an absent
  // header simply falls back to the previous behaviour.
  const sessionCwd = props.useSessions((state) => {
    for (const session of Object.values(state.byId)) {
      if ((session.retainedBy?.mainView ?? 0) > 0) {
        return String((session as { header?: { cwd?: string } }).header?.cwd ?? '')
      }
    }
    return ''
  })
  const cwd = useMemo(() => sessionCwd || workspaces[0]?.path || '', [sessionCwd, workspaces])

  const refreshHub = useCallback(async () => {
    if (!cwd) return
    setLoading(true)
    setError(undefined)
    try {
      const state = await api.loadHub(cwd, sessionId)
      setHub(state)
      setMemories(state.memories)
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    } finally {
      setLoading(false)
    }
  }, [api, cwd, sessionId, t])

  const refreshMemories = useCallback(async () => {
    if (!cwd) return
    try {
      setMemories(await api.listMemories(cwd, query.trim() || undefined))
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, query, t])

  const refreshTools = useCallback(async () => {
    try {
      setTools(await api.listTools())
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, t])

  useEffect(() => { void refreshHub() }, [refreshHub])
  useEffect(() => { if (view.kind === 'memories') void refreshMemories() }, [view, refreshMemories])
  useEffect(() => { if (view.kind === 'tools') void refreshTools() }, [view, refreshTools])

  const activeTopicSet = hub?.topicSets.find((topicSet) => topicSet.id === hub.activeTopicSetId)
  const currentTopicSet = view.kind === 'topic'
    ? hub?.topicSets.find((topicSet) => topicSet.id === view.id)
    : undefined

  const run = async (action: () => Promise<MutationResult | boolean>, after?: () => void): Promise<void> => {
    setNotice(undefined)
    setError(undefined)
    try {
      const result = await action()
      if (result === true) { setNotice(t('ok.saved')); after?.(); return }
      if (result && result.status === 'ok') setNotice(result.message)
      else if (result) setError(result.message)
      after?.()
    } catch (actionError) {
      setError(`${t('error.generic')}: ${String(actionError instanceof Error ? actionError.message : actionError)}`)
    }
  }

  const tabProps = (kind: View['kind']) => ({
    'data-active': String(view.kind === kind),
    className: 'sm-tab',
    onClick: () => setView(kind === 'hub' ? { kind: 'hub' } : kind === 'memories' ? { kind: 'memories' } : kind === 'tools' ? { kind: 'tools' } : { kind: 'hub' }),
  })

  const hubView: ReactNode = [
    h('div', { key: 'current', className: 'sm-card' },
      h('h3', null, t('hub.current')),
      h('div', { className: 'sm-row' },
        h('span', { className: 'sm-muted' }, sessionId || '—'),
        h(Button, { key: 'refresh', label: t('hub.refresh'), onClick: () => void refreshHub() }),
      ),
      h('div', { className: 'sm-row', style: { marginTop: 6 } },
        h('span', { className: 'sm-muted' }, `${t('hub.active')}：`),
        activeTopicSet
          ? h(Button, {
              key: 'open', label: activeTopicSet.title,
              onClick: () => setView({ kind: 'topic', id: activeTopicSet.id }),
            })
          : h('span', { className: 'sm-muted' }, t('hub.none')),
      ),
    ),
    h('div', { key: 'new', className: 'sm-form' },
      h('input', {
        key: 'input', className: 'sm-input', value: newTopicTitle,
        placeholder: t('topic.create.placeholder'),
        onChange: (event: { target: { value: string } }) => setNewTopicTitle(event.target.value),
      }),
      h(Button, {
        key: 'add', variant: 'primary', label: t('topic.create'), disabled: !newTopicTitle.trim(),
        onClick: () => void run(async () => api.createTopicSet(cwd, newTopicTitle.trim()), () => { setNewTopicTitle(''); void refreshHub() }),
      }),
    ),
    h('div', { key: 'list', className: 'sm-list' },
      (hub?.topicSets ?? []).length === 0
        ? h('div', { key: 'empty', className: 'sm-empty' }, t('hub.empty'))
        : (hub?.topicSets ?? []).map((topicSet) =>
            h('div', {
              key: topicSet.id, className: 'sm-item', 'data-clickable': 'true',
              onClick: () => { setView({ kind: 'topic', id: topicSet.id }); setSummaryDraft(undefined); setReply('') },
            },
              h('div', { className: 'sm-row' },
                h('span', { className: 'sm-title' }, topicSet.title),
                hub?.activeTopicSetId === topicSet.id ? h('span', { key: 'b', className: 'sm-badge' }, t('hub.active')) : null,
                topicSet.model ? h('span', { key: 'm', className: 'sm-badge' }, topicSet.model) : null,
              ),
              h('div', { className: 'sm-sub' }, topicSet.summary || '—'),
              h('div', { className: 'sm-sub' }, `${t('topic.members')}：${topicSet.branches.length}`),
              h('div', { className: 'sm-actions' },
                h(Button, {
                  key: 'act', label: t('hub.activate'),
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation()
                    void run(async () => api.activate(sessionId, topicSet.id), () => void refreshHub())
                  },
                }),
              ),
            ),
          ),
    ),
  ]

  const topicView: ReactNode = currentTopicSet
    ? [
        h(Button, { key: 'back', className: 'sm-back', label: t('topic.back'), onClick: () => setView({ kind: 'hub' }) }),
        h('div', { key: 'card', className: 'sm-card' },
          h('h3', null, currentTopicSet.title),
          h('div', { className: 'sm-row' },
            h(Button, {
              key: 'act', variant: 'primary', label: t('hub.activate'),
              onClick: () => void run(async () => api.activate(sessionId, currentTopicSet.id), () => void refreshHub()),
            }),
            currentTopicSet.model ? h('span', { key: 'm', className: 'sm-badge' }, currentTopicSet.model) : null,
          ),
        ),
        h('div', { key: 'members', className: 'sm-card' },
          h('h3', null, t('topic.members')),
          currentTopicSet.branches.length === 0
            ? h('div', { className: 'sm-empty' }, t('topic.noMembers'))
            : h('div', { className: 'sm-list' },
                currentTopicSet.branches.map((branch) =>
                  h('div', { key: branch.sessionId, className: 'sm-item', 'data-clickable': 'true', onClick: () => api.openSession(branch.sessionId) },
                    h('div', { className: 'sm-row' },
                      h('span', { className: 'sm-title' }, branch.title || branch.sessionId.slice(0, 12)),
                      h('span', { key: 's', className: 'sm-badge' }, branch.status),
                      branch.model ? h('span', { key: 'm', className: 'sm-badge' }, branch.model) : null,
                    ),
                    h('div', { className: 'sm-sub' }, branch.sessionId),
                  ),
                ),
              ),
        ),
        h('div', { key: 'reply', className: 'sm-card' },
          h('h3', null, t('topic.reply')),
          h('textarea', {
            key: 'input', className: 'sm-textarea', value: reply,
            placeholder: t('topic.reply.placeholder'),
            onChange: (event: { target: { value: string } }) => setReply(event.target.value),
          }),
          h('div', { className: 'sm-actions' },
            h(Button, {
              key: 'send', variant: 'primary', label: t('topic.reply.send'), disabled: !reply.trim(),
              onClick: () => void run(async () => api.followupTopicSet(cwd, currentTopicSet.id, reply.trim()), () => {
                const landed = hub?.topicSets.find((topicSet) => topicSet.id === currentTopicSet.id)
                setReply('')
                void landed
              }),
            }),
          ),
        ),
        h('div', { key: 'summary', className: 'sm-card' },
          h('h3', null, t('topic.summary')),
          h('textarea', {
            key: 'input', className: 'sm-textarea', value: summaryDraft ?? currentTopicSet.summary,
            onChange: (event: { target: { value: string } }) => setSummaryDraft(event.target.value),
          }),
          h('div', { className: 'sm-actions' },
            h(Button, {
              key: 'save', label: t('topic.summary.save'),
              onClick: () => void run(async () => api.updateTopicSetSummary(currentTopicSet.id, (summaryDraft ?? currentTopicSet.summary).slice(0, 500)), () => { setSummaryDraft(undefined); void refreshHub() }),
            }),
          ),
        ),
      ]
    : h('div', { key: 'missing', className: 'sm-empty' }, t('hub.empty'))

  const memoriesView: ReactNode = [
    h('div', { key: 'search', className: 'sm-form' },
      h('input', {
        key: 'input', className: 'sm-input', value: query, placeholder: t('memory.search'),
        onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
      }),
      h(Button, { key: 'go', label: t('hub.refresh'), onClick: () => void refreshMemories() }),
    ),
    h('div', { key: 'new', className: 'sm-form' },
      h('input', {
        key: 'input', className: 'sm-input', value: newMemory, placeholder: t('memory.new.placeholder'),
        onChange: (event: { target: { value: string } }) => setNewMemory(event.target.value),
      }),
      h(Button, {
        key: 'add', variant: 'primary', label: t('memory.add'), disabled: !newMemory.trim(),
        onClick: () => void run(async () => api.createMemory(cwd, newMemory.trim()), () => { setNewMemory(''); void refreshMemories() }),
      }),
    ),
    h('div', { key: 'list', className: 'sm-list' },
      memories.length === 0
        ? h('div', { key: 'empty', className: 'sm-empty' }, t('memory.empty'))
        : memories.map((memory) =>
            editingMemory && editingMemory.id === memory.id
              ? h('div', { key: memory.id, className: 'sm-item' },
                  h('textarea', {
                    key: 'input', className: 'sm-textarea', value: editingMemory.text,
                    onChange: (event: { target: { value: string } }) => setEditingMemory({ id: memory.id, text: event.target.value }),
                  }),
                  h('div', { className: 'sm-actions' },
                    h(Button, {
                      key: 'save', variant: 'primary', label: t('memory.save'),
                      onClick: () => void run(async () => api.updateMemory(cwd, memory.id, editingMemory.text), () => { setEditingMemory(undefined); void refreshMemories() }),
                    }),
                    h(Button, { key: 'cancel', label: t('memory.cancel'), onClick: () => setEditingMemory(undefined) }),
                  ),
                )
              : h('div', { key: memory.id, className: 'sm-item' },
                  h('div', { className: 'sm-title' }, memory.text),
                  h('div', { className: 'sm-sub' },
                    h('span', { key: 'st', className: 'sm-badge' }, memory.status),
                    `${t('memory.source')}：${memory.sourceSessionId || '—'}`,
                  ),
                  h('div', { className: 'sm-actions' },
                    memory.sourceSessionId
                      ? h(Button, {
                          key: 'loc', label: t('memory.locate'),
                          onClick: () => api.openSession(memory.sourceSessionId),
                        })
                      : null,
                    h(Button, { key: 'edit', label: t('memory.edit'), onClick: () => setEditingMemory({ id: memory.id, text: memory.text }) }),
                    h(Button, {
                      key: 'toggle', label: memory.status === 'active' ? t('memory.disable') : t('memory.enable'),
                      onClick: () => void run(async () => api.setMemoryStatus(cwd, memory.id, memory.status === 'active' ? 'superseded' : 'active'), () => void refreshMemories()),
                    }),
                    h(Button, {
                      key: 'del', variant: 'danger', label: t('memory.delete'),
                      onClick: () => void run(async () => api.deleteMemory(cwd, memory.id), () => void refreshMemories()),
                    }),
                  ),
                ),
          ),
    ),
  ]

  const toolsView: ReactNode = [
    h('div', { key: 'list', className: 'sm-list' },
      tools.length === 0
        ? h('div', { key: 'empty', className: 'sm-empty' }, t('tool.empty'))
        : tools.map((tool) =>
            h('div', { key: tool.id, className: 'sm-item' },
              h('div', { className: 'sm-row' },
                h('span', { className: 'sm-title' }, tool.name),
                h('span', { className: 'sm-badge' }, tool.status),
                h('span', { className: 'sm-badge' }, tool.live ? t('tool.live') : t('tool.offline')),
              ),
              editingTool && editingTool.id === tool.id
                ? h('div', { key: 'edit' },
                    h('textarea', {
                      key: 'input', className: 'sm-textarea', value: editingTool.description,
                      onChange: (event: { target: { value: string } }) => setEditingTool({ id: tool.id, description: event.target.value }),
                    }),
                    h('div', { className: 'sm-actions' },
                      h(Button, {
                        key: 'save', variant: 'primary', label: t('tool.desc.save'),
                        onClick: () => void run(async () => api.editTool(tool.id, { description: editingTool.description }), () => { setEditingTool(undefined); void refreshTools() }),
                      }),
                      h(Button, { key: 'cancel', label: t('memory.cancel'), onClick: () => setEditingTool(undefined) }),
                    ),
                  )
                : h('div', { key: 'desc' },
                    h('div', { className: 'sm-sub' }, `${t('tool.desc.edit')}：${tool.description || '—'}`),
                    h('div', { className: 'sm-actions' },
                      h(Button, { key: 'edit', label: t('tool.desc.edit'), onClick: () => setEditingTool({ id: tool.id, description: tool.description }) }),
                      tool.status === 'active'
                        ? h(Button, {
                            key: 'retire', variant: 'danger', label: t('tool.retire'),
                            onClick: () => void run(async () => api.editTool(tool.id, { status: 'retired' }), () => void refreshTools()),
                          })
                        : null,
                    ),
                  ),
              h('div', { className: 'sm-sub' }, `${t('tool.steps')}：${tool.steps.join(' → ') || '—'}`),
              h('div', { className: 'sm-sub' }, `${t('tool.params')}：${tool.parameters.join('、') || '—'} · ${t('tool.uses')}：${tool.useCount}`),
            ),
          ),
    ),
  ]

  const body = view.kind === 'hub' ? hubView : view.kind === 'topic' ? topicView : view.kind === 'memories' ? memoriesView : toolsView

  return h('div', { className: 'sm-panel', 'data-sm-panel': 'true' },
    h('div', { key: 'head', className: 'sm-head' },
      h('h1', null, t('panel.title')),
      hub ? h('span', { key: 'counts', className: 'sm-counts' }, t('hub.counts', hub.counts)) : null,
    ),
    h('div', { key: 'tabs', className: 'sm-tabs' },
      h('button', { key: 'hub', ...tabProps('hub') }, t('tab.hub')),
      h('button', { key: 'memories', ...tabProps('memories') }, t('tab.memories')),
      h('button', { key: 'tools', ...tabProps('tools') }, t('tab.tools')),
    ),
    h('div', { key: 'body', className: 'sm-body' },
      loading ? h('div', { key: 'loading', className: 'sm-muted' }, '…') : null,
      error ? h('div', { key: 'error', className: 'sm-error' }, error) : null,
      notice ? h('div', { key: 'notice', className: 'sm-ok' }, notice) : null,
      body,
    ),
  )
}
