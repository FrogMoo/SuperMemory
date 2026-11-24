/**
 * R35 一次性迁移：给「R33 之前由面板创建、既未派发也非话题集 root」的中枢补
 * 正证据（hub_sessions 行）。
 *
 * 为什么需要它：R33 起「中枢」不再是「没有 parentSession 的顶层会话」推断出来
 * 的（那个推断把每个普通对话都判成中枢并禁掉 bash/write/edit/subagent）。现在
 * 只有正证据才算中枢：hub_sessions 行、话题集 root 成员、派发记录里的
 * hubSessionId。R33 之前面板创建的普通中枢只有「标题 + session-* id」这一条
 * 正证据，重载后会被判成 other——能执行工具，但不能重载插件。
 *
 * 本迁移只接受一条**窄**证据链，绝不退回「无父即中枢」：
 *   - id 由插件以 `session-` 铸造（{@link HUB_ID_PREFIX}）；
 *   - 顶层会话：无 parentSession、origin !== 'subagent'；
 *   - 宿主标题以 `SuperMemory 中枢` 开头（{@link HUB_TITLE_PREFIX}，由
 *     createHubSession 生成，R31 之后的新格式；旧格式早已被 hub-title-migration
 *     改成同一前缀，所以启动时先跑标题迁移、再跑本迁移）；
 *   - 会话自身 cwd 的 workspaceKey 在「本插件有数据的工作区」白名单内（由
 *     {@link knownWorkspaceKeys} 从 store 推导），记录按会话自己的 workspaceKey
 *     写入，绝不猜一个工作区；
 *   - 已有 hub 记录 → 跳过（幂等）；解析出 branch 事实 → 跳过（分支优先，不写
 *     一条会被 resolveRole 忽略的假审计行）。
 *
 * 标记（store.meta 行 `hub-records`）只在本次没有「标题读不到」的候选时写入：
 * 读不到标题的会话无法判定，下次启动再试（与 hub-title-migration 的自愈策略
 * 一致）。dryRun 不写任何东西。
 * @module supermemory/hub-records-migration
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import { HUB_ID_PREFIX, HUB_TITLE_PREFIX } from './hub-sessions.ts'
import { recordHubSession, resolveRole } from './role.ts'
import { currentSessionTitle } from './title.ts'

/** Bump when the candidate rules change; an older marker re-runs the pass. */
export const HUB_RECORDS_MIGRATION_VERSION = 1

/** The meta-table row key of the migration marker (never the 'hub-titles' row). */
const MARKER_KEY = 'hub-records'

export interface HubRecordMigrationDeps {
  ctx: Context | undefined
  store: Store | undefined
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
  /**
   * Workspaces this plugin has data for. When given (even empty) only sessions
   * inside that set are considered — fail-closed, never "mark everything".
   * Omitted means no workspace filter (unit tests).
   */
  workspaceKeys?: readonly string[]
}

/** One hub record the pass will write (or wrote). */
export interface HubRecordPlanItem {
  sessionId: string
  title: string
  workspaceKey: string
}

/** Why one hub-titled candidate was not marked. */
export interface HubRecordSkipItem {
  sessionId: string
  title?: string
  reason: 'already-recorded' | 'branch-fact' | 'title-unreadable'
}

export interface HubRecordMigrationResult {
  status: 'applied' | 'planned' | 'already-done' | 'no-host'
  /** Sessions the host corpus returned (before every filter). */
  scanned: number
  /** Top-level `session-` sessions in an in-scope workspace. */
  considered: number
  /** Candidates whose title did not start with {@link HUB_TITLE_PREFIX}. */
  skippedNonHub: number
  /** Rows written this run. */
  marked: number
  /** Hub-titled candidates whose title could not be read (retried next start). */
  pending: number
  /** Hub-titled candidates that already had positive evidence / are branches. */
  skipped: HubRecordSkipItem[]
  plan: HubRecordPlanItem[]
}

const zeros = { scanned: 0, considered: 0, skippedNonHub: 0, marked: 0, pending: 0 }

interface SessionHeaderLike {
  id?: string
  cwd?: string
  parentSession?: unknown
  origin?: string
}

interface SessionRecordLike {
  header: SessionHeaderLike
}

interface TitleObservationLike {
  sessionId?: string
  status?: 'fulfilled' | 'rejected'
  value?: { title?: { title?: string } }
}

interface SessionQueryLike {
  listSessions?(signal?: AbortSignal): Promise<SessionRecordLike[]>
  readTitleSnapshots?(sessionIds: readonly string[], signal?: AbortSignal): Promise<TitleObservationLike[]>
}

interface LiveSessionsLike {
  list?(): Array<{ id?: string; header?: SessionHeaderLike }>
}

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get?: (key: string) => unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/** The session corpus: sessionQuery first, live sessions as a fallback. */
async function listSessionRecords(ctx: Context): Promise<SessionRecordLike[] | undefined> {
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (query && typeof query.listSessions === 'function') {
    try {
      const rows = await query.listSessions()
      if (Array.isArray(rows)) return rows
    } catch { /* fall through to the live registry */ }
  }
  try {
    const live = serviceOf<LiveSessionsLike>(ctx, 'sessions')
    const rows = typeof live?.list === 'function' ? live.list() : []
    return rows.map((session) => ({ header: session.header ?? { id: session.id } }))
  } catch {
    return undefined
  }
}

/** Live/persisted titles for a batch of ids (batch seam first, per-session fallback). */
async function readTitles(ctx: Context, sessionIds: readonly string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (query && typeof query.readTitleSnapshots === 'function') {
    try {
      const observations = await query.readTitleSnapshots(sessionIds)
      for (const observation of observations) {
        if (!observation || observation.status !== 'fulfilled') continue
        const sessionId = String(observation.sessionId ?? '')
        const title = observation.value?.title?.title
        if (!sessionId || typeof title !== 'string') continue
        // An EMPTY fulfilled title is a known blank title (a never-titled
        // session), not an unreadable one — it must not block the marker.
        titles.set(sessionId, title.trim())
      }
    } catch { /* fall back to the per-session read */ }
  }
  for (const sessionId of sessionIds) {
    if (titles.has(sessionId)) continue
    const current = currentSessionTitle(ctx, sessionId)
    if (typeof current === 'string') titles.set(sessionId, current.trim())
  }
  return titles
}

/**
 * Workspaces this plugin has data for: every table carrying a `workspaceKey`
 * contributes (topic sets, memories, collections, filemap, requirements, hub
 * records). `unknown` and empty keys are never treated as a workspace.
 */
export function knownWorkspaceKeys(store: Store | undefined): string[] {
  const keys = new Set<string>()
  if (!store) return []
  const tables: Array<{ entries(): IterableIterator<[string, unknown]> } | undefined> = [
    store.topicsets as unknown as { entries(): IterableIterator<[string, unknown]> },
    store.memories as unknown as { entries(): IterableIterator<[string, unknown]> },
    store.memoryCollections as unknown as { entries(): IterableIterator<[string, unknown]> },
    store.filemap as unknown as { entries(): IterableIterator<[string, unknown]> },
    store.requirements as unknown as { entries(): IterableIterator<[string, unknown]> },
    store.hubs as unknown as { entries(): IterableIterator<[string, unknown]> },
  ]
  for (const table of tables) {
    if (!table) continue
    try {
      for (const [, row] of table.entries()) {
        const key = String((row as { workspaceKey?: unknown } | undefined)?.workspaceKey ?? '')
        if (key && key !== 'unknown') keys.add(key)
      }
    } catch { /* an unreadable table contributes nothing */ }
  }
  return [...keys]
}

/** The persisted migration marker (undefined when never run). */
export async function hubRecordsMigrationMarker(
  store: Store | undefined,
): Promise<{ hubRecordsMigratedAt?: number; hubRecordsMigrationVersion?: number } | undefined> {
  try {
    return (await store?.meta?.get(MARKER_KEY)) as
      | { hubRecordsMigratedAt?: number; hubRecordsMigrationVersion?: number }
      | undefined
  } catch {
    return undefined
  }
}

async function writeMarker(store: Store | undefined): Promise<void> {
  if (!store?.meta) return
  await store.meta.put(MARKER_KEY, {
    hubRecordsMigratedAt: Date.now(),
    hubRecordsMigrationVersion: HUB_RECORDS_MIGRATION_VERSION,
  })
}

/** Whether this session already has a positive hub record (guarded read). */
function hubRecordOf(store: Store | undefined, sessionId: string): unknown {
  try {
    return store?.hubs?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Run (or preview) the one-time pass. Startup calls it with no options; tests
 * force a pass with `ignoreMarker`.
 */
export async function migrateHubSessionRecords(
  deps: HubRecordMigrationDeps,
  options: { dryRun?: boolean; ignoreMarker?: boolean } = {},
): Promise<HubRecordMigrationResult> {
  const { ctx, store, logger } = deps
  if (!options.ignoreMarker) {
    const marker = await hubRecordsMigrationMarker(store)
    if (marker && (marker.hubRecordsMigrationVersion ?? 0) >= HUB_RECORDS_MIGRATION_VERSION) {
      return { status: 'already-done', ...zeros, plan: [], skipped: [] }
    }
  }
  if (!ctx) return { status: 'no-host', ...zeros, plan: [], skipped: [] }
  const records = await listSessionRecords(ctx)
  if (!records) return { status: 'no-host', ...zeros, plan: [], skipped: [] }
  const scope = deps.workspaceKeys ? new Set(deps.workspaceKeys) : undefined

  const scanned = records.length
  const candidates: Array<{ sessionId: string; workspaceKey: string; title?: string }> = []
  const skipped: HubRecordSkipItem[] = []
  let considered = 0

  for (const record of records) {
    const header = record?.header ?? {}
    const sessionId = String(header.id ?? '')
    if (!sessionId.startsWith(HUB_ID_PREFIX)) continue
    if (header.parentSession) continue
    if (header.origin === 'subagent') continue
    if (!header.cwd) continue
    const workspaceKey = workspaceKeyOf(header.cwd)
    if (scope && !scope.has(workspaceKey)) continue
    considered += 1
    candidates.push({ sessionId, workspaceKey })
  }

  const titles = await readTitles(ctx, candidates.map((candidate) => candidate.sessionId))
  const plan: HubRecordPlanItem[] = []
  let skippedNonHub = 0
  let pending = 0
  for (const candidate of candidates) {
    const title = titles.get(candidate.sessionId)
    if (title === undefined) {
      // Unknown is not "not a hub": leave the marker open and retry next start.
      pending += 1
      skipped.push({ sessionId: candidate.sessionId, reason: 'title-unreadable' })
      continue
    }
    if (!title.startsWith(HUB_TITLE_PREFIX)) {
      skippedNonHub += 1
      continue
    }
    plan.push({ sessionId: candidate.sessionId, title, workspaceKey: candidate.workspaceKey })
  }

  const toWrite: HubRecordPlanItem[] = []
  for (const item of plan) {
    if (hubRecordOf(store, item.sessionId)) {
      skipped.push({ sessionId: item.sessionId, title: item.title, reason: 'already-recorded' })
      continue
    }
    // Branch facts win in resolveRole; never write an audit row that the role
    // resolution would immediately override (it would lie).
    if (resolveRole(store, { id: item.sessionId, session: { header: { cwd: item.workspaceKey } } }).role === 'branch') {
      skipped.push({ sessionId: item.sessionId, title: item.title, reason: 'branch-fact' })
      continue
    }
    toWrite.push(item)
  }

  if (options.dryRun) {
    return {
      status: 'planned', scanned, considered, skippedNonHub, marked: 0, pending,
      skipped, plan: toWrite,
    }
  }

  let marked = 0
  for (const item of toWrite) {
    await recordHubSession(store, {
      sessionId: item.sessionId,
      workspaceKey: item.workspaceKey,
      title: item.title,
      source: 'title-migration',
    })
    // Verify the write: a missing hub table silently loses it, and a marker over
    // a lost write would never retry.
    if (hubRecordOf(store, item.sessionId)) marked += 1
    else pending += 1
  }
  if (pending === 0) await writeMarker(store)
  logger.info(
    `supermemory: hub record migration applied — scanned ${scanned}, considered ${considered}`
    + `, marked ${marked}, skipped ${skipped.length}, pending ${pending}`,
  )
  return { status: 'applied', scanned, considered, skippedNonHub, marked, pending, skipped, plan: toWrite }
}
