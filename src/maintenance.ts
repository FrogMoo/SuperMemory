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
import type { Memory, Signal } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import './services.ts'


export interface MaintenanceConfig {
  enabled: boolean
  signalsThreshold: number
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
    for (const user of users) {
      for (const fact of extractFacts(user.text)) {
        const memoryId = await rememberFact(activeStore, workspaceKey, fact.text, fact.keywords, task.sessionId, user.seq, now)
        if (memoryId) {
          createdIds.push(memoryId)
          countSignal(activeStore, workspaceKey, fact.keywords[0] ?? fact.text.slice(0, 12), fact.text, now)
        }
      }
    }
    // Clear only after a successful pass: a failed extraction keeps the buffer
    // so the next turn replays those messages (text dedupe prevents doubles).
    buffers.set(task.sessionId, [])
    cursors.set(task.sessionId, task.seq)
    try {
      await persistCursor(task.sessionId, task.seq, createdIds)
    } catch (error) {
      throw error
    }
    if (createdIds.length > 0) {
      logger.info(`supermemory: +${createdIds.length} memories from ${task.sessionId}@${task.seq}`)
    }
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

/** Write one fact, skipping exact duplicates within the workspace. */
async function rememberFact(
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
    : { workspaceKey, pattern, count: 1, lastSeen: now, examples: [example] }
  void store.signals.put(signalKey, signal).catch(() => {
    // Signals are advisory; a failed count must never break maintenance.
  })
}
