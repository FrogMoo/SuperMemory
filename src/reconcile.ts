/**
 * Startup reconciliation (§2.4): the plugin applies, then drains everything
 * the previous process left mid-flight. Three paths, all idempotent:
 *   1. outbox pending with a non-terminal dispatch → re-cold-read the branch
 *      log and advance the summary (observe re-runs the ownership logic);
 *   2. outbox pending/relayed without hub confirmation → confirm from the hub
 *      log when the deliveryId is already there, otherwise re-followup;
 *   3. dispatch queued with no execution trace in the branch log → re-followup
 *      (the branch may never have been woken).
 * @module supermemory/reconcile
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLike, UserMessageLike } from './events.ts'
import { loadHostModule } from './host.ts'
import type { Store } from './store.ts'
import { branchHandles } from './dispatch.ts'
import { ensureMemberTitle, sessionTitleOf } from './title.ts'
import { applySessionTitle } from './session-title/gate.ts'
import { dispatchSource, relaySource } from './chat-card.ts'
import { flushObserve, isDispatchInput, relayCardFields, settleOpenDispatches } from './observe.ts'
import { openQuestionsOfDispatch, renderQuestionsBlock } from './questions.ts'

export interface ReconcileDeps {
  ctx: Context
  store: Store
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
  /** Live observe configuration: a restart must settle with the SAME policy. */
  observe: { enabled: boolean; maxTokensPolicy: 'deliver-partial' | 'fail'; interruptAfterMs?: number }
}

async function coldRead(ctx: Context, sessionId: string, afterSeq: number): Promise<SessionEventLike[]> {
  const persistence = ctx.sessionPersistence as unknown as {
    open(id: string, access: 'read'): Promise<{
      read(offset?: number, length?: number): Promise<{ events: SessionEventLike[] }>
      close(): Promise<void>
    }>
  }
  const handle = await persistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(afterSeq + 1)
    return events
  } finally {
    await handle.close()
  }
}

/**
 * Record one failure delivery (explicit failure, never disguised).
 *
 * The row is persisted FIRST and actually sent by the flush pass: the old code
 * returned early when the hub was not live, and since the dispatch was already
 * terminal nothing ever retried it — a restart-time failure was lost forever.
 *
 * R42 (relay 重复投递修复): the key is the CANONICAL `dlv-<dispatchId>` — the
 * same key the interrupt sweep's guard (observe.ts settleInterruptedDispatches)
 * and deliver()'s persistent guard check. It used to be `dlv-fail-<branchSessionId>`,
 * which (a) did not satisfy either guard, so a branch-died dispatch was relayed
 * TWICE (once here, once by the sweep), and (b) collided across the dispatches
 * of one branch, so a second dispatch's failure relay was silently swallowed
 * (observed in the real ledger: a dispatch with no relay row at all).
 */
async function failureDelivery(
  deps: ReconcileDeps,
  dispatchId: string,
  record: { hubSessionId: string; task: string; branchSessionId: string; topicSetId?: string },
  reason: string,
): Promise<void> {
  const { ctx, store, logger } = deps
  const deliveryId = 'dlv-' + dispatchId
  if (store.outbox.get(deliveryId)) return
  const questionBlock = renderQuestionsBlock(openQuestionsOfDispatch(store, dispatchId))
  const payload = '[supermemory-relay ' + record.branchSessionId + ']\n任务：' + record.task + '\n结果：' + reason
    + (questionBlock ? '\n\n' + questionBlock : '')
  const dispatch = store.dispatches.get(dispatchId)
  const topicSetTitle = record.topicSetId
    ? String(store.topicsets?.get?.(record.topicSetId)?.title ?? '')
    : ''
  const card = relayCardFields(ctx, store, {
    dispatchId,
    fromSessionId: record.branchSessionId,
    fromKind: 'branch',
    task: record.task,
    ...(topicSetTitle ? { topicSetTitle } : {}),
    ...(dispatch?.capability ? { capability: dispatch.capability } : {}),
  })
  await store.outbox.put(deliveryId, {
    dispatchId,
    kind: 'single',
    payload,
    status: 'pending',
    enqueuedAt: Date.now(),
    fromSessionId: record.branchSessionId,
    ...(card.fromTitle ? { fromTitle: card.fromTitle } : {}),
    fromKind: 'branch',
    task: card.task,
    topicSetTitle: card.topicSetTitle,
    capability: card.capability,
  })
  logger.info('supermemory: failure delivery ' + deliveryId + ' queued for the hub')
}

/** Run all three reconciliation paths once, detached from apply(). */
export function runReconciliation(deps: ReconcileDeps): void {
  void (async () => {
    const { ctx, store, logger } = deps
    let factory: ((input: { content: Array<{ type: 'text'; text: string }>; source: Record<string, unknown> }) => UserMessageLike) | undefined
    const ensureFactory = async () => {
      if (!factory) {
        const llm = await loadHostModule('@deepseek-ai/dsh-llm')
        factory = llm.createUserMessage as typeof factory
      }
      return factory!
    }

    // ---- path 1: dispatches whose owning turn already ended but was never
    // observed (plugin was down) — settle them through the same logic ----
    for (const [dispatchId, record] of [...store.dispatches.entries()]) {
      if (record.status !== 'dispatched' && record.status !== 'queued') continue
      if (!record.branchSessionId) continue
      if (!deps.observe.enabled) continue
      try {
        // The restart pass must settle with the USER'S policy, not a hard-coded
        // 'deliver-partial' (observe.maxTokensPolicy / enabled are configurable).
        await settleOpenDispatches({ ctx, store, logger, config: deps.observe }, record.branchSessionId)
        const after = store.dispatches.get(dispatchId)
        if (after && after.status !== record.status) {
          logger.info(`supermemory: reconcile ${dispatchId}: settled from ${record.status} → ${after.status}`)
        }
      } catch (error) {
        logger.warn(`supermemory: reconcile path1 ${dispatchId} failed: ${String(error).slice(0, 160)}`)
      }
    }

    // ---- path 3: queued dispatches whose branch never consumed the input ----
    for (const [dispatchId, record] of [...store.dispatches.entries()]) {
      if (record.status !== 'queued' && record.status !== 'dispatched') continue
      if (!record.branchSessionId) continue
      try {
        const events = (await coldRead(ctx, record.branchSessionId, -1))
          // Only THIS dispatch's window: an older dispatch's splice must not make
          // a new dispatch look "already traced" (which stranded it forever).
          .filter((e) => e.seq > record.startSeq)
        // R25: dispatch/resume inputs land as kind 'user' now, so a splice counts
        // for either kind (an in-flight record may still be 'supermemory').
        const spliced = (e: SessionEventLike) => e.type === 'agent/inbox/spliced'
          && ((e.data as { inserted?: Array<{ source?: { kind?: string } }> })?.inserted
            ?.some((m) => m.source?.kind === 'supermemory' || m.source?.kind === 'user') ?? false)
        // followup() splices the input immediately, but only the CLAIMED
        // user/message proves the branch actually consumed it.
        const claimedAt = events.findIndex((e) => e.type === 'user/message' && isDispatchInput(e.data as UserMessageLike))
        const traced = claimedAt >= 0 || events.some(spliced)
        const branch = ctx.agents.get(record.branchSessionId as never) ?? branchHandles.get(record.branchSessionId)?.agent
        if (!traced) {
          let target = branch
          if (!target) {
            // the branch died before its input landed: resume it, then re-wake
            try {
              const handle = await ctx.agents.resume({ resumeSessionId: record.branchSessionId as never })
              target = handle.agent
              branchHandles.set(record.branchSessionId, { agent: handle.agent, dispose: () => handle.dispose() })
              logger.info(`supermemory: reconcile ${dispatchId}: resumed dead branch`)
              // Requirement C: a resumed branch that was never named (pre-C
              // dispatch) gets its title on this recovery path too.
              if (record.topicSetId) {
                try {
                  const topicTitle = store.topicsets.get(record.topicSetId)?.title ?? ''
                  const named = await ensureMemberTitle(store, record.topicSetId, { sessionId: record.branchSessionId, kind: 'root' }, topicTitle, record.task, { taskOnly: true })
                  await applySessionTitle({ ctx, store, logger }, {
                    sessionId: record.branchSessionId,
                    kind: 'branch',
                    explicitTitle: named,
                    source: 'reconcile',
                    defer: true,
                  })
                } catch { /* naming is best-effort on recovery */ }
              }
            } catch (error) {
              logger.warn(`supermemory: reconcile ${dispatchId}: resume failed: ${String(error).slice(0, 160)}`)
            }
          }
          if (!target) {
            await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'failed', turnEndReason: 'branch-died', updatedAt: Date.now() }))
            await failureDelivery(deps, dispatchId, record, '分支在执行前已不存在（重启/重载导致），未伪装成答案。')
            continue
          }
          const make = await ensureFactory()
          // R32 需求③: restart re-dispatch is still a hub→branch request.
          const hubTitle = sessionTitleOf(ctx, store, record.hubSessionId)
          const topicSetTitle = record.topicSetId ? (store.topicsets.get(record.topicSetId)?.title ?? '') : ''
          target.followup(make({
            content: [{
              type: 'text',
              text: `[supermemory-dispatch ${dispatchId}]\n任务：${record.task}\n\n（重启恢复：重新派发）\n遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。`,
            }],
            // R25: 重启重投同样是派发输入（kind 'user'），否则 observe 的
            // isDispatchInput 认领不到它，这条 dispatch 会永久悬空。
            source: dispatchSource({
              fromSessionId: record.hubSessionId,
              ...(hubTitle ? { fromTitle: hubTitle } : {}),
              task: record.task,
              ...(topicSetTitle ? { topicSetTitle } : {}),
              dispatchId,
              status: 'dispatched',
            }) as never,
          }) as never)
          logger.info(`supermemory: reconcile ${dispatchId}: re-followed branch`)
          continue
        }
        // traced but no owning turn/end yet: either still working, or the
        // branch died with the input on disk (e.g. plugin remount). A dead
        // branch must not strand the dispatch forever.
        const finished = claimedAt >= 0 && events.some((e, index) => index > claimedAt && e.type === 'turn/end')
        if (finished || branch) continue
        logger.info(`supermemory: reconcile ${dispatchId}: branch dead with input on disk; failing dispatch`)
        await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'failed', turnEndReason: 'branch-died', updatedAt: Date.now() }))
        await failureDelivery(deps, dispatchId, record, '分支在执行中消失（重启/重载导致），未伪装成答案。')
      } catch (error) {
        logger.warn(`supermemory: reconcile path3 ${dispatchId} failed: ${String(error).slice(0, 160)}`)
      }
    }

    // ---- path 2: unconfirmed outbox items ----
    for (const [deliveryId, item] of [...store.outbox.entries()]) {
      if (item.status !== 'pending' && item.status !== 'relayed') continue
      // single: via its dispatch; group: via any member's hub
      let hubSessionId = item.dispatchId ? store.dispatches.get(item.dispatchId)?.hubSessionId : undefined
      if (!hubSessionId && item.groupId) {
        const { groupMembers } = await import('./group.ts')
        hubSessionId = groupMembers(store, item.groupId)[0]?.[1].hubSessionId
      }
      if (!hubSessionId) continue
      try {
        const events = await coldRead(ctx, hubSessionId, -1)
        const confirmed = events.some((e) => e.type === 'user/message'
          && (e.data as UserMessageLike)?.source?.deliveryId === deliveryId)
        if (confirmed) {
          await store.outbox.update(deliveryId, (r) => ({ ...r, status: 'confirmed', relayedAt: Date.now() }))
          logger.info(`supermemory: reconcile ${deliveryId}: confirmed from hub log`)
          continue
        }
        // §2.4 path 2: a message already queued in the hub's pending inbox
        // needs no re-send — it will confirm when claimed.
        const hubAgent = ctx.agents.get(hubSessionId as never) as
          { inbox?: { nextTurn?: Array<{ source?: { deliveryId?: string } }>; nextStep?: Array<{ source?: { deliveryId?: string } }> } } | undefined
        const queued = [...(hubAgent?.inbox?.nextTurn ?? []), ...(hubAgent?.inbox?.nextStep ?? [])]
          .some((m) => m.source?.deliveryId === deliveryId)
        if (queued) {
          logger.info(`supermemory: reconcile ${deliveryId}: already queued in hub inbox; no re-send`)
          continue
        }
        const hub = ctx.agents.get(hubSessionId as never)
        if (!hub) {
          logger.info(`supermemory: reconcile ${deliveryId}: hub not live; stays pending`)
          continue
        }
        const make = await ensureFactory()
        // R32/R33 需求⑦: prefer the source persisted with the outbox row; a
        // pre-R33 row reconstructs every field from the dispatch row / group
        // member. A GROUP's source is its first member BRANCH, never the group
        // id; groupId stays its own card row.
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
        hub.followup(make({
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
        logger.info(`supermemory: reconcile ${deliveryId}: re-relayed to hub`)
      } catch (error) {
        logger.warn(`supermemory: reconcile path2 ${deliveryId} failed: ${String(error).slice(0, 160)}`)
      }
    }

    // ---- self-healing: completed groups without a relay row, and any outbox
    // row still pending because its hub was offline. The old shortcut marked
    // those rows "relayed" without ever sending them, destroying branch results.
    await flushObserve({ ctx, store, logger, config: deps.observe })
    logger.info('supermemory: reconciliation pass complete')
  })().catch((error) => {
    deps.logger.warn(`supermemory: reconciliation pass failed: ${String(error).slice(0, 200)}`)
  })
}
