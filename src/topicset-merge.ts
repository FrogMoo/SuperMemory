/**
 * Topic-set merge (R23 第三期): consolidate the fragmented catalog.
 *
 * The dispatch-side matcher (topicset-match.ts) stops NEW fragmentation; this
 * module cleans up the EXISTING one. It clusters the active topic sets of one
 * workspace by pairwise title similarity (the same recall scorer, title vs
 * title), picks a primary set per cluster, and — only after an explicit
 * `apply` — moves every reference into it:
 *   dispatches / episodes / requirements / questions .topicSetId,
 *   routing.activeTopicSetId, topicsets.members[] (deduped by sessionId).
 * Source sets are ARCHIVED, never deleted. A meta marker (row 'merges')
 * records the executed cluster signatures, so a re-plan never re-proposes an
 * executed cluster (idempotent).
 *
 * Pattern follows title-migration.ts: a pure planTopicSetMerges(), a dry-run
 * report for human approval, then applyPlanToStore() + applyPlanToHost().
 * @module supermemory/topicset-merge
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TopicSet } from './schema.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'
import { normalizeTags } from './retrieval.ts'
import { findVerifyTopicSet, topicSetPairScore, verifyTopicSetTitle } from './topicset-match.ts'
import { TOPIC_SET_TITLE_MAX_CHARS, applySessionTitle, clipEllipsis, currentSessionTitle, sessionTitleFor } from './title.ts'
import { clipMarked } from './clip.ts'

/** Bump when the merge rules change; an older marker re-runs. */
export const MERGES_VERSION = 1

/** The meta-table row key of the merge marker. */
const MARKER_KEY = 'merges'

/**
 * Merge threshold on the pairwise title score (title×3 per shared token).
 *
 * Rationale: a pair that shares ONLY the project name (e.g. the latin token
 * "supermemory" in both titles) floors at 6; a single shared CJK bigram
 * pair scores 0 (bigram tokenization — 「命名验证」 and 「终验任务」 share no
 * bigram at all). 9 means at least THREE shared title tokens (验证+链路+路验,
 * or 同步+仓库+supermemory): clearly the same topic. Merging is a heavy,
 * hard-to-reverse decision, so the bar sits well above the dispatch
 * need-confirm MEDIUM=2 — and below it, pairs in [6, 9) are reported as
 * borderline candidates instead of being merged silently.
 * Validated against the real store (2026-11-18): at 9 the one-shot
 * verification family (7 sets) and the git-sync family (4 sets) each form
 * one component with no observed false merge; at 6 everything collapses
 * into one component.
 */
export const TOPIC_MERGE_THRESHOLD = 9

/** Below the threshold but at/above this score: reported, never merged. */
export const TOPIC_MERGE_BORDERLINE_MIN = 6

/**
 * A cluster whose every set reads as one-shot verification (title or summary
 * mentions 验证/复测/终验) merges INTO the workspace's verification set —
 * the funnel `kind:'verify'` dispatches use — creating it when absent.
 */
const VERIFY_NATURE_RE = /验证|复测|终验/

/** Merged summary cap (2× the 500-char create cap; keeps the field bounded). */
const MERGED_SUMMARY_MAX = 1000

export interface MergeRecordCounts {
  dispatches: number
  episodes: number
  requirements: number
  questions: number
  routing: number
}

export interface MergeSource {
  topicSetId: string
  title: string
  members: number
  createdAt: number
  /** Best pairwise title score against any member of the cluster. */
  score: number
  records: MergeRecordCounts
}

export interface MergeMemberChange {
  sessionId: string
  from: string
  to: string
}

export interface MergeTargetView {
  topicSetId: string
  title: string
  members: number
  createdAt: number
  keywords: string[]
  /** Why this set is the primary (or why a new one is minted). */
  reason: string
  /** True when apply mints this set (the workspace's verify set, absent). */
  toCreate?: boolean
  /** The title before a --rename override (absent when unchanged). */
  renameFrom?: string
}

export interface MergeClusterPlan {
  signature: string
  workspaceKey: string
  target: MergeTargetView
  sources: MergeSource[]
  records: MergeRecordCounts
  membersAfter: number
  memberChanges: MergeMemberChange[]
  keywordsAfter: string[]
  summaryAfter: string
  /** Every set reads as one-shot verification (the verify-set funnel). */
  verifyNature: boolean
}

/** A 0-member set with no records at all: pure index clutter. */
export interface MergeEmptySet {
  topicSetId: string
  title: string
  createdAt: number
}

/** A set whose best partner scores below the threshold: reported, not merged. */
export interface MergeBorderline {
  topicSetId: string
  title: string
  partnerId: string
  partnerTitle: string
  score: number
  partnerInCluster: boolean
}

/** A 0-member set that still owns records but matched no cluster. */
export interface MergeOrphan {
  topicSetId: string
  title: string
  records: MergeRecordCounts
}

export interface TopicSetMergePlan {
  clusters: MergeClusterPlan[]
  emptySets: MergeEmptySet[]
  borderline: MergeBorderline[]
  orphans: MergeOrphan[]
  totals: {
    activeSets: number
    clusteredSets: number
    toArchive: number
    dispatches: number
    episodes: number
    requirements: number
    questions: number
    routing: number
    membersAfter: number
    newTargets: number
  }
  /** Signatures already executed (from the marker) — never re-proposed. */
  executedSignatures: string[]
}

export interface TopicSetMergeDeps {
  ctx: Context
  store: Store
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

export interface TopicSetMergeResult extends TopicSetMergePlan {
  status: 'planned' | 'applied' | 'nothing-to-do'
  applied: {
    clusters: number
    archived: number
    created: number
    moved: MergeRecordCounts
    hostRenamed: number
    hostSkipped: number
  }
}

type Member = TopicSet['members'][number]

function zeroCounts(): MergeRecordCounts {
  return { dispatches: 0, episodes: 0, requirements: 0, questions: 0, routing: 0 }
}

function addCounts(a: MergeRecordCounts, b: MergeRecordCounts): MergeRecordCounts {
  return {
    dispatches: a.dispatches + b.dispatches,
    episodes: a.episodes + b.episodes,
    requirements: a.requirements + b.requirements,
    questions: a.questions + b.questions,
    routing: a.routing + b.routing,
  }
}

/** Every record that points at one topic set (the FK inventory). */
function recordCounts(store: Store, topicSetId: string): MergeRecordCounts {
  const counts = zeroCounts()
  for (const [, row] of store.dispatches.entries()) if (row.topicSetId === topicSetId) counts.dispatches += 1
  for (const [, row] of store.episodes.entries()) if (row.topicSetId === topicSetId) counts.episodes += 1
  for (const [, row] of store.requirements.entries()) if (row.topicSetId === topicSetId) counts.requirements += 1
  for (const [, row] of store.questions.entries()) if (row.topicSetId === topicSetId) counts.questions += 1
  for (const [, row] of store.routing.entries()) if (row.activeTopicSetId === topicSetId) counts.routing += 1
  return counts
}

/** Earliest dispatch task per branch session (the text that named it). */
function firstTaskBySession(store: Store): Map<string, string> {
  const best = new Map<string, { createdAt: number; task: string }>()
  for (const [, row] of store.dispatches.entries()) {
    const task = String(row.task ?? '').trim()
    if (!task || !row.branchSessionId) continue
    const prev = best.get(row.branchSessionId)
    if (!prev || (row.createdAt || 0) < prev.createdAt) best.set(row.branchSessionId, { createdAt: row.createdAt || 0, task })
  }
  const out = new Map<string, string>()
  for (const [sessionId, row] of best) out.set(sessionId, row.task)
  return out
}

/** Primary-set rule: most members > earliest created > most complete index. */
function completeness(record: TopicSet): number {
  return record.keywords.length + (String(record.summary ?? '').trim() ? 1 : 0)
}

function pickTarget(entries: Array<[string, TopicSet]>): { id: string; reason: string } {
  let best = entries[0]
  for (const entry of entries.slice(1)) {
    const cur = best[1]
    const cand = entry[1]
    if (cand.members.length !== cur.members.length) {
      if (cand.members.length > cur.members.length) best = entry
      continue
    }
    if ((cand.createdAt ?? 0) !== (cur.createdAt ?? 0)) {
      if ((cand.createdAt ?? 0) < (cur.createdAt ?? 0)) best = entry
      continue
    }
    if (completeness(cand) !== completeness(cur)) {
      if (completeness(cand) > completeness(cur)) best = entry
      continue
    }
    if (entry[0] < best[0]) best = entry
  }
  const record = best[1]
  const most = entries.every((entry) => entry[1].members.length <= record.members.length)
  const reason = most && record.members.length > 0
    ? `成员最多（${record.members.length} 个）`
    : '成员数相同，取创建最早且索引最完整者'
  return { id: best[0], reason }
}

/** Cluster signature: stable across re-plans, so the marker can dedupe. */
function clusterSignature(workspaceKey: string, targetKey: string, sourceIds: string[]): string {
  return `v${MERGES_VERSION}|${workspaceKey}|${targetKey}|${[...sourceIds].sort().join('+')}`
}

/**
 * Merge member lists: target members first, then each source's; one row per
 * sessionId (a session that belongs to several sets is kept ONCE), and a
 * kind conflict resolves to 'root' (a set-owning hub outranks a work branch).
 * Pure — used by the plan and by apply so both agree on the outcome.
 */
export function mergeMemberLists(target: TopicSet | undefined, sources: TopicSet[]): Member[] {
  const merged = new Map<string, Member>()
  const take = (member: Member) => {
    const existing = merged.get(member.sessionId)
    if (!existing) {
      merged.set(member.sessionId, { ...member })
      return
    }
    const kind = existing.kind === 'root' || member.kind === 'root' ? 'root' : existing.kind
    const title = existing.title.trim() ? existing.title : member.title
    const lastActiveAt = Math.max(existing.lastActiveAt || 0, member.lastActiveAt || 0)
    merged.set(member.sessionId, { ...existing, kind, title, lastActiveAt })
  }
  for (const member of target?.members ?? []) take(member)
  for (const source of sources) for (const member of source.members) take(member)
  return [...merged.values()]
}

/**
 * Recompute every merged member's title against the (new) topic-set title,
 * keeping the in-set ordinal de-duplication. Sources, in order: the
 * branch's first dispatch task; else the snippet after ' · ' of the old
 * title; else the old topic-set title alone (a panel root session). A title
 * with none of those is left untouched — never guessed.
 */
function planMemberTitles(
  members: Member[],
  targetTitle: string,
  tasks: Map<string, string>,
  sourceTitles: Map<string, string>,
): MergeMemberChange[] {
  const changes: MergeMemberChange[] = []
  const taken = new Set<string>()
  for (const member of members) {
    const from = String(member.title ?? '')
    const task = tasks.get(member.sessionId)
    let to: string
    if (task) {
      to = sessionTitleFor(targetTitle, task, taken)
    } else if (from.includes(' · ')) {
      const snippet = from.slice(from.indexOf(' · ') + 3)
      to = sessionTitleFor(targetTitle, snippet, taken)
    } else if (from.trim() && from.trim() === (sourceTitles.get(member.sessionId) ?? '')) {
      to = sessionTitleFor(targetTitle, '', taken)
    } else {
      to = from
    }
    taken.add(to)
    if (to !== from) changes.push({ sessionId: member.sessionId, from, to })
  }
  return changes
}

/** The persisted merge marker (undefined when never run). */
export function mergeMarker(store: Store): { mergesVersion?: number; mergeSignatures?: string[]; lastMergeAt?: number } | undefined {
  return store.meta?.get(MARKER_KEY) as { mergesVersion?: number; mergeSignatures?: string[]; lastMergeAt?: number } | undefined
}

/**
 * Compute the merge plan without writing anything. Pure over the store's
 * topicsets + record tables, so it is unit-testable with a fake store and
 * safe to run against the REAL store as a dry-run.
 */
export function planTopicSetMerges(store: Store, options: { rename?: string } = {}): TopicSetMergePlan {
  const marker = mergeMarker(store)
  const executed = new Set<string>(
    marker && (marker.mergesVersion ?? 0) >= MERGES_VERSION ? marker.mergeSignatures ?? [] : [],
  )
  const tasks = firstTaskBySession(store)
  const byWorkspace = new Map<string, Array<[string, TopicSet]>>()
  for (const entry of store.topicsets.entries()) {
    const record = entry[1]
    if (record.status !== 'active') continue
    const arr = byWorkspace.get(record.workspaceKey) ?? []
    arr.push(entry)
    byWorkspace.set(record.workspaceKey, arr)
  }
  const plan: TopicSetMergePlan = {
    clusters: [],
    emptySets: [],
    borderline: [],
    orphans: [],
    totals: {
      activeSets: 0, clusteredSets: 0, toArchive: 0,
      dispatches: 0, episodes: 0, requirements: 0, questions: 0, routing: 0,
      membersAfter: 0, newTargets: 0,
    },
    executedSignatures: [...executed],
  }
  const clustered = new Set<string>()
  // Clusters kept with their title-recompute inputs, so a --rename override can
  // re-plan member titles against the NEW target title from the same data.
  const built: Array<{ cluster: MergeClusterPlan; members: Member[]; sourceTitles: Map<string, string> }> = []
  for (const [workspaceKey, entries] of byWorkspace) {
    plan.totals.activeSets += entries.length
    const byId = new Map(entries)
    // ---- pairwise scores (title vs title, symmetric max) ----
    const pairs: Array<{ a: string; b: string; score: number }> = []
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const score = topicSetPairScore(entries[i][1], entries[j][1])
        if (score >= TOPIC_MERGE_BORDERLINE_MIN) pairs.push({ a: entries[i][0], b: entries[j][0], score })
      }
    }
    // ---- connected components at the merge threshold ----
    const parent = new Map(entries.map(([id]) => [id, id]))
    const find = (x: string): string => {
      let root = x
      while (parent.get(root) !== root) root = parent.get(root) as string
      while (parent.get(x) !== root) {
        const next = parent.get(x) as string
        parent.set(x, root)
        x = next
      }
      return root
    }
    for (const pair of pairs) {
      if (pair.score < TOPIC_MERGE_THRESHOLD) continue
      const ra = find(pair.a)
      const rb = find(pair.b)
      if (ra !== rb) parent.set(ra, rb)
    }
    const groups = new Map<string, string[]>()
    for (const [id] of entries) {
      const root = find(id)
      groups.set(root, [...(groups.get(root) ?? []), id])
    }
    const clusterMembers = new Set<string>()
    for (const ids of groups.values()) if (ids.length > 1) for (const id of ids) clusterMembers.add(id)
    // ---- clusters ----
    for (const ids of groups.values()) {
      if (ids.length < 2) continue
      const records = ids.map((id) => byId.get(id) as TopicSet)
      const verifyNature = records.every((record) => VERIFY_NATURE_RE.test(`${record.title ?? ''} ${record.summary ?? ''}`))
      const verifyId = verifyNature ? findVerifyTopicSet(store, workspaceKey) : undefined
      const useVerifyTarget = verifyNature && (!verifyId || ids.includes(verifyId))
      let targetId = ''
      let targetReason = ''
      let targetRecord: TopicSet | undefined
      if (useVerifyTarget && verifyId) {
        targetId = verifyId
        targetRecord = byId.get(verifyId)
        targetReason = '验证类簇：目标即本工作区验证集（kind:"verify" 派发的既定归拢点）'
      } else if (useVerifyTarget) {
        targetReason = `验证类簇：将新建「${verifyTopicSetTitle(workspaceKey)}」作为目标集（kind:"verify" 派发的既定归拢点）`
      } else {
        const picked = pickTarget(records.map((record, index) => [ids[index], record]))
        targetId = picked.id
        targetRecord = byId.get(targetId)
        targetReason = picked.reason
      }
      const sourceIds = useVerifyTarget ? ids.filter((id) => id !== targetId) : ids.filter((id) => id !== targetId)
      const signature = clusterSignature(workspaceKey, targetId || `new:${verifyTopicSetTitle(workspaceKey)}`, sourceIds)
      // Executed clusters stay accounted for: their sets are neither re-proposed
      // nor re-listed as empty/orphan/borderline.
      for (const id of ids) clustered.add(id)
      if (executed.has(signature)) continue
      const targetTitle = targetRecord ? String(targetRecord.title ?? '') : verifyTopicSetTitle(workspaceKey)
      const sources: MergeSource[] = sourceIds.map((id) => {
        const record = byId.get(id) as TopicSet
        let best = 0
        for (const other of records) {
          if (other === record) continue
          const score = topicSetPairScore(record, other)
          if (score > best) best = score
        }
        return {
          topicSetId: id,
          title: String(record.title ?? ''),
          members: record.members.length,
          createdAt: record.createdAt ?? 0,
          score: Math.round(best * 100) / 100,
          records: recordCounts(store, id),
        }
      })
      let records_ = zeroCounts()
      for (const source of sources) records_ = addCounts(records_, source.records)
      const merged = mergeMemberLists(targetRecord, sourceIds.map((id) => byId.get(id) as TopicSet))
      const sourceTitles = new Map<string, string>()
      for (const source of sources) for (const member of (byId.get(source.topicSetId) as TopicSet).members) {
        if (!sourceTitles.has(member.sessionId)) sourceTitles.set(member.sessionId, String((byId.get(source.topicSetId) as TopicSet).title ?? ''))
      }
      const memberChanges = planMemberTitles(merged, targetTitle, tasks, sourceTitles)
      const keywordUnion = new Set<string>()
      if (targetRecord) for (const tag of targetRecord.keywords) keywordUnion.add(tag)
      for (const id of sourceIds) for (const tag of (byId.get(id) as TopicSet).keywords) keywordUnion.add(tag)
      const summaryParts: string[] = []
      if (targetRecord && String(targetRecord.summary ?? '').trim()) summaryParts.push(String(targetRecord.summary).trim())
      for (const id of sourceIds) {
        const text = String((byId.get(id) as TopicSet).summary ?? '').trim()
        if (text) summaryParts.push(text)
      }
      plan.clusters.push({
        signature,
        workspaceKey,
        target: {
          topicSetId: targetId,
          title: targetTitle,
          members: targetRecord ? targetRecord.members.length : 0,
          createdAt: targetRecord ? targetRecord.createdAt ?? 0 : 0,
          keywords: targetRecord ? [...targetRecord.keywords] : [],
          reason: targetReason,
          ...(targetRecord ? {} : { toCreate: true }),
        },
        sources,
        records: records_,
        membersAfter: merged.length,
        memberChanges,
        keywordsAfter: normalizeTags([...keywordUnion]),
        summaryAfter: clipEllipsis(summaryParts.join('\n'), MERGED_SUMMARY_MAX),
        verifyNature,
      })
      built.push({ cluster: plan.clusters[plan.clusters.length - 1], members: merged, sourceTitles })
    }
    // ---- singletons: borderline / empty / orphan ----
    for (const [id, record] of entries) {
      if (clusterMembers.has(id)) continue
      let best: { id: string; score: number } | undefined
      for (const pair of pairs) {
        if (pair.a === id && (!best || pair.score > best.score)) best = { id: pair.b, score: pair.score }
        if (pair.b === id && (!best || pair.score > best.score)) best = { id: pair.a, score: pair.score }
      }
      if (best) {
        plan.borderline.push({
          topicSetId: id,
          title: String(record.title ?? ''),
          partnerId: best.id,
          partnerTitle: String((byId.get(best.id) as TopicSet).title ?? ''),
          score: Math.round(best.score * 100) / 100,
          partnerInCluster: clusterMembers.has(best.id),
        })
      }
      const counts = recordCounts(store, id)
      const owned = counts.dispatches + counts.episodes + counts.requirements + counts.questions + counts.routing
      if (record.members.length === 0 && owned === 0) {
        plan.emptySets.push({ topicSetId: id, title: String(record.title ?? ''), createdAt: record.createdAt ?? 0 })
      } else if (record.members.length === 0 && owned > 0) {
        plan.orphans.push({ topicSetId: id, title: String(record.title ?? ''), records: counts })
      }
    }
  }
  // ---- --rename: post-clustering override of an EXISTING target's title ----
  // Clustering itself is untouched (it ran on the current titles). The rename
  // only re-labels the primary set and recomputes member titles against the
  // NEW title, so a dry-run preview and the apply result come from ONE plan
  // (identical memberChanges). A to-create verify target is never renamed.
  if (options.rename !== undefined) {
    const wanted = String(options.rename ?? '').trim()
    if (!wanted) throw new Error('--rename 的标题不能为空。')
    const existing = plan.clusters.filter((cluster) => !cluster.target.toCreate)
    if (existing.length > 1) {
      throw new Error(
        '--rename 不明确：本批有 ' + existing.length + ' 个「已有主集」簇（'
        + existing.map((cluster) => '『' + cluster.target.title + '』').join('、')
        + '）；请分批执行，或在 SuperMemory 管理台逐个改名。',
      )
    }
    if (existing.length === 0) {
      throw new Error('--rename 无可生效的目标：本批没有「已有主集」簇（一次性验证类簇会新建目标集，标题固定）。')
    }
    const item = built.find((entry) => entry.cluster === existing[0])
    const to = clipEllipsis(wanted, TOPIC_SET_TITLE_MAX_CHARS)
    if (item && to && to !== existing[0].target.title) {
      existing[0].target.renameFrom = existing[0].target.title
      existing[0].target.title = to
      existing[0].memberChanges = planMemberTitles(item.members, to, tasks, item.sourceTitles)
    }
  }

  // ---- totals ----
  for (const cluster of plan.clusters) {
    plan.totals.clusteredSets += cluster.sources.length + 1
    plan.totals.toArchive += cluster.sources.length
    plan.totals.membersAfter += cluster.membersAfter
    plan.totals.dispatches += cluster.records.dispatches
    plan.totals.episodes += cluster.records.episodes
    plan.totals.requirements += cluster.records.requirements
    plan.totals.questions += cluster.records.questions
    plan.totals.routing += cluster.records.routing
    if (cluster.target.toCreate) plan.totals.newTargets += 1
  }
  plan.totals.toArchive += plan.emptySets.length
  return plan
}

/** Move every record that points at `from` over to `to`. */
async function moveReferences(store: Store, from: string, to: string, now: number, moved: MergeRecordCounts): Promise<void> {
  for (const [id, row] of [...store.dispatches.entries()]) {
    if (row.topicSetId !== from) continue
    await store.dispatches.update(id, (r) => ({ ...r, topicSetId: to, updatedAt: now })).catch(() => {})
    moved.dispatches += 1
  }
  for (const [id, row] of [...store.episodes.entries()]) {
    if (row.topicSetId !== from) continue
    await store.episodes.update(id, (r) => ({ ...r, topicSetId: to })).catch(() => {})
    moved.episodes += 1
  }
  for (const [id, row] of [...store.requirements.entries()]) {
    if (row.topicSetId !== from) continue
    await store.requirements.update(id, (r) => ({ ...r, topicSetId: to })).catch(() => {})
    moved.requirements += 1
  }
  for (const [id, row] of [...store.questions.entries()]) {
    if (row.topicSetId !== from) continue
    await store.questions.update(id, (r) => ({ ...r, topicSetId: to, updatedAt: now })).catch(() => {})
    moved.questions += 1
  }
  for (const [id, row] of [...store.routing.entries()]) {
    if (row.activeTopicSetId !== from) continue
    await store.routing.update(id, (r) => ({ ...r, activeTopicSetId: to, updatedAt: now })).catch(() => {})
    moved.routing += 1
  }
}

/** Write the plan's store rows: mint targets, move references, archive sources. */
export async function applyPlanToStore(
  store: Store,
  plan: TopicSetMergePlan,
): Promise<{ moved: MergeRecordCounts; archived: string[]; created: string[] }> {
  const now = Date.now()
  const moved = zeroCounts()
  const archived: string[] = []
  const created: string[] = []
  const titleChanges = new Map<string, string>()
  for (const cluster of plan.clusters) for (const change of cluster.memberChanges) titleChanges.set(change.sessionId, change.to)
  for (const cluster of plan.clusters) {
    // 1. mint the target when the cluster funnels into a new verify set
    let targetId = cluster.target.topicSetId
    if (cluster.target.toCreate) {
      targetId = newId('ts')
      await store.topicsets.put(targetId, {
        workspaceKey: cluster.workspaceKey,
        title: cluster.target.title,
        summary: '',
        keywords: [],
        status: 'active',
        members: [],
        shapeFingerprint: '',
        shapeGeneratedAt: 0,
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
      }).catch(() => {})
      created.push(targetId)
    }
    // 2. snapshot sources, then move their references and archive them
    const sourceRecords = cluster.sources
      .map((source) => ({ id: source.topicSetId, record: store.topicsets.get(source.topicSetId) }))
      .filter((row): row is { id: string; record: TopicSet } => !!row.record)
    for (const source of sourceRecords) {
      await moveReferences(store, source.id, targetId, now, moved)
      await store.topicsets.update(source.id, (record) => (
        record ? { ...record, status: 'archived', updatedAt: now } : record
      )).catch(() => {})
      archived.push(source.id)
    }
    // 3. merge members (deduped) + planned titles + index into the target
    const merged = mergeMemberLists(store.topicsets.get(targetId), sourceRecords.map((row) => row.record))
    await store.topicsets.update(targetId, (record) => {
      if (!record) return record
      return {
        ...record,
        // The (possibly --rename'd) target title lands in the SAME record write
        // as the merged members, so no stale-prefix state is ever at rest.
        title: cluster.target.title,
        members: merged.map((member) => {
          const title = titleChanges.get(member.sessionId)
          return title ? { ...member, title } : member
        }),
        keywords: cluster.keywordsAfter,
        summary: cluster.summaryAfter,
        updatedAt: now,
        lastActiveAt: now,
      }
    }).catch(() => {})
  }
  // 4. 0-member, 0-record sets: archive as pure index clutter
  for (const item of plan.emptySets) {
    await store.topicsets.update(item.topicSetId, (record) => (
      record && record.status === 'active' ? { ...record, status: 'archived', updatedAt: now } : record
    )).catch(() => {})
    archived.push(item.topicSetId)
  }
  // 5. marker: executed cluster signatures (idempotency)
  const previous = mergeMarker(store)?.mergeSignatures ?? []
  const signatures = [...new Set([...previous, ...plan.clusters.map((cluster) => cluster.signature)])]
  await store.meta?.put(MARKER_KEY, {
    mergesVersion: MERGES_VERSION,
    mergeSignatures: signatures,
    lastMergeAt: now,
  }).catch(() => {})
  return { moved, archived, created }
}

/**
 * Apply the plan's member titles to the HOST sessions. A session whose live
 * host title was changed by somebody else is skipped, never overwritten.
 */
export async function applyPlanToHost(
  ctx: Context,
  plan: TopicSetMergePlan,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<{ renamed: number; skipped: number }> {
  let renamed = 0
  let skipped = 0
  for (const cluster of plan.clusters) {
    for (const change of cluster.memberChanges) {
      try {
        const current = currentSessionTitle(ctx, change.sessionId)
        if (current && current !== change.from) {
          skipped += 1
          logger.info('supermemory: merge title skip ' + change.sessionId + ' — the host title was renamed by somebody else')
          continue
        }
        const outcome = applySessionTitle(ctx, change.sessionId, change.to, logger, { force: true })
        if (outcome === 'host' || outcome === 'fallback') renamed += 1
      } catch (error) {
        logger.warn('supermemory: merge host title failed for ' + change.sessionId + ': ' + String(error).slice(0, 160))
      }
    }
  }
  return { renamed, skipped }
}

/**
 * Plan (dry-run, the default) or apply the merge. Apply is only reached
 * through an explicit caller decision (the /memory merge apply subcommand);
 * this function never writes on its own.
 */
export async function mergeTopicSets(
  deps: TopicSetMergeDeps,
  options: { dryRun?: boolean; rename?: string } = {},
): Promise<TopicSetMergeResult> {
  const zeros = { clusters: 0, archived: 0, created: 0, moved: zeroCounts(), hostRenamed: 0, hostSkipped: 0 }
  const plan = planTopicSetMerges(deps.store, options.rename === undefined ? {} : { rename: options.rename })
  if (plan.clusters.length === 0 && plan.emptySets.length === 0) {
    return { ...plan, status: 'nothing-to-do', applied: zeros }
  }
  if (options.dryRun !== false) return { ...plan, status: 'planned', applied: zeros }
  const storeResult = await applyPlanToStore(deps.store, plan)
  const host = await applyPlanToHost(deps.ctx, plan, deps.logger)
  deps.logger.info(
    'supermemory: topic-set merge applied — clusters ' + plan.clusters.length
    + ', archived ' + storeResult.archived.length
    + ', created ' + storeResult.created.length
    + ' (host renamed ' + host.renamed + ', skipped ' + host.skipped + ')',
  )
  return {
    ...plan,
    status: 'applied',
    applied: {
      clusters: plan.clusters.length,
      archived: storeResult.archived.length,
      created: storeResult.created.length,
      moved: storeResult.moved,
      hostRenamed: host.renamed,
      hostSkipped: host.skipped,
    },
  }
}

/** Human-readable report for the /memory command (and the approval flow). */
export function renderMergeReport(result: TopicSetMergeResult): string {
  const mode = result.status === 'applied'
    ? '已执行并写库'
    : result.status === 'nothing-to-do'
      ? '没有可合并的簇'
      : '预演（未写库，审批后 /memory merge apply 才写）'
  const lines = ['话题集合并（' + mode + '）：']
  lines.push('- 活跃话题集 ' + result.totals.activeSets + ' 个；拟并入 ' + result.totals.clusteredSets
    + ' 个为 ' + result.clusters.length + ' 簇；另拟归档空集 ' + result.emptySets.length + ' 个')
  lines.push('- 预计搬迁记录：派发 ' + result.totals.dispatches
    + ' / 归档 ' + result.totals.episodes
    + ' / 需求 ' + result.totals.requirements
    + ' / 问题 ' + result.totals.questions
    + ' / 路由 ' + result.totals.routing
    + (result.totals.newTargets > 0 ? '；将新建目标集 ' + result.totals.newTargets + ' 个' : ''))
  result.clusters.forEach((cluster, index) => {
    lines.push('')
    lines.push('簇 ' + (index + 1) + '（' + cluster.workspaceKey + (cluster.verifyNature ? '，一次性验证类' : '') + '）：')
    const target = cluster.target.topicSetId
      ? '『' + cluster.target.title + '』（' + cluster.target.topicSetId + '，成员 ' + cluster.target.members + '）'
      : '（新建）『' + cluster.target.title + '』'
    lines.push('  · 主集：' + target + '——' + cluster.target.reason)
    if (cluster.target.renameFrom) {
      lines.push('  · 目标集改名：「' + cluster.target.renameFrom + '」→「' + cluster.target.title + '」'
        + '（成员标题与索引预览均按新标题计算；聚类按原标题进行，不受影响）')
    }
    for (const source of cluster.sources) {
      lines.push('  · 源集：『' + source.title + '』（' + source.topicSetId + '，成员 ' + source.members
        + '，相似分 ' + source.score
        + '；派发 ' + source.records.dispatches
        + ' / 归档 ' + source.records.episodes
        + ' / 需求 ' + source.records.requirements
        + ' / 问题 ' + source.records.questions
        + ' / 路由 ' + source.records.routing + '）')
    }
    lines.push('  · 合并后：'
      + (cluster.target.renameFrom ? '目标集改名为『' + cluster.target.title + '』；' : '标题不变；')
      + 'keywords=[' + cluster.keywordsAfter.join('、') + ']；成员 ' + cluster.membersAfter + ' 个')
    if (cluster.summaryAfter) lines.push('  · 摘要预览：' + clipMarked(cluster.summaryAfter, 120))
    lines.push('  · 成员标题变化 ' + cluster.memberChanges.length + ' 条：')
    for (const change of cluster.memberChanges) {
      lines.push('    - ' + change.sessionId + '：「' + change.from + '」→「' + change.to + '」')
    }
  })
  if (result.emptySets.length > 0) {
    lines.push('')
    lines.push('- 空集归档（0 成员 0 记录，apply 后 archived，不删）：')
    for (const item of result.emptySets) lines.push('  · 『' + item.title + '』（' + item.topicSetId + '）')
  }
  if (result.borderline.length > 0) {
    lines.push('')
    lines.push('- 边界候选（低于合并阈值 ' + TOPIC_MERGE_THRESHOLD + '，未合并，供人工判断）：')
    for (const item of result.borderline) {
      lines.push('  · 『' + item.title + '』（' + item.topicSetId + '）↔ 『' + item.partnerTitle + '」（' + item.partnerId
        + '）' + item.score + ' 分' + (item.partnerInCluster ? '（对方在拟议簇内）' : ''))
    }
  }
  if (result.orphans.length > 0) {
    lines.push('')
    lines.push('- 待人工处理（0 成员但仍有记录，未匹配任何簇，保持不动）：')
    for (const item of result.orphans) {
      lines.push('  · 『' + item.title + '』（' + item.topicSetId + '；派发 ' + item.records.dispatches
        + ' / 归档 ' + item.records.episodes
        + ' / 需求 ' + item.records.requirements
        + ' / 问题 ' + item.records.questions
        + ' / 路由 ' + item.records.routing + '）')
    }
  }
  if (result.status === 'applied') {
    lines.push('')
    lines.push('- 源集已全部 archived（不物理删除）；宿主改名 ' + result.applied.hostRenamed
      + ' 个，跳过（已被他人改名）' + result.applied.hostSkipped + ' 个')
    lines.push('- 合并标记已写入 store.meta.merges；已执行簇不会再次出现。')
  }
  return lines.join('\n')
}
