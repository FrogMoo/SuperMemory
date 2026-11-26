/**
 * One-time repair of titles damaged by the pre-2026-11-18 truncation.
 *
 * History: a topic-set title used to be cut at 12 characters (dispatch
 * auto-create) or 40 (every other creation path) with no ellipsis, and a
 * branch session title carried only the first 16 characters of its task.
 * The GENERATION paths were fixed on 2026-11-18 (see title.ts); this module
 * refreshes the EXISTING rows:
 *   - a topic-set title that is STILL literally the legacy 12-character
 *     slice of the dispatch that auto-created the set is recomputed from
 *     that task (clipEllipsis(firstLine(cleanTitleText(task)), 60));
 *   - a member title is recomputed with the CURRENT topic-set title and
 *     the full task text of the branch's FIRST dispatch (the one that
 *     named it), keeping the in-set ordinal de-duplication （2）（3）…;
 *   - a member with no dispatch row (a panel-created root session) is
 *     refreshed only when its title is exactly the OLD topic-set title.
 * Rows without a recovery source are left untouched and reported, never
 * guessed. The plan is content-idempotent (a second plan is empty), and a
 * persisted marker (store meta table, row 'titles') keeps the startup pass
 * from rescanning after a successful run. Applying to the HOST session
 * goes through applySessionTitle with force, and only when the live host
 * title still equals the stale stored one — a title somebody else renamed
 * is left alone.
 * @module supermemory/title-migration
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Dispatch } from './schema.ts'
import type { Store } from './store.ts'
import {
  TOPIC_SET_TITLE_MAX_CHARS,
  cleanTitleText,
  clipEllipsis,
  currentSessionTitle,
  firstLine,
  sessionTitleFor,
} from './title.ts'
import { applySessionTitle } from './session-title/gate.ts'

/** Bump when the repair rules change; a marker of an older version re-runs. */
export const TITLES_MIGRATION_VERSION = 1

/** The legacy dispatch auto-create wrote title = firstTask.slice(0, 12). */
const LEGACY_TOPIC_TITLE_CHARS = 12

/** The legacy every-other-path slice: title.slice(0, 40), no ellipsis. */
const LEGACY_TITLE_SLICE_CHARS = 40

/**
 * The auto-creating dispatch is recorded within seconds of the set's
 * creation; a much later dispatch did NOT create the set (its title came
 * from somewhere else, so that task text is not the title's source).
 */
const AUTOCREATE_GAP_MS = 10 * 60 * 1000

/** The meta-table row key of the migration marker. */
const MARKER_KEY = 'titles'

export interface TopicTitlePlan {
  topicSetId: string
  from: string
  to: string
  source: 'dispatch-task'
}

export interface MemberTitlePlan {
  topicSetId: string
  sessionId: string
  from: string
  to: string
  source: 'dispatch-task' | 'topic-title'
}

export interface UnrecoverableTitle {
  topicSetId?: string
  sessionId?: string
  title: string
  reason: string
}

export interface TitlesMigrationPlan {
  topicSets: TopicTitlePlan[]
  members: MemberTitlePlan[]
  unrecoverable: UnrecoverableTitle[]
  topicSetsTotal: number
  membersTotal: number
}

export interface TitlesMigrationResult extends TitlesMigrationPlan {
  status: 'already-done' | 'planned' | 'applied'
  applied: { topicSets: number; members: number; hostRenamed: number; hostSkipped: number }
}

export interface TitlesMigrationDeps {
  ctx: Context
  store: Store
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

interface DispatchRow extends Dispatch {
  id: string
}

function emptyPlan(): TitlesMigrationPlan {
  return { topicSets: [], members: [], unrecoverable: [], topicSetsTotal: 0, membersTotal: 0 }
}

/** The legacy 12-character slice of a task, exactly as the old code cut it. */
function legacyTopicSlice(task: string | undefined): string | undefined {
  if (task === undefined) return undefined
  return String(task ?? '').trim().slice(0, LEGACY_TOPIC_TITLE_CHARS)
}

/** Earliest dispatch row (creation order) matching one predicate. */
function earliestDispatch(rows: readonly DispatchRow[], match: (row: DispatchRow) => boolean): DispatchRow | undefined {
  let best: DispatchRow | undefined
  for (const row of rows) {
    if (!match(row)) continue
    if (!best || (row.createdAt || 0) < (best.createdAt || 0) || ((row.createdAt || 0) === (best.createdAt || 0) && row.id < best.id)) {
      best = row
    }
  }
  return best
}

/**
 * Compute the repair plan without writing anything. Pure over the store's
 * topicsets + dispatches tables, so it is unit-testable with a fake store.
 */
export function planTitlesMigration(store: Store): TitlesMigrationPlan {
  const plan = emptyPlan()
  const rows: DispatchRow[] = [...store.dispatches.entries()].map(([id, row]) => ({ id, ...row }))

  // ---- pass 1: topic-set titles (members are rebuilt against the NEW ones) ----
  const refreshedTopicTitles = new Map<string, string>()
  for (const [topicSetId, topicSet] of store.topicsets.entries()) {
    plan.topicSetsTotal += 1
    const first = earliestDispatch(rows, (row) => row.topicSetId === topicSetId)
    const legacy = legacyTopicSlice(first?.task)
    const title = String(topicSet.title ?? '')
    const lostText = !!first && title === legacy && legacy !== undefined
      && legacy.length < String(first.task ?? '').trim().length
    if (lostText && first) {
      const to = clipEllipsis(firstLine(cleanTitleText(first.task)), TOPIC_SET_TITLE_MAX_CHARS)
      if (to && to !== title) {
        plan.topicSets.push({ topicSetId, from: title, to, source: 'dispatch-task' })
        refreshedTopicTitles.set(topicSetId, to)
        continue
      }
    }
    // Damaged by a legacy slice but the source text is gone (the creating
    // dispatch is no longer in the ledger): report, never guess. A
    // model-regenerated or naturally short title is not flagged.
    const withinGap = !!first && Math.abs((first.createdAt || 0) - (topicSet.createdAt || 0)) <= AUTOCREATE_GAP_MS
    if (Array.from(title).length === LEGACY_TOPIC_TITLE_CHARS && !withinGap) {
      plan.unrecoverable.push({
        topicSetId,
        title,
        reason: '疑似被旧「派发自动创建 slice(0,12)」截断，但创建它的派发记录不在台账，无源文本可恢复',
      })
    } else if (Array.from(title).length === LEGACY_TITLE_SLICE_CHARS && !withinGap) {
      plan.unrecoverable.push({
        topicSetId,
        title,
        reason: '疑似被旧「slice(0,40)」截断（/memory new、面板、工具或管理台路径），原始完整标题无留存，不可恢复',
      })
    }
  }

  // ---- pass 2: member titles, against the refreshed topic-set titles ----
  for (const [topicSetId, topicSet] of store.topicsets.entries()) {
    for (const member of topicSet.members) plan.membersTotal += 1
    const topicTitle = refreshedTopicTitles.get(topicSetId) ?? String(topicSet.title ?? '')
    const oldTopicTitle = String(topicSet.title ?? '')
    const members = topicSet.members
    // Titles that will be KEPT are reserved first, so a refreshed title can
    // never collide with one that stays (the ordinal suffix then applies).
    const taken = new Set<string>()
    for (const member of members) {
      const task = earliestDispatch(rows, (row) => row.branchSessionId === member.sessionId)?.task
      const topicDerived = !task && member.title.trim() === oldTopicTitle && topicTitle !== oldTopicTitle
      if (!task && !topicDerived && member.title.trim()) taken.add(member.title.trim())
    }
    for (const member of members) {
      const from = String(member.title ?? '')
      const first = earliestDispatch(rows, (row) => row.branchSessionId === member.sessionId)
      const task = first?.task
      if (task) {
        const to = sessionTitleFor(topicTitle, task, taken)
        taken.add(to)
        if (to !== from) {
          plan.members.push({ topicSetId, sessionId: member.sessionId, from, to, source: 'dispatch-task' })
        }
        continue
      }
      if (from.trim() === oldTopicTitle && topicTitle !== oldTopicTitle) {
        // A panel-created root session named after the topic set alone.
        const to = sessionTitleFor(topicTitle, '', taken)
        taken.add(to)
        if (to !== from) {
          plan.members.push({ topicSetId, sessionId: member.sessionId, from, to, source: 'topic-title' })
        }
        continue
      }
      if (!from.trim()) continue
      // No dispatch row and not a topic echo: the legacy bare task snippet
      // was cut at EXACTLY 16 characters (truncateChars(…, 16)), which is its
      // signature; anything shorter is a deliberate short title, not damage.
      if (!from.includes(' · ') && Array.from(from).length === 16) {
        plan.unrecoverable.push({
          topicSetId,
          sessionId: member.sessionId,
          title: from,
          reason: '疑似旧「任务前 16 字」片段标题，但该分支无派发记录，无源文本可恢复',
        })
      }
    }
  }
  return plan
}

/** Write the plan's store rows (topic-set titles, then member titles). */
export async function applyPlanToStore(store: Store, plan: TitlesMigrationPlan): Promise<void> {
  const now = Date.now()
  for (const item of plan.topicSets) {
    await store.topicsets.update(item.topicSetId, (record) => (
      record && record.title !== item.to ? { ...record, title: item.to, updatedAt: now } : record
    )).catch(() => { /* a failed write keeps the old title; the next run retries */ })
  }
  for (const item of plan.members) {
    await store.topicsets.update(item.topicSetId, (record) => {
      if (!record) return record
      if (record.members.some((m) => m.sessionId === item.sessionId && m.title === item.to)) return record
      return {
        ...record,
        members: record.members.map((m) => (m.sessionId === item.sessionId ? { ...m, title: item.to } : m)),
        updatedAt: now,
      }
    }).catch(() => { /* a failed write keeps the old title; the next run retries */ })
  }
}

/**
 * Apply the plan's member titles to the HOST sessions. A session whose live
 * host title was changed by somebody else (user rename, another plugin) is
 * skipped rather than overwritten.
 */
export async function applyPlanToHost(
  ctx: Context,
  store: Store,
  plan: TitlesMigrationPlan,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<{ renamed: number; skipped: number }> {
  let renamed = 0
  let skipped = 0
  for (const item of plan.members) {
    try {
      const current = currentSessionTitle(ctx, item.sessionId)
      if (current && current !== item.from) {
        skipped += 1
        logger.info('supermemory: title migration skipped ' + item.sessionId + ' — the host title was renamed by somebody else')
        continue
      }
      const outcome = await applySessionTitle({ ctx, store, logger }, {
        sessionId: item.sessionId,
        kind: 'other',
        explicitTitle: item.to,
        source: 'migration',
        force: true,
      })
      if (outcome.outcome === 'host' || outcome.outcome === 'fallback') renamed += 1
    } catch (error) {
      logger.warn('supermemory: title migration host apply failed for ' + item.sessionId + ': ' + String(error).slice(0, 160))
    }
  }
  return { renamed, skipped }
}

/** The persisted migration marker (undefined when never run). */
export async function titlesMigrationMarker(store: Store): Promise<{ titlesMigratedAt?: number; titlesMigrationVersion?: number } | undefined> {
  return store.meta?.get(MARKER_KEY)
}

/** Record a successful run so a restart does not rescan. */
export async function writeTitlesMigrationMarker(store: Store): Promise<void> {
  await store.meta?.put(MARKER_KEY, { titlesMigratedAt: Date.now(), titlesMigrationVersion: TITLES_MIGRATION_VERSION })
}

/**
 * Run (or preview) the repair. Startup calls it with no options (marker-
 * guarded); the /memory command calls it with ignoreMarker so a manual
 * re-scan is always possible, and dryRun to preview without writing.
 */
export async function migrateTruncatedTitles(
  deps: TitlesMigrationDeps,
  options: { dryRun?: boolean; ignoreMarker?: boolean } = {},
): Promise<TitlesMigrationResult> {
  const { ctx, store, logger } = deps
  const zeros = { topicSets: 0, members: 0, hostRenamed: 0, hostSkipped: 0 }
  if (!options.ignoreMarker) {
    const marker = await titlesMigrationMarker(store)
    if (marker && (marker.titlesMigrationVersion ?? 0) >= TITLES_MIGRATION_VERSION) {
      return { ...emptyPlan(), status: 'already-done', applied: zeros }
    }
  }
  const plan = planTitlesMigration(store)
  if (options.dryRun) return { ...plan, status: 'planned', applied: zeros }
  await applyPlanToStore(store, plan)
  const host = await applyPlanToHost(ctx, store, plan, logger)
  await writeTitlesMigrationMarker(store)
  logger.info(
    'supermemory: title migration applied — topic sets ' + plan.topicSets.length
    + ', members ' + plan.members.length
    + ' (host renamed ' + host.renamed + ', skipped ' + host.skipped + ')',
  )
  return {
    ...plan,
    status: 'applied',
    applied: {
      topicSets: plan.topicSets.length,
      members: plan.members.length,
      hostRenamed: host.renamed,
      hostSkipped: host.skipped,
    },
  }
}

/** Human-readable report for the /memory command. */
export function renderTitlesMigrationReport(result: TitlesMigrationResult): string {
  const mode = result.status === 'applied'
    ? '已执行并写库'
    : result.status === 'already-done'
      ? '迁移标记已存在，未重扫（内容幂等，手动重扫也找不到待刷标题）'
      : '预演（未写库）'
  const lines = ['标题补正刷新（' + mode + '）：']
  lines.push('- 话题集标题：存量 ' + result.topicSetsTotal + ' 条，本次刷新 ' + result.topicSets.length + ' 条')
  for (const item of result.topicSets) lines.push('  · 「' + item.from + '」→「' + item.to + '」')
  lines.push('- 分支成员标题：存量 ' + result.membersTotal + ' 条，本次刷新 ' + result.members.length + ' 条')
  for (const item of result.members) lines.push('  · 「' + item.from + '」→「' + item.to + '」')
  if (result.unrecoverable.length > 0) {
    lines.push('- 不可恢复（保持不动）' + result.unrecoverable.length + ' 条：')
    for (const item of result.unrecoverable) {
      const who = item.sessionId ? item.sessionId + ' ' : (item.topicSetId ? item.topicSetId + ' ' : '')
      lines.push('  · ' + who + '「' + item.title + '」（' + item.reason + '）')
    }
  }
  if (result.status === 'applied') {
    lines.push('- 宿主会话改名 ' + result.applied.hostRenamed + ' 个；跳过（已被他人改名）' + result.applied.hostSkipped + ' 个')
    lines.push('- 迁移标记已写入 store.meta.titles；重启不会重复执行。')
  }
  return lines.join('\n')
}
