/**
 * Maintenance loop (decision D2): persistent `turn/end` events feed a
 * background queue with a durable per-session cursor.
 *
 * `agent/turn-stopping` is a serial blocking checkpoint — heavy work there
 * would delay `turn/end` itself, so nothing heavy runs inline. This listener
 * only enqueues; the queue drains detached, and every failure is contained.
 * The durable cursor (`hotcache.lastMaintainedSeq`) makes restart
 * reconciliation a cold read, not a guess.
 * @module supermemory/maintenance
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLike, UserMessageLike } from './events.ts'
import { extractFacts } from './extract.ts'
import { extractRequirements, rememberRequirements } from './requirements.ts'
import type { Memory, Signal } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import './services.ts'


export interface MaintenanceConfig {
  enabled: boolean
  signalsThreshold: number
  summaryEveryTurns: number
}

interface BufferedUser {
  seq: number
  text: string
}

interface Task {
  sessionId: string
  seq: number
}

interface ColdResult {
  users: BufferedUser[]
  turnEndSeqs: number[]
  workspaceKey?: string
}

const BUFFER_CAP = 50

/** In-memory debounce counter for the rolling topic-set summary. */
const summaryTurns = new Map<string, number>()

/** Attach the maintenance loop; returns the effect disposer. */
export function attachMaintenance(
  ctx: Context,
  store: Store | undefined,
  config: MaintenanceConfig,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): () => void {
  if (!store || !config.enabled) return () => {}
  const activeStore: Store = store

  const buffers = new Map<string, BufferedUser[]>()
  const cursors = new Map<string, number>()
  const queue: Task[] = []
  let pumping = false
  let disposed = false

  // Seed cursors from the durable hotcache so a restart resumes, not replays.
  for (const [sessionId, entry] of activeStore.hotcache.entries()) {
    if (entry.lastMaintainedSeq !== undefined) cursors.set(sessionId, entry.lastMaintainedSeq)
  }

  const bufferFor = (sessionId: string) => {
    let buffer = buffers.get(sessionId)
    if (!buffer) {
      buffer = []
      buffers.set(sessionId, buffer)
    }
    return buffer
  }

  const off = ctx.on('session/event', (session, event: SessionEventLike) => {
    if (disposed) return
    const sessionId = String(session.id)
    if (event.type !== 'user/message' && event.type !== 'turn/end') return
    if (event.type === 'user/message') {
      const message = event.data as unknown as UserMessageLike
      if (message.source?.kind !== 'user') return
      const text = textOfMessage(message)
      if (!text) return
      const buffer = bufferFor(sessionId)
      buffer.push({ seq: event.seq, text })
      if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP)
      return
    }
    if (event.type === 'turn/end') {
      queue.push({ sessionId, seq: event.seq })
      void pump()
    }
  })

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (!disposed && queue.length > 0) {
        const task = queue.shift()!
        try {
          await process(task)
        } catch (error) {
          logger.warn(`supermemory: maintenance task failed (${task.sessionId}@${task.seq}): ${String(error)}`)
        }
      }
    } finally {
      pumping = false
    }
  }

  async function process(task: Task): Promise<void> {
    const cursor = cursors.get(task.sessionId) ?? -1
    let users = (buffers.get(task.sessionId) ?? []).filter((u) => u.seq > cursor)
    let workspaceKey: string | undefined
    const live = ctx.sessions.get(task.sessionId)
    if (live) workspaceKey = workspaceKeyOf(live.header?.cwd)
    if (users.length === 0 || workspaceKey === undefined) {
      // Catch-up / cold path: read the durable log for this turn's user input.
      const cold = await coldRead(task.sessionId, cursor, task.seq)
      if (cold) {
        if (users.length === 0) users = cold.users
        workspaceKey ??= cold.workspaceKey
      }
    }
    buffers.set(task.sessionId, [])
    if (workspaceKey === undefined || users.length === 0) {
      cursors.set(task.sessionId, task.seq)
      await persistCursor(task.sessionId, task.seq)
      return
    }

    const now = Date.now()
    const createdIds: string[] = []
    const reqIds: string[] = []
    for (const user of users) {
      for (const fact of extractFacts(user.text)) {
        const memoryId = await rememberFact(activeStore, workspaceKey, fact.text, fact.keywords, task.sessionId, user.seq, now)
        if (memoryId) {
          createdIds.push(memoryId)
          countSignal(activeStore, workspaceKey, fact.keywords[0] ?? fact.text.slice(0, 12), fact.text, now)
        }
      }
      // P2: standing requirements (必须/需要/待办/...) join the same turn.
      const reqTexts = extractRequirements(user.text)
      if (reqTexts.length > 0) {
        const created = await rememberRequirements(activeStore, workspaceKey, reqTexts, task.sessionId, user.seq, now)
        reqIds.push(...created)
      }
    }
    // Clear only after a successful pass: a failed extraction keeps the buffer
    // so the next turn replays those messages (text dedupe prevents doubles).
    buffers.set(task.sessionId, [])
    cursors.set(task.sessionId, task.seq)
    await persistCursor(task.sessionId, task.seq, createdIds)
    // §2.1 (4): rolling topic-set summary, debounced by turn count.
    rollSummary(activeStore, task.sessionId, users, config.summaryEveryTurns, logger)
    if (createdIds.length > 0 || reqIds.length > 0) {
      logger.info(`supermemory: +${createdIds.length} memories, +${reqIds.length} requirements from ${task.sessionId}@${task.seq}`)
    }
    // §2.3: repeated tool sequences feed the tool-ization pipeline.
    await countSequenceSignal(activeStore, ctx, task.sessionId, workspaceKey, cursor, task.seq, config.signalsThreshold, logger)
  }

  async function persistCursor(sessionId: string, seq: number, createdIds: string[] = []): Promise<void> {
    const existing = activeStore.hotcache.get(sessionId)
    const recentRelevant = existing?.recentRelevant ?? { episodes: [], reqIds: [], memoryIds: [], toolNames: [] }
    const memoryIds = [...createdIds, ...recentRelevant.memoryIds].slice(0, 10)
    await activeStore.hotcache.put(sessionId, {
      recentRelevant: { ...recentRelevant, memoryIds },
      lastMaintainedSeq: seq,
      updatedAt: Date.now(),
    })
  }

  /** Cold-read one session's durable log through the persistence seam. */
  async function coldRead(sessionId: string, afterSeq: number, untilSeq: number): Promise<ColdResult | undefined> {
    let handle: Awaited<ReturnType<typeof ctx.sessionPersistence.open>> | undefined
    try {
      handle = await ctx.sessionPersistence.open(sessionId, 'read')
      const { events } = await handle.read(afterSeq + 1)
      const users: BufferedUser[] = []
      const turnEndSeqs: number[] = []
      for (const event of events) {
        if (event.seq > untilSeq) break
        if (event.type === 'user/message') {
          const message = event.data as unknown as UserMessageLike
          if (message.source?.kind !== 'user') continue
          const text = textOfMessage(message)
          if (text) users.push({ seq: event.seq, text })
        } else if (event.type === 'turn/end') {
          turnEndSeqs.push(event.seq)
        }
      }
      return {
        users, turnEndSeqs,
        workspaceKey: handle.header?.cwd ? workspaceKeyOf(handle.header.cwd) : undefined,
      }
    } catch {
      return undefined
    } finally {
      void handle?.close?.()
    }
  }

  // Startup reconciliation (§2.4 path 1, P0 scope): replay every session whose
  // durable cursor lags its persisted log. Runs detached; failures are logged.
  void (async () => {
    for (const [sessionId, cursor] of [...cursors]) {
      try {
        const cold = await coldRead(sessionId, cursor, Number.MAX_SAFE_INTEGER)
        if (!cold || cold.users.length === 0) continue
        const missed = cold.turnEndSeqs.filter((seq) => seq > cursor)
        if (missed.length === 0) continue
        logger.info(`supermemory: reconciling ${missed.length} missed turn(s) for ${sessionId}`)
        for (const seq of missed) queue.push({ sessionId, seq })
        void pump()
      } catch (error) {
        logger.warn(`supermemory: reconciliation failed for ${sessionId}: ${String(error)}`)
      }
    }
  })()

  return () => {
    disposed = true
    off()
  }
}

/** Plain text of one message's content blocks. */
function textOfMessage(message: UserMessageLike): string {
  return (message.content ?? [])
    .map((block) => (block.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean).join('\n')
}

/**
 * §2.1 (4): rolling topic-set summary. Rule-based and debounced by an
 * in-memory turn counter (a remount restarts the count — acceptable for a
 * debounce; the durable state is the summary itself).
 */
function rollSummary(
  store: Store,
  sessionId: string,
  users: BufferedUser[],
  everyNTurns: number,
  logger: { info: (msg: string) => void },
): void {
  const routing = store.routing.get(sessionId)
  if (!routing?.activeTopicSetId) return
  const topicSet = store.topicsets.get(routing.activeTopicSetId)
  if (!topicSet) return
  const count = (summaryTurns.get(sessionId) ?? 0) + 1
  summaryTurns.set(sessionId, count)
  if (count % Math.max(1, everyNTurns) !== 0 && users.length === 0) return
  const last = users[users.length - 1]?.text?.trim() ?? ''
  if (!last) return
  const snippet = last.replace(/\s+/g, ' ').slice(0, 60)
  const summary = `${topicSet.summary}${topicSet.summary ? ' / ' : ''}${snippet}`.slice(0, 300)
  void store.topicsets.update(routing.activeTopicSetId, (record) => ({
    ...record,
    summary,
    updatedAt: Date.now(),
  })).then(() => {
    logger.info(`supermemory: rolled summary for ${routing.activeTopicSetId}`)
  }).catch(() => { /* summary roll is best-effort */ })
}

/**
 * §2.3: count one turn's tool-call sequence as a tool-ization signal, and
 * raise a pending proposal once it crosses the threshold. Samples carry the
 * recorded arguments for later composite compilation.
 */
async function countSequenceSignal(
  store: Store,
  ctx: Context,
  sessionId: string,
  workspaceKey: string,
  afterSeq: number,
  untilSeq: number,
  threshold: number,
  logger: { info: (msg: string) => void },
): Promise<void> {
  let tools: string[] = []
  const args: Array<Record<string, unknown>> = []
  const { sequenceKey, parseArgs } = await import('./composite.ts')
  try {
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read(afterSeq + 1)
      for (const event of events) {
        if (event.seq > untilSeq) break
        if (event.type !== 'tool/call') continue
        const data = event.data as unknown as { name?: string; arguments?: unknown }
        if (!data.name) continue
        tools.push(data.name)
        args.push(parseArgs(data.arguments))
      }
    } finally {
      await handle.close()
    }
  } catch {
    return // a cold-read failure never breaks maintenance
  }
  if (tools.length < 2) return // single-tool turns are not sequences
  const key = sequenceKey(workspaceKey, tools)
  const existing = store.signals.get(key)
  const now = Date.now()
  const samples = [...(existing?.samples ?? []), JSON.stringify({ tools, args })].slice(-3)
  const crossed = existing?.proposedAt === undefined && (existing?.count ?? 0) + 1 >= threshold
  const signal: Signal = {
    workspaceKey,
    pattern: tools.join('>'),
    count: (existing?.count ?? 0) + 1,
    lastSeen: now,
    examples: [...(existing?.examples ?? []), `${tools.join(' → ')}`].slice(-3),
    sequence: tools,
    samples,
    proposedAt: crossed ? now : existing?.proposedAt,
    proposalStatus: crossed ? 'pending' as const : existing?.proposalStatus,
  }
  await store.signals.put(key, signal)
  if (signal.proposalStatus === 'pending') {
    logger.info(`supermemory: tool-ization proposal raised for ${tools.join('>')} (count=${signal.count})`)
  }
}

/** Write one fact, skipping exact duplicates within the workspace. */async function rememberFact(
  store: Store,
  workspaceKey: string,
  text: string,
  keywords: string[],
  sourceSessionId: string,
  sourceSeq: number,
  now: number,
): Promise<string | undefined> {
  const normalized = text.trim().toLowerCase()
  for (const [, record] of store.memories.entries()) {
    if (record.workspaceKey === workspaceKey && record.status === 'active'
      && record.text.trim().toLowerCase() === normalized) {
      return undefined
    }
  }
  const memoryId = newId('mem')
  const memory: Memory = {
    workspaceKey, text, keywords, sourceSessionId, sourceSeq,
    status: 'active', createdAt: now, updatedAt: now,
  }
  await store.memories.put(memoryId, memory)
  return memoryId
}

/** Increment the repeated-pattern counter (P3 tool-ization input). */
function countSignal(store: Store, workspaceKey: string, pattern: string, example: string, now: number): void {
  if (!pattern) return
  const signalKey = `ws/${workspaceKey}/${pattern}`
  const existing = store.signals.get(signalKey)
  const signal: Signal = existing
    ? { ...existing, count: existing.count + 1, lastSeen: now, examples: [...existing.examples, example].slice(-5) }
    : { workspaceKey, pattern, count: 1, lastSeen: now, examples: [example], sequence: [], samples: [] }
  void store.signals.put(signalKey, signal).catch(() => {
    // Signals are advisory; a failed count must never break maintenance.
  })
}
