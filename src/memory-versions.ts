/**
 * R30 需求①: 记忆的版本控制（就地更新 + 升版 + 历史归档）。
 *
 * 模型（与「记忆集合 + 条目」两级模型并行的第三维度）：
 * - `memories` 行永远只有一条（同一 key 不新开行）：更新 = 就地修改
 *   title/text/tags/集合，version+1；
 * - `memory_versions` 是完整的版本日志：每个版本一行完整快照（标题/标签/
 *   正文/集合），当前版本同时存在于 memories 行与最后一条历史行；
 * - 写入语义：create=新建 v1 并归档 v1（changeType 'create'）；update=就地
 *   更新升版并归档新版本（changeType 'update'）；migrate=旧记忆惰性迁移补的
 *   v1 历史（changeType 'migrate'，不丢数据、不改写正文）。
 *
 * 本模块是版本化读写的**唯一入口**（类似 questions.ts 对 questions 表的模式）：
 * tools.ts 的 memory_remember、panel.ts 的面板新建/编辑、webui.ts 的管理台
 * 编辑、maintenance.ts 的自动抽取都走这里，任何路径都不允许绕过版本化直接
 * `memories.put/update`。
 *
 * 兼容：旧介质没有 memory_versions 表（或宿主降级存储）时，写路径退化为
 * 「只改 memories 行、不写历史」，读路径退化为「只有当前版本」——与
 * questions.ts 的 questionsOf 同一套容错。
 * @module supermemory/memory-versions
 */
import type { Memory, MemoryVersion } from './schema.ts'
import { newId } from './store.ts'

/** 一次版本归档的 changeType 词汇。 */
export type MemoryChangeType = 'create' | 'update' | 'migrate'

/**
 * Structural view of the tables this module touches. Accepts the full `Store`
 * and every partial double (older test fixture / a medium opened before
 * `memory_versions` existed): the history table is optional on purpose, and
 * every writer degrades to "memories row only" when it is absent — the same
 * tolerance questions.ts applies to its table.
 */
export interface VersionStore {
  memories: {
    get(key: string): Memory | undefined
    entries(): IterableIterator<[string, Memory]>
    put(key: string, value: Memory): Promise<void>
    update(key: string, fn: (value: Memory) => Memory): Promise<void>
  }
  memoryVersions?: {
    entries(): IterableIterator<[string, MemoryVersion]>
    put(key: string, value: MemoryVersion): Promise<void>
  }
}

/** True when this store can persist memory history rows. */
export function memoryVersionsSupported(store: VersionStore | undefined): boolean {
  const table = store?.memoryVersions
  return !!table && typeof table.put === 'function' && typeof table.entries === 'function'
}

/** 当前记忆的版本号（旧记录没有 version 字段时读作 1，与 zod 默认值一致）。 */
export function currentVersionOf(memory: Memory | undefined): number {
  const version = Number(memory?.version)
  return Number.isInteger(version) && version > 0 ? version : 1
}

/** 新建一条记忆要写入的字段（版本化创建的唯一输入）。 */
export interface CreateMemoryInput {
  title?: string
  text: string
  tags?: readonly string[]
  /** 稳定键（同一事实的更新标识）；拆分写入不沿用。 */
  key?: string
  collectionId?: string
  sourceSessionId: string
  sourceSeq: number
}

/**
 * 版本化创建：写入 memories 行（version=1）并归档一条 v1 历史
 * （changeType 'create'）。返回新记忆 id；没有历史表时只写 memories 行。
 */
export async function createMemoryVersioned(
  store: VersionStore,
  workspaceKey: string,
  input: CreateMemoryInput,
  now = Date.now(),
): Promise<string> {
  const memoryId = newId('mem')
  const memory: Memory = {
    workspaceKey,
    title: input.title ?? '',
    text: input.text,
    keywords: [...(input.tags ?? [])],
    ...(input.key ? { key: input.key } : {}),
    ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    sourceSessionId: input.sourceSessionId,
    sourceSeq: input.sourceSeq,
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  await store.memories.put(memoryId, memory)
  await archiveVersion(store, {
    workspaceKey, memoryId, version: 1,
    title: memory.title, text: memory.text, tags: memory.keywords,
    collectionId: input.collectionId, updatedAt: now, changeType: 'create',
  })
  return memoryId
}

/** 就地更新的补丁（只设置调用方给出的字段；集合变更同样是一次升版）。 */
export interface UpdateMemoryPatch {
  title?: string
  text?: string
  tags?: readonly string[]
  collectionId?: string
  key?: string
}

/** 一次版本化更新的结果。 */
export interface UpdateMemoryResult {
  status: 'updated' | 'unchanged'
  /** 更新后的版本号（unchanged 时为当前版本）。 */
  version: number
  memoryId: string
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase()
}

function sameTags(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = (left ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
  const b = (right ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((tag) => set.has(tag))
}

/** 内容是否变化（正文/标题/标签/集合任一不同即算变化，集合变更也记入历史）。 */
function contentChanged(memory: Memory, patch: UpdateMemoryPatch): boolean {
  if (patch.text !== undefined && !sameText(memory.text, patch.text)) return true
  if (patch.title !== undefined && (patch.title ?? '') !== (memory.title ?? '')) return true
  if (patch.tags !== undefined && !sameTags(memory.keywords, patch.tags)) return true
  if (patch.collectionId !== undefined && (patch.collectionId ?? '') !== (memory.collectionId ?? '')) return true
  if (patch.key !== undefined && (patch.key ?? '') !== (memory.key ?? '')) return true
  return false
}

/**
 * 内容三要素（标题/正文/标签）是否都没变——集合归属另算。
 *
 * 写路径用它做「幂等快速判定」：内容没变时不必去解析集合归属，否则一次
 * 完全相同内容的重写可能顺手新建一个空集合（记忆却没被挂上去）。
 */
export function memoryContentUnchanged(
  memory: Memory,
  patch: { title?: string; text?: string; tags?: readonly string[] },
): boolean {
  if (patch.text !== undefined && !sameText(memory.text, patch.text)) return false
  if (patch.title !== undefined && (patch.title ?? '') !== (memory.title ?? '')) return false
  if (patch.tags !== undefined && !sameTags(memory.keywords, patch.tags)) return false
  return true
}

/**
 * 版本化就地更新：同 key 不同内容时直接改当前记忆并 version+1，把新版本整体
 * 归档进 memory_versions（旧版本从它创建/上一次更新起就已在档）。
 *
 * 幂等：内容完全相同 → 不升版、不写历史（status 'unchanged'）。
 * 记忆不存在 / 不属于该工作区时返回 undefined（调用方自行报错）。
 */
export async function updateMemoryVersioned(
  store: VersionStore,
  workspaceKey: string,
  memoryId: string,
  patch: UpdateMemoryPatch,
  now = Date.now(),
): Promise<UpdateMemoryResult | undefined> {
  const memory = store.memories.get(memoryId)
  if (!memory || memory.workspaceKey !== workspaceKey) return undefined
  const version = currentVersionOf(memory)
  if (!contentChanged(memory, patch)) {
    return { status: 'unchanged', version, memoryId }
  }
  const next: Memory = {
    ...memory,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.tags !== undefined ? { keywords: [...patch.tags] } : {}),
    ...(patch.collectionId !== undefined
      ? (patch.collectionId ? { collectionId: patch.collectionId } : { collectionId: undefined })
      : {}),
    ...(patch.key !== undefined ? (patch.key ? { key: patch.key } : { key: undefined }) : {}),
    version: version + 1,
    updatedAt: now,
  }
  await store.memories.update(memoryId, () => next)
  await archiveVersion(store, {
    workspaceKey, memoryId, version: next.version,
    title: next.title, text: next.text, tags: next.keywords,
    collectionId: next.collectionId, updatedAt: now, changeType: 'update',
  })
  return { status: 'updated', version: next.version, memoryId }
}

/** 归档一条历史版本（内部入口；没有历史表时静默跳过）。 */
async function archiveVersion(
  store: VersionStore,
  row: {
    workspaceKey: string
    memoryId: string
    version: number
    title: string
    text: string
    tags: readonly string[]
    collectionId?: string
    updatedAt: number
    changeType: MemoryChangeType
  },
): Promise<void> {
  const table = store.memoryVersions
  if (!table) return
  const record: MemoryVersion = {
    workspaceKey: row.workspaceKey,
    memoryId: row.memoryId,
    version: row.version,
    title: row.title ?? '',
    text: row.text,
    tags: [...(row.tags ?? [])],
    ...(row.collectionId ? { collectionId: row.collectionId } : {}),
    updatedAt: row.updatedAt,
    changeType: row.changeType,
  }
  await table.put(newId('memv'), record)
}

/** 一条记忆的全部历史版本（按版本号升序；没有历史表时返回空数组）。 */
export function memoryHistoryOf(store: VersionStore, memoryId: string): MemoryVersion[] {
  const table = store.memoryVersions
  if (!table) return []
  const rows: MemoryVersion[] = []
  for (const [, row] of table.entries()) {
    if (row.memoryId !== memoryId) continue
    rows.push(row)
  }
  rows.sort((a, b) => a.version - b.version || a.updatedAt - b.updatedAt)
  return rows
}

/** 同一工作区、active、带该 key 的记忆（用于「同 key → 就地更新」判定）。 */
export function findMemoryByKey(
  store: VersionStore,
  workspaceKey: string,
  key: string,
): [string, Memory] | undefined {
  for (const entry of store.memories.entries()) {
    const [id, memory] = entry
    if (memory.workspaceKey !== workspaceKey || memory.status !== 'active') continue
    if (memory.key !== key) continue
    return [id, memory]
  }
  return undefined
}

/** 惰性迁移的结果计数。 */
export interface VersionMigrationResult {
  /** 本次补写 v1 历史的记忆条数（每条只补一次，可重复执行）。 */
  migrated: number
}

/**
 * 惰性迁移：给「没有任何历史行」的旧记忆补一条 v1 历史（changeType 'migrate'），
 * 不改写正文/标题/标签/集合，也不动 version（旧记录读时即 version=1）。
 *
 * 判重按 memoryId 查历史表，所以天然幂等：新写入的记忆create 时已在档，
 * 不会重复补；可以像 migrateFlatMemories 一样在 recall/remember 前调用。
 */
export async function migrateMemoryVersions(
  store: VersionStore,
  workspaceKey: string,
  now = Date.now(),
): Promise<VersionMigrationResult> {
  const table = store.memoryVersions
  if (!table) return { migrated: 0 }
  const seen = new Set<string>()
  for (const [, row] of table.entries()) {
    if (row.workspaceKey !== workspaceKey) continue
    seen.add(row.memoryId)
  }
  let migrated = 0
  for (const [id, memory] of store.memories.entries()) {
    if (memory.workspaceKey !== workspaceKey) continue
    if (seen.has(id)) continue
    await archiveVersion(store, {
      workspaceKey, memoryId: id, version: currentVersionOf(memory),
      title: memory.title ?? '', text: memory.text, tags: memory.keywords ?? [],
      collectionId: memory.collectionId, updatedAt: memory.updatedAt ?? now, changeType: 'migrate',
    })
    migrated += 1
  }
  return { migrated }
}
