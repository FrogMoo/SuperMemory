/**
 * Branch observation + followup-relay delivery (§1.3 / §2.2).
 *
 * Terminal judgement never trusts `idle`: it reads the owning `turn/end`'s
 * `reason` from the branch's durable log. A completed turn is cold-read into
 * an episode and relayed to the hub with `followup` (which wakes it); failure
 * terminals produce an explicit failure delivery — never a disguised answer.
 * Delivery is at-least-once with a stable `deliveryId` idempotency key.
 * @module supermemory/observe
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLike, UserMessageLike } from './events.ts'
import { groupComplete, groupEpisodeSummaries, groupMembers, groupRelayExists, groupRelayText } from './group.ts'
import { loadHostModule } from './host.ts'
import type { Dispatch, Episode } from './schema.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'
import { updateMember } from './topicsets.ts'

export interface ObserveConfig {
  enabled: boolean
  maxTokensPolicy: 'deliver-partial' | 'fail'
}

export interface ObserveDeps {
  ctx: Context
  store: Store
  config: ObserveConfig
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

interface ColdEvent {
  type: string
  seq: number
  /** Event commit time (used for the episode's real time window). */
  time: number
  data: unknown
}

/** Per-branch settle chain: concurrent settles (live turn/end + startup
 * reconcile) must not both episode + relay the same dispatch, and a trigger that
 * arrives while one is running must still get its own pass afterwards (dropping
 * it would leave a later turn's dispatch unsettled until the next event). */
const settlingBranches = new Map<string, Promise<void>>()

type MessageFactory = (input: { content: Array<{ type: 'text'; text: string }>; source: Record<string, unknown> }) => UserMessageLike

let sharedFactory: MessageFactory | undefined

/** Process-wide cached `createUserMessage` (loaded through the host anchor). */
async function messageFactory(): Promise<MessageFactory> {
  if (!sharedFactory) {
    const llm = await loadHostModule('@deepseek-ai/dsh-llm')
    sharedFactory = llm.createUserMessage as MessageFactory
  }
  return sharedFactory
}

/** Read one session's durable log range through the persistence seam. */
async function coldRead(ctx: Context, sessionId: string, afterSeq: number, untilSeq?: number): Promise<ColdEvent[]> {
  const persistence = ctx.sessionPersistence as unknown as {
    open(id: string, access: 'read'): Promise<{
      read(offset?: number, length?: number): Promise<{ events: SessionEventLike[] }>
      close(): Promise<void>
    }>
  }
  const handle = await persistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(afterSeq + 1)
    const out: ColdEvent[] = []
    for (const event of events) {
      if (untilSeq !== undefined && event.seq > untilSeq) break
      out.push({ type: event.type, seq: event.seq, time: event.time, data: event.data })
    }
    return out
  } finally {
    await handle.close()
  }
}

/** True when a committed user message is this plugin's dispatch input. */
export function isDispatchInput(message: UserMessageLike): boolean {
  if (message.source?.kind !== 'supermemory') return false
  // Recall/notice cards are also appended as user/message; they are context, not
  // an input, and must never own a turn.
  const form = message.source?.form
  return form !== 'recall' && form !== 'notice'
}

/**
 * Locate the dispatch's own input message and the first turn/end after it.
 *
 * Ownership is the CLAIMED user/message only. followup() durably appends an
 * agent/inbox/spliced the moment it is called — even while the branch is
 * mid-turn — so treating a splice as the input attributed the PREVIOUS turn's
 * answer to this dispatch (and then lost the real answer). The host appends the
 * claimed message as user/message at the start of the owning step
 * (agent-loop agent.ts step()).
 */
function locateOwnership(events: ColdEvent[], startSeq: number): { messageSeq: number; turnEndSeq: number; reason: unknown } | undefined {
  let messageSeq: number | undefined
  for (const event of events) {
    if (event.seq < startSeq) continue
    if (event.type !== 'user/message') continue
    if (isDispatchInput(event.data as UserMessageLike)) { messageSeq = event.seq; break }
  }
  if (messageSeq === undefined) return undefined
  for (const event of events) {
    if (event.seq <= messageSeq) continue
    if (event.type === 'turn/end') {
      return { messageSeq, turnEndSeq: event.seq, reason: (event.data as { reason?: unknown })?.reason }
    }
  }
  return undefined
}

/** Rule-based episode from the branch's owned turn (no LLM in the loop). */
function buildEpisode(events: ColdEvent[], dispatchId: string, topicSetId: string, branchSessionId: string): Episode {
  const timeStart = events[0]?.time ?? Date.now()
  const timeEnd = events[events.length - 1]?.time ?? timeStart
  const assistantTexts: string[] = []
  const decisions: string[] = []
  const files: string[] = []
  const toolNames: string[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } }
      const text = (data.message?.content ?? [])
        .map((b) => (b.type === 'text' ? String(b.text ?? '') : ''))
        .filter(Boolean).join('\n').trim()
      if (text) assistantTexts.push(text)
    } else if (event.type === 'tool/call') {
      const data = event.data as { name?: string; arguments?: unknown }
      if (data.name) toolNames.push(data.name)
      const args = data.arguments as { file_path?: string; path?: string; command?: string } | undefined
      if (args?.file_path) files.push(args.file_path)
      if (args?.path) files.push(args.path)
    }
  }
  const finalText = assistantTexts[assistantTexts.length - 1] ?? ''
  const summary = finalText.length > 400 ? `${finalText.slice(0, 400)}…` : finalText
  for (const name of new Set(toolNames)) decisions.push(`调用了 ${name}`)
  return {
    topicSetId,
    branchSessionId,
    timeStart,
    timeEnd,
    summary,
    decisions,
    files: [...new Set(files)].slice(0, 20),
    nextSteps: [],
    reqIds: [],
    sourceSessionId: branchSessionId,
    sourceSeqStart: events[0]?.seq ?? 0,
    sourceSeqEnd: events[events.length - 1]?.seq ?? 0,
  }
}

/** The hub-facing relay text for one dispatch outcome. */
function relayText(dispatch: { task: string; branchSessionId: string }, episode: Episode | undefined, failure?: string): string {
  const head = `[supermemory-relay ${dispatch.branchSessionId}]`
  if (failure) {
    return `${head}\n任务：${dispatch.task}\n结果：分支未成功完成（${failure}）。以上为失败事实，未伪装成答案。`
  }
  const body = episode?.summary || '（分支已完成，但未生成摘要）'
  return `${head}\n任务：${dispatch.task}\n分支结果：\n${body}`
}

/** Attach observation + delivery; returns the effect disposer. */
export function attachObserve(ctx: Context, deps: ObserveDeps): () => void {
  if (!deps.config.enabled) return () => {}
  const { store, logger } = deps

  const off = ctx.on('session/event', (session, event: SessionEventLike) => {
    if (event.type !== 'turn/end') return
    const branchSessionId = String(session.id)
    // Detached on purpose, but never an unhandled rejection: a settle failure
    // must not escape into the session-event waterfall.
    void settleOpenDispatches(deps, branchSessionId, event.seq)
      .catch((error) => logger.warn("supermemory: settle failed: " + String(error).slice(0, 160)))
  })

  // outbox confirmation: a relay message landing in the hub log confirms it
  const offConfirm = ctx.on('session/event', (session, event: SessionEventLike) => {
    if (event.type !== 'user/message') return
    const message = event.data as UserMessageLike
    const deliveryId = message.source?.deliveryId
    if (!deliveryId || message.source?.kind !== 'supermemory') return
    const item = store.outbox.get(deliveryId)
    if (item && item.status !== 'confirmed') {
      void store.outbox.update(deliveryId, (r) => ({ ...r, status: 'confirmed', relayedAt: Date.now() }))
        .then(() => logger.info(`supermemory: delivery ${deliveryId} confirmed in ${String(session.id).slice(0, 13)}`))
        .catch(() => { /* confirmation is best-effort */ })
    }
  })

  return () => { off(); offConfirm() }
}

/**
 * Settle every open dispatch of one branch against its durable log. Called by
 * the live `turn/end` listener (with that event's seq) and by startup
 * reconciliation (with no bound) so a dispatch whose turn ended while the
 * plugin was down still settles exactly once.
 */
export async function settleOpenDispatches(deps: ObserveDeps, branchSessionId: string, turnEndSeq?: number): Promise<void> {
  // Wait for the branch's previous settle, then run so this trigger's own
  // turn/end bound is honoured (serialised, not dropped).
  const inFlight = settlingBranches.get(branchSessionId)
  if (inFlight) await inFlight.catch(() => { /* the previous pass reported its own failure */ })
  const run = settleBranch(deps, branchSessionId, turnEndSeq)
  settlingBranches.set(branchSessionId, run)
  try {
    await run
  } finally {
    if (settlingBranches.get(branchSessionId) === run) settlingBranches.delete(branchSessionId)
  }
}

/** The settle body; runs under the per-branch lock above. */
async function settleBranch(deps: ObserveDeps, branchSessionId: string, turnEndSeq?: number): Promise<void> {
  const { ctx, store, logger } = deps
  const open: Array<[string, Dispatch]> = []
  for (const [dispatchId, record] of store.dispatches.entries()) {
    if (record.branchSessionId !== branchSessionId) continue
    if (record.status === 'delivered' || record.status === 'failed') continue
    if (turnEndSeq !== undefined && record.startSeq >= turnEndSeq) continue
    open.push([dispatchId, record])
  }
  if (open.length === 0) return

  const events = await coldRead(ctx, branchSessionId, -1, turnEndSeq)
  const touchedGroups = new Set<string>()
  for (const [dispatchId, record] of open) {
    try {
      const ownership = locateOwnership(events, record.startSeq)
      if (!ownership) {
        // Not our input: another writer fed this branch. Conservative skip.
        logger.info(`supermemory: dispatch ${dispatchId} has no owned input yet; waiting`)
        continue
      }
      if (record.groupId) touchedGroups.add(record.groupId)
      if (turnEndSeq !== undefined && ownership.turnEndSeq > turnEndSeq) continue // a later turn closes ours
      const owned = events.filter((e) => e.seq > ownership.messageSeq && e.seq <= ownership.turnEndSeq)
      const reason = (ownership.reason as { kind?: string } | undefined)?.kind ?? 'error'

      if (reason === 'completed' || (reason === 'max-tokens' && deps.config.maxTokensPolicy === 'deliver-partial')) {
        const episode = buildEpisode(owned, dispatchId, record.topicSetId ?? '', branchSessionId)
        const episodeId = newId('epi')
        await store.episodes.put(episodeId, episode)
        // D6: group members never relay individually — the group summary does.
        if (!record.groupId) {
          await deliver(deps, { dispatchId, record, text: relayText(record, episode) })
        }
        await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'delivered', turnEndReason: reason, updatedAt: Date.now() }))
        await updateMember(store, record.topicSetId ?? '', branchSessionId, { status: 'idle' })
        logger.info(`supermemory: dispatch ${dispatchId} completed → episode ${episodeId}${record.groupId ? ' (group member)' : ''}`)
      } else {
        const failure = reason === 'max-tokens' ? '输出达到上限被截断' : `分支终态 ${reason}`
        if (!record.groupId) {
          await deliver(deps, { dispatchId, record, text: relayText(record, undefined, failure) })
        }
        await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'failed', turnEndReason: reason, updatedAt: Date.now() }))
        await updateMember(store, record.topicSetId ?? '', branchSessionId, { status: 'idle' })
        logger.info(`supermemory: dispatch ${dispatchId} failed (${reason})`)
      }
    } catch (error) {
      logger.warn(`supermemory: observe ${dispatchId} failed: ${String(error).slice(0, 200)}`)
    }
  }

  // D6: a group relays once, after ALL members reached any terminal state.
  for (const groupId of touchedGroups) {
    try {
      if (!groupComplete(store, groupId) || groupRelayExists(store, groupId)) continue
      const text = groupRelayText(store, groupId, groupEpisodeSummaries(store, groupId))
      const members = groupMembers(store, groupId)
      const hubSessionId = members[0]?.[1].hubSessionId
      if (!hubSessionId) continue
      await deliver(deps, { dispatchId: groupId, record: { hubSessionId }, text, groupId })
      logger.info(`supermemory: group ${groupId} relayed (${members.length} members)`)
    } catch (error) {
      logger.warn(`supermemory: group relay ${groupId} failed: ${String(error).slice(0, 200)}`)
    }
  }
}

/** Enqueue + send one relay delivery to the hub (at-least-once, idempotent). */
async function deliver(
  deps: ObserveDeps,
  input: { dispatchId: string; record: { hubSessionId: string }; text: string; groupId?: string },
): Promise<void> {
  const { ctx, store, logger } = deps
  // STABLE idempotency key (file header contract): one relay per dispatch or
  // group, so a retried delivery overwrites its outbox row instead of piling up
  // duplicates and the hub's confirmation can match it.
  const deliveryId = input.groupId ? "dlv-grp-" + input.groupId : "dlv-" + input.dispatchId
  await store.outbox.put(deliveryId, {
    dispatchId: input.groupId ? undefined : input.dispatchId,
    groupId: input.groupId,
    kind: input.groupId ? 'group' : 'single',
    payload: input.text,
    status: 'pending',
    enqueuedAt: Date.now(),
  })
  const hub = ctx.agents.get(input.record.hubSessionId as never)
  if (!hub) {
    logger.info(`supermemory: hub ${input.record.hubSessionId.slice(0, 13)} not live; delivery ${deliveryId} stays pending`)
    return
  }
  try {
    const factory = await messageFactory()
    hub.followup(factory({
      content: [{ type: 'text', text: input.text }],
      source: { kind: 'supermemory', form: 'relay', deliveryId },
    }) as never)
    await store.outbox.update(deliveryId, (r) => ({ ...r, status: 'relayed', relayedAt: Date.now() }))
    logger.info(`supermemory: relayed ${deliveryId} to hub`)
  } catch (error) {
    logger.warn(`supermemory: relay ${deliveryId} failed: ${String(error).slice(0, 160)}`)
  }
}

/**
 * Self-healing delivery pass (the at-least-once contract).
 *
 * Two windows used to strand results permanently:
 *   - a group whose members ALL became terminal right before a crash/reload
 *     never got its single relay (the live path only scans groups touched by
 *     the current settle, and startup reconcile returned early when no
 *     dispatch was open);
 *   - an outbox row whose hub was not live stayed pending forever, because the
 *     only retry attempt was one startup pass.
 * Called from startup reconciliation and from the periodic sweep in apply().
 */
export async function flushObserve(deps: ObserveDeps): Promise<void> {
  const { ctx, store, logger } = deps

  // ---- 1. completed groups whose relay row is missing ----
  const groupIds = new Set<string>()
  for (const [, record] of store.dispatches.entries()) {
    if (record.groupId) groupIds.add(record.groupId)
  }
  for (const groupId of groupIds) {
    try {
      if (!groupComplete(store, groupId) || groupRelayExists(store, groupId)) continue
      const members = groupMembers(store, groupId)
      const hubSessionId = members[0]?.[1].hubSessionId
      if (!hubSessionId) continue
      await deliver(deps, {
        dispatchId: groupId,
        record: { hubSessionId },
        text: groupRelayText(store, groupId, groupEpisodeSummaries(store, groupId)),
        groupId,
      })
      logger.info("supermemory: group " + groupId + " relayed by flush")
    } catch (error) {
      logger.warn("supermemory: group flush " + groupId + " failed: " + String(error).slice(0, 160))
    }
  }

  // ---- 2. pending outbox rows whose hub is live again ----
  for (const [deliveryId, item] of [...store.outbox.entries()]) {
    if (item.status !== 'pending') continue
    const hubSessionId = item.dispatchId
      ? store.dispatches.get(item.dispatchId)?.hubSessionId
      : (item.groupId ? groupMembers(store, item.groupId)[0]?.[1].hubSessionId : undefined)
    if (!hubSessionId) continue
    const hub = ctx.agents.get(hubSessionId as never) as
      | {
          followup?: (message: unknown) => void
          inbox?: {
            nextTurn?: Array<{ source?: { deliveryId?: string } }>
            nextStep?: Array<{ source?: { deliveryId?: string } }>
          }
        }
      | undefined
    if (!hub?.followup) continue
    // Already queued in the hub's pending inbox: it confirms when claimed.
    const queued = [...(hub.inbox?.nextTurn ?? []), ...(hub.inbox?.nextStep ?? [])]
      .some((message) => message.source?.deliveryId === deliveryId)
    if (queued) continue
    try {
      const factory = await messageFactory()
      hub.followup(factory({
        content: [{ type: 'text', text: item.payload }],
        source: { kind: 'supermemory', form: 'relay', deliveryId },
      }) as never)
      await store.outbox.update(deliveryId, (r) => ({ ...r, status: 'relayed', relayedAt: Date.now() }))
      logger.info("supermemory: flushed pending delivery " + deliveryId)
    } catch (error) {
      logger.warn("supermemory: flush delivery " + deliveryId + " failed: " + String(error).slice(0, 160))
    }
  }
}

