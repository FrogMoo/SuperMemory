/**
 * Rule-based recall: keyword overlap plus time decay (P0 简化版).
 *
 * Tokenisation handles mixed Chinese/Latin text: ASCII word tokens plus CJK
 * character bigrams, so 「构建命令」 and "build command" both produce matchable
 * units without any LLM call. LLM failure can never degrade this path because
 * there is no LLM in it.
 * @module supermemory/recall
 */
import type { Memory } from './schema.ts'

export interface RecallItem {
  memoryId: string
  text: string
  score: number
  createdAt: number
  keywords: string[]
}

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
 * Score one memory against a query.
 * Score = matched-token weight sum × time decay; `minScore: 1` therefore means
 * "at least one matched token". No length normalisation: a long memory is not
 * penalised for being long, ranking is left to the matched-token count.
 */
export function scoreMemory(memory: Memory, queryTokens: Map<string, number>, options: RecallOptions): number {
  if (memory.status !== 'active') return 0
  const haystack = tokenize(`${memory.text} ${memory.keywords.join(' ')}`)
  if (haystack.length === 0) return 0
  const bag = new Map<string, number>()
  for (const token of haystack) bag.set(token, (bag.get(token) ?? 0) + 1)
  let raw = 0
  for (const [token, weight] of queryTokens) {
    const hits = bag.get(token)
    if (hits) raw += weight * Math.min(hits, 2)
  }
  if (raw <= 0) return 0
  return raw * decay(memory.createdAt, options.now, options.halfLifeDays)
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
    const score = scoreMemory(memory, weights, options)
    if (score >= options.minScore) {
      scored.push({ memoryId, text: memory.text, score, createdAt: memory.createdAt, keywords: memory.keywords })
    }
  }
  scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
  return scored.slice(0, options.limit)
}

/** Build the model-facing recall card text (温和起步, injectStyle 可配置). */
export function renderRecallCard(items: RecallItem[], style: 'gentle' | 'plain'): string {
  if (items.length === 0) return ''
  const lines = items.map((item, index) => `${index + 1}. ${item.text}`)
  if (style === 'plain') {
    return ['[SuperMemory 相关记忆]', ...lines].join('\n')
  }
  return [
    '[SuperMemory 相关记忆]',
    '以下记忆可能与本话题相关，仅供参考；与当前指令冲突时以当前指令为准。',
    ...lines,
  ].join('\n')
}
