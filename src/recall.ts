/**
 * Rule-based recall: keyword overlap plus time decay (P0 简化版).
 *
 * Tokenisation handles mixed Chinese/Latin text: ASCII word tokens plus CJK
 * character bigrams, so 「构建命令」 and "build command" both produce matchable
 * units without any LLM call. LLM failure can never degrade this path because
 * there is no LLM in it.
 * @module supermemory/recall
 */
import { charCount, clipWithNote, dropNote } from './clip.ts'
import { renderRecordLine } from './retrieval.ts'
import type { Memory } from './schema.ts'

export interface RecallItem {
  memoryId: string
  title: string
  text: string
  score: number
  createdAt: number
  keywords: string[]
}

/**
 * Field weights for one record's token bag (R10).
 *
 * The whole point of the title + tags + body shape is that a query can be
 * answered from the index: a title hit is worth four body hits, a tag hit
 * three, so an exact title/tag match outranks a record that merely mentions
 * the word once deep in its prose.
 */
const TITLE_WEIGHT = 4
const TAG_WEIGHT = 3
const BODY_WEIGHT = 1

export interface RecallOptions {
  limit: number
  minScore: number
  halfLifeDays: number
  now: number
}

const LATIN = /[a-zA-Z0-9_+#.\-]{2,}/g
const CJK = /[\u4e00-\u9fff]/g

/** Split text into matchable tokens (latin words + CJK bigrams). */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(LATIN)) tokens.push(m[0])
  const chars = text.match(CJK) ?? []
  for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1])
  if (chars.length === 1) tokens.push(chars[0])
  return tokens
}

function decay(createdAt: number, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000)
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays))
}

/**
 * Raw match score of one memory against weighted query tokens (no decay).
 * `minScore: 1` therefore means "at least one matched token", independent of
 * the record's age — decay only reorders the survivors.
 */
export function rawScore(memory: Memory, queryTokens: Map<string, number>): number {
  if (memory.status !== 'active') return 0
  const fold = (text: string): Map<string, number> => {
    const bag = new Map<string, number>()
    for (const token of tokenize(text)) bag.set(token, (bag.get(token) ?? 0) + 1)
    return bag
  }
  // Defensive on purpose: records written before the title/tag columns existed
  // (and fixtures built without them) must still score; `?? ''` keeps the
  // index fields optional at the boundary.
  const titleBag = fold(memory.title ?? '')
  const tagBag = fold((memory.keywords ?? []).join(' '))
  const bodyBag = fold(memory.text ?? '')
  if (titleBag.size + tagBag.size + bodyBag.size === 0) return 0
  let raw = 0
  for (const [token, weight] of queryTokens) {
    // Each field contributes at most twice the token weight, and only a body
    // hit is filtered: the index fields are short by construction.
    const titleHits = titleBag.get(token) ?? 0
    const tagHits = tagBag.get(token) ?? 0
    const bodyHits = bodyBag.get(token) ?? 0
    raw += weight * TITLE_WEIGHT * Math.min(titleHits, 2)
    raw += weight * TAG_WEIGHT * Math.min(tagHits, 2)
    raw += weight * BODY_WEIGHT * Math.min(bodyHits, 2)
  }
  return raw
}

/** Query token weights: tokens rarer in the query corpus weigh more. */
export function queryWeights(query: string): Map<string, number> {
  const tokens = tokenize(query)
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  const weights = new Map<string, number>()
  for (const [token, count] of counts) weights.set(token, 1 / Math.sqrt(count))
  return weights
}

/** Rank active memories of one workspace against a query. */
export function recallMemories(
  memories: Iterable<[string, Memory]>,
  query: string,
  options: RecallOptions,
): RecallItem[] {
  const weights = queryWeights(query)
  if (weights.size === 0) return []
  const scored: RecallItem[] = []
  for (const [memoryId, memory] of memories) {
    // The threshold gates on the RAW match count; decay only orders results.
    const raw = rawScore(memory, weights)
    if (raw < options.minScore) continue
    scored.push({
      memoryId,
      title: memory.title ?? '',
      text: memory.text,
      score: raw * decay(memory.createdAt, options.now, options.halfLifeDays),
      createdAt: memory.createdAt,
      keywords: memory.keywords,
    })
  }
  scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
  return scored.slice(0, options.limit)
}

/** One topic set matched by the user's query/recalled memories (R19 需求⑧). */
export interface TopicSetMatch {
  id: string
  title: string
  tags: string[]
  score: number
}

/** Minimal topic-set shape the matcher reads (archived sets take no part). */
interface TopicSetLike {
  title: string
  summary?: string
  keywords?: readonly string[]
  status?: string
}

/**
 * R19 需求⑧: when a user need matches memories, surface the topic set those
 * conclusions belong to, so the hub can answer from — or activate — the right
 * set immediately instead of searching again.
 *
 * Matching is the same index-weighted rule as memory recall (title ×3, tags ×2,
 * body ×1), and archived sets are ignored. It is pure and LLM-free.
 */
export function matchTopicSets(
  topicSets: Iterable<[string, TopicSetLike]>,
  query: string,
  limit = 3,
): TopicSetMatch[] {
  const weights = queryWeights(query)
  if (weights.size === 0) return []
  const matches: TopicSetMatch[] = []
  for (const [id, topicSet] of topicSets) {
    if (topicSet.status && topicSet.status !== 'active') continue
    const fold = (text: string): Map<string, number> => {
      const bag = new Map<string, number>()
      for (const token of tokenize(text)) bag.set(token, (bag.get(token) ?? 0) + 1)
      return bag
    }
    const titleBag = fold(topicSet.title ?? '')
    const tagBag = fold((topicSet.keywords ?? []).join(' '))
    const bodyBag = fold(topicSet.summary ?? '')
    let score = 0
    for (const [token, weight] of weights) {
      score += weight * 3 * Math.min(titleBag.get(token) ?? 0, 2)
      score += weight * 2 * Math.min(tagBag.get(token) ?? 0, 2)
      score += weight * 1 * Math.min(bodyBag.get(token) ?? 0, 2)
    }
    if (score <= 0) continue
    matches.push({ id, title: topicSet.title, tags: [...(topicSet.keywords ?? [])], score })
  }
  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, Math.max(1, Math.min(limit, 8)))
}

/** A clipped body needs at least this much room for body + omission note. */
export const RECALL_BODY_MIN = 64

/** The topic-set hint is kept only while this much room remains for records. */
const HINT_MIN_ROOM = 96

/** Build the model-facing recall card text (温和起步, injectStyle 可配置).
 *
 * R47 需求②: `options.budget` makes the card budget-aware instead of letting
 * the caller hard-`slice` it (the old `.slice(0, maxChars)` in prestep.ts cut
 * mid-sentence, mid-tag, with no sign that anything was missing). Degradation
 * is by PRIORITY, never mid-body:
 *   1. the header is paid for first; the topic-set hint is kept only while it
 *      still leaves room for a record — a card must not become all preamble;
 *   2. records are kept whole while they fit (score order = relevance order);
 *   3. a record that no longer fits whole has its BODY clipped at a sentence
 *      boundary with an explicit omission note (title/tags stay whole);
 *   4. a record whose remaining share cannot hold a meaningful body
 *      (`RECALL_BODY_MIN`) is dropped WHOLE, and a later, smaller record may
 *      still take its place;
 *   5. the card ends with `…（已省略 k 项…）` when anything was dropped.
 *
 * Accounting counts CODE POINTS and reserves one newline per line, so the
 * assembled card never exceeds `options.budget`; the note is budgeted too (an
 * overflow retries with the note's real length reserved, bounded attempts).
 */
export function renderRecallCard(
  items: RecallItem[],
  style: 'gentle' | 'plain',
  topicSets: readonly TopicSetMatch[] = [],
  options: { budget?: number; hint?: string } = {},
): string {
  if (items.length === 0) return ''
  const budget = options.budget && options.budget > 0 ? Math.floor(options.budget) : 0
  const header = style === 'plain'
    ? ['[SuperMemory 相关记忆]']
    : [
        '[SuperMemory 相关记忆]',
        '以下记忆可能与本话题相关，仅供参考；与当前指令冲突时以当前指令为准。',
        '记忆只存结论性事实/决策（不是过程流水账）。',
      ]
  const hints = topicSets.length > 0
    ? [`相关话题集：${topicSets.map((topicSet) => topicSet.title).join('、')}（命中记忆时可直接激活或派发到该集）`]
    : []
  // No budget: the legacy behaviour — every record whole, caller decides.
  if (!budget) {
    const lines = items.map((item, index) =>
      `${index + 1}. ${renderRecordLine({ title: item.title, text: item.text, tags: item.keywords })}`)
    return [...header, ...lines, ...hints].join('\n')
  }
  // A tiny budget (a user can set recall.maxChars very low) cannot pay for the
  // three-line gentle preamble AND one record. The card degrades to its single
  // identifying line instead of overrunning the budget: the records are the
  // context, the preamble is etiquette.
  const minimal = ['[SuperMemory 相关记忆]']
  const minimalCost = minimal.reduce((sum, line) => sum + charCount(line) + 1, 0)
  if (budget - minimalCost < RECALL_BODY_MIN + 52) {
    header.length = 0
    header.push(...minimal)
  }
  const headerCost = header.reduce((sum, line) => sum + charCount(line) + 1, 0)
  const hintCostAll = hints.reduce((sum, line) => sum + charCount(line) + 1, 0)
  const compose = (reserve: number, withHint = true): { text: string; note: string; count: number } => {
    // A hint that would leave less than one record's room is dropped whole
    // (never clipped): the routing aid is worth less than the context itself.
    const hintLines = budget - headerCost - hintCostAll - reserve >= HINT_MIN_ROOM ? hints : []
    const hintCost = hintLines.reduce((sum, line) => sum + charCount(line) + 1, 0)
    let remaining = budget - headerCost - hintCost - reserve
    const lines: string[] = []
    let dropped = 0
    for (const [index, item] of items.entries()) {
      const prefix = `${index + 1}. `
      const tail = item.keywords.length > 0 ? ` ｜标签: ${item.keywords.join('、')}` : ''
      const head = item.title && item.title !== item.text.trim() ? `【${item.title}】` : ''
      // Cost the record can never give up: number + title + tags + its newline.
      const overhead = charCount(prefix) + charCount(head) + charCount(tail) + 1
      const whole = `${prefix}${head}${item.text}${tail}`
      const wholeCost = charCount(whole) + 1
      if (wholeCost <= remaining) {
        lines.push(whole)
        remaining -= wholeCost
        continue
      }
      // Shrink the body only when a meaningful share is left; otherwise drop
      // the record whole and let a later, smaller one take the place.
      const bodyShare = remaining - overhead
      if (bodyShare >= RECALL_BODY_MIN) {
        const body = clipWithNote(item.text, bodyShare, item.title ? `复取：memory_recall 「${item.title}」` : undefined)
        const line = `${prefix}${head}${body}${tail}`
        lines.push(line)
        remaining -= charCount(line) + 1
        if (remaining <= 0) {
          dropped += items.length - index - 1
          break
        }
        continue
      }
      dropped += 1
    }
    const note = dropNote(dropped, withHint ? options.hint : undefined)
    const text = [...header, ...hintLines, ...lines, ...(note ? [note] : [])].join('\n')
    return { text, note, count: dropped }
  }
  let pass = compose(0)
  for (let attempt = 0; attempt < 3 && pass.note; attempt += 1) {
    if (charCount(pass.text) <= budget) break
    pass = compose(charCount(pass.note) + 1)
  }
  // Last resort: the note's quoted query is longer than the record it replaces.
  // Fall back to the bare re-fetch note so the card still says what it left out
  // and how to see it. Below the header + that note the budget cannot express
  // any record, so the card is not injected at all (never a silent slice).
  if (charCount(pass.text) > budget && pass.count > 0) {
    pass = compose(charCount(dropNote(pass.count)) + 1, false)
    if (charCount(pass.text) > budget) return ''
  }
  return pass.text
}
