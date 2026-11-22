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
    // R19 需求⑥: the last LLM-generated topic-set shape. The fingerprint is the
    // content snapshot that produced `title`/`keywords`/`summary`; activation
    // only calls the model again when the snapshot changed (and the throttle
    // elapsed), so a quiet activation costs no tokens. Records written before
    // R19 read as ''/0 and are regenerated on their next activation.
    shapeFingerprint: z.string().default(''),
    shapeGeneratedAt: z.number().int().default(0),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastActiveAt: z.number().int().default(0),
  })

  const memories = z.object({
    workspaceKey: z.string(),
    // R10 retrieval shape: title + tags (keywords) + body, so a query can be
    // answered from the index instead of scanning every memory's body. Older
    // records predate `title`; the default keeps them readable in place (the
    // domain stays v1 — its schemas accept mixed generations on disk).
    title: z.string().default(''),
    text: z.string(),
    key: z.string().optional(),
    keywords: z.array(z.string()).default([]),
    // R22 需求④: an entry belongs to a memory collection. Optional on purpose:
    // records written before collections existed (and every producer outside
    // this module — panel, web console, fact extraction) stay valid, and a
    // lazy migration assigns them on the next recall/remember/export.
    collectionId: z.string().optional(),
    sourceSessionId: z.string(),
    sourceSeq: z.number().int().nonnegative(),
    status: z.enum(['active', 'superseded']).default('active'),
    supersededBy: z.string().optional(),
    // R30 需求①: 记忆版本号。同一 key 的更新不再新开一行，而是就地修改并
    // version+1（旧版本整体归档进 memory_versions）。旧介质没有这个字段，
    // zod 默认值在读时补齐为 1，并由惰性迁移补一条 v1 历史（域保持 v1 兼容）。
    version: z.number().int().default(1),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })

  // R22 需求④: 记忆集合 —— the same shape as a topic set (title + tags + body)
  // but for conclusions instead of conversations. A new table keeps the flat
  // `memories` table and every existing reader untouched: an old medium simply
  // has no rows here, so the domain stays v1-compatible (same as `questions`).
  const memoryCollections = z.object({
    workspaceKey: z.string(),
    title: z.string(),
    keywords: z.array(z.string()).default([]),
    summary: z.string().default(''),
    status: z.enum(['active', 'archived']).default('active'),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })

  // R30 需求①: 记忆历史版本 —— 一条记忆的每一次版本都是一行完整快照（标题/
  // 标签/正文/集合），与 memories.version 共同构成版本日志：当前版本永远同时
  // 存在于 memories 行与最后一条历史行，旧版本只增不减地留在本表。
  // 旧介质没有行即空表，域保持 v1 兼容（同 questions 的新表模式）。
  const memoryVersions = z.object({
    workspaceKey: z.string(),
    memoryId: z.string(),
    version: z.number().int(),
    title: z.string().default(''),
    text: z.string(),
    /** 该版本的标签（与 memories.keywords 同语义，历史行用 tags 命名）。 */
    tags: z.array(z.string()).default([]),
    collectionId: z.string().optional(),
    /** 该版本生效的时间（创建/更新时刻；迁移行沿用记忆自身的 updatedAt）。 */
    updatedAt: z.number().int(),
    /** create=新建 v1；update=就地更新升版；migrate=旧记忆惰性迁移补的 v1。 */
    changeType: z.enum(['create', 'update', 'migrate']),
  })

  const episodes = z.object({
    topicSetId: z.string().optional(),
    branchSessionId: z.string().optional(),
    timeStart: z.number().int(),
    timeEnd: z.number().int(),
    /** Short form for recall cards / topic-shape fingerprints / exports. */
    summary: z.string().default(''),
    /**
     * The branch's FULL final answer. `summary` is deliberately short (recall
     * cards, topic-shape fingerprints and exports read it), but the hub-facing
     * relay must carry the whole result: clipping it there silently destroyed
     * most of a branch's work. Episodes written before this field read as ''
     * and fall back to `summary` (the domain stays v1).
     */
    result: z.string().default(''),
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
    path: z.string(),
    role: z.string().default(''),
    summary: z.string().default(''),
    keywords: z.array(z.string()).default([]),
    hash: z.string().optional(),
    mtime: z.number().int().optional(),
    annotatedAt: z.number().int(),
  })

  const toolMemory = z.object({
    workspaceKey: z.string().optional(),
    // R28: 能力/组合工具的增加时间（面板「固化能力」页签「增加时间」列的数据源）。
    // 可选：旧介质没有这个字段，读作 undefined，由启动回填一次性补齐
    // （src/composite.ts backfillToolMemoryAttribution）；域版本保持 v1 兼容。
    createdAt: z.number().int().optional(),
    kind: z.enum(['composite', 'skill', 'workflow']).default('composite'),
    // Same retrieval shape as memories/topic sets: a human title, tags for
    // matching, and the description as the body.
    title: z.string().default(''),
    tags: z.array(z.string()).default([]),
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
    // P3 tool-ization: proposal lifecycle (null = not yet proposed)
    proposedAt: z.number().int().optional(),
    proposalStatus: z.enum(['pending', 'accepted', 'declined']).optional(),
    // recorded tool-call sequence for composite generation
    sequence: z.array(z.string()).default([]),
    samples: z.array(z.string()).default([]),
  })

  const dispatches = z.object({
    topicSetId: z.string().optional(),
    groupId: z.string().optional(),
    branchSessionId: z.string(),
    task: z.string(),
    hubSessionId: z.string(),
    startSeq: z.number().int().nonnegative(),
    turnEndReason: z.string().optional(),
    status: z.enum(['queued', 'dispatched', 'observed', 'summarized', 'delivered', 'failed', 'interrupted']).default('queued'),
    // D: last heartbeat while the branch was still working (timeout judgement)
    lastActivityAt: z.number().int().optional(),
    // R30 需求④: 分支会话的显式标题与标签（DSH 会话原生只支持标题、不支持标签，
    // 见 title.ts 对 dsh-session-title 的核实；标签因此落在派发行上，成为
    // 「分支会话 → 标题/标签」的持久映射）。标题取任务首行，标签 = 话题集标签 +
    // 轮次令牌 + 任务性质 + 能力档位（src/branch-meta.ts 推导）。
    // 带默认值：R30 之前的派发记录读作 ''/[]，存储域保持 v1 兼容（同 D/E 的可选字段）。
    title: z.string().default(''),
    tags: z.array(z.string()).default([]),
    // E: 续跑关联（中断任务由用户决定继续）。续跑产生的新派发记录原 dispatchId
    // （resumeOf），原派发回写续跑派发 id（resumedBy）。两个字段都是可选的：
    // 旧记录读作 undefined，存储域保持 v1 兼容（同 D 的 interrupted/lastActivityAt）。
    resumeOf: z.string().optional(),
    resumedBy: z.string().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })

  // R20: structured questions a BRANCH raises to the hub (never to the user).
  // A separate table keeps dispatch status/cursor logic untouched and stays
  // backward compatible: an old medium simply has no rows here, so every field
  // except the identity ones is defaulted on read.
  const questions = z.object({
    dispatchId: z.string().optional(),
    groupId: z.string().optional(),
    topicSetId: z.string().optional(),
    branchSessionId: z.string(),
    hubSessionId: z.string().optional(),
    /** The dispatched task label, so a hub aggregate is readable without a join. */
    branchTask: z.string().default(''),
    title: z.string(),
    question: z.string(),
    options: z.array(z.string()).default([]),
    severity: z.enum(['low', 'medium', 'high']).default('medium'),
    /** false = the branch keeps working under its best interpretation. */
    blocking: z.boolean().default(false),
    /** What the branch already finished (required for blocking=true by contract). */
    progress: z.string().default(''),
    /** The branch's default fallback if the user never answers. */
    defaultPlan: z.string().default(''),
    status: z.enum(['open', 'resolved']).default('open'),
    /** The user's answer, filled by the hub's memory_questions resolve step. */
    answer: z.string().optional(),
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

  // One-time migration markers (title repair). A single row keyed 'titles';
  // an old medium simply has no rows here, so the domain stays v1-compatible.
  const meta = z.object({
    titlesMigratedAt: z.number().int().optional(),
    titlesMigrationVersion: z.number().int().optional(),
    // R23 merge marker (meta row 'merges'): executed cluster signatures.
    mergesVersion: z.number().int().optional(),
    mergeSignatures: z.array(z.string()).optional(),
    lastMergeAt: z.number().int().optional(),
    // R23 memory re-layout marker (meta row 'organize-<digest>'): one
    // pass per workspace; an older version re-runs the plan. The fields are
    // declared here because the meta schema strips unknown keys on load — a
    // marker outside the schema would silently vanish on the next open.
    organizeVersion: z.number().int().optional(),
    organizeAppliedAt: z.number().int().optional(),
    organizeWorkspace: z.string().optional(),
    organizeBackup: z.string().optional(),
    organizeSummary: z.string().optional(),
  })

  return {
    topicsets, memories, memory_collections: memoryCollections, memory_versions: memoryVersions,
    episodes, requirements, filemap,
    tool_memory: toolMemory, signals, dispatches, questions, outbox, routing, hotcache, meta,
  }
}

export type Schemas = Awaited<ReturnType<typeof buildSchemas>>

export type TopicSet = z.infer<Schemas['topicsets']>
export type Memory = z.infer<Schemas['memories']>
export type MemoryCollection = z.infer<Schemas['memory_collections']>
/** R30 需求①: one historical version of a memory (full snapshot). */
export type MemoryVersion = z.infer<Schemas['memory_versions']>
export type Episode = z.infer<Schemas['episodes']>
export type Requirement = z.infer<Schemas['requirements']>
export type FileMapEntry = z.infer<Schemas['filemap']>
export type ToolMemory = z.infer<Schemas['tool_memory']>
export type Signal = z.infer<Schemas['signals']>
export type Dispatch = z.infer<Schemas['dispatches']>
export type Question = z.infer<Schemas['questions']>
export type OutboxItem = z.infer<Schemas['outbox']>
export type Routing = z.infer<Schemas['routing']>
export type Hotcache = z.infer<Schemas['hotcache']>
export type Meta = z.infer<Schemas['meta']>
