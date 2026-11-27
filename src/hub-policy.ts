/**
 * R36 需求①② — the hub tool WHITELIST (default deny).
 *
 * R33 modelled hub permissions as a blacklist: everything except ~20 hands-on
 * tools stayed available. That fails the actual requirement — an unknown or
 * future tool is silently ALLOWED, so a hub can drift into doing the work
 * itself with a tool nobody reviewed. R36 inverts the model:
 *
 *   a hub may call a tool ONLY when it is on the whitelist (exact name or a
 *   whitelisted prefix); everything else — including tools that do not exist
 *   yet — is denied with a structured `HUB_TOOL_NOT_IN_ALLOWLIST`.
 *
 * Design notes:
 *   - the policy lives in its own table `hub_policies` (one row per workspace),
 *     so a policy is DATA with a workspace scope, not a marker squeezed into
 *     `meta` (markers are process facts; the `organize-<digest>` per-workspace
 *     meta rows were the reason a policy row would have to be digest-keyed);
 *   - a missing row (old medium) or an unreadable store degrades to the BUILT-IN
 *     DEFAULT and reports a warning — never fail-open (which would allow
 *     everything) and never fail-closed (which would break the dispatch link,
 *     because `memory_dispatch` is locked);
 *   - {@link LOCKED_HUB_TOOLS} are always allowed regardless of the stored
 *     list: they are the dispatch/relay spine, and removing them would let a
 *     hub lock itself out of its own job. The panel renders them as locked.
 * R39 adds the DYNAMIC panel catalog below the policy: the runtime tool list is
 * read from `ctx.tools.definitions()` on every call, attributed to a source
 * (a declared field when the host provides one, otherwise a documented naming
 * rule that is labelled as an inference in the UI), grouped, and diffed against
 * the whitelist so stale entries are listed instead of silently dropped. The
 * built-in catalog survives only as the fallback when enumeration fails.
 *
 * R40 fixes the one blind spot of that view: `definitions()` without a scope
 * is the GLOBAL registration surface, while DSH's Web surface disables the
 * ordinary tool rows and mounts them per agent/preset. A hub session still
 * calls those tools, so a whitelisted name such as `plugin_manager` was
 * reported as "stale" and could be removed by the cleanup action. The explicit
 * {@link HOST_SESSION_TOOLS} list below synthesizes exactly those host/session
 * capabilities as a separate, non-stale source group; a real definition always
 * wins when the runtime does expose the same name.
 * @module supermemory/hub-policy
 */
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'

/** Bump when the default list or the record shape changes. */
export const HUB_POLICY_VERSION = 1

/**
 * R55: the READ-ONLY knowledge-face tool. A hub may load a capability's body to
 * judge whether it applies, but never runs it: execution is dispatched to a
 * branch (role-guard code `HUB_CAPABILITY_EXEC_DENIED`).
 */
export const CAPABILITY_DOC_TOOL = 'sm_cap_doc'

/** R55: the capability EXECUTION surface shares this prefix. */
export const CAPABILITY_EXEC_PREFIX = 'sm_cap_'

/** R55: historical capability tools (read-side mapping only; R50 never registers them). */
export const CAPABILITY_EXEC_LEGACY_PREFIX = 'sm_composite_'

/**
 * Core locked entries — always allowed, and the panel cannot uncheck them.
 * These are the dispatch/relay spine, the two ways a hub talks to the user and
 * to its branches, and (R55) the read-only capability knowledge face; without
 * them a hub cannot do its job at all.
 */
export const LOCKED_HUB_TOOLS: readonly string[] = Object.freeze([
  'memory_dispatch',
  'memory_questions',
  'memory_recall',
  'ask_user_question',
  'send_message',
  'run_code',
  // R55: read-only routing — the hub reads the knowledge face to decide, then
  // dispatches the execution. Locked so a stored row can never hide it.
  'sm_cap_doc',
])

/**
 * R60: the read-only session-history family — the five tools of the host
 * package `@deepseek-ai/dsh-tool-session-query` (globally registered, every
 * result authorized from the calling agent's workspace, NO write surface).
 *
 * Why a list, not just the prefix rule: the prefix decides the GROUP, this
 * list decides the READ-ONLY BADGE and the default whitelist membership. Each
 * name is backed by the package source (apply() registers exactly these five
 * through ctx.tools.register); a future session_* tool would still group here
 * but carry no verified read-only badge until it is added.
 */
export const SESSION_HISTORY_TOOLS: readonly string[] = Object.freeze([
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
])

/** R60: whether a name is one of the verified read-only session-history tools. */
export function isSessionHistoryTool(toolName: string): boolean {
  return SESSION_HISTORY_TOOLS.includes(String(toolName ?? '').trim())
}

/**
 * The built-in default whitelist (R33's allowed set, unchanged in membership):
 * the memory tools, the dispatch/collect line, the communication tools, the
 * read-only inspection tools, the schedule family (prefix), and the PTC
 * transport. `plugin_manager` is here on purpose (a hub may reload the plugin)
 * but the panel lets the user switch it OFF, with the consequence spelled out.
 */
export const DEFAULT_HUB_TOOLS: readonly string[] = Object.freeze([
  // 记忆
  'memory_dispatch',
  'memory_questions',
  'memory_resume',
  'memory_recall',
  'memory_remember',
  'memory_history',
  'memory_topicsets',
  'memory_new_topicset',
  'memory_export',
  'memory_scan',
  'memory_set_model',
  'memory_toolize',
  // 固化能力（R55：只读知识面；执行面 sm_cap_* 在中枢被结构性拒绝）
  'sm_cap_doc',
  // 沟通
  'ask_user_question',
  'send_message',
  'wait_agent',
  'list_agents',
  // 只读查看
  'read',
  'glob',
  'grep',
  // R60（用户裁决默认放行）：会话历史只读族——与 read/glob/grep 同列；
  // 面板独立分组 + 只读徽标；存盘行仍可关闭（非锁定）。
  ...SESSION_HISTORY_TOOLS,
  // 其它 / AI 传输
  'skill',
  'todo_write',
  'present',
  'run_code',
  'plugin_manager',
])

/** Prefix entries of the built-in default whitelist (the schedule family). */
export const DEFAULT_HUB_PREFIXES: readonly string[] = Object.freeze(['schedule_'])

/**
 * Hands-on execution tools (the R33 blacklist, kept as KNOWLEDGE, not as a
 * rule): they appear in the panel catalog with a risk note so a user can see
 * what a hub would be able to do if they deliberately enabled one.
 */
export const HUB_EXECUTION_TOOLS: readonly string[] = Object.freeze([
  'bash',
  'gitbash_native',
  'write',
  'edit',
  'apply_patch',
  'multi_edit',
  'create_file',
  'delete_file',
  'move_file',
  'terminal_open',
  'terminal_read',
  'terminal_close',
  'terminal_signal',
  'job_kill',
  'office_render',
  'office_convert',
  'office_recalculate',
  'subagent',
  'subagent_fork',
  'workflow',
])

/** One persisted policy row (table `hub_policies`). */
export interface HubPolicy {
  workspaceKey: string
  tools: string[]
  prefixes: string[]
  updatedAt: number
}

/** The resolved policy the guard evaluates (stored row or built-in default). */
export interface ResolvedHubPolicy {
  tools: string[]
  prefixes: string[]
  /** Where the values came from (diagnostics + the panel's source badge). */
  source: 'stored' | 'default'
}

/**
 * Whitelist test. Locked entries pass even when a stored list omits them —
 * the stored row is user data and must not be able to break the dispatch link.
 */
export function isHubAllowedTool(
  toolName: string,
  policy: { tools: readonly string[]; prefixes: readonly string[] },
): boolean {
  const name = String(toolName ?? '')
  if (!name) return false
  if (LOCKED_HUB_TOOLS.includes(name)) return true
  if (policy.tools.includes(name)) return true
  return policy.prefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix))
}

/** True for an entry the panel must render as locked (cannot be unchecked). */
export function isLockedHubTool(toolName: string): boolean {
  return LOCKED_HUB_TOOLS.includes(toolName)
}

/**
 * R55: is this name the capability EXECUTION surface (a concrete `sm_cap_*`
 * tool, legacy `sm_composite_*` read the same way)? `sm_cap_doc` is the
 * knowledge face, never execution.
 */
export function isCapabilityExecutionTool(toolName: string): boolean {
  const name = String(toolName ?? '').trim()
  if (!name || name === CAPABILITY_DOC_TOOL) return false
  return name.startsWith(CAPABILITY_EXEC_PREFIX) || name.startsWith(CAPABILITY_EXEC_LEGACY_PREFIX)
}

/**
 * The panel badge a catalog row carries:
 *   - `capabilityDoc` = read-only routing locked on (R55);
 *   - `capabilityExecDenied` = a hub must dispatch the execution (R55);
 *   - `sessionReadonly` = the verified read-only session-history family (R60).
 * Undefined keeps the plain rendering.
 */
export function hubCatalogNoteKey(toolName: string): 'capabilityDoc' | 'capabilityExecDenied' | 'sessionReadonly' | undefined {
  const name = String(toolName ?? '').trim()
  if (name === CAPABILITY_DOC_TOOL) return 'capabilityDoc'
  if (isCapabilityExecutionTool(name)) return 'capabilityExecDenied'
  if (isSessionHistoryTool(name)) return 'sessionReadonly'
  return undefined
}

/** De-duplicate, trim and drop empties; keeps the stored list canonical. */
export function normalizePolicyList(values: readonly unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    const name = String(value ?? '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * Read the policy of one workspace. NEVER throws: an unreadable table, a
 * malformed row or a missing workspace key degrades to the built-in default and
 * reports through `warn` — the guard must keep deciding, and the default keeps
 * the dispatch link alive.
 */
export function readHubPolicy(
  store: Store | undefined,
  workspaceKey: string | undefined,
  warn?: (message: string) => void,
): ResolvedHubPolicy {
  const fallback = (): ResolvedHubPolicy => ({
    tools: [...DEFAULT_HUB_TOOLS],
    prefixes: [...DEFAULT_HUB_PREFIXES],
    source: 'default',
  })
  if (!store || !workspaceKey) return fallback()
  try {
    const table = (store as { hubPolicies?: Store['hubPolicies'] }).hubPolicies
    if (!table || typeof table.entries !== 'function') return fallback()
    for (const [, row] of table.entries()) {
      if (!row || row.workspaceKey !== workspaceKey) continue
      const tools = normalizePolicyList(row.tools ?? [])
      const prefixes = normalizePolicyList(row.prefixes ?? [])
      if (tools.length === 0 && prefixes.length === 0) {
        warn?.('supermemory: hub policy row for this workspace is empty; using the built-in default whitelist')
        return fallback()
      }
      return { tools, prefixes, source: 'stored' }
    }
    return fallback()
  } catch (error) {
    warn?.('supermemory: hub policy read failed; using the built-in default whitelist: '
      + String(error).slice(0, 160))
    return fallback()
  }
}

/** Persist one workspace's policy (full replace; the panel always sends both lists). */
export async function writeHubPolicy(
  store: Store,
  workspaceKey: string,
  tools: readonly string[],
  prefixes: readonly string[],
  now = Date.now(),
): Promise<void> {
  const table = (store as { hubPolicies?: Store['hubPolicies'] }).hubPolicies
  if (!table) throw new Error('hub_policies 表不可用（存储域缺少该表）')
  const cleanTools = normalizePolicyList(tools)
  const cleanPrefixes = normalizePolicyList(prefixes)
  // The stored row keeps the locked entries even if a caller dropped them: the
  // guard would allow them anyway, and a row that reads as if they were removed
  // is a lie the next reader would have to re-derive.
  const merged = normalizePolicyList([...cleanTools, ...LOCKED_HUB_TOOLS])
  let rowId: string | undefined
  for (const [id, row] of table.entries()) {
    if (row?.workspaceKey === workspaceKey) { rowId = id; break }
  }
  const record: HubPolicy = {
    workspaceKey,
    tools: merged,
    prefixes: cleanPrefixes,
    updatedAt: now,
  }
  if (rowId) await table.update(rowId, () => record)
  else await table.put(`hub-policy-${workspaceKey}`, record)
}

/** Drop the stored row so the workspace falls back to the built-in default. */
export async function resetHubPolicy(store: Store, workspaceKey: string): Promise<boolean> {
  const table = (store as { hubPolicies?: Store['hubPolicies'] }).hubPolicies
  if (!table) return false
  let rowId: string | undefined
  for (const [id, row] of table.entries()) {
    if (row?.workspaceKey === workspaceKey) { rowId = id; break }
  }
  if (!rowId) return false
  await table.delete(rowId)
  return true
}

/** Bump when the locked-entry merge rules change; an older marker re-runs. */
export const HUB_POLICY_LOCKED_MERGE_VERSION = 1

/** The meta-table row key of the one-time locked-entry merge marker. */
const LOCKED_MERGE_MARKER = 'hub-policy-locked'

/** Result of {@link mergeLockedHubPolicies}. */
export interface HubPolicyLockedMergeResult {
  status: 'merged' | 'already-done' | 'no-store'
  /** Stored policy rows scanned this run. */
  rows: number
  /** Rows rewritten because they were missing a locked entry. */
  updated: number
  /** Locked names that were added (deduplicated). */
  added: string[]
}

/**
 * R55 one-time migration: merge {@link LOCKED_HUB_TOOLS} into every STORED
 * workspace policy row. The guard already allows locked entries regardless of
 * the row ({@link isHubAllowedTool}), so this is not a permission change — it
 * makes the durable row tell the truth (the panel reads it back as checked),
 * and it is the documented upgrade step for rows written before R55.
 *
 * Idempotent: after the first pass no row is missing a locked entry, so a
 * second call reports `already-done` and writes nothing. A marker row records
 * the check; `ignoreMarker` forces a re-scan (tests / restored backups).
 */
export async function mergeLockedHubPolicies(
  store: Store | undefined,
  options: { now?: number; ignoreMarker?: boolean } = {},
): Promise<HubPolicyLockedMergeResult> {
  const empty = (status: HubPolicyLockedMergeResult['status']): HubPolicyLockedMergeResult =>
    ({ status, rows: 0, updated: 0, added: [] })
  if (!store) return empty('no-store')
  const table = (store as { hubPolicies?: Store['hubPolicies'] }).hubPolicies
  if (!table || typeof table.entries !== 'function') return empty('no-store')
  const now = Number.isFinite(Number(options.now)) && Number(options.now) > 0 ? Number(options.now) : Date.now()
  try {
    if (!options.ignoreMarker) {
      const marker = (await store.meta?.get?.(LOCKED_MERGE_MARKER)) as { hubPolicyLockedVersion?: number } | undefined
      if (Number(marker?.hubPolicyLockedVersion ?? 0) >= HUB_POLICY_LOCKED_MERGE_VERSION) {
        return { ...empty('already-done'), status: 'already-done' }
      }
    }
    let rows = 0
    let updated = 0
    const added = new Set<string>()
    for (const [id, row] of table.entries()) {
      rows += 1
      const tools = normalizePolicyList(row?.tools ?? [])
      const missing = LOCKED_HUB_TOOLS.filter((name) => !tools.includes(name))
      if (missing.length === 0) continue
      const nextTools = normalizePolicyList([...tools, ...missing])
      await table.update(id, (current) => ({ ...current, tools: nextTools, updatedAt: now }))
      updated += 1
      for (const name of missing) added.add(name)
    }
    try {
      await store.meta?.put?.(LOCKED_MERGE_MARKER, {
        hubPolicyLockedVersion: HUB_POLICY_LOCKED_MERGE_VERSION,
        hubPolicyLockedMergedAt: now,
        hubPolicyLockedRows: rows,
        hubPolicyLockedUpdated: updated,
      })
    } catch { /* the migrated rows are the fact; the marker is advisory */ }
    return { status: updated > 0 ? 'merged' : 'already-done', rows, updated, added: [...added] }
  } catch {
    // Never break the boot for a policy merge: the guard allows locked entries
    // without the row, so a failed merge only loses the audit wording.
    return empty('no-store')
  }
}

// ---------------------------------------------------------------------------
// R39: the DYNAMIC catalog — runtime tools grouped by their source
// ---------------------------------------------------------------------------

/** Group ids the client maps to localized labels; any unknown id renders `label`. */
export const HUB_CATALOG_GROUPS = Object.freeze({
  supermemory: 'source:supermemory',
  composite: 'source:composite',
  schedule: 'source:schedule',
  // R60: the read-only session-history family (host dsh-tool-session-query).
  session: 'source:session',
  hostSession: 'source:host-session',
  host: 'source:host',
  mcpPrefix: 'source:mcp:',
  declaredPrefix: 'source:declared:',
  stale: 'stale',
})

/**
 * R40: 宿主会话工具合成清单 — tools a hub session can call even though the
 * GLOBAL `ctx.tools.definitions()` view cannot see them.
 *
 * Why a list, not a rule: the Web surface disables the ordinary tool rows in
 * the host layer and mounts them per agent/preset (`dsh-web-app/cordis.patch.yml`
 * disables tool-fs/tool-fs-search/tool-jobs/tool-skill/tool-todo/tool-web/
 * tool-subagent-control…, and the preset files mount them under the agent
 * scope), so a scope-less `definitions()` never lists them. The panel service
 * has no agent scope to ask, and the tool contract has no "per-session" flag.
 * Every name below is therefore backed by a checked DSH registration fact; a
 * fabricated name would claim availability the host never verified.
 *
 * Evidence classes:
 *   - `reserved`: the runtime provides the name outside the registry and
 *     rejects registration under it (`run_code`);
 *   - `agent-scope`: the tool is registered by a shipped preset row through
 *     `agent.ctx.tools.register` (verified in the DSH checkout's
 *     `dsh-web-app/presets/*.patch.yml` and the tool package sources);
 *   - `session-control`: the subagent/job/schedule families a hub needs to
 *     talk to its branches and collect asynchronous results.
 *
 * Deliberately NOT synthesized: hands-on execution and third-party shell tools
 * (`bash`, `gitbash_native`, `write`, `edit`, `office_*`, …). Their presence
 * depends on the selected preset and installed bundles, so a workspace-level
 * panel cannot truthfully claim `available: true` for them. They remain
 * addable by name, and this list can be extended when the host exposes a
 * per-scope enumeration.
 */
export const HOST_SESSION_TOOLS: readonly string[] = Object.freeze([
  // 宿主保留名：PTC 传输（ToolsService 拒绝注册同名工具）
  'run_code',
  // agent 级注册：会话的 agent.ctx 注册，全局 definitions() 看不到
  'plugin_manager',
  'ask_user_question',
  'send_message',
  'wait_agent',
  'list_agents',
  'todo_write',
  'present',
  'read',
  'read_image',
  'glob',
  'grep',
  'skill',
  'job_output',
  'job_list',
  'job_kill',
  'schedule_create',
  'schedule_list',
  'schedule_view',
  'schedule_edit',
])

/**
 * Per-name evidence, also the item description in the panel. Keep each line
 * short: the client renders it as one muted paragraph under the name.
 */
const HOST_SESSION_TOOL_EVIDENCE: Readonly<Record<string, string>> = Object.freeze({
  run_code: '宿主保留名：PTC 程序传输由运行时直接提供，ToolsService.register 拒绝注册同名工具，全局 definitions() 永远不含它。',
  plugin_manager: 'agent 级注册：@deepseek-ai/dsh-plugin-manager/tools 在会话的 agent.ctx 注册；标准预设启用，ptc 预设默认关闭。',
  ask_user_question: 'agent 级注册：@deepseek-ai/dsh-tool-ask-user 由各 agent preset 挂载（标准/ptc 均启用）。',
  send_message: 'agent 级注册：@deepseek-ai/dsh-tool-subagent-control 由 preset 挂载，负责分支消息。',
  wait_agent: 'agent 级注册：@deepseek-ai/dsh-tool-subagent-control 由 preset 挂载，负责等待子代理输入。',
  list_agents: 'agent 级注册：@deepseek-ai/dsh-tool-subagent-control 由 preset 挂载，负责子代理目录。',
  todo_write: 'agent 级注册：@deepseek-ai/dsh-tool-todo 由 preset 挂载。',
  present: 'agent 级注册：@deepseek-ai/dsh-tool-present 由 preset 挂载，负责交付文件卡片。',
  read: 'agent 级注册：@deepseek-ai/dsh-tool-fs 由 preset 挂载（Web 面禁用了宿主全局行，改为每会话注册）。',
  read_image: 'agent 级注册：@deepseek-ai/dsh-tool-fs 由 preset 挂载，负责图片读取。',
  glob: 'agent 级注册：@deepseek-ai/dsh-tool-fs-search 由 preset 挂载。',
  grep: 'agent 级注册：@deepseek-ai/dsh-tool-fs-search 由 preset 挂载。',
  skill: 'agent 级注册：@deepseek-ai/dsh-tool-skill 由 preset 挂载。',
  job_output: 'agent 级注册：@deepseek-ai/dsh-tool-jobs 由 preset 挂载，负责后台任务输出。',
  job_list: 'agent 级注册：@deepseek-ai/dsh-tool-jobs 由 preset 挂载，负责后台任务列表。',
  job_kill: 'agent 级注册：@deepseek-ai/dsh-tool-jobs 由 preset 挂载，负责取消后台任务（实操类）。',
  schedule_create: 'agent 级注册：@deepseek-ai/dsh-tool-schedule 由 preset 挂载（默认前缀 schedule_ 的匹配项）。',
  schedule_list: 'agent 级注册：@deepseek-ai/dsh-tool-schedule 由 preset 挂载（默认前缀 schedule_ 的匹配项）。',
  schedule_view: 'agent 级注册：@deepseek-ai/dsh-tool-schedule 由 preset 挂载（默认前缀 schedule_ 的匹配项）。',
  schedule_edit: 'agent 级注册：@deepseek-ai/dsh-tool-schedule 由 preset 挂载（默认前缀 schedule_ 的匹配项）。',
})

/** The synthetic source every {@link HOST_SESSION_TOOLS} entry belongs to. */
export const HOST_SESSION_SOURCE: HubCatalogSource = Object.freeze({
  id: HUB_CATALOG_GROUPS.hostSession,
  label: '宿主会话工具',
  kind: 'host-session',
  inferred: false,
  hint: '不在全局注册面（宿主保留名 / agent 级注册 / 会话级 API），但中枢会话实际可用；合成项永不判失效，清理不会移除。',
})

/** Where a catalog group came from: a host-declared field or an inference rule. */
export type HubCatalogSourceKind = 'declared' | 'supermemory' | 'composite' | 'mcp' | 'schedule' | 'session' | 'host' | 'host-session'

/** One attributed source of a runtime tool. */
export interface HubCatalogSource {
  /** Stable group id (see {@link HUB_CATALOG_GROUPS}). */
  id: string
  /** Display label; the client falls back to this for ids it cannot localize. */
  label: string
  kind: HubCatalogSourceKind
  /** True = the attribution is an inference, not declared by the host definition. */
  inferred: boolean
  /** One line naming the rule that produced this attribution. */
  hint?: string
}

/** The part of a runtime ToolDefinition this catalog needs. */
export interface HubToolDescriptor {
  name: string
  description?: string
  /** A host-declared source when the definition carries one (future-proofing). */
  source?: string
}

/** One switchable catalog row. */
export interface HubCatalogItem {
  name: string
  /** Short description excerpt (first line, ≤140 chars). */
  description?: string
  /** True for a prefix entry (rendered with a trailing `*`). */
  prefix?: boolean
  /** Locked entries cannot be unchecked (the panel disables the switch). */
  locked?: boolean
  /** Hands-on execution: shown with a risk note. */
  risk?: boolean
  /** Short locale key suffix for the per-item note (optional). */
  noteKey?: string
  /** Whitelist hit under the stored policy (exact name or prefix). */
  enabled: boolean
  /** Runtime availability; undefined = unknown (built-in fallback cannot verify). */
  available?: boolean
  /** Whitelisted but absent from the runtime list (only inside the stale group). */
  stale?: boolean
  /**
   * R40: synthesized host/session capability — not in the global registration
   * surface, but callable from a hub session. Never stale, never cleaned.
   */
  synthetic?: boolean
  /** Attributed source id. */
  source: string
}

/** One catalog group; `kind: 'stale'` is the trailing failed-entry bucket. */
export interface HubCatalogGroup {
  id: string
  label: string
  kind: 'source' | 'stale'
  inferred: boolean
  hint?: string
  /** R40: this group exists only in the synthetic host-session surface. */
  synthetic?: boolean
  items: HubCatalogItem[]
  total: number
  enabledCount: number
}

/** Provenance of one catalog generation (freshness + degradation). */
export interface HubCatalogMeta {
  generatedAt: number
  mode: 'dynamic' | 'fallback'
  /** Runtime tools seen (dynamic) / built-in entries listed (fallback). */
  toolCount: number
  /** R40: how many of `toolCount` are synthesized host/session entries. */
  syntheticCount: number
  groupCount: number
  /** True when at least one group used a definition-declared source. */
  anyDeclaredSource: boolean
  warning?: string
}

/** The complete catalog one `getHubPolicy` call returns. */
export interface HubCatalogSnapshot {
  groups: HubCatalogGroup[]
  stale: HubCatalogItem[]
  meta: HubCatalogMeta
}

/** Introspection keys a future host definition may use to declare its owner. */
const DECLARED_SOURCE_FIELDS: readonly string[] = Object.freeze([
  'source', 'sourceName', 'owner', 'ownerName', 'plugin', 'pluginName', 'pluginId', 'packageName', 'serverName', 'mcpServer',
])

/**
 * Read an optional host-declared source from a raw ToolDefinition. The current
 * DSH contract has NO owner field (ToolSchema = name/description/parameters),
 * so this normally returns undefined; it exists so a host that starts exposing
 * one upgrades the catalog from "inferred" to "declared" without a release.
 */
export function declaredHubToolSource(definition: unknown): string | undefined {
  if (!definition || typeof definition !== 'object') return undefined
  const record = definition as Record<string, unknown>
  for (const field of DECLARED_SOURCE_FIELDS) {
    const value = record[field]
    if (typeof value !== 'string') continue
    const clean = value.trim()
    if (clean.length > 0 && clean.length <= 120) return clean
  }
  return undefined
}

const sourceSlug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'source'

/**
 * Attribute one tool to a source. Rules, in order:
 *   1. a declared field on the definition (never inferred);
 *   2. `mcp__<server>__<tool>` → that MCP server;
 *   3. `memory_*` → this plugin;
 *   4. `sm_cap_*` → the capability family (legacy `sm_composite_*` is read the same way; R50 never registers those names);
 *   5. `schedule_*` → the host scheduling plugin;
 *   6. `session_*` → the read-only session-history family (R60);
 *   7. everything else (including names nobody reviewed) → host/未归属.
 * Every rule except (1) is an inference and is reported as one.
 */
export function inferHubToolSource(name: string, declared?: string): HubCatalogSource {
  const toolName = String(name ?? '').trim()
  const declaredSource = String(declared ?? '').trim()
  if (declaredSource) {
    return {
      id: HUB_CATALOG_GROUPS.declaredPrefix + sourceSlug(declaredSource),
      label: declaredSource,
      kind: 'declared',
      inferred: false,
      hint: '按工具定义自带的来源字段分组（宿主声明，非推断）',
    }
  }
  if (toolName.startsWith('mcp__')) {
    const server = /^mcp__(.+?)__/.exec(toolName)?.[1] ?? ''
    return {
      id: HUB_CATALOG_GROUPS.mcpPrefix + (server || 'unknown'),
      label: server ? `MCP · ${server}` : 'MCP · 未知服务器',
      kind: 'mcp',
      inferred: true,
      hint: '按 mcp__<server>__<tool> 命名前缀推断（服务器名含 __ 时可能解析不准）',
    }
  }
  if (toolName.startsWith('memory_')) {
    return { id: HUB_CATALOG_GROUPS.supermemory, label: 'SuperMemory 插件', kind: 'supermemory', inferred: true, hint: '按 memory_* 前缀推断（本插件注册）' }
  }
  if (toolName.startsWith('sm_cap_')) {
    return { id: HUB_CATALOG_GROUPS.composite, label: '固化能力（SuperMemory）', kind: 'composite', inferred: true, hint: '按 sm_cap_* 前缀推断（统一能力：知识面 + 执行面）' }
  }
  // Historical catalog rows may still carry the pre-R50 prefix; read-only mapping.
  if (toolName.startsWith('sm_composite_')) {
    return { id: HUB_CATALOG_GROUPS.composite, label: '固化能力（SuperMemory，旧名）', kind: 'composite', inferred: true, hint: '历史记录中的 sm_composite_* 前缀：只做读侧映射，不再注册' }
  }
  if (toolName.startsWith('schedule_')) {
    return { id: HUB_CATALOG_GROUPS.schedule, label: '调度', kind: 'schedule', inferred: true, hint: '按 schedule_* 前缀推断（宿主调度插件）' }
  }
  // R60: the session-history family sits BEFORE the fallback on purpose — these
  // five tools are globally registered by the host, so without this rule they
  // would land in 宿主内置/未归属 and read like an unattributed bug.
  if (toolName.startsWith('session_')) {
    return { id: HUB_CATALOG_GROUPS.session, label: '会话历史（只读）', kind: 'session', inferred: true, hint: '按 session_* 前缀推断（宿主 dsh-tool-session-query：只读，按调用 agent 做工作区授权）' }
  }
  return { id: HUB_CATALOG_GROUPS.host, label: '宿主内置 / 未归属', kind: 'host', inferred: true, hint: '未命中已知来源规则：归入宿主内置或未归属（未知名同样默认拒绝）' }
}

/** First meaningful line of a tool description, stripped and clipped. */
export function summarizeHubToolDescription(value: unknown, max = 140): string {
  const first = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
  const clean = first.replace(/^[#>*+\-\s]+/, '').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(1, max - 1))}…`
}

/** One group under construction. */
interface HubGroupBucket {
  source: HubCatalogSource
  items: HubCatalogItem[]
}

/** Render order of source kinds: this plugin first, unattributed last. */
function hubSourceRank(source: HubCatalogSource): number {
  switch (source.kind) {
    case 'supermemory': return 0
    case 'composite': return 1
    case 'mcp': return 2
    case 'schedule': return 3
    case 'session': return 4
    case 'declared': return 5
    case 'host-session': return 6
    default: return 7
  }
}

function sortHubItems(items: HubCatalogItem[]): HubCatalogItem[] {
  return items.sort((left, right) =>
    (left.prefix === right.prefix ? 0 : left.prefix ? -1 : 1)
    || (left.locked === right.locked ? 0 : left.locked ? -1 : 1)
    || left.name.localeCompare(right.name))
}

const groupBuckets = (): Map<string, HubGroupBucket> => new Map()

function bucketOf(buckets: Map<string, HubGroupBucket>, source: HubCatalogSource): HubGroupBucket {
  const existing = buckets.get(source.id)
  if (existing) return existing
  const created: HubGroupBucket = { source, items: [] }
  buckets.set(source.id, created)
  return created
}

/** Turn the buckets + stale rows into the final snapshot (stable ordering). */
function finalizeHubCatalog(
  buckets: Map<string, HubGroupBucket>,
  stale: HubCatalogItem[],
  now: number,
  info: { mode: 'dynamic' | 'fallback'; toolCount: number; syntheticCount?: number; warning?: string },
): HubCatalogSnapshot {
  const ordered = [...buckets.values()].sort((left, right) =>
    hubSourceRank(left.source) - hubSourceRank(right.source)
    || left.source.label.localeCompare(right.source.label))
  const groups: HubCatalogGroup[] = ordered.map((bucket) => {
    const items = sortHubItems(bucket.items)
    return {
      id: bucket.source.id,
      label: bucket.source.label,
      kind: 'source',
      inferred: bucket.source.inferred,
      ...(bucket.source.hint ? { hint: bucket.source.hint } : {}),
      ...(bucket.source.kind === 'host-session' ? { synthetic: true } : {}),
      items,
      total: items.length,
      enabledCount: items.filter((entry) => entry.enabled).length,
    }
  })
  const staleItems = [...stale].sort((left, right) => left.name.localeCompare(right.name))
  if (staleItems.length > 0) {
    groups.push({
      id: HUB_CATALOG_GROUPS.stale,
      label: '已失效条目',
      kind: 'stale',
      inferred: false,
      hint: '白名单里存在、当前运行时已不存在（工具被卸载/改名）；锁定项不可清理',
      items: staleItems,
      total: staleItems.length,
      enabledCount: staleItems.filter((entry) => entry.enabled).length,
    })
  }
  return {
    groups,
    stale: staleItems,
    meta: {
      generatedAt: now,
      mode: info.mode,
      toolCount: info.toolCount,
      syntheticCount: Math.max(0, Number(info.syntheticCount ?? 0)),
      groupCount: groups.length,
      anyDeclaredSource: ordered.some((bucket) => bucket.source.kind === 'declared'),
      ...(info.warning ? { warning: info.warning } : {}),
    },
  }
}

/** Input of {@link buildHubCatalog}. */
export interface HubCatalogInput {
  /** Runtime definitions (only name/description/source are read). */
  tools?: ReadonlyArray<HubToolDescriptor>
  allowTools?: readonly string[]
  prefixes?: readonly string[]
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number
}

/**
 * Build the catalog from the RUNTIME tool list. Every tool appears exactly
 * once; unknown names land in the host bucket and stay default-denied. The
 * explicit {@link HOST_SESSION_TOOLS} list fills the names the GLOBAL view
 * cannot see (R40) and is never stale. Any other whitelisted name absent from
 * the runtime list is moved to the stale bucket — never dropped.
 */
export function buildHubCatalog(input: HubCatalogInput): HubCatalogSnapshot {
  const allowTools = normalizePolicyList(input.allowTools ?? [])
  const prefixes = normalizePolicyList(input.prefixes ?? [])
  const now = Number.isFinite(Number(input.now)) && Number(input.now) > 0 ? Number(input.now) : Date.now()
  const policy = { tools: allowTools, prefixes }
  const buckets = groupBuckets()
  const runtime = new Map<string, HubCatalogItem>()
  const sources = new Map<string, HubCatalogSource>()

  for (const raw of input.tools ?? []) {
    const name = String(raw?.name ?? '').trim()
    if (!name || runtime.has(name)) continue
    const declared = typeof raw?.source === 'string' ? raw.source : declaredHubToolSource(raw)
    const source = inferHubToolSource(name, declared)
    sources.set(name, source)
    const description = summarizeHubToolDescription(raw?.description)
    const noteKey = hubCatalogNoteKey(name)
    runtime.set(name, {
      name,
      ...(description ? { description } : {}),
      enabled: isHubAllowedTool(name, policy),
      available: true,
      source: source.id,
      ...(isLockedHubTool(name) ? { locked: true } : {}),
      ...(HUB_EXECUTION_TOOLS.includes(name) ? { risk: true } : {}),
      ...(noteKey ? { noteKey } : {}),
    })
  }
  // R40: supplement the GLOBAL view with the explicit host/session surface.
  // A real definition above always wins (same name => never a duplicate and
  // never a synthetic description); the list only fills what the global view
  // structurally cannot see.
  let syntheticCount = 0
  for (const name of HOST_SESSION_TOOLS) {
    if (runtime.has(name)) continue
    sources.set(name, HOST_SESSION_SOURCE)
    runtime.set(name, {
      name,
      description: HOST_SESSION_TOOL_EVIDENCE[name],
      enabled: isHubAllowedTool(name, policy),
      available: true,
      synthetic: true,
      source: HOST_SESSION_SOURCE.id,
      ...(name === 'plugin_manager' ? { noteKey: 'pluginManager' } : {}),
      ...(hubCatalogNoteKey(name) ? { noteKey: hubCatalogNoteKey(name) } : {}),
      ...(isLockedHubTool(name) ? { locked: true } : {}),
      ...(HUB_EXECUTION_TOOLS.includes(name) ? { risk: true } : {}),
    })
    syntheticCount += 1
  }
  for (const entry of runtime.values()) {
    bucketOf(buckets, sources.get(entry.name) as HubCatalogSource).items.push(entry)
  }
  // A prefix entry is a rule, not a tool: render it once, inside the group of
  // the tools it currently matches (or its own inferred source when mixed).
  for (const prefix of prefixes) {
    const matches = [...runtime.values()].filter((entry) => entry.name.startsWith(prefix))
    if (matches.length === 0) continue
    const sourceIds = new Set(matches.map((entry) => entry.source))
    const source = sourceIds.size === 1
      ? (sources.get(matches[0].name) as HubCatalogSource)
      : inferHubToolSource(prefix)
    bucketOf(buckets, source).items.push({
      name: prefix,
      prefix: true,
      description: `前缀规则：放行所有 ${prefix}* 工具（当前匹配 ${matches.length} 个）`,
      enabled: true,
      available: true,
      source: source.id,
    })
  }
  const stale: HubCatalogItem[] = []
  for (const name of allowTools) {
    // Synthetic host/session entries are already in `runtime`, so they can
    // never fall through to this stale bucket (R40).
    if (runtime.has(name)) continue
    const source = inferHubToolSource(name)
    stale.push({
      name,
      enabled: true,
      available: false,
      stale: true,
      source: source.id,
      ...(isLockedHubTool(name) ? { locked: true } : {}),
      ...(HUB_EXECUTION_TOOLS.includes(name) ? { risk: true } : {}),
      ...(hubCatalogNoteKey(name) ? { noteKey: hubCatalogNoteKey(name) } : {}),
    })
  }
  for (const prefix of prefixes) {
    if ([...runtime.values()].some((entry) => entry.name.startsWith(prefix))) continue
    const source = inferHubToolSource(prefix)
    stale.push({ name: prefix, prefix: true, enabled: true, available: false, stale: true, source: source.id })
  }
  return finalizeHubCatalog(buckets, stale, now, {
    mode: 'dynamic',
    toolCount: runtime.size,
    syntheticCount,
  })
}

/** Input of {@link buildFallbackHubCatalog}. */
export interface HubFallbackInput {
  allowTools?: readonly string[]
  prefixes?: readonly string[]
  now?: number
  /** Why the dynamic path failed; surfaced verbatim to the panel. */
  warning?: string
}

/**
 * FALLBACK catalog: the built-in knowledge list, still grouped by the same
 * source rules, and still carrying EVERY whitelisted entry (an entry the list
 * does not know is added to the host group rather than dropped). `available`
 * stays undefined because this path cannot verify runtime presence, and no
 * stale group is fabricated from an unverifiable comparison.
 */
export function buildFallbackHubCatalog(input: HubFallbackInput): HubCatalogSnapshot {
  const allowTools = normalizePolicyList(input.allowTools ?? [])
  const prefixes = normalizePolicyList(input.prefixes ?? [])
  const now = Number.isFinite(Number(input.now)) && Number(input.now) > 0 ? Number(input.now) : Date.now()
  const policy = { tools: allowTools, prefixes }
  const buckets = groupBuckets()
  const seen = new Set<string>()
  let listed = 0
  const push = (item: HubCatalogItem, source: HubCatalogSource): void => {
    bucketOf(buckets, source).items.push(item)
    if (item.prefix !== true) listed += 1
  }
  for (const group of BUILTIN_HUB_CATALOG) {
    for (const entry of group.items) {
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      // R40: the synthetic host/session list is explicit knowledge, not a
      // runtime verdict — even the fallback can mark those entries available.
      // A prefix entry ("schedule_") is a rule, not a tool, so it keeps the
      // inferred source and stays unverified.
      const hostSession = entry.prefix !== true && HOST_SESSION_TOOLS.includes(entry.name)
      const source = hostSession ? HOST_SESSION_SOURCE : inferHubToolSource(entry.name)
      push({
        name: entry.name,
        ...(entry.prefix ? { description: `前缀规则：放行所有 ${entry.name}* 工具（内置清单，运行时未核验）` } : {}),
        ...(hostSession ? { description: HOST_SESSION_TOOL_EVIDENCE[entry.name] } : {}),
        ...(entry.prefix ? { prefix: true } : {}),
        ...(hostSession ? { available: true, synthetic: true } : {}),
        ...(entry.locked || isLockedHubTool(entry.name) ? { locked: true } : {}),
        ...(entry.risk || HUB_EXECUTION_TOOLS.includes(entry.name) ? { risk: true } : {}),
        ...(entry.noteKey
          ? { noteKey: entry.noteKey }
          : hostSession && entry.name === 'plugin_manager'
            ? { noteKey: 'pluginManager' }
            : hubCatalogNoteKey(entry.name)
              ? { noteKey: hubCatalogNoteKey(entry.name) }
              : {}),
        enabled: entry.prefix ? prefixes.includes(entry.name) : isHubAllowedTool(entry.name, policy),
        source: source.id,
      }, source)
    }
  }
  // Never silently discard a whitelist entry the built-in list does not know.
  for (const name of [...allowTools, ...prefixes]) {
    if (seen.has(name)) continue
    seen.add(name)
    const isPrefix = prefixes.includes(name)
    const hostSession = !isPrefix && HOST_SESSION_TOOLS.includes(name)
    const source = hostSession ? HOST_SESSION_SOURCE : inferHubToolSource(name)
    push({
      name,
      ...(isPrefix ? { prefix: true } : {}),
      description: hostSession
        ? HOST_SESSION_TOOL_EVIDENCE[name]
        : '白名单条目（内置回退：运行时是否存在未核验）',
      ...(hostSession ? { available: true, synthetic: true } : {}),
      ...(isLockedHubTool(name) ? { locked: true } : {}),
      ...(hostSession && name === 'plugin_manager'
        ? { noteKey: 'pluginManager' }
        : hubCatalogNoteKey(name)
          ? { noteKey: hubCatalogNoteKey(name) }
          : {}),
      enabled: true,
      source: source.id,
    }, source)
  }
  return finalizeHubCatalog(buckets, [], now, {
    mode: 'fallback',
    toolCount: listed,
    warning: input.warning ?? '动态目录不可用，已回退内置清单',
  })
}

/** Input of {@link cleanStaleHubPolicy}. */
export interface StaleCleanupInput {
  allowTools?: readonly string[]
  prefixes?: readonly string[]
  /** Names the runtime currently registers (pseudo tools are added internally). */
  runtimeNames?: readonly string[]
}

/** Result of {@link cleanStaleHubPolicy}. */
export interface StaleCleanupResult {
  tools: string[]
  prefixes: string[]
  removed: number
  removedNames: string[]
}

/**
 * Drop whitelist entries the runtime no longer has. Locked entries are kept
 * even when absent (the guard always allows them, so writing them out would
 * only be relabelled next read); a prefix is kept while any runtime tool
 * matches it.
 */
export function cleanStaleHubPolicy(input: StaleCleanupInput): StaleCleanupResult {
  const runtime = new Set((input.runtimeNames ?? []).map((name) => String(name ?? '').trim()).filter(Boolean))
  // R40: synthetic host/session entries are callable even though the global
  // enumeration cannot see them, so cleanup must never remove them.
  for (const name of HOST_SESSION_TOOLS) runtime.add(name)
  const tools = normalizePolicyList(input.allowTools ?? [])
  const prefixes = normalizePolicyList(input.prefixes ?? [])
  const removedNames: string[] = []
  const keptTools = tools.filter((name) => {
    const keep = runtime.has(name) || isLockedHubTool(name)
    if (!keep) removedNames.push(name)
    return keep
  })
  const keptPrefixes = prefixes.filter((prefix) => {
    const keep = [...runtime].some((name) => name.startsWith(prefix))
    if (!keep) removedNames.push(prefix)
    return keep
  })
  return { tools: keptTools, prefixes: keptPrefixes, removed: removedNames.length, removedNames }
}

/** One entry of the built-in FALLBACK catalog. */
interface HubBuiltinItem {
  name: string
  prefix?: boolean
  locked?: boolean
  risk?: boolean
  noteKey?: string
}

interface HubBuiltinGroup {
  id: string
  items: HubBuiltinItem[]
}

const item = (name: string, extra: Partial<HubBuiltinItem> = {}): HubBuiltinItem => ({ name, ...extra })

/**
 * The built-in catalog — the FALLBACK path only (R39). It still lists every
 * tool the plugin knows about (so a host without `ctx.tools.definitions()` has
 * a truthful, default-denied screen instead of a blank one), but the normal
 * path is the runtime list grouped by source.
 */
export const BUILTIN_HUB_CATALOG: readonly HubBuiltinGroup[] = Object.freeze([
  {
    id: 'memory',
    items: [
      item('memory_remember'),
      item('memory_recall', { locked: true }),
      item('memory_history'),
      item('memory_topicsets'),
      item('memory_new_topicset'),
      item('memory_export'),
      item('memory_scan'),
      item('memory_set_model'),
      item('memory_toolize'),
      item('memory_ui'),
      item('memory_raise_question'),
      // R55: the knowledge face alone — the execution surface is never
      // synthesized here (a concrete sm_cap_* tool appears when registered).
      item('sm_cap_doc', { locked: true, noteKey: 'capabilityDoc' }),
    ],
  },
  {
    id: 'dispatch',
    items: [
      item('memory_dispatch', { locked: true }),
      item('memory_resume'),
      item('memory_questions', { locked: true }),
    ],
  },
  {
    id: 'comm',
    items: [
      item('ask_user_question', { locked: true }),
      item('send_message', { locked: true }),
      item('wait_agent'),
      item('list_agents'),
      item('interrupt_agent', { risk: true }),
      item('propose_action'),
    ],
  },
  {
    id: 'readonly',
    items: [
      item('read'),
      item('read_image'),
      item('glob'),
      item('grep'),
      item('lsp'),
      item('session_search'),
      item('session_trace'),
      item('session_event_search'),
      item('session_event_trace'),
      item('session_event_read'),
      item('list_subagent_models'),
      item('job_list'),
      item('job_output'),
    ],
  },
  {
    id: 'schedule',
    items: [item('schedule_', { prefix: true })],
  },
  {
    id: 'other',
    items: [
      item('run_code', { locked: true }),
      item('plugin_manager', { noteKey: 'pluginManager' }),
      item('skill'),
      item('todo_write'),
      item('present'),
      item('update_goal'),
      item('create_goal'),
      item('get_goal'),
      item('cordis_inspect_list'),
      item('cordis_inspect_query'),
      item('web_search'),
      item('web_fetch'),
      ...HUB_EXECUTION_TOOLS.map((name) => item(name, { risk: true })),
      item('terminal_list', { risk: true }),
      item('terminal_open', { risk: true }),
      item('terminal_read', { risk: true }),
      item('terminal_close', { risk: true }),
      item('terminal_signal', { risk: true }),
      item('job_kill', { risk: true }),
      item('ralph', { risk: true }),
      item('spawn_teammate', { risk: true }),
    ],
  },
])


