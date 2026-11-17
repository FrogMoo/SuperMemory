/**
 * Per-step context injection: the opening recall card (P0) and the in-request
 * repeat cards (requirement A).
 *
 * Waterfall etiquette: always call next() and pass the FULL downstream decision
 * through (including startsRequestSeries), only appending messages.
 * A batch that carries a user-source message opens a new request (base recall +
 * fresh request state); every other step is a tool continuation and goes to the
 * repeat path. A single request can therefore receive several cards, bounded by
 * recall.repeat.maxCardsPerRequest / maxCharsPerRequest and de-duplicated by
 * memory id.
 * @module supermemory/prestep
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage, createUserMessage as CreateUserMessage } from '@deepseek-ai/dsh-llm'
import { loadHostModule } from './host.ts'
import {
  buildQuery,
  canInjectCard,
  clampText,
  commitCard,
  commitScan,
  freshItems,
  recallScoped,
  remainingChars,
  renderRepeatCard,
  triggerOf,
  type RepeatConfig,
  type Tracker,
} from './inrequest.ts'
import { renderRecallCard, type RecallOptions } from './recall.ts'
import './services.ts'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import { activeComposites, catalogFor, renderCatalog } from './toolize.ts'

export interface PreStepConfig {
  enabled: boolean
  maxItems: number
  minScore: number
  halfLifeDays: number
  maxChars: number
  injectStyle: 'gentle' | 'plain'
  repeat: RepeatConfig
  tracker: Tracker
}

/** Plain text of one message's content blocks. */
function textOf(message: UserMessage): string {
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** Options shared by the opening recall and every repeat recall. */
function recallOptions(config: PreStepConfig): RecallOptions {
  return { limit: config.maxItems, minScore: config.minScore, halfLifeDays: config.halfLifeDays, now: Date.now() }
}

/** Attach the recall-injecting pre-step listener. Returns the effect disposer. */
export function attachPreStep(
  ctx: Context,
  store: Store | undefined,
  config: PreStepConfig,
  logger: { warn: (msg: string) => void },
): () => void {
  if (!store || !config.enabled) return () => {}
  const activeStore: Store = store
  let createMessage: typeof CreateUserMessage | undefined
  const ensureFactory = async () => {
    if (!createMessage) {
      const llm = await loadHostModule('@deepseek-ai/dsh-llm')
      createMessage = llm.createUserMessage as typeof CreateUserMessage
    }
    return createMessage
  }
  const build = async (text: string) => {
    const factory = await ensureFactory()
    return factory({
      content: [{ type: 'text', text }],
      source: { kind: 'supermemory', form: 'recall' },
    })
  }

  return ctx.on('agent/pre-step', async (payload, next) => {
    let decision: PreStepDecision
    try {
      decision = await next()
    } catch (error) {
      logger.warn('supermemory: pre-step next() failed: ' + String(error))
      throw error
    }
    if (decision.kind !== 'enter') return decision
    const agent = payload.agent as unknown as { id?: string; session?: { header?: { cwd?: string } } }
    const sessionId = String(agent?.id ?? '')
    const workspaceKey = workspaceKeyOf(agent?.session?.header?.cwd)
    const turn = Number(payload.turn) || 0
    const step = Number(payload.step) || 0
    try {
      const messages = decision.messages ?? []
      const userText = messages
        .filter((message) => message.source?.kind === 'user')
        .map(textOf)
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000)
      if (userText) {
        const state = config.tracker.begin(sessionId, turn, step, userText)
        const items = recallScoped(activeStore, workspaceKey, userText, recallOptions(config))
        const card = renderRecallCard(items, config.injectStyle).slice(0, config.maxChars)
        if (!card) return decision
        const message = await build(card)
        commitCard(state, step, items, card.length)
        return { ...decision, messages: [...messages, message] }
      }
      // Tool continuation: requirement A repeat path.
      if (!config.repeat.enabled) return decision
      const state = config.tracker.ensure(sessionId, turn, step)
      if (!canInjectCard(state, config.repeat)) return decision
      const reason = triggerOf(state, step, config.repeat)
      if (!reason) return decision
      const query = buildQuery(state, 2000)
      if (!query) {
        commitScan(state, step)
        return decision
      }
      const items = freshItems(recallScoped(activeStore, workspaceKey, query, recallOptions(config)), state, config.repeat)
      const recent = state.recent.map((entry) => entry.name)
      const entries = catalogFor(recent, activeComposites(activeStore), undefined, 3)
      const strong = entries.some((entry) => entry.hits >= 2)
      const catalog = renderCatalog(entries)
      const text = renderRepeatCard(items, config.injectStyle, catalog)
      if (!text || (items.length === 0 && !strong)) {
        commitScan(state, step)
        return decision
      }
      const capped = clampText(text, Math.min(config.maxChars, remainingChars(state, config.repeat)))
      if (!capped) {
        commitScan(state, step)
        return decision
      }
      const message = await build(capped)
      commitCard(state, step, items, capped.length)
      return { ...decision, messages: [...messages, message] }
    } catch (error) {
      // Hard constraint: the hub is never blocked by the memory plugin.
      logger.warn('supermemory: recall injection skipped: ' + String(error).slice(0, 200))
      return decision
    }
  })
}
