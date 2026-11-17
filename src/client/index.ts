/**
 * SuperMemory client half (browser): mounts the panel remote (host half in
 * src/panel.ts), registers the left-sidebar "超级记忆" panel launcher, the
 * main-column panel page (hub session by default; topic sets and their
 * sessions at the second level; memory browsing/management; composite-tool
 * editing), and the New-session choice layer (中枢会话 / 话题集会话).
 * @module supermemory/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { PANEL_REMOTE } from './remote.ts'
import { en, NS, zh } from './locales.ts'
import { SupermemoryIcon } from './icon.tsx'
import { SupermemoryPanelPage } from './panel-page.tsx'
import type { MutationResult, PanelApi, TopicSetView } from './panel-page.tsx'
import { NewSessionChoice } from './new-session.tsx'

export const name = 'dsh-supermemory-client'

/** Services this client half needs. */
export const inject = ['slots', 'locale', 'remote', 'uiWorkspace']

/** The panel id shared by the sidebar launcher and the main-slot key. */
const PANEL_ID = 'supermemory' as MainPanelId

type Translator = (key: string, params?: Record<string, string | number>) => string

/** Unwrap one RemoteResult, throwing a readable error on failure. */
function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  const failure = result.error as RemoteFailure
  throw new Error(failure?.message ?? 'remote call failed')
}

/**
 * Build the panel API the components use: every host-panel call goes through
 * the mounted remote namespace; navigation goes through uiWorkspace.
 */
function buildApi(ctx: Context): PanelApi | undefined {
  let namespace: Record<string, ((...args: unknown[]) => Promise<RemoteResult<unknown>>)> | undefined
  try {
    namespace = ctx.get('remote.supermemoryPanel') as typeof namespace
  } catch {
    namespace = undefined
  }
  if (!namespace) return undefined
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const fn = namespace![method]
    if (typeof fn !== 'function') throw new Error(`supermemoryPanel.${method} unavailable`)
    return unwrap(await fn(...args) as RemoteResult<T>)
  }
  return {
    loadHub: (cwd, sessionId) => call('hubState', cwd, sessionId),
    listMemories: (cwd, query) => call('listMemories', cwd, query, 200),
    createMemory: (cwd, text, key) => call('createMemory', cwd, text, key),
    updateMemory: (cwd, id, text, key) => call('updateMemory', cwd, id, text, key),
    deleteMemory: (cwd, id) => call('deleteMemory', cwd, id),
    setMemoryStatus: (cwd, id, status) => call('setMemoryStatus', cwd, id, status),
    createTopicSet: (cwd, title) => call('createTopicSet', cwd, title),
    activate: async (sessionId, topicSetId) => call('activate', sessionId, topicSetId),
    updateTopicSetSummary: (id, summary) => call('updateTopicSetSummary', id, summary),
    createTopicSetSession: (cwd, ids) => call('createTopicSetSession', cwd, ids),
    followupTopicSet: (cwd, topicSetId, text) => call('followupTopicSet', cwd, topicSetId, text),
    listTools: () => call('listTools'),
    editTool: (id, patch) => call('editTool', id, patch),
    // The shell owns both navigations; a missing service must not throw inside
    // a click handler (ctx.get is typed as possibly-undefined).
    openSession: (sessionId) => { ctx.get('uiWorkspace')?.openSession(sessionId as never) },
    startSession: () => { ctx.get('uiWorkspace')?.startSession() },
    loadTopicSets: (cwd) => call('listTopicSets', cwd) as Promise<TopicSetView[]>,
  }
}

/**
 * Resolve the workspace path the New-session dialog should create sessions in.
 * The `workspaces` service is the one the shell exposes to client plugins
 * (same shape dsh-vscode-mode reads); an empty string falls back to the host's
 * default workspace resolution.
 */
function resolveCwd(ctx: Context): string {
  try {
    const workspaces = ctx.get('workspaces') as
      | { list?: { getSnapshot?: () => { items?: Array<{ path?: unknown }> } } }
      | undefined
    const items = workspaces?.list?.getSnapshot?.()?.items ?? []
    for (const item of items) {
      if (typeof item?.path === 'string' && item.path) return item.path
    }
  } catch {
    // The service is absent on older shells; the dialog still works with ''.
  }
  return ''
}

/**
 * Register the SuperMemory surfaces. Every registration is defensive: a
 * failure in one contribution must not take down the others (or the boot).
 * @param ctx - browser root context.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'supermemory: dictionaries')

  // Mount the panel remote (host descriptors registered in src/panel.ts).
  try {
    const remote = ctx.get('remote') as { $mount: (contribution: unknown) => Promise<() => void> } | undefined
    if (remote && typeof remote.$mount === 'function') {
      await remote.$mount(PANEL_REMOTE)
    }
  } catch (error) {
    console.error('supermemory: panel remote mount failed', error)
  }

  const api = buildApi(ctx)
  if (!api) {
    console.error('supermemory: panel remote unavailable; the panel stays empty')
    return
  }
  const t: Translator = (key, params) => {
    const bound = ctx.locale.bind(NS)
    return bound(key, params as never)
  }

  // Every contribution registers independently: a single failed slot (an id
  // renamed by the shell, a duplicate registration) must degrade ONE surface,
  // never the whole client half — that would take the sidebar entry, the panel
  // page and the New-session layer down together.
  const contribute = (label: string, attach: () => void): void => {
    try {
      attach()
    } catch (error) {
      console.error(`supermemory: ${label} registration failed`, error)
    }
  }

  // 1. the left-sidebar launcher, beside the plugin/automation panel rows.
  contribute('panel launcher', () => {
    ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 25,
      locale: NS,
      label: () => t('panel'),
    }, SupermemoryIcon as never)), 'supermemory: panel launcher')
  })

  // 2. the main-column panel page (hub session by default).
  contribute('panel page', () => {
    ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => ({ api }),
    }, SupermemoryPanelPage as never)), 'supermemory: panel page')
  })

  // 3. the New-session choice layer (中枢会话 / 话题集会话).
  // Mounted in shell.overlay, NOT in a sidebar row slot: this shell exposes no
  // "new session action" slot (the verified sidebar slot vocabulary is
  // sidebar.panellist / sidebar.session.row.leading /
  // sidebar.workspaces.session.row.action / sidebar.footer.action), so the
  // component installs its own capture-phase document listener and intercepts
  // the click on the shell's 新建会话 control by accessible name. Worst case
  // (label renamed upstream) nothing is intercepted and the shell's default
  // plain new session still runs.
  contribute('new-session choice', () => {
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'supermemory-new-session',
      order: 30,
      locale: NS,
      inject: () => ({ api, cwd: () => resolveCwd(ctx) }),
    }, NewSessionChoice as never)), 'supermemory: new-session choice')
  })
}
