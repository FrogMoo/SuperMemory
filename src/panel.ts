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
import type { Memory, ToolMemory } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import {
  addMember, createTopicSet, getRouting, getTopicSet, listTopicSets, setRouting,
  touchTopicSet, updateTopicSetSummary,
} from './topicsets.ts'
import { applySessionTitle, ensureMemberTitle } from './title.ts'
import { attachBranchToWorkspace } from './workspace.ts'
import { branchHandles } from './dispatch.ts'
import { deleteCompositeTool, editCompositeTool, liveCompositeSpecs } from './composite.ts'
import { enumerateModels } from './model.ts'
import { tokenize } from './recall.ts'

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
  | { kind: 'branch'; topicSetId: string; topicSetTitle: string; status: string }

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

let createMessage: typeof CreateUserMessage | undefined
async function messageFactory(): Promise<typeof CreateUserMessage> {
  if (!createMessage) {
    const llm = await loadHostModule('@deepseek-ai/dsh-llm')
    createMessage = llm.createUserMessage as typeof CreateUserMessage
  }
  return createMessage
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

  private view(id: string, topicSet: ReturnType<typeof getTopicSet>): TopicSetView {
    if (!topicSet) return { id, title: id, summary: '', branches: [] }
    return {
      id,
      title: topicSet.title,
      summary: topicSet.summary,
      branches: topicSet.members.map((m) => ({
        sessionId: m.sessionId,
        title: m.title,
        status: m.status,
        ...(m.model ? { model: m.model } : {}),
      })),
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
    const memories: MemoryView[] = []
    for (const [id, record] of this.store.memories.entries()) {
      if (record.workspaceKey !== workspaceKey) continue
      memories.push({
        id, text: record.text, key: record.key, status: record.status,
        sourceSessionId: record.sourceSessionId,
        createdAt: record.createdAt, updatedAt: record.updatedAt,
      })
    }
    memories.sort((a, b) => b.updatedAt - a.updatedAt)
    let requirements = 0
    for (const [, record] of this.store.requirements.entries()) {
      if (record.workspaceKey === workspaceKey && record.status === 'open') requirements++
    }
    let dispatches = 0
    for (const [, record] of this.store.dispatches.entries()) {
      if (record.status !== 'delivered' && record.status !== 'failed') dispatches++
    }
    const tools = [...this.store.toolMemory.entries()].filter(([, r]) => r.kind === 'composite').length
    return {
      sessionId,
      workspaceKey,
      ...(getRouting(this.store, sessionId)?.activeTopicSetId
        ? { activeTopicSetId: getRouting(this.store, sessionId)!.activeTopicSetId }
        : {}),
      topicSets,
      memories,
      counts: { memories: memories.length, requirements, episodes: this.store.episodes.size, dispatches, tools },
    }
  }

  /** Memories of one workspace, newest first; `query` filters by text/keywords. */
  listMemories(cwd: string, query?: string, limit?: number): MemoryView[] {
    const workspaceKey = this.wk(cwd)
    const tokens = query ? new Set(tokenize(query)) : new Set<string>()
    const rows: Array<{ view: MemoryView; score: number }> = []
    for (const [id, record] of this.store.memories.entries()) {
      if (record.workspaceKey !== workspaceKey) continue
      const bag = new Set(tokenize(`${record.text} ${record.key ?? ''} ${record.keywords.join(' ')}`))
      let score = 0
      for (const token of tokens) if (bag.has(token)) score++
      if (tokens.size > 0 && score === 0) continue
      rows.push({
        score,
        view: {
          id, text: record.text, key: record.key, status: record.status,
          sourceSessionId: record.sourceSessionId,
          createdAt: record.createdAt, updatedAt: record.updatedAt,
        },
      })
    }
    rows.sort((a, b) => b.score - a.score || b.view.updatedAt - a.view.updatedAt)
    const cap = Math.max(1, Math.min(200, Number(limit) || 100))
    return rows.slice(0, cap).map((row) => row.view)
  }

  /** Create one memory (panel editor). Mirrors memory_remember semantics. */
  async createMemory(cwd: string, text: string, key?: string): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const body = String(text ?? '').trim()
    if (!body) return { status: 'error', message: '记忆文本不能为空。' }
    const stableKey = key?.trim() || undefined
    const now = Date.now()
    for (const [memoryId, record] of this.store.memories.entries()) {
      if (record.workspaceKey !== workspaceKey || record.status !== 'active') continue
      if (stableKey && record.key === stableKey) {
        if (record.text.trim().toLowerCase() === body.toLowerCase()) {
          return { status: 'ok', message: '该 key 已存相同内容，未重复写入。', id: memoryId }
        }
        return { status: 'error', message: `key「${stableKey}」已存不同内容，请先修改或删除原记忆。`, id: memoryId }
      }
      if (!stableKey && record.text.trim().toLowerCase() === body.toLowerCase()) {
        return { status: 'ok', message: '相同记忆已存在。', id: memoryId }
      }
    }
    const memoryId = newId('mem')
    const memory: Memory = {
      workspaceKey, text: body, key: stableKey,
      keywords: [...new Set(tokenize(body))].slice(0, 12),
      // Typed in the panel: there is no source session to locate.
      sourceSessionId: '',
      sourceSeq: 0,
      status: 'active', createdAt: now, updatedAt: now,
    }
    await this.store.memories.put(memoryId, memory)
    return { status: 'ok', message: '已记住。', id: memoryId }
  }

  /** Update one memory's text (and optional key). */
  async updateMemory(cwd: string, id: string, text: string, key?: string): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const record = this.store.memories.get(id)
    if (!record || record.workspaceKey !== workspaceKey) return { status: 'error', message: '记忆不存在或不属于当前工作区。' }
    const body = String(text ?? '').trim()
    if (!body) return { status: 'error', message: '记忆文本不能为空。' }
    await this.store.memories.update(id, (r) => ({
      ...r,
      text: body,
      ...(key !== undefined ? { key: key.trim() || undefined } : {}),
      keywords: [...new Set(tokenize(body))].slice(0, 12),
      updatedAt: Date.now(),
    }))
    return { status: 'ok', message: '已更新。', id }
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

  /** Create a topic set (panel). */
  async createTopicSet(cwd: string, title: string): Promise<MutationResult> {
    const workspaceKey = this.wk(cwd)
    const name = String(title ?? '').trim()
    if (!name) return { status: 'error', message: '标题不能为空。' }
    const id = await createTopicSet(this.store, { workspaceKey, title: name.slice(0, 40) })
    return { status: 'ok', message: `已创建话题集『${name.slice(0, 40)}』。`, id }
  }

  /** Update a topic set's summary (panel). */
  async updateTopicSetSummary(id: string, summary: string): Promise<MutationResult> {
    if (!this.store.topicsets.get(id)) return { status: 'error', message: '话题集不存在。' }
    await updateTopicSetSummary(this.store, id, String(summary ?? '').slice(0, 500))
    return { status: 'ok', message: '梗概已更新。', id }
  }

  /**
   * R3: create a session bound to one or more topic sets (话题集会话).
   * The session is a fresh root member of every selected topic set.
   */
  async createTopicSetSession(cwd: string, topicSetIds: string[], options: SessionOptions = {}): Promise<MutationResult> {
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
      try {
        await attachBranchToWorkspace(ctx, sessionId, cwd, { warn: () => {}, info: () => {} })
      } catch { /* workspace attach is best-effort */ }
      return { status: 'ok', message: `已创建话题集会话（${titles.join('、')}）。`, id: sessionId }
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
  async createHubSession(cwd: string, options: SessionOptions = {}): Promise<MutationResult> {
    const created = await this.createSessionWithOptions(cwd, options)
    if ('error' in created) return { status: 'error', message: created.error }
    // A short id suffix keeps several hub sessions distinguishable in the
    // sidebar list (requirement C naming, hub flavour).
    const title = '新会话 · ' + created.sessionId.slice(-4)
    await this.finishSession(created.sessionId, cwd, title)
    return { status: 'ok', message: '已创建中枢会话。', id: created.sessionId }
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
  ): Promise<{ sessionId: string } | { error: string }> {
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
    try {
      await ctx.agents.create({
        sessionId: sessionId as never,
        meta: meta as never,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions: agentOptions as never } : {}),
      })
    } catch (error) {
      return { error: `创建会话失败：${String(error).slice(0, 200)}` }
    }
    this.applyPermission(sessionId, options.permission)
    return { sessionId }
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
            + '你是该话题集的工作分支：按用户回复继续执行并汇报结果。不要向用户提问，遇到分歧按最合理解释执行。',
        }],
        source: { kind: 'supermemory' },
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

  /** R6: list composite tools (self-generated) with descriptions. */
  listTools(): ToolView[] {
    const rows: ToolView[] = []
    for (const [id, record] of this.store.toolMemory.entries()) {
      if (record.kind !== 'composite') continue
      let steps: string[] = []
      let parameters: string[] = []
      let name = id
      try {
        const spec = JSON.parse(record.entry) as { name?: string; steps?: Array<{ tool: string }>; parameters?: Array<{ name: string }> }
        name = spec.name ?? id
        steps = (spec.steps ?? []).map((s) => s.tool)
        parameters = (spec.parameters ?? []).map((p) => p.name)
      } catch { /* a broken definition still lists with its description */ }
      rows.push({
        id, name,
        description: record.description,
        steps, parameters,
        useCount: record.useCount,
        status: record.status,
        live: liveCompositeSpecs.has(name),
      })
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return rows
  }

  /** R6: edit one composite tool (description / steps / parameters / status). */
  async editTool(id: string, patch: {
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
   * Sidebar badge projection (GUI 问题③): which topic set, if any, owns this
   * session. A member row of a non-archived topic set marks the session as a
   * branch; every other session (hub sessions, archived sets, unknown ids) is
   * a hub. Multiple hits resolve to the newest lastActiveAt.
   */
  sessionBadge(sessionId: string): SessionBadge {
    let best: { topicSetId: string; title: string; status: string; lastActiveAt: number } | undefined
    for (const [topicSetId, topicSet] of this.store.topicsets.entries()) {
      // status here is the TOPIC SET own status (active | archived); a member
      // row is live | idle (schema.ts) and never active.
      if (topicSet.status !== 'active') continue
      for (const member of topicSet.members) {
        if (member.sessionId !== sessionId) continue
        if (!best || member.lastActiveAt > best.lastActiveAt) {
          best = { topicSetId, title: topicSet.title, status: member.status, lastActiveAt: member.lastActiveAt }
        }
      }
    }
    if (!best) return { kind: 'hub' }
    return { kind: 'branch', topicSetId: best.topicSetId, topicSetTitle: best.title, status: best.status }
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
    id: 'dsh-supermemory#supermemoryPanel/createTopicSet',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'createTopicSet',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#MutationResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'title', wire: 'title', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Title', create: () => ({ parse: (v: unknown) => v }) } },
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
    parameters: [],
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
 * Two host contracts make the panel reachable from the browser, and BOTH used
 * to be silently missing (2026-11-18: every panel call answered HTTP 404):
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
  // ctx.get (never ctx.typert): the proxy getter throws without inject.
  const typert = ctx.get('typert') as { register?: (contribution: unknown) => unknown } | undefined
  if (!typert || typeof typert.register !== 'function') {
    console.warn('supermemory: typert registry unavailable; panel remote descriptors not registered')
    return () => { /* service disposal is fiber-scoped */ }
  }
  try {
    typert.register({
      package: 'dsh-supermemory',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: PANEL_DESCRIPTORS,
    })
  } catch (error) {
    // Loud on purpose: a duplicate package-face/endpoint registration (this
    // plugin re-enabled over root-owned registry entries) lands here. A silent
    // catch is exactly what produced the 404 panel.
    console.warn('supermemory: typert register failed for the panel descriptors', error)
  }
  return () => { /* service disposal is fiber-scoped */ }
}
