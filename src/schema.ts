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

  // R36 需求①: 中枢工具白名单（默认拒绝）——每个工作区一行。它是有工作区
  // 归属的数据（不是 meta 标记），所以独立建表：旧介质没有行即空表，读取时
  // 回退内置默认白名单，域保持 v1 兼容（同 memory_collections 的新表模式）。
  const hubPolicies = z.object({
    workspaceKey: z.string(),
    tools: z.array(z.string()).default([]),
    prefixes: z.array(z.string()).default([]),
    updatedAt: z.number().int(),
  })

  // R41 需求①b: 默认模型设置——每个工作区一行（中枢会话 / 分支会话）。和
  // hub_policies 一样是「有工作区归属的数据」，不是进程级 meta 标记。
  const modelDefaults = z.object({
    workspaceKey: z.string(),
    /** 新建中枢会话的默认模型；缺省=跟随宿主默认。 */
    hub: z.object({
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().optional(),
    }).optional(),
    /** 新派发分支会话的默认模型；缺省=跟随话题集/中枢/宿主默认。 */
    branch: z.object({
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().optional(),
    }).optional(),
    updatedAt: z.number().int(),
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
    // （src/capability.ts migrateCapabilities）；域版本保持 v1 兼容。
    createdAt: z.number().int().optional(),
    /**
     * R50 统一能力记录：capability = 可执行能力（知识面 + 执行面），knowledge =
     * 仅知识能力（知识面文件，无入口命令），proposal = 待接受的自动知识草稿。
     * composite / skill / workflow 是 R50 之前的历史 kind，只由惰性迁移读取：
     * 旧 capability（kind='composite' + spec.kind='capability'）迁为 capability，
     * 旧 skill 行迁为 knowledge，旧的工具序列行退役（status='retired'）。
     */
    kind: z.enum(['composite', 'skill', 'workflow', 'capability', 'knowledge', 'proposal']).default('composite'),
    // Same retrieval shape as memories/topic sets: a human title, tags for
    // matching, and the description as the body.
    title: z.string().default(''),
    tags: z.array(z.string()).default([]),
    trigger: z.string().default(''),
    description: z.string().default(''),
    /**
     * R50：新行为能力记录的 JSON 定义（CapabilityRecord）；旧行仍是旧的
     * CompositeSpec / skill 路径。读取统一走 capability.ts readCapabilityRow，
     * 迁移后旧行改写为新定义。域版本保持 v1。
     */
    entry: z.string().default(''),
    useCount: z.number().int().nonnegative().default(0),
    status: z.enum(['active', 'retired']).default('active'),
    // ---- R50 统一能力的行级镜像字段（旧介质读作缺省值，降级安全）----
    /** 知识面文件绝对路径（R52：.dsh/capabilities/<name>.md；旧 kind='skill' 行迁移时从 entry 取出）。 */
    skillPath: z.string().optional(),
    /** 启用/停用同时作用于知识面（disable-model-invocation）与执行面（工具注册）。 */
    enabled: z.boolean().default(true),
    /** 模型经 sm_cap_doc 加载本能力知识面的次数（转化率分母）。 */
    loadCount: z.number().int().nonnegative().default(0),
    /** 执行面（sm_cap_* 工具 / 面板 / memory_toolize）实际执行次数（转化率分子）。 */
    runCount: z.number().int().nonnegative().default(0),
    /** 来源：builtin / manual / auto / migrated（面板徽标与上限判定）。 */
    source: z.string().default('manual'),
    /** 任务签名（自动知识草稿/能力聚合同一类任务）。 */
    taskKey: z.string().optional(),
    /** 高置信自动起草的入口命令（未验证；人工「启用执行」前不得执行）。 */
    entryDraft: z.string().default(''),
    /** entryDraft 是否经人工确认（true 才允许 runnable=true）。 */
    entryVerified: z.boolean().default(false),
    /** 知识面正文（事实块之外）的哈希：检测人工编辑。 */
    bodyHash: z.string().optional(),
    /** 事实块哈希：判断自动事实是否过期。 */
    factsHash: z.string().optional(),
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
    // R48 task-level skills: distinct sessions/dispatches that produced this
    // signature. Optional (no default) so pre-R48 signal rows still validate
    // and the storage domain stays v1-compatible.
    sessions: z.array(z.string()).optional(),
    dispatches: z.array(z.string()).optional(),
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
    // R33 需求⑦: 派发时授予分支的能力档位（read/read-write/full/minimal）。
    // relay 卡片要显示「能力档位」，但标签里只有一个无法区分的快照；独立字段让
    // 回送路径无需反解 tags。旧记录读作 ''（卡片该行留空），域保持 v1 兼容。
    capability: z.string().default(''),
    // E: 续跑关联（中断任务由用户决定继续）。续跑产生的新派发记录原 dispatchId
    // （resumeOf），原派发回写续跑派发 id（resumedBy）。两个字段都是可选的：
    // 旧记录读作 undefined，存储域保持 v1 兼容（同 D 的 interrupted/lastActivityAt）。
    resumeOf: z.string().optional(),
    resumedBy: z.string().optional(),
    // R42: 中断清单已向中枢公告过的时间戳（relay 重复投递修复的持久增量标记）。
    // 「检测到 N 个被中断的任务」notice 原来只靠内存签名去重——插件重载后签名表
    // 清空，同一批中断任务会被再次整批送达中枢。落库后每个派发最多被公告一次，
    // 重载/清单刷新都只补新增的。旧记录读作 undefined（= 尚未公告），域保持 v1 兼容。
    interruptNoticedAt: z.number().int().optional(),
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
    // R32 需求③: the card source survives a restart with the pending outbox
    // row, so a re-relayed message still says "来自 <来源会话>". Optional with
    // defaults absent: pre-R32 rows read as before and the delivery path
    // reconstructs what it can from the dispatch row.
    fromSessionId: z.string().optional(),
    fromTitle: z.string().optional(),
    fromKind: z.enum(['hub', 'branch', 'group', 'system']).optional(),
    // R33 需求⑦: the rest of the card survives the same way (task / topic set /
    // capability). Defaults keep pre-R33 rows readable; the delivery path falls
    // back to the dispatch row or group member when a value is absent.
    task: z.string().default(''),
    topicSetTitle: z.string().default(''),
    capability: z.string().default(''),
    // R42: 同一批中断里「同分支 + 同任务」的重复派发只投一份回执，其余行的 ledger
    // 标记为「已由哪条派发代投」（status 仍写 relayed，避免被 flush 重投）。
    // 可选：旧行没有这个字段，读作 undefined，域保持 v1 兼容。
    suppressedOf: z.string().optional(),
  })

  // R33 需求②: positive hub records. A hub is NEVER inferred from "top-level
  // session with no parent" (that classified every ordinary conversation as a
  // hub and denied its bash/write/subagent). This table is the durable positive
  // mark written when the plugin creates a hub (panel 新会话 / 话题集会话) or
  // when the session dispatches (a hub by action). Topic-set root members and
  // dispatch.hubSessionId references are also positive marks, resolved without
  // this table; the row makes the mark explicit and workspace-scoped.
  const hubSessions = z.object({
    workspaceKey: z.string(),
    sessionId: z.string(),
    title: z.string().default(''),
    /** How the hub was marked (audit only; resolution trusts every source). */
    // R35: 'title-migration' is the one-time migration that marks pre-R33
    // panel-created hubs from their host title; 'migration' stays for older rows.
    // R59: FIRST WRITE WINS (a dispatch no longer overwrites an existing
    // provenance); the most recent writer is recorded in `lastSource`.
    source: z.enum(['panel', 'topicset-root', 'dispatch', 'migration', 'title-migration']).default('panel'),
    /** R59: most recent writer (audit only; '' on pre-R59 rows). */
    lastSource: z.string().default(''),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })

  // R59: the session-naming state machine. One row per session the plugin
  // names (hubs + work branches); ordinary conversations have no row. The
  // table is the SINGLE durable state of the naming service: the host title is
  // the only authority for display, this row says what the plugin intends,
  // what it last wrote, and whether a human owns the name now.
  const sessionTitles = z.object({
    workspaceKey: z.string().default(''),
    sessionId: z.string(),
    kind: z.enum(['hub', 'branch', 'other']).default('other'),
    state: z.enum(['provisional', 'named', 'user-locked', 'deferred']).default('provisional'),
    /** The final title the plugin wants (already byte-clipped, same string the host holds). */
    desiredTitle: z.string().default(''),
    /** The unclipped composition, for diagnostics only (never written to the host). */
    desiredFull: z.string().default(''),
    /** The raw topic/task text the composition came from (so reset can recompute). */
    topic: z.string().default(''),
    /** The exact title the host accepted at the last successful write. */
    lastWrittenTitle: z.string().default(''),
    /** Seq of the last session/title event the plugin accounted for. */
    lastTitleSeq: z.number().int().nonnegative().optional(),
    /** Who produced the current intent (panel/first-message/dispatch/migration/manual/...). */
    source: z.string().default(''),
    attempts: z.number().int().nonnegative().default(0),
    lastError: z.string().default(''),
    /** Why the row is user-locked (manual / external-rename). */
    lockedReason: z.string().default(''),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
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
    // R31 需求① marker (meta row 'hub-titles'): the one-time rename of hub
    // sessions created by the legacy '新会话 · <id4>' title format. Same
    // reason as above: an undeclared marker key would be stripped on load.
    hubTitlesMigrationVersion: z.number().int().optional(),
    hubTitlesMigratedAt: z.number().int().optional(),
    // R42: the v3 marker records WHICH ids were handled so a COLD session
    // (not attachable, so not renamable now) no longer blocks convergence.
    // hubTitlesProcessedIds = renamed or verified clean; hubTitlesPendingIds
    // = still carrying a legacy host title, finished on its first live event.
    hubTitlesProcessedIds: z.array(z.string()).optional(),
    hubTitlesPendingIds: z.array(z.string()).optional(),
    // R35 marker (meta row 'hub-records'): the one-time backfill of positive
    // hub_sessions rows for pre-R33 panel-created hubs. Declared here because
    // the meta schema strips unknown marker keys on load.
    hubRecordsMigrationVersion: z.number().int().optional(),
    hubRecordsMigratedAt: z.number().int().optional(),
    // R33 需求⑧ marker (meta row 'role-guard'): whether the monotonic runtime
    // guard actually installed. A missing/failed guard used to be a single
    // logger.warn; the marker makes the failure visible in the panel/console
    // and survives a reload. Declared here because the meta schema strips
    // unknown keys on load (same rule as every other marker).
    roleGuardInstalledAt: z.number().int().optional(),
    roleGuardFailedAt: z.number().int().optional(),
    roleGuardVersion: z.number().int().optional(),
    roleGuardError: z.string().optional(),
    // R59 marker (meta row 'session-titles'): the one-time adoption/migration
    // of existing session titles into the naming state machine. Declared here
    // because the meta schema strips unknown marker keys on load.
    sessionTitlesMigrationVersion: z.number().int().optional(),
    sessionTitlesMigratedAt: z.number().int().optional(),
    sessionTitlesMigrated: z.number().int().optional(),
    sessionTitlesAdopted: z.number().int().optional(),
    sessionTitlesDeferred: z.number().int().optional(),
    // R55 marker (meta row 'hub-policy-locked'): the one-time merge of the
    // locked hub entries (sm_cap_doc) into stored hub_policies rows. Declared
    // here because the meta schema strips unknown marker keys on load.
    hubPolicyLockedVersion: z.number().int().optional(),
    hubPolicyLockedMergedAt: z.number().int().optional(),
    hubPolicyLockedRows: z.number().int().optional(),
    hubPolicyLockedUpdated: z.number().int().optional(),
  })

  return {
    topicsets, memories, memory_collections: memoryCollections, memory_versions: memoryVersions,
    episodes, requirements, filemap,
    tool_memory: toolMemory, signals, dispatches, questions, outbox, routing, hotcache, meta,
    hub_sessions: hubSessions, hub_policies: hubPolicies, model_defaults: modelDefaults,
    session_titles: sessionTitles,
  }
}

export type Schemas = Awaited<ReturnType<typeof buildSchemas>>

export type TopicSet = z.infer<Schemas['topicsets']>
export type Memory = z.infer<Schemas['memories']>
export type MemoryCollection = z.infer<Schemas['memory_collections']>
/** R30 需求①: one historical version of a memory (full snapshot). */
export type MemoryVersion = z.infer<Schemas['memory_versions']>
/** R36 需求①: one workspace's hub tool whitelist (default deny). */
export type HubPolicy = z.infer<Schemas['hub_policies']>
export type ModelDefaults = z.infer<Schemas['model_defaults']>
export type Episode = z.infer<Schemas['episodes']>
export type Requirement = z.infer<Schemas['requirements']>
export type FileMapEntry = z.infer<Schemas['filemap']>
export type ToolMemory = z.infer<Schemas['tool_memory']>
export type Signal = z.infer<Schemas['signals']>
export type Dispatch = z.infer<Schemas['dispatches']>
/** R33 需求②: one positive hub record (workspace-scoped). */
export type HubSession = z.infer<Schemas['hub_sessions']>
/** R59: the durable session-naming state machine row. */
export type SessionTitleRow = z.infer<Schemas['session_titles']>
export type Question = z.infer<Schemas['questions']>
export type OutboxItem = z.infer<Schemas['outbox']>
export type Routing = z.infer<Schemas['routing']>
export type Hotcache = z.infer<Schemas['hotcache']>
export type Meta = z.infer<Schemas['meta']>
