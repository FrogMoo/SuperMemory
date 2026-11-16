/**
 * Pre-step context card: global recall injection (P0 — no routing yet).
 *
 * Waterfall etiquette: always call `next()` and pass the FULL downstream
 * decision through (including `startsRequestSeries`), only appending messages.
 * Guard (§1.2): batches without a `user`-source message (supermemory relays,
 * tool continuations, empty claims) pass through untouched — no routing, no
 * confirmation, no drift counting.
 * @module supermemory/prestep
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage, createUserMessage as CreateUserMessage } from '@deepseek-ai/dsh-llm'
import { loadHostModule } from './host.ts'
import { recallMemories, renderRecallCard, type RecallOptions } from './recall.ts'
import type { Memory } from './schema.ts'
import './services.ts'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'

export interface PreStepConfig {
  enabled: boolean
  maxItems: number
  minScore: number
  halfLifeDays: number
  maxChars: number
  injectStyle: 'gentle' | 'plain'
}

/** Plain text of one message's content blocks. */
function textOf(message: UserMessage): string {
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** Attach the recall-injecting pre-step listener. Returns the effect disposer. */
export function attachPreStep(
  ctx: Context,
  store: Store | undefined,
  config: PreStepConfig,
  logger: { warn: (msg: string) => void },
): () => void {
  if (!store || !config.enabled) return () => {}
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
      logger.warn(`supermemory: pre-step next() failed: ${String(error)}`)
      throw error
    }
    if (decision.kind !== 'enter') return decision
    const messages = decision.messages ?? []
    const hasUserSource = messages.some((m) => m.source?.kind === 'user')
    if (!hasUserSource) return decision

    try {
      const query = messages.map(textOf).filter(Boolean).join('\n').slice(0, 2000)
      if (!query) return decision
      const cwd = (payload.agent as unknown as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
      const workspaceKey = workspaceKeyOf(cwd)
      const options: RecallOptions = {
        limit: config.maxItems,
        minScore: config.minScore,
        halfLifeDays: config.halfLifeDays,
        now: Date.now(),
      }
      // workspace isolation (D4): only this workspace's active memories rank
      const own: [string, Memory][] = []
      for (const entry of store.memories.entries()) {
        const record = entry[1]
        if (record.workspaceKey === workspaceKey && record.status === 'active') own.push(entry)
      }
      const items = recallMemories(own, query, options)
      const card = renderRecallCard(items, config.injectStyle).slice(0, config.maxChars)
      if (!card) return decision
      const factory = await ensureFactory()
      const recallMessage = factory({
        content: [{ type: 'text', text: card }],
        source: { kind: 'supermemory', form: 'recall' },
      })
      return { ...decision, messages: [...decision.messages, recallMessage] }
    } catch (error) {
      // Hard constraint: the hub is never blocked by the memory plugin.
      logger.warn(`supermemory: recall injection skipped: ${String(error)}`)
      return decision
    }
  })
}
