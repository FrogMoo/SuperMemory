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
import { isPluginBranchId } from './hub-sessions.ts'
import { noteTopicSetActivated } from './topic-shape.ts'
import {
  getRouting, getTopicSet, listTopicSets, setRouting, touchTopicSet, createTopicSet,
} from './topicsets.ts'
import type { TopicSet } from './schema.ts'

/**
 * 固化能力（capability）的路由规则——模型可见文案的单一事实来源：
 * memory_toolize 的工具描述与每个能力工具的描述都引用它（src/tools.ts /
 * src/composite.ts）。规则要点：scope 内高频事务优先固化/更新能力，不要每次
 * 现敲命令；能力连续失败或文档与现状不符时必须更新能力，而不是绕过它。
 */
export const CAPABILITY_ROUTING_RULES = '固化能力（capability）路由规则：'
  + '① 在能力适用范围（scope）内遇到高频事务（git 同步/提交/推送、构建、验证、测试、发布等）时，优先调用已固化能力（sm_composite_*，默认预演、写操作 confirm=true 确认真实执行），不要每次现敲命令；'
  + '② 没有现成能力时，用 memory_toolize register 固化一个（入口命令 + 文档 + 适用范围 + 路由描述），不要满足于一次性命令；'
  + '③ 能力执行连续失败、或文档与现状不符时，必须用 memory_toolize register 同名更新能力（version+1、changelog 记录原因），不要绕过它手敲命令；'
  + '④ 用 memory_toolize refresh-builtin 刷新内置能力并查看差异报告与健康度（使用次数、成败分列、连续失败、文档/适用范围缺失、零使用），按信号决定更新还是停用。'

export interface RouteConfig {
  enabled: boolean
  driftTurns: number
  driftThreshold: number
  /** 关键词命中时注入静默提示卡片（不询问、不切换激活话题集）。 */
  hint: boolean
  llmFallback: boolean
}

export interface RouteDeps {
  store: Store
  config: RouteConfig
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
  /** Host context (R19 需求⑥: activation may refresh the set's LLM shape). */
  ctx?: Context
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
  // Require a boundary before the @ so e-mail addresses never count as a
  // mention, and require a non-trivial title on both sides: an empty or
  // one-character title would otherwise match EVERY @-mention.
  const mention = text.match(/(?:^|[^\w@])@([^\s@,，。;；]{1,30})/)
  if (mention) {
    const name = mention[1]
    for (const [id, topicSet] of listTopicSets(store, workspaceKey)) {
      const title = topicSet.title.trim()
      if (title.length < 2) continue
      if (title === name || title.includes(name) || name.includes(title)) {
        await setRouting(store, sessionId, { activeTopicSetId: id, driftCount: 0 })
        await touchTopicSet(store, id)
        if (deps.ctx) noteTopicSetActivated({ ctx: deps.ctx, store, logger: deps.logger }, id)
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
      await setRouting(store, sessionId, { driftCount: 0 })
    }
  }

  // ---- 3. keyword search: silent hint only (§R1) ----
  // 直接对话时模型就在当前上下文继续：不询问、不切换激活话题集；
  // 仅把相似话题作为提示卡片注入，激活只来自 @显式、面板或 /memory switch。
  if (!config.hint) return {}
  const candidates = listTopicSets(store, workspaceKey)
    .map(([id, topicSet]) => ({ id, topicSet, score: scoreTopicSet(topicSet, tokens) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  if (candidates.length === 0) return {}
  const lines = candidates.map((c) => `- 『${c.topicSet.title}』${c.topicSet.summary ? `：${c.topicSet.summary.slice(0, 80)}` : ''}`)
  return {
    card: [
      '[SuperMemory 话题提示]',
      '检测到可能与当前对话相关的历史话题（未切换，当前对话继续）：',
      ...lines,
      '需要切换时：在消息里 @话题集名，或在 SuperMemory 面板中点击激活。',
    ].join('\n'),
  }
}

/** True when the session is one of this plugin's branch sessions. */
function isBranchSession(store: Store, sessionId: string): boolean {
  // R19 需求③④: plugin-minted branch ids are branches regardless of member
  // kind (a fresh dispatch is `kind:'root'`); a host session that owns a set
  // stays a routing hub.
  if (isPluginBranchId(sessionId)) return true
  for (const [, topicSet] of store.topicsets.entries()) {
    if (topicSet.members.some((m) => m.sessionId === sessionId && m.kind === 'fork')) return true
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
  // R24: 派发回执后立即结束本轮——本轮里等分支只会把 relay 锁在队列里
  // （分支不在中枢 subagent 树里，wait_agent 等不到）。
  lines.push('如需把实质工作分派到分支，调用 memory_dispatch；本会话是中枢，只做判断与整合；派发回执后立即结束本轮回复，分支完成后 relay 会自动开启新一轮对话。')
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
