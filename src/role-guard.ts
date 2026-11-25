/**
 * R32 需求①② / R33 需求②④⑤⑧ / R36 需求①② — harden the hub/branch division
 * of labour in RUNTIME CODE.
 *
 * Three rules used to live only in the hub role prompt / DEV-NOTES SOP:
 *   1. only a hub (or the GUI) may reload this plugin; a branch that disables
 *     then enables `include:supermemory` kills its own agent in the same
 *     millisecond (R31 empirical evidence);
 *   2. a hub only judges and dispatches; it must not perform the work itself.
 *
 * Both are enforced through DSH's monotonic `ctx.tools.guard()` seam: the guard
 * runs after every pre-execute policy and before the tool body, so a denial is
 * final and cannot be turned back into permission by another listener.
 *
 * R33 fixes:
 *   - role resolution is delegated to {@link resolveRole} (positive hub marks,
 *     workspace-scoped, branch wins) instead of "top-level = hub";
 *   - the decision is TOTAL: any resolution/store failure still denies
 *     `plugin_manager` mutations (fail-closed) and ALLOWS ordinary tools, and
 *     reports the failure through the caller's warning sink;
 *   - a denial carries a structured `info.code` (ToolGuardDenial), so callers
 *     and durable diagnostics can identify the rule without parsing prose.
 *
 * R36 需求①② — the hub model becomes a WHITELIST (default deny). The R33
 * blacklist (20 hands-on tools) allowed every tool nobody had thought of, which
 * is exactly how a hub drifts into doing the work itself with a future tool.
 * Now a hub may call a tool ONLY when it is on the workspace whitelist
 * ({@link isHubAllowedTool}); everything else — including unknown/new tools —
 * is denied with `HUB_TOOL_NOT_IN_ALLOWLIST`. The whitelist is read per call
 * through {@link readHubPolicy}, which NEVER throws and degrades to the
 * built-in default (with a warning) so the dispatch link cannot be broken by a
 * missing row, and cannot be widened by an unreadable store.
 *
 * What is intentionally NOT denied:
 *   - `run_code` is the PTC transport a hub uses to call `memory_dispatch`;
 *     denying it would also deny the dispatch path. Direct Node APIs inside a
 *     program are a host-level capability (documented in DEV-NOTES §42/§43).
 *   - read-only / light tools stay available to every role through the default
 *     whitelist, so a hub can still judge and summarise.
 * @module supermemory/role-guard
 */
import type { Store } from './store.ts'
import { agentSessionId, agentWorkspaceKey, resolveRole, type SessionRole } from './role.ts'
import {
  CAPABILITY_DOC_TOOL,
  isCapabilityExecutionTool,
  isHubAllowedTool,
  readHubPolicy,
} from './hub-policy.ts'

export { agentSessionId }

/** Exact refusal for a branch that tries to reload this plugin. */
export const BRANCH_RELOAD_DENIED =
  '分支会话不能重载插件，请由中枢会话执行（plugin_manager 的禁用/启用会终止当前分支）。'

/** Exact refusal for a non-branch, non-hub session that tries plugin management. */
export const NON_HUB_RELOAD_DENIED =
  '只有中枢会话可以重载插件，请由中枢会话执行（当前会话不是中枢）。'

/** Exact guidance for a hub whose tool is not on the whitelist (R36). */
export function hubToolNotAllowed(toolName: string): string {
  return '该工具「' + toolName + '」不在中枢白名单中：可在超级记忆面板「中枢权限」页签勾选启用'
    + '（中枢默认拒绝白名单以外的工具，未来新增工具同样默认拒绝）。'
    + '中枢只做派发与收线，执行请用 memory_dispatch 派发给分支。'
}

/**
 * R55: exact refusal for a hub that tries to RUN a capability. Deliberately
 * distinct from the generic allowlist wording (which suggests ticking a panel
 * checkbox): there is no checkbox that makes a hub run a capability — the tool
 * is hidden from the hub's surface and the only correct move is to dispatch.
 */
export function hubCapabilityExecDenied(toolName: string): string {
  return '中枢不能执行固化能力；请用 memory_dispatch 派发到分支，任务里写明能力名、是否先预演、写操作需 confirm=true。'
    + '（被拒绝的工具：' + toolName + '）'
}

/**
 * R55: exact refusal for an ordinary (non-hub, non-branch) session reading a
 * capability knowledge face. The tool stays registered on purpose so the model
 * gets this explanation instead of a bare `UNKNOWN_TOOL`.
 */
export const CAPABILITY_DOC_ROLE_DENIED =
  '固化能力知识面（sm_cap_doc）只允许中枢/分支会话读取：当前会话既不是中枢也不是分支，不能读取能力正文；'
  + '请在对应话题集的中枢或分支会话中查看（普通会话仍可使用宿主 skill 目录里的第三方 skill）。'

/**
 * R36 需求①: the whitelist test moved to `hub-policy.ts` (it needs the stored
 * policy, and the panel/catalog share the same rule). `isHubAllowedTool` is
 * re-exported here so the guard's decision reads in one place.
 */
export { isHubAllowedTool } from './hub-policy.ts'

/** Structured identity name recorded on every denial (ToolErrorInfo.name). */
export const GUARD_ERROR_NAME = 'supermemory:role-guard'

/** Bump when the guard/role rules change; the meta marker records the version. */
export const ROLE_GUARD_VERSION = 4

/**
 * Machine-readable rule identity. R36 replaced the blacklist code
 * `HUB_EXECUTION_DENIED` with `HUB_TOOL_NOT_IN_ALLOWLIST`: the rule is now
 * "not on the whitelist" rather than "on the hands-on blacklist", and the two
 * must stay distinguishable in durable diagnostics.
 */
export type GuardCode =
  | 'BRANCH_RELOAD_DENIED'
  | 'NON_HUB_RELOAD_DENIED'
  | 'HUB_TOOL_NOT_IN_ALLOWLIST'
  // R55: capability division of labour — a hub reads the knowledge face only.
  | 'HUB_CAPABILITY_EXEC_DENIED'
  | 'CAPABILITY_DOC_ROLE_DENIED'

/** The shape `ctx.tools.guard()` accepts: a reason plus structured identity. */
export interface RoleGuardDenial {
  reason: string
  info: { name: string; code: GuardCode }
}

/** Build one denial (one place for the name/code shape). */
export function guardDenial(reason: string, code: GuardCode): RoleGuardDenial {
  return { reason, info: { name: GUARD_ERROR_NAME, code } }
}

/** `plugin_manager` actions that change the profile (all non-list actions). */
const PLUGIN_MANAGEMENT_PURE_ACTIONS: ReadonlySet<string> = new Set([
  'list_plugins',
  'list_bundles',
  'list_version_exemptions',
])

/** Structural view of an Agent (the plugin must not import host runtime values). */
export interface GuardAgentLike {
  id?: string
  session?: {
    id?: string
    header?: {
      parentSession?: unknown
      origin?: string
      delegationDepth?: number
    }
  }
}

/**
 * R35: the old exported `isBranchSession` projection was removed. Production had
 * no caller, but its export invited a SECOND branch authority next to
 * {@link resolveRole} — exactly the drift that left route.ts missing
 * `dispatches.branchSessionId`. Callers use `resolveRole(store, agent).role`
 * directly (route.ts, panel badge, dispatch, guard).
 */

/** Whether a tool call is a profile mutation through the host plugin manager. */
export function isPluginManagementMutation(toolName: string, args: unknown): boolean {
  if (toolName !== 'plugin_manager') return false
  const action = typeof args === 'object' && args !== null
    ? String((args as Record<string, unknown>).action ?? '')
    : ''
  // A missing/unreadable action is treated as a mutation: the host tool would
  // reject it anyway, and fail-closed is the correct default for reload entry.
  return !PLUGIN_MANAGEMENT_PURE_ACTIONS.has(action)
}

/**
 * The pure, TOTAL guard decision.
 *
 * @param store - durable plugin store (undefined until the domain opens).
 * @param agent - the Agent on whose behalf the call runs.
 * @param toolName - the model-facing tool name.
 * @param args - parsed tool arguments.
 * @param warn - optional warning sink (a store/role/policy failure is logged,
 *   never silent). The decision still returns: plugin_manager stays denied,
 *   every other tool stays allowed.
 * @returns a structured denial, or undefined to allow the call.
 */
export function roleGuardDecision(
  store: Store | undefined,
  agent: unknown,
  toolName: string,
  args: unknown,
  warn?: (message: string) => void,
): RoleGuardDenial | undefined {
  if (!store) return undefined
  let role: SessionRole = 'other'
  try {
    const resolution = resolveRole(store, agent)
    role = resolution.role
    // A degraded resolution (a table read failed inside resolveRole) is silent
    // otherwise: report it once per decision so the failure is diagnosable.
    if (resolution.reason === 'resolution-error') {
      warn?.('supermemory: role guard resolution failed (store read); ordinary tools stay allowed, plugin_manager stays denied')
    }
  } catch (error) {
    // resolveRole is already defensive; this is the belt-and-braces path. A
    // throw here must NOT fail every tool: keep the reload gate closed and let
    // ordinary work continue.
    try {
      warn?.('supermemory: role guard resolution failed; plugin_manager stays denied, other tools allowed: '
        + String(error).slice(0, 160))
    } catch { /* a broken logger must not break the guard */ }
    return isPluginManagementMutation(toolName, args)
      ? guardDenial(NON_HUB_RELOAD_DENIED, 'NON_HUB_RELOAD_DENIED')
      : undefined
  }
  // R55 需求①②: capability division of labour. Decided BEFORE the generic
  // allowlist on purpose: the allowlist wording tells a hub to tick a panel
  // checkbox, but no checkbox may let a hub RUN a capability — the corrective
  // instruction is "dispatch it to a branch". The knowledge face is read-only
  // routing and only hub/branch sessions get it.
  if (toolName === CAPABILITY_DOC_TOOL) {
    if (role !== 'hub' && role !== 'branch') {
      return guardDenial(CAPABILITY_DOC_ROLE_DENIED, 'CAPABILITY_DOC_ROLE_DENIED')
    }
    return undefined
  }
  if (role === 'hub' && isCapabilityExecutionTool(toolName)) {
    return guardDenial(hubCapabilityExecDenied(toolName), 'HUB_CAPABILITY_EXEC_DENIED')
  }
  if (toolName === 'plugin_manager' && isPluginManagementMutation(toolName, args)) {
    if (role === 'branch') return guardDenial(BRANCH_RELOAD_DENIED, 'BRANCH_RELOAD_DENIED')
    if (role !== 'hub') return guardDenial(NON_HUB_RELOAD_DENIED, 'NON_HUB_RELOAD_DENIED')
    // R36 需求①: a hub passes the reload rule but is still subject to the
    // whitelist — `plugin_manager` ships ON the default list and the panel can
    // switch it off (with the consequence spelled out), so the decision falls
    // through to the whitelist check below instead of returning early.
  }
  if (role === 'hub') {
    // R36 需求①: whitelist, default deny. The policy read never throws and
    // degrades to the built-in default (warning through `warn`), so a missing
    // row keeps the dispatch link alive and an unreadable store cannot widen
    // the hub's reach to "everything".
    const policy = readHubPolicy(store, agentWorkspaceKey(agent), warn)
    if (!isHubAllowedTool(toolName, policy)) {
      return guardDenial(hubToolNotAllowed(toolName), 'HUB_TOOL_NOT_IN_ALLOWLIST')
    }
  }
  return undefined
}
