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
import { listInterruptedDispatches, renderInterruptedList, resumeDispatch, type ResumeDeps, type ResumeResult } from './resume.ts'
import { loadHostModule } from './host.ts'
import { applyModelSelection, askDefaultModel, enumerateModels, type ModelDeps } from './model.ts'
import { matchTopicSets, recallMemories, type RecallOptions } from './recall.ts'
import {
  collectionTierNote, findMemoryConflict, listCollections, migrateFlatMemories, recallEntriesWithCollections,
  resolveCollectionForEntry, touchCollection,
  type CollectionAssignment, type MemoryConflictFinding,
} from './memory-collections.ts'
// R27 需求④.2: 一条写入整形为 1..N 条原子记忆（无模型时保持 1 条）。
import { splitMemoryEntries } from './memory-split.ts'
import { CAPABILITY_ROUTING_RULES } from './route.ts'
import { TITLE_MAX, assessConclusion, deriveTitle, mergeTags, normalizeTags, renderRecordLine, tagsOfBody } from './retrieval.ts'
import { fillTopicShapeOnCreate, noteTopicSetActivated } from './topic-shape.ts'
import type { Episode, FileMapEntry, Memory, Requirement, Signal } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import { createTopicSet, listTopicSets, setRouting, topicSetIdsOf } from './topicsets.ts'
import { TOPIC_SET_TITLE_MAX_CHARS, clipEllipsis } from './title.ts'
import { questionsForHub, raiseQuestion, renderQuestionList, resolveQuestions } from './questions.ts'
import { RESUME_NEXT_ACTION } from './round-end.ts'

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
  status: 'dispatched' | 'error' | 'need-confirm'
  dispatchId?: string
  branchSessionId?: string
  groupId?: string
  topicSetId?: string
  message?: string
  /** R24: 收口提示（与 dispatch.ts 的回执同源）。 */
  nextAction?: string
  /** R23: need-confirm 负载（与 dispatch.ts 同源）：候选话题集与判定理由。 */
  candidates?: Array<{ id: string; title: string; score: number }>
  reason?: string
  branches?: Array<{ branchSessionId?: string; task: string; status: 'dispatched' | 'error' | 'need-confirm' }>
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
        + '记忆按「记忆集合 + 条目」组织：集合归属由大模型在候选集合中判定（加到某个已有集合，还是新建一个；无模型时退化为标题/标签/正文相似度匹配，'
        + '高/中相似直接复用该集合并追加条目，低相似才新建集合）；可用 collection 指定集合标题、collectionId 指定集合 id。'
        + '一条写入若含多个事实，会先被整形为多条原子记忆（每条独立标题/标签/正文，最多 5 条，回执的 entries 逐条说明归入哪个集合）。'
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
        // R22 需求⑤: 相关集合优先复用；显式指定用于模型已经知道该写哪一集的情况。
        collection: { type: 'string', description: '可选：目标记忆集合标题（同名/相似集合会被复用，否则以该标题新建）' },
        collectionId: { type: 'string', description: '可选：目标记忆集合 id（必须已存在）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['stored', 'updated', 'conflict', 'duplicate'], required: true },
            memoryId: { type: 'string' },
            title: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            // R22 需求④⑤: which memory collection the entry landed in, and how.
            collectionId: { type: 'string', description: '所属记忆集合 id' },
            collectionTitle: { type: 'string', description: '所属记忆集合标题' },
            collectionTier: {
              type: 'string',
              enum: ['high', 'medium', 'low', 'explicit', 'llm'],
              description: '复用档位：high/medium=命中已有集合，llm=模型判定，low=新建集合，explicit=调用方指定',
            },
            collectionCreated: { type: 'boolean', description: '本次是否新建了集合' },
            // R27 需求④.2: 一条写入可被整形为多条原子记忆；entries 逐条回执。
            split: { type: 'integer', description: '本次写入被拆分为几条原子记忆（1=未拆分）' },
            entries: {
              type: 'array',
              description: '逐条原子记忆的写入结果（各自的内存 id/标题/标签/所属集合）',
              items: {
                type: 'object',
                properties: {
                  memoryId: { type: 'string' },
                  title: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  collectionId: { type: 'string', description: '所属记忆集合 id' },
                  collectionTitle: { type: 'string', description: '所属记忆集合标题' },
                  collectionTier: {
                    type: 'string',
                    enum: ['high', 'medium', 'low', 'explicit', 'llm'],
                    description: '复用档位：high/medium=命中已有集合，llm=模型判定，low=新建集合，explicit=调用方指定',
                  },
                },
                additionalProperties: false,
              },
            },
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
      async execute(args: { text: string; key?: string; title?: string; tags?: string[] | string; collection?: string; collectionId?: string }, exec: ToolExec) {
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

        // R22 需求④: assign legacy flat records to collections before deciding
        // where this entry goes — a reused collection must include the entries
        // that already exist for the same tags/title.
        await migrateFlatMemories(store, workspaceKey, now)

        // R27 需求④.2: 一条写入先「整形」为 1..N 条原子记忆。有模型时才调用
        // （一次；无模型/预判不通过/失败都保持 1 条，与旧行为一致）。
        const decisionDeps = {
          ctx: deps.ctx,
          logger: deps.logger,
          ...(exec.agent?.id ? { sessionId: String(exec.agent.id) } : {}),
        }
        const drafts = (await splitMemoryEntries(decisionDeps, text, { title, tags })) ?? [{ title, tags, text }]
        const atomic = drafts.filter((draft) => draft.text && assessConclusion(draft.text).ok)
        const entries = atomic.length > 0 ? atomic : [{ title, tags, text }]
        const split = entries.length > 1

        const stored: Array<{
          memoryId: string
          title: string
          text: string
          tags: string[]
          assignment: CollectionAssignment
        }> = []
        const duplicates: MemoryConflictFinding[] = []
        for (const entry of entries) {
          // 同 key 判重/冲突逐条进行；拆分后每条是独立事实，调用方的单个 key
          // 无法标识 N 行，因此只按正文判重（避免第二条误判成 key 冲突）。
          const existing = findMemoryConflict(store, workspaceKey, split
            ? { text: entry.text }
            : { text: entry.text, ...(key ? { key } : {}) })
          if (existing) {
            if (existing.kind === 'conflict') {
              return {
                status: 'conflict' as const,
                memoryId: existing.memoryId,
                title: existing.title,
                tags: existing.tags,
                ...(existing.collectionId ? { collectionId: existing.collectionId } : {}),
                ...(existing.collectionTitle ? { collectionTitle: existing.collectionTitle } : {}),
                message: `key「${key}」已存不同内容：「${renderRecordLine({ title: existing.title, text: existing.text, tags: existing.tags })}」。请与用户裁决后再写入。`,
                conflict: { memoryId: existing.memoryId, text: existing.text },
              }
            }
            duplicates.push(existing)
            continue
          }
          const entryTags = mergeTags(entry.tags, tags)
          // R22 需求⑤ + R27 需求④.3: prefer an existing related collection over
          // opening a new one; with a model available the MODEL decides which
          // candidate to reuse (or that a new set is warranted).
          const assignment = await resolveCollectionForEntry(
            store, workspaceKey, { title: entry.title, keywords: entryTags, text: entry.text }, {
              ...(args.collectionId ? { collectionId: String(args.collectionId) } : {}),
              ...(args.collection ? { collection: String(args.collection) } : {}),
              now,
              deps: decisionDeps,
            },
          )
          if ('error' in assignment) {
            return {
              status: 'conflict' as const,
              message: assignment.error
                + (assignment.candidates && assignment.candidates.length > 0
                  ? `候选集合：${assignment.candidates.map((c) => `「${c.title}」(${c.collectionId})`).join('、')}`
                  : ''),
            }
          }
          const memoryId = newId('mem')
          const memory: Memory = {
            workspaceKey, title: entry.title, text: entry.text,
            keywords: entryTags,
            // A split write stores independent facts; the caller's single key
            // cannot identify N rows, so it is not carried over.
            ...(!split && key ? { key } : {}),
            ...(assignment.collectionId ? { collectionId: assignment.collectionId } : {}),
            sourceSessionId: String((exec.agent as { id?: string } | undefined)?.id ?? 'tool'),
            sourceSeq: 0,
            status: 'active', createdAt: now, updatedAt: now,
          }
          await store.memories.put(memoryId, memory)
          if (assignment.collectionId) await touchCollection(store, assignment.collectionId, now)
          stored.push({ memoryId, title: entry.title, text: entry.text, tags: entryTags, assignment })
        }

        if (stored.length === 0) {
          // 拆分后每条都已存在：与旧行为一致地回报 duplicate，不写任何行。
          const found = duplicates[0]
          return {
            status: 'duplicate' as const,
            memoryId: found.memoryId,
            title: found.title,
            tags: found.tags,
            ...(found.collectionId ? { collectionId: found.collectionId } : {}),
            ...(found.collectionTitle ? { collectionTitle: found.collectionTitle } : {}),
            ...(split ? { split: entries.length } : {}),
            message: (key && !split ? '该 key 已存相同内容，未重复写入。' : '相同记忆已存在，未重复写入。')
              + (!split && found.collectionTitle ? `（所属集合「${found.collectionTitle}」）` : '')
              + (split ? `（已拆分为 ${entries.length} 条，均已存在）` : ''),
          }
        }

        const first = stored[0]
        const tierNote = collectionTierNote(first.assignment)
        const lines = stored.map((row) => renderRecordLine({
          title: row.title, text: row.text, tags: row.tags, collection: row.assignment.title,
        }))
        const skipped = duplicates.length > 0 ? `\n其中 ${duplicates.length} 条已存在，未重复写入。` : ''
        const keyNote = key && split ? `\n（拆分写入未沿用 key「${key}」：每条原子记忆是独立事实）` : ''
        return {
          status: 'stored' as const,
          memoryId: first.memoryId,
          title: first.title,
          tags: first.tags,
          ...(first.assignment.collectionId ? { collectionId: first.assignment.collectionId } : {}),
          ...(first.assignment.title ? { collectionTitle: first.assignment.title } : {}),
          collectionTier: first.assignment.tier,
          collectionCreated: first.assignment.created,
          split: entries.length,
          entries: stored.map((row) => ({
            memoryId: row.memoryId,
            title: row.title,
            tags: row.tags,
            ...(row.assignment.collectionId ? { collectionId: row.assignment.collectionId } : {}),
            ...(row.assignment.title ? { collectionTitle: row.assignment.title } : {}),
            collectionTier: row.assignment.tier,
          })),
          message: split
            ? `已拆分为 ${entries.length} 条原子记忆：\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}${skipped}${keyNote}`
            : `${tierNote === null ? `已记住：${lines[0]}` : `${tierNote}：${lines[0]}`}${keyNote}`,
        }
      },
    })))
  }

  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_recall',
    description: '检索 SuperMemory：结论性事实记忆（memories）、归档梗概（episodes）、需求（requirements）与项目文件地图（filemap），按当前工作区隔离，'
      + '关键词 + 时间衰减规则评分。回答"之前说过什么/做过什么"类问题前先用本工具检索；记忆只存结论，不是过程日志。'
      + '记忆采用两级检索：先按查询匹配「记忆集合」，再在集合内精选条目（标题×4/标签×3/正文×1 + 集合级上下文），'
      + '命中的记忆条目会带上所属集合的 id/标题/标签；collections 是命中的记忆集合（按分排序）。'
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
                // R22 需求④: the memory collection this entry belongs to.
                collectionId: { type: 'string', description: '所属记忆集合 id（未归集时为空）' },
                collectionTitle: { type: 'string', description: '所属记忆集合标题' },
                collectionTags: { type: 'array', items: { type: 'string' }, description: '所属记忆集合标签' },
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
          // R22 需求④⑤: the memory collections matched by this query (stage 1).
          collections: {
            type: 'array',
            description: '命中的记忆集合（两级检索第一级，按匹配分排序）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number', required: true },
                tier: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const items = (value as { items?: Array<{ title?: string; text: string; tags?: string[]; collectionTitle?: string }> }).items ?? []
        const topicSets = (value as { topicSets?: Array<{ title: string }> }).topicSets ?? []
        const collections = (value as { collections?: Array<{ title: string }> }).collections ?? []
        const collectionHint = collections.length > 0 ? `\n相关记忆集合：${collections.map((c) => c.title).join('、')}` : ''
        const hint = (topicSets.length > 0 ? `\n相关话题集：${topicSets.map((topicSet) => topicSet.title).join('、')}` : '') + collectionHint
        if (items.length === 0) return [{ type: 'text', text: `（未检索到相关记忆）${hint}` }]
        return [{
          type: 'text',
          text: items.map((item, i) => `${i + 1}. ${renderRecordLine({ title: item.title, text: item.text, tags: item.tags, collection: item.collectionTitle })}`).join('\n') + hint,
        }]
      },
    },
    async execute(args: { query: string; limit?: number }, exec: ToolExec) {
      const cwd = exec.agent?.session?.header?.cwd
      if (!cwd) return { items: [], total: 0, topicSets: [], collections: [] }
      const workspaceKey = workspaceKeyOf(cwd)
      const query = String(args.query ?? '').trim()
      if (!query) return { items: [], total: 0, topicSets: [], collections: [] }
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
        collectionId?: string
        collectionTitle?: string
        collectionTags?: string[]
      }> = []
      // R22 需求④⑤: two-stage retrieval — legacy flat records are folded into
      // collections first, then stage 1 ranks collections and stage 2 ranks the
      // entries (direct title/tag/body score + collection-level context).
      await migrateFlatMemories(store, workspaceKey, options.now)
      const collections = listCollections(store, workspaceKey)
      const memories: Array<[string, Memory]> = []
      for (const entry of store.memories.entries()) {
        if (entry[1].workspaceKey === workspaceKey && entry[1].status === 'active') memories.push(entry)
      }
      const collectionRecall = recallEntriesWithCollections(collections, memories, query, options)
      for (const item of collectionRecall.items) {
        items.push({
          kind: 'memory', id: item.memoryId, title: item.title, tags: item.keywords,
          text: item.text, score: item.score, createdAt: item.createdAt,
          collectionId: item.collectionId,
          collectionTitle: item.collectionTitle,
          collectionTags: item.collectionTags,
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
      return {
        items: items.slice(0, options.limit),
        total: items.length,
        topicSets,
        collections: collectionRecall.collections.map((match) => ({
          id: match.collectionId, title: match.title, tags: match.keywords, score: match.score, tier: match.tier,
        })),
      }
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
      // Whole up to TOPIC_SET_TITLE_MAX_CHARS, "…" beyond (was slice(0, 40)).
      const title = clipEllipsis(String(args.title ?? '').trim(), TOPIC_SET_TITLE_MAX_CHARS)
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
      + '话题集匹配（未显式给 topicSetId 且本会话没有激活话题集时）：插件按任务与同工作区现有话题集的相似度三档处置——'
      + '高相似：直接复用该话题集（不新建，回执注明复用了哪个集）；'
      + '中等相似：不派发也不新建，返回 need-confirm 与候选列表（id/标题/分数），中枢应立即用 ask_user_question 转问用户：'
      + '复用哪个候选（用户选定后带 topicSetId 重新派发）、强制新建（forceNewTopicSet=true）还是改述任务；'
      + '低相似/无候选：才自动新建（标题=任务首行）。跨工作区的话题集绝不参与匹配。'
      + '一次性验证类任务传 kind:"verify"：归入「<工作区目录名> · 验证」话题集（优先复用已有的），不要为每次验证新建话题集。'
      + '派发前优先考虑复用已有话题集；确认必须开新话题时才用 forceNewTopicSet=true，不要人为制造碎片化。'
      + 'capabilities 在派发前设定分支的能力边界（写进分支首条消息并尽量用 tools.restrict 落实）：'
      + 'full=与中枢一致（可读写文件 + 跑命令，改代码/构建/验证时用）；'
      + 'read-write=可读改文件但不能跑命令（默认，纯代码编辑/审阅改动用）；'
      + 'read=只读审阅（不能写文件、不能跑命令，只做分析/评审）；'
      + 'minimal=最小（只读文件 + memory_* / send_message / wait_agent，做汇总或轻量核对）。'
      + '派发前先想清楚是否需要改代码/跑命令，不要一律用 full。'
      + '分支遇到需要用户裁决的问题会用 memory_raise_question 上交中枢（永不直接问用户）；'
      + '收到 relay 或用户新消息时用 memory_questions 汇总所有分支的问题，再用 ask_user_question 一次提问。'
      + 'R24 收口：本工具立即返回回执、不阻塞；拿到回执后请直接结束本轮回复——不要调用 wait_agent 等分支、不要轮询分支状态。'
      + '分支完成后 relay 会作为新消息自动送达本会话并开启新一轮对话，届时再汇总转述。',
    parameters: {
      task: { type: 'string', description: '单个任务描述（自包含）；与 tasks 二选一' },
      tasks: {
        type: 'array',
        description: '多个任务描述（2 个以上）→ 并行组，全部终态后单次汇总回送',
        items: { type: 'string' },
      },
      topicSetId: { type: 'string', description: '目标话题集；省略则用本会话当前激活的话题集' },
      forceNewTopicSet: { type: 'boolean', description: '强制新建话题集（绕过相似度匹配复用）；默认 false' },
      kind: { type: 'string', enum: ['verify'], description: '任务性质：verify=一次性验证，归入「<工作区目录名> · 验证」话题集（优先复用已有的）' },
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
          status: { type: 'string', enum: ['dispatched', 'error', 'need-confirm'], required: true },
          dispatchId: { type: 'string' },
          branchSessionId: { type: 'string' },
          groupId: { type: 'string' },
          topicSetId: { type: 'string' },
          message: { type: 'string' },
          // R23: need-confirm payload — the hub offers these to the user.
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                score: { type: 'number' },
              },
              additionalProperties: false,
            },
          },
          reason: { type: 'string' },
          // R23: the hub ends its turn on this receipt instead of polling.
          nextAction: { type: 'string' },
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
          status: string; branchSessionId?: string; groupId?: string; message?: string; nextAction?: string
          candidates?: Array<{ id?: string; title?: string; score?: number }>
          reason?: string
          branches?: Array<{ branchSessionId?: string; task: string; status: string }>
        }
        if (v.status === 'need-confirm') {
          const lines = [v.message ?? '任务与现有话题集中等相似，尚未派发，等待用户裁决。']
          if (v.candidates && v.candidates.length > 0) {
            lines.push('候选话题集：')
            v.candidates.forEach((row, index) => {
              lines.push(`${index + 1}. 『${row.title ?? ''}』（${row.id ?? ''}${row.score !== undefined ? `，分数 ${row.score}` : ''}）`)
            })
          }
          if (v.reason) lines.push('判定理由：' + v.reason)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (v.status === 'dispatched') {
          const lines = [v.message ?? `已派发到分支 ${v.branchSessionId}；完成后结果会主动送回本会话。`]
          // R24: the last line tells the hub to END this turn (relay starts the next one).
          if (v.nextAction) lines.push(v.nextAction)
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
        forceNewTopicSet?: boolean
        kind?: 'verify'
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

  // E: 中断任务续跑。插件被中断/关闭后分支会话保留（不删除），恢复后由用户
  // 决定继续哪些：无参=清单；带 dispatchIds=续跑（优先续接被保留的分支会话，
  // 会话无法恢复才带「原始任务 + 已完成部分」上下文重派发到新分支）。
  disposers.push(ctx.tools.register(tools.defineTool({
    name: 'memory_resume',
    description: '继续被中断的任务（插件重载/关闭或 DSH 退出导致；分支会话已保留，未删除）。'
      + '无参 = 返回被中断任务清单（dispatchId、话题集、任务摘要、分支会话标识、中断时间、已完成部分）；'
      + '带 dispatchIds（可多个）= 续跑指定任务：优先续接被保留的分支会话（同一会话同一日志续投「原始任务 + 已完成部分」），'
      + '会话无法恢复时才带同样上下文重派发到新分支，并用 resumeOf/resumedBy 在台账关联原 dispatchId。'
      + '已交付、仍在进行中或自主失败（max-tokens 等）的任务不会被续跑。'
      + 'R24 收口：续跑同样立即返回、不阻塞；返回后请直接结束本轮回复，不要 wait_agent 或轮询等待分支——分支完成后 relay 会自动开启新一轮对话。',
    parameters: {
      dispatchIds: {
        type: 'array',
        description: '要续跑的 dispatchId（多个）；省略 = 只返回被中断任务清单',
        items: { type: 'string' },
      },
      capabilities: {
        type: 'string',
        enum: ['read', 'read-write', 'full', 'minimal'],
        description: '续跑分支能力边界（默认 read-write，与 memory_dispatch 一致）',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['listed', 'resumed', 'partial', 'error'], required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                dispatchId: { type: 'string', required: true },
                topicSetId: { type: 'string' },
                topicSetTitle: { type: 'string' },
                task: { type: 'string', required: true },
                branchSessionId: { type: 'string', required: true },
                branchTitle: { type: 'string', required: true },
                hubSessionId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                interruptedAt: { type: 'integer', required: true },
                partial: { type: 'string' },
                groupId: { type: 'string' },
                resumeOf: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                dispatchId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                mode: { type: 'string' },
                newDispatchId: { type: 'string' },
                branchSessionId: { type: 'string' },
                message: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
          total: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          // R24: 续跑成功后同样提示结束本轮（清单查询不带）。
          nextAction: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String((value as { message?: string }).message ?? '') }],
    },
    async execute(
      args: { dispatchIds?: string[]; capabilities?: 'read' | 'read-write' | 'full' | 'minimal' },
      exec: ToolExec,
    ) {
      // The tool contract is a receipt VALUE, never a thrown exception.
      try {
        const cwd = exec.agent?.session?.header?.cwd
        if (!cwd) {
          return { status: 'error' as const, items: [], results: [], total: 0, message: '无法确定当前工作区。' }
        }
        const ids = (args.dispatchIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean)
        const resumeDeps: ResumeDeps = { ctx: deps.ctx, store, logger: deps.logger }
        if (ids.length === 0) {
          const views = listInterruptedDispatches(store, { workspaceKey: workspaceKeyOf(cwd) })
          return {
            status: 'listed' as const,
            items: views.map((view) => ({
              dispatchId: view.dispatchId,
              ...(view.topicSetId ? { topicSetId: view.topicSetId } : {}),
              ...(view.topicSetTitle ? { topicSetTitle: view.topicSetTitle } : {}),
              task: view.task,
              branchSessionId: view.branchSessionId,
              branchTitle: view.branchTitle,
              hubSessionId: view.hubSessionId,
              status: view.status,
              interruptedAt: view.interruptedAt,
              ...(view.partial ? { partial: view.partial } : {}),
              ...(view.groupId ? { groupId: view.groupId } : {}),
              ...(view.resumeOf ? { resumeOf: view.resumeOf } : {}),
            })),
            results: [],
            total: views.length,
            message: renderInterruptedList(views),
          }
        }
        const results: ResumeResult[] = []
        for (const id of ids) {
          results.push(await resumeDispatch(resumeDeps, id, {
            exec,
            ...(args.capabilities ? { capabilities: args.capabilities } : {}),
          }))
        }
        const resumed = results.filter((row) => row.status === 'resumed').length
        const status: 'resumed' | 'partial' | 'error' = resumed === results.length
          ? 'resumed'
          : resumed > 0 ? 'partial' : 'error'
        const message = results.map((row, index) =>
          index + 1 + '. ' + (row.status === 'resumed' ? '✅' : '❌') + ' ' + row.dispatchId + '：' + row.message).join('\n')
        return {
          status, items: [], results, total: results.length, message,
          ...(resumed > 0 ? { nextAction: RESUME_NEXT_ACTION } : {}),
        }
      } catch (error) {
        deps.logger.warn(`supermemory: memory_resume threw: ${String(error).slice(0, 200)}`)
        return { status: 'error' as const, items: [], results: [], total: 0, message: `续跑异常：${String(error).slice(0, 200)}` }
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
    description: '工具化（P3）：① 列出待处理的组合工具提议（重复流程达阈值后产生）与已注册的能力；'
      + '② 接受/拒绝某个提议；③ register 注册或更新一个"能力"（capability）——入口命令 + 文档 + 适用范围 + 路由描述 + 可一键执行（默认预演，写操作需 confirm=true）；'
      + '④ refresh-builtin 刷新内置能力（store 缺失则播种、旧于内置版本则升级、现场更新保留）并返回差异报告与各能力健康度（使用次数/成败分列/连续失败/文档与适用范围缺失/零使用）。'
      + '接受提议会把记录到的工具序列编译成组合工具（一次调用完成确定性子序列）并持久化，重启后仍可用。'
      + 'register 同名能力 = 原地更新（version+1、changelog 记录原因），不会报错也不会重复建行；register 的能力同样落库（tool_memory），重启后 rebuildComposites 重建注册；仅适用于本仓库范围内注册（scope 指向本仓库目录）。'
      + CAPABILITY_ROUTING_RULES,
    parameters: {
      accept: { type: 'boolean', description: '接受第一个待处理提议并生成组合工具' },
      decline: { type: 'boolean', description: '拒绝（不再提示）第一个待处理提议' },
      register: { type: 'boolean', description: '注册一个能力（入口命令 + 文档 + 适用范围 + 路由描述，可一键执行）' },
      name: { type: 'string', description: '能力逻辑名（字母/数字/-/_，如 git-sync-supermemory；工具名派生为 sm_composite_<name>）' },
      title: { type: 'string', description: '能力标题（人类可读）' },
      description: { type: 'string', description: '能力描述 + 路由：何时优先用它、关键坑是什么（模型据此路由）' },
      entry: { type: 'string', description: '入口命令，如 "pnpm git:sync"（在 scope 目录内经 shell 执行）' },
      doc: { type: 'string', description: '文档路径（相对仓库根），如 "docs/git-sync.md"' },
      scope: { type: 'string', description: '适用范围：入口命令的执行目录，如 "F:\\10-SuperMemory"（通常是仓库根）' },
      runnable: { type: 'boolean', description: '是否允许执行；缺省 true' },
      dryRunArg: { type: 'string', description: '预演参数，如 "--dry-run"；定义后默认预演执行' },
      writeConfirm: { type: 'boolean', description: 'true=真实执行可能写远端/改状态，必须显式 confirm=true' },
      tags: { type: 'array', description: '标签（3–8 个短词，检索索引）', items: { type: 'string' } },
      refreshBuiltin: { type: 'boolean', description: '刷新内置能力：store 缺失则播种、旧于内置版本则升级（现场更新保留），并返回差异报告与各能力健康度' },
      changelog: { type: 'string', description: 'register 同名更新时的一行变更说明（写入 changelog，最新在前；缺省自动生成）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['listed', 'accepted', 'declined', 'none', 'registered', 'refreshed', 'error'], required: true },
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
          capabilities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', required: true },
                title: { type: 'string' },
                entry: { type: 'string', required: true },
                doc: { type: 'string' },
                scope: { type: 'string' },
                runnable: { type: 'boolean' },
                dryRunArg: { type: 'string' },
                writeConfirm: { type: 'boolean' },
                status: { type: 'string' },
                useCount: { type: 'integer' },
                version: { type: 'integer' },
                lastStatus: { type: 'string' },
                live: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
          builtin: {
            type: 'object',
            properties: {
              seeded: { type: 'array', items: { type: 'string' } },
              upgraded: { type: 'array', items: { type: 'string' } },
              current: { type: 'array', items: { type: 'string' } },
              localNewer: { type: 'array', items: { type: 'string' } },
              otherWorkspace: { type: 'integer' },
              health: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', required: true },
                    builtin: { type: 'boolean' },
                    builtinVersion: { type: 'integer' },
                    version: { type: 'integer' },
                    entry: { type: 'string' },
                    useCount: { type: 'integer' },
                    successCount: { type: 'integer' },
                    failCount: { type: 'integer' },
                    consecutiveFailures: { type: 'integer' },
                    lastStatus: { type: 'string' },
                    docMissing: { type: 'boolean' },
                    scopeMissing: { type: 'boolean' },
                    live: { type: 'boolean' },
                    notes: { type: 'array', items: { type: 'string' } },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value as {
          status: string
          pending?: Array<{ pattern: string; count: number }>
          tool?: string
          message?: string
          capabilities?: Array<{ name: string; title?: string; entry: string; dryRunArg?: string; writeConfirm?: boolean; status?: string }>
          builtin?: {
            seeded: string[]
            upgraded: string[]
            current: string[]
            localNewer: string[]
            health: Array<{
              name: string
              builtin?: boolean
              builtinVersion?: number
              version?: number
              entry?: string
              useCount?: number
              successCount?: number
              failCount?: number
              consecutiveFailures?: number
              lastStatus?: string
              docMissing?: boolean
              scopeMissing?: boolean
              live?: boolean
              notes?: string[]
            }>
          }
        }
        if (v.status === 'refreshed') {
          const b = v.builtin
          const parts: string[] = [v.message ?? '已刷新内置能力。']
          if (b) {
            if (b.seeded.length) parts.push('播种：' + b.seeded.join('、'))
            if (b.upgraded.length) parts.push('升级：' + b.upgraded.join('、'))
            if (b.current.length) parts.push('已最新：' + b.current.join('、'))
            if (b.localNewer.length) parts.push('现场更新（保留）：' + b.localNewer.join('、'))
            for (const h of b.health) {
              const head = `- ${h.name}${h.builtin ? '（内置）' : ''} v${h.version ?? 0}：使用 ${h.useCount ?? 0}（成功 ${h.successCount ?? 0}/失败 ${h.failCount ?? 0}，连续失败 ${h.consecutiveFailures ?? 0}）`
              parts.push(head + (h.notes && h.notes.length ? '\n  ' + h.notes.join('\n  ') : ''))
            }
          }
          return [{ type: 'text', text: parts.join('\n') }]
        }
        if (v.status === 'listed') {
          const list = (v.pending ?? []).map((p) => `- ${p.pattern}（${p.count} 次）`).join('\n')
          const caps = (v.capabilities ?? []).map((c) =>
            `- ${c.name}：${c.entry}${c.dryRunArg ? `（默认预演 ${c.dryRunArg}）` : ''}${c.writeConfirm ? '（写操作需 confirm=true）' : ''}${c.status === 'retired' ? '（已停用）' : ''}`).join('\n')
          const parts: string[] = []
          if (list) parts.push(`待处理提议：\n${list}`)
          if (caps) parts.push(`已注册能力：\n${caps}`)
          return [{ type: 'text', text: parts.length > 0 ? parts.join('\n\n') : '（没有待处理的工具化提议，也没有已注册的能力）' }]
        }
        if (v.status === 'accepted') return [{ type: 'text', text: `已固化为组合工具 ${v.tool}。` }]
        if (v.status === 'registered') return [{ type: 'text', text: v.message ?? `已注册能力 ${v.tool}。` }]
        if (v.status === 'declined') return [{ type: 'text', text: '已拒绝该提议。' }]
        if (v.status === 'none') return [{ type: 'text', text: '（没有待处理的工具化提议）' }]
        return [{ type: 'text', text: v.message ?? '操作失败。' }]
      },
    },
    async execute(
      args: {
        accept?: boolean
        decline?: boolean
        register?: boolean
        name?: string
        title?: string
        description?: string
        entry?: string
        doc?: string
        scope?: string
        runnable?: boolean
        dryRunArg?: string
        writeConfirm?: boolean
        tags?: string[]
        refreshBuiltin?: boolean
        changelog?: string
      },
      exec: ToolExec,
    ) {
      // A3: 本会话的工作区（能力列表/健康报告只覆盖适用于它的能力）。
      const cwd = exec.agent?.session?.header?.cwd
      const workspaceKey = cwd ? workspaceKeyOf(cwd) : undefined
      // R26: 刷新内置能力（播种缺失/升级旧版/现场保留）+ 差异报告 + 健康度信号。
      if (args.refreshBuiltin) {
        const { capabilityRecordsOf, capabilityHealthOf, mergeBuiltinCapabilities, registerComposite } = await import('./composite.ts')
        const report = await mergeBuiltinCapabilities(store, { ctx, register: registerComposite })
        // A3: 健康信号按当前工作区过滤；别的工作区的能力只报数量不列明细。
        const health = capabilityHealthOf(store, workspaceKey)
        const otherWorkspace = Math.max(0, capabilityRecordsOf(store).length - health.length)
        deps.logger.info(`supermemory: refresh-builtin (seeded ${report.seeded.length}, upgraded ${report.upgraded.length}, current ${report.current.length}, local-newer ${report.localNewer.length})`)
        return {
          status: 'refreshed' as const,
          message: `内置能力已刷新：播种 ${report.seeded.length}、升级 ${report.upgraded.length}、已最新 ${report.current.length}、现场更新保留 ${report.localNewer.length}。`
            + (otherWorkspace > 0 ? `另有 ${otherWorkspace} 个能力属于其他工作区，本工作区不暴露。` : ''),
          builtin: {
            seeded: report.seeded,
            upgraded: report.upgraded,
            current: report.current,
            localNewer: report.localNewer,
            health: health.map((h) => ({
              name: h.name,
              builtin: h.builtin,
              ...(h.builtinVersion !== undefined ? { builtinVersion: h.builtinVersion } : {}),
              version: h.version,
              entry: h.entry,
              useCount: h.useCount,
              successCount: h.successCount,
              failCount: h.failCount,
              consecutiveFailures: h.consecutiveFailures,
              ...(h.lastStatus ? { lastStatus: h.lastStatus } : {}),
              docMissing: h.docMissing,
              scopeMissing: h.scopeMissing,
              live: h.live,
              notes: h.notes,
            })),
          },
        }
      }
      // R22 能力注册：入口命令 + 文档 + 适用范围 + 路由描述，落库后可一键执行。
      if (args.register) {
        const { registerCapability } = await import('./composite.ts')
        const ws = workspaceKey ?? (args.scope ? workspaceKeyOf(args.scope) : undefined)
        const result = await registerCapability(ctx, store, {
          name: String(args.name ?? ''),
          title: args.title,
          description: String(args.description ?? ''),
          entry: String(args.entry ?? ''),
          doc: args.doc,
          scope: args.scope,
          runnable: args.runnable,
          dryRunArg: args.dryRunArg,
          writeConfirm: args.writeConfirm,
          tags: args.tags,
          changelog: args.changelog,
        }, ws)
        if (result.status === 'error') return { status: 'error' as const, message: result.message }
        deps.logger.info(`supermemory: capability ${result.name} registered via memory_toolize`)
        return { status: 'registered' as const, tool: result.name, message: result.message }
      }
      const pending: Array<[string, Signal]> = []
      for (const [key, signal] of store.signals.entries()) {
        if (signal.proposalStatus === 'pending' && signal.proposedAt !== undefined) pending.push([key, signal])
      }
      if (!args.accept && !args.decline) {
        const { capabilityRecordsOf, liveCompositeSpecs } = await import('./composite.ts')
        // A3: 只列出适用于当前工作区的能力（行级归属或 scope 推导）。
        return {
          status: 'listed' as const,
          pending: pending.map(([, s]) => ({ pattern: s.pattern, count: s.count })),
          capabilities: capabilityRecordsOf(store, workspaceKey).map((c) => ({
            name: c.spec.name,
            title: c.spec.title,
            entry: c.spec.entry,
            doc: c.spec.doc,
            scope: c.spec.scope,
            runnable: c.spec.runnable !== false,
            dryRunArg: c.spec.dryRunArg,
            writeConfirm: Boolean(c.spec.writeConfirm),
            status: c.status,
            useCount: c.useCount,
            ...(typeof c.spec.version === 'number' ? { version: c.spec.version } : {}),
            ...(c.spec.usage?.lastStatus ? { lastStatus: c.spec.usage.lastStatus } : {}),
            live: liveCompositeSpecs.has(c.spec.name),
          })),
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

