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
import { deriveTitle, mergeTags } from './retrieval.ts'
import type { Signal } from './schema.ts'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
// R22 需求⑤: 自动抽取的事实记忆与 memory_remember 共用集合归属判定。
import { resolveCollectionForEntry, touchCollection } from './memory-collections.ts'
// R30 需求①: 自动抽取与其他写路径共用同一套版本化创建（不允许绕过）。
import { createMemoryVersioned } from './memory-versions.ts'
import './services.ts'


export interface MaintenanceConfig {
  enabled: boolean
  signalsThreshold: number
  summaryEveryTurns: number
  autoToolize: boolean
  /** R45: 重复事务同时沉淀为 skill（默认开）。 */
  autoSkill: boolean
  toolizeCooldownMs: number
  toolizeMax: number
  toolizeMinSteps: number
  toolizeMinDistinctTools: number
  nearMissHint: boolean
  recycleIdleToolDays: number
  /** R48: same task must cross this many distinct sessions/dispatches. */
  skillMinSessions: number
  /** R48: recency window (days) for auto-creating/updating task skills. */
  skillRecencyDays: number
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
    // Only a REAL cwd may seed the key: workspaceKeyOf(undefined) yields the
    // literal 'unknown' workspace, which would strand these facts outside every
    // workspace filter instead of taking the cold-read fallback below.
    const liveCwd = live?.header?.cwd
    if (liveCwd) workspaceKey = workspaceKeyOf(liveCwd)
    if (users.length === 0 || workspaceKey === undefined) {
      // Catch-up / cold path: read the durable log for this turn's user input.
      const cold = await coldRead(task.sessionId, cursor, task.seq)
      if (cold) {
        if (users.length === 0) users = cold.users
        workspaceKey ??= cold.workspaceKey
      } else if (users.length === 0 || workspaceKey === undefined) {
        // A transient read failure must NOT advance the durable cursor: doing so
        // silently dropped those turns' facts/requirements forever. Keep the
        // buffer (and the cursor) so the next turn replays this window.
        logger.warn(`supermemory: cold read failed for ${task.sessionId}@${task.seq}; cursor kept at ${cursor}`)
        return
      }
    }
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
        const memoryId = await rememberFact(activeStore, workspaceKey, fact.text, fact.keywords, task.sessionId, user.seq, now, { ctx, logger })
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
    // §2.3 / R48: repeated tool sequences feed the legacy composite pipeline;
    // the TASK text + session id feed the task-level skill signature.
    const taskText = users.map((user) => user.text).filter(Boolean).join('\n').slice(0, 2000)
    await countSequenceSignal(activeStore, ctx, task.sessionId, workspaceKey, cursor, task.seq, config, logger, taskText, now)
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
  // Debounced by TURN COUNT. The old guard (count % N !== 0 && users.length === 0)
  // could never debounce: this path always has users, so the summary was
  // rewritten on every single turn and grew to its 300-char cap.
  if (count % Math.max(1, everyNTurns) !== 0) return
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
 * One turn's tool sequence feeds the tool-ization pipeline: R48's task signature
 * (a repeated TASK becomes a skill) plus, only when the legacy autoComposite
 * switch is on, a PENDING proposal for a sequence that names a business object.
 * R49: nothing here registers a composite — memory_toolize accept is the only
 * sequence entrance.
 */
async function countSequenceSignal(
  store: Store,
  ctx: Context,
  sessionId: string,
  workspaceKey: string,
  afterSeq: number,
  untilSeq: number,
  config: MaintenanceConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  taskText?: string,
  now: number = Date.now(),
): Promise<void> {
  let tools: string[] = []
  const args: Array<Record<string, unknown>> = []
  const { parseArgs } = await import('./composite.ts')
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
  if (tools.length < 2) return
  const { recordTurnSequences, recycleIdleComposites } = await import('./toolize.ts')
  const toolize = {
    enabled: config.autoToolize,
    autoSkill: config.autoSkill,
    threshold: config.signalsThreshold,
    cooldownMs: config.toolizeCooldownMs,
    maxActive: config.toolizeMax,
    minSteps: config.toolizeMinSteps,
    minDistinctTools: config.toolizeMinDistinctTools,
    nearMissHint: config.nearMissHint,
    recycleIdleDays: config.recycleIdleToolDays,
    skillMinSessions: config.skillMinSessions,
    skillRecencyDays: config.skillRecencyDays,
  }
  await recordTurnSequences(ctx, store, workspaceKey, tools, args, toolize, logger, undefined, {
    sessionId,
    ...(taskText ? { task: taskText } : {}),
    now,
  })
  await recycleIdleComposites(ctx, store, toolize, logger)
}

/** Write one fact, skipping exact duplicates within the workspace. */async function rememberFact(
  store: Store,
  workspaceKey: string,
  text: string,
  keywords: string[],
  sourceSessionId: string,
  sourceSeq: number,
  now: number,
  // R27 需求④.3: 自动写入同样把集合归属交给大模型判定（无 ctx = 相似度启发式）。
  deps: { ctx: Context; logger: { warn: (msg: string) => void; info?: (msg: string) => void } },
): Promise<string | undefined> {
  const normalized = text.trim().toLowerCase()
  for (const [, record] of store.memories.entries()) {
    if (record.workspaceKey === workspaceKey && record.status === 'active'
      && record.text.trim().toLowerCase() === normalized) {
      return undefined
    }
  }
  // R22 需求⑤: an auto-extracted fact joins the SAME collection layer as
  // memory_remember — a related collection is appended to, never duplicated.
  // A medium without the collection table degrades to an uncollected entry
  // (the migration in recall/remember folds it later).
  const title = deriveTitle(text)
  const tags = mergeTags([], keywords)
  const assignment = await resolveCollectionForEntry(store, workspaceKey, { title, keywords: tags, text }, { now, deps })
  if ('error' in assignment) return undefined
  // R30 需求①: 自动抽取也走版本化创建（v1 + 归档 v1 历史），不绕过版本化写入。
  const memoryId = await createMemoryVersioned(store, workspaceKey, {
    title, text,
    tags,
    ...(assignment.collectionId ? { collectionId: assignment.collectionId } : {}),
    sourceSessionId, sourceSeq,
  }, now)
  if (assignment.collectionId) await touchCollection(store, assignment.collectionId, now)
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
