/**
 * Dispatch-side topic-set matching (R23, 治本「派发即建集」碎片化).
 *
 * When a dispatch names no topic set AND the hub session has no sticky routing,
 * the task is scored against the EXISTING sets of the SAME workspace and
 * disposed by tier:
 *  - high   → reuse that set (no new set is created);
 *  - medium → create nothing and dispatch nothing: the hub asks the user;
 *  - none   → keep the legacy behaviour (auto-create, titled after the task).
 *
 * Scoring REUSES the recall index (recall.ts: tokenize + queryWeights +
 * matchTopicSets — title×3 / tags×2 / summary×1, LLM-free); this module adds
 * only the workspace guardrail, the activation/recency bonuses and the tier
 * policy, so the plugin keeps exactly ONE similarity algorithm.
 *
 * Pure and host-free: it reads a Store-like surface only, so the smoke harness
 * and the read-only replay tooling can drive it without a DSH host.
 * @module supermemory/topicset-match
 */
import { matchTopicSets } from './recall.ts'
import { TOPIC_SET_TITLE_MAX_CHARS, clipEllipsis } from './title.ts'
import type { TopicSet } from './schema.ts'
import type { Store } from './store.ts'

/**
 * Tier thresholds on the matchTopicSets score.
 *
 * That score sums weight×3 per title hit, weight×2 per tag hit and weight×1
 * per summary hit, with query weights 1/√count (recall.ts:94), so:
 *  - one title hit ≈ 3, two title hits ≈ 6, one tag hit ≈ 2;
 *  - HIGH = 6 → at least two index hits: clearly the same topic, reuse it;
 *  - MEDIUM = 2 → one tag hit or two weak hits: ask the user instead of
 *    silently fragmenting (a new set) or silently merging (a wrong reuse).
 * Initial values were validated by replaying the real store's dispatch
 * history against these thresholds (2026-11-18); see the branch report.
 */
export const TOPIC_MATCH_HIGH_THRESHOLD = 6
export const TOPIC_MATCH_MEDIUM_THRESHOLD = 2

/** Bonus for the hub's currently active set (routing.activeTopicSetId). */
export const TOPIC_MATCH_ACTIVE_BONUS = 2
/** Bonus for a set active inside the recency window (ordering tie-breaker). */
export const TOPIC_MATCH_RECENT_BONUS = 1
/** Recency window for the bonus above (7 days). */
export const TOPIC_MATCH_RECENT_WINDOW_MS = 7 * 86_400_000

/** Suffix of the per-workspace verification set (dispatch kind: 'verify'). */
export const VERIFY_TOPIC_SET_SUFFIX = ' · 验证'

export interface TopicSetCandidate {
  id: string
  title: string
  score: number
}

export type TopicMatchTier = 'high' | 'medium' | 'none'

export interface TopicSetMatchResult {
  tier: TopicMatchTier
  /** The set to reuse; only present for tier 'high'. */
  topicSetId?: string
  score: number
  candidates: TopicSetCandidate[]
  reason: string
}

export interface TopicSetMatchInput {
  task?: string
  tasks?: string[]
  workspaceKey: string
  activeTopicSetId?: string
  /** Evaluation moment for the recency bonus (tests/replay pass a fixed one). */
  now?: number
}

/** One query text for the matcher (a parallel group joins its tasks). */
export function matchQueryText(input: { task?: string; tasks?: string[] }): string {
  const single = String(input.task ?? '').trim()
  if (single) return single
  return (input.tasks ?? []).map((entry) => String(entry ?? '').trim()).filter(Boolean).join('\n')
}

/** Last path segment of a workspace key (both separators), e.g. 'SuperMemory'. */
export function workspaceDirName(workspaceKey: string): string {
  const raw = String(workspaceKey ?? '')
  const parts = raw.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : raw
}

/** Title of the per-workspace verification set, e.g. 「SuperMemory · 验证」. */
export function verifyTopicSetTitle(workspaceKey: string): string {
  return clipEllipsis(`${workspaceDirName(workspaceKey)}${VERIFY_TOPIC_SET_SUFFIX}`, TOPIC_SET_TITLE_MAX_CHARS)
}

/**
 * Find the workspace's verification set: an exact title match first, then a
 * containment match (either direction) so a hand-renamed variant still counts.
 * Archived sets never match. Read-only.
 */
export function findVerifyTopicSet(store: Store, workspaceKey: string): string | undefined {
  const expected = verifyTopicSetTitle(workspaceKey)
  let contained: string | undefined
  for (const [id, record] of store.topicsets.entries()) {
    if (record.workspaceKey !== workspaceKey) continue
    if (record.status !== 'active') continue
    const title = String(record.title ?? '').trim()
    if (title === expected) return id
    if (!contained && title.length >= 4 && (title.includes(expected) || expected.includes(title))) contained = id
  }
  return contained
}

/**
 * Score a dispatch task against the existing topic sets of ONE workspace and
 * dispose by tier. Guardrails: same workspaceKey only (cross-workspace never
 * matches), archived sets skipped, the hub's active set and recently active
 * sets get a small bonus. Never writes.
 */
export function matchTopicSetForTask(store: Store, input: TopicSetMatchInput): TopicSetMatchResult {
  const query = matchQueryText(input)
  const workspaceKey = String(input.workspaceKey ?? '')
  if (!query || !workspaceKey || workspaceKey === 'unknown') {
    return { tier: 'none', score: 0, candidates: [], reason: '没有可匹配的任务文本，或工作区未知。' }
  }
  // Guardrail: the candidate pool is this workspace's ACTIVE sets only —
  // fragmentation must never leak across projects, and an archived set is
  // not a reuse target.
  const pool: Array<[string, TopicSet]> = []
  for (const entry of store.topicsets.entries()) {
    const record = entry[1]
    if (record.workspaceKey !== workspaceKey) continue
    if (record.status !== 'active') continue
    pool.push(entry)
  }
  if (pool.length === 0) {
    return { tier: 'none', score: 0, candidates: [], reason: '同工作区内没有可匹配的话题集。' }
  }
  const now = input.now ?? Date.now()
  const scored = matchTopicSets(pool, query, 8).map((hit) => {
    const record = store.topicsets.get(hit.id)
    let score = hit.score
    if (input.activeTopicSetId && hit.id === input.activeTopicSetId) score += TOPIC_MATCH_ACTIVE_BONUS
    if (record && record.lastActiveAt >= now - TOPIC_MATCH_RECENT_WINDOW_MS) score += TOPIC_MATCH_RECENT_BONUS
    return { id: hit.id, title: hit.title, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const candidates = scored.map((row) => ({ id: row.id, title: row.title, score: Math.round(row.score * 100) / 100 }))
  const top = candidates[0]
  if (!top || top.score < TOPIC_MATCH_MEDIUM_THRESHOLD) {
    return {
      tier: 'none',
      score: top?.score ?? 0,
      candidates,
      reason: top
        ? `最高相似度 ${top.score} 低于中等阈值 ${TOPIC_MATCH_MEDIUM_THRESHOLD}，按现状自动新建。`
        : '任务与同工作区话题集没有关键词重叠，按现状自动新建。',
    }
  }
  if (top.score >= TOPIC_MATCH_HIGH_THRESHOLD) {
    return {
      tier: 'high',
      topicSetId: top.id,
      score: top.score,
      candidates,
      reason: `与话题集『${top.title}』高相似（${top.score} ≥ ${TOPIC_MATCH_HIGH_THRESHOLD}），直接复用、不新建。`,
    }
  }
  return {
    tier: 'medium',
    score: top.score,
    candidates,
    reason: `与话题集『${top.title}』中等相似（${top.score}，处于 ${TOPIC_MATCH_MEDIUM_THRESHOLD}~${TOPIC_MATCH_HIGH_THRESHOLD} 之间），不派发也不新建，等用户裁决。`,
  }
}

/** The hub-facing need-confirm text (directly transcribable to the user). */
export function renderTopicSetConfirm(result: TopicSetMatchResult): string {
  const lines = [
    `任务与现有话题集中等相似（最高分 ${result.score}），尚未派发、也未新建话题集。`,
    '候选话题集：',
  ]
  result.candidates.slice(0, 5).forEach((row, index) => {
    lines.push(`${index + 1}. 『${row.title}』（${row.id}，分数 ${row.score}）`)
  })
  lines.push('请用户裁决后重试：复用某个候选（带 topicSetId 派发）、强制新建（forceNewTopicSet=true），或改述任务。')
  return lines.join('\n')
}

/**
 * Symmetric pairwise similarity of two topic sets, for MERGE clustering
 * (topicset-merge.ts).
 *
 * The comparison is TITLE vs TITLE through the same scorer (matchTopicSets):
 * one set's title is the query, the other set's title is the only candidate
 * field. Summaries are deliberately NOT read here — an LLM-generated summary
 * is project boilerplate ("该话题集的目标是…") that makes every set of a
 * single-project workspace look alike (measured on the real store: title +
 * summary scoring merges all 20 active sets into one component at any
 * threshold ≤ 25). The title is the identity label a human judges "same
 * topic" by, and merging is a heavy, hard-to-reverse decision, so it requires
 * title evidence. No dispatch guardrails (active/recency bonuses) apply:
 * this is a catalog decision, not a routing one.
 */
export function topicSetPairScore(a: TopicSet, b: TopicSet): number {
  const titleOf = (set: TopicSet) => String(set.title ?? '')
  const candidate = (set: TopicSet) => [[titleOf(set), { title: titleOf(set), summary: '', keywords: [], status: 'active' }]]
  const forward = matchTopicSets(candidate(b) as never, titleOf(a), 1)[0]?.score ?? 0
  const backward = matchTopicSets(candidate(a) as never, titleOf(b), 1)[0]?.score ?? 0
  return Math.max(forward, backward)
}
