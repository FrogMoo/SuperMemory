/**
 * Pre-step topic-set routing (§1.2): explicit mention → sticky + drift →
 * keyword search (+ optional LLM) → confirmation, then the context card.
 *
 * Waterfall etiquette: always `next()` first and pass the full decision
 * through; we only append the topicset context message. The §1.2 guard (only
 * batches with a `user`-source message) is applied by the caller.
 * @module supermemory/route
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage, createUserMessage as CreateUserMessage } from '@deepseek-ai/dsh-llm'
import { loadHostModule } from './host.ts'
import { tokenize } from './recall.ts'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import {
  getRouting, getTopicSet, listTopicSets, setRouting, touchTopicSet, createTopicSet,
} from './topicsets.ts'
import type { TopicSet } from './schema.ts'

export interface RouteConfig {
  enabled: boolean
  driftTurns: number
  driftThreshold: number
  confirm: boolean
  llmFallback: boolean
}

export interface RouteDeps {
  store: Store
  config: RouteConfig
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

interface RouteOutcome {
  topicSetId?: string
  created?: string
  card?: string
}

/** The session cwd of a pre-step payload's agent. */
function agentCwd(agent: unknown): string | undefined {
  return (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
}

function textOf(message: UserMessage): string {
  return (message.content ?? [])
    .map((block: { type: string; text?: string }) => (block.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean).join('\n')
}

/** Score one topic set against the query tokens (title + summary + keywords). */
function scoreTopicSet(topicSet: TopicSet, tokens: Set<string>): number {
  if (tokens.size === 0) return 0
  const bag = new Set(tokenize(`${topicSet.title} ${topicSet.summary} ${topicSet.keywords.join(' ')}`))
  let hits = 0
  for (const token of tokens) if (bag.has(token)) hits++
  return hits / Math.sqrt(bag.size || 1)
}

/**
 * Run routing for one user batch. Returns the outcome (possibly empty when
 * routing declines); never throws — a routing failure must not block the hub.
 *
 * Only hub sessions route: branches (plugin-created topicset members) and
 * delegated sessions (subagents, `delegationDepth > 0`) are skipped, so a
 * worker is never parked on a routing confirmation.
 */
export async function routeBatch(
  ctx: Context,
  deps: RouteDeps,
  agent: unknown,
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): Promise<RouteOutcome> {
  const { store, config, logger } = deps
  if (!config.enabled || !text.trim()) return {}
  const header = (agent as { session?: { header?: { cwd?: string; delegationDepth?: number } } })?.session?.header
  const workspaceKey = workspaceKeyOf(header?.cwd)
  if ((header?.delegationDepth ?? 0) > 0) return {}
  if (isBranchSession(store, sessionId)) return {}
  const tokens = new Set(tokenize(text))

  // ---- 1. explicit: @话题集名 ----
  const mention = text.match(/@([^\s@,，。;；]{1,30})/)
  if (mention) {
    const name = mention[1]
    for (const [id, topicSet] of listTopicSets(store, workspaceKey)) {
      if (topicSet.title === name || topicSet.title.includes(name) || name.includes(topicSet.title)) {
        await setRouting(store, sessionId, { activeTopicSetId: id, driftCount: 0 })
        await touchTopicSet(store, id)
        return { topicSetId: id, card: renderCard(getTopicSet(store, id)) }
      }
    }
  }

  // ---- 2. sticky + drift ----
  const routing = getRouting(store, sessionId)
  if (routing?.activeTopicSetId) {
    const active = getTopicSet(store, routing.activeTopicSetId)
    if (active && active.status === 'active') {
      const overlap = scoreTopicSet(active, tokens)
      if (overlap >= config.driftThreshold) {
        await setRouting(store, sessionId, { driftCount: 0 })
        await touchTopicSet(store, routing.activeTopicSetId)
        return { topicSetId: routing.activeTopicSetId, card: renderCard(active) }
      }
      const drift = routing.driftCount + 1
      if (drift < config.driftTurns) {
        await setRouting(store, sessionId, { driftCount: drift })
        return { topicSetId: routing.activeTopicSetId, card: renderCard(active) }
      }
      // drifted for K consecutive turns → fall through to search
      setRouting(store, sessionId, { driftCount: 0 })
    }
  }

  // ---- 3. keyword search ----
  const candidates = listTopicSets(store, workspaceKey)
    .map(([id, topicSet]) => ({ id, topicSet, score: scoreTopicSet(topicSet, tokens) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)

  if (candidates.length > 0) {
    const best = candidates[0]
    if (config.confirm) {
      const answer = await askConfirm(ctx, logger, agent, signal,
        `检测到相似话题『${best.topicSet.title}』（${best.topicSet.summary || '暂无梗概'}）？当前消息可能属于该话题。`,
        best.topicSet.title)
      if (answer === 'continue') {
        await setRouting(store, sessionId, { activeTopicSetId: best.id, driftCount: 0 })
        await touchTopicSet(store, best.id)
        return { topicSetId: best.id, card: renderCard(best.topicSet) }
      }
      if (answer === 'new') return await createAndActivate(ctx, deps, sessionId, workspaceKey, text)
      return {} // 都不对 → no routing this turn
    }
    await setRouting(store, sessionId, { activeTopicSetId: best.id, driftCount: 0 })
    return { topicSetId: best.id, card: renderCard(best.topicSet) }
  }

  // ---- 4. no candidate: ask whether to create ----
  if (config.confirm) {
    const answer = await askConfirm(ctx, logger, agent, signal,
      '没有检测到相似的历史话题。要为当前讨论新建一个话题集吗？', '')
    if (answer === 'new' || answer === 'continue') {
      return await createAndActivate(ctx, deps, sessionId, workspaceKey, text)
    }
  }
  return {}
}

async function createAndActivate(
  ctx: Context,
  deps: RouteDeps,
  sessionId: string,
  workspaceKey: string,
  text: string,
): Promise<RouteOutcome> {
  const title = deriveTitle(text)
  const id = await createTopicSet(deps.store, { workspaceKey, title, keywords: [...new Set(tokenize(text))].slice(0, 12) })
  setRouting(deps.store, sessionId, { activeTopicSetId: id, driftCount: 0 })
  deps.logger.info(`supermemory: topic set created ${id} (${title})`)
  return { topicSetId: id, created: id, card: renderCard(getTopicSet(deps.store, id)) }
}

/** Ask the routing confirmation through the host's user-question channel. */
async function askConfirm(
  ctx: Context,
  logger: { warn: (msg: string) => void },
  agent: unknown,
  signal: AbortSignal | undefined,
  question: string,
  topicTitle: string,
): Promise<'continue' | 'new' | 'none' | undefined> {
  try {
    const answer = await ctx.userQuestions.ask({
      questions: [{
        id: 'supermemory-route',
        header: '话题路由',
        question,
        options: [
          { label: topicTitle ? `继续该话题` : '新建话题集', description: topicTitle ? `激活『${topicTitle}』` : '为当前讨论新建话题集' },
          ...(topicTitle ? [{ label: '新建话题集', description: '为当前讨论新建话题集' }] : []),
          { label: '都不对', description: '本次不进行话题路由' },
        ],
      }],
      ...(agent ? { agent: agent as never } : {}),
      ...(signal ? { signal } : {}),
    })
    const selected = answer?.answers?.[0]?.selected?.[0] ?? ''
    if (selected === '继续该话题') return 'continue'
    if (selected === '新建话题集') return 'new'
    return 'none'
  } catch (error) {
    logger.warn(`supermemory: routing confirmation unavailable: ${String(error).slice(0, 160)}`)
    return undefined
  }
}

/** First ~12 chars of the user text as a provisional title. */
function deriveTitle(text: string): string {
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '新话题'
  return line.slice(0, 12) || '新话题'
}

/** True when the session is one of this plugin's branch sessions. */
function isBranchSession(store: Store, sessionId: string): boolean {
  for (const [, topicSet] of store.topicsets.entries()) {
    if (topicSet.members.some((m) => m.sessionId === sessionId)) return true
  }
  return false
}

/** The model-facing topicset context card (§1.2 final step). */
export function renderCard(topicSet: TopicSet | undefined): string {
  if (!topicSet) return ''
  const lines = [
    `[SuperMemory 话题集] ${topicSet.title}`,
    topicSet.summary ? `梗概：${topicSet.summary}` : '梗概：（暂无，随对话滚动更新）',
  ]
  if (topicSet.defaultModel) {
    lines.push(`默认模型：${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}`)
  }
  if (topicSet.members.length > 0) {
    lines.push('分支：')
    for (const m of topicSet.members) {
      lines.push(`- ${m.title || m.sessionId}（${m.status}${m.model ? ' · ' + m.model : ''}）`)
    }
  }
  lines.push('如需把实质工作分派到分支，调用 memory_dispatch；本会话是中枢，只做判断与整合。')
  return lines.join('\n')
}

/**
 * Attach routing to the pre-step waterfall. `next()` is always called and the
 * full decision passed through; only the context message is appended.
 */
export function attachRoute(ctx: Context, deps: RouteDeps): () => void {
  if (!deps.config.enabled) return () => {}
  let createMessage: typeof CreateUserMessage | undefined
  const ensureFactory = async () => {
    if (!createMessage) {
      const llm = await loadHostModule('@deepseek-ai/dsh-llm')
      createMessage = llm.createUserMessage as typeof CreateUserMessage
    }
    return createMessage
  }

  return ctx.on('agent/pre-step', async (payload, next) => {
    let decision: PreStepDecision
    try {
      decision = await next()
    } catch (error) {
      deps.logger.warn(`supermemory: route next() failed: ${String(error)}`)
      throw error
    }
    if (decision.kind !== 'enter') return decision
    const messages = decision.messages ?? []
    if (!messages.some((m) => m.source?.kind === 'user')) return decision
    try {
      const sessionId = String(payload.agent?.id ?? '')
      const text = messages.map(textOf).filter(Boolean).join('\n')
      const outcome = await routeBatch(ctx, deps, payload.agent, sessionId, text, payload.signal)
      if (!outcome.card) return decision
      const factory = await ensureFactory()
      const card = factory({
        content: [{ type: 'text', text: outcome.card }],
        source: { kind: 'supermemory', form: 'recall' },
      })
      return { ...decision, messages: [...decision.messages, card] }
    } catch (error) {
      deps.logger.warn(`supermemory: routing skipped: ${String(error).slice(0, 200)}`)
      return decision
    }
  })
}
