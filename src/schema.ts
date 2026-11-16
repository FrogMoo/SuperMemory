/**
 * Storage domain declaration (storageDomain: `supermemory`, version 1).
 *
 * Every business table carries `workspaceKey` from v1 (decision D4): the schema
 * is effectively impossible to walk back once published. Session-scoped tables
 * (`routing`, `hotcache`) are keyed by sessionId and stay workspace-free by
 * design. Record schemas are zod, loaded from the host copy at apply time so
 * validation runs on the same zod instance the domain layer uses.
 * @module supermemory/schema
 */
import type * as z from 'zod'
import { loadHostModule } from './host.ts'

export type ZodModule = typeof import('zod')

let zodPending: Promise<ZodModule> | undefined

/** The host's zod module (v4), shared with the storage-domain layer. */
export function getZod(): Promise<ZodModule> {
  return (zodPending ??= loadHostModule('zod') as Promise<ZodModule>)
}

/** Builds every table schema of the domain. Called once, inside apply(). */
export async function buildSchemas() {
  const z = await getZod()

  const member = z.object({
    sessionId: z.string(),
    kind: z.enum(['root', 'fork']).default('root'),
    title: z.string().default(''),
    summary: z.string().default(''),
    status: z.enum(['live', 'idle']).default('live'),
    model: z.string().optional(),
    modelOverridden: z.boolean().default(false),
    lastActiveAt: z.number().int().default(0),
  })

  const topicsets = z.object({
    workspaceKey: z.string(),
    title: z.string(),
    summary: z.string().default(''),
    keywords: z.array(z.string()).default([]),
    status: z.enum(['active', 'archived']).default('active'),
    defaultModel: z.object({
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().optional(),
    }).optional(),
    members: z.array(member).default([]),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastActiveAt: z.number().int().default(0),
  })

  const memories = z.object({
    workspaceKey: z.string(),
    text: z.string(),
    key: z.string().optional(),
    keywords: z.array(z.string()).default([]),
    sourceSessionId: z.string(),
    sourceSeq: z.number().int().nonnegative(),
    status: z.enum(['active', 'superseded']).default('active'),
    supersededBy: z.string().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })

  const episodes = z.object({
    topicSetId: z.string().optional(),
    branchSessionId: z.string().optional(),
    timeStart: z.number().int(),
    timeEnd: z.number().int(),
    summary: z.string().default(''),
    decisions: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    nextSteps: z.array(z.string()).default([]),
    reqIds: z.array(z.string()).default([]),
    sourceSessionId: z.string(),
    sourceSeqStart: z.number().int().nonnegative(),
    sourceSeqEnd: z.number().int().nonnegative(),
  })

  const requirements = z.object({
    topicSetId: z.string().optional(),
    workspaceKey: z.string(),
    text: z.string(),
    constraints: z.array(z.string()).default([]),
    status: z.enum(['open', 'closed']).default('open'),
    sourceSessionId: z.string(),
    sourceSeq: z.number().int().nonnegative(),
    createdAt: z.number().int(),
    closedAt: z.number().int().optional(),
  })

  const filemap = z.object({
    workspaceKey: z.string(),
    role: z.string().default(''),
    summary: z.string().default(''),
    keywords: z.array(z.string()).default([]),
    hash: z.string().optional(),
    mtime: z.number().int().optional(),
    annotatedAt: z.number().int(),
  })

  const toolMemory = z.object({
    workspaceKey: z.string().optional(),
    kind: z.enum(['composite', 'skill', 'workflow']).default('composite'),
    trigger: z.string().default(''),
    description: z.string().default(''),
    entry: z.string().default(''),
    useCount: z.number().int().nonnegative().default(0),
    status: z.enum(['active', 'retired']).default('active'),
  })

  const signals = z.object({
    workspaceKey: z.string(),
    pattern: z.string(),
    count: z.number().int().nonnegative().default(0),
    lastSeen: z.number().int(),
    examples: z.array(z.string()).default([]),
  })

  const dispatches = z.object({
    topicSetId: z.string().optional(),
    groupId: z.string().optional(),
    branchSessionId: z.string(),
    task: z.string(),
    hubSessionId: z.string(),
    startSeq: z.number().int().nonnegative(),
    turnEndReason: z.string().optional(),
    status: z.enum(['queued', 'dispatched', 'observed', 'summarized', 'delivered', 'failed']).default('queued'),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })

  const outbox = z.object({
    dispatchId: z.string().optional(),
    groupId: z.string().optional(),
    kind: z.enum(['single', 'group']).default('single'),
    payload: z.string(),
    status: z.enum(['pending', 'relayed', 'confirmed', 'failed']).default('pending'),
    enqueuedAt: z.number().int(),
    relayedAt: z.number().int().optional(),
  })

  const routing = z.object({
    activeTopicSetId: z.string().optional(),
    driftCount: z.number().int().nonnegative().default(0),
    updatedAt: z.number().int(),
  })

  const hotcache = z.object({
    recentRelevant: z.object({
      episodes: z.array(z.string()).default([]),
      reqIds: z.array(z.string()).default([]),
      memoryIds: z.array(z.string()).default([]),
      toolNames: z.array(z.string()).default([]),
    }).default({ episodes: [], reqIds: [], memoryIds: [], toolNames: [] }),
    lastMaintainedSeq: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int(),
  })

  return {
    topicsets, memories, episodes, requirements, filemap, tool_memory: toolMemory,
    signals, dispatches, outbox, routing, hotcache,
  }
}

export type Schemas = Awaited<ReturnType<typeof buildSchemas>>

export type TopicSet = z.infer<Schemas['topicsets']>
export type Memory = z.infer<Schemas['memories']>
export type Episode = z.infer<Schemas['episodes']>
export type Requirement = z.infer<Schemas['requirements']>
export type FileMapEntry = z.infer<Schemas['filemap']>
export type ToolMemory = z.infer<Schemas['tool_memory']>
export type Signal = z.infer<Schemas['signals']>
export type Dispatch = z.infer<Schemas['dispatches']>
export type OutboxItem = z.infer<Schemas['outbox']>
export type Routing = z.infer<Schemas['routing']>
export type Hotcache = z.infer<Schemas['hotcache']>
