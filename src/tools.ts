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
import { matchTopicSets, recallMemories, type RecallOptions } from './recall.ts'
import { TITLE_MAX, assessConclusion, deriveTitle, mergeTags, normalizeTags, renderRecordLine, tagsOfBody } from './retrieval.ts'
import { fillTopicShapeOnCreate, noteTopicSetActivated } from './topic-shape.ts'
import type { Episode, FileMapEntry, Memory, Requirement, Signal } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import { createTopicSet, listTopicSets, setRouting, topicSetIdsOf } from './topicsets.ts'
import { questionsForHub, raiseQuestion, renderQuestionList, resolveQuestions } from './questions.ts'

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
  groupId?: string
  topicSetId?: string
  message?: string
  branches?: Array<{ branchSessionId?: string; task: string; status: 'dispatched' | 'error' }>
}

/** Attach all tools; returns the effect disposer. */
export async function attachTools(ctx: Context, deps: ToolsDeps, config: ToolsConfig): Promise<() => void> {
  const { store } = deps
  const tools = await loadHostModule('@deepseek-ai/dsh-tools') as typeof Tools
  const disposers: Array<() => void> = []

  if (config.rememberEnabled) {
    disposers.push(ctx.tools.register(tools.defineTool({
      name: 'memory_remember',
      description: '将一条【结论性】事实记忆写入 SuperMemory：跨会话持久、按工作区隔离。只记结论——可复用的事实、决策、约定、构建命令、文件用途；'
        + '禁止记录过程流水账（先做了什么、执行了哪些命令、第几步、工具调用日志、大段输出），这些留在会话里。'
        + '必须同时给出 title + tags + 正文：标题是一句可扫读的结论（≤48 字），标签是 3–8 个短词（检索索引），正文自包含。'
        + '过长（>1500 字）或明显是步骤/命令日志的内容会被拒绝，请先改写成结论。'
        + '同一 key 已存不同文本时返回冲突提示（不覆盖），由你向用户裁决。',
      parameters: {
        text: { type: 'string', required: true, description: '结论正文（自包含、可复用的事实/决策；不要过程流水账）' },
        key: { type: 'string', description: '可选稳定键；同一事实更新时传相同 key' },
        title: { type: 'string', required: true, description: '结论标题（≤48 字）：一句可扫读的话，检索时权重最高' },
        tags: {
          type: 'array',
          required: true,
          description: '标签（3–8 个短词）：检索索引，与正文分离',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['stored', 'updated', 'conflict', 'duplicate'], required: true },
            memoryId: { type: 'string' },
            title: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
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
      async execute(args: { text: string; key?: string; title?: string; tags?: string[] | string }, exec: ToolExec) {
        const cwd = exec.agent?.session?.header?.cwd
        if (!cwd) return { status: 'conflict' as const, message: '无法确定当前工作区（agent 会话缺少 cwd），已拒绝写入。' }
        const workspaceKey = workspaceKeyOf(cwd)
        const text = String(args.text ?? '').trim()
        if (!text) return { status: 'conflict' as const, message: 'text 不能为空。' }
        // R19 需求⑧: the write path enforces "结论, not transcript" even when a
        // model ignores the description — overlength / step logs are refused
        // with an actionable message instead of polluting recall.
        const verdict = assessConclusion(text)
        if (!verdict.ok) return { status: 'conflict' as const, message: verdict.message }
        const key = args.key?.trim() || undefined
        const title = String(args.title ?? '').trim().slice(0, TITLE_MAX) || deriveTitle(text)
        const tags = mergeTags(normalizeTags(args.tags), tagsOfBody(text))
        if (!title) return { status: 'conflict' as const, message: '标题不能为空：请给出一句可扫读的结论标题。' }
        if (tags.length === 0) return { status: 'conflict' as const, message: '至少需要 1 个标签（3–8 个短词）作为检索索引。' }
        const now = Date.now()

        if (key) {
          for (const [memoryId, record] of store.memories.entries()) {
            if (record.workspaceKey !== workspaceKey || record.status !== 'active' || record.key !== key) continue
            if (record.text.trim().toLowerCase() === text.toLowerCase()) {
              return {
                status: 'duplicate' as const,
                memoryId,
                title: record.title,
                tags: record.keywords,
                message: '该 key 已存相同内容，未重复写入。',
              }
            }
            return {
              status: 'conflict' as const,
              memoryId,
              title: record.title,
              tags: record.keywords,
              message: `key「${key}」已存不同内容：「${renderRecordLine({ title: record.title, text: record.text, tags: record.keywords })}」。请与用户裁决后再写入。`,
              conflict: { memoryId, text: record.text },
            }
          }
        }
        for (const [memoryId, record] of store.memories.entries()) {
          if (record.workspaceKey === workspaceKey && record.status === 'active'
            && record.text.trim().toLowerCase() === text.toLowerCase()) {
            return {
              status: 'duplicate' as const,
              memoryId,
              title: record.title,
              tags: record.keywords,
              message: '相同记忆已存在，未重复写入。',
            }
          }
        }
        const memoryId = newId('mem')
        const memory: Memory = {
          workspaceKey, title, text, key,
          keywords: tags,
          sourceSessionId: String((exec.agent as { id?: string } | undefined)?.id ?? 'tool'),
          sourceSeq: 0,
          status: 'active', createdAt: now, updatedAt: now,
        }
        await store.memories.put(memoryId, memory)
        return {
          status: 'stored' as const, memoryId, title, tags,
          message: `已记住：${renderRecordLine({ title, text, tags })}`,
        }
      },
    })))
  }

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_recall',
    description: '检索 SuperMemory：结论性事实记忆（memories）、归档梗概（episodes）、需求（requirements）与项目文件地图（filemap），按当前工作区隔离，'
      + '关键词 + 时间衰减规则评分。回答"之前说过什么/做过什么"类问题前先用本工具检索；记忆只存结论，不是过程日志。'
      + '返回的 topicSets 是命中的话题集（结论属于哪个集），命中时优先直接回答或把任务派发到该集，不要重复检索。',
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
                title: { type: 'string', description: '标题：检索命中的索引字段，优先阅读' },
                tags: { type: 'array', items: { type: 'string' }, description: '标签' },
                text: { type: 'string', required: true, description: '正文' },
                score: { type: 'number', required: true },
                createdAt: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          total: { type: 'integer', required: true },
          // R19 需求⑧: which topic set the matched conclusions belong to, so the
          // hub can answer from / dispatch to the right set immediately.
          topicSets: {
            type: 'array',
            description: '命中的话题集（按匹配分排序）：命中记忆时优先用该集',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number', required: true },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const items = (value as { items?: Array<{ title?: string; text: string; tags?: string[] }> }).items ?? []
        const topicSets = (value as { topicSets?: Array<{ title: string }> }).topicSets ?? []
        const hint = topicSets.length > 0 ? `\n相关话题集：${topicSets.map((topicSet) => topicSet.title).join('、')}` : ''
        if (items.length === 0) return [{ type: 'text', text: `（未检索到相关记忆）${hint}` }]
        return [{
          type: 'text',
          text: items.map((item, i) => `${i + 1}. ${renderRecordLine({ title: item.title, text: item.text, tags: item.tags })}`).join('\n') + hint,
        }]
      },
    },
    async execute(args: { query: string; limit?: number }, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (!cwd) return { items: [], total: 0, topicSets: [] }
      const workspaceKey = workspaceKeyOf(cwd)
      const query = String(args.query ?? '').trim()
      if (!query) return { items: [], total: 0, topicSets: [] }
      const options: RecallOptions = {
        limit: Math.max(1, Math.min(20, Number(args.limit) || config.recall.maxItems)),
        minScore: config.recall.minScore,
        halfLifeDays: config.recall.halfLifeDays,
        now: Date.now(),
      }
      const items: Array<{
        kind: 'memory' | 'episode' | 'requirement' | 'file'
        id: string
        title: string
        tags: string[]
        text: string
        score: number
        createdAt: number
      }> = []
      const memories: Array<[string, Memory]> = []
      for (const entry of store.memories.entries()) {
        if (entry[1].workspaceKey === workspaceKey && entry[1].status === 'active') memories.push(entry)
      }
      for (const item of recallMemories(memories, query, options)) {
        items.push({
          kind: 'memory', id: item.memoryId, title: item.title, tags: item.keywords,
          text: item.text, score: item.score, createdAt: item.createdAt,
        })
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
          workspaceKey: '', title: '', text: episode.summary, keywords: [], sourceSessionId: episode.sourceSessionId,
          sourceSeq: episode.sourceSeqStart, status: 'active' as const, createdAt: episode.timeStart, updatedAt: episode.timeEnd,
        }]),
        query, options,
      )) {
        items.push({ kind: 'episode', id: item.memoryId, title: item.title, tags: item.keywords, text: item.text, score: item.score, createdAt: item.createdAt })
      }
      const requirements: Array<[string, Requirement]> = []
      for (const entry of store.requirements.entries()) {
        if (entry[1].workspaceKey === workspaceKey && entry[1].status === 'open') requirements.push(entry)
      }
      for (const item of recallMemories(
        requirements.map(([id, req]) => [id, {
          workspaceKey: req.workspaceKey, title: '', text: req.text, keywords: req.constraints, sourceSessionId: req.sourceSessionId,
          sourceSeq: req.sourceSeq, status: 'active' as const, createdAt: req.createdAt, updatedAt: req.createdAt,
        }]),
        query, options,
      )) {
        items.push({ kind: 'requirement', id: item.memoryId, title: item.title, tags: item.keywords, text: item.text, score: item.score, createdAt: item.createdAt })
      }
      // P2: the project file map answers "这个文件干什么".
      const filemap: Array<[string, FileMapEntry]> = []
      for (const entry of store.filemap.entries()) {
        if (entry[1].workspaceKey === workspaceKey) filemap.push(entry)
      }
      for (const item of recallMemories(
        filemap.map(([key, entry]) => [key, {
          workspaceKey: entry.workspaceKey,
          title: entry.path,
          text: `${entry.role ? entry.role + '：' : ''}${entry.summary}`.trim() || entry.path,
          keywords: entry.keywords,
          sourceSessionId: '', sourceSeq: 0, status: 'active' as const, createdAt: entry.annotatedAt, updatedAt: entry.annotatedAt,
        }]),
        query, options,
      )) {
        items.push({ kind: 'file', id: item.memoryId, title: item.title, tags: item.keywords, text: item.text, score: item.score, createdAt: item.createdAt })
      }
      items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      // R19 需求⑧: rank the workspace's topic sets by the same query so a
      // remembered conclusion points at the set it came from.
      const topicSets = matchTopicSets(listTopicSets(store, workspaceKey), query, 3)
      return { items: items.slice(0, options.limit), total: items.length, topicSets }
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
                tags: { type: 'array', items: { type: 'string' }, description: '标签（keywords）' },
                summary: { type: 'string', required: true, description: '正文/梗概' },
                sessions: { type: 'integer', required: true, description: '该话题集下的会话数' },
                branches: { type: 'integer', required: true, description: '同 sessions（兼容字段）' },
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
        const items = (value as {
          items?: Array<{ title: string; tags?: string[]; summary: string; sessions?: number; branches?: number; model?: string }>
        }).items ?? []
        if (items.length === 0) return [{ type: 'text', text: '（当前工作区暂无话题集）' }]
        return [{
          type: 'text',
          text: items.map((i) => {
            const count = i.sessions ?? i.branches ?? 0
            const tags = i.tags && i.tags.length > 0 ? ` ｜标签: ${i.tags.join('、')}` : ''
            return `- 【${i.title}】${count} 个会话${i.model ? ' · ' + i.model : ''}${tags}${i.summary ? '：' + i.summary.slice(0, 80) : ''}`
          }).join('\n'),
        }]
      },
    },
    async execute(args: { topicSetId?: string }, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (!cwd) return { items: [], total: 0 }
      const workspaceKey = workspaceKeyOf(cwd)
      const toItem = (id: string, topicSet: {
        title: string
        summary: string
        keywords: string[]
        members: unknown[]
        defaultModel?: { provider: string; model: string }
      }) => ({
        id,
        title: topicSet.title,
        tags: topicSet.keywords,
        summary: topicSet.summary,
        sessions: topicSet.members.length,
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
      + '必须同时给出 title + tags + summary，不要只给标题：标题是一句可扫读的话，标签是 3–8 个检索短词，'
      + '正文说明这个话题集到底要做什么。显式开新话题时使用；不确定时先 memory_topicsets 查看已有话题集。',
    parameters: {
      title: { type: 'string', required: true, description: '话题集标题（简短）' },
      tags: {
        type: 'array',
        description: '标签（3–8 个短词）：检索索引，必填建议；缺省会用标题/摘要派生',
        items: { type: 'string' },
      },
      summary: { type: 'string', description: '正文/梗概（≤500 字）：这个话题集到底要做什么，必填建议' },
      askModel: { type: 'boolean', description: '是否询问默认模型；默认询问' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['created', 'error'], required: true },
          topicSetId: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          model: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as { status: string; title?: string; tags?: string[]; model?: string; message?: string }
        if (v.status === 'created') {
          return [{ type: 'text', text: `已创建并激活话题集『${v.title ?? ''}』${v.tags && v.tags.length > 0 ? '（标签：' + v.tags.join('、') + '）' : ''}${v.model ? '（默认模型 ' + v.model + '）' : ''}` }]
        }
        return [{ type: 'text', text: v.message ?? '创建失败。' }]
      },
    },
    async execute(args: { title: string; tags?: string[] | string; summary?: string; askModel?: boolean }, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      const sessionId = String(exec.agent?.id ?? '')
      if (!cwd || !sessionId) return { status: 'error' as const, message: '无法确定当前会话。' }
      const workspaceKey = workspaceKeyOf(cwd)
      let model
      if (args.askModel !== false) {
        model = await askDefaultModel(deps.model, exec.agent)
      }
      const title = String(args.title ?? '').slice(0, 40)
      if (!title.trim()) return { status: 'error' as const, message: '标题不能为空。' }
      // R18: the three layers are always written. A model that forgot tags gets
      // the title/body vocabulary as a fallback, never an empty index.
      const tags = mergeTags(normalizeTags(args.tags), tagsOfBody(`${title} ${args.summary ?? ''}`))
      const topicSetId = await createTopicSet(store, {
        workspaceKey,
        title,
        keywords: tags,
        summary: String(args.summary ?? '').slice(0, 500),
        ...(model ? { defaultModel: model } : {}),
      })
      await setRouting(store, sessionId, { activeTopicSetId: topicSetId, driftCount: 0 })
      // R19 需求⑥: only a caller that supplied no tags AND no body needs the
      // model fallback (the tool contract asks for both, so this is a degraded
      // path, not the normal one — no extra token burn on a well-formed call).
      const explicitTags = normalizeTags(args.tags)
      if (explicitTags.length === 0 || !String(args.summary ?? '').trim()) {
        try {
          await fillTopicShapeOnCreate(
            { ctx: deps.ctx, store, logger: deps.logger },
            topicSetId,
            '',
            { tags: explicitTags.length === 0, summary: !String(args.summary ?? '').trim() },
          )
        } catch (error) {
          deps.logger.warn('supermemory: topic-set shape generation skipped: ' + String(error).slice(0, 160))
        }
      }
      noteTopicSetActivated({ ctx: deps.ctx, store, logger: deps.logger }, topicSetId)
      const stored = store.topicsets.get(topicSetId)
      return {
        status: 'created' as const,
        topicSetId,
        title: stored?.title ?? title,
        tags: stored?.keywords ?? tags,
        ...(model ? { model: `${model.provider}/${model.model}` } : {}),
      }
    },
  })))

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_dispatch',
    description: '把实质工作异步派发到话题集的分支会话（在全新对话中执行，不在主对话框直接完成操作）：插件先落账，随即唤醒分支并立即返回回执，'
      + '本会话（中枢）不阻塞。分支完成后结果会以 relay 形式主动送回本会话。'
      + '中枢只做判断、派发与汇总：不要自己读改文件/跑命令，把操作交给分支。'
      + '简单问答不要派发——上下文卡/recall 能答的中枢直接答。'
      + '需求多或复杂时用 tasks[] 拆成多个分支并行协同：每个任务一个独立分支，全部到达终态后只回送一次汇总，失败成员单独标注；'
      + '并行组里的任务必须自包含、互不依赖，不要把一个可拆分的大任务塞进单个分支串行做。'
      + 'mode 语义：auto（默认）复用空闲的匹配分支、否则新建，绝不在忙碌分支里合并另一个任务；'
      + 'continue 显式续派同一条分支（忙则排队，用于同一任务的后续）；fork 从父分支最近已完成轮次开新分支；new 强制新建。'
      + '分支归属话题集、可被同一话题集下的多个中枢复用/共享（不按中枢隔离）；不要为同一件工作反复新建分支造成重复或分裂。'
      + 'capabilities 在派发前设定分支的能力边界（写进分支首条消息并尽量用 tools.restrict 落实）：'
      + 'full=与中枢一致（可读写文件 + 跑命令，改代码/构建/验证时用）；'
      + 'read-write=可读改文件但不能跑命令（默认，纯代码编辑/审阅改动用）；'
      + 'read=只读审阅（不能写文件、不能跑命令，只做分析/评审）；'
      + 'minimal=最小（只读文件 + memory_* / send_message / wait_agent，做汇总或轻量核对）。'
      + '派发前先想清楚是否需要改代码/跑命令，不要一律用 full。'
      + '分支遇到需要用户裁决的问题会用 memory_raise_question 上交中枢（永不直接问用户）；'
      + '收到 relay 或用户新消息时用 memory_questions 汇总所有分支的问题，再用 ask_user_question 一次提问。',
    parameters: {
      task: { type: 'string', description: '单个任务描述（自包含）；与 tasks 二选一' },
      tasks: {
        type: 'array',
        description: '多个任务描述（2 个以上）→ 并行组，全部终态后单次汇总回送',
        items: { type: 'string' },
      },
      topicSetId: { type: 'string', description: '目标话题集；省略则用本会话当前激活的话题集' },
      mode: { type: 'string', enum: ['auto', 'continue', 'fork', 'new'], description: '分支获取方式；默认 auto' },
      capabilities: {
        type: 'string',
        enum: ['read', 'read-write', 'full', 'minimal'],
        description: '分支能力边界（默认 read-write）：full=读写+命令（改代码/构建用）；'
          + 'read-write=读写无命令（默认）；read=只读审阅；minimal=只读+记忆/汇总类工具。越界由插件在分支作用域内限制。',
      },
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
          // R19 协同①: a parallel group reports every task + the branch it got,
          // so the hub can name the branches in its own summary immediately.
          branches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                branchSessionId: { type: 'string' },
                task: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as {
          status: string; branchSessionId?: string; groupId?: string; message?: string
          branches?: Array<{ branchSessionId?: string; task: string; status: string }>
        }
        if (v.status === 'dispatched') {
          const lines = [v.message ?? `已派发到分支 ${v.branchSessionId}；完成后结果会主动送回本会话。`]
          if (v.branches && v.branches.length > 0) {
            lines.push('分支清单：')
            v.branches.forEach((row, index) => {
              lines.push(`${index + 1}. ${row.status === 'dispatched' ? '✅' : '❌'} ${row.task.slice(0, 40)}`
                + `${row.branchSessionId ? ` → ${row.branchSessionId}` : ''}`)
            })
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        return [{ type: 'text', text: v.message ?? '派发失败。' }]
      },
    },
    async execute(
      args: {
        task?: string
        tasks?: string[]
        topicSetId?: string
        mode?: 'auto' | 'continue' | 'fork' | 'new'
        capabilities?: 'read' | 'read-write' | 'full' | 'minimal'
      },
      exec: ToolExec,
    ): Promise<DispatchResult> {
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

  // R20: the branch-side question channel. A branch records the question and
  // keeps working; only the HUB ever talks to the user, aggregating every
  // branch's questions into one ask_user_question.
  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_raise_question',
    description: '【仅分支会话使用】把需要用户裁决的问题结构化上交中枢，由中枢汇总所有分支的问题后统一向用户提问。'
      + '分支不要直接向用户提问、也不要因为提问而卡住不干活：非阻塞问题（blocking=false，默认）上交后继续按最合理解释推进并完成实质工作，'
      + '把做出的假设写进最终汇报；只有真正阻断、非用户裁决无法继续时才 blocking=true，并同时给出 progress（已完成进度）与 defaultPlan（默认备选方案）。'
      + '中枢不要调用本工具——中枢需要用户裁决时直接用 ask_user_question。',
    parameters: {
      title: { type: 'string', required: true, description: '问题标题（≤80 字）：一句可扫读的话' },
      question: { type: 'string', required: true, description: '要用户裁决的具体问题（写清背景与取舍）' },
      options: { type: 'array', items: { type: 'string' }, description: '可选：给用户的候选答案（每个一句）' },
      severity: { type: 'string', enum: ['low', 'medium', 'high'], description: '可选：严重度，默认 medium' },
      blocking: { type: 'boolean', description: '是否阻塞：true=非用户裁决无法继续（应同时给 progress 与 defaultPlan）；默认 false' },
      progress: { type: 'string', description: '可选：已完成的进度（阻塞时必填，便于中枢向用户说明代价）' },
      defaultPlan: { type: 'string', description: '可选：用户不裁决时分支将采用的默认备选方案（阻塞时必填）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['recorded', 'error'], required: true },
          questionId: { type: 'string' },
          dispatchId: { type: 'string' },
          blocking: { type: 'boolean' },
          message: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String((value as { message?: string }).message ?? '') }],
    },
    async execute(
      args: {
        title: string
        question: string
        options?: string[]
        severity?: 'low' | 'medium' | 'high'
        blocking?: boolean
        progress?: string
        defaultPlan?: string
      },
      exec: ToolExec,
    ) {
      const sessionId = String(exec.agent?.id ?? '')
      if (!sessionId) return { status: 'error' as const, message: '无法确定当前会话。' }
      try {
        return await raiseQuestion(store, sessionId, args)
      } catch (error) {
        deps.logger.warn(`supermemory: memory_raise_question threw: ${String(error).slice(0, 200)}`)
        return { status: 'error' as const, message: `上交失败：${String(error).slice(0, 200)}` }
      }
    },
  })))

  // R20: the hub-side aggregation view over the same table. Listing and
  // resolving live in one tool so a hub can ask once, record the answer and
  // keep the queue clean without a second round trip.
  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_questions',
    description: '【中枢汇总用】列出 / 结清分支通过 memory_raise_question 上交的问题：含来源分支、是否阻塞、已完成进度与默认备选方案。'
      + '收到 relay 或用户新消息时先调用本工具，把各分支的问题去重、按主题合并成一份清单，再用 ask_user_question 一次向用户提问；'
      + '非阻塞问题且分支已按最合理解释完成时不必提问，在汇报里列出假设即可。'
      + '用户答复后用 resolve 传入问题 id 结清（可带 answer），再用 memory_dispatch 把裁决派回对应分支。',
    parameters: {
      status: { type: 'string', enum: ['open', 'resolved', 'all'], description: '要列出的话题状态；默认 open（待处理）' },
      resolve: { type: 'array', items: { type: 'string' }, description: '可选：已向用户提问/已裁决的问题 id，传入即标记 resolved' },
      answer: { type: 'string', description: '可选：用户答复原文，随 resolve 一起记录' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['listed', 'resolved', 'error'], required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                dispatchId: { type: 'string' },
                topicSetId: { type: 'string' },
                branchSessionId: { type: 'string', required: true },
                branchTask: { type: 'string' },
                title: { type: 'string', required: true },
                question: { type: 'string', required: true },
                options: { type: 'array', items: { type: 'string' } },
                severity: { type: 'string' },
                blocking: { type: 'boolean', required: true },
                progress: { type: 'string' },
                defaultPlan: { type: 'string' },
                status: { type: 'string', required: true },
                createdAt: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          total: { type: 'integer', required: true },
          blocking: { type: 'integer', required: true },
          resolved: { type: 'integer' },
          message: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String((value as { message?: string }).message ?? '') }],
    },
    async execute(
      args: { status?: 'open' | 'resolved' | 'all'; resolve?: string[]; answer?: string },
      exec: ToolExec,
    ) {
      const cwd = exec.agent?.session?.header?.cwd
      const sessionId = String(exec.agent?.id ?? '')
      if (!cwd) {
        return { status: 'error' as const, items: [], total: 0, blocking: 0, resolved: 0, message: '无法确定当前工作区。' }
      }
      const workspaceKey = workspaceKeyOf(cwd)
      const wanted = args.status === 'resolved' || args.status === 'all' ? args.status : 'open'
      const resolveIds = (args.resolve ?? []).map((id) => String(id ?? '').trim()).filter(Boolean)
      let resolved = 0
      if (resolveIds.length > 0) {
        // Only questions this hub can actually see may be closed: an untrusted
        // id must never resolve another workspace's question.
        const visible = new Set(
          questionsForHub(store, workspaceKey, sessionId || undefined, 'open').map((row) => row.id),
        )
        resolved = await resolveQuestions(store, resolveIds.filter((id) => visible.has(id)), args.answer)
      }
      const rows = questionsForHub(store, workspaceKey, sessionId || undefined, wanted)
      const items = rows.map(({ id, question }) => ({
        id,
        ...(question.dispatchId ? { dispatchId: question.dispatchId } : {}),
        ...(question.topicSetId ? { topicSetId: question.topicSetId } : {}),
        branchSessionId: question.branchSessionId,
        ...(question.branchTask ? { branchTask: question.branchTask } : {}),
        title: question.title,
        question: question.question,
        ...(question.options.length > 0 ? { options: question.options } : {}),
        severity: question.severity,
        blocking: question.blocking,
        ...(question.progress ? { progress: question.progress } : {}),
        ...(question.defaultPlan ? { defaultPlan: question.defaultPlan } : {}),
        status: question.status,
        createdAt: question.createdAt,
      }))
      const listText = renderQuestionList(rows)
      const message = resolved > 0 ? `已标记 ${resolved} 个问题为已解决。

${listText}` : listText
      return {
        status: resolveIds.length > 0 ? 'resolved' as const : 'listed' as const,
        items,
        total: rows.length,
        blocking: rows.filter((row) => row.question.blocking).length,
        resolved,
        message,
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

