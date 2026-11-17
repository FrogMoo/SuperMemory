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

export interface ReconcileDeps {
  ctx: Context
  store: Store
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
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

/** Send one failure delivery to the hub (explicit failure, never disguised). */
async function failureDelivery(deps: ReconcileDeps, record: { hubSessionId: string; task: string; branchSessionId: string }, reason: string): Promise<void> {
  const { ctx, logger } = deps
  const hub = ctx.agents.get(record.hubSessionId as never)
  if (!hub) {
    logger.info(`supermemory: failure delivery for ${record.branchSessionId.slice(0, 13)} stays undelivered (hub not live)`)
    return
  }
  try {
    const llm = await loadHostModule('@deepseek-ai/dsh-llm')
    const make = llm.createUserMessage as (input: { content: Array<{ type: 'text'; text: string }>; source: Record<string, unknown> }) => unknown
    hub.followup(make({
      content: [{
        type: 'text',
        text: `[supermemory-relay ${record.branchSessionId}]\n任务：${record.task}\n结果：${reason}`,
      }],
      source: { kind: 'supermemory', form: 'relay', deliveryId: `dlv-${record.branchSessionId}-failed` },
    }) as never)
  } catch (error) {
    logger.warn(`supermemory: failure delivery failed: ${String(error).slice(0, 160)}`)
  }
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
      try {
        const { settleOpenDispatches } = await import('./observe.ts')
        await settleOpenDispatches({
          ...deps,
          config: { enabled: true, maxTokensPolicy: 'deliver-partial' },
        }, record.branchSessionId)
        const after = store.dispatches.get(dispatchId)
        if (after && after.status !== record.status) {
          logger.info(`supermemory: reconcile ${dispatchId}: settled from ${record.status} → ${after.status}`)
        }
      } catch (error) {
        logger.warn(`supermemory: reconcile path1 ${dispatchId} failed: ${String(error).slice(0, 160)}`)
      }
    }

    // ---- path 3: queued dispatches whose branch never saw the input ----
    for (const [dispatchId, record] of [...store.dispatches.entries()]) {
      if (record.status !== 'queued' && record.status !== 'dispatched') continue
      if (!record.branchSessionId) continue
      try {
        const events = await coldRead(ctx, record.branchSessionId, -1)
        // The dispatch input lands as an inbox splice (or a committed
        // user/message on the success path) with a supermemory source.
        const traced = events.some((e) => (e.type === 'agent/inbox/spliced'
          && ((e.data as { inserted?: Array<{ source?: { kind?: string } }> })?.inserted?.some((m) => m.source?.kind === 'supermemory') ?? false))
          || (e.type === 'user/message' && (e.data as UserMessageLike)?.source?.kind === 'supermemory'))
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
            } catch (error) {
              logger.warn(`supermemory: reconcile ${dispatchId}: resume failed: ${String(error).slice(0, 160)}`)
            }
          }
          if (!target) {
            await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'failed', turnEndReason: 'branch-died', updatedAt: Date.now() }))
            await failureDelivery(deps, record, '分支在执行前已不存在（重启/重载导致），未伪装成答案。')
            continue
          }
          const make = await ensureFactory()
          target.followup(make({
            content: [{
              type: 'text',
              text: `[supermemory-dispatch ${dispatchId}]\n任务：${record.task}\n\n（重启恢复：重新派发）`,
            }],
            source: { kind: 'supermemory', form: 'instructions' },
          }) as never)
          logger.info(`supermemory: reconcile ${dispatchId}: re-followed branch`)
          continue
        }
        // traced but no owning turn/end yet: either still working, or the
        // branch died with the input on disk (e.g. plugin remount). A dead
        // branch must not strand the dispatch forever.
        const inputSeq = events.findIndex((e) => (e.type === 'agent/inbox/spliced'
          && ((e.data as { inserted?: Array<{ source?: { kind?: string } }> })?.inserted?.some((m) => m.source?.kind === 'supermemory') ?? false))
          || (e.type === 'user/message' && (e.data as UserMessageLike)?.source?.kind === 'supermemory'))
        const turnEndAfter = inputSeq >= 0 && events.some((e, index) => index > inputSeq && e.type === 'turn/end')
        if (turnEndAfter || branch) continue
        logger.info(`supermemory: reconcile ${dispatchId}: branch dead with input on disk; failing dispatch`)
        await store.dispatches.update(dispatchId, (r) => ({ ...r, status: 'failed', turnEndReason: 'branch-died', updatedAt: Date.now() }))
        await failureDelivery(deps, record, '分支在执行中消失（重启/重载导致），未伪装成答案。')
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
        hub.followup(make({
          content: [{ type: 'text', text: item.payload }],
          source: { kind: 'supermemory', form: 'relay', deliveryId },
        }) as never)
        await store.outbox.update(deliveryId, (r) => ({ ...r, status: 'relayed', relayedAt: Date.now() }))
        logger.info(`supermemory: reconcile ${deliveryId}: re-relayed to hub`)
      } catch (error) {
        logger.warn(`supermemory: reconcile path2 ${deliveryId} failed: ${String(error).slice(0, 160)}`)
      }
    }

    // ---- path 1: pending outbox with terminal dispatch → advance summary ----
    for (const [deliveryId, item] of [...store.outbox.entries()]) {
      if (item.status !== 'pending') continue
      const record = item.dispatchId ? store.dispatches.get(item.dispatchId) : undefined
      if (!record || (record.status !== 'delivered' && record.status !== 'failed')) continue
      try {
        await store.outbox.update(deliveryId, (r) => ({ ...r, status: 'relayed', relayedAt: Date.now() }))
        logger.info(`supermemory: reconcile ${deliveryId}: dispatch already ${record.status}; marked relayed`)
      } catch (error) {
        logger.warn(`supermemory: reconcile path1 ${deliveryId} failed: ${String(error).slice(0, 160)}`)
      }
    }
    logger.info('supermemory: reconciliation pass complete')
  })()
}
