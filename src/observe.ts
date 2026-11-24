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
import type { Dispatch, Episode, Question } from './schema.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'
import { openQuestionsOfDispatch, renderQuestionsBlock } from './questions.ts'
import { clipRelayResult, episodeResult } from './relay-text.ts'
import { updateMember } from './topicsets.ts'
import { relaySource, type ChatCardKind } from './chat-card.ts'
import { sessionTitleOf, type TitleHost } from './title.ts'

export interface ObserveConfig {
  enabled: boolean
  maxTokensPolicy: 'deliver-partial' | 'fail'
  /** D: silence longer than this marks an open dispatch as interrupted. */
  interruptAfterMs?: number
}

export interface ObserveDeps {
  ctx: Context
  store: Store
  config: ObserveConfig
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
  /**
   * R33: optional message factory seam. Production leaves it absent (the host
   * `createUserMessage` is loaded lazily); host-free gates inject a fake so the
   * delivery/outbox card fields can be asserted without a DSH install.
   */
  createMessage?: MessageFactory
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
  // R25: dispatch/resume inputs land as kind 'user': the host's session-list
  // recency only advances for a user/message whose source.kind is 'user', which
  // is what puts a reused/resumed branch back on top. Recall/notice/relay cards
  // stay 'supermemory' and are context, never an input.
  //
  // Known boundary: a human message typed INSIDE a branch is also kind 'user',
  // so a first-match scan could attribute that turn to an open dispatch. It is
  // acceptable: the plugin appends its input immediately after recording the
  // dispatch, so the claimed user/message inside the window is ours in practice.
  if (message.source?.kind !== 'user') return false
  const form = message.source?.form
  return form !== 'recall' && form !== 'notice' && form !== 'relay'
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

/** `summary` is the memory-facing short form; the full answer lives in `result`. */
const EPISODE_SUMMARY_MAX = 400

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
  // `summary` stays short on purpose; `result` below keeps the full answer for
  // the hub-facing relay (see schema.ts and relay-text.ts).
  const summary = finalText.length > EPISODE_SUMMARY_MAX ? `${finalText.slice(0, EPISODE_SUMMARY_MAX)}…` : finalText
  for (const name of new Set(toolNames)) decisions.push(`调用了 ${name}`)
  return {
    topicSetId,
    branchSessionId,
    timeStart,
    timeEnd,
    summary,
    result: finalText,
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
function relayText(
  dispatch: { task: string; branchSessionId: string },
  episode: Episode | undefined,
  failure?: string,
  questions: readonly Question[] = [],
): string {
  const head = `[supermemory-relay ${dispatch.branchSessionId}]`
  const questionBlock = renderQuestionsBlock(questions)
  const tail = questionBlock ? `\n\n${questionBlock}` : ''
  if (failure) {
    // D: an aborted turn still produced work — keep the partial result so the
    // hub learns what DID land before the branch died.
    const partialText = episodeResult(episode)
    const partial = partialText ? `\n已完成部分：${clipRelayResult(partialText, dispatch.branchSessionId)}` : ''
    // E: 分支没跑完时告诉 hub 怎么继续——中断任务由用户决定续跑。
    const resumeHint = '\n如需继续该任务：memory_resume（无参查看清单，带 dispatchId 续跑）或 /memory resume。'
    return `${head}\n任务：${dispatch.task}\n结果：分支未成功完成（${failure}）。${partial}\n以上为失败事实，未伪装成答案。${resumeHint}${tail}`
  }
  const body = clipRelayResult(episodeResult(episode), dispatch.branchSessionId) || '（分支已完成，但未生成摘要）'
  return `${head}\n任务：${dispatch.task}\n分支结果：\n${body}${tail}`
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

  // D heartbeat: while a branch is working it emits events, so a dispatch that
  // stopped receiving them is provably silent (used by the timeout sweep).
  const lastBeat = new Map<string, number>()
  const openOf = (branchSessionId: string): Array<[string, Dispatch]> => {
    const rows: Array<[string, Dispatch]> = []
    for (const [dispatchId, record] of store.dispatches.entries()) {
      if (record.branchSessionId !== branchSessionId) continue
      if (record.status === 'delivered' || record.status === 'failed' || record.status === 'interrupted') continue
      rows.push([dispatchId, record])
    }
    return rows
  }
  const offBeat = ctx.on('session/event', (session, _event: SessionEventLike) => {
    const branchSessionId = String(session.id)
    const now = Date.now()
    if (now - (lastBeat.get(branchSessionId) ?? 0) < 30000) return
    const open = openOf(branchSessionId)
    if (open.length === 0) return
    lastBeat.set(branchSessionId, now)
    for (const [dispatchId] of open) {
      void store.dispatches.update(dispatchId, (r) => ({ ...r, lastActivityAt: now }))
        .catch(() => { /* heartbeat is best-effort */ })
    }
  })

  return () => { off(); offConfirm(); offBeat() }
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
    // R19 fix: `interrupted` is terminal (it was already relayed by the interrupt
    // sweep). A late turn/end must not rewrite that verdict back to delivered
    // and desynchronise it from the group summary the hub already received.
    if (record.status === 'delivered' || record.status === 'failed' || record.status === 'interrupted') continue
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
          await deliver(deps, {
            dispatchId, record,
            text: relayText(record, episode, undefined, openQuestionsOfDispatch(store, dispatchId)),
          })
        }
        await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'delivered', turnEndReason: reason, updatedAt: Date.now() }))
        await updateMember(store, record.topicSetId ?? '', branchSessionId, { status: 'idle' })
        logger.info(`supermemory: dispatch ${dispatchId} completed → episode ${episodeId}${record.groupId ? ' (group member)' : ''}`)
      } else {
        const failure = reason === 'max-tokens' ? '输出达到上限被截断' : `分支终态 ${reason}`
        // D: summarize what the aborted turn managed to do (never disguised).
        const partial = owned.length > 0
          ? buildEpisode(owned, dispatchId, record.topicSetId ?? '', branchSessionId)
          : undefined
        if (!record.groupId) {
          await deliver(deps, {
            dispatchId, record,
            text: relayText(record, partial, failure, openQuestionsOfDispatch(store, dispatchId)),
          })
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

/** Card identity the relay message/source carries (R32/R33). */
export interface RelayCardFields {
  fromSessionId: string
  fromTitle: string
  fromKind: ChatCardKind
  task: string
  topicSetTitle: string
  capability: string
}

/** Optional overrides when a card field is already known by the caller/outbox. */
export interface RelayCardInput {
  dispatchId?: string
  groupId?: string
  fromSessionId?: string
  fromTitle?: string
  fromKind?: ChatCardKind
  task?: string
  topicSetTitle?: string
  capability?: string
}

/**
 * Resolve every card field for one relay from durable rows.
 *
 * R33 需求⑦:
 *   - a GROUP's source session is its first member BRANCH (`branchSessionId`),
 *     not the group id; the group id is its own card row;
 *   - task / topic set / capability are carried in both directions (they used to
 *     be dropped for relays, so the branch→hub card rows were always empty);
 *   - a pre-R33 outbox row (no persisted fields) is reconstructed from the
 *     dispatch row / group member, and a missing title is looked up live.
 *
 * Pure except for the optional `sessionTitleOf` host read; never throws (a
 * missing table answers ''), so a host-free fixture can still deliver.
 */
export function relayCardFields(
  ctx: TitleHost,
  store: Store,
  input: RelayCardInput,
): RelayCardFields {
  let dispatch: Dispatch | undefined
  let groupFirst: Dispatch | undefined
  try {
    dispatch = input.dispatchId ? store.dispatches.get(input.dispatchId) : undefined
    groupFirst = input.groupId ? groupMembers(store, input.groupId)[0]?.[1] : undefined
  } catch { /* a closing/partial store keeps the empty defaults */ }
  const record = dispatch ?? groupFirst
  const fromKind: ChatCardKind = input.fromKind ?? (input.groupId ? 'group' : 'branch')
  const fromSessionId = String(
    input.fromSessionId ?? record?.branchSessionId ?? '',
  ).trim()
  let topicSetTitle = String(input.topicSetTitle ?? '').trim()
  if (!topicSetTitle && record?.topicSetId) {
    try {
      topicSetTitle = String(store.topicsets?.get?.(record.topicSetId)?.title ?? '').trim()
    } catch { /* optional label */ }
  }
  let fromTitle = String(input.fromTitle ?? '').trim()
  if (!fromTitle && fromSessionId) {
    try {
      fromTitle = String(sessionTitleOf(ctx, store, fromSessionId) ?? '').trim()
    } catch { /* optional label */ }
  }
  if (!fromTitle && input.groupId) {
    fromTitle = topicSetTitle ? `并行组 · ${topicSetTitle}` : '并行组'
  }
  return {
    fromSessionId,
    fromTitle,
    fromKind,
    task: String(input.task ?? record?.task ?? ''),
    topicSetTitle,
    capability: String(input.capability ?? record?.capability ?? ''),
  }
}

/** Enqueue + send one relay delivery to the hub (at-least-once, idempotent). */
async function deliver(
  deps: ObserveDeps,
  input: {
    dispatchId: string
    record: { hubSessionId: string }
    text: string
    groupId?: string
    deliveryId?: string
    /** R32: explicit card source when the caller is not a single dispatch row. */
    fromSessionId?: string
    fromTitle?: string
    fromKind?: ChatCardKind
  },
): Promise<void> {
  const { ctx, store, logger } = deps
  // STABLE idempotency key (file header contract): one relay per dispatch or
  // group, so a retried delivery overwrites its outbox row instead of piling up
  // duplicates and the hub's confirmation can match it. E: an explicit override
  // lets non-settle relays (startup interrupted notice) reuse this channel.
  const deliveryId = input.deliveryId ?? (input.groupId ? "dlv-grp-" + input.groupId : "dlv-" + input.dispatchId)
  // R32 需求③ / R33 需求⑦: the card fields are resolved NOW (while the branch
  // session and its dispatch row are live) and persisted with the outbox row,
  // so a restart re-delivery still says "来自 <来源会话>" with the same task/set/
  // capability rows. A group's source is the FIRST MEMBER BRANCH — never the
  // group id (which used to be shown as if it were a session).
  const card = relayCardFields(ctx, store, {
    dispatchId: input.dispatchId,
    groupId: input.groupId,
    ...(input.fromSessionId === undefined ? {} : { fromSessionId: input.fromSessionId }),
    ...(input.fromTitle === undefined ? {} : { fromTitle: input.fromTitle }),
    ...(input.fromKind === undefined ? {} : { fromKind: input.fromKind }),
  })
  await store.outbox.put(deliveryId, {
    dispatchId: input.groupId ? undefined : (input.dispatchId || undefined),
    groupId: input.groupId,
    kind: input.groupId ? 'group' : 'single',
    payload: input.text,
    status: 'pending',
    enqueuedAt: Date.now(),
    ...(card.fromSessionId ? { fromSessionId: card.fromSessionId } : {}),
    ...(card.fromTitle ? { fromTitle: card.fromTitle } : {}),
    ...(card.fromKind ? { fromKind: card.fromKind } : {}),
    task: card.task,
    topicSetTitle: card.topicSetTitle,
    capability: card.capability,
  })
  const hub = ctx.agents.get(input.record.hubSessionId as never)
  if (!hub) {
    logger.info(`supermemory: hub ${input.record.hubSessionId.slice(0, 13)} not live; delivery ${deliveryId} stays pending`)
    return
  }
  try {
    const factory = deps.createMessage ?? await messageFactory()
    hub.followup(factory({
      content: [{ type: 'text', text: input.text }],
      source: relaySource({
        deliveryId,
        ...(card.fromSessionId ? { fromSessionId: card.fromSessionId } : {}),
        ...(card.fromTitle ? { fromTitle: card.fromTitle } : {}),
        fromKind: card.fromKind,
        ...(input.groupId ? { groupId: input.groupId } : { dispatchId: input.dispatchId }),
        ...(card.task ? { task: card.task } : {}),
        ...(card.topicSetTitle ? { topicSetTitle: card.topicSetTitle } : {}),
        ...(card.capability ? { capability: card.capability } : {}),
        status: 'returned',
      }) as never,
    }) as never)
    await store.outbox.update(deliveryId, (r) => ({ ...r, status: 'relayed', relayedAt: Date.now() }))
    logger.info(`supermemory: relayed ${deliveryId} to hub`)
  } catch (error) {
    logger.warn(`supermemory: relay ${deliveryId} failed: ${String(error).slice(0, 160)}`)
  }
}

/**
 * Delivery seam for non-settle relays (the startup interrupted notice, resume.ts):
 * same at-least-once outbox contract with a caller-supplied stable deliveryId.
 */
export async function deliverRelay(
  deps: ObserveDeps,
  input: {
    deliveryId: string
    dispatchId?: string
    hubSessionId: string
    text: string
    fromSessionId?: string
    fromTitle?: string
    fromKind?: ChatCardKind
  },
): Promise<void> {
  await deliver(deps, {
    dispatchId: input.dispatchId ?? '',
    record: { hubSessionId: input.hubSessionId },
    text: input.text,
    deliveryId: input.deliveryId,
    ...(input.fromSessionId === undefined ? {} : { fromSessionId: input.fromSessionId }),
    ...(input.fromTitle === undefined ? {} : { fromTitle: input.fromTitle }),
    ...(input.fromKind === undefined ? {} : { fromKind: input.fromKind }),
  })
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
      // R33 需求⑦: a row written before R32/R33 may carry no source fields at
      // all. Resolve them from the dispatch / group member (including the real
      // branch title), then PERSIST them with the relayed status so the next
      // restart does not have to reconstruct them again.
      const card = relayCardFields(ctx, store, {
        ...(item.dispatchId === undefined ? {} : { dispatchId: item.dispatchId }),
        ...(item.groupId === undefined ? {} : { groupId: item.groupId }),
        ...(item.fromSessionId ? { fromSessionId: item.fromSessionId } : {}),
        ...(item.fromTitle ? { fromTitle: item.fromTitle } : {}),
        ...(item.fromKind ? { fromKind: item.fromKind } : {}),
        ...(item.task ? { task: item.task } : {}),
        ...(item.topicSetTitle ? { topicSetTitle: item.topicSetTitle } : {}),
        ...(item.capability ? { capability: item.capability } : {}),
      })
      const factory = deps.createMessage ?? await messageFactory()
      hub.followup(factory({
        content: [{ type: 'text', text: item.payload }],
        source: relaySource({
          deliveryId,
          ...(card.fromSessionId ? { fromSessionId: card.fromSessionId } : {}),
          ...(card.fromTitle ? { fromTitle: card.fromTitle } : {}),
          fromKind: card.fromKind,
          ...(item.groupId ? { groupId: item.groupId } : { dispatchId: item.dispatchId ?? '' }),
          ...(card.task ? { task: card.task } : {}),
          ...(card.topicSetTitle ? { topicSetTitle: card.topicSetTitle } : {}),
          ...(card.capability ? { capability: card.capability } : {}),
          status: 'returned',
        }) as never,
      }) as never)
      await store.outbox.update(deliveryId, (r) => ({
        ...r,
        ...(card.fromSessionId ? { fromSessionId: card.fromSessionId } : {}),
        ...(card.fromTitle ? { fromTitle: card.fromTitle } : {}),
        fromKind: card.fromKind,
        task: card.task,
        topicSetTitle: card.topicSetTitle,
        capability: card.capability,
        status: 'relayed',
        relayedAt: Date.now(),
      }))
      logger.info("supermemory: flushed pending delivery " + deliveryId)
    } catch (error) {
      logger.warn("supermemory: flush delivery " + deliveryId + " failed: " + String(error).slice(0, 160))
    }
  }
}

/** Options of one interrupt-settlement pass (D). */
export interface InterruptOptions {
  /** No activity for longer than this marks an open dispatch as interrupted. */
  timeoutMs: number
  /** Clock override for tests. */
  now?: number
  /** Cause written into the relay (default: 超时未结算). */
  reason?: string
  /** Startup pass: only backfill terminal dispatches, never interrupt live ones. */
  terminalOnly?: boolean
}

/**
 * D: turn silence into a relay.
 *
 * A branch that is stopped / crashes / is unloaded never emits `turn/end`, so the
 * live settle path can never fire and the hub waits forever. This pass runs from
 * the periodic sweep, from plugin disposal and from startup reconciliation:
 *  - an open dispatch whose heartbeat is older than `timeoutMs` is marked
 *    `interrupted` and relayed once (idempotent through the outbox key);
 *  - a terminal dispatch that never reached the hub (crash between settle and
 *    deliver) is backfilled with the same one-shot relay.
 * Group members are skipped: their single relay belongs to the group.
 */
export async function settleInterruptedDispatches(
  deps: ObserveDeps,
  options: InterruptOptions,
): Promise<string[]> {
  const { store, logger } = deps
  const now = options.now ?? Date.now()
  const settled: string[] = []
  const touchedGroups = new Set<string>()
  for (const [dispatchId, record] of [...store.dispatches.entries()]) {
    if (record.status === 'delivered') continue
    const deliveryId = 'dlv-' + dispatchId
    // Already relayed / queued: flushObserve owns retries, never duplicate here.
    if (store.outbox.get(deliveryId)) continue
    const idleSince = record.lastActivityAt ?? record.updatedAt
    const stale = now - idleSince >= options.timeoutMs
    const terminal = record.status === 'failed' || record.status === 'interrupted'
    // A terminal dispatch that never reached the hub is always backfilled; an
    // open one is interrupted only when it is stale (or when the caller wants it).
    if (!terminal) {
      if (options.terminalOnly) continue
      if (!stale) continue
    }
    const reason = terminal
      ? `分支中断（${record.turnEndReason ? '终态 ' + record.turnEndReason : (options.reason ?? '未结算')}）`
      : `分支中断（${options.reason ?? '超时未结算'}）`
    if (record.groupId) touchedGroups.add(record.groupId)
    try {
      const partial = await partialSummary(deps, record)
      if (!record.groupId) {
        // 投递失败（例如 dispose 期间宿主服务已不可用）绝不能把派发留在 open：
        // outbox 行已先行落账，标记 interrupted 之后由 flushObserve 自愈重投，
        // 回执永远不会丢（D 兜底与 E 续跑共同的前提）。
        try {
          await deliver(deps, {
            dispatchId, record,
            text: relayText(record, partial, reason, openQuestionsOfDispatch(store, dispatchId)),
          })
        } catch (error) {
          logger.warn(`supermemory: interrupt relay ${dispatchId} deferred: ${String(error).slice(0, 160)}`)
        }
      }
      await store.dispatches.update(dispatchId, (r) => ({
        ...r,
        status: 'interrupted',
        turnEndReason: r.turnEndReason ?? (options.reason ?? 'silent'),
        updatedAt: Date.now(),
      }))
      settled.push(dispatchId)
      logger.info(`supermemory: dispatch ${dispatchId} interrupted (${reason})`)
    } catch (error) {
      logger.warn(`supermemory: interrupt settle ${dispatchId} failed: ${String(error).slice(0, 160)}`)
    }
  }
  // R19 fix: `interrupted` is a terminal member state, so this sweep must also
  // close the group NOW (a member that stops emitting turn/end would otherwise
  // withhold the single group relay until the next flushObserve pass — or
  // forever, while groupComplete ignored interrupted).
  for (const groupId of touchedGroups) {
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
      logger.info(`supermemory: group ${groupId} relayed by interrupt sweep (${members.length} members)`)
    } catch (error) {
      logger.warn(`supermemory: interrupt group relay ${groupId} failed: ${String(error).slice(0, 160)}`)
    }
  }
  return settled
}

/** Best-effort partial episode for an interrupted branch (never blocks a relay). */
async function partialSummary(deps: ObserveDeps, record: Dispatch): Promise<Episode | undefined> {
  const persistence = (deps.ctx as unknown as { sessionPersistence?: unknown }).sessionPersistence
  if (!persistence || !record.branchSessionId) return undefined
  try {
    const events = await coldRead(deps.ctx, record.branchSessionId, record.startSeq)
    if (events.length === 0) return undefined
    return buildEpisode(events, record.branchSessionId, record.topicSetId ?? '', record.branchSessionId)
  } catch {
    return undefined
  }
}

