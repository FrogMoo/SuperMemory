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
import { charCount, clipAtBoundary } from './clip.ts'
import { matchTopicSets, renderRecallCard, type RecallOptions } from './recall.ts'
import './services.ts'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import { isHubSession, listHubBranches, listTopicSetBranches, renderHubBranchesCard } from './hub-branches.ts'

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

/**
 * R47: the re-fetch clue carried by every omission note. The user's own words
 * are the best `memory_recall` query, so the note quotes a short, cleaned
 * slice of them — long enough to be a real query, short enough to stay a hint.
 */
function clipQueryHint(userText: string): string {
  const clean = String(userText ?? '').replace(/\s+/g, ' ').trim()
  const clipped = clipAtBoundary(clean, 24) || clean.slice(0, 24)
  return `「${clipped}」`
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
  // R19 协同②: the hub↔branch card is a NOTICE, not recall: it is context about
  // the hub's own delegates, and `form: 'notice'` keeps observe.ts from mistaking
  // it for a dispatch input (isDispatchInput excludes recall/notice).
  const buildNotice = async (text: string) => {
    const factory = await ensureFactory()
    return factory({
      content: [{ type: 'text', text }],
      source: { kind: 'supermemory', form: 'notice', summary: 'SuperMemory 中枢分支概览' },
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
        // R19 需求⑧: the opening card also names the topic set the matched
        // conclusions belong to, so the hub can answer/activate immediately.
        const topicSets = matchTopicSets([...activeStore.topicsets.entries()], userText, 3)
        // R47: the card is rendered WITH its budget (degradation by priority,
        // omission notes) instead of being hard-sliced at maxChars afterwards —
        // the old `.slice(0, maxChars)` cut mid-sentence/mid-tag with no sign.
        const recallHint = `复取：memory_recall ${clipQueryHint(userText)}`
        const card = renderRecallCard(items, config.injectStyle, topicSets, { budget: config.maxChars, hint: recallHint })
        // R19 协同②: a hub also gets a compact statement of the branches it has
        // started (title / state / owning set / shared-with-N-hubs), so "which
        // branches do I have?" is answerable from context instead of guesswork.
        // Branches never receive this card (isHubSession is false for them).
        // R30 需求⑤.2: the card ALSO carries the matched topic sets' own branch
        // lists (标题/标签/状态/最后活动) — the 「按话题集检索其下分支会话」 step
        // of the routing, read from the durable ledger with no extra host call.
        let branchesCard = ''
        if (isHubSession(activeStore, agent)) {
          try {
            const setSections = topicSets
              .slice(0, 2)
              .map((set) => ({
                title: set.title,
                rows: listTopicSetBranches(activeStore, set.id, 4),
              }))
              .filter((section) => section.rows.length > 0)
            branchesCard = renderHubBranchesCard(
              listHubBranches(activeStore, sessionId),
              { now: Date.now(), ...(setSections.length > 0 ? { topicSets: setSections } : {}) },
            )
          } catch (error) {
            logger.warn('supermemory: hub branch card skipped: ' + String(error).slice(0, 160))
          }
        }
        if (!card && !branchesCard) return decision
        const appended = []
        if (card) {
          const message = await build(card)
          // Code points, the same unit the card budget counts in.
          commitCard(state, step, items, charCount(card))
          appended.push(message)
        }
        if (branchesCard) appended.push(await buildNotice(branchesCard))
        return { ...decision, messages: [...messages, ...appended] }
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
      // R47/R50: budget-aware repeat card (priority: header > records >
      // omission note). The old hard slice is replaced by a renderer that
      // degrades and says what it left out. R50 removed the composite catalog.
      const text = renderRepeatCard(items, config.injectStyle, '', {
        budget: Math.min(config.maxChars, remainingChars(state, config.repeat)),
        hint: `复取：memory_recall ${clipQueryHint(query)}`,
      })
      if (!text || items.length === 0) {
        commitScan(state, step)
        return decision
      }
      const message = await build(text)
      commitCard(state, step, items, charCount(text))
      return { ...decision, messages: [...messages, message] }
    } catch (error) {
      // Hard constraint: the hub is never blocked by the memory plugin.
      logger.warn('supermemory: recall injection skipped: ' + String(error).slice(0, 200))
      return decision
    }
  })
}
