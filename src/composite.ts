/**
 * Composite tools (P3 / §2.3): repeated tool sequences become ONE call.
 *
 * The maintenance loop counts tool-call sequence signatures; past the
 * threshold the plugin PROPOSES固化 at the next user interaction (never
 * interrupting). On confirmation the sequence is compiled into a composite
 * tool whose varying arguments become parameters, registered through the
 * host's `defineTool` and persisted in the `tool_memory` table — so a restart
 * rebuilds the registration from durable JSON.
 *
 * Nested dispatch reuses `ctx.tools.execute`, so member calls keep the full
 * pre/post-execute policy chain, guards and durable tool/result events.
 *
 * R22 能力（capability）：同一张表也承载"固化的能力"——入口命令 + 文档 +
 * 适用范围 + 路由描述 + 可一键执行（见文末 capability 区）。序列回答"按什么
 * 顺序调哪些工具"，能力回答"这件事现在怎么做"，由 memory_toolize register
 * 录入、rebuildComposites 重建、管理台一键执行（默认预演，写操作二次确认）。
 * @module supermemory/composite
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type * as Tools from '@deepseek-ai/dsh-tools'
import { loadHostModule } from './host.ts'
import type { Signal, ToolMemory } from './schema.ts'
import { deriveTitle, normalizeTags } from './retrieval.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'
import { BUILTIN_CAPABILITIES } from './builtin-capabilities.ts'
import { CAPABILITY_ROUTING_RULES } from './route.ts'

/** One recorded step of a repeated sequence. */
export interface SequenceSample {
  /** tool name per step, in order */
  tools: string[]
  /** per-step arguments as recorded */
  args: Array<Record<string, unknown>>
}

/**
 * 形态：'sequence'（缺省，旧记录）= 编译出的工具序列；'capability' = 固化的
 * "能力"——入口命令 + 文档 + 适用范围 + 路由描述 + 可一键执行。二者共用一张
 * tool_memory 表（kind='composite'），域 schema 不变，重启后由
 * rebuildComposites 一并重建注册。
 */
export type CompositeKind = 'sequence' | 'capability'

export interface CompositeSpec {
  name: string
  /** 'sequence'（缺省）= 工具序列；'capability' = 一键执行的能力。 */
  kind?: CompositeKind
  /** Human title (R10): the retrieval index, rendered above the description. */
  title?: string
  /** Tags (R10): short labels, typically the distinct tool names of the flow. */
  tags?: string[]
  description: string
  steps: Array<{ tool: string; arguments: Record<string, unknown> }>
  /** parameter name → step index + argument key */
  parameters: Array<{ name: string; step: number; key: string; description: string }>
  // ---- 以下仅 kind='capability' 生效（sequence 记录忽略）----
  /** 入口命令，如 "pnpm git:sync"（在 scope 目录内经 shell 执行）。 */
  entry?: string
  /** 文档路径（相对仓库根），如 "docs/git-sync.md"。 */
  doc?: string
  /** 适用范围：入口命令的执行目录，如 "F:\10-SuperMemory"（通常是本仓库根；内置能力由插件位置推导）。 */
  scope?: string
  /** 是否允许执行；false = 只作路由/文档存在，不执行。缺省 true。 */
  runnable?: boolean
  /** 预演参数，如 "--dry-run"：定义后默认预演执行。 */
  dryRunArg?: string
  /** true = 真实执行可能写远端/改状态，必须显式 confirm=true。 */
  writeConfirm?: boolean
  /** 路由描述：何时优先用本能力，并入模型可见的工具描述。 */
  routeNote?: string
  // ---- 维护元数据（R26 持续维护）：版本 / 变更说明 / 使用统计 ----
  /** 定义版本：memory_toolize register 同名更新 +1；内置升级以它判定新旧。 */
  version?: number
  /** 最近一次维护时间（register 更新 / 内置升级时刷新）。 */
  updatedAt?: number
  /** 变更说明（最新在前，最多 CAP_CHANGELOG_MAX 条）。 */
  changelog?: string[]
  /** 使用统计（仅 kind='capability'）：行级 useCount 之外的成败明细。 */
  usage?: CapabilityUsage
}

/**
 * 能力使用统计（R26）：每次执行（预演/实跑/失败都计；needs-confirm 不计）累加。
 * useCount 与行级字段保持一致（面板/控制台/memory_toolize 直读行级值），成败
 * 分列与连续失败是持续维护信号——refresh-builtin 健康报告的数据源。
 */
export interface CapabilityUsage {
  useCount: number
  successCount: number
  failCount: number
  consecutiveFailures: number
  lastUsedAt?: number
  lastStatus?: 'completed' | 'failed'
  lastDryRun?: boolean
  lastExitCode?: number
  lastSummary?: string
}

/** changelog 上限：最新在前，超出丢弃最旧的（register 更新与内置升级共用）。 */
const CAP_CHANGELOG_MAX = 20

/** A capability spec with its fields narrowed (kind is always 'capability'). */
export type CapabilitySpec = CompositeSpec & { kind: 'capability'; entry: string }

/** Signature key for one tool sequence. */
export function sequenceKey(workspaceKey: string, tools: string[]): string {
  return `ws/${workspaceKey}/seq/${tools.join('>')}`
}

/** Parse one recorded arguments value (events may carry a JSON string). */
export function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Compile a composite spec from a signal's recorded samples: steps come from
 * the latest sample; parameters are the scalar arguments that varied.
 */
export function compileComposite(signal: Signal, samples: SequenceSample[]): CompositeSpec {
  const latest = samples[samples.length - 1] ?? { tools: [], args: [] }
  const steps = latest.tools.map((tool, index) => ({ tool, arguments: parseArgs(latest.args[index]) }))
  const parameters: CompositeSpec['parameters'] = []
  steps.forEach((step, stepIndex) => {
    for (const [key, value] of Object.entries(step.arguments)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
      const varied = samples.some((sample) => {
        const other = parseArgs(sample.args[stepIndex])[key]
        return other !== undefined && other !== value
      })
      if (varied) {
        parameters.push({
          name: `p${stepIndex}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_'),
          step: stepIndex,
          key,
          description: `${step.tool} 的 ${key}`,
        })
      }
    }
  })
  const name = `sm_composite_${signal.pattern.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 24) || 'seq'}`
  // R10: title + tags are the retrieval index (steps are the body); tags are
  // the distinct tool names of the flow, so "which composite runs bash+read?"
  // is answerable without scanning every description.
  const title = deriveTitle(`组合工具：${latest.tools.join(' → ')}`, name)
  const tags = normalizeTags([...new Set(latest.tools)])
  return {
    name, title, tags,
    description: `组合工具：${latest.tools.join(' → ')}（由重复流程 ${signal.count} 次后固化）`,
    steps, parameters,
  }
}

/** Live composite registrations: spec name -> disposer (for edit/re-register). */
const liveComposites = new Map<string, () => void>()

/** Names of currently registered composite tools (for panel liveness). */
export const liveCompositeSpecs = new Set<string>()

/**
 * Increment one composite's durable use counter (matched by spec name).
 *
 * R26 使用统计：能力每次执行都落库——预演（dry-run）与真实执行都算，执行失败
 * （非零退出/启动失败）也计；needs-confirm 没有执行，调用方不会进来。明细写进
 * spec.usage（成败分列、连续失败、lastUsedAt、最近一次结果），行级 useCount 同步
 * +1（面板/控制台/memory_toolize 直读它）。传入 result 时记明细；不传（旧调用点：
 * 面板/控制台）只计总数。返回 Promise 供测试等待；内部 catch 保证计数写库失败
 * 永远不会让一次本来成功的执行失败。
 */
export function bumpCompositeUse(store: Store, name: string, result?: CapabilityRunResult): Promise<void> {
  for (const [id, record] of store.toolMemory.entries()) {
    if (record.kind !== 'composite' || !record.entry) continue
    let spec: CompositeSpec
    try {
      spec = JSON.parse(record.entry) as CompositeSpec
    } catch {
      continue
    }
    if (spec.name !== name) continue
    const useCount = (Number(record.useCount) || 0) + 1
    let entry = record.entry
    if (spec.kind === 'capability') {
      entry = JSON.stringify({ ...spec, usage: mergeCapabilityUsage(spec.usage, record.useCount, result) })
    }
    return store.toolMemory.update(id, (r) => ({ ...r, useCount, entry }))
      .catch(() => { /* counter is advisory */ })
  }
  return Promise.resolve()
}

/**
 * Merge one run outcome into the durable usage stats (pure).
 * result 缺省（旧调用点）只计总数，不动成败明细；连续失败在成功后归零。
 */
export function mergeCapabilityUsage(
  previous: CapabilityUsage | undefined,
  rowUseCount: number | undefined,
  result?: CapabilityRunResult,
): CapabilityUsage {
  const base: CapabilityUsage = previous ?? {
    useCount: Number(rowUseCount) || 0,
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
  }
  const succeeded = result ? result.status === 'completed' : undefined
  return {
    ...base,
    useCount: base.useCount + 1,
    successCount: succeeded === true ? base.successCount + 1 : base.successCount,
    failCount: succeeded === false ? base.failCount + 1 : base.failCount,
    consecutiveFailures: succeeded === undefined
      ? base.consecutiveFailures
      : (succeeded ? 0 : base.consecutiveFailures + 1),
    lastUsedAt: Date.now(),
    ...(result && result.status !== 'needs-confirm'
      ? {
        lastStatus: result.status === 'completed' ? 'completed' as const : 'failed' as const,
        lastDryRun: result.dryRun,
        ...(typeof result.exitCode === 'number' ? { lastExitCode: result.exitCode } : {}),
        ...(result.summary ? { lastSummary: result.summary.slice(0, 200) } : {}),
      }
      : {}),
  }
}

/** Register one composite tool; returns its disposer. */
export async function registerComposite(ctx: Context, store: Store, spec: CompositeSpec, workspaceKey?: string): Promise<() => void> {
  // Two signals can normalise to the same composite name, and a restart rebuild
  // re-registers every durable definition: dispose the previous handle first so
  // a re-registration replaces instead of leaking the old one.
  const previous = liveComposites.get(spec.name)
  if (previous) {
    try { previous() } catch { /* the old registration may already be gone */ }
    liveComposites.delete(spec.name)
    liveCompositeSpecs.delete(spec.name)
  }
  const tools = await loadHostModule('@deepseek-ai/dsh-tools') as typeof Tools
  // 能力（capability）不是工具序列，而是一键执行的入口命令：注册成带
  // dryRun/confirm 语义的模型可见工具（定义见文末 capability 区）。
  if (spec.kind === 'capability' && spec.entry) {
    // 上面已守卫 kind/entry；TS 不会把窄化结果应用到整个对象，这里显式收窄。
    // 定义对象在函数内构造会加宽字面量类型（type: 'object' → string），与序列路径
    // 一样用 as never 交给 defineTool；语义由 output schema 的文字描述保证。
    const capSpec = spec as CapabilitySpec
    const disposer = ctx.tools.register(tools.defineTool(capabilityToolDef(store, capSpec, workspaceKey) as never))
    liveComposites.set(spec.name, disposer)
    liveCompositeSpecs.add(spec.name)
    return disposer
  }
  // normalise legacy records (arguments persisted as JSON strings)
  const steps = spec.steps.map((step) => ({ tool: step.tool, arguments: parseArgs(step.arguments) }))
  const properties: Record<string, unknown> = {}
  for (const parameter of spec.parameters) {
    properties[parameter.name] = { type: 'string', description: parameter.description }
  }
  const disposer = ctx.tools.register(tools.defineTool({
    name: spec.name,
    description: spec.description + '（一次调用完成整个确定性子序列）',
    parameters: properties as never,
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['completed', 'failed'], required: true },
          steps: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String((value as { summary?: string }).summary ?? '') }],
    },
    async execute(args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: unknown; toolSet?: unknown }) {
      const texts: string[] = []
      let completed = 0
      for (const [index, step] of steps.entries()) {
        const arguments_ = { ...step.arguments }
        for (const parameter of spec.parameters) {
          if (parameter.step !== index) continue
          const override = args[parameter.name]
          if (override !== undefined) arguments_[parameter.key] = override
        }
        try {
          const batch = await (ctx.tools as unknown as {
            execute(input: {
              calls: Array<{ callId: string; name: string; arguments: unknown }>
              signal: AbortSignal
              agent?: unknown
              toolSet?: unknown
            }): Promise<{ results: Array<{ isError?: boolean; content?: Array<{ type: string; text?: string }>; value?: unknown }> }>
          }).execute({
            calls: [{ callId: `${spec.name}:${index}`, name: step.tool, arguments: arguments_ }],
            signal: exec.signal,
            ...(exec.agent ? { agent: exec.agent } : {}),
            ...(exec.toolSet !== undefined ? { toolSet: exec.toolSet } : {}),
          })
          const result = batch.results[0]
          if (result?.isError) {
            return { status: 'failed' as const, steps: completed, summary: `第 ${index + 1} 步 ${step.tool} 失败：${result.content?.map((c) => c.text ?? '').join('') || '未知错误'}` }
          }
          completed++
          texts.push(`${step.tool} ✓`)
        } catch (error) {
          return { status: 'failed' as const, steps: completed, summary: `第 ${index + 1} 步 ${step.tool} 异常：${String(error).slice(0, 160)}` }
        }
      }
      // Usage is durable (panel + /memory tools surface it); best-effort so a
      // counter write can never fail an otherwise successful composite run.
      bumpCompositeUse(store, spec.name)
      return { status: 'completed' as const, steps: completed, summary: `${spec.description}：${texts.join('，')}` }
    },
  }))
  liveComposites.set(spec.name, disposer)
  liveCompositeSpecs.add(spec.name)
  return disposer
}

/** Persist a composite spec into tool_memory (durable definition JSON). */
export async function persistComposite(store: Store, spec: CompositeSpec, signalKey: string, workspaceKey?: string): Promise<string> {
  const id = newId('tm')
  const record: ToolMemory = {
    kind: 'composite',
    // 能力按适用范围落到工作区（控制台只在本工作区展示它）；序列记录保持全局。
    ...(workspaceKey ? { workspaceKey } : {}),
    title: spec.title ?? deriveTitle(spec.description, spec.name),
    tags: normalizeTags(spec.tags ?? spec.name),
    trigger: signalKey,
    description: spec.description,
    entry: JSON.stringify(spec),
    useCount: 0,
    status: 'active',
  }
  await store.toolMemory.put(id, record)
  return id
}

/** Rebuild-register every active composite from durable JSON (P3 restart). */
export async function rebuildComposites(
  ctx: Context,
  store: Store,
  // 注入缝：无宿主注册器（测试/headless）时用假 register 也能验证重建拾取。
  deps?: {
    register?: (ctx: Context, store: Store, spec: CompositeSpec) => Promise<() => void>
    logger?: { info: (msg: string) => void }
  },
): Promise<number> {
  const register = deps?.register ?? registerComposite
  // R26: 内置能力先与 store 合并（缺失播种/旧版升级/现场保留），随后统一注册。
  try {
    const merged = await mergeBuiltinCapabilities(store)
    if (merged.seeded.length > 0 || merged.upgraded.length > 0) {
      deps?.logger?.info('supermemory: builtin capabilities merged — seeded ' + merged.seeded.join(',')
        + '; upgraded ' + merged.upgraded.join(','))
    }
  } catch { /* 合并失败不阻塞启动：持久行照常重建 */ }
  let registered = 0
  for (const [, record] of [...store.toolMemory.entries()]) {
    if (record.kind !== 'composite' || record.status !== 'active' || !record.entry) continue
    try {
      const spec = JSON.parse(record.entry) as CompositeSpec
      // A3: 行级工作区归属随注册传入，能力工具据此做跨工作区门禁。
      await register(ctx, store, spec, record.workspaceKey)
      registered++
    } catch { /* a broken definition is skipped, never blocks boot */ }
  }
  return registered
}

/**
 * R6: edit one composite tool in place. Applies the patch to the durable
 * definition, re-registers the tool (so the model sees the new description
 * and behaviour immediately) and persists the change. The tool NAME is
 * stable — renaming a registered tool is not supported.
 */
export async function editCompositeTool(
  ctx: Context,
  store: Store,
  id: string,
  patch: {
    title?: string
    tags?: string[]
    description?: string
    steps?: Array<{ tool: string; arguments: Record<string, unknown> }>
    parameters?: Array<{ name: string; step: number; key: string; description: string }>
    status?: string
    // ---- 能力字段（kind='capability' 时生效）----
    entry?: string
    doc?: string
    scope?: string
    runnable?: boolean
    dryRunArg?: string
    writeConfirm?: boolean
    routeNote?: string
  },
): Promise<{ status: 'ok' | 'error'; message: string; id?: string }> {
  const record = store.toolMemory.get(id)
  if (!record || record.kind !== 'composite') {
    return { status: 'error', message: '组合工具不存在。' }
  }
  let spec: CompositeSpec
  try {
    spec = JSON.parse(record.entry) as CompositeSpec
  } catch {
    return { status: 'error', message: '工具定义损坏，无法编辑。' }
  }
  if (!spec) {
    return { status: 'error', message: '工具定义损坏，无法编辑。' }
  }
  // 能力用入口命令替代步骤：两套校验互斥。
  if (spec.kind === 'capability') {
    if (!spec.entry) return { status: 'error', message: '能力定义缺少入口命令，无法编辑。' }
  } else if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    return { status: 'error', message: '工具定义缺少步骤，无法编辑。' }
  }
  const next: CompositeSpec = {
    ...spec,
    ...(patch.title !== undefined ? { title: String(patch.title).slice(0, 80) } : {}),
    ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
    ...(patch.description !== undefined ? { description: String(patch.description).slice(0, 500) } : {}),
    ...(patch.entry !== undefined ? { entry: String(patch.entry).slice(0, 300) } : {}),
    ...(patch.doc !== undefined ? { doc: String(patch.doc).slice(0, 300) } : {}),
    ...(patch.scope !== undefined ? { scope: String(patch.scope).slice(0, 300) } : {}),
    ...(patch.runnable !== undefined ? { runnable: Boolean(patch.runnable) } : {}),
    ...(patch.dryRunArg !== undefined ? { dryRunArg: String(patch.dryRunArg).slice(0, 80) } : {}),
    ...(patch.writeConfirm !== undefined ? { writeConfirm: Boolean(patch.writeConfirm) } : {}),
    ...(patch.routeNote !== undefined ? { routeNote: String(patch.routeNote).slice(0, 500) } : {}),
    ...(patch.steps !== undefined
      ? { steps: patch.steps.map((step) => ({ tool: String(step.tool ?? ''), arguments: parseArgs(step.arguments ?? {}) })) }
      : {}),
    ...(patch.parameters !== undefined
      ? { parameters: patch.parameters.map((p) => ({ name: String(p.name ?? ''), step: Number(p.step) || 0, key: String(p.key ?? ''), description: String(p.description ?? '') })) }
      : {}),
  }
  if (next.kind !== 'capability' && (next.steps.length === 0 || next.steps.some((step) => !step.tool))) {
    return { status: 'error', message: '步骤不能为空，且每步都需要工具名。' }
  }
  if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'retired') {
    return { status: 'error', message: 'status 仅支持 active / retired。' }
  }
  // retire: unregister and persist without re-registering
  if (patch.status === 'retired') {
    const dispose = liveComposites.get(next.name)
    if (dispose) { try { dispose() } catch { /* best-effort */ } }
    liveComposites.delete(next.name)
    liveCompositeSpecs.delete(next.name)
    await store.toolMemory.update(id, (r) => ({ ...r, status: 'retired', description: next.description, entry: JSON.stringify(next), ...(next.title !== undefined ? { title: next.title } : {}), ...(next.tags !== undefined ? { tags: next.tags } : {}) }))
    return { status: 'ok', message: `已停用${next.kind === 'capability' ? '能力' : '组合工具'} ${next.name}（重启后不会重新注册）。`, id }
  }
  try {
    const previous = liveComposites.get(next.name)
    if (previous) { try { previous() } catch { /* best-effort */ } }
    liveComposites.delete(next.name)
    liveCompositeSpecs.delete(next.name)
    // A3: 行级工作区归属随行传入，编辑后重注册不丢跨工作区门禁。
    const dispose = await registerComposite(ctx, store, next, record.workspaceKey)
    liveComposites.set(next.name, dispose)
    liveCompositeSpecs.add(next.name)
  } catch (error) {
    return { status: 'error', message: `重新注册失败：${String(error).slice(0, 200)}` }
  }
  await store.toolMemory.update(id, (r) => ({
    ...r,
    title: next.title ?? r.title,
    tags: next.tags ?? r.tags,
    description: next.description,
    entry: JSON.stringify(next),
    status: 'active',
  }))
  return { status: 'ok', message: `已更新${next.kind === 'capability' ? '能力' : '组合工具'} ${next.name}。`, id }
}

/**
 * R6+: delete one composite tool for good. Unregisters the live tool when it
 * is registered, drops the durable definition, and drops the sequence signal
 * that created it — so the same flow must cross the threshold AGAIN before a
 * new composite may be registered (a delete is not a silent retire).
 */
export async function deleteCompositeTool(
  ctx: Context,
  store: Store,
  id: string,
): Promise<{ status: 'ok' | 'error'; message: string; id?: string }> {
  const record = store.toolMemory.get(id)
  if (!record || record.kind !== 'composite') {
    return { status: 'error', message: '组合工具不存在。' }
  }
  let name = id
  try {
    name = (JSON.parse(record.entry) as CompositeSpec).name ?? id
  } catch {
    // a broken definition still unregisters under its row id fallback
  }
  const dispose = liveComposites.get(name)
  if (dispose) { try { dispose() } catch { /* best-effort */ } }
  liveComposites.delete(name)
  liveCompositeSpecs.delete(name)
  await store.toolMemory.delete(id)
  if (record.trigger) {
    try { await store.signals.delete(record.trigger) } catch { /* the signal row is advisory */ }
  }
  return { status: 'ok', message: `已删除组合工具 ${name}。`, id }
}

/**
 * Composite near-miss hints moved to src/activity.ts: tools/post-execute can
 * carry additionalContexts for the next request, tools/pre-execute cannot.
 */

// ---------------------------------------------------------------------------
// 能力（capability）：把高频事务固化成「入口命令 + 文档 + 适用范围 + 路由描述 +
// 可一键执行」的受管对象。序列组合工具回答"哪些工具按什么顺序跑"，能力回答
// "这件事现在怎么做"——一条入口命令、一份文档、一个适用范围目录、一段路由描述。
//
// 执行走 node:child_process（shell），环境继承、默认 120s 超时；默认预演
// （dryRunArg），真实写操作必须显式 confirm=true。持久化仍走 tool_memory
// （kind='composite' + spec.kind='capability'），rebuildComposites 重启重建。
// ---------------------------------------------------------------------------

/** Register input of one capability (memory_toolize register / webui tool/register). */
export interface CapabilityInput {
  /** 逻辑名，如 git-sync-supermemory；工具名派生为 sm_composite_<name>。 */
  name: string
  title?: string
  description: string
  /** 入口命令，如 "pnpm git:sync"。 */
  entry: string
  doc?: string
  scope?: string
  runnable?: boolean
  dryRunArg?: string
  writeConfirm?: boolean
  tags?: string[]
  routeNote?: string
  /** register 同名更新时的一行变更说明（写入 changelog，最新在前）。 */
  changelog?: string
}

/** 合法逻辑名：字母/数字/-/_，≤41 字符（工具名再派生 sm_composite_ 前缀）。 */
export function isValidCapabilityName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(name)
}

/** 逻辑名 → 注册工具名（沿用 sm_composite_ 命名约定）。 */
export function capabilityToolName(name: string): string {
  const slug = String(name).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return 'sm_composite_' + (slug || 'capability')
}

/**
 * Build + validate one capability spec (pure: no host, no IO).
 * 入参刻意不含 changelog：本函数不读它（changelog 由 register/内置合并各自记账），
 * 这样 BuiltinCapability（changelog: string[] 版本史）也能直接传入。
 */
export function buildCapabilitySpec(input: Omit<CapabilityInput, 'changelog'>): { status: 'ok'; spec: CapabilitySpec } | { status: 'error'; message: string } {
  const name = String(input.name ?? '').trim()
  if (!isValidCapabilityName(name)) {
    return { status: 'error', message: '能力名称只能包含字母/数字/-/_（≤41 字符）且以字母或数字开头。' }
  }
  const entry = String(input.entry ?? '').trim()
  if (!entry) return { status: 'error', message: '入口命令（entry）不能为空。' }
  if (entry.length > 300) return { status: 'error', message: '入口命令过长（≤300 字符）。' }
  const description = String(input.description ?? '').trim()
  if (!description) return { status: 'error', message: '描述不能为空（模型靠它路由到本能力）。' }
  if (description.length > 500) return { status: 'error', message: '描述过长（≤500 字符）。' }
  const toolName = capabilityToolName(name)
  const spec: CapabilitySpec = {
    name: toolName,
    kind: 'capability',
    title: String(input.title ?? '').trim().slice(0, 80) || deriveTitle(description, toolName),
    tags: normalizeTags(input.tags ?? [name]),
    description,
    // 能力不是序列：steps/parameters 恒为空（toolize 的前缀匹配/上限因此自动排除它）。
    steps: [],
    parameters: [],
    entry,
    runnable: input.runnable === undefined ? true : Boolean(input.runnable),
    ...(String(input.doc ?? '').trim() ? { doc: String(input.doc).trim().slice(0, 300) } : {}),
    ...(String(input.scope ?? '').trim() ? { scope: String(input.scope).trim().slice(0, 300) } : {}),
    ...(String(input.dryRunArg ?? '').trim() ? { dryRunArg: String(input.dryRunArg).trim().slice(0, 80) } : {}),
    ...(input.writeConfirm !== undefined ? { writeConfirm: Boolean(input.writeConfirm) } : {}),
    ...(String(input.routeNote ?? '').trim() ? { routeNote: String(input.routeNote).trim().slice(0, 500) } : {}),
  }
  return { status: 'ok', spec }
}

/**
 * 调用方会话的工作区 key（宿主 exec.agent.session.header.cwd）。
 * 取不到返回 undefined——没有工作区事实时不做隔离判定（测试/headless 放行）。
 */
function callerWorkspaceKey(exec: { agent?: unknown }): string | undefined {
  const cwd = (exec.agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd
  if (!cwd || typeof cwd !== 'string') return undefined
  try {
    return workspaceKeyOf(cwd)
  } catch {
    return undefined
  }
}

/**
 * 能力是否适用于某个工作区（A3 工作区隔离的单一判定）：
 * - 行级归属（tool_memory.workspaceKey）优先；
 * - 无行级归属时用 spec.scope 推导；
 * - 两者都没有 = 全局能力（旧数据/无 scope 的注册），任何工作区适用。
 */
export function capabilityAppliesToWorkspace(
  spec: Pick<CapabilitySpec, 'scope'>,
  callerWorkspace: string | undefined,
  rowWorkspaceKey?: string,
): boolean {
  if (!callerWorkspace) return true
  const own = rowWorkspaceKey || (spec.scope ? workspaceKeyOf(spec.scope) : undefined)
  if (!own) return true
  return own === callerWorkspace
}

/** One capability execution result (tool output and the webui endpoint share it). */
export interface CapabilityRunResult {
  status: 'completed' | 'failed' | 'needs-confirm'
  exitCode?: number
  stdout: string
  stderr: string
  durationMs: number
  dryRun: boolean
  command: string
  summary: string
}

/** 输出截断：工具结果/HTTP 响应都不该无上限增长。 */
const CAP_OUTPUT_CLIP = 8000
/** 默认超时：同步子进程，120s 足够一次同步/构建类命令。 */
const CAP_TIMEOUT_MS = 120000

function clipCapOutput(text: string): string {
  return text.length > CAP_OUTPUT_CLIP
    ? text.slice(0, CAP_OUTPUT_CLIP) + `\n…（输出过长已截断，原 ${text.length} 字符）`
    : text
}

/** PATH 分隔符与键名（Windows 上 env 里可能是 `Path`）。 */
const PATH_SEP = process.platform === 'win32' ? ';' : ':'

/**
 * 能力执行环境的 PATH 兜底（R27）。
 *
 * 子进程继承 `process.env`，但桌面宿主/服务启动方式的差异会让 PATH 缺少 node 或
 * pnpm 所在目录（注册表 PATH 里通常有 `%APPDATA%\npm`、`%ProgramFiles%\nodejs`）。
 * 这里把「确实存在」的可执行目录**追加**进 PATH：
 *   - `dirname(process.execPath)`（当前宿主用的 node/Electron 目录）；
 *   - `PNPM_HOME`（pnpm 自己的约定变量）；
 *   - Windows 上再由 `APPDATA/ProgramFiles/LOCALAPPDATA` 推导 npm/nodejs/pnpm 目录。
 * 全部由环境变量与实际存在性推导，不硬编码盘符；原 PATH 顺序保持不变，大小写不敏感
 * 去重。找不到目录时原样返回（不影响调用方）。
 */
export function capabilityExecEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  // Windows 的环境变量名大小写不敏感，保留调用方原有的写法（Path / PATH）；
  // 极端情况下 env 里同时存在 `Path` 与 `PATH`（大小写变体），只留一个，避免
  // 子进程读到哪个不确定。
  const variants = Object.keys(env).filter((name) => name.toLowerCase() === 'path')
  const key = variants[0] ?? 'PATH'
  for (const variant of variants.slice(1)) delete env[variant]
  const parts = String(env[key] ?? '').split(PATH_SEP).map((part) => part.trim()).filter(Boolean)
  const seen = new Set(parts.map((part) => (process.platform === 'win32' ? part.toLowerCase() : part)))
  const candidates: string[] = []
  const add = (dir: string | undefined): void => {
    if (dir && isAbsolute(dir)) candidates.push(dir)
  }
  add(dirname(process.execPath))
  add(env.PNPM_HOME)
  if (process.platform === 'win32') {
    if (env.APPDATA) add(join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'pnpm'))
    if (env.ProgramFiles) add(join(env.ProgramFiles, 'nodejs'))
    if (env['ProgramFiles(x86)']) add(join(env['ProgramFiles(x86)'], 'nodejs'))
  }
  for (const dir of candidates) {
    const dedupe = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(dedupe)) continue
    if (!existsSync(dir)) continue
    seen.add(dedupe)
    parts.push(dir)
  }
  env[key] = parts.join(PATH_SEP)
  return env
}

/**
 * Execute one capability's entry command inside its scope directory.
 *
 * 安全闸：① runnable=false 直接拒绝；② 定义了 dryRunArg 且调用方未显式关闭时
 * 默认预演；③ writeConfirm 能力的真实执行必须 confirm=true，否则返回
 * needs-confirm 且不执行。
 */
export function runCapability(spec: CompositeSpec, options: { dryRun?: boolean; confirm?: boolean } = {}): CapabilityRunResult {
  if (spec.kind !== 'capability' || !spec.entry) {
    return { status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun: false, command: '', summary: '不是可执行的能力定义（缺少 entry）。' }
  }
  if (spec.runnable === false) {
    return { status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun: Boolean(options.dryRun), command: spec.entry, summary: '该能力未开放执行（runnable=false）。' }
  }
  // 预演缺省：定义了 dryRunArg 且调用方既没显式 dryRun 也没 confirm 时，默认预演；
  // confirm=true 的语义就是"确认真实执行"，此时预演缺省让位（否则管理台的"确认执行"
  // 会悄悄变成又一次预演）。
  const dryRun = options.dryRun !== undefined
    ? Boolean(options.dryRun)
    : (options.confirm === true ? false : Boolean(spec.dryRunArg))
  const command = dryRun && spec.dryRunArg ? `${spec.entry} ${spec.dryRunArg}` : spec.entry
  // 写操作能力没定义预演参数时，"预演"无从谈起——拒绝，而不是把真实命令当预演跑掉。
  if (dryRun && spec.writeConfirm && !spec.dryRunArg) {
    return {
      status: 'failed', stdout: '', stderr: '', durationMs: 0, dryRun, command,
      summary: '该能力标记了写操作确认（writeConfirm）但未定义预演参数（dryRunArg），无法预演；确认执行请显式传 confirm=true。',
    }
  }
  if (!dryRun && spec.writeConfirm && options.confirm !== true) {
    return {
      status: 'needs-confirm',
      stdout: '', stderr: '', durationMs: 0, dryRun, command,
      summary: `该能力真实执行可能写远端/改状态（writeConfirm）：确认执行请显式传 confirm=true；只要预演可保持缺省（自动追加 ${spec.dryRunArg ?? '预演参数'}）。`,
    }
  }
  const started = Date.now()
  const child = spawnSync(command, {
    shell: true,
    cwd: spec.scope && spec.scope.trim() ? spec.scope : process.cwd(),
    encoding: 'utf8',
    timeout: CAP_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    // R27: 注入 node/pnpm 目录（见 capabilityExecEnv），能力命令不再依赖宿主继承到的 PATH。
    env: capabilityExecEnv(),
  })
  const durationMs = Date.now() - started
  const stdout = clipCapOutput(String(child.stdout ?? ''))
  const stderr = clipCapOutput(String(child.stderr ?? ''))
  const exitCode = typeof child.status === 'number' ? child.status : undefined
  const failed = Boolean(child.error) || exitCode === undefined
  return {
    status: failed ? 'failed' : (exitCode === 0 ? 'completed' : 'failed'),
    exitCode,
    stdout,
    stderr,
    durationMs,
    dryRun,
    command,
    summary: `${command} → ${child.error ? `启动失败：${String(child.error).slice(0, 120)}` : `exit ${exitCode}`}（${dryRun ? '预演' : '实跑'}，${durationMs}ms）`,
  }
}

/**
 * The model-visible description of one capability (pure; asserted by the
 * capability smoke). Carries the routing note (when to prefer it), the entry
 * command, the dry-run default, the write-confirm rule and the capability
 * routing rules, so the model never has to guess the semantics.
 */
export function capabilityToolDescription(spec: CapabilitySpec): string {
  const semantics = '（能力：在适用范围 ' + (spec.scope || '当前目录') + ' 内执行入口命令 `' + spec.entry + '`；'
    + (spec.dryRunArg ? `默认追加预演参数 ${spec.dryRunArg}（只读不改）；` : '')
    + (spec.writeConfirm ? '真实执行可能写远端/改状态：confirm=true 表示确认真实执行（自动脱离预演缺省）；' : '')
    + (spec.doc ? `详细流程见 ${spec.doc}；` : '')
    + (spec.runnable === false ? '当前未开放执行。' : '')
    + '返回 exitCode/stdout/stderr/durationMs。）'
  return spec.description + (spec.routeNote ? '。' + spec.routeNote : '') + semantics + '\n' + CAPABILITY_ROUTING_RULES
}

/**
 * The model-visible tool definition of one capability. Exported so tests (and
 * headless drivers) can call execute() without a live tool registry.
 *
 * `workspaceKey` = 持久行的工作区归属（undefined=全局能力）：execute 时按调用方
 * 会话的 cwd 判定适用性，跨工作区调用直接拒绝——不执行、不计数（A3 隔离）。
 */
export function capabilityToolDef(store: Store, spec: CapabilitySpec, workspaceKey?: string) {
  return {
    name: spec.name,
    description: capabilityToolDescription(spec),
    parameters: {
      dryRun: { type: 'boolean', description: 'true=强制预演；缺省时若能力定义了预演参数（dryRunArg）则自动预演' },
      confirm: { type: 'boolean', description: '真实执行写操作能力（writeConfirm）时的二次确认，必须为 true' },
    } as never,
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['completed', 'failed', 'needs-confirm'], required: true },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          durationMs: { type: 'integer' },
          dryRun: { type: 'boolean' },
          command: { type: 'string' },
          summary: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { status?: string; summary?: string }
        return [{ type: 'text', text: (v.status === 'needs-confirm' ? '需要确认：' : '') + String(v.summary ?? '') }]
      },
    },
    async execute(args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: unknown; toolSet?: unknown }) {
      // 工作区隔离（A3）：跨工作区调用拒绝执行，也不计使用。
      const callerWorkspace = callerWorkspaceKey(exec)
      if (callerWorkspace && !capabilityAppliesToWorkspace(spec, callerWorkspace, workspaceKey)) {
        const own = workspaceKey || (spec.scope ? workspaceKeyOf(spec.scope) : '')
        return {
          status: 'failed' as const, stdout: '', stderr: '', durationMs: 0, dryRun: false, command: spec.entry,
          summary: `该能力适用于工作区 ${own || '（未知）'}，当前会话工作区是 ${callerWorkspace}：不执行（工作区隔离）。`,
        }
      }
      const result = runCapability(spec, {
        ...(typeof args.dryRun === 'boolean' ? { dryRun: args.dryRun } : {}),
        ...(typeof args.confirm === 'boolean' ? { confirm: args.confirm } : {}),
      })
      // 实际执行过（含非零退出）才计数；needs-confirm 没有执行，不计。
      // R26: 传入 result → 同时落成败分列/连续失败/最近一次结果（维护信号）。
      if (result.status !== 'needs-confirm') void bumpCompositeUse(store, spec.name, result)
      return result
    },
  }
}

/** Seam so tests (and headless hosts) can register a capability without a live tool registry. */
export interface CapabilityDeps {
  register: (ctx: Context, store: Store, spec: CompositeSpec) => Promise<() => void>
  persist: (store: Store, spec: CompositeSpec, key: string, workspaceKey?: string) => Promise<string>
  toolExists: (ctx: Context, name: string) => boolean
}

/** Default seam: the real host registry and the real durable table. */
export function defaultCapabilityDeps(): CapabilityDeps {
  return {
    register: registerComposite,
    persist: persistComposite,
    toolExists: (ctx, name) => Boolean(ctx.tools.get(name)),
  }
}

/** Dispose one live registration by tool name (best-effort; re-register replaces). */
export function disposeComposite(name: string): void {
  const dispose = liveComposites.get(name)
  if (dispose) { try { dispose() } catch { /* the old registration may already be gone */ } }
  liveComposites.delete(name)
  liveCompositeSpecs.delete(name)
}

/**
 * Register one capability: validate → durable-record lookup (same tool name =
 * UPDATE in place, so re-registering the seed is idempotent) → host-tool
 * conflict check (only for NEW names) → register the live tool → persist.
 */
export async function registerCapability(
  ctx: Context,
  store: Store,
  input: CapabilityInput,
  workspaceKey?: string,
  deps?: CapabilityDeps,
): Promise<{ status: 'ok' | 'error'; message: string; id?: string; name?: string }> {
  const built = buildCapabilitySpec(input)
  if (built.status === 'error') return { status: 'error', message: built.message }
  const spec = built.spec
  const seam = deps ?? defaultCapabilityDeps()
  // 先查持久记录：自己注册过的同名能力走更新，不算"被占用"。
  let existingId: string | undefined
  for (const [id, record] of store.toolMemory.entries()) {
    if (record.kind !== 'composite' || !record.entry) continue
    try {
      if ((JSON.parse(record.entry) as CompositeSpec).name !== spec.name) continue
      // A3: 同名行按工作区归属区分——传入 workspaceKey 时只更新本工作区的行，
      // 别的工作区的同名能力不会被误更新（它也不在本工作区暴露）。
      if (workspaceKey && record.workspaceKey && record.workspaceKey !== workspaceKey) continue
      if (workspaceKey && !record.workspaceKey && spec.scope && workspaceKeyOf(spec.scope) !== workspaceKey) continue
      existingId = id
      break
    } catch { /* a broken row never blocks */ }
  }
  if (!existingId) {
    try {
      if (seam.toolExists(ctx, spec.name)) {
        return { status: 'error', message: `工具名 ${spec.name} 已被占用（宿主已有同名工具）。` }
      }
    } catch { /* a host without a tool registry falls through to registration */ }
  }
  // 无宿主注册器（测试/headless）时只落库：重启后 rebuildComposites 会补齐注册。
  const hasRegistry = typeof (ctx as unknown as { tools?: { register?: unknown } }).tools?.register === 'function'
  try {
    if (existingId) {
      // 同名 = 更新（R26 持续维护）：version+1、updatedAt、changelog 追加一行，
      // usage 使用统计原样保留（更新定义不重置计数）。
      let previous: CompositeSpec | undefined
      try {
        previous = JSON.parse(store.toolMemory.get(existingId)?.entry ?? '') as CompositeSpec
      } catch { /* a broken previous definition still updates */ }
      const version = (Number(previous?.version) || 0) + 1
      const changeLine = String(input.changelog ?? '').trim().slice(0, 200)
        || `更新能力定义（入口 ${spec.entry}${spec.doc ? `，文档 ${spec.doc}` : ''}）`
      const changelog = [changeLine, ...(previous?.changelog ?? [])].slice(0, CAP_CHANGELOG_MAX)
      const next: CapabilitySpec = {
        ...spec,
        version,
        updatedAt: Date.now(),
        changelog,
        ...(previous?.usage ? { usage: previous.usage } : {}),
      }
      disposeComposite(next.name)
      if (hasRegistry) await seam.register(ctx, store, next)
      await store.toolMemory.update(existingId, (r) => ({
        ...r,
        title: next.title ?? r.title,
        tags: next.tags ?? r.tags,
        description: next.description,
        entry: JSON.stringify(next),
        ...(workspaceKey ? { workspaceKey } : {}),
      }))
      return { status: 'ok', message: `已更新能力 ${next.name}（v${version}，入口 ${next.entry}）：${changeLine}`, id: existingId, name: next.name }
    }
    // 新注册也从 v1 起记版本：版本是「本地是否有意修改」的唯一信号——内置升级
    // 不覆盖版本 ≥ 内置的行，因此经 register 录入/更新的现场能力不会被内置覆盖。
    const changeLine = String(input.changelog ?? '').trim().slice(0, 200)
      || `注册能力（入口 ${spec.entry}${spec.doc ? `，文档 ${spec.doc}` : ''}）`
    const stamped: CapabilitySpec = {
      ...spec,
      version: 1,
      updatedAt: Date.now(),
      changelog: [changeLine],
    }
    if (hasRegistry) await seam.register(ctx, store, stamped)
    const id = await seam.persist(store, stamped, 'capability/' + stamped.name, workspaceKey)
    return {
      status: 'ok',
      message: hasRegistry
        ? `已注册能力 ${stamped.name}（v1，入口 ${stamped.entry}${stamped.dryRunArg ? `，默认预演 ${stamped.dryRunArg}` : ''}${stamped.writeConfirm ? '，写操作需 confirm=true' : ''}）。`
        : `已保存能力 ${stamped.name}（宿主未提供工具注册器，重启/重载后生效）。`,
      id,
      name: stamped.name,
    }
  } catch (error) {
    return { status: 'error', message: `注册失败：${String(error).slice(0, 200)}` }
  }
}

/** Every durable capability record (broken JSON skipped) — for list surfaces. */
export function capabilityRecordsOf(store: Store, workspaceKey?: string): Array<{ id: string; spec: CapabilitySpec; useCount: number; status: string }> {
  const out: Array<{ id: string; spec: CapabilitySpec; useCount: number; status: string }> = []
  for (const [id, record] of store.toolMemory.entries()) {
    if (record.kind !== 'composite' || !record.entry) continue
    try {
      const spec = JSON.parse(record.entry) as CompositeSpec
      if (spec?.kind !== 'capability' || !spec.entry) continue
      // A3: 只列出适用于当前工作区的能力（行级归属或 scope 推导；全局能力除外）。
      if (!capabilityAppliesToWorkspace(spec, workspaceKey, record.workspaceKey)) continue
      out.push({ id, spec: spec as CapabilitySpec, useCount: record.useCount, status: record.status })
    } catch { /* one broken row never blocks a list */ }
  }
  return out
}

// ---------------------------------------------------------------------------
// R26 内置能力（builtin capabilities）与持续维护：能力定义随插件源码分发
// （src/builtin-capabilities.ts），启动重建时与 store 合并；使用统计与健康
// 报告为大模型提供「能力是否满足新需求」的可读信号。
// ---------------------------------------------------------------------------

/** 内置能力与 store 合并的结果（差异报告）。 */
export interface BuiltinMergeReport {
  /** 现场缺失 → 已播种的工具名。 */
  seeded: string[]
  /** 现场旧于内置 → 已升级的工具名（定义覆盖，使用数据保留）。 */
  upgraded: string[]
  /** 版本一致 → 未动。 */
  current: string[]
  /** 现场新于内置 → 保留现场（本地维护中）。 */
  localNewer: string[]
  /** 本次发生变化的 spec（播种 + 升级）及其工作区归属：调用方据此重新注册。 */
  changed: Array<{ spec: CapabilitySpec; workspaceKey?: string }>
}

/**
 * 把内置能力合并进 store（幂等）：缺失播种、旧版升级、现场版本保留。
 *
 * 升级策略（覆盖而非保留现场定义）：内置定义随插件代码与文档一起发布，旧版
 * 定义本身就是「文档与现状不符」的故障形态；唯一有意的本地修改路径是
 * memory_toolize register（version+1 超过内置），因此版本旧于内置的行不可能是
 * 认真的本地编辑。升级保留 useCount/usage——不丢任何使用数据。
 *
 * 行级归属（workspaceKey）是唯一例外：若它恰好等于「旧 scope 推导出的工作区键」
 * （说明是内置定义自己播种/继承的，不是现场指定），而新定义的 scope 指向别处
 * （v2 起 scope 由插件位置推导，换克隆目录就会变），归属随之迁移；现场显式登记到
 * 其他工作区的行不会被改写。
 *
 * opts.ctx + opts.register 提供时，变化的 spec 立即重新注册（refresh-builtin
 * 运行时刷新用）；rebuildComposites 只做数据合并，注册交给随后的统一循环。
 */
export async function mergeBuiltinCapabilities(
  store: Store,
  opts?: {
    ctx?: Context
    // A3: register 可带行级工作区归属，供能力工具做跨工作区门禁。
    register?: (ctx: Context, store: Store, spec: CompositeSpec, workspaceKey?: string) => Promise<() => void>
  },
): Promise<BuiltinMergeReport> {
  const report: BuiltinMergeReport = { seeded: [], upgraded: [], current: [], localNewer: [], changed: [] }
  for (const builtin of BUILTIN_CAPABILITIES) {
    const toolName = capabilityToolName(builtin.name)
    // 按工具名找行（跨工作区）：现场行可能属于任何 workspaceKey，升级时不改写它。
    let rowId: string | undefined
    let row: ToolMemory | undefined
    for (const [id, record] of store.toolMemory.entries()) {
      if (record.kind !== 'composite' || !record.entry) continue
      try {
        if ((JSON.parse(record.entry) as CompositeSpec).name === toolName) { rowId = id; row = record; break }
      } catch { /* a broken row never blocks */ }
    }
    if (!rowId || !row) {
      const built = buildCapabilitySpec(builtin)
      if (built.status === 'error') continue
      const spec: CapabilitySpec = {
        ...built.spec,
        version: builtin.version,
        ...(builtin.changelog?.length ? { changelog: [...builtin.changelog] } : {}),
      }
      const seedWorkspace = builtin.scope ? workspaceKeyOf(builtin.scope) : undefined
      await persistComposite(store, spec, 'capability/' + toolName, seedWorkspace)
      report.seeded.push(toolName)
      report.changed.push({ spec, workspaceKey: seedWorkspace })
      continue
    }
    let spec: CompositeSpec | undefined
    try {
      spec = JSON.parse(row.entry) as CompositeSpec
    } catch { /* 定义损坏：按旧版处理，用内置修复 */ }
    // 同名的序列组合工具不是这个能力的行：不劫持、不播种。
    if (spec && spec.kind !== 'capability') continue
    const storeVersion = Number(spec?.version) || 0
    if (spec && storeVersion >= builtin.version) {
      if (storeVersion > builtin.version) report.localNewer.push(toolName)
      else report.current.push(toolName)
      continue
    }
    const built = buildCapabilitySpec(builtin)
    if (built.status === 'error') continue
    const next: CapabilitySpec = {
      ...built.spec,
      version: builtin.version,
      updatedAt: Date.now(),
      changelog: [...(builtin.changelog ?? []), ...(spec?.changelog ?? [])].slice(0, CAP_CHANGELOG_MAX),
      // 使用统计保留：升级定义不重置计数；无明细的历史行把行级 useCount 结转。
      usage: spec?.usage ?? {
        useCount: Number(row.useCount) || 0,
        successCount: 0,
        failCount: 0,
        consecutiveFailures: 0,
      },
    }
    // scope 随插件位置变化时（v2 起内置 scope 自动推导）原先由**旧 scope 推导**
    // 出来的行级归属必须跟着搬：否则行仍锁在旧工作区键上，能力在新工作区依旧
    // 不生效——这正是「换克隆目录后能力失效」的另一半原因。
    // 只迁移「继承自旧 scope」的归属；现场显式登记到别的工作区的行保持不动
    // （工作区归属是现场事实），且那种行注册时已 version+1，根本走不到升级分支。
    const previousScopeKey = spec?.scope ? workspaceKeyOf(spec.scope) : undefined
    const nextScopeKey = next.scope ? workspaceKeyOf(next.scope) : undefined
    const inheritedWorkspace = Boolean(row.workspaceKey && previousScopeKey && row.workspaceKey === previousScopeKey)
    const workspaceKey = inheritedWorkspace && nextScopeKey ? nextScopeKey : row.workspaceKey
    await store.toolMemory.update(rowId, (r) => ({
      ...r,
      title: next.title ?? r.title,
      tags: next.tags ?? r.tags,
      description: next.description,
      entry: JSON.stringify(next),
      // 行级归属只在「继承自旧 scope」时随 scope 迁移（见上）；否则不碰。
      ...(workspaceKey !== r.workspaceKey ? { workspaceKey } : {}),
      // status 仍不碰：停用是现场决定。
    }))
    report.upgraded.push(toolName)
    report.changed.push({ spec: next, workspaceKey })
  }
  // 运行时刷新：立即重新注册变化的 spec，模型当场看到新描述/新语义。
  if (opts?.ctx && opts?.register) {
    for (const entry of report.changed) {
      try {
        await opts.register(opts.ctx, store, entry.spec, entry.workspaceKey)
      } catch { /* 注册失败不阻塞刷新：重启时 rebuildComposites 会补 */ }
    }
  }
  return report
}

/** One capability's maintenance snapshot (the "does it still fit?" signals). */
export interface CapabilityHealth {
  id: string
  /** 工具名（sm_composite_*）。 */
  name: string
  title?: string
  entry: string
  doc?: string
  scope?: string
  status: string
  live: boolean
  /** 是否内置能力（定义随插件分发）。 */
  builtin: boolean
  builtinVersion?: number
  version: number
  useCount: number
  successCount: number
  failCount: number
  consecutiveFailures: number
  lastUsedAt?: number
  lastStatus?: 'completed' | 'failed'
  lastDryRun?: boolean
  lastSummary?: string
  /** doc 文件在 scope 内不存在（文档与现状不符）。 */
  docMissing: boolean
  /** scope 目录不存在（换机器/换克隆目录）。 */
  scopeMissing: boolean
  /** 人读维护信号（连续失败/文档缺失/零使用/未注册/版本关系）。 */
  notes: string[]
}

/**
 * Every durable capability's health snapshot — the data behind
 * memory_toolize refresh-builtin. Pure read (existsSync 只读文件系统)。
 */
export function capabilityHealthOf(store: Store, workspaceKey?: string): CapabilityHealth[] {
  const out: CapabilityHealth[] = []
  for (const [id, record] of store.toolMemory.entries()) {
    if (record.kind !== 'composite' || !record.entry) continue
    let spec: CompositeSpec
    try {
      spec = JSON.parse(record.entry) as CompositeSpec
    } catch { continue }
    if (spec?.kind !== 'capability' || !spec.entry) continue
    // A3: 与 capabilityRecordsOf 同一判定——健康报告只覆盖当前工作区适用的能力。
    if (!capabilityAppliesToWorkspace(spec, workspaceKey, record.workspaceKey)) continue
    const usage = spec.usage
    const builtin = BUILTIN_CAPABILITIES.find((b) => capabilityToolName(b.name) === spec.name)
    const version = Number(spec.version) || 0
    const useCount = Number(record.useCount) || 0
    const successCount = usage?.successCount ?? 0
    const failCount = usage?.failCount ?? 0
    const consecutiveFailures = usage?.consecutiveFailures ?? 0
    const scopeMissing = Boolean(spec.scope && !existsSync(spec.scope))
    const docMissing = Boolean(spec.doc && spec.scope && !scopeMissing && !existsSync(join(spec.scope, spec.doc)))
    const notes: string[] = []
    if (consecutiveFailures >= 2) {
      notes.push(`连续失败 ${consecutiveFailures} 次：必须用 memory_toolize register 同名更新能力（或修订 ${spec.doc ?? '文档'}），不要绕过`)
    }
    if (useCount > 0 && successCount === 0 && failCount > 0) notes.push('从未成功执行过：入口命令或适用范围需要修订')
    if (scopeMissing) notes.push(`适用范围目录不存在：${spec.scope}（换机器/换克隆目录时会出现，register 同名更新可修正）`)
    if (docMissing) notes.push(`文档缺失：${spec.doc}（scope 内找不到）——文档与现状不符，必须更新能力`)
    if (useCount === 0) notes.push('零使用：确认路由描述是否说清何时用它，否则更新或停用')
    if (!liveCompositeSpecs.has(spec.name)) notes.push('未注册（重启或 refresh-builtin 后生效）')
    if (builtin && version < builtin.version) notes.push(`现场版本旧于内置 v${builtin.version}：memory_toolize refresh-builtin 可升级`)
    if (builtin && version > builtin.version) notes.push(`现场版本新于内置 v${builtin.version}（本地维护中，内置升级不会覆盖）`)
    out.push({
      id,
      name: spec.name,
      ...(spec.title ? { title: spec.title } : {}),
      entry: spec.entry,
      ...(spec.doc ? { doc: spec.doc } : {}),
      ...(spec.scope ? { scope: spec.scope } : {}),
      status: record.status,
      live: liveCompositeSpecs.has(spec.name),
      builtin: Boolean(builtin),
      ...(builtin ? { builtinVersion: builtin.version } : {}),
      version,
      useCount,
      successCount,
      failCount,
      consecutiveFailures,
      ...(usage?.lastUsedAt !== undefined ? { lastUsedAt: usage.lastUsedAt } : {}),
      ...(usage?.lastStatus ? { lastStatus: usage.lastStatus } : {}),
      ...(usage?.lastDryRun !== undefined ? { lastDryRun: usage.lastDryRun } : {}),
      ...(usage?.lastSummary ? { lastSummary: usage.lastSummary } : {}),
      docMissing,
      scopeMissing,
      notes,
    })
  }
  return out
}
