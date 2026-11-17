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
  type Dispatch, type Episode, type FileMapEntry, type Hotcache, type Memory, type OutboxItem, type Requirement, type Routing, type Signal, type ToolMemory, type TopicSet,
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
  episodes: Table<Episode>
  requirements: Table<Requirement>
  filemap: Table<FileMapEntry>
  toolMemory: Table<ToolMemory>
  signals: Table<Signal>
  routing: Table<Routing>
  hotcache: Table<Hotcache>
  dispatches: Table<Dispatch>
  outbox: Table<OutboxItem>
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
      episodes: sd.domainTable(schemas.episodes),
      requirements: sd.domainTable(schemas.requirements),
      filemap: sd.domainTable(schemas.filemap),
      tool_memory: sd.domainTable(schemas.tool_memory),
      signals: sd.domainTable(schemas.signals),
      dispatches: sd.domainTable(schemas.dispatches),
      outbox: sd.domainTable(schemas.outbox),
      routing: sd.domainTable(schemas.routing),
      hotcache: sd.domainTable(schemas.hotcache),
    },
  }) as SupermemorySpec
  const domain = await storageDomain.open(spec)
  logger.info('supermemory: storage domain opened')
  const table = <V>(name: string) => domain.table(name) as unknown as Table<V>
  return {
    domain,
    topicsets: table<TopicSet>('topicsets'),
    memories: table<Memory>('memories'),
    episodes: table<Episode>('episodes'),
    requirements: table<Requirement>('requirements'),
    filemap: table<FileMapEntry>('filemap'),
    toolMemory: table<ToolMemory>('tool_memory'),
    signals: table<Signal>('signals'),
    routing: table<Routing>('routing'),
    hotcache: table<Hotcache>('hotcache'),
    dispatches: table<Dispatch>('dispatches'),
    outbox: table<OutboxItem>('outbox'),
    close: () => domain.close(),
  }
}
