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
 * @module supermemory/composite
 */
import type { Context } from '@deepseek-ai/cordis'
import type * as Tools from '@deepseek-ai/dsh-tools'
import { loadHostModule } from './host.ts'
import type { Signal, ToolMemory } from './schema.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'

/** One recorded step of a repeated sequence. */
export interface SequenceSample {
  /** tool name per step, in order */
  tools: string[]
  /** per-step arguments as recorded */
  args: Array<Record<string, unknown>>
}

interface CompositeSpec {
  name: string
  description: string
  steps: Array<{ tool: string; arguments: Record<string, unknown> }>
  /** parameter name → step index + argument key */
  parameters: Array<{ name: string; step: number; key: string; description: string }>
}

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
  return { name, description: `组合工具：${latest.tools.join(' → ')}（由重复流程 ${signal.count} 次后固化）`, steps, parameters }
}

/** Register one composite tool; returns its disposer. */
export async function registerComposite(ctx: Context, store: Store, spec: CompositeSpec): Promise<() => void> {
  const tools = await loadHostModule('@deepseek-ai/dsh-tools') as typeof Tools
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
      return { status: 'completed' as const, steps: completed, summary: `${spec.description}：${texts.join('，')}` }
    },
  }))
  return disposer
}

/** Persist a composite spec into tool_memory (durable definition JSON). */
export async function persistComposite(store: Store, spec: CompositeSpec, signalKey: string): Promise<string> {
  const id = newId('tm')
  const record: ToolMemory = {
    kind: 'composite',
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
export async function rebuildComposites(ctx: Context, store: Store): Promise<number> {
  let registered = 0
  for (const [, record] of [...store.toolMemory.entries()]) {
    if (record.kind !== 'composite' || record.status !== 'active' || !record.entry) continue
    try {
      const spec = JSON.parse(record.entry) as CompositeSpec
      await registerComposite(ctx, store, spec)
      registered++
    } catch { /* a broken definition is skipped, never blocks boot */ }
  }
  return registered
}

/**
 * Pre-execute soft hint (§2.3): when the model is about to call the FIRST
 * tool of a known composite by hand, attach a gentle note. Additive only —
 * the waterfall decision is passed through untouched.
 */
export function attachCompositeHint(ctx: Context, store: Store): () => void {
  return ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    try {
      const name = (exec as { name?: string }).name
      if (!name) return decision
      for (const [, record] of store.toolMemory.entries()) {
        if (record.kind !== 'composite' || record.status !== 'active' || !record.entry) continue
        const spec = JSON.parse(record.entry) as CompositeSpec
        if (spec.steps[0]?.tool !== name) continue
        const llm = await loadHostModule('@deepseek-ai/dsh-llm')
        const hint = llm.createUserMessage({
          content: [{ type: 'text', text: `[SuperMemory 提示] 检测到重复流程：可直接调用组合工具 ${spec.name} 一次完成（${spec.steps.map((s) => s.tool).join(' → ')}）。` }],
          source: { kind: 'supermemory', form: 'notice', summary: '组合工具提示' },
        })
        return { ...decision, additionalContexts: [...((decision as { additionalContexts?: unknown[] }).additionalContexts ?? []), hint] } as never
      }
    } catch { /* hints are best-effort */ }
    return decision
  })
}
