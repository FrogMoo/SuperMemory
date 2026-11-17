/**
 * Branch capability profiles (R18, 需求④): the hub declares — BEFORE dispatching —
 * how much the branch may do, and the plugin enforces it through DSH's
 * per-agent tool restriction (`ctx.tools.restrict({ deny })` on the branch's
 * agent scope, from @deepseek-ai/dsh-tools).
 *
 * The deny lists are the durable, script-visible contract: the same profile is
 * written into the branch's first message by `src/script-delegation.ts`, so the
 * model sees the boundary even when a deployment's tool registry cannot be
 * restricted (older host, fake context, unsupported service).
 * @module supermemory/capabilities
 */

/** The four capability profiles `memory_dispatch` accepts. */
export type CapabilityProfile = 'read' | 'read-write' | 'full' | 'minimal'

/** Anything that is not one of the profiles falls back to the default. */
export const DEFAULT_CAPABILITY: CapabilityProfile = 'read-write'

/** Tools a minimal branch keeps (plus every `memory_*` tool). */
export const MINIMAL_ALLOWED: readonly string[] = Object.freeze(['read', 'send_message', 'wait_agent'])

/** A profile resolved to wire/description/deny facts. */
export interface ResolvedCapability {
  profile: CapabilityProfile
  /** Global tool names removed for the branch scope (empty = unrestricted). */
  deny: readonly string[]
  /** Short label used in the dispatch script and receipts. */
  label: string
  /** One-sentence explanation of what the branch may and may not do. */
  description: string
}

/**
 * The static vocabulary. `minimal` denies everything the other profiles deny
 * (an exhaustive deny list is impossible without the live registry, so the
 * restriction step below additionally removes every visible tool that is not
 * on {@link MINIMAL_ALLOWED} or `memory_*`).
 */
export const CAPABILITY_PROFILES: Readonly<Record<CapabilityProfile, ResolvedCapability>> = Object.freeze({
  minimal: Object.freeze({
    profile: 'minimal',
    deny: Object.freeze([
      'write', 'edit', 'apply_patch', 'bash', 'terminal_open', 'terminal_read', 'terminal_close',
      'terminal_signal', 'job_kill', 'job_output', 'job_list', 'memory_dispatch',
      'web_search', 'web_fetch', 'subagent', 'subagent_fork', 'workflow', 'present', 'todo_write',
      'glob', 'grep', 'read_image', 'office_render', 'office_convert', 'office_recalculate',
      'inspect', 'session_search', 'session_trace',
    ]),
    label: '最小（只读文件 + 记忆/汇总）',
    description: '只能 read 文件与调用 memory_* / send_message / wait_agent，不能写文件、不能执行命令、不能继续派发',
  }),
  read: Object.freeze({
    profile: 'read',
    deny: Object.freeze([
      'write', 'edit', 'apply_patch', 'bash', 'terminal_open', 'terminal_read', 'terminal_close',
      'terminal_signal', 'job_kill', 'job_output', 'job_list', 'memory_dispatch',
    ]),
    label: '只读审阅',
    description: '可读文件、检索记忆、汇报结果；不能写文件、不能执行 shell/终端命令、不能继续派发',
  }),
  'read-write': Object.freeze({
    profile: 'read-write',
    deny: Object.freeze([
      'bash', 'apply_patch', 'terminal_open', 'terminal_read', 'terminal_close', 'terminal_signal',
    ]),
    label: '读写代码（无命令）',
    description: '可读改文件（write/edit），不能执行 shell/终端命令；需要跑命令时请让中枢用 full 派发',
  }),
  full: Object.freeze({
    profile: 'full',
    deny: Object.freeze([]),
    label: '完全能力',
    description: '与中枢一致：可读改文件、执行命令（含 shell/终端）',
  }),
})

/**
 * Resolve an untrusted profile name (`memory_dispatch.capabilities`).
 * Unknown/omitted values resolve to the default (`read-write`).
 */
export function resolveCapabilities(name: unknown): ResolvedCapability {
  const raw = typeof name === 'string' ? name.trim().toLowerCase() : ''
  const profile = raw in CAPABILITY_PROFILES ? raw as CapabilityProfile : DEFAULT_CAPABILITY
  return CAPABILITY_PROFILES[profile]
}

/** The structural slice of `ctx.tools` the restriction needs. */
export interface CapabilityTools {
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
  definitions?(scope?: unknown): readonly { name: string }[]
}

/** Outcome of applying one profile to one agent scope (never throws). */
export interface CapabilityApplyResult {
  status: 'applied' | 'unsupported' | 'failed'
  profile: CapabilityProfile
  /** Names actually denied (the intersection with the live registry when known). */
  denied: readonly string[]
  /** Present for `failed`: the caught error text. */
  message?: string
}

/**
 * Recover the names a failed `tools.restrict()` refused.
 *
 * The registry's message names every unknown/scope-local tool in the first
 * segment (`… names unknown global tool "a", "b"; known global tools: …`).
 * Parsing it is preferable to dropping the whole profile: one scope-local name
 * (a preset that registers `bash` itself) would otherwise lift every
 * restriction on the branch.
 */
function refusedNames(message: string): string[] {
  const head = message.split('; known global tools:')[0] ?? ''
  return [...head.matchAll(/"([^"]+)"/g)].map((match) => match[1]).filter(Boolean)
}

/** A tool the minimal profile keeps: `memory_*` plus the explicit allow list. */
function minimalAllowed(name: string): boolean {
  return name.startsWith('memory_') || MINIMAL_ALLOWED.includes(name)
}

/**
 * Restrict one branch agent scope to a profile.
 *
 * DSH's `tools.restrict()` rejects unknown names outright (it validates against
 * the scope's restrictable set), so the static deny list is intersected with the
 * names the live registry reports through `definitions(agent)`. Without that
 * projection the raw list is attempted and a rejection is reported, never
 * thrown: capability degradation must not lose a dispatch that is already
 * recorded.
 *
 * @param tools - `agentCtx.tools` of the branch's creation/resume scope.
 * @param agent - the branch Agent (definitions' viewing scope).
 * @param resolved - profile from {@link resolveCapabilities}.
 * @param logger - warning sink; `applied`/`unsupported` log nothing.
 */
export function applyCapabilities(
  tools: unknown,
  agent: unknown,
  resolved: ResolvedCapability,
  logger?: { warn: (msg: string) => void },
): CapabilityApplyResult {
  if (resolved.deny.length === 0 && resolved.profile === 'full') {
    return { status: 'applied', profile: resolved.profile, denied: [] }
  }
  const service = tools as CapabilityTools | undefined
  if (!service || typeof service.restrict !== 'function') {
    // No tool service on this scope (older host / fake context): the script
    // still states the boundary, so this is a documented degradation.
    return { status: 'unsupported', profile: resolved.profile, denied: [] }
  }
  let known: Set<string> | undefined
  try {
    const rows = typeof service.definitions === 'function' ? service.definitions(agent) : undefined
    if (Array.isArray(rows)) known = new Set(rows.map((row) => String(row?.name ?? '')).filter(Boolean))
  } catch { /* no projection: fall back to the static list */ }
  let deny: string[]
  if (resolved.profile === 'minimal') {
    // "Deny everything except" needs the live inventory; without it the static
    // list still removes every capability the profiles know about.
    deny = known ? [...known].filter((name) => !minimalAllowed(name)) : [...resolved.deny]
  } else {
    deny = known ? resolved.deny.filter((name) => known.has(name)) : [...resolved.deny]
  }
  if (deny.length === 0) {
    return { status: 'applied', profile: resolved.profile, denied: [] }
  }
  try {
    service.restrict({ deny })
    return { status: 'applied', profile: resolved.profile, denied: deny }
  } catch (error) {
    // One bounded retry: remove the names the registry itself refused (a
    // scope-local registration is not restrictable) and keep the rest.
    const refused = new Set(refusedNames(String(error)))
    const retry = deny.filter((name) => !refused.has(name))
    if (refused.size > 0 && retry.length > 0 && retry.length < deny.length) {
      try {
        service.restrict({ deny: retry })
        return { status: 'applied', profile: resolved.profile, denied: retry }
      } catch { /* fall through to the reported failure */ }
    }
    const message = String(error).slice(0, 200)
    logger?.warn(`supermemory: 分支能力限制（${resolved.profile}）未生效：${message}`)
    return { status: 'failed', profile: resolved.profile, denied: [], message }
  }
}
