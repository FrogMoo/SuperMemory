/**
 * SuperMemory main panel (the `main` slot keyed by panel id 'supermemory').
 * Level 1 shows the hub session and the workspace's topic sets; level 2
 * opens one topic set (its branch sessions, reply box and summary); the
 * Memories tab is two levels (R30 需求②): 记忆集卡片 → 集合内条目（带版本
 * 徽标）→ 记忆详情（完整正文 + 历史版本）；the Tools tab lists and edits
 * composite tools (R6) with their lifecycle timestamps (R28 需求②).
 * @module supermemory/client/panel-page
 */
import { createElement as h, useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { subscribeHubReceipt, takePendingHubReceipt, type HubSessionReceipt } from './open-dispatch.ts'
import { isRailCurrent } from '../rail-selection.ts'

export interface TopicSetView {
  id: string
  title: string
  /** Tags (host `keywords`): the index the 话题集 tab filters on. */
  tags: string[]
  summary: string
  /** Session count (R11): how many sessions this topic set holds. */
  sessions: number
  /** How many of those sessions are live right now. */
  live: number
  /** R30 需求③: lifecycle (the hub's 全部话题集 view lists archived sets too). */
  status?: 'active' | 'archived'
  branches: Array<{
    sessionId: string
    kind: 'root' | 'fork'
    title: string
    status: string
    model?: string
    topicSetId?: string
    topicSetTitle?: string
    hubs?: number
    /** 最新一次派发的任务摘要（重启后仅凭持久台账也能认出分支）。 */
    task?: string
    /** R30 需求④: 分支标签（来自最新一次派发记录）。 */
    tags?: string[]
  }>
  model?: string
}

export interface MemoryView {
  id: string
  title: string
  tags: string[]
  text: string
  key?: string
  status: string
  sourceSessionId: string
  createdAt: number
  updatedAt: number
  /**
   * R28 需求④: the 记忆集合 this entry belongs to (host listMemories/hubState
   * 透出；undefined = 未归集). Memories are displayed grouped by collection.
   */
  collectionId?: string
  collectionTitle?: string
  collectionTags?: string[]
  /**
   * R30 需求①: 当前版本号（旧记录读作 1）。记忆页签的条目行显示 vN 徽标，
   * 详情页列出全部历史版本。
   */
  version?: number
}

/**
 * R30 需求②: 记忆页签第一级——记忆集合卡片。条目数/最近更新由宿主聚合
 * （未归集是一张 id 为 '' 的虚拟卡片，保证旧数据不丢）。
 */
export interface MemoryCollectionView {
  id: string
  title: string
  tags: string[]
  summary: string
  count: number
  latestUpdatedAt: number
  status: string
  createdAt: number
  updatedAt: number
}

/** R30 需求①: 一条历史版本（完整快照）。 */
export interface MemoryVersionView {
  version: number
  updatedAt: number
  title: string
  tags: string[]
  text: string
  changeType: 'create' | 'update' | 'migrate'
  collectionId?: string
}

/** R30 需求②: 记忆详情（当前字段 + 版本序列，最后一条即当前版本）。 */
export interface MemoryDetailView {
  view: MemoryView
  versions: MemoryVersionView[]
}

/** R39: 「中枢权限」动态目录的一条目录项（运行时工具名或前缀规则）。 */
export interface HubCatalogItem {
  name: string
  /** 首行描述摘要（宿主截断到 140 字）。 */
  description?: string
  /** 前缀项（如 `schedule_`），渲染时带 `*`。 */
  prefix?: boolean
  /** 锁定项：面板禁用取消勾选。 */
  locked?: boolean
  /** 实操执行类工具：带风险提示。 */
  risk?: boolean
  /** 每项附加说明的 locale key 后缀（如 pluginManager）。 */
  noteKey?: string
  /** 当前存储白名单命中（精确或前缀）。 */
  enabled: boolean
  /** 运行时可用性；undefined=未知（内置回退无法核验）。 */
  available?: boolean
  /** 白名单有、运行时无（只在失效组里）。 */
  stale?: boolean
  /** R40: 合成项——不在全局注册面，但中枢会话实际可用（永不失效、清理不移除）。 */
  synthetic?: boolean
  /** 归属来源 id（source:* / stale）。 */
  source: string
}

/** R39: 目录分组——每个来源一组，失效条目单列最后一组。 */
export interface HubCatalogGroup {
  /** 来源 id：source:supermemory / source:composite / source:mcp:<server> / source:schedule / source:host / source:declared:<slug> / stale。 */
  id: string
  /** 宿主给的显示名（客户端对已知 id 优先本地化，未知 id 用它）。 */
  label: string
  kind: 'source' | 'stale'
  /** 归属是否为推断（宿主定义无来源字段时的命名规则）。 */
  inferred: boolean
  /** 产生该归属的规则说明。 */
  hint?: string
  /** R40: 该组只存在于合成宿主会话面。 */
  synthetic?: boolean
  items: HubCatalogItem[]
  total: number
  enabledCount: number
}

/** R39: 一次目录生成的来源信息（新鲜度 + 降级）。 */
export interface HubCatalogMeta {
  generatedAt: number
  mode: 'dynamic' | 'fallback'
  toolCount: number
  /** R40: `toolCount` 中合成宿主会话项的个数。 */
  syntheticCount: number
  groupCount: number
  anyDeclaredSource: boolean
  warning?: string
}

/** R39: 中枢权限页签快照（宿主 getHubPolicy 的投影）。 */
export interface HubPolicyView {
  workspaceKey: string
  tools: string[]
  prefixes: string[]
  /** stored=工作区自有；default=旧库无记录/读失败回退的内置默认。 */
  source: 'stored' | 'default'
  locked: string[]
  defaults: { tools: string[]; prefixes: string[] }
  /** 动态目录：运行时全部工具按来源分组 + 失效条目组。 */
  catalog: HubCatalogGroup[]
  catalogMeta: HubCatalogMeta
  /** 白名单里有、运行时已不存在的条目（一键清理用）。 */
  stale: HubCatalogItem[]
}

/** R41 需求①b: 设置页签的默认模型快照（宿主 getModelDefaults 的投影）。 */
export interface ModelSelectionView {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelDefaultsView {
  workspaceKey: string
  /** 新建中枢会话的默认模型；缺省=跟随宿主默认。 */
  hub?: ModelSelectionView
  /** 新派发分支会话的默认模型；缺省=跟随话题集/中枢/宿主默认。 */
  branch?: ModelSelectionView
  source: 'stored' | 'default'
}

/** R45: 设置页签「已生成的 skills」快照（宿主 listSkills 的投影）。 */
export interface SkillView {
  name: string
  title: string
  description: string
  whenToUse?: string
  version: number
  useCount: number
  enabled: boolean
  status: 'active' | 'retired'
  path: string
  source?: string
  occurrences: number
  updatedAt: number
  changelog: string[]
}

export interface ToolView {
  id: string
  name: string
  title: string
  tags: string[]
  description: string
  steps: string[]
  parameters: string[]
  useCount: number
  status: string
  live: boolean
  /**
   * R22 需求③: the capability's own definition, so the panel can render a
   * detail view (entry / doc / scope / routing / how it runs) instead of only
   * the description. Sequence tools leave these empty.
   */
  kind?: 'sequence' | 'capability' | 'knowledge' | 'proposal'
  /** R50: 逻辑名（工具名/skill 名之外的稳定名）。 */
  logicalName?: string
  entry?: string
  doc?: string
  scope?: string
  runnable?: boolean
  dryRunArg?: string
  writeConfirm?: boolean
  routeNote?: string
  /** R50 统一能力：入口草稿（未验证）、启停、知识面文件与统计。 */
  entryDraft?: string
  entryVerified?: boolean
  enabled?: boolean
  loadCount?: number
  runCount?: number
  loadsToRuns?: number
  successRate?: number
  successCount?: number
  failCount?: number
  consecutiveFailures?: number
  lastStatus?: 'completed' | 'failed'
  lastUsedAt?: number
  lastDryRun?: boolean
  lastSummary?: string
  skillPath?: string
  /** R52: knowledge-face body (frontmatter stripped) for the panel editor. */
  body?: string
  source?: string
  taskKey?: string
  proposalStatus?: 'pending' | 'accepted' | 'declined'
  expiresAt?: number
  /** R22: maintenance signals mirrored from the host's capabilityHealthOf. */
  builtin?: boolean
  builtinVersion?: number
  scopeMissing?: boolean
  docMissing?: boolean
  notes?: string[]
  /** R26: 能力定义版本与使用明细（面板能力卡片展示）。 */
  version?: number
  /** R28 需求②: 能力增加时间（ms epoch；宿主 listTools 透出，缺省时面板显示 —）。 */
  createdAt?: number
  usage?: {
    useCount: number
    successCount: number
    failCount: number
    consecutiveFailures: number
    lastUsedAt?: number
    lastStatus?: 'completed' | 'failed'
    lastDryRun?: boolean
    lastExitCode?: number
    lastSummary?: string
  }
}

/** One agent-preset row of the host roster (hub quick launcher). */
export interface AgentPresetView {
  id: string
  name?: string
  description?: string
  isDefault: boolean
}

/** Runtime provider/model catalog (hub quick launcher). */
export interface ModelCatalogView {
  providers: Array<{ id: string; name: string }>
  models: Array<{ provider: string; id: string; name: string }>
}

/** One permission-preset option of the host catalog (hub quick launcher). */
export interface PermissionPresetView {
  value: string
  name: string
  description?: string
}

/** The host permission catalog (hub quick launcher). */
export interface PermissionCatalogView {
  options: PermissionPresetView[]
  defaultPreset: string
}

/** Quick-launcher choices applied to the created session (R7). */
export interface SessionOptions {
  agentPreset?: string
  model?: { provider: string; model: string; reasoningEffort?: string }
  permission?: string
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

/**
 * Sidebar badge projection for one session (mirrors the host SessionBadge):
 * a topic-set branch with the set it belongs to, a topic-set hub, a plugin hub
 * session, or an explicit "no badge".
 */
export type SessionBadge =
  | { kind: 'hub' }
  /** R19 需求③: hub conversation that is the root member of a topic set. */
  | { kind: 'hub-set'; topicSetId: string; topicSetTitle: string }
  | { kind: 'branch'; topicSetId: string; topicSetTitle: string; status: string }
  /**
   * R31 需求②: no badge — a plugin branch that has not joined a topic set yet,
   * or an id the plugin cannot classify. The sidebar renders nothing.
   */
  | { kind: 'none' }

/**
 * R18 需求①: one row of the panel's left rail. A hub session is a top-level
 * session of this workspace that belongs to no topic set — the mirror of a
 * dispatched branch.
 */
export interface HubSessionView {
  sessionId: string
  title: string
  live: boolean
  updatedAt: number
  createdAt: number
  origin: 'hub'
  /** R19 需求①: the row's workspace (filtered by the selected workspace). */
  cwd: string
  workspaceKey: string
  /** R19 需求③: set this hub belongs to as its root conversation. */
  topicSetId?: string
  topicSetTitle?: string
  /** R19 协同②: how many branches this hub started (and how many are working). */
  branches: number
  workingBranches: number
}

/**
 * R19 协同②: one branch of a hub, projected from the durable dispatch table.
 * The same shape is returned by the host's `listHubBranches`; `shared` means
 * more than one hub dispatched into the branch (跨中枢共享, requirement ③).
 */
export interface HubBranchView {
  branchSessionId: string
  title: string
  /** R30 需求④: 分支标签（话题集标签 + 轮次 + 任务性质 + 能力档位）。 */
  tags: string[]
  task: string
  hubSessionId: string
  topicSetId?: string
  topicSetTitle?: string
  status: 'working' | 'idle' | 'failed'
  openDispatches: number
  dispatches: number
  groupId?: string
  lastActivityAt: number
  hubs: string[]
  shared: boolean
}

/** R19 需求⑤: one chat row inside the panel. */
export interface SessionMessageView {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  at: number
}

/** R19 需求⑤: the panel's read/send view of one session. */
export interface SessionChatView {
  sessionId: string
  title: string
  live: boolean
  messages: SessionMessageView[]
  truncated: boolean
  note?: string
}

/**
 * R22 需求③: one composite tool / capability rendered as readable detail rows.
 * Every field comes from the host (panel.listTools now ships routeNote /
 * builtin / scopeMissing / docMissing / notes); a missing field is simply
 * omitted — never printed as "undefined".
 */
function kindLabel(
  kind: ToolView['kind'] | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (kind === 'capability') return t('tool.kind.capability')
  if (kind === 'knowledge') return t('tool.kind.knowledge')
  if (kind === 'proposal') return t('tool.kind.proposal')
  return t('tool.kind.sequence')
}

function capabilityDetail(
  tool: ToolView,
  t: (key: string, params?: Record<string, string | number>) => string,
): ReactNode[] {
  const rows: ReactNode[] = []
  const row = (key: string, label: string, value: ReactNode): void => {
    rows.push(h('div', { key, className: 'sm-kv' },
      h('span', { key: 'k', className: 'sm-kv-k' }, label),
      h('span', { key: 'v', className: 'sm-kv-v' }, value),
    ))
  }
  const code = (key: string, value: string): ReactNode => h('code', { key, className: 'sm-code' }, value)
  row('kind', t('tool.detail.kind'), kindLabel(tool.kind, t))
  if (tool.version !== undefined) {
    row('version', t('tool.detail.version'),
      `v${tool.version}`
      + (tool.builtin && tool.builtinVersion !== undefined
        ? ` · ${t('tool.detail.builtin', { version: tool.builtinVersion })}`
        : ''))
  }
  // R28 需求②: 生命周期时间戳——增加时间与最后使用时间，缺字段显示 —。
  if (tool.createdAt !== undefined || tool.usage?.lastUsedAt !== undefined) {
    row('created', t('tool.detail.created'), fmtTime(tool.createdAt))
    row('lastUsed', t('tool.detail.lastUsed'), fmtTime(tool.usage?.lastUsedAt))
  }
  if (tool.entry) row('entry', t('tool.detail.entry'), code('code', tool.entry))
  if (tool.entryDraft) {
    row('entryDraft', t('tool.detail.entryDraft'),
      h('span', null, code('code', tool.entryDraft),
        tool.entryVerified ? null : h('span', { key: 'w', className: 'sm-warn' }, t('tool.detail.unverified'))))
  }
  if (tool.skillPath) row('skill', t('tool.detail.skill'), code('code', tool.skillPath))
  if (tool.kind === 'proposal' && tool.expiresAt !== undefined) row('expires', t('tool.detail.expires'), fmtTime(tool.expiresAt))
  if (tool.doc) {
    row('doc', t('tool.detail.doc'),
      h('span', null, code('code', tool.doc),
        tool.docMissing ? h('span', { key: 'w', className: 'sm-warn' }, t('tool.detail.missing')) : null))
  }
  if (tool.scope) {
    row('scope', t('tool.detail.scope'),
      h('span', null, code('code', tool.scope),
        tool.scopeMissing ? h('span', { key: 'w', className: 'sm-warn' }, t('tool.detail.missing')) : null))
  }
  if (tool.routeNote) row('route', t('tool.detail.route'), tool.routeNote)
  if (tool.kind === 'capability') {
    const how = tool.runnable === false
      ? t('tool.detail.noRun')
      : [
          tool.dryRunArg ? `${t('tool.detail.dryRun')}（${tool.dryRunArg}）` : t('tool.detail.realRun'),
          tool.writeConfirm ? t('tool.detail.confirm') : null,
        ].filter(Boolean).join(' · ')
    row('run', t('tool.detail.run'), how)
  }
  const usage = tool.usage
  const stats = [
    `${t('tool.runCount')} ${tool.runCount ?? tool.useCount}`,
    `${t('tool.loadCount')} ${tool.loadCount ?? 0}`,
    `${t('tool.conversion')} ${tool.loadsToRuns ?? 0}`,
    `${t('tool.successRate')} ${tool.successRate ?? 0}`,
    usage ? `${t('tool.detail.success')} ${usage.successCount} / ${t('tool.detail.fail')} ${usage.failCount}` : null,
    usage && usage.consecutiveFailures >= 2 ? `${t('tool.detail.streak')} ${usage.consecutiveFailures}` : null,
    usage?.lastStatus
      ? `${t('tool.detail.last')} ${usage.lastStatus === 'completed' ? t('tool.detail.ok') : t('tool.detail.failed')}${usage.lastDryRun ? `（${t('tool.detail.preview')}）` : ''}`
      : null,
  ].filter(Boolean).join(' · ')
  row('stats', t('tool.detail.stats'), stats)
  if (usage?.lastSummary) row('lastSummary', t('tool.detail.lastSummary'), usage.lastSummary)
  if (tool.notes && tool.notes.length > 0) {
    rows.push(h('div', { key: 'notes', className: 'sm-kv' },
      h('span', { key: 'k', className: 'sm-kv-k' }, t('tool.detail.health')),
      h('ul', { key: 'v', className: 'sm-kv-v sm-notes' },
        tool.notes.map((note, index) => h('li', { key: index }, note))),
    ))
  }
  if (tool.steps.length > 0) row('steps', t('tool.steps'), tool.steps.join(' → '))
  if (tool.parameters.length > 0) row('params', t('tool.params'), tool.parameters.join('、'))
  return rows
}

/** R18 需求②: title/tags the host derives from a memory body. */
export interface MemoryShape {
  title: string
  tags: string[]
}

/** Injected face: host-panel calls plus navigation, built in apply(). */
export interface PanelApi {
  loadHub(cwd: string, sessionId: string): Promise<HubState>
  listMemories(cwd: string, query?: string): Promise<MemoryView[]>
  // R30 需求②: 记忆页签两级页（集合卡片 → 集合内条目 → 记忆详情/历史）。
  listMemoryCollections(cwd: string): Promise<MemoryCollectionView[]>
  listMemoriesByCollection(cwd: string, collectionId: string, query?: string): Promise<MemoryView[]>
  getMemoryDetail(cwd: string, id: string): Promise<MemoryDetailView | undefined>
  // R36 需求②: 「中枢权限」设置——白名单快照 / 保存（含 reset 恢复默认）。
  getHubPolicy(cwd: string): Promise<HubPolicyView>
  setHubPolicy(cwd: string, patch: { tools?: string[]; prefixes?: string[]; reset?: boolean }): Promise<MutationResult>
  cleanupStaleHubPolicy(cwd: string): Promise<MutationResult>
  // R41 需求①b: 设置页签的默认模型（中枢会话 / 分支会话，按工作区）。
  getModelDefaults(cwd: string): Promise<ModelDefaultsView>
  setModelDefaults(cwd: string, patch: { hub?: ModelSelectionView | null; branch?: ModelSelectionView | null; reset?: boolean }): Promise<MutationResult>
  // R45: 设置页签「已生成的 skills」——快照 / 启用停用 / 改路由描述。
  listSkills(cwd: string): Promise<SkillView[]>
  updateSkill(cwd: string, name: string, patch: { enabled?: boolean; description?: string }): Promise<MutationResult>
  createMemory(cwd: string, text: string, key?: string, title?: string, tags?: string[]): Promise<MutationResult>
  updateMemory(cwd: string, id: string, text: string, key?: string, title?: string, tags?: string[]): Promise<MutationResult>
  deleteMemory(cwd: string, id: string): Promise<MutationResult>
  setMemoryStatus(cwd: string, id: string, status: string): Promise<MutationResult>
  createTopicSet(cwd: string, title: string, tags?: string[], summary?: string): Promise<MutationResult>
  activate(sessionId: string, topicSetId: string): Promise<boolean>
  updateTopicSetSummary(id: string, summary: string, tags?: string[]): Promise<MutationResult>
  createTopicSetSession(cwd: string, ids: string[], options?: SessionOptions, firstMessage?: string): Promise<MutationResult>
  createHubSession(cwd: string, options?: SessionOptions, firstMessage?: string): Promise<MutationResult>
  followupTopicSet(cwd: string, topicSetId: string, text: string): Promise<MutationResult>
  listTools(cwd?: string): Promise<ToolView[]>
  editTool(id: string, patch: Record<string, unknown>): Promise<MutationResult>
  deleteTool(id: string): Promise<MutationResult>
  /** R50: 预演/执行能力（默认预演；writeConfirm 需 options.confirm=true）。 */
  runTool(id: string, options?: { dryRun?: boolean; confirm?: boolean }): Promise<{
    status: 'completed' | 'failed' | 'needs-confirm'
    exitCode?: number
    stdout: string
    stderr: string
    durationMs: number
    dryRun: boolean
    command: string
    summary: string
  }>
  /** R50: 接受/拒绝待处理提案。 */
  acceptProposal(cwd: string, id: string): Promise<MutationResult>
  declineProposal(cwd: string, id: string): Promise<MutationResult>
  sessionBadge(sessionId: string): Promise<SessionBadge>
  listHubSessions(cwd: string): Promise<HubSessionView[]>
  /** R19 协同②: the branches one hub started (name / state / set / shared). */
  listHubBranches(cwd: string, hubSessionId: string, limit?: number): Promise<HubBranchView[]>
  /**
   * R30 需求③: every topic set of the workspace (archived included) — the hub's
   * management view — and every branch session across sets (optionally filtered
   * to one topic set). Both are durable-ledger reads (no live handle needed).
   */
  listAllTopicSets(cwd: string): Promise<TopicSetView[]>
  listAllBranches(cwd: string, topicSetId?: string, limit?: number): Promise<HubBranchView[]>
  readSessionMessages(sessionId: string, limit?: number): Promise<SessionChatView>
  sendSessionMessage(sessionId: string, text: string): Promise<MutationResult>
  suggestMemoryShape(text: string): Promise<MemoryShape>
  /** R18: drop the sidebar badge cache after a refresh / dispatch receipt. */
  invalidateBadges(sessionId?: string): void
  openSession(sessionId: string): void
  startSession(): void
  loadTopicSets(cwd: string): Promise<TopicSetView[]>
  listAgentPresets(): Promise<AgentPresetView[]>
  listModelCatalog(): Promise<ModelCatalogView>
  listPermissions(): Promise<PermissionCatalogView>
}

export interface PanelPageProps {
  useWorkspaces: <S>(selector: (state: { items: Array<{ id: string; path: string; title?: string }> }) => S) => S
  useSessions: <S>(selector: (state: { byId: Record<string, { id: string; retainedBy?: { mainView?: number } }> }) => S) => S
  t: (key: string, params?: Record<string, string | number>) => string
  api: PanelApi
}

type View =
  | { kind: 'hub' }
  | { kind: 'sets' }
  | { kind: 'topic'; id: string }
  // R44 需求②: 全部分支会话（跨话题集）独立页签——原「中枢会话」页签里的
  // 「全部分支会话」卡移到这里，避免中枢页签塞满管理视图。
  | { kind: 'branches' }
  | { kind: 'memories' }
  // R30 需求②: 记忆两级页——集合内条目 / 单条记忆详情（含历史版本）。
  | { kind: 'memory-collection'; id: string }
  | { kind: 'memory-detail'; id: string }
  | { kind: 'tools' }
  // R36 需求② / R41 需求①a: 「设置」页签（默认模型 + 中枢权限，单一入口）。
  | { kind: 'settings' }
  | { kind: 'chat'; id: string }

const PANEL_CSS = `
/* R18 需求⑥: 8px grid, 10px cards, hover lift, underline tabs, compact head.
   Every colour rides the host theme vocabulary (--dsw-alias-*), never a
   hardcoded palette: the panel must follow light/dark like the shell. */
.sm-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-bg-base,#151517);font-size:13px}
.sm-panel *{box-sizing:border-box}
.sm-shell{display:flex;height:100%;min-height:0;width:100%}

/* ---- R41: settings section headings (默认模型 / 中枢权限) ---- */
.sm-section-title{font-size:11px;font-weight:600;letter-spacing:.04em;opacity:.6;margin:4px 0 0}

/* ---- left rail: hub sessions (R18 需求①) ---- */
.sm-side{display:flex;flex-direction:column;gap:8px;width:232px;flex:none;min-height:0;padding:12px 8px;border-right:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-1,#1c1c1e)}
.sm-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 6px;font-size:11px;font-weight:600;letter-spacing:.04em;opacity:.55}
.sm-side-count{font-weight:400;letter-spacing:0}
.sm-side-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px}
.sm-hub{display:flex;align-items:center;gap:6px;width:100%;padding:7px 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font-family:inherit;font-size:12px;text-align:left;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.sm-hub:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.sm-hub[data-current="true"]{border-color:var(--dsw-alias-link,#7aaaff);background:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 14%,transparent)}
.sm-hub-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-hub-meta{font-size:9px;opacity:.6;flex:none;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-hub-set{color:var(--dsw-alias-link,#7aaaff);opacity:.85}
.sm-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 18%,transparent)}
.sm-side-empty{padding:10px 8px;font-size:11px;line-height:1.5;opacity:.5}
.sm-side-foot{margin-top:auto;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
.sm-newhub{width:100%;justify-content:center}

/* ---- right body ---- */
.sm-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.sm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
.sm-brand{font-size:13px;font-weight:650;letter-spacing:.01em}
.sm-head-sub{font-size:11px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.sm-pills{display:flex;align-items:center;gap:4px;margin-left:auto;flex-wrap:wrap}
.sm-pill{padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));font-size:10px;line-height:16px;opacity:.75;white-space:nowrap}
.sm-tabs{display:flex;align-items:stretch;gap:4px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));overflow-x:auto}
.sm-tab{padding:8px 10px;border:none;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:inherit;opacity:.62;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap;margin-bottom:-1px;transition:opacity .12s ease,border-color .12s ease}
.sm-tab:hover{opacity:.9;background:transparent}
.sm-tab[data-active="true"]{opacity:1;border-bottom-color:var(--dsw-alias-link,#7aaaff);font-weight:600;background:transparent}
.sm-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 20px}

/* ---- surfaces ---- */
.sm-card{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;padding:10px 12px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1,#1f1f21);transition:border-color .12s ease,box-shadow .12s ease}
.sm-card:hover,.sm-item:hover{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.2))}
.sm-card h3{margin:0 0 6px;font-size:12.5px;font-weight:600;opacity:.9}
.sm-item{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,#1f1f21);transition:border-color .12s ease,transform .12s ease,box-shadow .12s ease}
.sm-item[data-clickable="true"]{cursor:pointer}
.sm-item[data-clickable="true"]:hover{border-color:var(--dsw-alias-link,#7aaaff);box-shadow:0 2px 10px rgba(0,0,0,.18)}
/* R36 需求②: 「中枢权限」开关行——label 即整行，checkbox 与标题同一基线；
   锁定行置灰且禁点，风险/锁定徽标跟在标题后。 */
.sm-item:has(> input[type="checkbox"]){display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer}
.sm-item:has(> input[type="checkbox"]:disabled){opacity:.62;cursor:not-allowed}
.sm-item > input[type="checkbox"]{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-link,#7aaaff);cursor:inherit}
.sm-item .sm-title{font-weight:600;font-size:12.5px}
.sm-item .sm-sub{opacity:.58;font-size:11px;margin-top:2px;word-break:break-all}
.sm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sm-muted{opacity:.58;font-size:11px}
.sm-list{display:flex;flex-direction:column;gap:8px}

/* ---- buttons: three levels (primary / secondary / danger), two sizes ---- */
.sm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:inherit;cursor:pointer;font-size:12px;font-family:inherit;line-height:1.4;transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.sm-btn:hover{border-color:var(--dsw-alias-link,#7aaaff)}
.sm-btn[data-size="sm"]{padding:3px 8px;font-size:11px;border-radius:7px}
.sm-btn[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill,#f9fafb);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#0f1115);font-weight:600}
.sm-btn[data-variant="primary"]:hover{background:var(--dsw-alias-button-primary-hover,#ebeef2);border-color:transparent}
.sm-btn[data-variant="danger"]{border-color:var(--dsw-alias-state-error-primary,#f25a5a);color:var(--dsw-alias-state-error-primary,#f25a5a);background:transparent}
.sm-btn[data-variant="danger"]:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f25a5a) 12%,transparent)}
.sm-btn:disabled{opacity:.45;cursor:default}

/* ---- fields ---- */
.sm-input,.sm-select,.sm-textarea{width:100%;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-specific-input-major,#2c2c2e);color:inherit;font-size:12px;font-family:inherit}
.sm-input:focus,.sm-select:focus,.sm-textarea:focus{outline:none;border-color:var(--dsw-alias-link,#7aaaff)}
.sm-textarea{min-height:56px;resize:vertical;line-height:1.5}
.sm-field{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.sm-field .sm-field-label{font-size:11px;opacity:.55}
.sm-check{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:8px;cursor:pointer;font-size:12px}
.sm-check:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.sm-form{display:flex;gap:8px;margin-bottom:8px}
.sm-form .sm-input{flex:1}
.sm-form-col{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.sm-form-row{display:flex;gap:8px;flex-wrap:wrap}
.sm-form-row .sm-input{flex:1;min-width:120px}
.sm-form-label{font-size:11px;opacity:.55}
.sm-back{margin-bottom:8px}

/* ---- feedback ---- */
.sm-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.sm-error{color:var(--dsw-alias-state-error-primary,#f25a5a);font-size:12px;padding:8px 0}
.sm-ok{color:var(--dsw-alias-state-success-primary,#22c55e);font-size:12px;padding:4px 0}
.sm-badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;line-height:16px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));opacity:.8;margin-right:4px}
.sm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:28px 12px;text-align:center;opacity:.6}
.sm-empty-art{opacity:.5;margin-bottom:2px}
.sm-empty-label{font-size:12px}
.sm-empty-hint{font-size:11px;opacity:.75;max-width:280px;line-height:1.5}
.sm-shape-hint{font-size:11px;opacity:.55;margin-top:-2px}

/* ---- composer (hub tab) ---- */
.sm-composer{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:12px;padding:14px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1,#1f1f21)}
.sm-composer-head{margin-bottom:10px}
.sm-composer-title{margin:0 0 4px;font-size:16px;font-weight:650}
.sm-composer-desc{margin:0;font-size:11.5px;opacity:.58;line-height:1.55}
.sm-composer-input{width:100%;min-height:92px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-specific-input-major,#2c2c2e);color:inherit;font-size:13px;font-family:inherit;resize:vertical;line-height:1.55}
.sm-composer-input:focus{outline:none;border-color:var(--dsw-alias-link,#7aaaff)}
.sm-composer-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.sm-composer-opts{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.sm-opt{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:999px;background:transparent;font-size:11px}
.sm-opt-label{opacity:.55;font-size:11px;white-space:nowrap}
.sm-opt-select{border:none;background:transparent;color:inherit;font-size:11px;padding:1px 2px;max-width:160px}
.sm-opt-select:focus{outline:none}
.sm-composer-sets{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.sm-chip{padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:transparent;color:inherit;font-size:11px;cursor:pointer;font-family:inherit}
.sm-chip:hover{border-color:var(--dsw-alias-link,#7aaaff)}
.sm-chip[data-active="true"]{border-color:var(--dsw-alias-link,#7aaaff);background:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 14%,transparent)}
.sm-chip[data-dashed="true"]{border-style:dashed;opacity:.75}
.sm-set-created{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;font-size:11px;opacity:.85}
.sm-receipt{border:1px solid var(--dsw-alias-link,#7aaaff);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 8%,transparent)}
.sm-receipt .sm-sub{margin-top:4px}

/* ---- retrieval shape: title + tags + body ---- */
.sm-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.sm-tag{padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));font-size:10px;opacity:.85;line-height:16px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-tag[data-hit="true"]{border-color:var(--dsw-alias-link,#7aaaff);color:var(--dsw-alias-link,#7aaaff);opacity:1}
.sm-body-text{margin-top:4px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sm-body-text[data-open="true"]{-webkit-line-clamp:unset;overflow:visible}

/* ---- R22: 派发卡片（需求②）与能力详情（需求③） ---- */
.sm-dispatch h3{margin:0}
.sm-dispatch .sm-composer-opts{margin-top:8px}
.sm-dispatch .sm-actions{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1))}
.sm-caret{flex:none;width:10px;font-size:10px;opacity:.55;text-align:center}
.sm-detail{display:flex;flex-direction:column;gap:3px;margin:8px 0 2px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
.sm-kv{display:flex;align-items:flex-start;gap:8px;font-size:11.5px;line-height:1.65}
.sm-kv-k{flex:none;width:74px;opacity:.55}
.sm-kv-v{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap}
.sm-code{display:inline-block;padding:0 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,#2c2c2e);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;word-break:break-all}
.sm-notes{margin:0;padding-left:15px}
.sm-warn{margin-left:4px;font-size:10.5px;color:var(--dsw-alias-state-error-primary,#f25a5a)}
/* ---- R39: dynamic hub-policy catalog (source groups, collapse, stale) ---- */
.sm-chevbtn{flex:none;background:none;border:0;padding:0;margin:0;color:inherit;font:inherit;font-size:11px;opacity:.6;cursor:pointer;line-height:1}
.sm-chevbtn:hover{opacity:1}
.sm-desc{flex:1 1 100%;font-size:11px;line-height:1.5;opacity:.58;word-break:break-word;margin-top:2px}
.sm-warnbox{margin-top:6px;padding:6px 9px;border:1px solid var(--dsw-alias-state-warning-primary,#e8a33d);border-radius:8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-warning-primary,#e8a33d);word-break:break-word}

/* ---- R19: global workspace selector, in-panel chat, memory modal ---- */
.sm-ws{display:inline-flex;align-items:center;gap:5px;font-size:11px;opacity:.9;min-width:0}
.sm-ws-select{max-width:280px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:999px;background:transparent;color:inherit;font-size:11px;padding:2px 7px;font-family:inherit}
.sm-ws-select:focus{outline:none;border-color:var(--dsw-alias-link,#7aaaff)}
.sm-chat{display:flex;flex-direction:column;gap:8px}
.sm-chat-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));margin-bottom:4px}
.sm-msg{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1f1f21)}
.sm-msg[data-role="user"]{border-color:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-link,#7aaaff) 7%,transparent)}
.sm-msg[data-role="tool"]{opacity:.72}
.sm-msg-role{font-size:10px;opacity:.55;letter-spacing:.04em}
.sm-msg-text{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.6}
.sm-msg[data-role="tool"] .sm-msg-text{font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.sm-chat-bar{display:flex;align-items:flex-end;gap:8px;margin-top:8px}
.sm-chat-bar textarea{flex:1;min-height:60px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-specific-input-major,#2c2c2e);color:inherit;font-family:inherit;font-size:12.5px;resize:vertical;line-height:1.5}
.sm-chat-bar textarea:focus{outline:none;border-color:var(--dsw-alias-link,#7aaaff)}
.sm-modal-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.52)}
.sm-modal{width:min(560px,100%);max-height:82vh;overflow:auto;padding:14px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1f1f21);box-shadow:0 18px 48px rgba(0,0,0,.4)}
.sm-modal h3{margin:0 0 10px;font-size:14px;font-weight:650}
.sm-modal-hint{font-size:11px;opacity:.58;line-height:1.55;margin:-4px 0 10px}

/* ---- narrow windows: the rail folds into a horizontal strip ---- */
@media (max-width:760px){
  .sm-shell{flex-direction:column}
  .sm-side{width:auto;flex:none;flex-direction:row;align-items:center;gap:8px;padding:8px;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));overflow:hidden}
  .sm-side-head{padding:0;white-space:nowrap}
  .sm-side-count{display:none}
  .sm-side-list{flex-direction:row;overflow-x:auto;overflow-y:hidden;gap:6px;min-width:0}
  .sm-hub{width:auto;max-width:180px;flex:none}
  .sm-side-foot{margin:0;padding:0;border:none;flex:none}
  .sm-newhub{width:auto;white-space:nowrap}
  .sm-body{padding:10px 12px 16px}
}
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
  size?: 'sm'
  disabled?: boolean
  title?: string
  className?: string
}): ReactElement {
  return h('button', {
    type: 'button',
    className: ['sm-btn', props.className].filter(Boolean).join(' '),
    'data-variant': props.variant,
    'data-size': props.size,
    disabled: props.disabled,
    title: props.title,
    onClick: props.onClick,
  }, props.label)
}

/**
 * R18 需求⑥: illustration-style empty state. A tiny inline SVG (drawn with the
 * theme's own label colour) replaces the bare "暂无" line everywhere.
 */
function EmptyState(props: { label: string; hint?: string }): ReactElement {
  return h('div', { className: 'sm-empty' },
    h('svg', {
      key: 'art', className: 'sm-empty-art', width: 48, height: 48, viewBox: '0 0 48 48',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
      strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
    },
      h('rect', { key: 'a', x: 9, y: 13, width: 30, height: 23, rx: 4 }),
      h('path', { key: 'b', d: 'M9 20h30' }),
      h('circle', { key: 'c', cx: 15, cy: 17, r: 1.4, fill: 'currentColor', stroke: 'none' }),
      h('path', { key: 'd', d: 'M16 27h12' }),
      h('path', { key: 'e', d: 'M16 31h8' }),
    ),
    h('div', { key: 'label', className: 'sm-empty-label' }, props.label),
    props.hint ? h('div', { key: 'hint', className: 'sm-empty-hint' }, props.hint) : null,
  )
}

/** R19 协同②: coarse relative time for branch cards, localized (no date lib). */
function branchAgo(at: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const delta = Math.max(0, Date.now() - at)
  if (delta < 60_000) return t('branches.ago.just')
  if (delta < 3_600_000) return t('branches.ago.min', { count: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('branches.ago.hour', { count: Math.floor(delta / 3_600_000) })
  return t('branches.ago.day', { count: Math.floor(delta / 86_400_000) })
}

/**
 * R28 需求②: local YYYY-MM-DD HH:mm for the capability lifecycle timestamps
 * (增加时间 / 最后使用). A missing or nonsensical value renders '—' — the host
 * ships these fields from R28 on, older hosts simply leave them undefined.
 */
function fmtTime(at?: number): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * R19 协同②: the hub's linked branches. One card, every consumer (hub tab and
 * the in-panel chat of a hub) passes its own rows; a branch row opens that
 * branch's conversation in the panel.
 */
function BranchList(props: {
  rows: HubBranchView[]
  t: (key: string, params?: Record<string, string | number>) => string
  onOpen: (sessionId: string) => void
  compact?: boolean
}): ReactElement {
  // Defensive: a host/remote failure must never blank the panel (an older host
  // may answer a non-array), so the list renders its empty state instead.
  const rows = Array.isArray(props.rows) ? props.rows : []
  const { t, onOpen } = props
  return h('div', { key: 'branches', className: 'sm-card' },
    h('div', { key: 'head', className: 'sm-row' },
      h('h3', { key: 'title' }, t('branches.title')),
      h('span', { key: 'count', className: 'sm-badge' }, String(rows.length)),
    ),
    rows.length === 0
      ? h(EmptyState, { key: 'empty', label: t('branches.empty'), hint: props.compact ? undefined : t('branches.empty.hint') })
      : h('div', { key: 'list', className: 'sm-list' },
          rows.map((row) =>
            h('div', {
              key: row.branchSessionId, className: 'sm-item', 'data-clickable': 'true',
              title: `${row.title} · ${row.branchSessionId}`,
              onClick: () => onOpen(row.branchSessionId),
            },
              h('div', { key: 'row', className: 'sm-row' },
                h('span', { key: 'title', className: 'sm-title' }, row.title),
                h('span', { key: 'state', className: 'sm-badge', 'data-state': row.status }, t(`branches.${row.status}`)),
                row.shared
                  ? h('span', { key: 'shared', className: 'sm-badge', title: row.hubs.join('、') }, t('branches.shared', { count: row.hubs.length - 1 }))
                  : null,
                row.groupId ? h('span', { key: 'grp', className: 'sm-badge' }, t('branches.group')) : null,
              ),
              h('div', { key: 'meta', className: 'sm-sub' },
                `${row.topicSetTitle ? t('branches.set', { title: row.topicSetTitle }) : t('branches.noSet')} · `
                + `${branchAgo(row.lastActivityAt, t)} · ${t('branches.dispatches', { count: row.dispatches })}`,
              ),
              // R30 需求④: 分支标签（话题集标签 + 轮次 + 任务性质 + 能力档位）。
              row.tags && row.tags.length > 0 ? tagChips(row.tags) : null,
              h('div', { key: 'id', className: 'sm-sub' }, row.branchSessionId),
            ),
          ),
        ),
  )
}

/** Tag chips: the record's index fields, rendered beside the title. */
function tagChips(tags: string[], needle = ''): ReactElement | null {
  const list = (tags ?? []).filter(Boolean)
  if (list.length === 0) return null
  const lowered = needle.trim().toLowerCase()
  return h('div', { className: 'sm-tags' },
    list.map((tag) =>
      h('span', {
        key: tag,
        className: 'sm-tag',
        'data-hit': String(lowered.length > 0 && tag.toLowerCase().includes(lowered)),
        title: tag,
      }, tag),
    ),
  )
}

/** Split a tag input ("a，b c" / "a,b") into the array the host expects. */
function splitTags(raw: string): string[] {
  return String(raw ?? '').split(/[,，、;；\s]+/).map((tag) => tag.trim()).filter(Boolean)
}

/** Client-side title fallback for records written before titles existed. */
function deriveTitleClient(body: string): string {
  const clean = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const clause = clean.split(/[。！？；;.!?]/)[0]?.trim() || clean
  return clause.length <= 48 ? clause : `${clause.slice(0, 47)}…`
}

/** The SuperMemory main panel page. */
export function SupermemoryPanelPage(props: PanelPageProps): ReactElement {
  installCss()
  const { t, api } = props
  const [view, setView] = useState<View>({ kind: 'hub' })
  const [hub, setHub] = useState<HubState | undefined>()
  // R30 需求②: 记忆两级页的状态——第一级集合卡片、第二级集合内条目、
  // 第三级单条记忆详情（当前版本 + 历史版本）。
  const [memoryCollections, setMemoryCollections] = useState<MemoryCollectionView[]>([])
  const [collectionMemories, setCollectionMemories] = useState<MemoryView[]>([])
  const [memoryDetail, setMemoryDetail] = useState<MemoryDetailView | undefined>()
  // R36 需求②: 「设置」页签的中枢权限——宿主快照 + 本地草稿（勾选态只在保存时写回）。
  const [hubPolicy, setHubPolicy] = useState<HubPolicyView | undefined>()
  const [hubPolicyDraft, setHubPolicyDraft] = useState<{ tools: string[]; prefixes: string[] } | undefined>()
  const [hubPolicyCustom, setHubPolicyCustom] = useState('')
  // R39: 动态目录的本地视图状态——跨来源搜索与按组折叠（勾选态仍在草稿里）。
  const [hubPolicyQuery, setHubPolicyQuery] = useState('')
  const [hubPolicyCollapsed, setHubPolicyCollapsed] = useState<string[]>([])
  // R41 需求①b: 设置页签的默认模型（"provider/model" 文本，''=跟随默认）。
  const [modelDefaults, setModelDefaults] = useState<ModelDefaultsView | undefined>()
  const [hubModelDraft, setHubModelDraft] = useState('')
  // R45: 设置页签的 skills 快照 + 每条描述的行内草稿。
  const [skills, setSkills] = useState<SkillView[]>([])
  const [skillDrafts, setSkillDrafts] = useState<Record<string, string>>({})
  const [branchModelDraft, setBranchModelDraft] = useState('')
  const [tools, setTools] = useState<ToolView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  // R30 需求②: 第一级的集合搜索（与第二级的条目搜索分开：前者在本地过滤卡片，
  // 后者由宿主按标题/标签/正文打分过滤）。
  const [memoryQuery, setMemoryQuery] = useState('')
  // R11: the 话题集 tab filters on title + tags (never on every body), so a
  // workspace with many topic sets stays searchable by index.
  const [setsQuery, setSetsQuery] = useState('')
  const [reply, setReply] = useState('')
  const [summaryDraft, setSummaryDraft] = useState<string | undefined>()
  const [summaryTagsDraft, setSummaryTagsDraft] = useState<string[] | undefined>()
  const [editingMemory, setEditingMemory] = useState<{ id: string; title: string; tags: string[]; text: string; key?: string } | undefined>()
  const [editingTool, setEditingTool] = useState<{ id: string; title: string; tags: string[]; description: string; body: string } | undefined>()
  const [confirmDeleteTool, setConfirmDeleteTool] = useState<string | undefined>()
  // R22 需求③: 固化能力可展开看完整定义（入口/文档/适用范围/路由/执行方式/健康度）。
  const [expandedTool, setExpandedTool] = useState<string | undefined>()
  // R27: 记忆删除不可恢复，和固化能力一样先就地问一次（内联两段确认），
  // 不再一点就永久删除。
  const [confirmDeleteMemory, setConfirmDeleteMemory] = useState<string | undefined>()
  // R30 需求②: 详情页里展开的历史版本（key = `<memoryId>:<version>`）。
  const [expandedVersion, setExpandedVersion] = useState<string | undefined>()
  // R7 quick launcher (中枢会话页签): the new-session-page choices — workspace,
  // agent preset, model, permission — beside the topic-set selection.
  const [presets, setPresets] = useState<AgentPresetView[]>([])
  const [catalog, setCatalog] = useState<ModelCatalogView | undefined>()
  const [permissions, setPermissions] = useState<PermissionCatalogView | undefined>()
  // R19 需求②: ONE workspace source for the whole panel (left rail, hub tab,
  // launcher, memories/topic sets). The old `launchWorkspace` was a second,
  // independent selector; it is gone.
  const [workspacePath, setWorkspacePath] = useState('')
  const [launchPreset, setLaunchPreset] = useState('')
  const [launchModel, setLaunchModel] = useState('')
  const [launchPermission, setLaunchPermission] = useState('')
  const [launchSets, setLaunchSets] = useState<TopicSetView[]>([])
  const [launchSelected, setLaunchSelected] = useState<string[]>([])
  const [launchNewTitle, setLaunchNewTitle] = useState('')
  const [launching, setLaunching] = useState(false)
  // R8: the composer's opening message and the in-place launch receipt. The
  // hub tab no longer navigates to the shell's new-session page: the session
  // is created host-side, the message is delivered as its first turn, and the
  // receipt is rendered right below the composer.
  const [composerText, setComposerText] = useState('')
  const [showNewSet, setShowNewSet] = useState(false)
  const [receipt, setReceipt] = useState<{ id: string; message: string; kind: 'hub' | 'sets' } | undefined>()
  // R18 需求①: the left rail's hub sessions, refreshed together with the hub
  // state (a new session appears there without a page reload).
  const [hubs, setHubs] = useState<HubSessionView[]>([])
  // R19 协同②: hub → branches. `hubBranches` is the CURRENT session's list
  // (hub tab), `chatBranches` the viewed session's list (chat view), so both
  // surfaces answer "which branches did this hub start?".
  const [hubBranches, setHubBranches] = useState<HubBranchView[]>([])
  const [chatBranches, setChatBranches] = useState<HubBranchView[]>([])
  // R30 需求③ / R44 需求②: the hub manages EVERY topic set (archived included)
  // and views every branch across sets. `allSets` still feeds the topic-set
  // pickers (launch chips, topic view); `allBranches` now belongs to the
  // dedicated 「分支会话」 tab, with its own set filter + keyword search.
  const [allSets, setAllSets] = useState<TopicSetView[]>([])
  const [allBranches, setAllBranches] = useState<HubBranchView[]>([])
  const [branchFilter, setBranchFilter] = useState('')
  const [branchQuery, setBranchQuery] = useState('')
  // R18 需求②: the topic set just created (title + auto tags must be visible).
  const [createdSet, setCreatedSet] = useState<{ title: string; tags: string[] } | undefined>()
  // R19 需求⑤: the in-panel conversation (no navigation to the shell session).
  const [chatData, setChatData] = useState<SessionChatView | undefined>()
  const [chatDraft, setChatDraft] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState<string | undefined>()

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
  const cwd = useMemo(
    () => workspacePath || sessionCwd || workspaces[0]?.path || '',
    [workspacePath, sessionCwd, workspaces],
  )

  // Remember the last workspace, and never keep a path that is no longer open.
  useEffect(() => {
    if (workspacePath) {
      if (workspaces.length === 0 || workspaces.some((workspace) => workspace.path === workspacePath)) return
    }
    let remembered = ''
    try {
      remembered = localStorage.getItem('sm-panel-ws') || ''
    } catch { /* private mode: the in-memory default still works */ }
    const known = (path: string): boolean => workspaces.length === 0 || workspaces.some((workspace) => workspace.path === path)
    const next = remembered && known(remembered) ? remembered : (sessionCwd || workspaces[0]?.path || '')
    if (next) setWorkspacePath(next)
  }, [sessionCwd, workspacePath, workspaces])

  // A4: 跟随 shell 的工作区切换——主视图会话换到另一个工作区时面板随之切换，
  // 不停留在旧工作区的数据上（用户显式选择过的优先，直到再次发生切换）。
  const [lastSessionCwd, setLastSessionCwd] = useState('')
  useEffect(() => {
    if (!sessionCwd) return
    if (lastSessionCwd && lastSessionCwd !== sessionCwd) setWorkspacePath(sessionCwd)
    if (sessionCwd !== lastSessionCwd) setLastSessionCwd(sessionCwd)
  }, [sessionCwd, lastSessionCwd])

  /** Switch the panel's one workspace and reset every workspace-scoped view. */
  const changeWorkspace = useCallback((path: string): void => {
    if (!path || path === workspacePath) return
    setWorkspacePath(path)
    try {
      localStorage.setItem('sm-panel-ws', path)
    } catch { /* private mode */ }
    setHub(undefined)
    setHubs([])
    setHubBranches([])
    setChatBranches([])
    setAllSets([])
    setAllBranches([])
    setBranchFilter('')
    setLaunchSelected([])
    setLaunchSets([])
    setReceipt(undefined)
    setCreatedSet(undefined)
    // A3/A4: 工具列表也是工作区视图——切换时清空，由 refreshTools 按新 cwd 重拉。
    setTools([])
    // R30 需求②: 记忆两级页的数据同样是工作区视图，切换时清空重拉。
    setMemoryCollections([])
    setCollectionMemories([])
    setMemoryDetail(undefined)
    setChatData(undefined)
    setChatDraft('')
    setChatError(undefined)
    setView({ kind: 'hub' })
  }, [workspacePath])

  const refreshHub = useCallback(async () => {
    if (!cwd) return
    setLoading(true)
    setError(undefined)
    try {
      // R18 需求①: the rail rides the same refresh — hub sessions are created by
      // this very page, so a stale rail would hide the session just started.
      // R19 协同②: the current hub's branch list rides it too.
      // R30 需求③ / R44 需求②: 全部话题集（话题集筛选下拉与快速启动 chips 共用）
      // 与全部分支会话（「分支会话」页签）仍同路刷新，切页签即有新数据。
      const [state, hubRows, branchRows, setRows, allBranchRows] = await Promise.all([
        api.loadHub(cwd, sessionId),
        api.listHubSessions(cwd).then((rows) => rows, () => [] as HubSessionView[]),
        sessionId
          ? api.listHubBranches(cwd, sessionId).then((rows) => rows, () => [] as HubBranchView[])
          : Promise.resolve([] as HubBranchView[]),
        api.listAllTopicSets(cwd).then((rows) => rows, () => [] as TopicSetView[]),
        api.listAllBranches(cwd).then((rows) => rows, () => [] as HubBranchView[]),
      ])
      setHub(state)
      setHubs(hubRows)
      setHubBranches(branchRows)
      setAllSets(setRows)
      setAllBranches(allBranchRows)
      // R18 需求③: a refresh is exactly when membership may have changed.
      api.invalidateBadges()
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    } finally {
      setLoading(false)
    }
  }, [api, cwd, sessionId, t])

  // R30 需求②: 第一级——集合卡片（含条目数/最近更新，宿主聚合）。
  const refreshMemoryCollections = useCallback(async () => {
    if (!cwd) return
    try {
      setMemoryCollections(await api.listMemoryCollections(cwd))
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, t])

  // R30 需求②: 第二级——一个集合内的条目（'' = 未归集）。
  const refreshCollectionMemories = useCallback(async (collectionId: string) => {
    if (!cwd) return
    try {
      setCollectionMemories(await api.listMemoriesByCollection(cwd, collectionId, query.trim() || undefined))
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, query, t])

  // R30 需求②: 第三级——记忆详情（当前版本 + 历史版本）。
  const refreshMemoryDetail = useCallback(async (id: string) => {
    if (!cwd) return
    try {
      setMemoryDetail(await api.getMemoryDetail(cwd, id))
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, t])

  // R41 需求①b: 设置页签的默认模型快照；文本草稿与快照同步。
  const refreshModelDefaults = useCallback(async () => {
    if (!cwd) return
    try {
      const view = await api.getModelDefaults(cwd)
      setModelDefaults(view)
      setHubModelDraft(view.hub ? `${view.hub.provider}/${view.hub.model}` : '')
      setBranchModelDraft(view.branch ? `${view.branch.provider}/${view.branch.model}` : '')
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, t])

  // R45: 设置页签的已生成 skills；草稿只在拉到快照时重置，输入中不被覆盖。
  const refreshSkills = useCallback(async () => {
    if (!cwd) return
    try {
      const rows = await api.listSkills(cwd)
      setSkills(rows)
      setSkillDrafts(Object.fromEntries(rows.map((row) => [row.name, row.description])))
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, t])

  // R36 需求②: 设置页签的中枢权限数据——宿主快照拉到后同步为草稿（勾选态）。
  const refreshHubPolicy = useCallback(async () => {
    if (!cwd) return
    try {
      const view = await api.getHubPolicy(cwd)
      setHubPolicy(view)
      setHubPolicyDraft({ tools: [...view.tools], prefixes: [...view.prefixes] })
      setHubPolicyCustom('')
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, t])

  // R39: 只刷新目录（运行时工具可能在两次保存之间新增/卸载）——保留当前勾选
  // 草稿，刷新不等于放弃未保存的改动；catalogMeta.generatedAt 即"上次刷新"。
  const refreshHubPolicyCatalog = useCallback(async () => {
    if (!cwd) return
    try {
      const view = await api.getHubPolicy(cwd)
      setHubPolicy(view)
      setHubPolicyDraft((draft) => draft ?? { tools: [...view.tools], prefixes: [...view.prefixes] })
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, t])

  // R30 需求②: 一次写操作后按当前所在层级刷新（集合卡片 / 集合内条目 / 详情），
  // 顺带刷新中枢计数，让「记忆 N」徽标即时跟上。
  const refreshMemoryViews = useCallback((): void => {
    if (view.kind === 'memory-collection') void refreshCollectionMemories(view.id)
    else if (view.kind === 'memory-detail') void refreshMemoryDetail(view.id)
    else void refreshMemoryCollections()
    void refreshHub()
  }, [view, refreshCollectionMemories, refreshMemoryDetail, refreshMemoryCollections, refreshHub])

  // R30 需求②: 打开记忆详情（记住来自哪个集合，返回时回到该集合的条目页）。
  const openMemoryDetail = useCallback((id: string): void => {
    setExpandedVersion(undefined)
    setMemoryDetail(undefined)
    setView({ kind: 'memory-detail', id })
  }, [])

  const backFromMemoryDetail = useCallback((): void => {
    setExpandedVersion(undefined)
    setView({ kind: 'memory-collection', id: memoryDetail?.view.collectionId ?? '' })
  }, [memoryDetail])

  // A3: 工具列表按当前工作区拉取（cwd 变化即重新过滤，不停留在旧工作区数据）。
  const refreshTools = useCallback(async () => {
    if (!cwd) return
    try {
      setTools(await api.listTools(cwd))
    } catch (loadError) {
      setError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, t])

  useEffect(() => { void refreshHub() }, [refreshHub])
  // R30 需求②: 两级页各自按视图拉取（集合卡片 / 集合内条目 / 记忆详情）。
  useEffect(() => {
    if (view.kind === 'memories') void refreshMemoryCollections()
  }, [view, refreshMemoryCollections])
  useEffect(() => {
    if (view.kind === 'memory-collection') void refreshCollectionMemories(view.id)
  }, [view, refreshCollectionMemories])
  useEffect(() => {
    if (view.kind === 'memory-detail') void refreshMemoryDetail(view.id)
  }, [view, refreshMemoryDetail])
  useEffect(() => {
    if (view.kind === 'settings') {
      void refreshHubPolicy()
      void refreshModelDefaults()
      void refreshSkills()
    }
  }, [view, refreshHubPolicy, refreshSkills])
  useEffect(() => { if (view.kind === 'tools') void refreshTools() }, [view, refreshTools])
  // R44 需求②: 「分支会话」页签按需拉全量分支（首次进入或 cwd 变化时；refreshHub
  // 已在创建/派发后刷新，这里只兜「直接点进页签」的冷启动）。
  useEffect(() => {
    if (view.kind !== 'branches' || !cwd) return
    if (allBranches.length > 0) return
    void api.listAllBranches(cwd).then(setAllBranches, () => [] as HubBranchView[])
  }, [view, cwd, api, allBranches.length])

  // 需求①: the shell's 新建会话 click CREATES a hub session and publishes its
  // receipt here. The panel may be parked on another tab, so a receipt always
  // switches back to the hub tab and renders in place (message + session id +
  // 「打开会话」). The rail's 「＋ 新中枢会话」 button produces the same receipt
  // through createHubNow below, so both entries behave identically.
  //
  // Two consumption paths, one effect: (1) live publishes reach the listener,
  // (2) a receipt published before this panel mounted is drained right after
  // subscribing — that closes the mount/publish race (selectPanel opens the
  // panel and the host call resolves a few milliseconds later). Drained once,
  // so a later remount never shows a stale creation.
  useEffect(() => {
    const show = (incoming: HubSessionReceipt): void => {
      setView({ kind: 'hub' })
      setReceipt(incoming)
      void refreshHub()
    }
    const unsubscribe = subscribeHubReceipt(show)
    const pending = takePendingHubReceipt()
    if (pending) show(pending)
    return unsubscribe
  }, [refreshHub])

  // R19 需求⑤: read one session's model-visible surface. The panel polls this
  // method (2.5 s) instead of opening the shell session; `sessionQuery` gives
  // the same fold the model sees, and a failure renders an explicit note.
  const loadChat = useCallback(async (id: string): Promise<void> => {
    try {
      const [data, branches] = await Promise.all([
        api.readSessionMessages(id, 80),
        cwd ? api.listHubBranches(cwd, id).then((rows) => rows, () => [] as HubBranchView[]) : Promise.resolve([] as HubBranchView[]),
      ])
      setChatData(data)
      setChatBranches(branches)
      setChatError(undefined)
    } catch (loadError) {
      setChatError(`${t('error.load')}: ${String(loadError instanceof Error ? loadError.message : loadError)}`)
    }
  }, [api, cwd, t])

  const openChat = useCallback((id: string): void => {
    setChatData(undefined)
    setChatDraft('')
    setChatError(undefined)
    setView({ kind: 'chat', id })
  }, [])

  // Poll only while the chat view is open and the document is visible.
  useEffect(() => {
    if (view.kind !== 'chat') return
    const id = view.id
    void loadChat(id)
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void loadChat(id)
    }, 2500)
    return () => clearInterval(timer)
  }, [loadChat, view])

  const sendChat = async (id: string): Promise<void> => {
    const text = chatDraft.trim()
    if (!text) return
    setChatSending(true)
    setChatError(undefined)
    try {
      const result = await api.sendSessionMessage(id, text)
      if (result.status === 'ok') {
        setChatDraft('')
        await loadChat(id)
      } else {
        setChatError(result.message)
      }
    } catch (sendError) {
      setChatError(`${t('error.generic')}: ${String(sendError instanceof Error ? sendError.message : sendError)}`)
    } finally {
      setChatSending(false)
    }
  }

  // R7: the host catalogs behind the quick launcher (agent presets, model
  // routes, permission presets), read once per mount. A failure leaves the
  // corresponding selector empty — the launcher still works with defaults.
  useEffect(() => {
    let alive = true
    void api.listAgentPresets().then((rows) => { if (alive) setPresets(rows) }, () => { /* keep the default option */ })
    void api.listModelCatalog().then((rows) => { if (alive) setCatalog(rows) }, () => { /* keep the default option */ })
    void api.listPermissions().then((rows) => { if (alive) setPermissions(rows) }, () => { /* keep the default option */ })
    return () => { alive = false }
  }, [api])

  // R19 需求②: the launcher's topic sets belong to the SAME selected workspace
  // (the header selector is the single source); a stale selection is dropped.
  useEffect(() => {
    if (!cwd) return
    let alive = true
    void api.loadTopicSets(cwd).then((rows) => {
      if (!alive) return
      setLaunchSets(rows)
      setLaunchSelected((current) => current.filter((id) => rows.some((row) => row.id === id)))
    }, () => { if (alive) setLaunchSets([]) })
    return () => { alive = false }
  }, [api, cwd])

  const launchCwd = cwd

  const launchCreateSet = async (): Promise<void> => {
    const title = launchNewTitle.trim()
    if (!title || !launchCwd) return
    setError(undefined)
    try {
      const created = await api.createTopicSet(launchCwd, title)
      if (created.status !== 'ok' || !created.id) { setError(created.message); return }
      const id = created.id
      setLaunchNewTitle('')
      const rows = await api.loadTopicSets(launchCwd)
      setLaunchSets(rows)
      setLaunchSelected((current) => (current.includes(id) ? current : [...current, id]))
      // R18 需求②: show what the host actually wrote (title + derived tags)
      // instead of leaving the form blank after creation.
      const createdRow = rows.find((row) => row.id === id)
      setCreatedSet(createdRow
        ? { title: createdRow.title, tags: createdRow.tags }
        : { title: created.message, tags: [] })
      void refreshHub()
    } catch (createError) {
      setError(`${t('error.generic')}: ${String(createError instanceof Error ? createError.message : createError)}`)
    }
  }

  /**
   * 需求②: one click on 「＋ 新中枢会话」 (the panel rail) creates the hub session
   * immediately — no form, no type picker — and renders the same in-place
   * receipt as the shell's 新建会话 entry.
   *
   * Defaults: the panel's current workspace; host defaults for agent preset /
   * model / permission (no options passed, so the host applies its own);
   * NO topic set, because a hub session owns none by definition — the dispatch
   * card still picks the sticky / automatically matched set when dispatching.
   */
  const createHubNow = useCallback(async (): Promise<void> => {
    if (!launchCwd) { setError(t('launch.needWorkspace')); return }
    setLaunching(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await api.createHubSession(launchCwd, {}, '')
      if (result.status === 'ok' && result.id) {
        setView({ kind: 'hub' })
        setReceipt({ id: result.id, message: result.message, kind: 'hub' })
        setComposerText('')
        void refreshHub()
      } else {
        setError(result.message)
      }
    } catch (createError) {
      setError(`${t('error.generic')}: ${String(createError instanceof Error ? createError.message : createError)}`)
    } finally {
      setLaunching(false)
    }
  }, [api, launchCwd, refreshHub, t])

  const startLaunch = async (mode: 'chat' | 'bare' = 'chat'): Promise<void> => {
    if (!launchCwd) { setError(t('launch.needWorkspace')); return }
    const text = composerText.trim()
    if (mode === 'chat' && !text) return
    setLaunching(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const options: SessionOptions = {}
      if (launchPreset) options.agentPreset = launchPreset
      if (launchModel) {
        const slash = launchModel.indexOf('/')
        if (slash > 0) options.model = { provider: launchModel.slice(0, slash), model: launchModel.slice(slash + 1) }
      }
      if (launchPermission) options.permission = launchPermission
      const ids = launchSelected
      const opening = mode === 'chat' ? text : ''
      const result = ids.length > 0
        ? await api.createTopicSetSession(launchCwd, ids, options, opening)
        : await api.createHubSession(launchCwd, options, opening)
      if (result.status === 'ok' && result.id) {
        // In place: no api.openSession here. The user opens the conversation
        // from the receipt only when they want to follow it in the shell.
        setComposerText('')
        setReceipt({ id: result.id, message: result.message, kind: ids.length > 0 ? 'sets' : 'hub' })
        void refreshHub()
      } else {
        setError(result.message)
      }
    } catch (launchError) {
      setError(`${t('error.generic')}: ${String(launchError instanceof Error ? launchError.message : launchError)}`)
    } finally {
      setLaunching(false)
    }
  }

  // R44 需求②: 「分支会话」页签的本地筛选——话题集过滤 + 关键字搜索（标题/
  // 标签/分支 id/所属话题集），切换即生效（宿主 listAllBranches 也支持按集
  // 过滤，这里保留即时体验）。
  const filteredBranchRows = useMemo(() => {
    const needle = branchQuery.trim().toLowerCase()
    return allBranches.filter((row) => {
      if (branchFilter && row.topicSetId !== branchFilter) return false
      if (!needle) return true
      const haystack = [
        row.title, row.branchSessionId, row.topicSetTitle ?? '',
        ...(row.tags ?? []),
      ].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [allBranches, branchFilter, branchQuery])

  const filteredSets = useMemo(() => {
    const needle = setsQuery.trim().toLowerCase()
    const rows = hub?.topicSets ?? []
    if (!needle) return rows
    const inIndex = (topicSet: TopicSetView): boolean =>
      topicSet.title.toLowerCase().includes(needle)
      || topicSet.tags.some((tag) => tag.toLowerCase().includes(needle))
    // Index fields first (title, then tags), body hits last: the point of the
    // title+tags+body shape is not having to scan every set's summary.
    return [
      ...rows.filter(inIndex),
      ...rows.filter((topicSet) => !inIndex(topicSet) && topicSet.summary.toLowerCase().includes(needle)),
    ]
  }, [hub, setsQuery])

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
      // R18 需求③: any successful mutation (activate, reply, topic-set edit) may
      // have changed membership or titles the sidebar badge caches.
      if (result && result.status === 'ok') api.invalidateBadges()
      after?.()
    } catch (actionError) {
      setError(`${t('error.generic')}: ${String(actionError instanceof Error ? actionError.message : actionError)}`)
    }
  }

  // R27: 会话视图（chat）属于「中枢会话」，话题集详情（topic）属于「话题集」——
  // 否则在这两个二级视图里四个页签全都不高亮，用户看不出自己在哪一层。
  // R30 需求②: 记忆的两级下钻（集合内条目 / 记忆详情）同属「记忆」页签。
  const tabActive = (kind: View['kind']): boolean => {
    if (view.kind === kind) return true
    if (kind === 'hub') return view.kind === 'chat'
    if (kind === 'sets') return view.kind === 'topic'
    if (kind === 'memories') return view.kind === 'memory-collection' || view.kind === 'memory-detail'
    return false
  }

  const tabProps = (kind: View['kind']) => ({
    'data-active': String(tabActive(kind)),
    className: 'sm-tab',
    onClick: () => setView(
      kind === 'hub' ? { kind: 'hub' }
        : kind === 'sets' ? { kind: 'sets' }
          : kind === 'branches' ? { kind: 'branches' }
            : kind === 'memories' ? { kind: 'memories' }
              : kind === 'settings' ? { kind: 'settings' }
                : { kind: 'tools' },
    ),
  })

  // The dispatch card: submitting creates the session host-side, DELIVERS the
  // message as its first turn, and renders the receipt in place: no navigation
  // to the shell's new-session page (the user opens it from the receipt only
  // when they want to follow the conversation there).
  // R22 需求②: 派发回到「卡片」形态——与面板其它卡片（记忆 / 固化能力）同一套
  // 视觉语言：小标题 + 一句说明 + 紧凑输入 + 行内选项 + 底部动作。字段与功能
  // 一个都不少：任务文本、工作区/Agent 模式/模型/权限、话题集绑定 chips、
  // ＋新话题集、开始对话 / 仅创建会话、Ctrl/Cmd+Enter、就地回执。
  const composerView: ReactNode = h('div', { key: 'composer', className: 'sm-card sm-dispatch' },
    h('div', { key: 'head', className: 'sm-row' },
      h('h3', { key: 'title' }, t('composer.title')),
      h('span', { key: 'desc', className: 'sm-muted' }, t('composer.desc')),
    ),
    h('textarea', {
      key: 'input', className: 'sm-textarea', rows: 3,
      value: composerText,
      placeholder: t('composer.placeholder'),
      onChange: (event: { target: { value: string } }) => setComposerText(event.target.value),
      onKeyDown: (event: { key: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void }) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          void startLaunch('chat')
        }
      },
    }),
    h('div', { key: 'opts', className: 'sm-composer-opts' },
      h('label', { key: 'ws', className: 'sm-opt' },
        h('span', { key: 'label', className: 'sm-opt-label' }, t('launch.workspace')),
        h('select', {
          key: 'select', className: 'sm-opt-select', value: launchCwd,
          onChange: (event: { target: { value: string } }) => changeWorkspace(event.target.value),
        },
          workspaces.length === 0
            ? h('option', { key: 'current', value: launchCwd }, launchCwd || '—')
            : [
                // A cwd outside the shell's open workspaces (closed workspace)
                // still has to be a selectable option, or the select would show
                // a different workspace than the panel actually writes to.
                ...(launchCwd && !workspaces.some((workspace) => workspace.path === launchCwd)
                  ? [h('option', { key: 'current', value: launchCwd }, launchCwd)]
                  : []),
                ...workspaces.map((workspace) =>
                  h('option', { key: workspace.id, value: workspace.path }, workspace.title || workspace.path),
                ),
              ],
        ),
      ),
      h('label', { key: 'preset', className: 'sm-opt' },
        h('span', { key: 'label', className: 'sm-opt-label' }, t('launch.preset')),
        h('select', {
          key: 'select', className: 'sm-opt-select', value: launchPreset,
          onChange: (event: { target: { value: string } }) => setLaunchPreset(event.target.value),
        },
          h('option', { key: 'default', value: '' }, t('launch.default')),
          presets.map((preset) =>
            h('option', {
              key: preset.id, value: preset.id,
              title: preset.description || undefined,
            }, (preset.name || preset.id) + (preset.isDefault ? `（${t('launch.defaultMark')}）` : '')),
          ),
        ),
      ),
      h('label', { key: 'model', className: 'sm-opt' },
        h('span', { key: 'label', className: 'sm-opt-label' }, t('launch.model')),
        h('select', {
          key: 'select', className: 'sm-opt-select', value: launchModel,
          onChange: (event: { target: { value: string } }) => setLaunchModel(event.target.value),
        },
          h('option', { key: 'default', value: '' }, t('launch.default')),
          (catalog?.models ?? []).map((model) =>
            h('option', {
              key: `${model.provider}/${model.id}`, value: `${model.provider}/${model.id}`,
              title: model.name || undefined,
            }, `${model.provider}/${model.id}`),
          ),
        ),
      ),
      h('label', { key: 'permission', className: 'sm-opt' },
        h('span', { key: 'label', className: 'sm-opt-label' }, t('launch.permission')),
        h('select', {
          key: 'select', className: 'sm-opt-select', value: launchPermission,
          onChange: (event: { target: { value: string } }) => setLaunchPermission(event.target.value),
        },
          h('option', {
            key: 'default', value: '',
            title: (permissions?.options ?? []).find((option) => option.value === permissions?.defaultPreset)?.description || undefined,
          }, permissions?.defaultPreset ? `${t('launch.default')}（${permissions.defaultPreset}）` : t('launch.default')),
          (permissions?.options ?? []).map((option) =>
            h('option', { key: option.value, value: option.value, title: option.description || undefined }, option.name || option.value),
          ),
        ),
      ),
    ),
    h('div', { key: 'sets', className: 'sm-composer-sets' },
      h('span', { key: 'label', className: 'sm-opt-label' }, t('launch.sets')),
      launchSets.length === 0
        ? h('span', { key: 'empty', className: 'sm-muted' }, t('composer.setsEmpty'))
        : launchSets.map((topicSet) =>
            h('button', {
              key: topicSet.id, type: 'button', className: 'sm-chip',
              'data-active': String(launchSelected.includes(topicSet.id)),
              onClick: () => setLaunchSelected((current) =>
                current.includes(topicSet.id) ? current.filter((entry) => entry !== topicSet.id) : [...current, topicSet.id]),
            }, topicSet.title),
          ),
      h('button', {
        key: 'new', type: 'button', className: 'sm-chip', 'data-dashed': 'true',
        onClick: () => setShowNewSet((value) => !value),
      }, t('composer.newSet')),
    ),
    showNewSet
      ? h('div', { key: 'newset', className: 'sm-form', style: { marginTop: 8, marginBottom: 0 } },
          h('input', {
            key: 'input', className: 'sm-input', value: launchNewTitle,
            placeholder: t('newSession.create'),
            onChange: (event: { target: { value: string } }) => setLaunchNewTitle(event.target.value),
          }),
          h(Button, {
            key: 'add', label: t('topic.create'), disabled: !launchNewTitle.trim() || !launchCwd,
            onClick: () => void launchCreateSet(),
          }),
        )
      : null,
    createdSet
      ? h('div', { key: 'createdSet', className: 'sm-set-created' },
          h('span', { key: 'badge', className: 'sm-badge' }, t('sets.created')),
          h('span', { key: 'title' }, createdSet.title),
          createdSet.tags.length > 0 ? tagChips(createdSet.tags) : null,
        )
      : null,
    h('div', { key: 'actions', className: 'sm-actions' },
      h(Button, {
        key: 'send', variant: 'primary', label: t('composer.start'),
        disabled: launching || !composerText.trim() || !launchCwd,
        onClick: () => void startLaunch('chat'),
      }),
      h(Button, {
        key: 'createOnly', label: t('composer.createOnly'), title: t('composer.createOnly.hint'),
        disabled: launching || !launchCwd,
        onClick: () => void startLaunch('bare'),
      }),
      h('span', { key: 'hint', className: 'sm-muted' }, t('composer.hint')),
    ),
  )

  // The in-place receipt: created session + delivery state, shown where the
  // conversation was started. 打开会话 is the only path that navigates.
  const receiptView: ReactNode = receipt
    ? h('div', { key: 'receipt', className: 'sm-receipt' },
        h('div', { key: 'row', className: 'sm-row' },
          h('span', { key: 'mark', className: 'sm-badge' }, receipt.kind === 'sets' ? t('composer.receipt.sets') : t('composer.receipt.hub')),
          h('span', { key: 'text' }, receipt.message),
        ),
        h('div', { key: 'meta', className: 'sm-sub' }, receipt.id),
        h('div', { key: 'actions', className: 'sm-actions' },
          // A failure receipt ('' id) has no session to open: show the message
          // and let the user dismiss it, never a broken 打开会话 button.
          receipt.id
            ? h(Button, { key: 'open', label: t('composer.open'), onClick: () => api.openSession(receipt.id) })
            : null,
          h(Button, { key: 'dismiss', label: t('composer.dismiss'), onClick: () => setReceipt(undefined) }),
        ),
      )
    : null

  const hubView: ReactNode = [
    composerView,
    receiptView,
    // R19 协同②: the current hub's own delegates, with state / set / sharing.
    BranchList({ rows: hubBranches, t, onOpen: openChat }),
    // R22 需求⑦: 中枢会话页签只留「派发 + 回执 + 本中枢的分支 + 当前会话」。
    // 话题集列表、激活话题集、会话数/在线数统计都属于话题集页签，这里不再
    // 重复展示——用户已明确「这部分都在话题集页签里看」。
    h('div', { key: 'current', className: 'sm-card' },
      h('h3', null, t('hub.current')),
      h('div', { className: 'sm-row' },
        h('span', { className: 'sm-muted' }, sessionId || '—'),
        h(Button, { key: 'refresh', label: t('hub.refresh'), onClick: () => void refreshHub() }),
      ),
    ),
  ]

  // R44 需求②: 「分支会话」页签——全部分支（跨话题集）。原「中枢会话」页签的
  // 「全部分支会话」卡移到这里：中枢页签只留派发/回执/本中枢分支/当前会话，
  // 跨话题集的管理视图独立成页签。筛选（话题集）与关键字搜索都在本地做，
  // 数据来自宿主 listAllBranches（与话题集筛选下拉共用 allSets）。
  const branchesView: ReactNode = [
    h('div', { key: 'filters', className: 'sm-form' },
      h('label', { key: 'set', className: 'sm-opt' },
        h('span', { key: 'text', className: 'sm-opt-label' }, t('hub.allBranches.filter')),
        h('select', {
          key: 'select', className: 'sm-opt-select', value: branchFilter,
          onChange: (event: { target: { value: string } }) => setBranchFilter(event.target.value),
        },
          h('option', { key: 'all', value: '' }, t('hub.allBranches.allSets')),
          allSets.map((topicSet) =>
            h('option', { key: topicSet.id, value: topicSet.id }, topicSet.title)),
        ),
      ),
      h('input', {
        key: 'search', className: 'sm-input', value: branchQuery,
        placeholder: t('branches.search'),
        onChange: (event: { target: { value: string } }) => setBranchQuery(event.target.value),
      }),
      h(Button, {
        key: 'clear', label: t('sets.clear'),
        onClick: () => { setBranchFilter(''); setBranchQuery('') },
      }),
    ),
    h('div', { key: 'stats', className: 'sm-muted' }, t('branches.stats', {
      shown: filteredBranchRows.length, total: allBranches.length,
    })),
    h('div', { key: 'list', className: 'sm-list' },
      filteredBranchRows.length === 0
        ? h(EmptyState, { key: 'empty', label: t('hub.allBranches.empty'), hint: t('hub.allBranches.hint') })
        : filteredBranchRows.map((row) =>
            h('div', {
              key: row.branchSessionId, className: 'sm-item', 'data-clickable': 'true',
              title: `${row.title} · ${row.branchSessionId}`,
              onClick: () => openChat(row.branchSessionId),
            },
              h('div', { key: 'row', className: 'sm-row' },
                h('span', { key: 'title', className: 'sm-title' }, row.title),
                h('span', { key: 'state', className: 'sm-badge', 'data-state': row.status }, t(`branches.${row.status}`)),
                row.shared
                  ? h('span', { key: 'shared', className: 'sm-badge', title: row.hubs.join('、') }, t('branches.shared', { count: row.hubs.length - 1 }))
                  : null,
                row.groupId ? h('span', { key: 'grp', className: 'sm-badge' }, t('branches.group')) : null,
              ),
              h('div', { key: 'meta', className: 'sm-sub' },
                `${row.topicSetTitle ? t('branches.set', { title: row.topicSetTitle }) : t('branches.noSet')} · `
                + `${branchAgo(row.lastActivityAt, t)} · ${t('branches.dispatches', { count: row.dispatches })}`,
              ),
              row.tags && row.tags.length > 0 ? tagChips(row.tags) : null,
              h('div', { key: 'id', className: 'sm-sub' }, row.branchSessionId),
            ),
          ),
    ),
  ]

  // R11: a dedicated 话题集 tab. Each card is the record's own retrieval shape
  // — title, tag chips, body — plus the session count the user asked to see.
  const setsView: ReactNode = [
    h('div', { key: 'search', className: 'sm-form' },
      h('input', {
        key: 'input', className: 'sm-input', value: setsQuery,
        placeholder: t('sets.search'),
        onChange: (event: { target: { value: string } }) => setSetsQuery(event.target.value),
      }),
      h(Button, { key: 'clear', label: t('sets.clear'), onClick: () => setSetsQuery('') }),
    ),
    h('div', { key: 'stats', className: 'sm-muted' }, t('sets.stats', {
      shown: filteredSets.length, total: hub?.topicSets.length ?? 0,
    })),
    h('div', { key: 'list', className: 'sm-list' },
      filteredSets.length === 0
        ? h(EmptyState, { key: 'empty', label: t('sets.empty'), hint: t('sets.empty.hint') })
        : filteredSets.map((topicSet) =>
            h('div', {
              key: topicSet.id, className: 'sm-item', 'data-clickable': 'true',
              onClick: () => { setView({ kind: 'topic', id: topicSet.id }); setSummaryDraft(undefined); setSummaryTagsDraft(undefined); setReply('') },
            },
              h('div', { className: 'sm-row' },
                h('span', { className: 'sm-title' }, topicSet.title),
                hub?.activeTopicSetId === topicSet.id ? h('span', { key: 'a', className: 'sm-badge' }, t('hub.active')) : null,
                h('span', { key: 'n', className: 'sm-badge' }, t('sets.sessions', { count: topicSet.sessions })),
                topicSet.live > 0 ? h('span', { key: 'l', className: 'sm-badge' }, t('sets.live', { count: topicSet.live })) : null,
                topicSet.model ? h('span', { key: 'm', className: 'sm-badge' }, topicSet.model) : null,
              ),
              tagChips(topicSet.tags),
              h('div', { className: 'sm-body-text' }, topicSet.summary || t('sets.noBody')),
              h('div', { className: 'sm-actions' },
                h(Button, {
                  key: 'act', label: t('hub.activate'),
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation()
                    void run(async () => api.activate(sessionId, topicSet.id), () => void refreshHub())
                  },
                }),
                h(Button, {
                  key: 'open', label: t('sets.open'),
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation()
                    setView({ kind: 'topic', id: topicSet.id })
                    setReply('')
                  },
                }),
              ),
            ),
          ),
    ),
  ]

  const topicView: ReactNode = currentTopicSet
    ? [
        // R22 需求⑥: 详情是从「话题集」列表进来的，返回目标就是那张列表
        // （不再把用户丢回中枢页签，那里已经没有话题集内容了）。
        h(Button, { key: 'back', className: 'sm-back', label: t('topic.back'), onClick: () => setView({ kind: 'sets' }) }),
        h('div', { key: 'card', className: 'sm-card' },
          h('h3', null, currentTopicSet.title),
          tagChips(currentTopicSet.tags),
          h('div', { className: 'sm-row', style: { marginTop: 6 } },
            h(Button, {
              key: 'act', variant: 'primary', label: t('hub.activate'),
              onClick: () => void run(async () => api.activate(sessionId, currentTopicSet.id), () => void refreshHub()),
            }),
            h('span', { key: 'n', className: 'sm-badge' }, t('sets.sessions', { count: currentTopicSet.sessions })),
            currentTopicSet.model ? h('span', { key: 'm', className: 'sm-badge' }, currentTopicSet.model) : null,
          ),
        ),
        h('div', { key: 'members', className: 'sm-card' },
          h('h3', null, t('topic.members')),
          currentTopicSet.branches.length === 0
            ? h(EmptyState, { label: t('topic.noMembers') })
            : h('div', { className: 'sm-list' },
                currentTopicSet.branches.map((branch) =>
                  h('div', { key: branch.sessionId, className: 'sm-item', 'data-clickable': 'true', onClick: () => openChat(branch.sessionId) },
                    h('div', { className: 'sm-row' },
                      h('span', { className: 'sm-title' }, branch.title || branch.sessionId.slice(0, 12)),
                      // R19 需求③: root members are the set's own hub conversations.
                      h('span', { key: 'k', className: 'sm-badge' }, branch.kind === 'fork' ? t('topic.branch') : t('topic.root')),
                      h('span', { key: 's', className: 'sm-badge' }, branch.status),
                      // R19 协同③ fix: the card names its OWNING set and the
                      // share count for every branch row (fresh dispatches are
                      // kind 'root' members but are still branches).
                      branch.kind === 'fork' && branch.topicSetTitle
                        ? h('span', { key: 'own', className: 'sm-badge', title: t('branches.ownSet') }, branch.topicSetTitle)
                        : null,
                      branch.kind === 'fork' && (branch.hubs ?? 0) > 1
                        ? h('span', { key: 'sh', className: 'sm-badge' }, t('branches.shared', { count: (branch.hubs ?? 1) - 1 }))
                        : null,
                      branch.model ? h('span', { key: 'm', className: 'sm-badge' }, branch.model) : null,
                    ),
                    h('div', { className: 'sm-sub' }, branch.sessionId),
                    // B3: 分支卡片带最新一次派发的任务摘要（无则仅显示会话 id）。
                    branch.task ? h('div', { key: 'task', className: 'sm-sub' }, `任务：${branch.task}`) : null,
                    // R30 需求④: 分支标签（与中枢卡/管理台同一份映射）。
                    branch.tags && branch.tags.length > 0 ? tagChips(branch.tags) : null,
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
          h('div', { className: 'sm-form-label' }, t('memory.tags')),
          h('input', {
            key: 'tags', className: 'sm-input', value: (summaryTagsDraft ?? currentTopicSet.tags).join('，'),
            placeholder: t('memory.tags.placeholder'),
            onChange: (event: { target: { value: string } }) => setSummaryTagsDraft(
              String(event.target.value).split(/[,，、;；\s]+/).map((tag) => tag.trim()).filter(Boolean),
            ),
          }),
          h('div', { key: 'bodyLabel', className: 'sm-form-label', style: { marginTop: 6 } }, t('memory.body')),
          h('textarea', {
            key: 'input', className: 'sm-textarea', value: summaryDraft ?? currentTopicSet.summary,
            onChange: (event: { target: { value: string } }) => setSummaryDraft(event.target.value),
          }),
          h('div', { className: 'sm-actions' },
            h(Button, {
              key: 'save', label: t('topic.summary.save'),
              onClick: () => void run(async () => api.updateTopicSetSummary(
                currentTopicSet.id,
                (summaryDraft ?? currentTopicSet.summary).slice(0, 500),
                summaryTagsDraft ?? currentTopicSet.tags,
              ), () => { setSummaryDraft(undefined); setSummaryTagsDraft(undefined); void refreshHub() }),
            }),
          ),
        ),
      ]
    : h(EmptyState, { key: 'missing', label: t('hub.empty'), hint: t('hub.empty.hint') })

  // R28 需求④ / R30 需求②: one memory entry row inside a collection — title
  // (+ version badge), tag chips, body, status, source and every action (open
  // detail / edit / enable-disable / two-step delete). The title row opens the
  // detail page (level 3); the actions stay inline so nothing is lost from the
  // old flat list.
  const memoryEntryRow = (memory: MemoryView): ReactNode =>
    h('div', { key: memory.id, className: 'sm-item' },
      h('div', {
        key: 'head', className: 'sm-row', 'data-clickable': 'true',
        title: t('memory.detail.open'),
        style: { cursor: 'pointer' },
        onClick: () => openMemoryDetail(memory.id),
      },
        h('span', { key: 'title', className: 'sm-title' }, memory.title || deriveTitleClient(memory.text)),
        h('span', { key: 'ver', className: 'sm-badge' }, `v${memory.version ?? 1}`),
        h('span', { key: 'st', className: 'sm-badge' }, memory.status),
      ),
      tagChips(memory.tags, query),
      h('div', { className: 'sm-body-text' }, memory.text),
      h('div', { className: 'sm-sub' },
        `${t('memory.updated')}：${fmtTime(memory.updatedAt)}`,
        ` · ${t('memory.source')}：${memory.sourceSessionId || '—'}`,
      ),
      h('div', { className: 'sm-actions' },
        memory.sourceSessionId
          ? h(Button, {
              key: 'loc', label: t('memory.locate'),
              onClick: () => api.openSession(memory.sourceSessionId),
            })
          : null,
        h(Button, {
          key: 'edit', label: t('memory.edit'),
          onClick: () => setEditingMemory({ id: memory.id, title: memory.title, tags: memory.tags, text: memory.text, key: memory.key }),
        }),
        h(Button, {
          key: 'toggle', label: memory.status === 'active' ? t('memory.disable') : t('memory.enable'),
          onClick: () => void run(async () => api.setMemoryStatus(cwd, memory.id, memory.status === 'active' ? 'superseded' : 'active'), () => void refreshMemoryViews()),
        }),
        // R27: 永久删除先就地问一次（与固化能力的删除确认一致）。
        confirmDeleteMemory === memory.id
          ? h(Button, {
              key: 'delYes', variant: 'danger', label: t('memory.deleteConfirm'),
              onClick: () => void run(async () => api.deleteMemory(cwd, memory.id), () => {
                setConfirmDeleteMemory(undefined)
                void refreshMemoryViews()
              }),
            })
          : h(Button, {
              key: 'del', variant: 'danger', label: t('memory.delete'),
              onClick: () => setConfirmDeleteMemory(memory.id),
            }),
        confirmDeleteMemory === memory.id
          ? h(Button, { key: 'delNo', label: t('memory.cancel'), onClick: () => setConfirmDeleteMemory(undefined) })
          : null,
      ),
    )

  // R30 需求②: 第一级只展示记忆集卡片（标题/标签/条目数/最近更新），按标题/标签
  // 搜索；点击卡片下钻到该集合的条目页。未归集是一张 id 为 '' 的虚拟卡片。
  const filteredCollections = useMemo(() => {
    const needle = memoryQuery.trim().toLowerCase()
    if (!needle) return memoryCollections
    return memoryCollections.filter((collection) =>
      collection.title.toLowerCase().includes(needle)
      || collection.tags.some((tag) => tag.toLowerCase().includes(needle)))
  }, [memoryCollections, memoryQuery])

  const collectionCard = (collection: MemoryCollectionView): ReactNode =>
    h('div', {
      key: collection.id || 'ungrouped', className: 'sm-card',
      'data-clickable': 'true',
      title: t('memory.collection.open'),
      style: { cursor: 'pointer' },
      onClick: () => setView({ kind: 'memory-collection', id: collection.id }),
    },
      h('div', { key: 'head', className: 'sm-row' },
        h('h3', { key: 'title' }, collection.title),
        h('span', { key: 'count', className: 'sm-badge' }, t('memory.group.count', { count: collection.count })),
      ),
      tagChips(collection.tags),
      h('div', { key: 'meta', className: 'sm-sub' }, `${t('memory.updated')}：${fmtTime(collection.latestUpdatedAt)}`),
    )

  const collectionList: ReactNode = filteredCollections.length === 0
    ? h(EmptyState, { key: 'empty', label: t('memory.collection.empty'), hint: t('memory.collection.empty.hint') })
    : h('div', { key: 'cards', className: 'sm-list' }, filteredCollections.map(collectionCard))

  // R30 需求②: 第二级——一个集合内的全部条目（标题/标签/版本徽标/更新时间），
  // 点击条目进入详情页。搜索框按标题/标签/正文过滤（宿主侧打分）。
  const currentCollection = view.kind === 'memory-collection'
    ? memoryCollections.find((collection) => collection.id === view.id)
    : undefined

  const memoryCollectionView: ReactNode = h('div', { key: 'mc' },
    h('div', { key: 'crumb', className: 'sm-row' },
      h(Button, { key: 'back', label: t('memory.back'), onClick: () => setView({ kind: 'memories' }) }),
      h('span', { key: 'path', className: 'sm-muted' },
        `${t('tab.memories')} / ${currentCollection?.title ?? (view.kind === 'memory-collection' ? view.id : '')}`),
    ),
    h('div', { key: 'search', className: 'sm-form' },
      h('input', {
        key: 'input', className: 'sm-input', value: query, placeholder: t('memory.search'),
        onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
      }),
      h(Button, {
        key: 'go', label: t('hub.refresh'),
        onClick: () => { if (view.kind === 'memory-collection') void refreshCollectionMemories(view.id) },
      }),
    ),
    collectionMemories.length === 0
      ? h(EmptyState, { key: 'empty', label: t('memory.empty'), hint: t('memory.empty.hint') })
      : h('div', { key: 'list', className: 'sm-list' }, collectionMemories.map(memoryEntryRow)),
  )

  // R30 需求②: 第三级——记忆详情：完整正文、当前版本、历史版本列表（可展开），
  // 以及编辑/停用/删除动作。历史里最后一条即当前版本。
  const detail = memoryDetail
  const detailVersions = detail?.versions ?? []
  const expandedVersionKey = expandedVersion
  const memoryDetailView: ReactNode = detail
    ? h('div', { key: 'md' },
        h('div', { key: 'crumb', className: 'sm-row' },
          h(Button, { key: 'back', label: t('memory.back'), onClick: () => backFromMemoryDetail() }),
          h('span', { key: 'path', className: 'sm-muted' },
            `${t('tab.memories')} / ${detail.view.collectionTitle || t('memory.group.ungrouped')} / ${detail.view.title || deriveTitleClient(detail.view.text)}`),
        ),
        h('div', { key: 'head', className: 'sm-row' },
          h('span', { key: 'title', className: 'sm-title' }, detail.view.title || deriveTitleClient(detail.view.text)),
          h('span', { key: 'ver', className: 'sm-badge' }, `v${detail.view.version ?? 1}`),
          h('span', { key: 'st', className: 'sm-badge' }, detail.view.status),
        ),
        tagChips(detail.view.tags, query),
        h('div', { key: 'body', className: 'sm-body-text' }, detail.view.text),
        h('div', { key: 'meta', className: 'sm-sub' },
          `${t('memory.updated')}：${fmtTime(detail.view.updatedAt)}`,
          detail.view.key ? ` · key ${detail.view.key}` : '',
          detail.view.sourceSessionId ? ` · ${t('memory.source')}：${detail.view.sourceSessionId}` : '',
        ),
        h('div', { key: 'actions', className: 'sm-actions' },
          h(Button, {
            key: 'edit', label: t('memory.edit'),
            onClick: () => setEditingMemory({
              id: detail.view.id, title: detail.view.title, tags: detail.view.tags, text: detail.view.text, key: detail.view.key,
            }),
          }),
          h(Button, {
            key: 'toggle', label: detail.view.status === 'active' ? t('memory.disable') : t('memory.enable'),
            onClick: () => void run(async () => api.setMemoryStatus(cwd, detail.view.id, detail.view.status === 'active' ? 'superseded' : 'active'), () => void refreshMemoryViews()),
          }),
          confirmDeleteMemory === detail.view.id
            ? h(Button, {
                key: 'delYes', variant: 'danger', label: t('memory.deleteConfirm'),
                onClick: () => void run(async () => api.deleteMemory(cwd, detail.view.id), () => {
                  setConfirmDeleteMemory(undefined)
                  setView({ kind: 'memory-collection', id: detail.view.collectionId ?? '' })
                }),
              })
            : h(Button, {
                key: 'del', variant: 'danger', label: t('memory.delete'),
                onClick: () => setConfirmDeleteMemory(detail.view.id),
              }),
          confirmDeleteMemory === detail.view.id
            ? h(Button, { key: 'delNo', label: t('memory.cancel'), onClick: () => setConfirmDeleteMemory(undefined) })
            : null,
        ),
        h('div', { key: 'history', className: 'sm-form-col' },
          h('div', { key: 'label', className: 'sm-form-label' },
            `${t('memory.history')}（${detailVersions.length}）`),
          detailVersions.length === 0
            ? h('div', { key: 'none', className: 'sm-muted' }, t('memory.history.none'))
            : h('div', { key: 'rows', className: 'sm-list' },
                detailVersions.map((row) => {
                  const rowKey = `${detail.view.id}:${row.version}`
                  const open = expandedVersionKey === rowKey
                  return h('div', { key: rowKey, className: 'sm-item' },
                    h('div', {
                      key: 'head', className: 'sm-row', 'data-clickable': 'true',
                      title: t('memory.history.toggle'),
                      style: { cursor: 'pointer' },
                      onClick: () => setExpandedVersion(open ? undefined : rowKey),
                    },
                      h('span', { key: 'caret', className: 'sm-caret' }, open ? '▾' : '▸'),
                      h('span', { key: 'ver', className: 'sm-badge' }, `v${row.version}`),
                      h('span', { key: 'type', className: 'sm-badge' }, t(`memory.history.${row.changeType}`)),
                      h('span', { key: 'title', className: 'sm-title' }, row.title || '—'),
                      h('span', { key: 'at', className: 'sm-sub' }, fmtTime(row.updatedAt)),
                    ),
                    tagChips(row.tags),
                    open ? h('div', { key: 'text', className: 'sm-body-text' }, row.text) : null,
                  )
                }),
              ),
        ),
      )
    : h(EmptyState, { key: 'missing', label: t('memory.empty'), hint: t('memory.empty.hint') })

  // -------------------------------------------------------------------------
  // R39: 「中枢权限」页签 —— 动态目录（每次调用即时生成，按来源分组，默认拒绝）。
  // 宿主工具定义不带来源字段，所以分组是「可解释的推断」：定义自带来源字段优先
  // （标为非推断），否则 mcp__<server>__ / memory_* / sm_cap_* / schedule_*
  // 依次判定，其余归宿主内置/未归属。白名单有、运行时无的条目单列失效组并可
  // 一键清理；枚举失败时宿主回退内置清单并告警（页面不白屏），默认路径始终动态。
  // -------------------------------------------------------------------------
  const hubPolicySelected = (name: string, prefix = false): boolean => {
    if (!hubPolicyDraft) return false
    return prefix ? hubPolicyDraft.prefixes.includes(name) : hubPolicyDraft.tools.includes(name)
  }
  const hubPolicyToggle = (name: string, prefix = false): void => {
    if (!hubPolicyDraft) return
    if (prefix) {
      const has = hubPolicyDraft.prefixes.includes(name)
      setHubPolicyDraft({
        ...hubPolicyDraft,
        prefixes: has
          ? hubPolicyDraft.prefixes.filter((entry) => entry !== name)
          : [...hubPolicyDraft.prefixes, name],
      })
      return
    }
    const has = hubPolicyDraft.tools.includes(name)
    setHubPolicyDraft({
      ...hubPolicyDraft,
      tools: has
        ? hubPolicyDraft.tools.filter((entry) => entry !== name)
        : [...hubPolicyDraft.tools, name],
    })
  }
  const hubPolicyAddCustom = (): void => {
    const name = hubPolicyCustom.trim()
    if (!name || !hubPolicyDraft) return
    if (!hubPolicyDraft.tools.includes(name)) {
      setHubPolicyDraft({ ...hubPolicyDraft, tools: [...hubPolicyDraft.tools, name] })
    }
    setHubPolicyCustom('')
  }
  /** R39: 当前草稿是否通过前缀规则覆盖了某工具（此时单项开关由前缀决定）。 */
  const hubPolicyPrefixCovered = (name: string): boolean => Boolean(hubPolicyDraft
    && !hubPolicyDraft.tools.includes(name)
    && hubPolicyDraft.prefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix)))

  /** R39: 已知来源 id 本地化；未知来源（含宿主声明的来源名）直接用宿主 label。 */
  const hubPolicyGroupLabel = (group: HubCatalogGroup): string => {
    if (group.id === 'stale') return t('hubPolicy.group.stale')
    if (group.id === 'source:supermemory') return t('hubPolicy.source.supermemory')
    if (group.id === 'source:composite') return t('hubPolicy.source.composite')
    if (group.id === 'source:schedule') return t('hubPolicy.source.schedule')
    if (group.id === 'source:host-session') return t('hubPolicy.source.hostSession')
    if (group.id === 'source:host') return t('hubPolicy.source.host')
    if (group.id.startsWith('source:mcp:')) return t('hubPolicy.source.mcp', { server: group.id.slice('source:mcp:'.length) })
    return group.label
  }

  const hubPolicyCount = hubPolicyDraft
    ? hubPolicyDraft.tools.length + hubPolicyDraft.prefixes.length
    : 0
  const hubPolicyNeedle = hubPolicyQuery.trim().toLowerCase()
  // 搜索跨来源分组：命中组名时整组显示，否则按工具名/描述过滤；空组隐藏。
  const hubPolicyFiltered = (hubPolicy?.catalog ?? [])
    .map((group) => {
      const label = hubPolicyGroupLabel(group)
      const groupHit = hubPolicyNeedle.length > 0
        && (label.toLowerCase().includes(hubPolicyNeedle) || group.label.toLowerCase().includes(hubPolicyNeedle))
      const items = groupHit
        ? group.items
        : group.items.filter((item) => hubPolicyNeedle.length === 0
          || item.name.toLowerCase().includes(hubPolicyNeedle)
          || (item.description ?? '').toLowerCase().includes(hubPolicyNeedle))
      return { group, items }
    })
    .filter((row) => row.items.length > 0)

  const toggleHubPolicyGroup = (id: string): void => {
    setHubPolicyCollapsed((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id])
  }

  /** R39: 一键清理 —— 先保存当前草稿（不丢未保存勾选），再由宿主按运行时清理。 */
  const cleanHubPolicyStale = (): void => void run(async () => {
    if (!hubPolicyDraft) return { status: 'error' as const, message: t('hubPolicy.loading') }
    const saved = await api.setHubPolicy(cwd, { tools: hubPolicyDraft.tools, prefixes: hubPolicyDraft.prefixes })
    if (saved.status !== 'ok') return saved
    return api.cleanupStaleHubPolicy(cwd)
  }, () => void refreshHubPolicy())

  const hubPolicySwitch = (entry: HubCatalogItem): ReactNode => {
    const locked = entry.locked === true || (hubPolicy?.locked ?? []).includes(entry.name)
    const prefixCovered = !locked && entry.prefix !== true && hubPolicyPrefixCovered(entry.name)
    const checked = locked || prefixCovered || hubPolicySelected(entry.name, entry.prefix === true)
    const disabled = locked || prefixCovered
    const title = locked
      ? t('hubPolicy.locked.tip')
      : prefixCovered
        ? t('hubPolicy.viaPrefix.tip')
        : entry.risk === true
          ? t('hubPolicy.risk.tip')
          : entry.description
    return h('label', {
      key: `${entry.source}:${entry.name}`,
      className: 'sm-item',
      'data-locked': String(disabled),
      title,
    },
      h('input', {
        key: 'box', type: 'checkbox', checked, disabled,
        onChange: () => hubPolicyToggle(entry.name, entry.prefix === true),
      }),
      h('span', { key: 'name', className: 'sm-title' }, entry.prefix === true ? `${entry.name}*` : entry.name),
      locked ? h('span', { key: 'lock', className: 'sm-badge' }, t('hubPolicy.locked')) : null,
      prefixCovered ? h('span', { key: 'prefix', className: 'sm-badge' }, t('hubPolicy.viaPrefix')) : null,
      entry.risk === true ? h('span', { key: 'risk', className: 'sm-badge' }, t('hubPolicy.risk')) : null,
      entry.synthetic === true
        ? h('span', { key: 'synthetic', className: 'sm-badge', title: t('hubPolicy.synthetic.tip') }, t('hubPolicy.synthetic'))
        : null,
      entry.stale === true ? h('span', { key: 'stale', className: 'sm-badge' }, t('hubPolicy.stale.badge')) : null,
      entry.noteKey === 'pluginManager' && !locked
        ? h('span', { key: 'note', className: 'sm-sub' }, t('hubPolicy.note.pluginManager'))
        : null,
      entry.description ? h('div', { key: 'desc', className: 'sm-desc' }, entry.description) : null,
    )
  }

  const hubPolicyGroupCard = (group: HubCatalogGroup, items: HubCatalogItem[]): ReactNode => {
    const collapsed = hubPolicyCollapsed.includes(group.id)
    // 启用数按当前草稿算（含前缀覆盖与锁定项），勾选后立刻反映。
    const enabled = group.items.filter((item) => item.locked === true
      || hubPolicySelected(item.name, item.prefix === true)
      || (item.prefix !== true && hubPolicyPrefixCovered(item.name))).length
    const isStale = group.kind === 'stale'
    return h('div', { key: group.id, className: 'sm-card' },
      h('div', { key: 'head', className: 'sm-row' },
        h('button', {
          key: 'chev', type: 'button', className: 'sm-chevbtn',
          title: collapsed ? t('hubPolicy.group.expand') : t('hubPolicy.group.collapse'),
          onClick: () => toggleHubPolicyGroup(group.id),
        }, collapsed ? '▸' : '▾'),
        h('h3', { key: 'title', style: { margin: 0 } }, hubPolicyGroupLabel(group)),
        group.inferred
          ? h('span', { key: 'inferred', className: 'sm-badge', title: t('hubPolicy.inferred.tip') }, t('hubPolicy.inferred'))
          : null,
        group.synthetic === true
          ? h('span', { key: 'synthetic', className: 'sm-badge', title: t('hubPolicy.synthetic.tip') }, t('hubPolicy.synthetic'))
          : null,
        h('span', { key: 'count', className: 'sm-badge' },
          hubPolicyNeedle.length > 0
            ? t('hubPolicy.group.match', { count: items.length, total: group.total })
            : t('hubPolicy.group.count', { count: group.total })),
        h('span', { key: 'enabled', className: 'sm-badge' },
          t('hubPolicy.group.enabled', { enabled })),
        isStale
          ? h(Button, {
              key: 'clean', size: 'sm', label: t('hubPolicy.stale.clean', { count: group.items.length }),
              title: t('hubPolicy.stale.tip'),
              disabled: group.items.every((item) => item.locked === true),
              onClick: () => cleanHubPolicyStale(),
            })
          : null,
      ),
      group.hint && !collapsed ? h('div', { key: 'hint', className: 'sm-muted' }, group.hint) : null,
      collapsed ? null : h('div', { key: 'rows', className: 'sm-list' }, items.map(hubPolicySwitch)),
    )
  }

  const hubPolicyView: ReactNode = !hubPolicy || !hubPolicyDraft
    ? h(EmptyState, { key: 'loading', label: t('hubPolicy.loading'), hint: t('hubPolicy.loading.hint') })
    : h('div', { key: 'hp' },
        h('div', { key: 'head', className: 'sm-card' },
          h('div', { key: 'line', className: 'sm-row' },
            h('span', { key: 'model', className: 'sm-title' },
              t('hubPolicy.model', { count: hubPolicyCount })),
            h('span', { key: 'source', className: 'sm-badge' },
              hubPolicy.source === 'stored' ? t('hubPolicy.source.stored') : t('hubPolicy.source.default')),
            h('span', { key: 'mode', className: 'sm-badge' },
              hubPolicy.catalogMeta.mode === 'fallback' ? t('hubPolicy.catalog.fallback') : t('hubPolicy.catalog.dynamic')),
          ),
          h('div', { key: 'meta', className: 'sm-muted' },
            t('hubPolicy.catalog.meta', { tools: hubPolicy.catalogMeta.toolCount, groups: hubPolicy.catalogMeta.groupCount }),
            hubPolicy.catalogMeta.syntheticCount > 0
              ? ' · ' + t('hubPolicy.catalog.synthetic', { count: hubPolicy.catalogMeta.syntheticCount })
              : '',
            ' · ',
            t('hubPolicy.lastRefresh', { time: fmtTime(hubPolicy.catalogMeta.generatedAt) })),
          hubPolicy.catalogMeta.warning
            ? h('div', { key: 'warning', className: 'sm-warnbox' }, hubPolicy.catalogMeta.warning)
            : null,
          h('div', { key: 'hint', className: 'sm-muted' }, t('hubPolicy.hint')),
          h('div', { key: 'actions', className: 'sm-actions' },
            h(Button, {
              key: 'reset', label: t('hubPolicy.reset'),
              onClick: () => void run(async () => api.setHubPolicy(cwd, { reset: true }), () => void refreshHubPolicy()),
            }),
            h(Button, {
              key: 'save', variant: 'primary', label: t('hubPolicy.save'),
              onClick: () => void run(async () => api.setHubPolicy(cwd, {
                tools: hubPolicyDraft.tools, prefixes: hubPolicyDraft.prefixes,
              }), () => void refreshHubPolicy()),
            }),
          ),
          h('div', { key: 'search', className: 'sm-form' },
            h('input', {
              key: 'searchInput', className: 'sm-input', value: hubPolicyQuery,
              placeholder: t('hubPolicy.search.placeholder'),
              onChange: (event: { target: { value: string } }) => setHubPolicyQuery(event.target.value),
            }),
            h(Button, { key: 'refresh', label: t('hubPolicy.refresh'), onClick: () => void refreshHubPolicyCatalog() }),
          ),
          h('div', { key: 'add', className: 'sm-form' },
            h('input', {
              key: 'input', className: 'sm-input', value: hubPolicyCustom,
              placeholder: t('hubPolicy.custom.placeholder'),
              onChange: (event: { target: { value: string } }) => setHubPolicyCustom(event.target.value),
              onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') hubPolicyAddCustom() },
            }),
            h(Button, { key: 'addBtn', label: t('hubPolicy.custom.add'), onClick: () => hubPolicyAddCustom() }),
          ),
        ),
        hubPolicyFiltered.length === 0
          ? h(EmptyState, { key: 'noMatch', label: t('hubPolicy.empty'), hint: t('hubPolicy.empty.hint') })
          : h('div', { key: 'groups', className: 'sm-list' },
              hubPolicyFiltered.map((row) => hubPolicyGroupCard(row.group, row.items))),
      )

  // R10: memories are edited and read as title + tags + body. The search box
  // filters on every field, but the *hit source* is visible: a title/tag match
  // is highlighted, so the user never has to scan the body to find a record.
  // R30 需求②: 第一级只列记忆集卡片（见 collectionList），条目在下钻页里。
  const memoriesView: ReactNode = [
    h('div', { key: 'search', className: 'sm-form' },
      h('input', {
        key: 'input', className: 'sm-input', value: memoryQuery, placeholder: t('memory.collection.search'),
        onChange: (event: { target: { value: string } }) => setMemoryQuery(event.target.value),
      }),
      h(Button, { key: 'go', label: t('hub.refresh'), onClick: () => void refreshMemoryCollections() }),
    ),
    collectionList,
  ]


  // R10: a composite tool is read as title + tags + body too: the title and
  // tags are the index (which flow, which tools), the description is the body
  // that the model sees, and steps stay below as execution detail.
  const toolsView: ReactNode = [
    h('div', { key: 'list', className: 'sm-list' },
      tools.length === 0
        ? h(EmptyState, { key: 'empty', label: t('tool.empty'), hint: t('tool.empty.hint') })
        : tools.map((tool) =>
            h('div', { key: tool.id, className: 'sm-item' },
              // R22 需求③: 点标题行展开/收起该能力的完整定义——入口命令、文档、
              // 适用范围、路由描述、执行/预演方式、健康度与使用统计都在下面。
              h('div', {
                key: 'head', className: 'sm-row', 'data-clickable': 'true',
                title: t('tool.detail.toggle'),
                style: { cursor: 'pointer' },
                onClick: () => setExpandedTool(expandedTool === tool.id ? undefined : tool.id),
              },
                h('span', { key: 'caret', className: 'sm-caret' }, expandedTool === tool.id ? '▾' : '▸'),
                h('span', { key: 'title', className: 'sm-title' }, tool.title || tool.name),
                h('span', { key: 'kind', className: 'sm-badge' }, kindLabel(tool.kind, t)),
                tool.source === 'auto' ? h('span', { key: 'auto', className: 'sm-badge' }, t('tool.badge.auto')) : null,
                tool.entryDraft && !tool.entryVerified
                  ? h('span', { key: 'draft', className: 'sm-badge' }, t('tool.badge.draft'))
                  : null,
                h('span', { key: 'status', className: 'sm-badge' }, tool.enabled === false ? 'retired' : tool.status),
                h('span', { key: 'live', className: 'sm-badge' }, tool.live ? t('tool.live') : t('tool.offline')),
              ),
              tagChips(tool.tags),
              expandedTool === tool.id
                ? h('div', { key: 'detail', className: 'sm-detail' }, capabilityDetail(tool, t))
                : null,
              editingTool && editingTool.id === tool.id
                ? h('div', { key: 'edit' },
                    h('div', { key: 'title', className: 'sm-form-row' },
                      h('input', {
                        key: 't', className: 'sm-input', value: editingTool.title, placeholder: t('memory.title.placeholder'),
                        onChange: (event: { target: { value: string } }) => setEditingTool({ ...editingTool, title: event.target.value }),
                      }),
                      h('input', {
                        key: 'tags', className: 'sm-input', value: editingTool.tags.join('，'), placeholder: t('memory.tags.placeholder'),
                        onChange: (event: { target: { value: string } }) => setEditingTool({ ...editingTool, tags: splitTags(event.target.value) }),
                      }),
                    ),
                    h('textarea', {
                      key: 'input', className: 'sm-textarea', value: editingTool.description,
                      onChange: (event: { target: { value: string } }) => setEditingTool({ ...editingTool, description: event.target.value }),
                    }),
                    h('div', { className: 'sm-form-label' }, t('tool.body.label')),
                    h('textarea', {
                      key: 'body', className: 'sm-textarea', value: editingTool.body, rows: 12,
                      placeholder: t('tool.body.placeholder'),
                      onChange: (event: { target: { value: string } }) => setEditingTool({ ...editingTool, body: event.target.value }),
                    }),
                    h('div', { className: 'sm-actions' },
                      h(Button, {
                        key: 'save', variant: 'primary', label: t('tool.desc.save'),
                        onClick: () => void run(async () => api.editTool(tool.id, {
                          title: editingTool.title, tags: editingTool.tags, description: editingTool.description,
                        }), () => { setEditingTool(undefined); void refreshTools() }),
                      }),
                      h(Button, {
                        key: 'saveBody', label: t('tool.body.save'),
                        onClick: () => void run(async () => api.editTool(tool.id, { body: editingTool.body }), () => { setEditingTool(undefined); void refreshTools() }),
                      }),
                      h(Button, { key: 'cancel', label: t('memory.cancel'), onClick: () => setEditingTool(undefined) }),
                    ),
                  )
                : h('div', { key: 'desc' },
                    h('div', { className: 'sm-body-text' }, tool.description || '—'),
                    h('div', { className: 'sm-actions' },
                      tool.kind === 'proposal'
                        ? h(Button, {
                            key: 'accept', variant: 'primary', label: t('tool.accept'),
                            onClick: () => void run(async () => api.acceptProposal(cwd, tool.id), () => void refreshTools()),
                          })
                        : null,
                      tool.kind === 'proposal'
                        ? h(Button, {
                            key: 'decline', label: t('tool.decline'),
                            onClick: () => void run(async () => api.declineProposal(cwd, tool.id), () => void refreshTools()),
                          })
                        : null,
                      tool.kind === 'capability' && tool.entry
                        ? h(Button, {
                            key: 'preview', label: t('tool.preview'),
                            onClick: () => void run(async () => {
                              const result = await api.runTool(tool.id)
                              const detail = [result.summary, result.stdout ? result.stdout.slice(0, 1200) : '', result.stderr ? result.stderr.slice(0, 800) : '']
                                .filter(Boolean).join('\n')
                              return { status: result.status === 'failed' ? 'error' as const : 'ok' as const, message: detail }
                            }),
                          })
                        : null,
                      tool.entryDraft && !tool.entryVerified
                        ? h(Button, {
                            key: 'enableRun', variant: 'primary', label: t('tool.enableRun'),
                            onClick: () => void run(async () => api.editTool(tool.id, { entry: tool.entryDraft, changelog: '人工启用执行（入口草稿已验证）' }), () => void refreshTools()),
                          })
                        : null,
                      tool.kind !== 'proposal'
                        ? h(Button, {
                            key: 'edit', label: t('tool.desc.edit'),
                            onClick: () => setEditingTool({ id: tool.id, title: tool.title, tags: tool.tags, description: tool.description, body: tool.body ?? '' }),
                          })
                        : null,
                      tool.kind !== 'proposal'
                        ? (tool.status === 'active'
                            ? h(Button, {
                                key: 'retire', variant: 'danger', label: t('tool.retire'),
                                onClick: () => void run(async () => api.editTool(tool.id, { status: 'retired' }), () => void refreshTools()),
                              })
                            : h(Button, {
                                key: 'enable', variant: 'primary', label: t('tool.enable'),
                                onClick: () => void run(async () => api.editTool(tool.id, { status: 'active' }), () => void refreshTools()),
                              }))
                        : null,
                      // Delete archives the knowledge face (never hard-deletes).
                      confirmDeleteTool === tool.id
                        ? h(Button, {
                            key: 'delYes', variant: 'danger', label: t('tool.deleteConfirm'),
                            onClick: () => void run(async () => api.deleteTool(tool.id), () => { setConfirmDeleteTool(undefined); void refreshTools(); void refreshHub() }),
                          })
                        : h(Button, {
                            key: 'del', variant: 'danger', label: t('tool.delete'),
                            onClick: () => setConfirmDeleteTool(tool.id),
                          }),
                      confirmDeleteTool === tool.id
                        ? h(Button, { key: 'delNo', label: t('memory.cancel'), onClick: () => setConfirmDeleteTool(undefined) })
                        : null,
                    ),
                  ),
              tool.steps.length > 0
                ? h('div', { className: 'sm-sub' }, t('tool.steps') + '：' + tool.steps.join(' → '))
                : h('div', { className: 'sm-sub' },
                    t('tool.detail.entry') + '：' + (tool.entry || '—')
                    + ' · ' + t('tool.detail.scope') + '：' + (tool.scope || '—')
                    + ' · ' + t('tool.detail.skill') + '：' + (tool.skillPath || '—')),
              h('div', { className: 'sm-sub' },
                t('tool.runCount') + '：' + (tool.runCount ?? tool.useCount)
                + ' · ' + t('tool.loadCount') + '：' + (tool.loadCount ?? 0)
                + ' · ' + t('tool.conversion') + '：' + (tool.loadsToRuns ?? 0)
                + ' · ' + t('tool.successRate') + '：' + (tool.successRate ?? 0)
                + ' · ' + t('tool.detail.last') + '：' + (tool.lastStatus ?? '—')),
              // R26: 能力卡片显示定义版本与使用明细（成败/连续失败/最近一次执行）。
              // R28 需求②: 再补上增加时间与最后使用时间（缺字段显示 —）。
              tool.version !== undefined || tool.usage?.lastStatus
                || tool.createdAt !== undefined || tool.usage?.lastUsedAt !== undefined
                ? h('div', { key: 'capmeta', className: 'sm-sub' },
                    `${tool.version !== undefined ? `版本 v${tool.version} · ` : ''}`
                    + (tool.usage?.lastStatus
                      ? `最近执行 ${tool.usage.lastStatus === 'completed' ? '成功' : '失败'}${tool.usage.lastDryRun ? '（预演）' : ''}`
                        + ` · 成功 ${tool.usage.successCount}/失败 ${tool.usage.failCount}`
                        + (tool.usage.consecutiveFailures >= 2 ? ` · 连续失败 ${tool.usage.consecutiveFailures}` : '')
                      : '')
                    + (tool.createdAt !== undefined || tool.usage?.lastUsedAt !== undefined
                      ? `${tool.version !== undefined || tool.usage?.lastStatus ? ' · ' : ''}`
                        + `${t('tool.detail.created')} ${fmtTime(tool.createdAt)}`
                        + ` · ${t('tool.detail.lastUsed')} ${fmtTime(tool.usage?.lastUsedAt)}`
                      : ''))
                : null,
            ),
          ),
    ),
  ]

  // R19 需求⑤: the in-panel conversation. Reading uses the host's
  // sessionQuery surface (the same model-visible fold); sending is a followup
  // into the live session (or one resume for a cold one). The DSH session page
  // stays available through 「打开会话」 but is no longer required to talk.
  const chatView: ReactNode = view.kind === 'chat'
    ? h('div', { key: 'chat', className: 'sm-chat' },
        h('div', { key: 'head', className: 'sm-chat-head' },
          h('span', { key: 'title', className: 'sm-title' }, chatData?.title || view.id.slice(-8)),
          chatData?.live
            ? h('span', { key: 'live', className: 'sm-badge' }, t('chat.live'))
            : h('span', { key: 'cold', className: 'sm-badge' }, t('chat.cold')),
          chatData?.truncated ? h('span', { key: 'tr', className: 'sm-badge' }, t('chat.truncated')) : null,
          h('span', { key: 'grow', style: { flex: 1 } }),
          h(Button, { key: 'refresh', size: 'sm', label: t('chat.refresh'), onClick: () => void loadChat(view.id) }),
          h(Button, { key: 'open', size: 'sm', label: t('chat.open'), onClick: () => api.openSession(view.id) }),
        ),
        chatError ? h('div', { key: 'err', className: 'sm-error' }, chatError) : null,
        chatData?.note ? h('div', { key: 'note', className: 'sm-muted' }, chatData.note) : null,
        // R19 协同②: a hub's conversation shows its linked branches right above
        // the messages; a branch's conversation shows none (it owns no branches).
        chatBranches.length > 0 ? BranchList({ rows: chatBranches, t, onOpen: openChat, compact: true }) : null,
        (chatData?.messages ?? []).length === 0 && !chatData?.note
          ? h(EmptyState, { key: 'empty', label: t('chat.empty'), hint: t('chat.empty.hint') })
          : h('div', { key: 'msgs', className: 'sm-list' },
              (chatData?.messages ?? []).map((message) =>
                h('div', { key: `${message.role}-${message.seq}`, className: 'sm-msg', 'data-role': message.role },
                  h('span', { key: 'role', className: 'sm-msg-role' },
                    message.role === 'user' ? t('chat.you')
                      : message.role === 'assistant' ? t('chat.assistant')
                        : t('chat.tool')),
                  h('div', { key: 'text', className: 'sm-msg-text' }, message.text),
                ),
              ),
            ),
        h('div', { key: 'bar', className: 'sm-chat-bar' },
          h('textarea', {
            key: 'input', className: 'sm-textarea', value: chatDraft, rows: 3,
            placeholder: t('chat.placeholder'),
            onChange: (event: { target: { value: string } }) => setChatDraft(event.target.value),
            onKeyDown: (event: { key: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void }) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void sendChat(view.id)
              }
            },
          }),
          h(Button, {
            key: 'send', variant: 'primary', label: t('chat.send'),
            disabled: chatSending || !chatDraft.trim(),
            onClick: () => void sendChat(view.id),
          }),
        ),
        h('div', { key: 'hint', className: 'sm-muted' }, t('chat.hint')),
      )
    : null

  // R41 需求①a/b: 「设置」页签——设置即权限与默认模型的单一入口。
  // 上半部是默认模型（中枢/分支），下半部沿用 R36/R39 的中枢权限（动态目录、
  // 按来源分组、锁定项、失效清理），不再有独立的「中枢权限」页签。
  const modelDefaultsCard = (): ReactNode => {
    const choices = catalog?.models ?? []
    const known = (value: string): boolean => choices.some((model) => `${model.provider}/${model.id}` === value)
    const select = (key: string, value: string, onChange: (next: string) => void): ReactNode =>
      h('select', {
        key, className: 'sm-opt-select', value,
        onChange: (event: { target: { value: string } }) => onChange(String(event.target.value)),
      },
        h('option', { key: 'follow', value: '' }, t('settings.models.follow')),
        choices.map((model) => {
          const id = `${model.provider}/${model.id}`
          return h('option', { key: id, value: id, title: model.name || undefined }, id)
        }),
        value && !known(value) ? h('option', { key: 'custom', value }, value) : null,
      )
    const saveDefaults = (): void => void run(async () => {
      const parse = (text: string): { provider: string; model: string } | null => {
        const slash = text.indexOf('/')
        return slash > 0 ? { provider: text.slice(0, slash), model: text.slice(slash + 1) } : null
      }
      return api.setModelDefaults(cwd, {
        hub: hubModelDraft ? parse(hubModelDraft) : null,
        branch: branchModelDraft ? parse(branchModelDraft) : null,
      })
    }, () => void refreshModelDefaults())
    return h('div', { key: 'models', className: 'sm-card' },
      h('div', { key: 'head', className: 'sm-row' },
        h('h3', { key: 'title' }, t('settings.models.title')),
        h('span', { key: 'source', className: 'sm-badge' },
          modelDefaults?.source === 'stored' ? t('hubPolicy.source.stored') : t('hubPolicy.source.default')),
      ),
      h('div', { key: 'hint', className: 'sm-muted' }, t('settings.models.hint')),
      h('div', { key: 'form', className: 'sm-form' },
        h('label', { key: 'hub', className: 'sm-opt' },
          h('span', { key: 'label', className: 'sm-opt-label' }, t('settings.models.hub')),
          select('hub', hubModelDraft, setHubModelDraft),
        ),
        h('label', { key: 'branch', className: 'sm-opt' },
          h('span', { key: 'label', className: 'sm-opt-label' }, t('settings.models.branch')),
          select('branch', branchModelDraft, setBranchModelDraft),
        ),
      ),
      h('div', { key: 'actions', className: 'sm-actions' },
        h(Button, {
          key: 'save', variant: 'primary', label: t('settings.models.save'),
          disabled: !cwd, onClick: saveDefaults,
        }),
        h(Button, {
          key: 'reset', label: t('settings.models.reset'),
          disabled: !cwd,
          onClick: () => void run(async () => api.setModelDefaults(cwd, { reset: true }), () => void refreshModelDefaults()),
        }),
      ),
      h('div', { key: 'precedence', className: 'sm-desc' }, t('settings.models.precedence')),
    )
  }

  // R45 需求④: 最小插入——在设置页签追加「已生成的 skills」，不改动既有的
  // 默认模型/中枢权限卡片结构（任务 B 正在改的页签布局保持原样）。
  const skillsCard = (): ReactNode => h('div', { key: 'skills', className: 'sm-card' },
    h('div', { key: 'head', className: 'sm-row' },
      h('h3', { key: 'title' }, t('settings.skills.title')),
      h('span', { key: 'count', className: 'sm-badge' }, String(skills.length)),
    ),
    h('div', { key: 'hint', className: 'sm-muted' }, t('settings.skills.hint')),
    skills.length === 0
      ? h('div', { key: 'empty', className: 'sm-muted' }, t('settings.skills.empty'))
      : h('div', { key: 'list', className: 'sm-form' },
          skills.map((skill) => h('div', { key: skill.name, className: 'sm-form-row' },
            h('div', { key: 'meta', className: 'sm-desc' },
              h('strong', null, skill.name), ' ',
              h('span', { key: 'ver', className: 'sm-badge' }, 'v' + skill.version), ' ',
              h('span', { key: 'uses', className: 'sm-muted' }, t('settings.skills.uses', { count: skill.useCount })),
              skill.enabled ? null : h('span', { key: 'off', className: 'sm-badge' }, t('settings.skills.disabled')),
            ),
            h('input', {
              key: 'desc', className: 'sm-input',
              value: skillDrafts[skill.name] ?? skill.description,
              onChange: (event: { target: { value: string } }) => setSkillDrafts((draft) => ({ ...draft, [skill.name]: String(event.target.value) })),
            }),
            h(Button, {
              key: 'save', label: t('settings.skills.save'), disabled: !cwd,
              onClick: () => void run(async () => api.updateSkill(cwd, skill.name, { description: skillDrafts[skill.name] ?? skill.description }), () => void refreshSkills()),
            }),
            h(Button, {
              key: 'toggle', label: skill.enabled ? t('settings.skills.disable') : t('settings.skills.enable'), disabled: !cwd,
              onClick: () => void run(async () => api.updateSkill(cwd, skill.name, { enabled: !skill.enabled }), () => void refreshSkills()),
            }),
          )),
        ),
  )

  const settingsView: ReactNode = h('div', { key: 'settings' },
    modelDefaultsCard(),
    h('div', { key: 'policyTitle', className: 'sm-section-title' }, t('settings.policy.title')),
    hubPolicyView,
  )

  const body = view.kind === 'hub' ? hubView
    : view.kind === 'sets' ? setsView
      : view.kind === 'topic' ? topicView
        : view.kind === 'branches' ? branchesView
          : view.kind === 'memories' ? memoriesView
            : view.kind === 'memory-collection' ? memoryCollectionView
              : view.kind === 'memory-detail' ? memoryDetailView
                : view.kind === 'settings' ? settingsView
                  : view.kind === 'chat' ? chatView
                    : toolsView

  // R18 需求①: the panel is a two-column shell — a hub-session rail on the
  // left and the active view on the right. Under 760px the rail folds into a
  // horizontal strip (pure CSS).
  const sideRail = h('aside', { key: 'side', className: 'sm-side' },
    h('div', { key: 'head', className: 'sm-side-head', title: t('side.authority') },
      h('span', { key: 'title' }, t('side.title')),
      h('span', { key: 'count', className: 'sm-side-count' }, t('side.count', { count: hubs.length })),
    ),
    hubs.length === 0
      ? h('div', { key: 'empty', className: 'sm-side-empty' }, `${t('side.empty')} · ${t('side.empty.hint')}`)
      : h('div', { key: 'list', className: 'sm-side-list' },
          hubs.map((hubRow) => {
            // R19 需求⑤: a rail click takes over the conversation IN the panel;
            // 「打开会话」 remains the explicit navigation path inside the chat.
            // R41 需求②: ONE selection source (see src/rail-selection.ts). The
            // old OR compared BOTH, so opening any hub in the panel highlighted
            // that row AND the shell session's row (two highlights at once).
            const current = isRailCurrent(view, hubRow.sessionId, sessionId)
            return h('button', {
              key: hubRow.sessionId,
              type: 'button',
              className: 'sm-hub',
              'data-current': String(current),
              title: `${hubRow.title}${hubRow.topicSetTitle ? ` · 话题集 ${hubRow.topicSetTitle}` : ''} · ${hubRow.sessionId}`,
              onClick: () => openChat(hubRow.sessionId),
            },
              hubRow.live
                ? h('span', { key: 'dot', className: 'sm-dot', title: t('side.running') })
                : null,
              h('span', { key: 'title', className: 'sm-hub-title' }, hubRow.title || hubRow.sessionId.slice(-4)),
              hubRow.topicSetTitle
                ? h('span', { key: 'set', className: 'sm-hub-meta sm-hub-set', title: `${t('badge.hubSet.tip', { title: hubRow.topicSetTitle })}` }, hubRow.topicSetTitle)
                : null,
              hubRow.branches > 0
                ? h('span', {
                    key: 'branches', className: 'sm-hub-meta',
                    title: t('side.branches', { count: hubRow.branches, working: hubRow.workingBranches }),
                  }, hubRow.workingBranches > 0 ? `${hubRow.branches}·${hubRow.workingBranches}` : String(hubRow.branches))
                : null,
              current ? h('span', { key: 'cur', className: 'sm-hub-meta' }, t('side.current')) : null,
            )
          }),
        ),
    h('div', { key: 'foot', className: 'sm-side-foot' },
      h(Button, {
        // 需求②: clicking 「＋ 新中枢会话」 creates a hub session right away (no
        // intermediate form); the receipt appears in the hub tab.
        key: 'new', className: 'sm-newhub', size: 'sm', label: t('side.new'),
        title: t('composer.title'),
        disabled: launching,
        onClick: () => { void createHubNow() },
      }),
    ),
  )

  const bodyScroll = h('div', { key: 'body', className: 'sm-body' },
    loading ? h('div', { key: 'loading', className: 'sm-muted' }, '…') : null,
    error ? h('div', { key: 'error', className: 'sm-error' }, error) : null,
    notice ? h('div', { key: 'notice', className: 'sm-ok' }, notice) : null,
    body,
  )

  // R19 需求②: the header selector is THE workspace source. A cwd that is not
  // in the shell's workspace list (a session in a closed workspace) still
  // appears as an option so the panel never points somewhere unselectable.
  const wsOptions: Array<{ path: string; label: string }> = workspaces.map((workspace) => ({
    path: workspace.path,
    label: workspace.title || workspace.path,
  }))
  if (cwd && !wsOptions.some((option) => option.path === cwd)) wsOptions.unshift({ path: cwd, label: cwd })

  // R19 需求⑦: memory editing is a modal, in both this panel and the web
  // console — never an inline row that pushes the list around.
  const memoryModal: ReactNode = editingMemory
    ? h('div', {
        key: 'memory-modal', className: 'sm-modal-backdrop',
        onClick: () => setEditingMemory(undefined),
      },
        h('div', {
          key: 'dialog', className: 'sm-modal', role: 'dialog', 'aria-modal': 'true',
          onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
        },
          h('h3', { key: 'title' }, t('memory.modal.title')),
          h('p', { key: 'hint', className: 'sm-modal-hint' }, t('memory.modal.hint')),
          h('div', { key: 'meta', className: 'sm-form-row' },
            h('input', {
              key: 't', className: 'sm-input', value: editingMemory.title, placeholder: t('memory.title.placeholder'),
              onChange: (event: { target: { value: string } }) => setEditingMemory({ ...editingMemory, title: event.target.value }),
            }),
            h('input', {
              key: 'tags', className: 'sm-input', value: editingMemory.tags.join('，'), placeholder: t('memory.tags.placeholder'),
              onChange: (event: { target: { value: string } }) => setEditingMemory({ ...editingMemory, tags: splitTags(event.target.value) }),
            }),
          ),
          h('textarea', {
            key: 'body', className: 'sm-textarea', value: editingMemory.text,
            placeholder: t('memory.new.placeholder'),
            onChange: (event: { target: { value: string } }) => setEditingMemory({ ...editingMemory, text: event.target.value }),
          }),
          h('div', { key: 'actions', className: 'sm-actions' },
            h(Button, {
              key: 'save', variant: 'primary', label: t('memory.save'),
              onClick: () => void run(async () => api.updateMemory(
                cwd,
                editingMemory.id,
                editingMemory.text,
                editingMemory.key,
                editingMemory.title,
                editingMemory.tags,
              ), () => { setEditingMemory(undefined); void refreshMemoryViews() }),
            }),
            h(Button, { key: 'cancel', label: t('memory.cancel'), onClick: () => setEditingMemory(undefined) }),
          ),
        ),
      )
    : null

  // Compact head (R18 需求⑥): one row — brand, workspace selector, count pills.
  const main = h('main', { key: 'main', className: 'sm-main' },
    h('div', { key: 'head', className: 'sm-head' },
      h('span', { key: 'brand', className: 'sm-brand' }, t('panel.title')),
      wsOptions.length > 0
        ? h('label', { key: 'ws', className: 'sm-ws' },
            h('span', { key: 'label', className: 'sm-opt-label' }, t('workspace.label')),
            h('select', {
              key: 'select', className: 'sm-ws-select', value: cwd,
              title: cwd,
              onChange: (event: { target: { value: string } }) => changeWorkspace(event.target.value),
            }, wsOptions.map((option) => h('option', { key: option.path, value: option.path }, option.label))),
          )
        : hub ? h('span', { key: 'sub', className: 'sm-head-sub' }, hub.workspaceKey) : null,
      hub
        ? h('div', { key: 'pills', className: 'sm-pills' },
            h('span', { key: 'sets', className: 'sm-pill' }, `${t('tab.sets')} ${hub.topicSets.length}`),
            h('span', { key: 'mem', className: 'sm-pill' }, `${t('tab.memories')} ${hub.counts.memories}`),
            h('span', { key: 'tools', className: 'sm-pill' }, `${t('tab.tools')} ${hub.counts.tools}`),
          )
        : null,
    ),
    h('div', { key: 'tabs', className: 'sm-tabs' },
      h('button', { key: 'hub', ...tabProps('hub') }, t('tab.hub')),
      h('button', { key: 'sets', ...tabProps('sets') }, t('tab.sets')),
      // R44 需求②: 分支会话独立页签（原中枢页签的「全部分支会话」卡）。
      h('button', { key: 'branches', ...tabProps('branches') }, t('tab.branches')),
      h('button', { key: 'memories', ...tabProps('memories') }, t('tab.memories')),
      h('button', { key: 'tools', ...tabProps('tools') }, t('tab.tools')),
      h('button', { key: 'settings', ...tabProps('settings') }, t('tab.settings')),
    ),
    bodyScroll,
  )

  return h('div', { className: 'sm-panel', 'data-sm-panel': 'true' },
    h('div', { key: 'shell', className: 'sm-shell' }, sideRail, main),
    memoryModal,
  )
}
