/**
 * SuperMemory client half (browser): mounts the panel remote (host half in
 * src/panel.ts), registers the left-sidebar "超级记忆" panel launcher, the
 * main-column panel page (hub session by default; topic sets and their
 * sessions at the second level; memory browsing/management; composite-tool
 * editing), the New-session entry (the shell's 新建会话 control CREATES a hub
 * session immediately with host defaults and shows the in-place receipt — no
 * dialog, no choice step; 需求①), and a 「分支」 badge on topic-set sessions in
 * the sidebar (hub vs branch at a glance).
 * @module supermemory/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { PANEL_REMOTE } from './remote.ts'
import { en, NS, zh } from './locales.ts'
import { SupermemoryIcon } from './icon.tsx'
import { SupermemoryPanelPage } from './panel-page.tsx'
import type { HubBranchView, HubPolicyView, HubSessionView, MemoryCollectionView, MemoryDetailView, MemoryShape, MemoryView, ModelDefaultsView, MutationResult, PanelApi, SessionBadge, SessionChatView, SkillView, TopicSetView } from './panel-page.tsx'
import { NewSessionChoice } from './new-session.tsx'
import { SupermemorySessionBadge, invalidateBadge } from './session-badge.tsx'
import { attachChatCards } from './chat-card.tsx'

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
    createMemory: (cwd, text, key, title, tags) => call('createMemory', cwd, text, key, title, tags),
    updateMemory: (cwd, id, text, key, title, tags) => call('updateMemory', cwd, id, text, key, title, tags),
    deleteMemory: (cwd, id) => call('deleteMemory', cwd, id),
    setMemoryStatus: (cwd, id, status) => call('setMemoryStatus', cwd, id, status),
    // R30 需求②: 记忆页签两级页——集合卡片统计 / 集合内条目 / 记忆详情（含历史版本）。
    listMemoryCollections: (cwd) => call<MemoryCollectionView[]>('listMemoryCollections', cwd),
    listMemoriesByCollection: (cwd, collectionId, query) => call<MemoryView[]>('listMemoriesByCollection', cwd, collectionId, query, 200),
    getMemoryDetail: (cwd, id) => call<MemoryDetailView | undefined>('getMemoryDetail', cwd, id),
    // R36 需求②: 「设置 → 中枢权限」——白名单快照 / 保存（含 reset）。
    getHubPolicy: (cwd) => call<HubPolicyView>('getHubPolicy', cwd),
    setHubPolicy: (cwd, patch) => call<MutationResult>('setHubPolicy', cwd, patch),
    cleanupStaleHubPolicy: (cwd) => call<MutationResult>('cleanupStaleHubPolicy', cwd),
    // R41 需求①b: 设置页签的默认模型（中枢会话 / 分支会话）。
    getModelDefaults: (cwd) => call<ModelDefaultsView>('getModelDefaults', cwd),
    setModelDefaults: (cwd, patch) => call<MutationResult>('setModelDefaults', cwd, patch),
    // R45: 设置页签「已生成的 skills」——快照 / 启用停用 / 改路由描述。
    listSkills: (cwd) => call<SkillView[]>('listSkills', cwd),
    updateSkill: (cwd, name, patch) => call<MutationResult>('updateSkill', cwd, name, patch),
    createTopicSet: (cwd, title, tags, summary) => call('createTopicSet', cwd, title, tags, summary),
    listHubSessions: (cwd) => call<HubSessionView[]>('listHubSessions', cwd),
    // R19 协同②: the hub's branch association (read model over dispatches).
    listHubBranches: (cwd, hubSessionId, limit) => call<HubBranchView[]>('listHubBranches', cwd, hubSessionId, limit),
    // R30 需求③: the hub manages EVERY topic set (archived included) and sees
    // every branch session across sets (optionally filtered to one set).
    listAllTopicSets: (cwd) => call<TopicSetView[]>('listAllTopicSets', cwd),
    listAllBranches: (cwd, topicSetId, limit) => call<HubBranchView[]>('listAllBranches', cwd, topicSetId, limit),
    // R19 需求⑤: in-panel conversation (host reads sessionQuery.readSurface).
    readSessionMessages: (sessionId, limit) => call<SessionChatView>('readSessionMessages', sessionId, limit),
    sendSessionMessage: (sessionId, text) => call<MutationResult>('sendSessionMessage', sessionId, text),
    suggestMemoryShape: (text) => call<MemoryShape>('suggestMemoryShape', text),
    // R18 需求③: the badge cache is module-level; a hub refresh / dispatch receipt
    // is exactly when topic-set membership may have changed, so the panel asks
    // for a re-read instead of leaving a stale hub badge in the sidebar.
    invalidateBadges: (sessionId) => { invalidateBadge(sessionId) },
    activate: async (sessionId, topicSetId) => call('activate', sessionId, topicSetId),
    updateTopicSetSummary: (id, summary, tags) => call('updateTopicSetSummary', id, summary, tags),
    createTopicSetSession: (cwd, ids, options, firstMessage) => call('createTopicSetSession', cwd, ids, options, firstMessage),
    createHubSession: (cwd, options, firstMessage) => call('createHubSession', cwd, options, firstMessage),
    followupTopicSet: (cwd, topicSetId, text) => call('followupTopicSet', cwd, topicSetId, text),
    listTools: (cwd) => call('listTools', cwd),
    editTool: (id, patch) => call('editTool', id, patch),
    deleteTool: (id) => call('deleteTool', id),
    // R50: 统一能力的执行面（默认预演）与提案接受/拒绝。
    runTool: (id, options) => call('runTool', id, options),
    acceptProposal: (cwd, id) => call<MutationResult>('acceptProposal', cwd, id),
    declineProposal: (cwd, id) => call<MutationResult>('declineProposal', cwd, id),
    listAgentPresets: () => call('listAgentPresets'),
    listModelCatalog: () => call('listModelCatalog'),
    listPermissions: () => call('listPermissions'),
    sessionBadge: (sessionId) => call<SessionBadge>('sessionBadge', sessionId),
    // The shell owns both navigations; a missing service must not throw inside
    // a click handler (ctx.get is typed as possibly-undefined).
    openSession: (sessionId) => { ctx.get('uiWorkspace')?.openSession(sessionId as never) },
    startSession: () => { ctx.get('uiWorkspace')?.startSession() },
    loadTopicSets: (cwd) => call('listTopicSets', cwd) as Promise<TopicSetView[]>,
  }
}

/**
 * Resolve the workspace a click-created hub session should live in.
 *
 * The MAIN-VIEW session's own cwd wins: with more than one workspace open,
 * `workspaces.items[0].path` points the session (and every later write) at the
 * wrong project. Both services are optional seams: an older shell simply
 * yields '' and the New-session entry then leaves the click to the shell
 * instead of creating a session in an unknown workspace.
 */
function resolveCwd(ctx: Context): string {
  try {
    const sessions = ctx.get('sessions') as
      | { list?: { getSnapshot?: () => { byId?: Record<string, { retainedBy?: { mainView?: number }; cwd?: unknown; header?: { cwd?: unknown } }> } } }
      | undefined
    const byId = sessions?.list?.getSnapshot?.()?.byId ?? {}
    for (const session of Object.values(byId)) {
      if ((session?.retainedBy?.mainView ?? 0) <= 0) continue
      const cwd = session.cwd ?? session.header?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    }
  } catch {
    // The service is absent on older shells; fall through to the workspace list.
  }
  try {
    const workspaces = ctx.get('workspaces') as
      | { list?: { getSnapshot?: () => { items?: Array<{ path?: unknown }> } } }
      | undefined
    const items = workspaces?.list?.getSnapshot?.()?.items ?? []
    for (const item of items) {
      if (typeof item?.path === 'string' && item.path) return item.path
    }
  } catch {
    // The service is absent on older shells; '' makes the entry defer to the shell.
  }
  return ''
}

/**
 * Open the SuperMemory panel in the shell's main column — the same
 * `layout.selectPanel(PANEL_ID)` call the shell's plugin-manager makes.
 *
 * The shell provides the layout service as a reflected value and its own
 * plugins read it as `ctx.layout`; `ctx.get('layout')` is the abstracted form.
 * Both are tried, because the reflected property is the verified one while
 * `get` keeps this working if the property is renamed. Returns false when
 * neither is usable, so the caller can fall back to opening the created
 * session directly — never a dead click.
 */
function selectSuperPanel(ctx: Context): boolean {
  try {
    const holder = ctx as unknown as { layout?: { selectPanel?: (id: string) => unknown } }
    const layout = holder.layout ?? (ctx.get('layout') as { selectPanel?: (id: string) => unknown } | undefined)
    const select = layout?.selectPanel
    if (typeof select !== 'function') return false
    void Promise.resolve(select.call(layout, PANEL_ID)).catch(() => {
      try {
        ctx.get('uiWorkspace')?.startSession()
      } catch {
        // Older shell: nothing else to fall back to.
      }
    })
    return true
  } catch {
    return false
  }
}

/**
 * Register the SuperMemory surfaces. Every registration is defensive: a
 * failure in one contribution must not take down the others (or the boot).
 * @param ctx - browser root context.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'supermemory: dictionaries')

  // R32 需求③: install the hub↔branch chat card BEFORE the panel API check —
  // the conversation card must not depend on the panel remote being mountable.
  try {
    attachChatCards(ctx)
  } catch (error) {
    console.error('supermemory: chat card registration failed', error)
  }

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

  // 3. the New-session entry (需求①：点击「新会话」立即创建中枢会话): the click
  // CREATES the hub session through the panel api with host defaults and hands
  // the receipt to the panel — no dialog and no intermediate choice step.
  // Mounted in shell.overlay, NOT in a sidebar row slot: this shell exposes no
  // "new session action" slot to replace (the sidebar's own 新建会话 row renders
  // sidebar.session.action, which would ADD a control rather than replace it),
  // so the component installs a capture-phase document listener and matches the
  // control by accessible name. Worst cases (label renamed upstream, no api, or
  // no resolvable workspace) leave the click untouched, so the shell's default
  // new-session flow still runs.
  contribute('new-session entry', () => {
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'supermemory-new-session',
      order: 30,
      locale: NS,
      inject: () => ({
        // 需求①: the click creates the hub session itself (host defaults), then
        // hands the receipt to the panel; `cwd` resolves the current workspace
        // and `selectPanel` reveals the panel so the receipt is visible.
        api,
        cwd: () => resolveCwd(ctx),
        selectPanel: () => selectSuperPanel(ctx),
      }),
    }, NewSessionChoice as never)), 'supermemory: new-session entry')
  })

  // 4. the sidebar session-row badge (问题③, R31 需求②): a 「分支」/「话题集」/
  //    「中枢」 mark on the sessions this plugin knows about, so hub sessions,
  //    the branches they dispatched to and topic-set hubs stay distinguishable
  //    in the left sidebar.
  //    R31 需求② moved the slot from `leading` to `trailing`: the host gates
  //    the leading cell by `!row.archived && !row.blank && (showStatus ?
  //    <SessionStatusDots/> : renderSlot(...))`, so a RUNNING row lost the
  //    badge to its own status dot (the 「运行中隐藏」 report). The trailing
  //    cell is gated by `!row.blank` only — it renders while running and in
  //    approval states, and no other package registers that slot (verified in
  //    the host app.asar, Rows.tsx trailing cell: time label, slot, pin mark).
  //    Known limitation (same as before, not a regression): a blank row — no
  //    first message yet — renders neither cell, so a brand-new empty hub
  //    session shows no badge until it has a message.
  contribute('session badge', () => {
    ctx.effect(() => ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
      name: 'sidebar.session.row.trailing',
      id: 'supermemory-branch',
      order: 30,
      locale: NS,
      inject: () => ({ api }),
    }, SupermemorySessionBadge as never)), 'supermemory: session badge')
  })
}
