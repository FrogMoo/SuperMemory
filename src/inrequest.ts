/**
 * In-request recall (requirement A): repeat recall while ONE user request runs.
 *
 * Host event surface (verified against @deepseek-ai/dsh-agent and
 * @deepseek-ai/dsh-tools 0.2.2-rc.3 sources under _dsh_src):
 *
 * - agent/pre-step is a per-STEP waterfall: dsh-agent-loop agent.ts#preStep runs
 *   for every model step of a turn and receives the claimed inbox messages. An
 *   enter decision carries messages, the ONLY place where a plugin may append
 *   model-visible, durably logged content. A tool-continuation step claims no
 *   user message, which is why the old guard (inject only when a user-source
 *   message exists) produced exactly one card per request.
 * - agent/request is deprecated and documented as unable to mutate messages.
 * - systemPrompt sections are assembled BEFORE the pre-step waterfall and must be
 *   pure/synchronous (no recall I/O); runtimeContext is a read-only projection.
 * - tools/pre-execute only allows/denies/cancels/asks: PreToolDecision has no
 *   context field, so it cannot carry a card (the old composite hint wrote
 *   additionalContexts there and was silently dropped). tools/post-execute DOES
 *   accept additionalContexts for the next request; tools/result is an isolated
 *   observer whose failures are contained.
 * => the per-step pre-step waterfall is the single safe injection point.
 *
 * This module is host-free (pure functions plus an in-memory tracker) so the
 * smoke scripts can exercise it under Node type stripping.
 * @module supermemory/inrequest
 */
import { RECALL_BODY_MIN, recallMemories, renderRecallCard, tokenize, type RecallItem, type RecallOptions } from './recall.ts'
import { charCount, clipWithNote, dropNote } from './clip.ts'
import { renderRecordLine } from './retrieval.ts'
import type { Memory } from './schema.ts'
import type { Store } from './store.ts'

/** Configuration of the in-request repeat path (recall.repeat). */
export interface RepeatConfig {
  enabled: boolean
  everySteps: number
  maxCardsPerRequest: number
  maxCharsPerRequest: number
  dedupe: boolean
  hotSignal: boolean
}

/** One tool result observed during the current request. */
export interface ToolObservation {
  name: string
  args: Record<string, unknown>
  text: string
  isError: boolean
}

/** Per-session state of one request (reset by the first pre-step with user input). */
export interface RequestState {
  turn: number
  step: number
  lastRecallStep: number
  toolCalls: number
  cards: number
  chars: number
  injectedIds: Set<string>
  baseQuery: string
  toolText: string
  recent: ToolObservation[]
  seenPaths: Set<string>
  bestOverlap: number
  hot: boolean
  hinted: Set<string>
}

/** Why a later pre-step injected another card. */
export type RepeatTrigger = 'tools' | 'hot'

const MAX_SESSIONS = 128
const MAX_RECENT = 8
const TOOL_TEXT_CAP = 1200
const PATH_PATTERN = /[A-Za-z]:[\\/][^\s;)\]]{2,}|(?:\.{0,2}\/)[\w.\-]+(?:\/[\w.\-]+)+/g
const ERROR_PATTERN = /(^|[^A-Za-z])(error|exception|failed|failure|fatal|ENOENT|EACCES|EPERM|TypeError|ReferenceError|SyntaxError)([^A-Za-z]|)|错误|失败|异常|报错/i

/** Clamp one string to a character budget (never throws). */
export function clampText(text: string, cap: number): string {
  if (typeof text !== 'string') return ''
  if (text.length <= cap) return text
  return text.slice(0, cap)
}

/** Start a fresh request state. */
export function newState(turn: number, step: number, query: string): RequestState {
  return {
    turn,
    step,
    lastRecallStep: step,
    toolCalls: 0,
    cards: 0,
    chars: 0,
    injectedIds: new Set(),
    baseQuery: clampText(query, 2000),
    toolText: '',
    recent: [],
    seenPaths: new Set(),
    bestOverlap: 0,
    hot: false,
    hinted: new Set(),
  }
}

/** File-path-looking tokens in one tool output (Windows and POSIX forms). */
export function extractPaths(text: string): string[] {
  if (!text) return []
  const found = text.match(PATH_PATTERN)
  if (!found) return []
  return [...new Set(found)].slice(0, 12)
}

/** Cheap error heuristic over a tool output. */
export function looksLikeError(text: string): boolean {
  if (!text) return false
  return ERROR_PATTERN.test(text)
}

/**
 * Best keyword overlap between one observation and the workspace memories.
 * Counts DISTINCT query tokens hitting one memory and caps the scan, so a huge
 * store can never turn one tool result into a hot spot for the hub.
 */
export function memoryOverlap(text: string, memories: Iterable<[string, Memory]>, cap: number): number {
  const tokens = new Set(tokenize(clampText(text, 800)))
  if (tokens.size === 0) return 0
  const wanted = new Set<string>()
  for (const token of tokens) {
    if (token.length < 2) continue
    wanted.add(token)
    if (wanted.size >= 60) break
  }
  let best = 0
  let checked = 0
  for (const entry of memories) {
    const memory = entry[1]
    if (memory.status !== 'active') continue
    checked += 1
    if (checked > cap) break
    const hay = new Set(tokenize(memory.text + ' ' + memory.keywords.join(' ')))
    let hits = 0
    for (const token of wanted) if (hay.has(token)) hits += 1
    if (hits > best) best = hits
  }
  return best
}

/**
 * Record one tool result in the request state and decide whether it carried a
 * high-signal change. Conservative by design: a bare new path is routine (an
 * agent touches many files); it becomes hot only together with a real keyword
 * overlap, and an overlap only counts when it clearly rises.
 */
export function observe(
  state: RequestState,
  observation: ToolObservation,
  config: RepeatConfig,
  memories: Iterable<[string, Memory]>,
  memoryCap: number,
): void {
  state.toolCalls += 1
  state.recent.push({
    name: observation.name,
    args: observation.args,
    text: clampText(observation.text, 600),
    isError: observation.isError,
  })
  if (state.recent.length > MAX_RECENT) state.recent.splice(0, state.recent.length - MAX_RECENT)
  state.toolText = clampText((state.toolText + '\n' + observation.text).trim(), TOOL_TEXT_CAP)
  if (!config.hotSignal) return
  if (observation.isError || looksLikeError(observation.text)) {
    state.hot = true
    return
  }
  const newPaths = extractPaths(observation.text).filter((path) => !state.seenPaths.has(path))
  for (const path of newPaths) state.seenPaths.add(path)
  const overlap = memoryOverlap(observation.text, memories, memoryCap)
  if (newPaths.length > 0 && overlap >= 3) state.hot = true
  if (overlap >= state.bestOverlap + 2 && overlap >= 4) state.hot = true
  if (overlap > state.bestOverlap) state.bestOverlap = overlap
}

/** Why (if at all) this step should inject another card. */
export function triggerOf(state: RequestState, step: number, config: RepeatConfig): RepeatTrigger | undefined {
  state.step = step
  if (!config.enabled) return undefined
  const every = Math.max(1, Math.floor(config.everySteps || 3))
  if (state.toolCalls >= every) return 'tools'
  if (config.hotSignal && state.hot) return 'hot'
  return undefined
}

/** Whether the per-request card budget still allows one more card. */
export function canInjectCard(state: RequestState, config: RepeatConfig): boolean {
  if (!config.enabled) return false
  if (state.cards >= Math.max(1, Math.floor(config.maxCardsPerRequest || 1))) return false
  if (state.chars >= Math.max(200, Math.floor(config.maxCharsPerRequest || 6000))) return false
  return true
}

/** Remaining per-request character budget for one more card. */
export function remainingChars(state: RequestState, config: RepeatConfig): number {
  return Math.max(0, Math.floor(config.maxCharsPerRequest || 6000) - state.chars)
}

/** Query for a repeat recall: this request's user text plus recent tool output. */
export function buildQuery(state: RequestState, cap: number): string {
  const parts = [state.baseQuery, state.toolText].filter((part) => Boolean(part))
  return clampText(parts.join('\n'), cap).trim()
}

/** Drop memories already injected in this request (dedupe). */
export function freshItems(items: RecallItem[], state: RequestState, config: RepeatConfig): RecallItem[] {
  if (!config.dedupe) return items
  return items.filter((item) => !state.injectedIds.has(item.memoryId))
}

/** Record an injected card: advances the trigger baseline and the budgets. */
export function commitCard(state: RequestState, step: number, items: RecallItem[], chars: number): void {
  state.lastRecallStep = step
  state.toolCalls = 0
  state.hot = false
  state.cards += 1
  state.chars += chars
  for (const item of items) state.injectedIds.add(item.memoryId)
}

/** Record a scan that produced no card, so the next trigger needs fresh calls. */
export function commitScan(state: RequestState, step: number): void {
  state.lastRecallStep = step
  state.toolCalls = 0
  state.hot = false
}

/** Rank this workspace's active memories against one query (same rules as P0). */
export function recallScoped(store: Store, workspaceKey: string, query: string, options: RecallOptions): RecallItem[] {
  const own: Array<[string, Memory]> = []
  for (const entry of store.memories.entries()) {
    const record = entry[1]
    if (record.workspaceKey === workspaceKey && record.status === 'active') own.push(entry)
  }
  return recallMemories(own, query, options)
}

/**
 * The later-in-request card: a clearly distinct header plus the composite catalog.
 *
 * R47 需求②: like the opening card, this one is budget-aware and degrades by
 * PRIORITY — header first, then memory records whole (title/tags whole), then
 * the catalog block, then clipped bodies, and only then dropped records with a
 * counted note. A catalog that would force a body clip is dropped whole
 * instead (mixing a capability hint into a card whose memory text had to be
 * cut is the wrong trade). `options.budget` omitted = legacy unbounded
 * rendering, so existing callers keep their contract.
 */
export function renderRepeatCard(
  items: RecallItem[],
  style: 'gentle' | 'plain',
  catalog: string,
  options: { budget?: number; hint?: string } = {},
): string {
  const head = style === 'plain'
    ? ['[SuperMemory 相关记忆 · 过程内补充]']
    : ['[SuperMemory 相关记忆 · 过程内补充]', '执行过程中出现了此前未注入的相关记忆，仅供参考；与当前指令冲突时以当前指令为准。']
  const budget = options.budget && options.budget > 0 ? Math.floor(options.budget) : 0
  if (!budget) {
    if (items.length === 0 && !catalog) return ''
    const lines = items.map((item, index) =>
      (index + 1) + '. ' + renderRecordLine({ title: item.title, text: item.text, tags: item.keywords }))
    return [...head, ...lines, ...(catalog ? [catalog] : [])].join('\n')
  }
  if (items.length === 0 && !catalog) return ''
  // Tiny budget: keep the single identifying line, drop the etiquette line
  // (same rule as the opening card — never overrun the budget for preamble).
  const minimal = ['[SuperMemory 相关记忆 · 过程内补充]']
  const minimalCost = charCount(minimal[0]) + 1
  if (budget - minimalCost < RECALL_BODY_MIN + 52) {
    head.length = 0
    head.push(...minimal)
  }
  const headCost = head.reduce((sum, line) => sum + charCount(line) + 1, 0)
  // No memory record: the catalog IS the card, so clip it (with a sized note)
  // rather than emit a bare header.
  if (items.length === 0) {
    const room = budget - headCost - 1
    if (charCount(catalog) <= room) return [...head, catalog].join('\n')
    return [...head, clipWithNote(catalog, Math.max(32, room), '')].join('\n')
  }
  const catalogCost = catalog ? charCount(catalog) + 1 : 0
  const build = (reserve: number, withCatalog: boolean, withHint = true): { text: string; note: string; cut: boolean; count: number } => {
    let remaining = budget - headCost - reserve - (withCatalog ? catalogCost : 0)
    const lines: string[] = []
    let dropped = 0
    let cut = false
    for (const [index, item] of items.entries()) {
      const prefix = `${index + 1}. `
      const tail = item.keywords.length > 0 ? ` ｜标签: ${item.keywords.join('、')}` : ''
      const title = item.title && item.title !== item.text.trim() ? `【${item.title}】` : ''
      const overhead = charCount(prefix) + charCount(title) + charCount(tail) + 1
      const whole = `${prefix}${title}${item.text}${tail}`
      const wholeCost = charCount(whole) + 1
      if (wholeCost <= remaining) {
        lines.push(whole)
        remaining -= wholeCost
        continue
      }
      const bodyShare = remaining - overhead
      if (bodyShare >= RECALL_BODY_MIN) {
        cut = true
        const body = clipWithNote(item.text, bodyShare, item.title ? `复取：memory_recall 「${item.title}」` : undefined)
        const line = `${prefix}${title}${body}${tail}`
        lines.push(line)
        remaining -= charCount(line) + 1
        if (remaining <= 0) {
          dropped += items.length - index - 1
          break
        }
        continue
      }
      cut = true
      dropped += 1
    }
    const note = dropNote(dropped, withHint ? options.hint : undefined)
    const parts = [
      ...head,
      ...lines,
      ...(withCatalog && catalog ? [catalog] : []),
      ...(note ? [note] : []),
    ]
    return { text: parts.join('\n'), note, cut, count: dropped }
  }
  let useCatalog = Boolean(catalog)
  let pass = build(0, useCatalog)
  if (useCatalog && pass.cut) {
    useCatalog = false
    pass = build(0, false)
  }
  for (let attempt = 0; attempt < 3 && pass.note; attempt += 1) {
    if (charCount(pass.text) <= budget) break
    pass = build(charCount(pass.note) + 1, useCatalog)
  }
  // Last resort: keep the bare re-fetch note (no quoted query) so the card
  // still fits and still says what it left out; below that floor, inject
  // nothing rather than an over-budget or silent slice.
  if (charCount(pass.text) > budget && pass.count > 0) {
    pass = build(charCount(dropNote(pass.count)) + 1, useCatalog, false)
    if (charCount(pass.text) > budget) return ''
  }
  return pass.text
}

/** In-memory request tracker shared by the pre-step and tool-activity listeners. */
export interface Tracker {
  begin(sessionId: string, turn: number, step: number, query: string): RequestState
  ensure(sessionId: string, turn: number, step: number): RequestState
  get(sessionId: string): RequestState | undefined
  observe(sessionId: string, observation: ToolObservation, config: RepeatConfig, memories: Iterable<[string, Memory]>, memoryCap: number): void
  hasHinted(sessionId: string, name: string): boolean
  markHinted(sessionId: string, name: string): void
}

/** Create a tracker bounded to MAX_SESSIONS live requests (LRU on touch). */
export function createTracker(): Tracker {
  const states = new Map<string, RequestState>()
  const touch = (sessionId: string, state: RequestState): void => {
    states.delete(sessionId)
    states.set(sessionId, state)
    while (states.size > MAX_SESSIONS) {
      const oldest = states.keys().next()
      if (oldest.done) break
      states.delete(oldest.value)
    }
  }
  return {
    begin(sessionId, turn, step, query) {
      const state = newState(turn, step, query)
      touch(sessionId, state)
      return state
    },
    ensure(sessionId, turn, step) {
      const existing = states.get(sessionId)
      if (existing && existing.turn === turn) return existing
      const state = newState(turn, step, '')
      touch(sessionId, state)
      return state
    },
    get(sessionId) {
      return states.get(sessionId)
    },
    observe(sessionId, observation, config, memories, memoryCap) {
      const state = states.get(sessionId)
      if (!state) return
      observe(state, observation, config, memories, memoryCap)
    },
    hasHinted(sessionId, name) {
      return states.get(sessionId)?.hinted.has(name) ?? false
    },
    markHinted(sessionId, name) {
      const state = states.get(sessionId)
      if (state) state.hinted.add(name)
    },
  }
}
