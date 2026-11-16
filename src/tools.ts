/**
 * Model-visible tools: `memory_remember` and `memory_recall` (P0).
 *
 * Definitions are built with the host's `defineTool` (loaded through the host
 * anchor), so argument validation, output validation and presentation all run
 * on the host's own machinery. Bodies are pure rule logic — no LLM in the
 * loop, so they cannot fail the way an LLM call can.
 * @module supermemory/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type * as Tools from '@deepseek-ai/dsh-tools'
import { loadHostModule } from './host.ts'
import { recallMemories, type RecallOptions } from './recall.ts'
import type { Episode, Memory, Requirement } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'

export interface ToolsConfig {
  rememberEnabled: boolean
  recall: {
    maxItems: number
    minScore: number
    halfLifeDays: number
  }
}

interface ToolExec {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** Attach the P0 tools; returns the effect disposer. */
export async function attachTools(ctx: Context, store: Store | undefined, config: ToolsConfig): Promise<() => void> {
  if (!store) return () => {}
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
    description: '检索 SuperMemory：事实记忆（memories）、归档梗概（episodes）与需求（requirements），按当前工作区隔离，'
      + '关键词 + 时间衰减规则评分。回答“之前说过什么/做过什么”类问题前先用本工具检索。',
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
                kind: { type: 'string', enum: ['memory', 'episode', 'requirement'], required: true },
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
      const items: Array<{ kind: 'memory' | 'episode' | 'requirement'; id: string; text: string; score: number; createdAt: number }> = []
      const memories: Array<[string, Memory]> = []
      for (const entry of store.memories.entries()) {
        if (entry[1].workspaceKey === workspaceKey && entry[1].status === 'active') memories.push(entry)
      }
      for (const item of recallMemories(memories, query, options)) {
        items.push({ kind: 'memory', id: item.memoryId, text: item.text, score: item.score, createdAt: item.createdAt })
      }
      // episodes / requirements join the same rule ranking once P1/P2 fill them.
      const episodes: Array<[string, Episode]> = []
      for (const entry of store.episodes.entries()) {
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
      items.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      return { items: items.slice(0, options.limit), total: items.length }
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
