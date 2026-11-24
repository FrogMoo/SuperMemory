/**
 * Domain store: opens the `supermemory` storage domain and exposes typed table
 * accessors plus workspace-key resolution.
 * @module supermemory/store
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { loadHostModule } from './host.ts'
import {
  buildSchemas,
  type Dispatch, type Episode, type FileMapEntry, type Hotcache, type HubPolicy, type HubSession, type Memory, type ModelDefaults, type MemoryCollection, type MemoryVersion, type Meta, type OutboxItem, type Question, type Requirement, type Routing, type Signal, type ToolMemory, type TopicSet,
} from './schema.ts'

/** Structural view of one KvTable handle (the domain layer's runtime type). */
export interface Table<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  keys(): IterableIterator<string>
  readonly size: number
  put(key: string, value: V): Promise<void>
  update(key: string, fn: (value: V) => V): Promise<void>
  delete(key: string): Promise<boolean>
  deleteMany(keys: readonly string[]): Promise<number>
}

/** The declared domain spec, narrowed to its literal type. */
export type SupermemorySpec = StorageDomain.DomainSpec & {
  readonly name: 'supermemory'
  readonly version: 1
}

export interface Store {
  readonly domain: StorageDomain.Domain<SupermemorySpec>
  topicsets: Table<TopicSet>
  memories: Table<Memory>
  /** R22 需求④: memory collections (entries stay in `memories`). */
  memoryCollections: Table<MemoryCollection>
  /** R30 需求①: historical versions of memories (entries stay in `memories`). */
  memoryVersions: Table<MemoryVersion>
  /** R36 需求①: the hub tool whitelist (one row per workspace). */
  hubPolicies: Table<HubPolicy>
  /** R41 需求①b: default hub/branch models (one row per workspace). */
  modelDefaults: Table<ModelDefaults>
  episodes: Table<Episode>
  requirements: Table<Requirement>
  filemap: Table<FileMapEntry>
  toolMemory: Table<ToolMemory>
  signals: Table<Signal>
  routing: Table<Routing>
  hotcache: Table<Hotcache>
  dispatches: Table<Dispatch>
  /** R20: branch-raised questions awaiting the hub's single user question. */
  questions: Table<Question>
  outbox: Table<OutboxItem>
  /** One-time migration markers (title repair); see title-migration.ts. */
  meta: Table<Meta>
  /** R33 需求②: positive hub records (never inferred from a missing parent). */
  hubs: Table<HubSession>
  close(): Promise<void>
}

/**
 * Canonical workspace key: the realpath of a session cwd (decision D4).
 * Falls back to the resolved path when the directory vanished.
 */
export function workspaceKeyOf(cwd: string | undefined | null): string {
  if (!cwd) return 'unknown'
  try {
    return realpathSync(resolve(cwd))
  } catch {
    return resolve(cwd)
  }
}

/** Monotonic-ish id helper (no host import needed). */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Backoff used while a disposing instance still owns the domain (plugin reload race). */
const STORE_OPEN_RETRY_MS = Object.freeze([100, 250, 750, 2000])

/**
 * Retry an async open while the domain name is still reserved by an instance
 * that is unloading.
 *
 * `storageDomain.open()` rejects `already-open` when the name is reserved by
 * an in-flight or completed open, and a plugin reload can start the new fiber
 * before the old fiber's domain disposer ran. Only that code is retried; every
 * other failure (version mismatch, malformed medium, backend route, …) is the
 * caller's to degrade on, immediately.
 */
export async function retryDomainOpen<T>(
  open: () => Promise<T>,
  logger: { warn: (msg: string) => void },
  delays: readonly number[] = STORE_OPEN_RETRY_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await open()
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      if (code !== 'already-open' || attempt >= delays.length) throw error
      logger.warn(`supermemory: storage domain still owned by a disposing instance; retrying in ${delays[attempt]}ms`)
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}

/** Open the storage domain, riding out a reload's domain-handover window. */
export async function openStoreWithRetry(
  storageDomain: StorageDomain.DomainFacility,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<Store> {
  return retryDomainOpen(() => openStore(storageDomain, logger), logger)
}

/**
 * Open the storage domain. A failure is logged and rethrown — the caller
 * decides whether to degrade (P0: degrade to a disabled store).
 */
export async function openStore(
  storageDomain: StorageDomain.DomainFacility,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<Store> {
  const sd = await loadHostModule('@deepseek-ai/dsh-storage-domain') as typeof StorageDomain
  const schemas = await buildSchemas()
  const spec = sd.defineDomain({
    name: 'supermemory',
    version: 1,
    tables: {
      topicsets: sd.domainTable(schemas.topicsets),
      memories: sd.domainTable(schemas.memories),
      memory_collections: sd.domainTable(schemas.memory_collections),
      memory_versions: sd.domainTable(schemas.memory_versions),
      episodes: sd.domainTable(schemas.episodes),
      requirements: sd.domainTable(schemas.requirements),
      filemap: sd.domainTable(schemas.filemap),
      tool_memory: sd.domainTable(schemas.tool_memory),
      signals: sd.domainTable(schemas.signals),
      dispatches: sd.domainTable(schemas.dispatches),
      questions: sd.domainTable(schemas.questions),
      outbox: sd.domainTable(schemas.outbox),
      routing: sd.domainTable(schemas.routing),
      hotcache: sd.domainTable(schemas.hotcache),
      meta: sd.domainTable(schemas.meta),
      hub_sessions: sd.domainTable(schemas.hub_sessions),
      hub_policies: sd.domainTable(schemas.hub_policies),
      model_defaults: sd.domainTable(schemas.model_defaults),
    },
  }) as SupermemorySpec
  const domain = await storageDomain.open(spec)
  logger.info('supermemory: storage domain opened')
  const table = <V>(name: string) => domain.table(name) as unknown as Table<V>
  return {
    domain,
    topicsets: table<TopicSet>('topicsets'),
    memories: table<Memory>('memories'),
    memoryCollections: table<MemoryCollection>('memory_collections'),
    memoryVersions: table<MemoryVersion>('memory_versions'),
    episodes: table<Episode>('episodes'),
    requirements: table<Requirement>('requirements'),
    filemap: table<FileMapEntry>('filemap'),
    toolMemory: table<ToolMemory>('tool_memory'),
    signals: table<Signal>('signals'),
    routing: table<Routing>('routing'),
    hotcache: table<Hotcache>('hotcache'),
    dispatches: table<Dispatch>('dispatches'),
    questions: table<Question>('questions'),
    outbox: table<OutboxItem>('outbox'),
    meta: table<Meta>('meta'),
    hubs: table<HubSession>('hub_sessions'),
    hubPolicies: table<HubPolicy>('hub_policies'),
    modelDefaults: table<ModelDefaults>('model_defaults'),
    close: () => domain.close(),
  }
}
