/**
 * R23: one-time reorganization of the existing memories into the R22
 * 「记忆集合 + 条目」two-level model.
 *
 * Why this exists (and why it is a *data plan*, not a heuristic): R22 gave the
 * store a collection table but let the collections grow out of the historical
 * write order — one 12-entry catch-all set, titles like「r8 记忆」, and a few
 * auto-extracted placeholders（「写结论性记忆」/ 并行组包装文本 / 续跑包装文本）.
 * The R23 request is to re-layout those rows by TOPIC: one clear collection per
 * theme, every entry in exactly one collection, near-duplicates merged into the
 * most informative row, and placeholders removed.
 *
 * Design constraints:
 * - **Nothing real is lost.** The plan is an explicit, reviewable table: the
 *   topics, every entry's final title/tags/body, the merge targets and the
 *   deletion reasons. Merged rows keep the union of both bodies; deletions are
 *   listed with a reason and every affected row is still in the JSON backup
 *   written before the first write.
 * - **Idempotent and safe under concurrent edits.** The plan is embedded (the
 *   data set is this workspace's, identified by the plugin repo root). A
 *   destructive step runs only while the row's current body still matches the
 *   SHA-256 captured when the plan was authored — a body somebody edited in
 *   between is left alone and reported as a conflict instead of being
 *   overwritten or deleted. Every write compares before writing, and a
 *   persisted marker (`meta` row `organize:<workspaceKey>`) stops a restart
 *   from repeating the pass.
 * - **Single writer.** The pass runs from the plugin's own `apply()` (before
 *   sessions exist), i.e. through the live storage domain, never by editing
 *   `supermemory.json` behind a running host (the JSON backend's `single`
 *   layout rewrites the whole unit on every write, so an offline edit would be
 *   lost or worse). `/memory-organize` exposes preview/apply/report for manual
 *   operation after a reload; `scripts/memory-organize.mjs` is the read-only
 *   dry-run tool.
 * @module supermemory/memory-organize
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bestCollectionFor, collectionRows } from './memory-collections.ts'
// R30 需求①: 整理引擎的条目改写同样走版本化更新（就地修改 + 升版 + 归档），
// 不与 memory_remember/面板/管理台/自动抽取各走一套写路径。
import { updateMemoryVersioned } from './memory-versions.ts'
import { TITLE_MAX } from './retrieval.ts'
import type { Memory, MemoryCollection, Meta } from './schema.ts'
import { newId } from './store.ts'

/** Bump when the plan or its rules change; an older marker re-runs the pass. */
export const ORGANIZE_VERSION = 1

/**
 * The meta-table row key of the per-workspace marker. The key is a digest so a
 * `per-record` storage layout (which restricts keys to [A-Za-z0-9_-]+) accepts
 * it too; the human-readable workspace stays inside the record.
 */
export function organizeMarkerKey(workspaceKey: string): string {
  const digest = createHash('sha256').update(workspaceKey, 'utf8').digest('hex').slice(0, 16)
  return `organize-${digest}`
}

/** One target collection (key is the plan's internal reference only). */
export interface OrganizeCollectionSpec {
  key: string
  title: string
  keywords: string[]
  summary: string
}

/** One entry the plan keeps, with its final retrieval shape. */
export interface OrganizeEntrySpec {
  memoryId: string
  /** Plan collection key. */
  collection: string
  title: string
  keywords: string[]
  /** Replacement body (a merge). Omitted means "keep the body". */
  text?: string
  /** Text appended to the existing body (a dated correction). */
  appendText?: string
  /**
   * SHA-256 of the body this plan was authored against. Required whenever
   * `text` or `appendText` is set: a body that changed in the meantime is
   * reported, not overwritten.
   */
  expectTextSha256?: string
  /** What happened to this row, for the report. */
  note?: string
}

/** One row the plan removes (placeholder, or merged into another row). */
export interface OrganizeDeleteSpec {
  memoryId: string
  title: string
  reason: string
  /** When set, the row is only removed after this keeper carries the merged body. */
  mergedInto?: string
  /** SHA-256 of the body this plan was authored against (guard against edits). */
  expectTextSha256: string
}

export interface MemoryOrganizePlanData {
  version: number
  collections: OrganizeCollectionSpec[]
  entries: OrganizeEntrySpec[]
  deletes: OrganizeDeleteSpec[]
  /** Collections produced by the pre-R23 heuristic pass; removed once empty. */
  oldCollectionIds: string[]
  /**
   * Expected title of each pre-R23 collection. When a title no longer matches,
   * the collection was renamed by the operator: it is kept (and its entries
   * are not re-assigned) instead of being deleted as a "junk" collection.
   */
  oldCollectionTitles?: Record<string, string>
}

/** The fallback collection: created only when an unplanned entry cannot match anything. */
export const ORGANIZE_FALLBACK: OrganizeCollectionSpec = {
  key: 'other',
  title: '其他结论（待归类）',
  keywords: ['supermemory', '其他', '待归类'],
  summary: '整理时尚无法归入现有主题的结论，后续可改名、合并或手动归类。',
}

const R8_CORRECTION = '（后续更正：R9 起分支会话已继承中枢的文件/shell 能力，本条「分支会话没有文件/shell 工具」的限制已解除，见「R9–R11」条目。）'
const R8_CORRECTION_SUFFIX = `\n\n${R8_CORRECTION}`

const MERGED_R18 = 'R18 完成并验收（2026-11-18，用户六项需求）：①中枢会话侧栏——新增 src/hub-sessions.ts（listHubSessions：过滤 parentSession/subagent/话题集成员含归档，批量读标题，50 条上限，sessionQuery 缺失降级 ctx.sessions.list），并新增 BRANCH_ID_PREFIX=\'branch-\' 恒排除、HUB_ID_PREFIX=\'session-\' 保留；宿主 panel.listHubSessions + wire 三处同步，客户端 panel-page.tsx 改 sm-shell 两栏（760px 折叠），左栏「中枢会话」列表+在线绿点+当前高亮+点击打开+「＋新中枢会话」；真实 /api/state 复测 hubs 11 条、branch- 前缀 0 条、live 1。②自动三层：createTopicSet(cwd,title,tags?,summary?)、memory_new_topicset 参数补齐 tags/summary（原 execute 读但参数未声明，中枢派分支修复）、memory_remember 描述强制 title+tags、面板新建记忆 onBlur 调 suggestMemoryShape 自动补全、新建话题集回读显示 title+tags、createTopicSetSession 首条消息 buildTopicSetOpening 带三层。③徽标 bug 根因：session-badge.tsx 的 badgeCache 永久缓存 {kind:\'hub\'}，分支后来入集也不显示；修法 branch 永久缓存、hub 8s TTL、导出 invalidateBadge + api.invalidateBadges()。④分支能力：src/capabilities.ts 四档（read/read-write/full/minimal）→ agentCtx.tools.restrict({deny})（必须 agent scope 调，全局 ctx 调会抛 requires a scoped context），src/script-delegation.ts buildDispatchScript 把「本轮能力边界」写进分支首条消息，memory_dispatch 新增 capabilities 参数（默认 read-write）。⑤中枢软约定：supermemory:hub-role systemPrompt（order 901，currentInitiator/scope 判定，分支不注入；已在会话 prompt 生效可见），不摘工具。⑥前端改版：面板 8px 栅格/10px 圆角/tab 下划线/空状态插画/按钮分层；管理台左侧固定五段导航+卡片列表+760px 折叠+明暗双主题。闸门（中枢复跑）：tsc 双 0 错、core 6 / mechanism 38（修复后）/ webui 27 / client-sim OK、build 宿主 9 文件（含 hub-sessions chunk）+ client 87298 字符（89065 bytes）。已 plugin_manager 对 include:supermemory 禁用→启用重载，需刷新 http://127.0.0.1:62590；管理台端口每次重载会变，用 memory_ui 取新令牌 URL。'

const MERGED_GIT = '仓库 F:\\10-SuperMemory 的 git 同步状态与推送路径（2026-11-18 核实）：远程 origin = http://<内网 Gitee>/<旧帐号名>/SuperMemory.git（内网 Gitee，主机可达 HTTP 200），本地 main 跟踪 origin/main。R15–R20 的改动已打包为提交 897a02357b85a4a1a1813af56d7287c43192c405（49 文件，+12235/−1324，信息 feat(rounds-15-20): 面板注册自愈 / 中枢 composer 与侧栏 / 记忆记录形态 / 分支问题上交）并已推送，origin/main 与该提交一致。此后 HEAD 更新为 60f0f02「feat(round-26): 工作区隔离 / 能力持续维护 / 分支会话重启保留」，与 origin/main 完全一致，工作区干净、无未跟踪文件。后续同步流程：git fetch origin → 若 origin/main 领先则 pull --rebase；有本地源码改动则 add/commit 后 GIT_TERMINAL_PROMPT=0 git push origin main。凭据：scripts/git-sync-push.sh 的 store 凭据方案已失效（~/.git-credentials 不存在，脚本必报 could not read Username for \'http://<内网 Gitee>\'，退出码 1）；当前可用默认 GCM（helper=manager，Windows 凭据存储），若 GCM 也失效再找用户要凭据。仓库内另有 scripts/git-sync-push.mjs / .sh 同步脚本。'

/**
 * The R23 plan. This workspace's ids are stable; on any other workspace the
 * ids simply do not exist, so the pass reports "nothing-to-do" and writes
 * nothing (a fresh clone never gets five empty collections).
 */
export const ORGANIZE_PLAN: MemoryOrganizePlanData = {
  version: ORGANIZE_VERSION,
  collections: [
    {
      key: 'core',
      title: '记忆系统：集合、检索与写入',
      keywords: ['supermemory', '记忆集合', '两级检索', '标题标签正文', '写入去重', 'R22'],
      summary: '记忆的「集合 + 条目」存储、标题×4/标签×3/正文×1 检索加权、写入侧集合复用与同 key 判定等设计结论。',
    },
    {
      key: 'ui',
      title: '面板、管理台与前端交互',
      keywords: ['supermemory', '面板', '管理台', 'composer', '页签', '交互修复'],
      summary: 'SuperMemory 面板 / 管理台 / Web 控制台的布局、页签与交互结论，含 composer 改版、侧栏与前端 bug 修复。',
    },
    {
      key: 'branch',
      title: '分支派发与协作机制',
      keywords: ['supermemory', '分支会话', '派发', '并行组', '问题上交', '能力边界'],
      summary: '中枢↔分支的派发与并行收敛、分支能力继承、分支提问上交中枢与一话题集多中枢等协作结论。',
    },
    {
      key: 'gate',
      title: '构建、测试与重载闸门',
      keywords: ['supermemory', 'typecheck', 'smoke', 'build', '回归闸门', '重载'],
      summary: '构建 / 测试 / 重载的验收闸门与典型根因修复，含 arity 漂移类回归的永久闸门与全量测试轮结论。',
    },
    {
      key: 'env',
      title: '环境、路径与仓库同步',
      keywords: ['supermemory', 'git同步', 'GCM凭据', 'scope推导', '工作区隔离'],
      summary: '仓库同步与推送凭据、内置能力 scope 从插件位置推导、工作区隔离与重载生效条件等环境类结论。',
    },
  ],
  entries: [
    {
      memoryId: 'mem-mwmcnex9-ucr9fc',
      collection: 'core',
      title: 'R22：八项修复完成并重载（记忆集合/派发卡/绿点/面板）',
      keywords: ['supermemory', 'R22', '记忆集合', '派发卡片', '绿点', '面板'],
    },
    {
      memoryId: 'mem-mwmceuq0-a8f89d',
      collection: 'core',
      title: '记忆写入先做集合匹配（高/中相似复用、低相似新建）',
      keywords: ['supermemory', '记忆集合', '集合匹配', '相似度', '同key', '写入'],
      note: '与 mem-mwmc68di 近重复，保留本条的「并在回执注明」完整表述',
    },
    {
      memoryId: 'mem-mwkvpvt2-o0krs2',
      collection: 'core',
      title: 'R9–R11：分支能力继承、标题/标签/正文检索、话题集页签',
      keywords: ['supermemory', 'R9', 'R10', 'R11', '分支能力', '标题标签正文'],
    },
    {
      memoryId: 'mem-mwkuup1h-rfvc6d',
      collection: 'ui',
      title: 'R14 需求：中枢会话改 composer 布局并就地触发对话',
      keywords: ['supermemory', 'R14', '中枢会话', 'composer', '就地触发', '面板'],
    },
    {
      memoryId: 'mem-mwkv5n2p-vwum3n',
      collection: 'ui',
      title: 'R8：中枢会话 composer 布局与首条消息直送',
      keywords: ['supermemory', 'R8', 'composer', 'firstMessage', '中枢会话', '面板'],
      // The historical text is preserved verbatim; only a dated correction is
      // appended because R9 fixed the「分支没有文件/shell 工具」limitation.
      appendText: R8_CORRECTION_SUFFIX,
      expectTextSha256: '44ce7ef6cf57fabb4e56e28fa7b094ae2f91cf5dffb1bd31c3a1e66cd7b64a19',
      note: '原文保留，追加 R9 已修复「分支无文件/shell 工具」的更正注记',
    },
    {
      memoryId: 'mem-mwkwzlw2-wszibc',
      collection: 'ui',
      title: 'R18：中枢侧栏/自动三层/分支能力/徽标修复/前端改版（含验收）',
      keywords: ['supermemory', 'R18', '中枢侧栏', '分支能力', '徽标持久化', '前端改版', '验收'],
      text: MERGED_R18,
      expectTextSha256: '888ee36ce351ab96b015df3354df04554ab8bc55a56f09236f40904a556b2c21',
      note: '合并 R18 完成条目与 R18 最终验收条目（验收细节并入）',
    },
    {
      memoryId: 'mem-mwkysqcq-jbbgqm',
      collection: 'branch',
      title: 'R19：并行多分支、关联分支展示与一话题集多中枢',
      keywords: ['supermemory', 'R19', '并行分支', '关联分支', '分支共享', '中枢'],
    },
    {
      memoryId: 'mem-mwkytofa-m9t57p',
      collection: 'branch',
      title: 'R20：分支先干活、问题上交中枢、中枢一次提问',
      keywords: ['supermemory', 'R20', '分支提问', '中枢汇总', '派发', '协作'],
    },
    {
      memoryId: 'mem-mwm4s24n-bly8s9',
      collection: 'gate',
      title: 'R21：全量测试轮、7 处前端 bug 与能力 exit 127 根治',
      keywords: ['supermemory', 'R21', '全量测试', '前端bug', 'capability', '回归闸门'],
    },
    {
      memoryId: 'mem-mwm3gz5g-1f715w',
      collection: 'gate',
      title: '面板「加载失败」根因：客户端 listTools 声明缺 cwd',
      keywords: ['supermemory', '面板', 'listTools', 'arity', '远程方法', '回归闸门'],
    },
    {
      memoryId: 'mem-mwm2i0r9-63205r',
      collection: 'env',
      title: 'git 同步：origin/HEAD 状态、提交历史与 GCM 推送凭据',
      keywords: ['supermemory', 'git', '同步', 'GCM凭据', 'origin', 'HEAD'],
      text: MERGED_GIT,
      expectTextSha256: '866e5b78b5c14e59251250f58dbca3d8d15ece8120c9e290f3d5e451752ff2e2',
      note: '合并 git 凭据条目与仓库同步条目（897a02 提交、GCM 路径并入）',
    },
    {
      memoryId: 'mem-mwm3msyt-1unad2',
      collection: 'env',
      title: '内置 git-sync 能力 scope 从插件位置推导（v2）',
      keywords: ['supermemory', 'builtin', 'git-sync', 'scope', '工作区隔离', '路径推导'],
    },
  ],
  deletes: [
    {
      memoryId: 'mem-mwm3hbj6-0vrci3',
      title: '写入结论性记忆（标题+标签+正文：根因、修复位置、验证结果、生效条件）',
      reason: '占位：复述写入规则、无任何结论内容',
      expectTextSha256: 'a308c3fef1f89ba9f5d7636e7dffe54059156714786e2204fd300fc2df09118d',
    },
    {
      memoryId: 'mem-mwm3nb8q-7fi9ub',
      title: '写结论性记忆',
      reason: '占位：正文仅 7 字「写结论性记忆」，无结论内容',
      expectTextSha256: '6a1495c9f844cb14353f5456884541b0d7a7757151932661e882f8239a3cf89e',
    },
    {
      memoryId: 'mem-mwm3sim8-2b610a',
      title: '本任务是并行组 grp-mwm3q5gw-df0g7d 的一员：只负责这一个任务',
      reason: '派发包装文本（并行组说明），是过程消息不是结论',
      expectTextSha256: 'f35228f63b1ee98868fa42076dea60d29a80e8337673cef913703f22a2018a33',
    },
    {
      memoryId: 'mem-mwmbx5th-pzz88r',
      title: '本任务是并行组 grp-mwmbphig-uy8ihi 的一员：只负责这一个任务',
      reason: '派发包装文本（并行组说明），是过程消息不是结论',
      expectTextSha256: '26260a72b997bc09e95b93011eb81ba40c4e3c8bb161957509bd63202bd94779',
    },
    {
      memoryId: 'mem-mwm4wh5d-w3fk69',
      title: '本消息是被中断任务的续跑（原派发 dsp-mwkyjskq-92lsyb，原分支 branch…',
      reason: '续跑包装文本（被中断任务说明），是过程消息不是结论',
      expectTextSha256: 'c13b03c147f22696c094ece2af374c8fb64e1caa5115dc5c2d676dfb49fa0aeb',
    },
    {
      memoryId: 'mem-mwmcpcf1-i5qgso',
      title: '本消息是被中断任务的续跑（原派发 dsp-mwmbphig-ks97ye，原分支 branch…',
      reason: '续跑包装文本（被中断任务说明），是过程消息不是结论',
      expectTextSha256: '4322554de1e6f7898ac9f00b9e06d18835b9a4ca9e7071ec6d020267de136009',
    },
    {
      memoryId: 'mem-mwmc68di-ybrsaz',
      title: '先做集合匹配（标题/标签/正文相似度，分高/中/低三档），高相似直接复用该集合新增条目，回执注…',
      reason: '与 mem-mwmceuq0 近重复；后者表述更完整（「并在回执注明」），本条无独有信息',
      mergedInto: 'mem-mwmceuq0-a8f89d',
      expectTextSha256: '2c236b8df4babdffea87c01e14a7eea0e5c824ec804a0f241e357897431cae16',
    },
    {
      memoryId: 'mem-mwl4tso5-mlaney',
      title: 'SuperMemory 仓库同步：sync 脚本凭据方案失效，改用 GCM 默认路径推送',
      reason: '已并入 git 同步条目：凭据失效原因、GCM 路径、退出码 1 事实全部保留',
      mergedInto: 'mem-mwm2i0r9-63205r',
      expectTextSha256: '5ddc730840d161a0e1ce00965280694f16ea2c14e4186ddfd0ecb216c3978526',
    },
    {
      memoryId: 'mem-mwl4v8sy-jbnr4d',
      title: 'SuperMemory 仓库已同步云端：origin 为内网 Gitee，main↔origin',
      reason: '已并入 git 同步条目：897a02 提交（49 文件/+12235/−1324）与推送事实全部保留',
      mergedInto: 'mem-mwm2i0r9-63205r',
      expectTextSha256: 'ed9cae27b0c45832f3eeec0f744c33f0477192b4ec82c5549192dac56befae2b',
    },
    {
      memoryId: 'mem-mwkx49qw-dbeb4j',
      title: 'R18 最终验收：六项需求全部生效（含两处修复：branch 过滤、topicset 工具参数）',
      reason: '已并入 R18 完成条目：BRANCH_ID_PREFIX 修复、/api/state 复测、参数补齐根因全部保留',
      mergedInto: 'mem-mwkwzlw2-wszibc',
      expectTextSha256: '5bbdbbf150a122f75ab46d14c2b06bebf2324ae836618e54244aef9033f42c5b',
    },
  ],
  oldCollectionIds: [
    'mc-mwmcnchi-ri6xeg',
    'mc-mwmcnely-8v9uoe',
    'mc-mwmcner7-xo93br',
    'mc-mwmcnet9-mf0vgb',
    'mc-mwmcneuy-z7ladr',
    'mc-mwmcnevu-dbwfyz',
  ],
  oldCollectionTitles: {
    'mc-mwmcnchi-ri6xeg': 'supermemory 记忆',
    'mc-mwmcnely-8v9uoe': 'r8 记忆',
    'mc-mwmcner7-xo93br': '写入 记忆',
    'mc-mwmcnet9-mf0vgb': 'grp-mwm3q5gw-df0g7d 记忆',
    'mc-mwmcneuy-z7ladr': 'dsp-mwkyjskq-92lsyb 记忆',
    'mc-mwmcnevu-dbwfyz': 'key 记忆',
  },
}

// ---------------------------------------------------------------------------
// store shape
// ---------------------------------------------------------------------------

/** The tables the pass reads/writes; a real `Store` satisfies it structurally. */
export interface OrganizeStore {
  memories: {
    get(key: string): Memory | undefined
    entries(): IterableIterator<[string, Memory]>
    put(key: string, value: Memory): Promise<void>
    update(key: string, fn: (value: Memory) => Memory): Promise<void>
    delete(key: string): Promise<boolean>
  }
  memoryCollections: {
    get(key: string): MemoryCollection | undefined
    entries(): IterableIterator<[string, MemoryCollection]>
    put(key: string, value: MemoryCollection): Promise<void>
    delete(key: string): Promise<boolean>
    update(key: string, fn: (value: MemoryCollection) => MemoryCollection): Promise<void>
  }
  meta: {
    get(key: string): Meta | undefined
    entries(): IterableIterator<[string, Meta]>
    put(key: string, value: Meta): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// plan (pure)
// ---------------------------------------------------------------------------

export interface OrganizeCounts {
  collections: number
  entries: number
  /** Active entries without a usable collection. */
  uncollected: number
  /** Active collections with zero active entries. */
  emptyCollections: number
  /** Non-active entries (superseded); never touched by this pass. */
  inactive: number
}

export interface OrganizeCollectionView {
  id: string
  title: string
  keywords: string[]
  summary: string
  entryCount: number
}

export interface OrganizeMapping {
  memoryId: string
  title: string
  fromCollection: string
  toCollection: string
  titleChanged: boolean
  tagsChanged: boolean
  textChanged: boolean
  note?: string
}

export interface OrganizeDeletionView {
  memoryId: string
  title: string
  reason: string
  mergedInto?: string
  /** false when the row is missing, its body changed, or the merge keeper failed. */
  willDelete: boolean
  /** Why the row was kept (only when willDelete is false). */
  blockedReason?: string
}

export interface OrganizeConflict {
  memoryId: string
  title: string
  action: 'replace-text' | 'delete' | 'merge'
  reason: string
}

export interface OrganizeUnknownRow {
  memoryId: string
  title: string
  text: string
  collectionId?: string
}

export interface MemoryOrganizePlan {
  /** The plan expects nothing to do in this workspace. */
  nothingToDo: boolean
  reason?: string
  before: OrganizeCounts
  /** Collections to create (title not present) or reuse (title present). */
  collections: Array<OrganizeCollectionSpec & { existingId?: string }>
  present: OrganizeEntrySpec[]
  missing: OrganizeEntrySpec[]
  deletions: OrganizeDeletionView[]
  conflicts: OrganizeConflict[]
  /** Active entries outside the plan (created since authoring). */
  unknown: OrganizeUnknownRow[]
  oldCollections: Array<[string, MemoryCollection]>
}

function sha256(text: string): string {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

function activeEntries(store: OrganizeStore, workspaceKey: string): Array<[string, Memory]> {
  return [...store.memories.entries()].filter(([, row]) => row.workspaceKey === workspaceKey && row.status === 'active')
}

function activeCollections(store: OrganizeStore, workspaceKey: string): Array<[string, MemoryCollection]> {
  return collectionRows(store).filter(([, row]) => row.workspaceKey === workspaceKey && row.status !== 'archived')
}

function workspaceCollection(store: OrganizeStore, workspaceKey: string, id: string | undefined): [string, MemoryCollection] | undefined {
  if (!id) return undefined
  const found = store.memoryCollections.get(id)
  return found && found.workspaceKey === workspaceKey ? [id, found] : undefined
}

/** Current-state projection by collection title (empty collections included). */
export function organizeState(store: OrganizeStore, workspaceKey: string): {
  counts: OrganizeCounts
  collections: OrganizeCollectionView[]
  uncollected: Array<{ memoryId: string; title: string }>
} {
  const active = activeEntries(store, workspaceKey)
  const collections = activeCollections(store, workspaceKey)
  const views: OrganizeCollectionView[] = collections.map(([id, row]) => ({
    id,
    title: row.title,
    keywords: [...(row.keywords ?? [])],
    summary: row.summary ?? '',
    entryCount: 0,
  }))
  const byId = new Map(views.map((view) => [view.id, view]))
  let uncollected = 0
  let inactive = 0
  const uncollectedRows: Array<{ memoryId: string; title: string }> = []
  for (const [memoryId, memory] of active) {
    const collection = memory.collectionId ? byId.get(memory.collectionId) : undefined
    if (!collection) {
      uncollected += 1
      uncollectedRows.push({ memoryId, title: memory.title ?? '' })
      continue
    }
    collection.entryCount += 1
  }
  for (const [, memory] of store.memories.entries()) {
    if (memory.workspaceKey === workspaceKey && memory.status !== 'active') inactive += 1
  }
  return {
    counts: {
      collections: views.length,
      entries: active.length,
      uncollected,
      emptyCollections: views.filter((view) => view.entryCount === 0).length,
      inactive,
    },
    collections: views,
    uncollected: uncollectedRows,
  }
}

/** A pre-R23 collection still carries the title the plan was authored against. */
function isRetiredCollection(plan: MemoryOrganizePlanData, id: string, title: string): boolean {
  const expected = plan.oldCollectionTitles?.[id]
  return expected === undefined || expected === title
}

function collectionBag(spec: OrganizeCollectionSpec, workspaceKey: string): [string, MemoryCollection] {
  return [spec.key, {
    workspaceKey,
    title: spec.title,
    keywords: spec.keywords,
    summary: spec.summary,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  }]
}

/**
 * Build the current-state plan. Pure over the store; no writes. Missing rows
 * make the plan smaller (the pass remains safe if it is re-run after a partial
 * failure), and changed bodies are moved to `conflicts`, not overwritten.
 */
export function planMemoryOrganize(
  store: OrganizeStore,
  workspaceKey: string,
  plan: MemoryOrganizePlanData = ORGANIZE_PLAN,
): MemoryOrganizePlan {
  const state = organizeState(store, workspaceKey)
  const collections = activeCollections(store, workspaceKey)
  const present: OrganizeEntrySpec[] = []
  const missing: OrganizeEntrySpec[] = []
  const conflicts: OrganizeConflict[] = []

  for (const item of plan.entries) {
    const memory = store.memories.get(item.memoryId)
    if (!memory || memory.workspaceKey !== workspaceKey || memory.status !== 'active') {
      missing.push(item)
      continue
    }
    // Content idempotency: a re-run (or a manual apply after a successful one)
    // finds the row already carrying the merged body / correction note. That is
    // success, not a conflict — the original-hash guard only protects a body
    // somebody else edited.
    const satisfied = item.text !== undefined
      ? memory.text === item.text
      : item.appendText !== undefined && memory.text.includes(item.appendText.trim())
    if (item.expectTextSha256 && (item.text !== undefined || item.appendText !== undefined)
      && !satisfied && sha256(memory.text) !== item.expectTextSha256) {
      conflicts.push({
        memoryId: item.memoryId,
        title: memory.title ?? '',
        action: 'replace-text',
        reason: '正文与整理计划制定时不一致（可能被手动编辑），保留现状不覆盖',
      })
      // Still place the row (non-destructive fields only).
      present.push({ ...item, text: undefined, appendText: undefined })
      continue
    }
    present.push(item)
  }

  const presentIds = new Set(present.map((item) => item.memoryId))
  const deletions: OrganizeDeletionView[] = []
  for (const item of plan.deletes) {
    const memory = store.memories.get(item.memoryId)
    if (!memory || memory.workspaceKey !== workspaceKey) continue
    let willDelete = true
    if (sha256(memory.text) !== item.expectTextSha256) {
      willDelete = false
      const blockedReason = '正文与整理计划制定时不一致，保留该条'
      deletions.push({ ...item, willDelete, blockedReason })
      conflicts.push({
        memoryId: item.memoryId,
        title: memory.title ?? item.title,
        action: item.mergedInto ? 'merge' : 'delete',
        reason: '正文与整理计划制定时不一致，保留该条（不删除、不合并）',
      })
      continue
    }
    deletions.push({ ...item, willDelete })
  }

  const deleteIds = new Set(plan.deletes.map((item) => item.memoryId))
  const unknown: OrganizeUnknownRow[] = []
  for (const [memoryId, memory] of activeEntries(store, workspaceKey)) {
    if (presentIds.has(memoryId) || deleteIds.has(memoryId)) continue
    unknown.push({
      memoryId,
      title: memory.title ?? '',
      text: memory.text,
      ...(memory.collectionId ? { collectionId: memory.collectionId } : {}),
    })
  }

  const collectionSpecs = plan.collections.map((spec) => {
    const existing = collections.find(([, row]) => row.title.trim().toLowerCase() === spec.title.trim().toLowerCase())
    return { ...spec, ...(existing ? { existingId: existing[0] } : {}) }
  })
  const oldCollections = collections.filter(([id, row]) => plan.oldCollectionIds.includes(id) && isRetiredCollection(plan, id, row.title))

  const nothingToDo = present.length === 0 && deletions.length === 0 && oldCollections.length === 0
  return {
    nothingToDo,
    ...(nothingToDo ? { reason: '当前工作区没有与整理计划匹配的记忆/集合（计划只针对本插件仓库工作区），未写任何数据。' } : {}),
    before: state.counts,
    collections: collectionSpecs,
    present,
    missing,
    deletions,
    conflicts,
    unknown,
    oldCollections,
  }
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

/** Default backup directory: next to the storage file, never in the repo. */
export function defaultBackupDir(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'supermemory-backups')
}

async function writeBackup(
  store: OrganizeStore,
  workspaceKey: string,
  plan: MemoryOrganizePlan,
  now: number,
  dir: string,
): Promise<string> {
  const memories: Record<string, Memory> = {}
  for (const [id, row] of store.memories.entries()) if (row.workspaceKey === workspaceKey) memories[id] = row
  const collections: Record<string, MemoryCollection> = {}
  for (const [id, row] of store.memoryCollections.entries()) if (row.workspaceKey === workspaceKey) collections[id] = row
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `organize-v${ORGANIZE_VERSION}-${stamp}.json`)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify({
    kind: 'supermemory-memory-organize-backup',
    version: ORGANIZE_VERSION,
    workspaceKey,
    createdAt: now,
    note: 'R23 整理前快照：只含 memories / memory_collections 两个受影响表，可直接手工回填。',
    planned: {
      collections: plan.collections.map((spec) => spec.title),
      mappings: plan.present.map((item) => ({ memoryId: item.memoryId, title: item.title })),
      deletions: plan.deletions.map((item) => ({ memoryId: item.memoryId, title: item.title, reason: item.reason })),
    },
    memories,
    memoryCollections: collections,
  }, null, 2), 'utf8')
  return path
}

// ---------------------------------------------------------------------------
// apply / preview
// ---------------------------------------------------------------------------

export interface MemoryOrganizeResult {
  status: 'applied' | 'already-done' | 'preview' | 'nothing-to-do'
  before: OrganizeCounts
  after?: OrganizeCounts
  collections: OrganizeCollectionView[]
  mappings: OrganizeMapping[]
  deletions: OrganizeDeletionView[]
  conflicts: OrganizeConflict[]
  unknownAssignments: OrganizeMemoryAssignment[]
  backupPath?: string
  marker?: boolean
  reason?: string
}

export interface OrganizeMemoryAssignment {
  memoryId: string
  title: string
  collection: string
}

function newCollection(workspaceKey: string, spec: OrganizeCollectionSpec, now: number): MemoryCollection {
  return {
    workspaceKey,
    title: spec.title.slice(0, TITLE_MAX),
    keywords: spec.keywords,
    summary: spec.summary,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index])
}

function cloneStore(store: OrganizeStore): OrganizeStore {
  const cloneRows = <V>(rows: IterableIterator<[string, V]>): Map<string, V> =>
    new Map([...rows].map(([key, value]) => [key, JSON.parse(JSON.stringify(value)) as V]))
  const memories = cloneRows(store.memories.entries())
  const collections = cloneRows(store.memoryCollections.entries())
  const meta = cloneRows(store.meta.entries())
  const tableOf = <V>(rows: Map<string, V>) => ({
    get: (key: string): V | undefined => rows.get(key),
    entries: () => rows.entries(),
    put: async (key: string, value: V) => { rows.set(key, value) },
    update: async (key: string, fn: (value: V) => V) => { rows.set(key, fn(rows.get(key) as V)) },
    delete: async (key: string) => rows.delete(key),
  })
  return { memories: tableOf(memories), memoryCollections: tableOf(collections), meta: tableOf(meta) }
}

/**
 * Dry-run the plan on a deep copy of the store: the exact same code path as
 * apply, so the projection cannot drift from what apply would do. Nothing is
 * written to the real store, no backup file is created and no marker is set.
 */
export async function previewMemoryOrganize(
  store: OrganizeStore,
  workspaceKey: string,
  plan: MemoryOrganizePlanData = ORGANIZE_PLAN,
): Promise<MemoryOrganizeResult> {
  return applyMemoryOrganize(store, workspaceKey, { plan, dryRun: true, ignoreMarker: true })
}

/**
 * Apply the plan through the live store.
 *
 * Ordering: backup → collections → entry updates → unknown assignment →
 * deletions (only after a merge keeper was written) → old collection cleanup →
 * verification sweep → marker. A failure before the marker leaves a partial
 * state that a re-run completes (the plan is rebuilt from current state).
 */
export async function applyMemoryOrganize(
  store: OrganizeStore,
  workspaceKey: string,
  options: {
    plan?: MemoryOrganizePlanData
    now?: number
    ignoreMarker?: boolean
    /** Simulate on a deep copy; no backup file and no marker write. */
    dryRun?: boolean
    backupDir?: string
    logger?: { info: (msg: string) => void; warn: (msg: string) => void }
  } = {},
): Promise<MemoryOrganizeResult> {
  const now = options.now ?? Date.now()
  const planData = options.plan ?? ORGANIZE_PLAN
  const logger = options.logger
  const markerKey = organizeMarkerKey(workspaceKey)
  // A dry run works on a deep copy so the real store cannot be touched by any
  // branch of this function (including the marker and the backup file).
  if (options.dryRun) store = cloneStore(store)
  if (!options.ignoreMarker && !options.dryRun) {
    const marker = store.meta.get(markerKey)
    if (marker && (marker.organizeVersion ?? 0) >= planData.version) {
      const state = organizeState(store, workspaceKey)
      return {
        status: 'already-done',
        before: state.counts,
        after: state.counts,
        collections: state.collections,
        mappings: [],
        deletions: [],
        conflicts: [],
        unknownAssignments: [],
        ...(marker.organizeBackup ? { backupPath: marker.organizeBackup } : {}),
        marker: true,
        reason: `整理标记已存在（v${marker.organizeVersion}），未重复执行。`,
      }
    }
  }
  const planned = planMemoryOrganize(store, workspaceKey, planData)
  if (planned.nothingToDo) {
    return {
      status: 'nothing-to-do',
      before: planned.before,
      collections: organizeState(store, workspaceKey).collections,
      mappings: [],
      deletions: [],
      conflicts: planned.conflicts,
      unknownAssignments: [],
      ...(planned.reason ? { reason: planned.reason } : {}),
    }
  }

  const backupPath = options.dryRun
    ? undefined
    : await writeBackup(store, workspaceKey, planned, now, options.backupDir ?? defaultBackupDir())

  // 1) collections (reuse by exact title, create the rest)
  const collectionIds = new Map<string, string>()
  for (const spec of planned.collections) {
    const existing = activeCollections(store, workspaceKey)
      .find(([, row]) => row.title.trim().toLowerCase() === spec.title.trim().toLowerCase())
    if (existing) {
      collectionIds.set(spec.key, existing[0])
      continue
    }
    const id = newId('mc')
    await store.memoryCollections.put(id, newCollection(workspaceKey, spec, now))
    collectionIds.set(spec.key, id)
  }
  const collectionIdFor = (key: string): string | undefined => collectionIds.get(key)

  // 2) entry updates (title/tags/text/collection); a changed body was already
  //    moved to conflicts by the planner, so `text` here is guarded.
  const mappings: OrganizeMapping[] = []
  for (const item of planned.present) {
    const memory = store.memories.get(item.memoryId)
    if (!memory) continue
    const collectionId = collectionIdFor(item.collection)
    if (!collectionId) continue
    const fromTitle = workspaceCollection(store, workspaceKey, memory.collectionId)?.[1].title ?? ''
    const spec = planData.collections.find((row) => row.key === item.collection)
    const next: Memory = {
      ...memory,
      title: item.title.slice(0, TITLE_MAX),
      keywords: item.keywords,
      collectionId,
      updatedAt: now,
    }
    if (item.text !== undefined) next.text = item.text
    else if (item.appendText !== undefined && !memory.text.includes(item.appendText.trim())) {
      next.text = `${memory.text}${item.appendText}`
    }
    const textChanged = next.text !== memory.text
    const titleChanged = next.title !== (memory.title ?? '')
    const tagsChanged = !sameTags(memory.keywords ?? [], item.keywords)
    if (textChanged || titleChanged || tagsChanged || memory.collectionId !== collectionId) {
      // R30 需求①: 同一套版本化更新——旧版本整体归档进 memory_versions。
      await updateMemoryVersioned(store, workspaceKey, item.memoryId, {
        title: next.title, text: next.text, tags: next.keywords, collectionId,
      }, now)
    }
    mappings.push({
      memoryId: item.memoryId,
      title: item.title,
      fromCollection: fromTitle,
      toCollection: spec?.title ?? item.collection,
      titleChanged,
      tagsChanged,
      textChanged,
      ...(item.note ? { note: item.note } : {}),
    })
  }

  // 3) entries outside the plan (created since authoring): best match, fallback.
  const unknownAssignments: OrganizeMemoryAssignment[] = []
  let fallbackId: string | undefined
  const ensureFallback = async (): Promise<string> => {
    if (fallbackId) return fallbackId
    const existing = activeCollections(store, workspaceKey)
      .find(([, row]) => row.title.trim().toLowerCase() === ORGANIZE_FALLBACK.title.trim().toLowerCase())
    if (existing) { fallbackId = existing[0]; return fallbackId }
    const id = newId('mc')
    await store.memoryCollections.put(id, newCollection(workspaceKey, ORGANIZE_FALLBACK, now))
    fallbackId = id
    return id
  }
  const assignUnknown = async (row: OrganizeUnknownRow): Promise<void> => {
    const memory = store.memories.get(row.memoryId)
    if (!memory) return
    const match = bestCollectionFor(
      { title: row.title, keywords: memory.keywords ?? [], summary: row.text },
      planData.collections.map((spec) => collectionBag(spec, workspaceKey)),
    )
    let targetId: string | undefined
    let targetTitle = ORGANIZE_FALLBACK.title
    if (match && match.tier !== 'low') {
      const key = planData.collections.find((spec) => spec.title === match.title)?.key
      targetId = key ? collectionIdFor(key) : undefined
      if (key && !targetId) targetId = await ensureFallback()
      if (key) targetTitle = match.title
    }
    if (!targetId) { targetId = await ensureFallback(); targetTitle = ORGANIZE_FALLBACK.title }
    if (memory.collectionId !== targetId) {
      // R30 需求①: 集合迁移同样是一次内容变更，走版本化更新并归档。
      await updateMemoryVersioned(store, workspaceKey, row.memoryId, { collectionId: targetId }, now)
    }
    unknownAssignments.push({ memoryId: row.memoryId, title: row.title, collection: targetTitle })
  }
  for (const row of planned.unknown) await assignUnknown(row)

  // 4) deletions: junk always (hash-guarded); merged rows only when the keeper
  //    now carries the merged body.
  const deletionViews: OrganizeDeletionView[] = []
  for (const item of planned.deletions) {
    const view: OrganizeDeletionView = { ...item }
    if (view.willDelete && item.mergedInto) {
      const keeper = store.memories.get(item.mergedInto)
      const keeperSpec = planData.entries.find((row) => row.memoryId === item.mergedInto)
      const expectedText = keeperSpec?.text
      // A duplicate that is absorbed without body rewriting has no expected
      // text: an existing keeper is enough. A real merge requires the keeper
      // to actually carry the merged body.
      const keeperOk = !!keeper && (expectedText === undefined || keeper.text === expectedText)
      if (!keeperOk) {
        view.willDelete = false
        view.blockedReason = '合并目标未写入合并正文，保留该条避免丢信息'
        planned.conflicts.push({
          memoryId: item.memoryId,
          title: item.title,
          action: 'merge',
          reason: `合并目标 ${item.mergedInto} 未写入成功，保留本条避免丢信息`,
        })
      }
    }
    if (view.willDelete) await store.memories.delete(item.memoryId)
    deletionViews.push(view)
  }

  // 5) verification sweep: no entry (active or superseded) may be left with a
  //    dangling collectionId after the old collections were removed.
  for (const [memoryId, memory] of store.memories.entries()) {
    if (memory.workspaceKey !== workspaceKey) continue
    const current = workspaceCollection(store, workspaceKey, memory.collectionId)
    // A row in one of the pre-R23 collections is re-assigned even when a
    // conflict keeps that collection alive for a moment: no entry may stay in
    // a collection this pass is supposed to retire (active or superseded).
    const retired = current !== undefined && planData.oldCollectionIds.includes(current[0])
      && isRetiredCollection(planData, current[0], current[1].title)
    if (current && !retired) continue
    await assignUnknown({ memoryId, title: memory.title ?? '', text: memory.text, ...(memory.collectionId ? { collectionId: memory.collectionId } : {}) })
  }

  // 6) old collections: remove only the pre-R23 rows, and only when nothing
  //    active still points at them.
  for (const [id, row] of planned.oldCollections) {
    const referenced = [...store.memories.entries()]
      .some(([, memory]) => memory.workspaceKey === workspaceKey && memory.collectionId === id)
    if (referenced) {
      planned.conflicts.push({
        memoryId: '',
        title: row.title,
        action: 'delete',
        reason: `旧集合仍被条目引用，保留未删除（id ${id}）`,
      })
      continue
    }
    await store.memoryCollections.delete(id)
  }

  // 7) marker (only after the whole pass succeeded)
  const after = organizeState(store, workspaceKey)
  if (!options.dryRun) await store.meta.put(markerKey, {
    organizeVersion: planData.version,
    organizeAppliedAt: now,
    organizeWorkspace: workspaceKey,
    organizeBackup: backupPath,
    organizeSummary: `${after.counts.collections} 个集合 / ${after.counts.entries} 条条目`,
  })
  if (!options.dryRun) logger?.info(`supermemory: memory organize applied — ${mappings.length} entries mapped, `
    + `${deletionViews.filter((row) => row.willDelete).length} removed, ${after.counts.collections} collections; backup ${backupPath}`)
  return {
    status: options.dryRun ? 'preview' : 'applied',
    before: planned.before,
    after: after.counts,
    collections: after.collections,
    mappings,
    deletions: deletionViews,
    conflicts: planned.conflicts,
    unknownAssignments,
    ...(backupPath ? { backupPath } : {}),
    marker: options.dryRun ? false : true,
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/** Human-readable report for /memory-organize and the startup log. */
export function renderMemoryOrganizeReport(result: MemoryOrganizeResult): string {
  const label = result.status === 'applied'
    ? '已执行并写库'
    : result.status === 'already-done'
      ? '整理标记已存在，未重复执行'
      : result.status === 'preview'
        ? '预演，未写库'
        : '无需整理'
  const lines = [`记忆整理（${label}）：`]
  if (result.reason) lines.push('- 说明：' + result.reason)
  const before = result.before
  lines.push(`- 整理前：${before.collections} 个集合 / ${before.entries} 条条目 / 未归集 ${before.uncollected} / 空集合 ${before.emptyCollections} / 已停用 ${before.inactive}`)
  if (result.after) {
    const after = result.after
    lines.push(`- 整理后：${after.collections} 个集合 / ${after.entries} 条条目 / 未归集 ${after.uncollected} / 空集合 ${after.emptyCollections}`)
  }
  if (result.collections.length > 0) {
    lines.push('- 集合与条目数：')
    for (const row of result.collections) lines.push(`  · ${row.title}（${row.entryCount} 条）`)
  }
  if (result.mappings.length > 0) {
    lines.push('- 归属调整：' + result.mappings.length + ' 条')
    for (const row of result.mappings) {
      const changes: string[] = []
      if (row.fromCollection !== row.toCollection) changes.push(`集合「${row.fromCollection || '未归集'}」→「${row.toCollection}」`)
      if (row.titleChanged) changes.push('标题已修正')
      if (row.tagsChanged) changes.push('标签已规范')
      if (row.textChanged) changes.push('正文已合并/补注')
      lines.push(`  · ${row.title}（${changes.join('；') || '已符合'}）${row.note ? ' — ' + row.note : ''}`)
    }
  }
  if (result.deletions.length > 0) {
    lines.push('- 删除/吸收清单：')
    for (const row of result.deletions) {
      const state = row.willDelete ? (result.status === 'preview' ? '将删除' : '已删除') : ('保留：' + (row.blockedReason ?? '正文已变'))
      lines.push(`  · 「${row.title}」— ${state}；${row.reason}${row.mergedInto ? '；并入 ' + row.mergedInto : ''}`)
    }
  }
  if (result.unknownAssignments.length > 0) {
    lines.push('- 计划外条目（整理后新写入的）：')
    for (const row of result.unknownAssignments) lines.push(`  · ${row.title} → 「${row.collection}」`)
  }
  if (result.conflicts.length > 0) {
    lines.push('- 冲突（保持现状）：')
    for (const row of result.conflicts) lines.push(`  · ${row.title || row.memoryId}：${row.reason}`)
  }
  if (result.backupPath) lines.push('- 原始数据备份：' + result.backupPath)
  if (result.marker && result.status === 'applied') lines.push('- 整理标记已写入 store.meta（重启不会重复执行）。')
  return lines.join('\n')
}
