/**
 * Model-visible tools. P0 shipped `memory_remember` / `memory_recall`; P1 adds
 * `memory_dispatch` (async fan-out), `memory_topicsets`, `memory_new_topicset`
 * and `memory_set_model`. Definitions are built with the host's `defineTool`
 * (loaded through the host anchor) so argument/output validation runs on the
 * host's own machinery.
 * @module supermemory/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type * as Tools from '@deepseek-ai/dsh-tools'
import { runDispatch, type DispatchDeps } from './dispatch.ts'
import { loadHostModule } from './host.ts'
import { applyModelSelection, askDefaultModel, enumerateModels, type ModelDeps } from './model.ts'
import { recallMemories, type RecallOptions } from './recall.ts'
import type { Episode, FileMapEntry, Memory, Requirement, Signal } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import { createTopicSet, listTopicSets, setRouting, topicSetIdsOf } from './topicsets.ts'

export interface ToolsDeps {
  ctx: Context
  store: Store
  dispatch: DispatchDeps
  model: ModelDeps
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

export interface ToolsConfig {
  rememberEnabled: boolean
  recall: {
    maxItems: number
    minScore: number
    halfLifeDays: number
  }
}

interface ToolExec {
  agent?: { id?: string; session?: { header?: { cwd?: string } } }
}

/** The receipt/error shape `memory_dispatch` returns (matches its output schema). */
interface DispatchResult {
  status: 'dispatched' | 'error'
  dispatchId?: string
  branchSessionId?: string
  topicSetId?: string
  message?: string
}

/** Attach all tools; returns the effect disposer. */
export async function attachTools(ctx: Context, deps: ToolsDeps, config: ToolsConfig): Promise<() => void> {
  const { store } = deps
  const tools = await loadHostModule('@deepseek-ai/dsh-tools') as typeof Tools
  const disposers: Array<() => void> = []

  if (config.rememberEnabled) {
    disposers.push(ctx.tools.register(tools.defineTool({
      name: 'memory_remember',
      description: '将一条事实记忆写入 SuperMemory：跨会话持久、按工作区隔离。用户明确要求记住某事、或你判断某事实值得跨会话保留时使用。'
        + '同一 key 已存不同文本时返回冲突提示（不覆盖），由你向用户裁决。',
      parameters: {
        text: { type: 'string', required: true, description: '要记住的事实文本，简洁自包含' },
        key: { type: 'string', description: '可选稳定键；同一事实更新时传相同 key' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['stored', 'updated', 'conflict', 'duplicate'], required: true },
            memoryId: { type: 'string' },
            message: { type: 'string', required: true },
            conflict: {
              type: 'object',
              properties: {
                memoryId: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: String((value as { message?: string }).message ?? '') }],
      },
      async execute(args: { text: string; key?: string }, exec: ToolExec) {
        const cwd = exec.agent?.session?.header?.cwd
        if (!cwd) return { status: 'conflict' as const, message: '无法确定当前工作区（agent 会话缺少 cwd），已拒绝写入。' }
        const workspaceKey = workspaceKeyOf(cwd)
        const text = String(args.text ?? '').trim()
        if (!text) return { status: 'conflict' as const, message: 'text 不能为空。' }
        const key = args.key?.trim() || undefined
        const now = Date.now()

        if (key) {
          for (const [memoryId, record] of store.memories.entries()) {
            if (record.workspaceKey !== workspaceKey || record.status !== 'active' || record.key !== key) continue
            if (record.text.trim().toLowerCase() === text.toLowerCase()) {
              return { status: 'duplicate' as const, memoryId, message: '该 key 已存相同内容，未重复写入。' }
            }
            return {
              status: 'conflict' as const,
              memoryId,
              message: `key「${key}」已存不同内容：「${record.text}」。请与用户裁决后再写入。`,
              conflict: { memoryId, text: record.text },
            }
          }
        }
        for (const [memoryId, record] of store.memories.entries()) {
          if (record.workspaceKey === workspaceKey && record.status === 'active'
            && record.text.trim().toLowerCase() === text.toLowerCase()) {
            return { status: 'duplicate' as const, memoryId, message: '相同记忆已存在，未重复写入。' }
          }
        }
        const memoryId = newId('mem')
        const memory: Memory = {
          workspaceKey, text, key,
          keywords: keywordsOfText(text),
          sourceSessionId: String((exec.agent as { id?: string } | undefined)?.id ?? 'tool'),
          sourceSeq: 0,
          status: 'active', createdAt: now, updatedAt: now,
        }
        await store.memories.put(memoryId, memory)
        return { status: 'stored' as const, memoryId, message: `已记住：${text}` }
      },
    })))
  }

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_recall',
    description: '检索 SuperMemory：事实记忆（memories）、归档梗概（episodes）、需求（requirements）与项目文件地图（filemap），按当前工作区隔离，'
      + '关键词 + 时间衰减规则评分。回答"之前说过什么/做过什么"类问题前先用本工具检索。',
    parameters: {
      query: { type: 'string', required: true, description: '检索问题或关键词' },
      limit: { type: 'integer', description: `返回条数上限，默认 ${config.recall.maxItems}` },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['memory', 'episode', 'requirement', 'file'], required: true },
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
                score: { type: 'number', required: true },
                createdAt: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          total: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const items = (value as { items?: Array<{ text: string }> }).items ?? []
        if (items.length === 0) return [{ type: 'text', text: '（未检索到相关记忆）' }]
        return [{ type: 'text', text: items.map((item, i) => `${i + 1}. ${item.text}`).join('\n') }]
      },
    },
    async execute(args: { query: string; limit?: number }, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (!cwd) return { items: [], total: 0 }
      const workspaceKey = workspaceKeyOf(cwd)
      const query = String(args.query ?? '').trim()
      if (!query) return { items: [], total: 0 }
      const options: RecallOptions = {
        limit: Math.max(1, Math.min(20, Number(args.limit) || config.recall.maxItems)),
        minScore: config.recall.minScore,
        halfLifeDays: config.recall.halfLifeDays,
        now: Date.now(),
      }
      const items: Array<{ kind: 'memory' | 'episode' | 'requirement' | 'file'; id: string; text: string; score: number; createdAt: number }> = []
      const memories: Array<[string, Memory]> = []
      for (const entry of store.memories.entries()) {
        if (entry[1].workspaceKey === workspaceKey && entry[1].status === 'active') memories.push(entry)
      }
      for (const item of recallMemories(memories, query, options)) {
        items.push({ kind: 'memory', id: item.memoryId, text: item.text, score: item.score, createdAt: item.createdAt })
      }
      // Workspace isolation (D4): episodes have no workspaceKey of their own —
      // they join through their topic set. Without this filter a recall in
      // workspace A surfaced workspace B's archived summaries.
      const ownTopicSetIds = topicSetIdsOf(store, workspaceKey)
      const episodes: Array<[string, Episode]> = []
      for (const entry of store.episodes.entries()) {
        const topicSetId = entry[1].topicSetId
        if (!topicSetId || !ownTopicSetIds.has(topicSetId)) continue
        if (entry[1].summary) episodes.push([entry[0], entry[1]])
      }
      for (const item of recallMemories(
        episodes.map(([id, episode]) => [id, {
          workspaceKey: '', text: episode.summary, keywords: [], sourceSessionId: episode.sourceSessionId,
          sourceSeq: episode.sourceSeqStart, status: 'active' as const, createdAt: episode.timeStart, updatedAt: episode.timeEnd,
        }]),
        query, options,
      )) {
        items.push({ kind: 'episode', id: item.memoryId, text: item.text, score: item.score, createdAt: item.createdAt })
      }
      const requirements: Array<[string, Requirement]> = []
      for (const entry of store.requirements.entries()) {
        if (entry[1].workspaceKey === workspaceKey && entry[1].status === 'open') requirements.push(entry)
      }
      for (const item of recallMemories(
        requirements.map(([id, req]) => [id, {
          workspaceKey: req.workspaceKey, text: req.text, keywords: req.constraints, sourceSessionId: req.sourceSessionId,
          sourceSeq: req.sourceSeq, status: 'active' as const, createdAt: req.createdAt, updatedAt: req.createdAt,
        }]),
        query, options,
      )) {
        items.push({ kind: 'requirement', id: item.memoryId, text: item.text, score: item.score, createdAt: item.createdAt })
      }
      // P2: the project file map answers "这个文件干什么".
      const filemap: Array<[string, FileMapEntry]> = []
      for (const entry of store.filemap.entries()) {
        if (entry[1].workspaceKey === workspaceKey) filemap.push(entry)
      }
      for (const item of recallMemories(
        filemap.map(([key, entry]) => [key, {
          workspaceKey: entry.workspaceKey, text: `${entry.path}（${entry.role}）${entry.summary}`, keywords: entry.keywords,
          sourceSessionId: '', sourceSeq: 0, status: 'active' as const, createdAt: entry.annotatedAt, updatedAt: entry.annotatedAt,
        }]),
        query, options,
      )) {
        items.push({ kind: 'file', id: item.memoryId, text: item.text, score: item.score, createdAt: item.createdAt })
      }
      items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      return { items: items.slice(0, options.limit), total: items.length }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_topicsets',
    description: '列出当前工作区的话题集（标题/梗概/分支状态/默认模型），或查看单个话题集的详情。'
      + '需要激活某个话题集时用 /memory switch，或在消息里 @话题集名。',
    parameters: {
      topicSetId: { type: 'string', description: '可选；提供则返回该话题集详情' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                branches: { type: 'integer', required: true },
                model: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          total: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const items = (value as { items?: Array<{ title: string; summary: string; branches: number; model?: string }> }).items ?? []
        if (items.length === 0) return [{ type: 'text', text: '（当前工作区暂无话题集）' }]
        return [{
          type: 'text',
          text: items.map((i) => `- ${i.title}（${i.branches} 分支${i.model ? ' · ' + i.model : ''}）${i.summary ? '：' + i.summary.slice(0, 80) : ''}`).join('\n'),
        }]
      },
    },
    async execute(args: { topicSetId?: string }, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (!cwd) return { items: [], total: 0 }
      const workspaceKey = workspaceKeyOf(cwd)
      const toItem = (id: string, topicSet: { title: string; summary: string; members: unknown[]; defaultModel?: { provider: string; model: string } }) => ({
        id,
        title: topicSet.title,
        summary: topicSet.summary,
        branches: topicSet.members.length,
        ...(topicSet.defaultModel ? { model: `${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}` } : {}),
      })
      if (args.topicSetId) {
        const topicSet = store.topicsets.get(String(args.topicSetId))
        if (!topicSet) return { items: [], total: 0 }
        return { items: [toItem(String(args.topicSetId), topicSet)], total: 1 }
      }
      const items = listTopicSets(store, workspaceKey).map(([id, topicSet]) => toItem(id, topicSet))
      return { items, total: items.length }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_new_topicset',
    description: '为当前讨论新建一个话题集（可按提示选择默认模型），并立即激活。'
      + '显式开新话题时使用；不确定时先 memory_topicsets 查看已有话题集。',
    parameters: {
      title: { type: 'string', required: true, description: '话题集标题（简短）' },
      askModel: { type: 'boolean', description: '是否询问默认模型；默认询问' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['created', 'error'], required: true },
          topicSetId: { type: 'string' },
          title: { type: 'string' },
          model: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as { status: string; title?: string; model?: string; message?: string }
        if (v.status === 'created') {
          return [{ type: 'text', text: `已创建并激活话题集『${v.title ?? ''}』${v.model ? '（默认模型 ' + v.model + '）' : ''}` }]
        }
        return [{ type: 'text', text: v.message ?? '创建失败。' }]
      },
    },
    async execute(args: { title: string; askModel?: boolean }, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      const sessionId = String(exec.agent?.id ?? '')
      if (!cwd || !sessionId) return { status: 'error' as const, message: '无法确定当前会话。' }
      const workspaceKey = workspaceKeyOf(cwd)
      let model
      if (args.askModel !== false) {
        model = await askDefaultModel(deps.model, exec.agent)
      }
      const topicSetId = await createTopicSet(store, {
        workspaceKey,
        title: String(args.title).slice(0, 40),
        ...(model ? { defaultModel: model } : {}),
      })
      await setRouting(store, sessionId, { activeTopicSetId: topicSetId, driftCount: 0 })
      return {
        status: 'created' as const,
        topicSetId,
        title: String(args.title).slice(0, 40),
        ...(model ? { model: `${model.provider}/${model.model}` } : {}),
      }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_dispatch',
    description: '把实质工作异步派发到话题集的分支会话（在全新对话中执行，不在主对话框直接完成操作）：插件先落账，随即唤醒分支并立即返回回执，'
      + '本会话（中枢）不阻塞。分支完成后结果会以 relay 形式主动送回本会话。'
      + '简单问答不要派发——上下文卡/recall 能答的中枢直接答。mode=auto 时插件自行判定继续/新建；'
      + '需要从父分支最近已完成轮次开新分支时用 mode=fork。传 tasks[]（2 个以上）走并行组：每个任务一个分支，'
      + '全部到达终态后只回送一次汇总（失败成员标注）。',
    parameters: {
      task: { type: 'string', description: '单个任务描述（自包含）；与 tasks 二选一' },
      tasks: {
        type: 'array',
        description: '多个任务描述（2 个以上）→ 并行组，全部终态后单次汇总回送',
        items: { type: 'string' },
      },
      topicSetId: { type: 'string', description: '目标话题集；省略则用本会话当前激活的话题集' },
      mode: { type: 'string', enum: ['auto', 'continue', 'fork', 'new'], description: '分支获取方式；默认 auto' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['dispatched', 'error'], required: true },
          dispatchId: { type: 'string' },
          branchSessionId: { type: 'string' },
          groupId: { type: 'string' },
          topicSetId: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as { status: string; branchSessionId?: string; groupId?: string; message?: string }
        if (v.status === 'dispatched') {
          return [{ type: 'text', text: v.message ?? `已派发到分支 ${v.branchSessionId}；完成后结果会主动送回本会话。` }]
        }
        return [{ type: 'text', text: v.message ?? '派发失败。' }]
      },
    },
    async execute(args: { task?: string; tasks?: string[]; topicSetId?: string; mode?: 'auto' | 'continue' | 'fork' | 'new' }, exec: ToolExec): Promise<DispatchResult> {
      // The tool contract is a receipt/error VALUE, never a thrown exception:
      // an unexpected storage/agent failure must not surface as a tool crash.
      try {
        return await runDispatch(deps.dispatch, args, exec)
      } catch (error) {
        deps.logger.warn(`supermemory: memory_dispatch threw: ${String(error).slice(0, 200)}`)
        return { status: 'error', message: `派发异常：${String(error).slice(0, 200)}` }
      }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_set_model',
    description: '设置话题集默认模型或单个分支的模型覆盖。省略 provider/model 时返回当前可用的'
      + 'providers/models 目录供选择（运行时枚举，可能为空——空目录时可直接自由输入）。',
    parameters: {
      topicSetId: { type: 'string', description: '按话题集设置（默认模型）' },
      branchSessionId: { type: 'string', description: '按分支设置（覆盖）' },
      provider: { type: 'string', description: '提供方 id' },
      model: { type: 'string', description: '模型 id' },
      reasoningEffort: { type: 'string', description: '可选推理强度' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['applied', 'catalog', 'error'], required: true },
          applied: { type: 'string' },
          live: { type: 'boolean' },
          catalog: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                provider: { type: 'string', required: true },
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as { status: string; applied?: string; catalog?: Array<{ provider: string; id: string }>; message?: string }
        if (v.status === 'applied') return [{ type: 'text', text: `已设置模型：${v.applied}` }]
        if (v.status === 'catalog') {
          const list = (v.catalog ?? []).map((m) => `${m.provider}/${m.id}`).join('、')
          return [{ type: 'text', text: `可用模型目录：${list || '（空——可直接自由输入 provider 与 model）'}` }]
        }
        return [{ type: 'text', text: v.message ?? '设置失败。' }]
      },
    },
    async execute(args: { topicSetId?: string; branchSessionId?: string; provider?: string; model?: string; reasoningEffort?: string }) {
      if (!args.provider || !args.model) {
        const { models } = await enumerateModels(deps.ctx)
        return { status: 'catalog' as const, catalog: models.slice(0, 40) }
      }
      if (!args.topicSetId && !args.branchSessionId) {
        return { status: 'error' as const, message: '必须指定 topicSetId 或 branchSessionId。' }
      }
      const result = await applyModelSelection(deps.model, { topicSetId: args.topicSetId, branchSessionId: args.branchSessionId }, {
        provider: String(args.provider),
        model: String(args.model),
        ...(args.reasoningEffort ? { reasoningEffort: String(args.reasoningEffort) } : {}),
      })
      if (!result.applied) return { status: 'error' as const, message: '未找到目标。' }
      return { status: 'applied' as const, applied: result.applied, live: result.live }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_scan',
    description: '扫描当前工作区的文件并刷新项目地图（filemap）：规则化标注角色、按 hash 失效陈旧条目。'
      + '之后 memory_recall 能回答"这个文件干什么"。等价于 /memory scan。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['scanned', 'error'], required: true },
          scanned: { type: 'integer' },
          added: { type: 'integer' },
          stale: { type: 'integer' },
          total: { type: 'integer' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as { status: string; scanned?: number; added?: number; stale?: number; total?: number; message?: string }
        if (v.status === 'scanned') {
          return [{ type: 'text', text: `扫描 ${v.scanned} 个文件：新增 ${v.added}，失效/更新 ${v.stale}，当前共 ${v.total} 条。` }]
        }
        return [{ type: 'text', text: v.message ?? '扫描失败。' }]
      },
    },
    async execute(_args: Record<string, never>, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (!cwd) return { status: 'error' as const, message: '无法确定当前工作区。' }
      try {
        const { scanWorkspace, filemapEntries } = await import('./filemap.ts')
        const result = await scanWorkspace(store, cwd)
        const total = filemapEntries(store, workspaceKeyOf(cwd)).length
        return { status: 'scanned' as const, scanned: result.scanned, added: result.added, stale: result.stale, total }
      } catch (error) {
        return { status: 'error' as const, message: `扫描失败：${String(error).slice(0, 200)}` }
      }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_export',
    description: '把当前工作区的 SuperMemory 内容（激活话题集、事实记忆、未完成需求、归档梗概、项目文件地图）'
      + '导出为 Markdown 文件（写入工作区根目录的 .supermemory-export.md），供 git 共享。等价于 /memory export。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['exported', 'error'], required: true },
          path: { type: 'string' },
          memories: { type: 'integer' },
          requirements: { type: 'integer' },
          files: { type: 'integer' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as { status: string; path?: string; message?: string }
        return [{ type: 'text', text: v.status === 'exported' ? `已导出到 ${v.path}` : (v.message ?? '导出失败。') }]
      },
    },
    async execute(_args: Record<string, never>, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (!cwd) return { status: 'error' as const, message: '无法确定当前工作区。' }
      try {
        const { writeFileSync } = await import('node:fs')
        const { buildExport } = await import('./export.ts')
        const workspaceKey = workspaceKeyOf(cwd)
        const activeTopicSetId = store.routing.get(String(exec.agent?.id ?? ''))?.activeTopicSetId
        const result = buildExport(store, workspaceKey, activeTopicSetId)
        const target = `${cwd.replace(/[\\/]+$/, '')}/.supermemory-export.md`
        writeFileSync(target, result.text, 'utf8')
        return { status: 'exported' as const, path: target, memories: result.memories, requirements: result.requirements, files: result.files }
      } catch (error) {
        return { status: 'error' as const, message: `导出失败：${String(error).slice(0, 200)}` }
      }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_ui',
    description: '打开 SuperMemory 可视化管理台（Plan A）：返回当前可用的管理台 URL（含一次性令牌）。'
      + '用户要求「可视化管理记忆 / 打开记忆面板 / 记忆管理台」时调用本工具，并把返回的 URL 原样作为 Markdown 链接交付；'
      + '管理台未启用时不要反复重试，退回 /memory 命令族即可。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ready', 'unavailable'], required: true },
          url: { type: 'string' },
          port: { type: 'integer' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as { status: string; url?: string; message?: string }
        return [{ type: 'text', text: v.status === 'ready' ? `记忆管理台：${v.url}` : (v.message ?? '管理台不可用。') }]
      },
    },
    async execute(_args: Record<string, never>, exec: ToolExec) {
      const { getWebui } = await import('./webui.ts')
      const webui = getWebui()
      if (!webui?.enabled) {
        return {
          status: 'unavailable' as const,
          message: '管理台未启用（ui.enabled=false）。可用 /memory 命令族替代。',
        }
      }
      const cwd = exec.agent?.session?.header?.cwd
      const sessionId = String(exec.agent?.id ?? '') || undefined
      return {
        status: 'ready' as const,
        url: webui.url(sessionId, cwd ? workspaceKeyOf(cwd) : undefined),
        port: webui.port,
      }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_toolize',
    description: '工具化（P3）：列出待处理的组合工具提议（重复流程达阈值后产生），或接受/拒绝某个提议。'
      + '接受会把记录到的工具序列编译成组合工具（一次调用完成确定性子序列）并持久化，重启后仍可用。',
    parameters: {
      accept: { type: 'boolean', description: '接受第一个待处理提议并生成组合工具' },
      decline: { type: 'boolean', description: '拒绝（不再提示）第一个待处理提议' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['listed', 'accepted', 'declined', 'none', 'error'], required: true },
          pending: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pattern: { type: 'string', required: true },
                count: { type: 'integer', required: true },
              },
              additionalProperties: false,
            },
          },
          tool: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as { status: string; pending?: Array<{ pattern: string; count: number }>; tool?: string; message?: string }
        if (v.status === 'listed') {
          const list = (v.pending ?? []).map((p) => `- ${p.pattern}（${p.count} 次）`).join('\n')
          return [{ type: 'text', text: list ? `待处理提议：\n${list}` : '（没有待处理的工具化提议）' }]
        }
        if (v.status === 'accepted') return [{ type: 'text', text: `已固化为组合工具 ${v.tool}。` }]
        if (v.status === 'declined') return [{ type: 'text', text: '已拒绝该提议。' }]
        if (v.status === 'none') return [{ type: 'text', text: '（没有待处理的工具化提议）' }]
        return [{ type: 'text', text: v.message ?? '操作失败。' }]
      },
    },
    async execute(args: { accept?: boolean; decline?: boolean }) {
      const pending: Array<[string, Signal]> = []
      for (const [key, signal] of store.signals.entries()) {
        if (signal.proposalStatus === 'pending' && signal.proposedAt !== undefined) pending.push([key, signal])
      }
      if (!args.accept && !args.decline) {
        return {
          status: 'listed' as const,
          pending: pending.map(([, s]) => ({ pattern: s.pattern, count: s.count })),
        }
      }
      if (pending.length === 0) return { status: 'none' as const }
      const [key, signal] = pending[0]
      if (args.decline) {
        await store.signals.update(key, (r) => ({ ...r, proposalStatus: 'declined' }))
        return { status: 'declined' as const }
      }
      try {
        const { compileComposite, registerComposite, persistComposite } = await import('./composite.ts')
        const samples = (signal.samples ?? []).map((raw) => {
          try {
            return JSON.parse(raw) as { tools: string[]; args: Array<Record<string, unknown>> }
          } catch {
            return undefined
          }
        }).filter((s): s is { tools: string[]; args: Array<Record<string, unknown>> } => s !== undefined)
        const spec = compileComposite(signal, samples)
        await registerComposite(ctx, store, spec)
        await persistComposite(store, spec, key)
        await store.signals.update(key, (r) => ({ ...r, proposalStatus: 'accepted' }))
        deps.logger.info(`supermemory: composite tool ${spec.name} registered via memory_toolize`)
        return { status: 'accepted' as const, tool: spec.name }
      } catch (error) {
        return { status: 'error' as const, message: `生成失败：${String(error).slice(0, 200)}` }
      }
    },
  })))

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Keywords for a tool-written memory (same rules as extraction). */
function keywordsOfText(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_+#.\-]{2,}/g)) tokens.push(m[0])
  const chars = text.match(/[\u4e00-\u9fff]/g) ?? []
  for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1])
  return [...new Set(tokens)].slice(0, 24)
}
