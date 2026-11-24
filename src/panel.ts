/**
 * Host-side panel data channel (§1.5): a `supermemoryPanel` service exposed to
 * the Web client through the typert remote registry, so the in-app SuperMemory
 * panel (P1.5 client bundle) can browse memories, manage topic sets, create
 * topic-set sessions, reply into topic-set branches, and edit composite tools.
 * The command/tool fallbacks (/memory topicsets, /memory switch, memory_topicsets)
 * cover the same data; this service is the seam the client bundle calls.
 * @module supermemory/panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage, createUserMessage as CreateUserMessage } from '@deepseek-ai/dsh-llm'
import { loadHostModule } from './host.ts'
import type { ToolMemory } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import {
  addMember, createTopicSet, getRouting, getTopicSet, listTopicSets, setRouting,
  topicSetIdsOf, touchTopicSet, updateTopicSetSummary,
} from './topicsets.ts'
import { TITLE_FALLBACK, TOPIC_SET_TITLE_MAX_CHARS, applySessionTitle, clipEllipsis, currentSessionTitle, describeSessionTitle, ensureMemberTitle } from './title.ts'
import { attachBranchToWorkspace } from './workspace.ts'
import { branchHandles, compositionSetup } from './dispatch.ts'
import {
  bumpCompositeUse, capabilityAppliesToWorkspace, capabilityHealthOf, deleteCompositeTool, editCompositeTool,
  liveCompositeSpecs, runCapability, type CapabilityRunResult, type CompositeSpec,
} from './composite.ts'
import { enumerateModels, type ModelSelection } from './model.ts'
import { tokenize } from './recall.ts'
// R22 需求⑤: 面板新建记忆与 memory_remember 共用同一套集合归属判定。
import { collectionTierNote, listCollections, resolveCollectionForEntry, touchCollection } from './memory-collections.ts'
// R30 需求①: 面板写路径与 memory_remember 共用同一套版本化更新（不允许绕过）。
import {
  createMemoryVersioned, currentVersionOf, findMemoryByKey, memoryContentUnchanged, memoryHistoryOf,
  updateMemoryVersioned,
} from './memory-versions.ts'
// R27 需求④.2: 面板粘贴长文同样整形为原子记忆（与 memory_remember 同一条路径）。
import { splitMemoryEntries } from './memory-split.ts'
import { TITLE_MAX, assessConclusion, deriveTitle, mergeTags, normalizeTags, tagsOfBody } from './retrieval.ts'
import { isPluginBranchId, listHubSessions, hubSessionTitle, type HubSessionView } from './hub-sessions.ts'
// R36 需求①②: 中枢白名单（默认拒绝）的读写；R39：动态目录按来源分组。
import {
  DEFAULT_HUB_PREFIXES, DEFAULT_HUB_TOOLS, LOCKED_HUB_TOOLS,
  buildFallbackHubCatalog, buildHubCatalog, cleanStaleHubPolicy, declaredHubToolSource,
  readHubPolicy, resetHubPolicy, writeHubPolicy,
  type HubCatalogGroup, type HubCatalogItem, type HubCatalogMeta, type HubCatalogSnapshot,
  type HubToolDescriptor, type ResolvedHubPolicy,
} from './hub-policy.ts'
import { BRANCH_CARD_EXCERPT_CHARS, hubsByBranch, latestTaskByBranch, listHubBranches, listWorkspaceBranches, taskExcerpt, type HubBranchView } from './hub-branches.ts'
import { latestBranchMeta } from './branch-meta.ts'
import { fillTopicShapeOnCreate, noteTopicSetActivated } from './topic-shape.ts'
import { recordHubSession } from './role.ts'
import { defaultModelFor, readModelDefaults, writeModelDefaults, type ModelDefaultsView } from './model-defaults.ts'

export interface TopicSetView {
  id: string
  title: string
  /** Tags (the topic set's `keywords`): the cheap index a query/UI filters on. */
  tags: string[]
  /** Body: the topic set's running summary. */
  summary: string
  /** Session count (R11: the 话题集 tab shows how many sessions a set holds). */
  sessions: number
  /** How many of those sessions are currently live. */
  live: number
  /**
   * R30 需求③: the set's lifecycle (listTopicSets only lists active ones;
   * listAllTopicSets — the hub's management view — carries archived sets too).
   */
  status?: 'active' | 'archived'
  branches: Array<{
    sessionId: string
    kind: 'root' | 'fork'
    title: string
    status: string
    model?: string
    /** Owning set of this branch row (R19 协同③: the card is self-describing). */
    topicSetId?: string
    topicSetTitle?: string
    /** Distinct hubs that dispatched into this branch (>=2 means 共享). */
    hubs?: number
    /**
     * Latest task excerpt dispatched into this branch (durable ledger read).
     * Carried so a preserved branch stays identifiable after a restart —
     * title + owning set + task summary, without needing a live handle.
     */
    task?: string
    /** R30 需求④: the branch's tags (from its newest dispatch record). */
    tags?: string[]
  }>
  model?: string
}

export interface MemoryView {
  id: string
  title: string
  /** Tags (stored as `keywords`). */
  tags: string[]
  text: string
  key?: string
  status: string
  sourceSessionId: string
  createdAt: number
  updatedAt: number
  // R27 需求④: 所属记忆集合（两级模型的条目侧）。未归集时不设这三个字段，
  // 客户端据此显示「未归集」而不是空串。
  collectionId?: string
  collectionTitle?: string
  collectionTags?: string[]
  // R30 需求①: 当前版本号（旧记录读作 1；历史版本见 getMemoryDetail）。
  version?: number
}

/**
 * R30 需求②: 记忆页签第一级——记忆集合卡片（标题/标签/条目数/最近更新）。
 * 条目仍在 `memories` 表里，这里只给统计投影。
 */
export interface MemoryCollectionView {
  id: string
  title: string
  tags: string[]
  summary: string
  /** 该集合的条目数（active + superseded 全算，与 hubState 的 memories 计数一致）。 */
  count: number
  /** 集合内最近一次更新的时间戳。 */
  latestUpdatedAt: number
  status: string
  createdAt: number
  updatedAt: number
}

/**
 * R36 需求② / R39: 「中枢权限」页签快照。`tools`/`prefixes` 是当前生效的
 * 白名单（存储行或内置默认），`defaults` 是内置默认值，「恢复默认」对照它
 * 渲染；`catalog` 是每次调用即时生成的 DYNAMIC 目录（运行时全部工具按来源
 * 分组，默认拒绝），`catalogMeta` 记录生成时间/模式/回退告警，`stale` 是
 * 白名单有而运行时无的条目（单列最后一组，供一键清理）。
 */
export interface HubPolicyView {
  workspaceKey: string
  tools: string[]
  prefixes: string[]
  /** stored=工作区自有白名单；default=旧库无记录/读失败回退的内置默认。 */
  source: 'stored' | 'default'
  locked: string[]
  defaults: { tools: string[]; prefixes: string[] }
  catalog: HubCatalogGroup[]
  catalogMeta: HubCatalogMeta
  stale: HubCatalogItem[]
}

/** R36 需求②: 保存入参（整份替换或 reset）。 */
export interface HubPolicyPatch {
  tools?: string[]
  prefixes?: string[]
  reset?: boolean
}

/** R30 需求②: 记忆详情页——当前版本 + 全部历史版本（可展开）。 */
export interface MemoryVersionView {
  version: number
  updatedAt: number
  title: string
  tags: string[]
  text: string
  changeType: 'create' | 'update' | 'migrate'
  collectionId?: string
}

/** R30 需求②: 一条记忆的详情（当前字段 + 版本序列，最后一条即当前版本）。 */
export interface MemoryDetailView {
  view: MemoryView
  versions: MemoryVersionView[]
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
  /** R27: 行的创建时间（旧行在回填前是 undefined，客户端显示 —）。 */
  createdAt?: number
  // R22 能力（capability）字段；序列组合工具这些字段为空。
  kind?: 'sequence' | 'capability'
  entry?: string
  doc?: string
  scope?: string
  runnable?: boolean
  dryRunArg?: string
  writeConfirm?: boolean
  // R22 需求③: 能力详情面板要能读完一条能力的全部定义与健康信号——
  // 路由描述（何时优先用它）、是否内置及版本关系、文档/适用范围是否缺失、
  // 以及 capabilityHealthOf 给出的人读维护 notes。
  routeNote?: string
  builtin?: boolean
  builtinVersion?: number
  scopeMissing?: boolean
  docMissing?: boolean
  notes?: string[]
  // R26: 能力定义版本与使用明细（register 同名更新 +1；成败分列/连续失败/最近一次结果）。
  version?: number
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

/** One agent-preset row for the hub quick launcher (R7). */
export interface AgentPresetView {
  id: string
  name?: string
  description?: string
  isDefault: boolean
}

/** Runtime provider/model catalog for the hub quick launcher (R7). */
export interface ModelCatalogView {
  providers: Array<{ id: string; name: string }>
  models: Array<{ provider: string; id: string; name: string }>
}

/** One permission-preset option of the process-level catalog (R7). */
export interface PermissionPresetView {
  value: string
  name: string
  description?: string
}

/** The permission catalog the hub quick launcher renders (R7). */
export interface PermissionCatalogView {
  options: PermissionPresetView[]
  defaultPreset: string
}

/** Choices applied to a session the plugin creates (R7); every field optional. */
export interface SessionOptions {
  /** Agent preset id (rides the creation metadata). */
  agentPreset?: string
  /** Provider/model route (rides the agent options). */
  model?: { provider: string; model: string; reasoningEffort?: string }
  /** Permission preset value (applied right after creation). */
  permission?: string
}

/**
 * Sidebar badge projection for one session (GUI 问题③): a topic-set branch
 * (with the set it belongs to and the member live status) or a plain hub
 * session. Consumed by the client half session-row badge.
 */
export type SessionBadge =
  | { kind: 'hub' }
  /**
   * R19 需求③: the session is a hub (a root member) of one active topic set.
   * It keeps its hub role and gets a 「话题集」 badge with the set name instead
   * of being mislabelled as a branch.
   */
  | { kind: 'hub-set'; topicSetId: string; topicSetTitle: string }
  | { kind: 'branch'; topicSetId: string; topicSetTitle: string; status: string }
  /**
   * R31 需求②: deliberately unbadged — a plugin branch that has not joined a
   * topic set yet, or an id this plugin cannot classify. The client renders
   * nothing; the kind exists so "no badge" is an explicit answer instead of
   * the old catch-all `hub`.
   */
  | { kind: 'none' }

/**
 * R18: the hub-session rail of the panel. Same shape as the host module's view
 * so the wire contract and the client type stay one vocabulary.
 */
export type HubSessionRow = HubSessionView

/** R18: auto-derived title/tags for a memory body (panel autofill). */
export interface MemoryShapeView {
  title: string
  tags: string[]
}

export interface PanelCounts {
  memories: number
  requirements: number
  episodes: number
  dispatches: number
  tools: number
}

export interface HubState {
  sessionId: string
  workspaceKey: string
  activeTopicSetId?: string
  topicSets: TopicSetView[]
  memories: MemoryView[]
  counts: PanelCounts
}

export interface MutationResult {
  status: 'ok' | 'error'
  message: string
  id?: string
}

/**
 * R19 需求⑤: one rendered message of a session's model-visible surface, as the
 * in-panel conversation renders it. Only user/assistant/tool turns are shown;
 * system prompts and developer/tool-declaration events stay out of the chat.
 */
export interface SessionMessageView {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  at: number
}

/** R19 需求⑤: a live/read-only view of one session for the in-panel chat. */
export interface SessionChatView {
  sessionId: string
  title: string
  live: boolean
  messages: SessionMessageView[]
  /** Older messages exist beyond the returned window. */
  truncated: boolean
  /** Degradation/why-this-is-empty note (host lacks sessionQuery, …). */
  note?: string
}

/** Structural view of `ctx.sessionQuery` (already used by hub-sessions). */
interface ChatSessionQueryLike {
  readSurface?(sessionId: string): Promise<{ session?: { id?: string }; events?: Array<{ seq?: number; type?: string; data?: unknown }> }>
  readTitleSnapshots?(sessionIds: readonly string[]): Promise<Array<{
    sessionId?: string
    status?: 'fulfilled' | 'rejected'
    value?: { title?: { title?: string } }
  }>>
}

/** Structural view of the live agent registry (send/resume side). */
interface ChatAgentsLike {
  get?(sessionId: string): { followup?(message: UserMessage): unknown } | undefined
  resume?(options: {
    resumeSessionId: string
    /** Composition (preset mount) for the resumed scope; see dispatch.ts. */
    setup?: (agentCtx: Context, agent: unknown) => Promise<void>
  }): Promise<{ agent: { followup(message: UserMessage): unknown } }>
}

/**
 * Sessions this panel resumed so the user can keep talking inside the panel.
 * Deliberately NOT disposed here: `resume` makes the session live for the user,
 * and killing it on a plugin reload would drop the conversation. DSH closes it
 * with the app.
 */
const resumedChatHandles = new Map<string, { agent: { followup(message: UserMessage): unknown } }>()

/** R30 需求②: 「未归集」虚拟集合的标题（id 为空串；与面板 locales 同一词汇）。 */
const UNGROUPED_TITLE = '未归集'

let createMessage: typeof CreateUserMessage | undefined
async function messageFactory(): Promise<typeof CreateUserMessage> {
  if (!createMessage) {
    const llm = await loadHostModule('@deepseek-ai/dsh-llm')
    createMessage = llm.createUserMessage as typeof CreateUserMessage
  }
  return createMessage
}

/**
 * The agent handle `ctx.agents.create()` returns. This service only needs
 * `followup`, which is how the panel pushes a hub conversation's opening
 * message into the session it just created (R8: 就地触发中枢对话).
 */
interface SessionHandle {
  agent: { followup(message: UserMessage): unknown }
  dispose?: () => void
}

/**
 * R18: the opening message of a 话题集会话 carries the set's three layers —
 * title, tags, summary — before the user's own text, so the session starts from
 * the index (and the client never has to re-send them).
 *
 * Exported as a pure seam: scripts/mechanism-smoke.mjs asserts the exact text
 * without a DSH host.
 */
export function buildTopicSetOpening(store: Store, topicSetIds: string[], message: string | undefined): string {
  const body = String(message ?? '').trim()
  if (!body) return ''
  const sets = topicSetIds
    .map((id) => store.topicsets.get(id))
    .filter((record): record is NonNullable<ReturnType<Store['topicsets']['get']>> => !!record)
  const titles = sets.map((record) => record.title).join('、')
  const tags = [...new Set(sets.flatMap((record) => record.keywords))].filter(Boolean)
  const summary = sets.map((record) => record.summary).filter(Boolean).join(' ')
  const lines = [
    `[supermemory-topic-set] 话题集：${titles}${tags.length > 0 ? ` ｜标签: ${tags.join('、')}` : ''}`,
    ...(summary ? [`话题集梗概：${summary}`] : []),
    '',
    `用户开场：${body}`,
  ]
  return lines.join('\n')
}

/** Plain text of one model content block; tool calls stay visible as a marker. */
export function chatBlockText(block: unknown): string {
  if (!block || typeof block !== 'object') return ''
  const record = block as { type?: unknown; text?: unknown; name?: unknown }
  switch (record.type) {
    case 'text':
      return String(record.text ?? '')
    case 'tool-call':
      return `（调用 ${String(record.name ?? '工具')}）`
    case 'image':
      return '（图片）'
    case 'file':
      return '（文件）'
    // Reasoning is internal: never render it as assistant chat text.
    default:
      return ''
  }
}

/** Join one message's content blocks into chat text. */
export function chatMessageText(content: unknown, maxChars = 1200): string {
  if (!Array.isArray(content)) return ''
  const text = content.map(chatBlockText).filter(Boolean).join('\n').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/**
 * R19 需求⑤: project a `sessionQuery.readSurface()` event list onto chat rows.
 * Only model-visible conversation events are kept (user / assistant / tool);
 * system prompts, developer declarations and lifecycle events are excluded.
 * Exported pure for scripts/mechanism-smoke.mjs.
 */
export function projectChatEvents(
  events: ReadonlyArray<{ seq?: number; type?: string; time?: number; data?: unknown }>,
  limit = 80,
): { messages: SessionMessageView[]; truncated: boolean } {
  const rows: SessionMessageView[] = []
  for (const event of events) {
    const type = String(event?.type ?? '')
    const data = event?.data as { message?: { content?: unknown }; isError?: boolean } | undefined
    if (!data || !data.message) continue
    if (type === 'user/message') {
      const text = chatMessageText(data.message.content)
      if (text) rows.push({ seq: Number(event.seq ?? 0), role: 'user', text, at: Number(event.time ?? 0) })
    } else if (type === 'assistant/message') {
      const text = chatMessageText(data.message.content)
      if (text) rows.push({ seq: Number(event.seq ?? 0), role: 'assistant', text, at: Number(event.time ?? 0) })
    } else if (type === 'tool/result') {
      const body = chatMessageText(data.message.content, 600)
      if (body) rows.push({ seq: Number(event.seq ?? 0), role: 'tool', text: data.isError ? `（工具失败）${body}` : body, at: Number(event.time ?? 0) })
    }
  }
  const cap = Math.max(1, Math.min(400, Math.floor(limit) || 80))
  const truncated = rows.length > cap
  return { messages: truncated ? rows.slice(-cap) : rows, truncated }
}

/** Plain data service (no host imports needed at definition time). */
export class SupermemoryPanelService {
  constructor(
    private readonly store: Store,
    private readonly ctx?: Context,
  ) {}

  private wk(cwd: string | undefined): string {
    return workspaceKeyOf(cwd)
  }

  /**
   * A3: 一条 tool_memory 行是否适用于给定工作区。能力按行级归属或 scope 推导
   * （与 composite.capabilityAppliesToWorkspace 同一语义）；序列组合工具无归属
   * 无 scope = 全局，任何工作区照常可见。
   */
  private toolApplies(record: Pick<ToolMemory, 'workspaceKey' | 'entry'>, workspaceKey: string | undefined): boolean {
    if (!workspaceKey) return true
    if (record.workspaceKey) return record.workspaceKey === workspaceKey
    try {
      const spec = JSON.parse(record.entry) as { scope?: string }
      if (spec.scope) return workspaceKeyOf(spec.scope) === workspaceKey
    } catch { /* a broken definition counts as global */ }
    return true
  }

  private view(id: string, topicSet: ReturnType<typeof getTopicSet>): TopicSetView {
    if (!topicSet) return { id, title: id, tags: [], summary: '', sessions: 0, live: 0, branches: [] }
    // R19 协同③: a branch row names how many hubs dispatched into it. The branch
    // belongs to the set (not to one hub), so a card showing "2 中枢共享" is the
    // truthful projection; `undefined` means the branch has no dispatch yet.
    const hubCounts = hubsByBranch(this.store)
    const latestTasks = latestTaskByBranch(this.store)
    // R30 需求④: 分支的显式标题/标签来自最新一次派发记录（DSH 无原生会话标签，
    // 见 branch-meta.ts）。一次读全表投影，行内直接取用。
    const branchMeta = latestBranchMeta(this.store)
    return {
      id,
      title: topicSet.title,
      tags: topicSet.keywords,
      summary: topicSet.summary,
      sessions: topicSet.members.length,
      live: topicSet.members.filter((member) => member.status === 'live').length,
      status: topicSet.status,
      branches: topicSet.members.map((m) => {
        // A fresh dispatch is recorded as kind 'root' but is a `branch-*` work
        // branch; the UI label must follow the id, not the raw member kind.
        const isBranch = m.kind === 'fork' || isPluginBranchId(m.sessionId)
        const hubCount = isBranch ? hubCounts.get(m.sessionId)?.length : undefined
        const meta = branchMeta.get(m.sessionId)
        return {
          sessionId: m.sessionId,
          kind: (isBranch ? 'fork' : 'root') as 'root' | 'fork',
          // R30 需求④: 显式标题（任务首行）优先，成员标题（话题集 · 任务）兜底。
          title: (isBranch ? meta?.title : '') || m.title,
          status: m.status,
          ...(m.model ? { model: m.model } : {}),
          // R19 协同③ fix: a branch belongs to this set; carry the set so the
          // branch card can say so (and show 共享 for kind-root branches too).
          ...(isBranch ? { topicSetId: id, topicSetTitle: topicSet.title } : {}),
          ...(hubCount ? { hubs: hubCount } : {}),
          // 任务摘要（最新一次派发）：重启后仅凭持久台账也能认出这个分支。
          ...(isBranch && latestTasks.get(m.sessionId)
            ? { task: taskExcerpt(latestTasks.get(m.sessionId)!, BRANCH_CARD_EXCERPT_CHARS) }
            : {}),
          ...(isBranch && meta && meta.tags.length > 0 ? { tags: [...meta.tags] } : {}),
        }
      }),
      ...(topicSet.defaultModel ? { model: `${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}` } : {}),
    }
  }

  /** Topic sets of one workspace, newest first. */
  listTopicSets(cwd: string): TopicSetView[] {
    const workspaceKey = this.wk(cwd)
    return listTopicSets(this.store, workspaceKey).map(([id, topicSet]) => this.view(id, topicSet))
  }

  /**
   * Activate a topic set for one session (panel click). AWAITED: the panel
   * reloads right after the click, and the domain updates its map only when the
   * queued write lands — a fire-and-forget write showed the OLD active set.
   */
  async activate(sessionId: string, topicSetId: string): Promise<boolean> {
    const topicSet = this.store.topicsets.get(topicSetId)
    if (!topicSet) return false
    await setRouting(this.store, sessionId, { activeTopicSetId: topicSetId, driftCount: 0 })
    await touchTopicSet(this.store, topicSetId)
    // R19 需求⑥: activation is the generation trigger, but it is fire-and-forget
    // and content-fingerprint/throttle guarded (topic-shape.ts): a quiet
    // activation costs no tokens and never delays the routing write.
    noteTopicSetActivated({ ctx: this.ctx, store: this.store, logger: { warn: (msg) => console.warn(msg) } }, topicSetId)
    return true
  }

  /** The active topic set of one session. */
  activeTopicSet(sessionId: string): TopicSetView | undefined {
    const active = getRouting(this.store, sessionId)?.activeTopicSetId
    if (!active) return undefined
    const topicSet = this.store.topicsets.get(active)
    if (!topicSet) return undefined
    return this.view(active, topicSet)
  }

  /** Full panel snapshot: hub session, topic sets, memories, counts. */
  hubState(cwd: string, sessionId: string): HubState {
    const workspaceKey = this.wk(cwd)
    const topicSets = listTopicSets(this.store, workspaceKey).map(([id, topicSet]) => this.view(id, topicSet))
    // R27 需求④: 条目带所属集合（与 listMemories 同一投影）。
    const collections = new Map(listCollections(this.store, workspaceKey))
    const memories: MemoryView[] = []
    for (const [id, record] of this.store.memories.entries()) {
      if (record.workspaceKey !== workspaceKey) continue
      const collection = record.collectionId ? collections.get(record.collectionId) : undefined
      memories.push({
        id, title: record.title, tags: record.keywords, text: record.text, key: record.key, status: record.status,
        sourceSessionId: record.sourceSessionId,
        createdAt: record.createdAt, updatedAt: record.updatedAt,
        // R30 需求①: 当前版本号（旧记录读作 1）。
        version: currentVersionOf(record),
        ...(collection
          ? { collectionId: record.collectionId, collectionTitle: collection.title, collectionTags: [...collection.keywords] }
          : {}),
      })
    }
    memories.sort((a, b) => b.updatedAt - a.updatedAt)
    let requirements = 0
    for (const [, record] of this.store.requirements.entries()) {
      if (record.workspaceKey === workspaceKey && record.status === 'open') requirements++
    }
    // A3: 概览计数同样按工作区隔离——跨工作区的派发/能力不计入本工作区。
    const ownSetIds = topicSetIdsOf(this.store, workspaceKey)
    let episodes = 0
    for (const [, episode] of this.store.episodes.entries()) {
      if (episode.topicSetId && ownSetIds.has(episode.topicSetId)) episodes++
    }
    let dispatches = 0
    for (const [, record] of this.store.dispatches.entries()) {
      // R19 fix: `interrupted` is terminal too; counting it as "进行中" made the
      // hub badge claim work was still running after the interrupt relay.
      if (record.status === 'delivered' || record.status === 'failed' || record.status === 'interrupted') continue
      if (record.topicSetId && !ownSetIds.has(record.topicSetId)) continue
      dispatches++
    }
    let tools = 0
    for (const [, record] of this.store.toolMemory.entries()) {
      if (record.kind !== 'composite') continue
      // 能力按行级归属/scope 判定；序列组合工具无归属=全局，照常计数。
      if (!this.toolApplies(record, workspaceKey)) continue
      tools++
    }
    return {
      sessionId,
      workspaceKey,
      ...(getRouting(this.store, sessionId)?.activeTopicSetId
        ? { activeTopicSetId: getRouting(this.store, sessionId)!.activeTopicSetId }
        : {}),
      topicSets,
      memories,
      counts: { memories: memories.length, requirements, episodes, dispatches, tools },
    }
  }

  /** Memories of one workspace, newest first; `query` filters by text/keywords. */
  listMemories(cwd: string, query?: string, limit?: number): MemoryView[] {
    const workspaceKey = this.wk(cwd)
    const tokens = query ? new Set(tokenize(query)) : new Set<string>()
    // R27 需求④: 集合上下文一次取齐（未归集/已归档集合的条目不带这三个字段）。
    const collections = new Map(listCollections(this.store, workspaceKey))
    const rows: Array<{ view: MemoryView; score: number }> = []
    for (const [id, record] of this.store.memories.entries()) {
      if (record.workspaceKey !== workspaceKey) continue
      // R10: title and tags are the index; a hit there counts 4x/3x a body hit,
      // so a title/tag filter never needs the body scan.
      const titleBag = new Set(tokenize(record.title ?? ''))
      const tagBag = new Set(tokenize(record.keywords.join(' ')))
      const bodyBag = new Set(tokenize(`${record.text} ${record.key ?? ''}`))
      let score = 0
      for (const token of tokens) {
        if (titleBag.has(token)) score += 4
        else if (tagBag.has(token)) score += 3
        else if (bodyBag.has(token)) score += 1
      }
      if (tokens.size > 0 && score === 0) continue
      const collection = record.collectionId ? collections.get(record.collectionId) : undefined
      rows.push({
        score,
        view: {
          id, title: record.title, tags: record.keywords, text: record.text, key: record.key, status: record.status,
          sourceSessionId: record.sourceSessionId,
          createdAt: record.createdAt, updatedAt: record.updatedAt,
          // R30 需求①: 当前版本号（旧记录读作 1）。
          version: currentVersionOf(record),
          ...(collection
            ? { collectionId: record.collectionId, collectionTitle: collection.title, collectionTags: [...collection.keywords] }
            : {}),
        },
      })
    }
    rows.sort((a, b) => b.score - a.score || b.view.updatedAt - a.view.updatedAt)
    const cap = Math.max(1, Math.min(200, Number(limit) || 100))
    return rows.slice(0, cap).map((row) => row.view)
  }

  /** Create one memory (panel editor). Mirrors memory_remember semantics. */
  async createMemory(cwd: string, text: string, key?: string, title?: string, tags?: string[] | string): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const body = String(text ?? '').trim()
    if (!body) return { status: 'error', message: '记忆文本不能为空。' }
    const cleanTitle = String(title ?? '').trim().slice(0, TITLE_MAX) || deriveTitle(body)
    const cleanTags = mergeTags(normalizeTags(tags), tagsOfBody(body))
    const stableKey = key?.trim() || undefined
    const now = Date.now()
    // R30 需求①: 同 key → 就地更新 + 升版（与 memory_remember 同一套版本化语义，
    // 不再「冲突不覆盖」）。内容完全相同 → 幂等回报、不升版。
    const sameKey = stableKey ? findMemoryByKey(this.store, workspaceKey, stableKey) : undefined
    if (sameKey) {
      const [memoryId, existing] = sameKey
      // 幂等快速判定：内容没变时不解析集合归属（避免顺手新建空集合）。
      if (memoryContentUnchanged(existing, { title: cleanTitle, text: body, tags: cleanTags })) {
        return {
          status: 'ok',
          id: memoryId,
          message: `该 key 已存相同内容，未重复写入（当前 v${currentVersionOf(existing)}）。`,
        }
      }
      const decisionDeps = { ctx: this.ctx, logger: { warn: (msg: string) => console.warn(msg) } }
      const assignment = await resolveCollectionForEntry(
        this.store, workspaceKey, { title: cleanTitle, keywords: cleanTags, text: body },
        { now, deps: decisionDeps },
      )
      if ('error' in assignment) return { status: 'error', message: assignment.error }
      const result = await updateMemoryVersioned(this.store, workspaceKey, memoryId, {
        title: cleanTitle, text: body, tags: cleanTags,
        ...(assignment.collectionId ? { collectionId: assignment.collectionId } : {}),
      }, now)
      if (!result) return { status: 'error', message: 'key 对应的记忆不存在或不属于当前工作区。' }
      if (result.status === 'unchanged') {
        return { status: 'ok', message: `该 key 已存相同内容，未重复写入（当前 v${result.version}）。`, id: memoryId }
      }
      if (assignment.collectionId) await touchCollection(this.store, assignment.collectionId, now)
      return {
        status: 'ok',
        id: memoryId,
        message: `已更新到 v${result.version}（旧版本已归档，可在详情里查看历史）${assignment.title ? `，归入记忆集合「${assignment.title}」` : ''}。`,
      }
    }
    // 整段重复（无 key）：与旧行为一致地直接回报（不拆分、不写入）。
    for (const [memoryId, record] of this.store.memories.entries()) {
      if (record.workspaceKey !== workspaceKey || record.status !== 'active') continue
      if (record.text.trim().toLowerCase() === body.toLowerCase()) {
        return { status: 'ok', message: '相同记忆已存在。', id: memoryId }
      }
    }
    // R27 需求④.2: 面板粘贴的长文先整形为 1..N 条原子记忆（有模型才调用一次；
    // 无模型/预判不通过/失败都保持 1 条，与旧行为一致）。拆分后每条是独立事实，
    // 调用方的单个 key 无法标识 N 行，因此不沿用。
    const decisionDeps = { ctx: this.ctx, logger: { warn: (msg: string) => console.warn(msg) } }
    const drafts = (await splitMemoryEntries(decisionDeps, body, { title: cleanTitle, tags: cleanTags }))
      ?? [{ title: cleanTitle, tags: cleanTags, text: body }]
    const atomic = drafts.filter((draft) => draft.text && assessConclusion(draft.text).ok)
    const entries = atomic.length > 0 ? atomic : [{ title: cleanTitle, tags: cleanTags, text: body }]
    const split = entries.length > 1
    const created: Array<{ id: string; collectionTitle: string; note: string | null }> = []
    const duplicateIds: string[] = []
    for (const entry of entries) {
      if (split) {
        let exists = false
        for (const [memoryId, record] of this.store.memories.entries()) {
          if (record.workspaceKey !== workspaceKey || record.status !== 'active') continue
          if (record.text.trim().toLowerCase() === entry.text.toLowerCase()) {
            exists = true
            duplicateIds.push(memoryId)
            break
          }
        }
        if (exists) continue
      }
      const entryTags = mergeTags(entry.tags, cleanTags)
      // R22 需求⑤ + R27 需求④.3: 与 memory_remember 同一套集合判定（有模型时由模型决定）。
      const assignment = await resolveCollectionForEntry(
        this.store, workspaceKey, { title: entry.title, keywords: entryTags, text: entry.text },
        { now, deps: decisionDeps },
      )
      if ('error' in assignment) return { status: 'error', message: assignment.error }
      // R30 需求①: 新建 v1 + 归档 v1 历史（版本化创建的唯一入口）。
      const memoryId = await createMemoryVersioned(this.store, workspaceKey, {
        title: entry.title, text: entry.text, tags: entryTags,
        ...(split ? {} : (stableKey ? { key: stableKey } : {})),
        ...(assignment.collectionId ? { collectionId: assignment.collectionId } : {}),
        // Typed in the panel: there is no source session to locate.
        sourceSessionId: '',
        sourceSeq: 0,
      }, now)
      if (assignment.collectionId) await touchCollection(this.store, assignment.collectionId, now)
      created.push({ id: memoryId, collectionTitle: assignment.title, note: collectionTierNote(assignment) })
    }
    if (created.length === 0) {
      return { status: 'ok', message: '相同记忆已存在，未重复写入。', ...(duplicateIds[0] ? { id: duplicateIds[0] } : {}) }
    }
    const first = created[0]
    const skipped = duplicateIds.length > 0 ? `其中 ${duplicateIds.length} 条已存在，未重复写入。` : ''
    return {
      status: 'ok',
      id: first.id,
      message: split
        ? `已拆分为 ${created.length} 条记忆，分别归入：${created.map((row) => row.collectionTitle ? `「${row.collectionTitle}」` : '未归集').join('、')}。${skipped}`
        : `已记住（v1）${first.note ? `（${first.note}）` : ''}。${skipped}`,
    }
  }

  /** Update one memory's text (and optional key). */
  async updateMemory(
    cwd: string,
    id: string,
    text: string,
    key?: string,
    title?: string,
    tags?: string[] | string,
  ): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const record = this.store.memories.get(id)
    if (!record || record.workspaceKey !== workspaceKey) return { status: 'error', message: '记忆不存在或不属于当前工作区。' }
    const body = String(text ?? '').trim()
    if (!body) return { status: 'error', message: '记忆文本不能为空。' }
    // R19 需求⑧: editing is still a write — keep the conclusion rule here too.
    const verdict = assessConclusion(body)
    if (!verdict.ok) return { status: 'error', message: verdict.message }
    // R30 需求①: 编辑走同一套版本化更新（就地修改 + version+1 + 归档）。
    // An omitted title/tags keeps what the record had (the row is edited
    // field by field); an explicit empty value re-derives it from the body.
    const result = await updateMemoryVersioned(this.store, workspaceKey, id, {
      text: body,
      ...(key !== undefined ? { key: key.trim() || undefined } : {}),
      ...(title !== undefined
        ? { title: String(title).trim().slice(0, TITLE_MAX) || deriveTitle(body) }
        : {}),
      ...(tags !== undefined
        ? { tags: mergeTags(normalizeTags(tags), tagsOfBody(body)) }
        : {}),
    })
    if (!result) return { status: 'error', message: '记忆不存在或不属于当前工作区。' }
    if (result.status === 'unchanged') {
      return { status: 'ok', message: `内容没有变化，未升版（当前 v${result.version}）。`, id }
    }
    return { status: 'ok', message: `已更新到 v${result.version}（旧版本已归档）。`, id }
  }

  /** Delete one memory. */
  async deleteMemory(cwd: string, id: string): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const record = this.store.memories.get(id)
    if (!record || record.workspaceKey !== workspaceKey) return { status: 'error', message: '记忆不存在或不属于当前工作区。' }
    await this.store.memories.delete(id)
    return { status: 'ok', message: '已删除。', id }
  }

  /** Toggle one memory's status (active / superseded). */
  async setMemoryStatus(cwd: string, id: string, status: string): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const record = this.store.memories.get(id)
    if (!record || record.workspaceKey !== workspaceKey) return { status: 'error', message: '记忆不存在或不属于当前工作区。' }
    if (status !== 'active' && status !== 'superseded') return { status: 'error', message: 'status 仅支持 active / superseded。' }
    await this.store.memories.update(id, (r) => ({ ...r, status, updatedAt: Date.now() }))
    return { status: 'ok', message: status === 'active' ? '已启用。' : '已停用。', id }
  }

  /**
   * R36 需求② / R39: 中枢权限页签的一次性快照——当前白名单、内置默认、锁定项，
   * 以及每次调用都从运行时重新生成的工具目录（按来源分组；宿主枚举失败时回退
   * 内置清单并告警，页面不白屏，但默认路径永远是动态目录）。
   */
  getHubPolicy(cwd: string): HubPolicyView {
    const workspaceKey = this.wk(cwd)
    const resolved: ResolvedHubPolicy = readHubPolicy(this.store, workspaceKey, (message) => console.warn(message))
    const snapshot = this.hubPolicyCatalogSnapshot(resolved.tools, resolved.prefixes)
    return {
      workspaceKey,
      tools: [...resolved.tools],
      prefixes: [...resolved.prefixes],
      source: resolved.source,
      locked: [...LOCKED_HUB_TOOLS],
      defaults: { tools: [...DEFAULT_HUB_TOOLS], prefixes: [...DEFAULT_HUB_PREFIXES] },
      catalog: snapshot.groups,
      catalogMeta: snapshot.meta,
      stale: snapshot.stale,
    }
  }

  /**
   * R39: 一键清理失效条目——白名单里有、当前运行时已不存在的工具（插件卸载/
   * 改名）与匹配不到任何工具的前缀。锁定项永不清理（guard 始终放行它们）；
   * 动态枚举失败时拒绝清理而不是瞎猜。原为内置默认时，清理会落一行工作区
   * 自定义白名单（在回执里说明）。
   */
  async cleanupStaleHubPolicy(cwd: string): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const resolved: ResolvedHubPolicy = readHubPolicy(this.store, workspaceKey, (message) => console.warn(message))
    let runtimeNames: string[]
    try {
      runtimeNames = this.runtimeHubTools().map((tool) => tool.name)
    } catch (error) {
      return {
        status: 'error',
        message: `动态目录不可用，无法判断失效条目：${String(error instanceof Error ? error.message : error).slice(0, 160)}`,
      }
    }
    const cleaned = cleanStaleHubPolicy({ allowTools: resolved.tools, prefixes: resolved.prefixes, runtimeNames })
    if (cleaned.removed === 0) return { status: 'ok', message: '没有失效条目需要清理。' }
    try {
      await writeHubPolicy(this.store, workspaceKey, cleaned.tools, cleaned.prefixes)
    } catch (error) {
      return { status: 'error', message: `清理失效条目失败：${String(error).slice(0, 160)}` }
    }
    const preview = cleaned.removedNames.slice(0, 5).join('、') + (cleaned.removedNames.length > 5 ? '…' : '')
    return {
      status: 'ok',
      message: `已清理 ${cleaned.removed} 个失效条目（${preview}）并保存。`
        + (resolved.source === 'default' ? '原为内置默认，本次已写入工作区自定义白名单。' : ''),
    }
  }

  /**
   * R36 需求②: 保存白名单（整份替换：面板总是把两个列表一起送来）。锁定项在
   * 写入时合并回去，用户无法通过一次保存把自己锁在派发链路之外。
   */
  async setHubPolicy(cwd: string, patch: HubPolicyPatch): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    if (patch.reset) {
      // Awaited on purpose: the receipt must reflect the write, unlike the
      // best-effort markers (a silent failure would leave the user believing
      // the default was restored).
      try {
        await resetHubPolicy(this.store, workspaceKey)
      } catch (error) {
        return { status: 'error', message: `恢复默认失败：${String(error).slice(0, 160)}` }
      }
      return { status: 'ok', message: '已恢复内置默认白名单（下一个工具调用即生效）。' }
    }
    const tools = Array.isArray(patch.tools) ? patch.tools : undefined
    const prefixes = Array.isArray(patch.prefixes) ? patch.prefixes : undefined
    if (!tools || !prefixes) {
      return { status: 'error', message: '保存白名单需要同时提供 tools 与 prefixes 两个列表。' }
    }
    try {
      await writeHubPolicy(this.store, workspaceKey, tools, prefixes)
    } catch (error) {
      return { status: 'error', message: `保存失败：${String(error).slice(0, 160)}` }
    }
    return { status: 'ok', message: '白名单已保存（下一个工具调用即生效）。' }
  }

  /**
   * R41 需求①b: the 设置 tab's default-model snapshot (per workspace).
   */
  getModelDefaults(cwd: string): ModelDefaultsView {
    return readModelDefaults(this.store, this.wk(cwd))
  }

  /**
   * R41 需求①b: save the 设置 tab's default models. A missing selection means
   * "follow the existing chain"; `null` clears one kind; `reset` clears both.
   */
  async setModelDefaults(cwd: string, patch: {
    hub?: ModelSelection | null
    branch?: ModelSelection | null
    reset?: boolean
  }): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const hub = patch?.hub === null ? null : (patch?.hub ?? undefined)
    const branch = patch?.branch === null ? null : (patch?.branch ?? undefined)
    if (!patch?.reset && hub === undefined && branch === undefined) {
      return { status: 'error', message: '没有要保存的默认模型。' }
    }
    try {
      const saved = await writeModelDefaults(this.store, workspaceKey, {
        ...(patch?.reset ? { reset: true } : { hub, branch }),
      })
      const hubName = saved.hub ? `${saved.hub.provider}/${saved.hub.model}` : '跟随宿主默认'
      const branchName = saved.branch ? `${saved.branch.provider}/${saved.branch.model}` : '跟随话题集/中枢/宿主默认'
      return {
        status: 'ok',
        message: patch?.reset
          ? '已恢复默认设置（中枢/分支会话跟随既有链路）。'
          : `默认模型已保存：中枢会话 ${hubName}；分支会话 ${branchName}。`,
      }
    } catch (error) {
      return { status: 'error', message: `保存默认模型失败：${String(error).slice(0, 160)}` }
    }
  }

  /**
   * R39: 宿主运行时工具清单——直接读 `ctx.tools.definitions()`（宿主契约：
   * ToolDefinition extends ToolSchema，只有 name/description/parameters，没有
   * owner/plugin 字段）。无该 seams、抛错或返回空清单都视为失败，由调用方回退
   * 内置清单并告警；成功时只投影本模块需要的字段（name/description/来源）。
   * 作用域：不传 scope = 全局视图（panel 服务不是 agent 作用域），因此
   * agent 级 scoped 工具与 preset/session 级 restrict 不在目录里——见
   * DEV-NOTES §47 的限制说明。
   */
  private runtimeHubTools(): HubToolDescriptor[] {
    const tools = this.ctx?.tools as unknown as {
      definitions?: (scope?: unknown) => unknown
    } | undefined
    if (!tools || typeof tools.definitions !== 'function') {
      throw new Error('宿主未暴露 ctx.tools.definitions()')
    }
    const definitions = tools.definitions()
    if (!Array.isArray(definitions)) throw new Error('ctx.tools.definitions() 未返回数组')
    const descriptors: HubToolDescriptor[] = []
    for (const definition of definitions) {
      const record = definition as { name?: unknown; description?: unknown } | undefined
      const name = String(record?.name ?? '').trim()
      if (!name) continue
      const declared = declaredHubToolSource(definition)
      const description = typeof record?.description === 'string' ? record.description : undefined
      descriptors.push({
        name,
        ...(description ? { description } : {}),
        ...(declared ? { source: declared } : {}),
      })
    }
    if (descriptors.length === 0) throw new Error('ctx.tools.definitions() 返回空清单')
    return descriptors
  }

  /**
   * R39: 动态目录 + 内置回退（永不抛）。失败路径必须留下告警：页面显示
   * 「内置回退」徽标与警告条，而不是白屏或静默换源。
   */
  private hubPolicyCatalogSnapshot(allowTools: readonly string[], prefixes: readonly string[]): HubCatalogSnapshot {
    const now = Date.now()
    try {
      return buildHubCatalog({ tools: this.runtimeHubTools(), allowTools, prefixes, now })
    } catch (error) {
      const detail = String(error instanceof Error ? error.message : error).slice(0, 200)
      const warning = `动态工具目录生成失败，已回退内置清单：${detail}`
      console.warn('supermemory: ' + warning)
      return buildFallbackHubCatalog({ allowTools, prefixes, now, warning })
    }
  }

  /**
   * R30 需求②: 记忆页签第一级——本工作区的记忆集合卡片（标题/标签/条目数/
   * 最近更新）。条目数按集合聚合（含未归集：id 为空串的虚拟集合，让旧数据
   * 与「没归集」的新数据在面板里仍然可见，不丢条目）。
   */
  listMemoryCollections(cwd: string): MemoryCollectionView[] {
    const workspaceKey = this.wk(cwd)
    const stats = new Map<string, { count: number; latest: number }>()
    for (const [, record] of this.store.memories.entries()) {
      if (record.workspaceKey !== workspaceKey) continue
      const id = record.collectionId ?? ''
      const row = stats.get(id) ?? { count: 0, latest: 0 }
      row.count += 1
      if (record.updatedAt > row.latest) row.latest = record.updatedAt
      stats.set(id, row)
    }
    const rows: MemoryCollectionView[] = []
    for (const [id, collection] of listCollections(this.store, workspaceKey)) {
      const row = stats.get(id) ?? { count: 0, latest: collection.updatedAt }
      rows.push({
        id,
        title: collection.title,
        tags: [...collection.keywords],
        summary: collection.summary,
        count: row.count,
        latestUpdatedAt: row.latest,
        status: collection.status,
        createdAt: collection.createdAt,
        updatedAt: collection.updatedAt,
      })
    }
    const loose = stats.get('')
    if (loose && loose.count > 0) {
      rows.push({
        id: '',
        title: UNGROUPED_TITLE,
        tags: [],
        summary: '',
        count: loose.count,
        latestUpdatedAt: loose.latest,
        status: 'active',
        createdAt: 0,
        updatedAt: loose.latest,
      })
    }
    rows.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt || a.title.localeCompare(b.title))
    return rows
  }

  /**
   * R30 需求②: 记忆页签第二级——一个集合（collectionId；'' = 未归集）里的全部
   * 条目，按更新时间倒序。`query` 命中标题/标签/正文/key 时只返回匹配行。
   */
  listMemoriesByCollection(cwd: string, collectionId: string, query?: string, limit?: number): MemoryView[] {
    const workspaceKey = this.wk(cwd)
    const wanted = collectionId ?? ''
    const tokens = query ? new Set(tokenize(query)) : new Set<string>()
    const collections = new Map(listCollections(this.store, workspaceKey))
    const rows: Array<{ view: MemoryView; score: number }> = []
    for (const [id, record] of this.store.memories.entries()) {
      if (record.workspaceKey !== workspaceKey) continue
      if ((record.collectionId ?? '') !== wanted) continue
      // 与 listMemories 同一套索引打分：标题×4 / 标签×3 / 正文×1。
      const titleBag = new Set(tokenize(record.title ?? ''))
      const tagBag = new Set(tokenize(record.keywords.join(' ')))
      const bodyBag = new Set(tokenize(`${record.text} ${record.key ?? ''}`))
      let score = 0
      for (const token of tokens) {
        if (titleBag.has(token)) score += 4
        else if (tagBag.has(token)) score += 3
        else if (bodyBag.has(token)) score += 1
      }
      if (tokens.size > 0 && score === 0) continue
      const collection = record.collectionId ? collections.get(record.collectionId) : undefined
      rows.push({
        score,
        view: {
          id, title: record.title, tags: record.keywords, text: record.text, key: record.key, status: record.status,
          sourceSessionId: record.sourceSessionId,
          createdAt: record.createdAt, updatedAt: record.updatedAt,
          version: currentVersionOf(record),
          ...(collection
            ? { collectionId: record.collectionId, collectionTitle: collection.title, collectionTags: [...collection.keywords] }
            : {}),
        },
      })
    }
    rows.sort((a, b) => b.score - a.score || b.view.updatedAt - a.view.updatedAt)
    const cap = Math.max(1, Math.min(200, Number(limit) || 100))
    return rows.slice(0, cap).map((row) => row.view)
  }

  /**
   * R30 需求②: 记忆详情——当前字段 + 全部历史版本（最后一条即当前版本；
   * 旧存储域没有历史表时只有当前版本，可正常打开详情）。
   */
  getMemoryDetail(cwd: string, id: string): MemoryDetailView | undefined {
    const workspaceKey = this.wk(cwd)
    const record = this.store.memories.get(id)
    if (!record || record.workspaceKey !== workspaceKey) return undefined
    const collections = new Map(listCollections(this.store, workspaceKey))
    const collection = record.collectionId ? collections.get(record.collectionId) : undefined
    const view: MemoryView = {
      id, title: record.title, tags: record.keywords, text: record.text, key: record.key, status: record.status,
      sourceSessionId: record.sourceSessionId,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      version: currentVersionOf(record),
      ...(collection
        ? { collectionId: record.collectionId, collectionTitle: collection.title, collectionTags: [...collection.keywords] }
        : {}),
    }
    const versions: MemoryVersionView[] = memoryHistoryOf(this.store, id).map((row) => ({
      version: row.version,
      updatedAt: row.updatedAt,
      title: row.title ?? '',
      tags: [...(row.tags ?? [])],
      text: row.text,
      changeType: row.changeType,
      ...(row.collectionId ? { collectionId: row.collectionId } : {}),
    }))
    return { view, versions }
  }

  /**
   * R18: hub sessions of this workspace (no parent, not a subagent, not a
   * topic-set member). Read through the host session-query seam; a host
   * without it degrades to the live session list, then to an empty rail.
   */
  listHubSessions(cwd: string): Promise<HubSessionRow[]> {
    return listHubSessions(this.ctx, this.store, cwd)
  }

  /**
   * R19 协同②: the hub → branch association of one hub session.
   *
   * The rows are projected from the durable dispatch table (`hubSessionId`), so
   * this works for a live hub, a persisted hub, and for a branch shared by
   * several hubs. `cwd` is the panel's current workspace: a row whose topic set
   * belongs to another workspace is filtered out (defence in depth; the caller
   * already scopes by workspace).
   */
  listHubBranches(cwd: string, hubSessionId: string, limit = 20): HubBranchView[] {
    const id = String(hubSessionId ?? '').trim()
    if (!id) return []
    const workspaceKey = this.wk(cwd)
    const rows = listHubBranches(this.store, id, limit)
    return rows.filter((row) => {
      if (!row.topicSetId) return true
      const topicSet = this.store.topicsets.get(row.topicSetId)
      return !topicSet || topicSet.workspaceKey === workspaceKey
    })
  }

  /**
   * R30 需求③: EVERY topic set of the workspace — the hub's management view.
   * `listTopicSets` above stays active-only (the 话题集 tab); this one adds the
   * archived sets (each row carries `status`) so a hub can still inspect, tag or
   * re-activate history instead of losing it from every list.
   */
  listAllTopicSets(cwd: string): TopicSetView[] {
    const workspaceKey = this.wk(cwd)
    const rows: TopicSetView[] = []
    const ordered: Array<[string, NonNullable<ReturnType<typeof getTopicSet>>]> = []
    for (const [id, topicSet] of this.store.topicsets.entries()) {
      if (topicSet.workspaceKey !== workspaceKey) continue
      ordered.push([id, topicSet])
    }
    // Active first (a management list still leads with live work), then by the
    // set's own recency — the same order the 话题集 tab uses inside each group.
    ordered.sort((a, b) =>
      (a[1].status === 'archived' ? 1 : 0) - (b[1].status === 'archived' ? 1 : 0)
      || b[1].lastActiveAt - a[1].lastActiveAt)
    for (const [id, topicSet] of ordered) rows.push(this.view(id, topicSet))
    return rows
  }

  /**
   * R30 需求③: every BRANCH session of the workspace, across topic sets — the
   * hub's cross-set view (title / tags / owning set / status / last activity),
   * optionally filtered to one topic set. Projected from the durable dispatch
   * ledger (`listWorkspaceBranches`), so a preserved branch survives restarts
   * without a live handle; `cwd` scopes it to the panel's workspace.
   */
  listAllBranches(cwd: string, topicSetId?: string, limit = 100): HubBranchView[] {
    const workspaceKey = this.wk(cwd)
    const setId = String(topicSetId ?? '').trim()
    const rows = listWorkspaceBranches(this.store, workspaceKey, limit)
    return setId ? rows.filter((row) => row.topicSetId === setId) : rows
  }

  /**
   * R19 需求⑤: read one session's model-visible conversation for the in-panel
   * chat. Capability evidence: `ctx.sessionQuery.readSurface(id)` returns the
   * cloned current surface (dsh-session-query/src/index.ts:322), which is the
   * same fold the model itself sees — no transcript mutation, no resume.
   *
   * A host without `sessionQuery` (older/minimal profile) degrades to an empty
   * list with an explicit `note`, never to an error: the panel keeps working.
   */
  async readSessionMessages(sessionId: string, limit = 80): Promise<SessionChatView> {
    const id = String(sessionId ?? '').trim()
    if (!id) return { sessionId: '', title: '', live: false, messages: [], truncated: false, note: '缺少会话 id。' }
    const ctx = this.ctx
    let live = false
    let agents: ChatAgentsLike | undefined
    try {
      agents = ctx?.get?.('agents') as ChatAgentsLike | undefined
      live = !!agents?.get?.(id)
    } catch { live = false }
    let query: ChatSessionQueryLike | undefined
    try {
      query = ctx?.get?.('sessionQuery') as ChatSessionQueryLike | undefined
    } catch {
      query = undefined
    }
    let title = id.slice(-4)
    try {
      if (query?.readTitleSnapshots) {
        const observations = await query.readTitleSnapshots([id])
        const observed = observations.find((row) => row.status === 'fulfilled' && row.sessionId === id)
        const observedTitle = observed?.value?.title?.title
        if (typeof observedTitle === 'string' && observedTitle.trim()) title = observedTitle.trim()
      }
    } catch { /* a title failure keeps the id suffix */ }
    if (!query?.readSurface) {
      return {
        sessionId: id, title, live, messages: [], truncated: false,
        note: '宿主未提供 sessionQuery，无法读取会话消息；可在 DSH 中打开该会话查看。',
      }
    }
    try {
      const surface = await query.readSurface(id)
      const projected = projectChatEvents(surface?.events ?? [], limit)
      return { sessionId: id, title, live, messages: projected.messages, truncated: projected.truncated }
    } catch (error) {
      return {
        sessionId: id, title, live, messages: [], truncated: false,
        note: `读取会话失败：${String(error).slice(0, 160)}`,
      }
    }
  }

  /**
   * R19 需求⑤: send one user message directly into a hub/branch session from
   * the panel. A live agent is used as-is (`ctx.agents.get`); a persisted but
   * idle session is resumed once (`ctx.agents.resume({resumeSessionId})` — the
   * documented resume entry, dsh-agent/src/index.ts:429) and kept live inside
   * this panel so the reply can be polled. The session's own view in DSH shows
   * the same messages: the panel is a second surface, not a parallel transcript.
   */
  async sendSessionMessage(sessionId: string, text: string): Promise<MutationResult> {
    const id = String(sessionId ?? '').trim()
    const body = String(text ?? '').trim()
    if (!id) return { status: 'error', message: '缺少会话 id。' }
    if (!body) return { status: 'error', message: '消息不能为空。' }
    if (Array.from(body).length > 8000) return { status: 'error', message: '消息过长（上限 8000 字）。' }
    const ctx = this.ctx
    if (!ctx) return { status: 'error', message: '宿主上下文不可用。' }
    let agents: ChatAgentsLike | undefined
    try {
      agents = ctx.get?.('agents') as ChatAgentsLike | undefined
    } catch {
      agents = undefined
    }
    if (!agents) return { status: 'error', message: '宿主未提供 agents 服务，无法发送消息。' }
    let message: UserMessage
    try {
      const factory = await messageFactory()
      // R25: 面板里发消息就是用户行为 —— 以 kind 'user' 落账，会话因此置顶。
      message = factory({ content: [{ type: 'text', text: body }], source: { kind: 'user' } })
    } catch (error) {
      return { status: 'error', message: `宿主消息工厂不可用：${String(error).slice(0, 160)}` }
    }
    let agent = agents.get?.(id)
    let resumed = false
    if (!agent) {
      if (typeof agents.resume !== 'function') {
        return { status: 'error', message: '该会话未运行，且宿主不支持恢复；请点「打开会话」在 DSH 中打开后再发送。' }
      }
      try {
        // Mount the session's recorded agent preset on the resumed scope (the
        // same setup a dispatch resume uses); without it a resumed conversation
        // would come back without its preset tools. Mount failure is logged and
        // degrades to host tools — it never blocks the send.
        const handle = await agents.resume({
          resumeSessionId: id,
          setup: compositionSetup(ctx, {}, { warn: (msg) => console.warn(msg) }),
        })
        resumedChatHandles.set(id, handle)
        agent = handle.agent
        resumed = true
      } catch (error) {
        return {
          status: 'error',
          message: `会话未运行且恢复失败：${String(error).slice(0, 160)}。请点「打开会话」在 DSH 中打开后再发送。`,
        }
      }
    }
    try {
      if (typeof agent?.followup !== 'function') return { status: 'error', message: '该会话的 agent 不可写（followup 不可用）。' }
      agent.followup(message)
      // R41 需求③a: a hub created from the rail has no opening message, so its
      // title is the neutral 「新会话」. The first message sent from the panel is
      // the available work summary — upgrade the title once, never overwriting
      // a title a person chose.
      void this.refreshHubTitleFromMessage(id, body)
      return { status: 'ok', message: resumed ? '会话已恢复，消息已发送。' : '消息已发送。', id }
    } catch (error) {
      return { status: 'error', message: `发送失败：${String(error).slice(0, 160)}` }
    }
  }

  /**
   * R18: derive the title + tags a memory body implies, so the panel's editor
   * can fill the two index fields instead of leaving them blank. Pure reuse of
   * the retrieval rules (same derivation the tool layer applies on write).
   */
  suggestMemoryShape(text: string): MemoryShapeView {
    const body = String(text ?? '').trim()
    return { title: deriveTitle(body), tags: mergeTags([], tagsOfBody(body)) }
  }

  /**
   * Create a topic set (panel). R18: title + tags + summary are all written on
   * creation — omitted tags fall back to the title/body vocabulary, so a set
   * created from the panel is never index-less.
   */
  async createTopicSet(cwd: string, title: string, tags?: string[] | string, summary?: string): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const name = String(title ?? '').trim()
    if (!name) return { status: 'error', message: '标题不能为空。' }
    const body = String(summary ?? '').slice(0, 500)
    const explicitTags = normalizeTags(tags)
    const keywords = mergeTags(explicitTags, tagsOfBody(`${name} ${body}`))
    const id = await createTopicSet(this.store, {
      workspaceKey,
      // Whole up to TOPIC_SET_TITLE_MAX_CHARS, "…" beyond (was slice(0, 40)).
      title: clipEllipsis(name, TOPIC_SET_TITLE_MAX_CHARS),
      summary: body,
      keywords,
    })
    // R19 需求⑥: a model fills the index. The creator-supplied title/tags/body
    // stay authoritative; only a layer left empty is generated. A failure
    // (no model, timeout, malformed JSON) keeps exactly what was written here.
    let shapeNote = ''
    try {
      const shape = await fillTopicShapeOnCreate(
        { ctx: this.ctx, store: this.store, logger: { warn: (msg) => console.warn(msg) } },
        id,
        body,
        { tags: explicitTags.length === 0, summary: body.trim().length === 0 },
      )
      if (shape) shapeNote = '（已由模型补全索引）'
    } catch (error) {
      console.warn('supermemory: topic-set shape generation skipped: ' + String(error).slice(0, 160))
    }
    const stored = this.store.topicsets.get(id)
    const finalTags = stored?.keywords ?? keywords
    const tagText = finalTags.length > 0 ? `（标签：${finalTags.join('、')}）` : ''
    return { status: 'ok', message: `已创建话题集『${stored?.title ?? clipEllipsis(name, TOPIC_SET_TITLE_MAX_CHARS)}』${tagText}${shapeNote}。`, id }
  }

  /** Update a topic set's summary (panel). */
  async updateTopicSetSummary(id: string, summary: string, tags?: string[] | string): Promise<MutationResult> {
    const record = this.store.topicsets.get(id)
    if (!record) return { status: 'error', message: '话题集不存在。' }
    // `tags` is the UI-facing name of the record's `keywords`; omitting it
    // keeps the current tags, an empty array clears them.
    const nextKeywords = tags !== undefined ? normalizeTags(tags) : record.keywords
    await updateTopicSetSummary(this.store, id, String(summary ?? '').slice(0, 500), nextKeywords)
    return { status: 'ok', message: '标签与正文已更新。', id }
  }

  /**
   * R3: create a session bound to one or more topic sets (话题集会话).
   * The session is a fresh root member of every selected topic set.
   */
  async createTopicSetSession(cwd: string, topicSetIds: string[], options: SessionOptions = {}, firstMessage = ''): Promise<MutationResult> {
    const ctx = this.ctx
    if (!ctx) return { status: 'error', message: '宿主上下文不可用，无法创建会话。' }
    const ids = (topicSetIds ?? []).filter((id) => this.store.topicsets.get(id))
    if (ids.length === 0) return { status: 'error', message: '请至少选择一个有效话题集。' }
    if (!cwd) return { status: 'error', message: '无法确定工作区。' }
    const titles = ids.map((id) => this.store.topicsets.get(id)?.title ?? id)
    const created = await this.createSessionWithOptions(cwd, options)
    if ('error' in created) return { status: 'error', message: created.error }
    const sessionId = created.sessionId
    try {
      // Requirement C: one stable title for the session AND every member row.
      const named = await ensureMemberTitle(this.store, ids[0], { sessionId, kind: 'root' }, titles.join('、'), '')
      for (const id of ids.slice(1)) {
        await addMember(this.store, id, { sessionId, kind: 'root', title: named })
        await touchTopicSet(this.store, id)
      }
      await touchTopicSet(this.store, ids[0])
      applySessionTitle(ctx, sessionId, named, { warn: () => {} })
      // R33 需求②: a topic-set conversation is a POSITIVE hub mark (root member
      // + explicit record), never inferred from its missing parentSession.
      await recordHubSession(this.store, {
        sessionId,
        workspaceKey: workspaceKeyOf(cwd),
        title: named,
        source: 'topicset-root',
      })
      try {
        await attachBranchToWorkspace(ctx, sessionId, cwd, { warn: () => {}, info: () => {} })
      } catch { /* workspace attach is best-effort */ }
      const delivered = await this.deliverFirstMessage(created.handle, buildTopicSetOpening(this.store, ids, firstMessage))
      const base = `已创建话题集会话（${titles.join('、')}）`
      if (delivered === true) return { status: 'ok', message: `${base}并发送首条消息。`, id: sessionId }
      if (typeof delivered === 'string') return { status: 'ok', message: `${base}，但首条消息发送失败：${delivered}`, id: sessionId }
      return { status: 'ok', message: `${base}。`, id: sessionId }
    } catch (error) {
      return { status: 'error', message: `创建会话失败：${String(error).slice(0, 200)}` }
    }
  }

  /**
   * R7: create one plain hub session carrying the quick-launcher choices. The
   * session belongs to NO topic set; it is named, attached to its workspace
   * and opened by the client. An empty option set reproduces the shell's
   * plain new session (host defaults for preset/model/permission).
   */
  async createHubSession(cwd: string, options: SessionOptions = {}, firstMessage = ''): Promise<MutationResult> {
    const workspaceKey = workspaceKeyOf(cwd)
    // R41 需求①b: an explicit composer choice wins; otherwise the workspace's
    // 中枢会话默认模型 applies, and finally the host default (no options).
    const resolvedOptions: SessionOptions = { ...options }
    if (!resolvedOptions.model) {
      const hubDefault = defaultModelFor(this.store, workspaceKey, 'hub')
      if (hubDefault) resolvedOptions.model = hubDefault
    }
    const created = await this.createSessionWithOptions(cwd, resolvedOptions)
    if ('error' in created) return { status: 'error', message: created.error }
    // R41 需求③a: the name is the work itself — the opening message (48-char
    // clip) or the neutral 「新会话」 when there is no content yet. No brand
    // prefix, no id token.
    const title = hubSessionTitle(created.sessionId, firstMessage)
    await this.finishSession(created.sessionId, cwd, title)
    // R33 需求②: the plugin created this hub — record the positive mark.
    await recordHubSession(this.store, {
      sessionId: created.sessionId,
      workspaceKey,
      title,
      source: 'panel',
    })
    const delivered = await this.deliverFirstMessage(created.handle, firstMessage)
    if (delivered === true) return { status: 'ok', message: '已创建中枢会话并发送首条消息。', id: created.sessionId }
    if (typeof delivered === 'string') return { status: 'ok', message: `中枢会话已创建，但首条消息发送失败：${delivered}`, id: created.sessionId }
    return { status: 'ok', message: '已创建中枢会话。', id: created.sessionId }
  }

  /**
   * R41 需求③a: upgrade a hub's neutral title from the first message the user
   * sends in the panel. Only generic titles (「新会话」, the old brand prefix,
   * the pre-R31「新会话 · id」) are upgraded — a title a person chose is kept.
   */
  private async refreshHubTitleFromMessage(sessionId: string, text: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    try {
      const record = this.store?.hubs?.get?.(sessionId)
      if (!record) return
      const current = currentSessionTitle(ctx, sessionId) ?? record.title
      const generic = !current
        || current === TITLE_FALLBACK
        || current.startsWith('SuperMemory 中枢')
        || /^新会话\s*·/.test(current)
      if (!generic) return
      const title = describeSessionTitle(text)
      if (!title || title === TITLE_FALLBACK) return
      applySessionTitle(ctx, sessionId, title, { warn: () => {} }, { force: true })
      await recordHubSession(this.store, {
        sessionId,
        workspaceKey: record.workspaceKey,
        title,
        source: record.source,
      })
    } catch { /* naming is best-effort; the message already went through */ }
  }

  /**
   * R8: push the composer's opening message into the session the panel just
   * created, so a hub conversation can be started from the SuperMemory page
   * without navigating to the shell's new-session page. Returns `true` when
   * delivered, `false` when there was nothing to send, or the failure text —
   * a failed delivery never discards the already-created session.
   */
  private async deliverFirstMessage(handle: SessionHandle, text: string | undefined): Promise<true | false | string> {
    const body = String(text ?? '').trim()
    if (!body) return false
    try {
      const factory = await messageFactory()
      // R25: 新会话本就靠 createdAt 置顶，这里用 'user' 只为规则一致（人发起的投递）。
      const message = factory({
        content: [{ type: 'text', text: body }],
        source: { kind: 'user' },
      })
      handle.agent.followup(message as UserMessage)
      return true
    } catch (error) {
      return String(error).slice(0, 200)
    }
  }

  /**
   * R7: create the bare session with the quick-launcher choices applied. The
   * agent preset rides the creation metadata; the model rides the agent
   * options (route fallback until the session records a selection); the
   * permission preset is applied right after creation because its service
   * owns the session knob events. Every choice is optional.
   */
  private async createSessionWithOptions(
    cwd: string,
    options: SessionOptions,
  ): Promise<{ sessionId: string; handle: SessionHandle } | { error: string }> {
    const ctx = this.ctx
    if (!ctx) return { error: '宿主上下文不可用，无法创建会话。' }
    if (!cwd) return { error: '无法确定工作区。' }
    const sessionId = newId('session')
    const meta: Record<string, unknown> = { cwd }
    if (options.agentPreset) meta.agentPreset = options.agentPreset
    const agentOptions: Record<string, unknown> = {}
    if (options.model?.provider && options.model?.model) {
      agentOptions.provider = options.model.provider
      agentOptions.model = options.model.model
      if (options.model.reasoningEffort) agentOptions.reasoningEffort = options.model.reasoningEffort
    }
    let handle: SessionHandle
    try {
      handle = await ctx.agents.create({
        sessionId: sessionId as never,
        meta: meta as never,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions: agentOptions as never } : {}),
      }) as unknown as SessionHandle
    } catch (error) {
      return { error: `创建会话失败：${String(error).slice(0, 200)}` }
    }
    this.applyPermission(sessionId, options.permission)
    return { sessionId, handle }
  }

  /** Name the host session and attach it to its workspace (best-effort). */
  private async finishSession(sessionId: string, cwd: string, title: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    applySessionTitle(ctx, sessionId, title, { warn: () => {} })
    try {
      await attachBranchToWorkspace(ctx, sessionId, cwd, { warn: () => {}, info: () => {} })
    } catch { /* workspace attach is best-effort */ }
  }

  /**
   * R7: apply one permission preset to a just-created session. The preset
   * value comes from the host catalog (listPermissions); an unknown value or
   * a missing service is reported, never faked.
   */
  private applyPermission(sessionId: string, preset: string | undefined): void {
    if (!preset) return
    const ctx = this.ctx
    if (!ctx) return
    try {
      const service = ctx.get('permissionPresets') as { set?(session: unknown, name: string): void } | undefined
      const agent = ctx.agents.get(sessionId as never) as { session?: unknown } | undefined
      if (!service || typeof service.set !== 'function' || !agent?.session) return
      service.set(agent.session, preset)
    } catch (error) {
      console.warn('supermemory: permission preset apply failed: ' + String(error).slice(0, 160))
    }
  }

  /** R7: the agent-preset roster for the hub quick launcher. */
  async listAgentPresets(): Promise<AgentPresetView[]> {
    const ctx = this.ctx
    if (!ctx) return []
    try {
      const service = ctx.get('agentPresets') as {
        list?(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
        defaultId?: string
      } | undefined
      if (!service || typeof service.list !== 'function') return []
      const rows = await service.list()
      const defaultId = service.defaultId
      return rows.map((row) => ({
        id: row.id,
        ...(row.name ? { name: row.name } : {}),
        ...(row.description ? { description: row.description } : {}),
        isDefault: row.id === defaultId,
      }))
    } catch (error) {
      console.warn('supermemory: agent preset roster unavailable: ' + String(error).slice(0, 160))
      return []
    }
  }

  /** R7: the runtime provider/model catalog for the hub quick launcher. */
  async listModelCatalog(): Promise<ModelCatalogView> {
    const ctx = this.ctx
    if (!ctx) return { providers: [], models: [] }
    try {
      return await enumerateModels(ctx)
    } catch (error) {
      console.warn('supermemory: model catalog unavailable: ' + String(error).slice(0, 160))
      return { providers: [], models: [] }
    }
  }

  /** R7: the process-level permission catalog for the hub quick launcher. */
  async listPermissions(): Promise<PermissionCatalogView> {
    const ctx = this.ctx
    if (!ctx) return { options: [], defaultPreset: '' }
    try {
      const service = ctx.get('permissionPresets') as
        | { catalog?(): PermissionCatalogView }
        | undefined
      if (!service || typeof service.catalog !== 'function') return { options: [], defaultPreset: '' }
      return service.catalog()
    } catch (error) {
      console.warn('supermemory: permission catalog unavailable: ' + String(error).slice(0, 160))
      return { options: [], defaultPreset: '' }
    }
  }

  /**
   * R5: reply into a topic set. Resolves the topic set's live member (or the
   * most recent one, creating a fresh branch when none exists) and delivers
   * the text as a followup; the result names the session the reply landed in.
   */
  async followupTopicSet(cwd: string, topicSetId: string, text: string): Promise<MutationResult> {
    const ctx = this.ctx
    if (!ctx) return { status: 'error', message: '宿主上下文不可用，无法回复。' }
    const topicSet = getTopicSet(this.store, topicSetId)
    if (!topicSet) return { status: 'error', message: '话题集不存在。' }
    const body = String(text ?? '').trim()
    if (!body) return { status: 'error', message: '回复内容不能为空。' }
    if (!cwd) return { status: 'error', message: '无法确定工作区。' }
    let sessionId: string | undefined
    // 1. a live member held by this plugin
    for (const member of [...topicSet.members].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
      if (branchHandles.has(member.sessionId)) { sessionId = member.sessionId; break }
    }
    // 2. a live registry agent
    if (!sessionId) {
      for (const member of [...topicSet.members].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
        if (ctx.agents.get(member.sessionId as never)) { sessionId = member.sessionId; break }
      }
    }
    // 3. resume the most recent persisted member
    if (!sessionId && topicSet.members.length > 0) {
      const target = [...topicSet.members].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: target.sessionId as never })
        branchHandles.set(target.sessionId, { agent: handle.agent, dispose: () => handle.dispose() })
        sessionId = target.sessionId
      } catch { /* fall through to a fresh branch */ }
    }
    // 4. a fresh branch session
    if (!sessionId) {
      sessionId = newId('branch')
      try {
        const handle = await ctx.agents.create({
          sessionId: sessionId as never,
          meta: { cwd },
        })
        branchHandles.set(sessionId, { agent: handle.agent, dispose: () => handle.dispose() })
      } catch (error) {
        return { status: 'error', message: `创建分支失败：${String(error).slice(0, 200)}` }
      }
      const named = await ensureMemberTitle(this.store, topicSetId, { sessionId, kind: 'root' }, topicSet.title, body)
      applySessionTitle(ctx, sessionId, named, { warn: () => {} })
      try {
        await attachBranchToWorkspace(ctx, sessionId, cwd, { warn: () => {}, info: () => {} })
      } catch { /* best-effort */ }
    }
    // deliver the reply
    try {
      const factory = await messageFactory()
      const message = factory({
        content: [{
          type: 'text',
          text: `[supermemory-panel-reply]\n话题集：${topicSet.title}\n用户回复：${body}\n\n`
            + '你是该话题集的工作分支：按用户回复继续执行并汇报结果。遇到分歧按最合理解释执行，不要停下来等确认；'
            + '需要用户裁决时用 memory_raise_question 上交中枢汇总（不要在本分支里直接向用户提问）。',
        }],
        // R25: 面板里的用户回复同样是人类投递 → kind 'user'（置顶）。
        source: { kind: 'user' },
      })
      const agent = branchHandles.get(sessionId)?.agent ?? ctx.agents.get(sessionId as never)
      if (!agent) return { status: 'error', message: '分支会话不在线，回复未送达。', id: sessionId }
      agent.followup(message as UserMessage)
      await touchTopicSet(this.store, topicSetId)
      return { status: 'ok', message: '已送入话题集分支。', id: sessionId }
    } catch (error) {
      return { status: 'error', message: `回复失败：${String(error).slice(0, 200)}`, id: sessionId }
    }
  }

  /**
   * R6: list composite tools (self-generated) with descriptions.
   *
   * A3 工作区隔离：传入 cwd 时只返回适用于该工作区的工具——能力的行级归属
   * （tool_memory.workspaceKey）或 scope 推导命中当前工作区；别的工作区的
   * 能力不列出。无 cwd（旧宿主/兼容路径）不过滤。
   */
  listTools(cwd?: string): ToolView[] {
    const workspaceKey = cwd ? this.wk(cwd) : undefined
    // R22 需求③: 能力详情面板需要维护信号，这里与 capabilityHealthOf 同源一次性取齐
    // （按工具名对齐；序列组合工具没有这些字段）。
    const health = new Map(capabilityHealthOf(this.store).map((row) => [row.name, row]))
    const rows: ToolView[] = []
    for (const [id, record] of this.store.toolMemory.entries()) {
      if (record.kind !== 'composite') continue
      let steps: string[] = []
      let parameters: string[] = []
      let name = id
      let kind: 'sequence' | 'capability' = 'sequence'
      let entry: string | undefined
      let doc: string | undefined
      let scope: string | undefined
      let runnable: boolean | undefined
      let dryRunArg: string | undefined
      let writeConfirm: boolean | undefined
      let version: number | undefined
      let routeNote: string | undefined
      let usage: ToolView["usage"]
      try {
        const spec = JSON.parse(record.entry) as {
          name?: string
          kind?: 'sequence' | 'capability'
          steps?: Array<{ tool: string }>
          parameters?: Array<{ name: string }>
          entry?: string
          doc?: string
          scope?: string
          runnable?: boolean
          dryRunArg?: string
          writeConfirm?: boolean
          routeNote?: string
          version?: number
          usage?: ToolView["usage"]
        }
        name = spec.name ?? id
        kind = spec.kind === 'capability' ? 'capability' : 'sequence'
        steps = (spec.steps ?? []).map((s) => s.tool)
        parameters = (spec.parameters ?? []).map((p) => p.name)
        entry = spec.entry
        doc = spec.doc
        scope = spec.scope
        runnable = spec.runnable
        dryRunArg = spec.dryRunArg
        writeConfirm = spec.writeConfirm
        version = typeof spec.version === 'number' ? spec.version : undefined
        routeNote = spec.routeNote
        usage = spec.usage
      } catch { /* a broken definition still lists with its description */ }
      // A3: 跨工作区的工具不列出（能力按行级归属/scope 判定；序列无归属=全局）。
      if (!capabilityAppliesToWorkspace({ scope }, workspaceKey, record.workspaceKey)) continue
      const healthRow = health.get(name)
      rows.push({
        id, name,
        title: record.title || record.description.slice(0, TITLE_MAX),
        tags: record.tags,
        description: record.description,
        steps, parameters,
        useCount: record.useCount,
        status: record.status,
        live: liveCompositeSpecs.has(name),
        // R27: 旧行在 tool_memory.createdAt 回填前是 undefined（客户端显示 —）。
        createdAt: record.createdAt,
        kind, entry, doc, scope, runnable, dryRunArg, writeConfirm,
        ...(routeNote ? { routeNote } : {}),
        ...(healthRow
          ? {
              builtin: healthRow.builtin,
              ...(healthRow.builtinVersion !== undefined ? { builtinVersion: healthRow.builtinVersion } : {}),
              scopeMissing: healthRow.scopeMissing,
              docMissing: healthRow.docMissing,
              notes: healthRow.notes,
            }
          : {}),
        ...(version !== undefined ? { version } : {}),
        ...(usage ? { usage } : {}),
      })
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return rows
  }

  /** R6: edit one composite tool (description / steps / parameters / status). */
  async editTool(id: string, patch: {
    title?: string
    tags?: string[]
    description?: string
    steps?: Array<{ tool: string; arguments: Record<string, unknown> }>
    parameters?: Array<{ name: string; step: number; key: string; description: string }>
    status?: string
  }): Promise<MutationResult> {
    if (!this.ctx) return { status: 'error', message: '宿主上下文不可用，无法修改工具。' }
    return editCompositeTool(this.ctx, this.store, id, patch)
  }

  /**
   * R6+: delete one composite tool for good (unregister + durable row + the
   * sequence signal that created it). The panel's delete button; a retired
   * tool is deleted the same way.
   */
  async deleteTool(id: string): Promise<MutationResult> {
    if (!this.ctx) return { status: 'error', message: '宿主上下文不可用，无法删除工具。' }
    return deleteCompositeTool(this.ctx, this.store, id)
  }

  /**
   * R22: run one capability tool (its entry command inside its scope directory).
   * Dry-run is the default (dryRunArg appended); a writeConfirm capability
   * refuses a real run without an explicit confirm and answers
   * status 'needs-confirm' WITHOUT executing anything.
   */
  async runTool(id: string, options: { dryRun?: boolean; confirm?: boolean } = {}): Promise<CapabilityRunResult> {
    const record = this.store.toolMemory.get(id)
    if (!record || record.kind !== 'composite' || !record.entry) {
      return { status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun: Boolean(options.dryRun), command: '', summary: '组合工具不存在。' }
    }
    let spec: CompositeSpec
    try {
      spec = JSON.parse(record.entry) as CompositeSpec
    } catch {
      return { status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun: Boolean(options.dryRun), command: '', summary: '工具定义损坏，无法执行。' }
    }
    if (spec.kind !== 'capability' || !spec.entry) {
      return {
        status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun: Boolean(options.dryRun), command: '',
        summary: '只有能力（capability）可以一键执行；序列组合工具请直接调用它。',
      }
    }
    const result = runCapability(spec, { dryRun: options.dryRun, confirm: options.confirm })
    // 实际执行过（含非零退出）才计数；needs-confirm 没有执行，不计。
    // R26 收尾：传入 result，面板执行也记成败明细/最近一次结果。
    if (result.status !== 'needs-confirm') void bumpCompositeUse(this.store, spec.name, result)
    return result
  }

  /**
   * Sidebar badge projection (GUI 问题③; R19 需求③④ root cause fix).
   *
   * Membership alone does NOT make a branch: `createTopicSetSession` adds the
   * session it creates as `kind: 'root'` — the set's own hub conversation, which
   * must keep its 中枢 role and be badged as 「话题集」.
   *
   * A branch is (a) any plugin-minted `branch-*`/`fork-*` id — a fresh dispatch
   * is recorded as kind 'root', so the id prefix is the only reliable witness —
   * or (b) a `kind:'fork'` member. R18 treated every member as a branch, so a
   * hub that owned a set showed the wrong 分支 badge (and the same conflation
   * removed it from the hub rail / disabled its hub prompt).
   *
   * Tiers: a branch hit wins; otherwise a root hit yields `hub-set`; otherwise a
   * plain hub. Multiple hits inside one tier resolve to the newest
   * `lastActiveAt`. Archived sets never badge.
   */
  /** Guarded positive hub-record read: badge truth, same table resolveRole uses. */
  private hubRecordOf(sessionId: string): boolean {
    try {
      return Boolean(this.store?.hubs?.get?.(sessionId))
    } catch {
      return false
    }
  }

  sessionBadge(sessionId: string): SessionBadge {
    const pluginBranch = isPluginBranchId(sessionId)
    let bestFork: { topicSetId: string; title: string; status: string; lastActiveAt: number } | undefined
    let bestRoot: { topicSetId: string; title: string; lastActiveAt: number } | undefined
    for (const [topicSetId, topicSet] of this.store.topicsets.entries()) {
      // status here is the TOPIC SET own status (active | archived); a member
      // row is live | idle (schema.ts) and never active.
      if (topicSet.status !== 'active') continue
      for (const member of topicSet.members) {
        if (member.sessionId !== sessionId) continue
        // A plugin-minted branch is a branch whatever its member kind: a fresh
        // dispatch records kind 'root' (its own session root), and R18's
        // kind-based reading would have turned that branch into a hub-set.
        if (pluginBranch || member.kind === 'fork') {
          if (!bestFork || member.lastActiveAt > bestFork.lastActiveAt) {
            bestFork = { topicSetId, title: topicSet.title, status: member.status, lastActiveAt: member.lastActiveAt }
          }
        } else if (!bestRoot || member.lastActiveAt > bestRoot.lastActiveAt) {
          bestRoot = { topicSetId, title: topicSet.title, lastActiveAt: member.lastActiveAt }
        }
      }
    }
    if (bestFork) {
      return { kind: 'branch', topicSetId: bestFork.topicSetId, topicSetTitle: bestFork.title, status: bestFork.status }
    }
    if (bestRoot) {
      return { kind: 'hub-set', topicSetId: bestRoot.topicSetId, topicSetTitle: bestRoot.title }
    }
    // R31 需求② + R35: a session in NO topic set is badged by POSITIVE evidence,
    // because the old catch-all `{kind:'hub'}` marked every foreign id (a branch
    // that has not joined a set yet, a subagent, a shell session) as a hub:
    // - a plugin-minted `branch-*`/`fork-*` id is a work branch that simply
    //   has no member row yet → no badge (`none`), never a hub;
    // - a session with a `hub_sessions` record → `hub` (the same positive mark
    //   resolveRole trusts; a stale `session-*` id-shape guess is NOT a role);
    // - anything else (no record: an ordinary conversation, a subagent, an
    //   unknown minting) stays unbadged (`none`) rather than being optimistically
    //   labelled a hub. Pre-R33 panel hubs get their record from the one-time
    //   title migration (src/hub-records-migration.ts).
    if (isPluginBranchId(sessionId)) return { kind: 'none' }
    if (this.hubRecordOf(sessionId)) return { kind: 'hub' }
    return { kind: 'none' }
  }
}

/** Remote descriptors for the panel service (wire contract). */
const PANEL_DESCRIPTORS = Object.freeze([
  {
    id: 'dsh-supermemory#supermemoryPanel/listTopicSets',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listTopicSets',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [{ name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } }],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/activate',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'activate',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#ActivateResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionId', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'topicSetId', wire: 'topicSetId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetId', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/activeTopicSet',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'activeTopicSet',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetView', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionId', create: () => ({ parse: (v: unknown) => v }) } }],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/hubState',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'hubState',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#HubState', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionId', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/listMemories',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listMemories',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MemoryViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'query', wire: 'query', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Query', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'limit', wire: 'limit', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Limit', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/createMemory',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'createMemory',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'text', wire: 'text', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Text', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'key', wire: 'key', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Key', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'title', wire: 'title', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Title', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'tags', wire: 'tags', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Tags', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/updateMemory',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'updateMemory',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Id', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'text', wire: 'text', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Text', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'key', wire: 'key', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Key', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'title', wire: 'title', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Title', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'tags', wire: 'tags', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Tags', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/deleteMemory',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'deleteMemory',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Id', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/setMemoryStatus',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'setMemoryStatus',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Id', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'status', wire: 'status', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Status', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R30 需求②: 记忆页签第一级（集合卡片统计）。
    id: 'dsh-supermemory#supermemoryPanel/listMemoryCollections',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listMemoryCollections',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MemoryCollectionViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R30 需求②: 记忆页签第二级（一个集合内的条目，带版本徽标）。
    id: 'dsh-supermemory#supermemoryPanel/listMemoriesByCollection',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listMemoriesByCollection',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MemoryViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'collectionId', wire: 'collectionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#CollectionId', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'query', wire: 'query', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Query', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'limit', wire: 'limit', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Limit', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R30 需求②: 记忆详情（当前版本 + 历史版本列表）。
    id: 'dsh-supermemory#supermemoryPanel/getMemoryDetail',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'getMemoryDetail',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MemoryDetail', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Id', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R36 需求②: 中枢权限页签快照（当前白名单 + 默认值 + 锁定项 + 目录）。
    id: 'dsh-supermemory#supermemoryPanel/getHubPolicy',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'getHubPolicy',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#HubPolicyView', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R36 需求②: 保存白名单（tools/prefixes 整份替换，或 reset 恢复默认）。
    id: 'dsh-supermemory#supermemoryPanel/setHubPolicy',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'setHubPolicy',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#HubPolicyPatch', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R39: 一键清理白名单里运行时已不存在的条目（锁定项除外）。
    id: 'dsh-supermemory#supermemoryPanel/cleanupStaleHubPolicy',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'cleanupStaleHubPolicy',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R41 需求①b: 设置页签的默认模型快照（中枢/分支，按工作区）。
    id: 'dsh-supermemory#supermemoryPanel/getModelDefaults',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'getModelDefaults',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#ModelDefaultsView', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R41 需求①b: 保存默认模型（每项可选/可清空，reset 恢复默认）。
    id: 'dsh-supermemory#supermemoryPanel/setModelDefaults',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'setModelDefaults',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#ModelDefaultsPatch', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/createTopicSet',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'createTopicSet',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'title', wire: 'title', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Title', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'tags', wire: 'tags', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Tags', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'summary', wire: 'summary', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Summary', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/updateTopicSetSummary',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'updateTopicSetSummary',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Id', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'summary', wire: 'summary', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Summary', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'tags', wire: 'tags', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Tags', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/createTopicSetSession',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'createTopicSetSession',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'topicSetIds', wire: 'topicSetIds', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetIds', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'options', wire: 'options', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionOptions', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'firstMessage', wire: 'firstMessage', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#FirstMessage', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/createHubSession',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'createHubSession',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'options', wire: 'options', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionOptions', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'firstMessage', wire: 'firstMessage', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#FirstMessage', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/listAgentPresets',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listAgentPresets',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#AgentPresetViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/listModelCatalog',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listModelCatalog',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#ModelCatalogView', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/listPermissions',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listPermissions',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#PermissionCatalogView', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/followupTopicSet',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'followupTopicSet',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'topicSetId', wire: 'topicSetId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetId', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'text', wire: 'text', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Text', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/listTools',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listTools',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#ToolViews', create: () => ({ parse: (v: unknown) => v }) },
    // A3: 面板按当前工作区拉取工具列表（cwd 由面板传入）。
    // 与 listTools(cwd?: string) 的签名一致：cwd 可省略（无 cwd 时不过滤），
    // 客户端声明端同为 optional，两端参数个数必须一致，否则客户端 api 直接拒调。
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/editTool',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'editTool',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Id', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'patch', wire: 'patch', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#ToolPatch', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/deleteTool',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'deleteTool',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Id', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R22: 一键执行能力（默认预演；writeConfirm 能力需 options.confirm=true）。
    id: 'dsh-supermemory#supermemoryPanel/runTool',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'runTool',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#CapabilityRunResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Id', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'options', wire: 'options', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#RunOptions', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/listHubSessions',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listHubSessions',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#HubSessionRows', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R19 协同②: the branches one hub started (name / state / shared / set).
    id: 'dsh-supermemory#supermemoryPanel/listHubBranches',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listHubBranches',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#HubBranchViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'hubSessionId', wire: 'hubSessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#HubSessionId', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'limit', wire: 'limit', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Limit', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R30 需求③: 中枢管理全部话题集（含归档）——标题/标签/会话数/在线数。
    id: 'dsh-supermemory#supermemoryPanel/listAllTopicSets',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listAllTopicSets',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R30 需求③: 中枢查看全部分支会话（跨话题集，可按话题集筛选）。
    id: 'dsh-supermemory#supermemoryPanel/listAllBranches',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listAllBranches',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#HubBranchViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'topicSetId', wire: 'topicSetId', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetId', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'limit', wire: 'limit', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Limit', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    // R19 需求⑤: in-panel conversation — read the model-visible surface and
    // send a followup without navigating to the shell's session page.
    id: 'dsh-supermemory#supermemoryPanel/readSessionMessages',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'readSessionMessages',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionChatView', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionId', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'limit', wire: 'limit', source: 'json', acceptsUndefined: true, codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Limit', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/sendSessionMessage',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'sendSessionMessage',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionId', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'text', wire: 'text', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Text', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/suggestMemoryShape',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'suggestMemoryShape',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MemoryShape', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'text', wire: 'text', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Text', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/sessionBadge',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'sessionBadge',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionBadge', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionId', create: () => ({ parse: (v: unknown) => v }) } }],
  },
])

/**
 * Mount the panel service and register its remote descriptors.
 *
 * Three host contracts make the panel reachable from the browser, and the first
 * two used to be silently missing (2026-11-18: every panel call answered 404):
 *
 * 1. `ctx.typert` is a proxy property. Reading it requires 'typert' in this
 *    plugin's `inject`; without it the getter throws "cannot get property
 *    'typert' without inject" (cordis ReflectService.handler.get). The old code
 *    read `ctx.typert?.register(...)` inside `try { } catch {}`, so the throw was
 *    swallowed on every call, the descriptors never reached the typert local
 *    registry, and the API Gateway (claimsEndpoint reads
 *    `ctx.typert.local.get(endpoint)`) answered 404 for POST
 *    /api/supermemoryPanel/*. `ctx.get('typert')` has no inject requirement, and
 *    every failure is now logged instead of swallowed.
 * 2. The Gateway's validateBinding/readBinding requires the service instance to
 *    expose `typertRemote` = `{ service, serviceKey, namespace }` — exactly what
 *    `bindTypertRemote(this, 'supermemoryPanel')` from
 *    @deepseek-ai/dsh-typert-protocol produces. It is attached here by hand
 *    because this plugin takes no static dependency on that package (host
 *    packages resolve only through the loadHostModule anchor).
 * 3. The registry keys every endpoint and remembers every endpoint it has EVER
 *    seen (`local.hasSeen()`). Once a strict definition is withdrawn, the
 *    Gateway refuses the descriptor-free source fallback for that endpoint for
 *    the rest of the process:
 *      "typert gateway: supermemoryPanel/hubState: its strict definition was
 *       withdrawn and SRC fallback is forbidden".
 *    A plugin reload can race the old fiber's teardown: the new instance calls
 *    `typert.register()` while the old package face is still live, the registry
 *    rejects the duplicate, the old fiber then withdraws, and nothing ever
 *    re-registers — the panel is dead while every other feature still works.
 *    The registration therefore VERIFIES its endpoints and RETRIES instead of
 *    firing once (see attachPanelRegistration).
 */
export function attachPanel(ctx: Context, store: Store | undefined): () => void {
  if (!store) return () => {}
  const service = new SupermemoryPanelService(store, ctx)
  // Gateway validateBinding: the binding must point at THIS instance, and the
  // original it reads is the instance itself (no symbols.original on a plain
  // class instance), so a non-enumerable own property is enough.
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({ service, serviceKey: 'supermemoryPanel', namespace: 'supermemoryPanel' }),
    enumerable: false,
  })
  ctx.provide('supermemoryPanel', service)
  return attachPanelRegistration(ctx)
}

/** The single package-face contribution this plugin registers (schemas stay empty: the wire codecs are hand-written). */
interface PanelContribution {
  package: string
  face: 'host'
  schemas: unknown[]
  model: { services: unknown[]; events: unknown[]; objects: unknown[] }
  invocations: typeof PANEL_DESCRIPTORS
}

/** The slice of `ctx.get('typert')` that the panel registration depends on. */
interface PanelTypertRegistry {
  register(contribution: PanelContribution): unknown
  local?: { get(endpoint: string): unknown }
}

/** Endpoint key of one descriptor, exactly as the registry (and the Gateway) keys it. */
function panelEndpoint(descriptor: { namespace: string; method: string }): string {
  return `${descriptor.namespace}/${descriptor.method}`
}

/** Delays between failed registration attempts; the last value repeats. */
const PANEL_REGISTRATION_RETRY_MS = Object.freeze([250, 750, 2000, 5000, 15000])
/** Re-verification delays after a healthy registration, before the steady watchdog takes over. */
const PANEL_REGISTRATION_VERIFY_MS = Object.freeze([1000, 4000])
/** Steady-state watchdog: re-registers if the endpoints are withdrawn later in this process. */
const PANEL_REGISTRATION_WATCHDOG_MS = 30000

/**
 * Keep the panel descriptors registered for this fiber's lifetime.
 *
 * `typert.register()` is transactional and rejects the whole batch on a
 * duplicate package face or endpoint, so the only safe recovery from the reload
 * race described on attachPanel is to retry once the old fiber has withdrawn.
 * Each tick first verifies the live endpoints through `typert.local.get()`: a
 * complete set is health (watchdog), a missing set is re-registered. Timers are
 * unref'd and cleared by the returned disposer, so the plugin never keeps the
 * process alive and a reload starts from a clean slate.
 */
function attachPanelRegistration(ctx: Context): () => void {
  let closed = false
  let failed = 0
  let verified = 0
  /** Set once a registration succeeded on a registry that cannot be read back (no `local` view). */
  let healthUnverifiable = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const disposers: unknown[] = []

  const schedule = (delay: number) => {
    if (closed) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      check()
    }, delay)
    timers.add(timer)
    // A pending watchdog must never hold the Node event loop open.
    const unrefable = timer as unknown as { unref?: () => void }
    if (typeof unrefable.unref === 'function') unrefable.unref()
  }

  /**
   * Registration state read from the registry: true = every endpoint is live,
   * false = at least one is missing, undefined = this registry exposes no
   * `local` view (a test double or a future host), so it cannot be verified.
   */
  const registered = (typert: PanelTypertRegistry): boolean | undefined => {
    const local = typert.local
    if (!local || typeof local.get !== 'function') return undefined
    return PANEL_DESCRIPTORS.every(descriptor => local.get(panelEndpoint(descriptor)) !== undefined)
  }

  const check = () => {
    if (closed) return
    // ctx.get (never ctx.typert): the proxy getter throws without inject.
    const typert = ctx.get('typert') as PanelTypertRegistry | undefined
    if (!typert || typeof typert.register !== 'function') {
      if (failed === 0) console.warn('supermemory: typert registry unavailable; panel remote descriptors not registered yet')
      failed += 1
      schedule(PANEL_REGISTRATION_RETRY_MS[Math.min(failed - 1, PANEL_REGISTRATION_RETRY_MS.length - 1)])
      return
    }
    const state = registered(typert)
    if (state === true || (state === undefined && healthUnverifiable)) {
      failed = 0
      verified += 1
      schedule(verified <= PANEL_REGISTRATION_VERIFY_MS.length
        ? PANEL_REGISTRATION_VERIFY_MS[verified - 1]
        : PANEL_REGISTRATION_WATCHDOG_MS)
      return
    }
    try {
      const disposer = typert.register({
        package: 'dsh-supermemory',
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: PANEL_DESCRIPTORS,
      })
      if (typeof disposer === 'function') disposers.push(disposer)
      const after = registered(typert)
      if (after === false) throw new Error('the registry did not keep the panel descriptors')
      if (after === undefined) healthUnverifiable = true
      failed = 0
      verified = 0
    } catch (error) {
      // Loud on the first failure only: a duplicate package face is expected
      // during a reload race, and the retries below are the recovery path.
      if (failed === 0) console.warn('supermemory: typert register failed for the panel descriptors; retrying', error)
      failed += 1
    }
    schedule(failed === 0
      ? PANEL_REGISTRATION_VERIFY_MS[0]
      : PANEL_REGISTRATION_RETRY_MS[Math.min(failed - 1, PANEL_REGISTRATION_RETRY_MS.length - 1)])
  }

  check()

  return () => {
    if (closed) return
    closed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const disposer of disposers) {
      try { (disposer as () => void)() } catch { /* the owning fiber disposes the same effect */ }
    }
    disposers.length = 0
  }
}
