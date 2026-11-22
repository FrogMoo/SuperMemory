/**
 * R27 需求④: 记忆写入的大模型辅助 seam。
 *
 * 记忆的两处「该由模型判断」的环节——集合归属（memory-collections.ts 的
 * decideCollectionWithLlm）与原子拆分（memory-split.ts 的
 * splitMemoryEntries）共用本模块：
 *
 * 1. 路由：优先当前会话（中枢）的模型，其次运行时的第一个可用目录项；
 * 2. 一次 llm.stream 调用收齐文本，取第一个 JSON 对象；
 * 3. 任何失败（无 ctx / 无 llm 服务 / 无路由 / 抛错 / 超时 / 非 JSON）都返回
 *    undefined，由调用方静默降级到启发式——与 topic-shape.ts 的既定范式一致。
 *
 * Token 护栏：每次判定只调用一次，不重试、不多轮。
 * @module supermemory/llm-json
 */
import type { Context } from '@deepseek-ai/cordis'
import { enumerateModels, hubSelection } from './model.ts'

/** One model call's deadline (a hung stream must not stall a write path). */
export const LLM_JSON_TIMEOUT_MS = 20_000

export interface LlmJsonLogger {
  warn: (msg: string) => void
  info?: (msg: string) => void
}

export interface LlmJsonDeps {
  ctx?: Context
  logger?: LlmJsonLogger
  /** The acting session, so the hub model is preferred over the catalog. */
  sessionId?: string
}

export interface LlmJsonRequest {
  system: string
  user: string
  /** Completion cap; a split answer needs more room than a one-line decision. */
  maxTokens?: number
  timeoutMs?: number
}

/** One route: provider + model (+ optional reasoning effort). */
export interface LlmRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

interface LlmStreamChunkLike {
  type?: string
  text?: string
}

interface LlmStreamLike {
  stream?(options: Record<string, unknown>): AsyncIterable<LlmStreamChunkLike>
}

/**
 * The route a memory decision uses: the acting session's hub model first, then
 * the first enumerated catalog entry. `undefined` means "no model available" —
 * every caller then keeps its heuristic behaviour (and burns no tokens).
 */
export async function resolveLlmRoute(
  ctx: Context | undefined,
  sessionId?: string,
): Promise<LlmRoute | undefined> {
  if (!ctx) return undefined
  if (sessionId) {
    try {
      const agent = (ctx as unknown as { agents?: { get?: (id: string) => unknown } }).agents?.get?.(sessionId)
      const hub = hubSelection(agent)
      if (hub) return { provider: hub.provider, model: hub.model, ...(hub.reasoningEffort ? { reasoningEffort: hub.reasoningEffort } : {}) }
    } catch { /* no live agent: fall through to the catalog */ }
  }
  try {
    const { models } = await enumerateModels(ctx)
    const first = models[0]
    if (first) return { provider: first.provider, model: first.id }
  } catch { /* no catalog: no model */ }
  return undefined
}

/** The `llm` service through `ctx.get` (never the property: see model.ts). */
function llmServiceOf(ctx: Context | undefined): LlmStreamLike | undefined {
  try {
    return (ctx as unknown as { get?: (name: string) => unknown } | undefined)?.get?.('llm') as LlmStreamLike | undefined
  } catch {
    return undefined
  }
}

/** Strip code fences/quotes and parse the first JSON object of an answer. */
export function parseJsonObject(text: string): unknown | undefined {
  const clean = String(text ?? '').replace(/```[a-z]*/gi, '').replace(/```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(clean.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * One model call whose answer must be a JSON object. Returns `undefined` when
 * there is no model, the call fails, it times out, or the answer carries no
 * usable JSON — the caller degrades silently in every one of those cases.
 */
export async function askLlmJson(
  deps: LlmJsonDeps,
  request: LlmJsonRequest,
): Promise<unknown | undefined> {
  const { ctx, logger, sessionId } = deps
  if (!ctx) return undefined
  const llm = llmServiceOf(ctx)
  if (!llm || typeof llm.stream !== 'function') return undefined
  const route = await resolveLlmRoute(ctx, sessionId)
  if (!route) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? LLM_JSON_TIMEOUT_MS)
  let text = ''
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      system: request.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
      maxTokens: request.maxTokens ?? 600,
      temperature: 0.2,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
  } catch (error) {
    logger?.warn(`supermemory: llm-json call failed: ${String(error).slice(0, 160)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
  const parsed = parseJsonObject(text)
  if (parsed === undefined) {
    logger?.warn('supermemory: llm-json answer did not contain a JSON object; degrading to the heuristic')
  }
  return parsed
}
