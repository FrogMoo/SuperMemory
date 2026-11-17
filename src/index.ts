/**
 * SuperMemory — DSH 记忆插件。
 *
 * 实现依据《可行性分析与实现方案.md》v4.2：D1–D8 定稿；P0（事实记忆 + 跨会话
 * recall + 维护循环）+ P1（话题集路由 + 异步派发 + relay 交付 + 模型管理）。
 * 宿主包经 loadHostModule 锚定 `process.argv[1]` 解析（dsh-vscode-mode 实证模式）；
 * Config 用 schemastery；存储走 storageDomain。
 * @module supermemory
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { attachCommands, type CommandsDeps } from './commands.ts'
import { branchHandles, releasableBranches } from './dispatch.ts'
import { attachMaintenance } from './maintenance.ts'
import type { ModelDeps } from './model.ts'
import { attachObserve } from './observe.ts'
import { attachPreStep } from './prestep.ts'
import { loadHostModule } from './host.ts'
import { runReconciliation } from './reconcile.ts'
import { attachRoute, type RouteDeps } from './route.ts'
import type { Signal } from './schema.ts'
import { attachPanel } from './panel.ts'
import { openStore, workspaceKeyOf, type Store } from './store.ts'
import { attachTools, type ToolsDeps } from './tools.ts'
import './services.ts'
import './source.ts'

export const name = 'supermemory'

/** Services this plugin consumes; the fiber stays PENDING until all exist. */
export const inject = [
  'sessions', 'tools', 'storageDomain', 'sessionPersistence',
  'commands', 'systemPrompt', 'userQuestions', 'agents', 'workspaceRegistry',
]

export interface Config {
  enabled: boolean
  recall: {
    maxItems: number
    minScore: number
    halfLifeDays: number
    maxChars: number
    injectStyle: 'gentle' | 'plain'
  }
  route: {
    enabled: boolean
    driftTurns: number
    driftThreshold: number
    confirm: boolean
    llmFallback: boolean
    classifierProvider: string
    classifierModel: string
  }
  dispatch: {
    enabled: boolean
    idleReleaseMs: number
  }
  observe: {
    enabled: boolean
    maxTokensPolicy: 'deliver-partial' | 'fail'
  }
  maintenance: {
    enabled: boolean
    signalsThreshold: number
    summaryEveryTurns: number
  }
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('插件总开关').default(true),
  recall: Schema.object({
    maxItems: Schema.natural().description('recall 注入条数上限').default(5),
    minScore: Schema.natural().description('recall 注入最低分').default(1),
    halfLifeDays: Schema.natural().description('时间衰减半衰期（天）').default(14),
    maxChars: Schema.natural().description('recall 卡片字符上限').default(2400),
    injectStyle: Schema.union([Schema.const('gentle'), Schema.const('plain')])
      .description('注入语气：gentle 温和起步 / plain 直陈').default('gentle'),
  }).description('检索注入参数').default({}),
  route: Schema.object({
    enabled: Schema.boolean().description('话题集路由开关').default(true),
    driftTurns: Schema.natural().description('连续多少轮低重合才重新路由').default(3),
    driftThreshold: Schema.natural().description('重合度阈值（命中 token 数）').default(1),
    confirm: Schema.boolean().description('路由前是否弹确认').default(true),
    llmFallback: Schema.boolean().description('关键词不确定时是否用 LLM 语义匹配（需配置分类器模型）').default(false),
    classifierProvider: Schema.string().description('分类器 provider（llmFallback 开启时必填）').default(''),
    classifierModel: Schema.string().description('分类器模型（llmFallback 开启时必填）').default(''),
  }).description('话题集路由参数').default({}),
  dispatch: Schema.object({
    enabled: Schema.boolean().description('异步派发开关').default(true),
    idleReleaseMs: Schema.natural().description('分支空闲释放毫秒数（D5：释放前确认无未交付 outbox）').default(1800000),
  }).description('派发参数').default({}),
  observe: Schema.object({
    enabled: Schema.boolean().description('分支观察与投递开关').default(true),
    maxTokensPolicy: Schema.union([Schema.const('deliver-partial'), Schema.const('fail')])
      .description('max-tokens 终态处理').default('deliver-partial'),
  }).description('观察投递参数').default({}),
  maintenance: Schema.object({
    enabled: Schema.boolean().description('维护循环开关').default(true),
    signalsThreshold: Schema.natural().description('工具化信号阈值（P3）').default(3),
    summaryEveryTurns: Schema.natural().description('话题集梗概滚动更新间隔（轮）').default(10),
  }).description('维护循环参数').default({}),
}).description('SuperMemory 记忆插件配置').default({})

/**
 * P3: ask about pending tool-ization proposals at the next user turn (§2.3).
 * Additive waterfall: the decision is always passed through; only a context
 * message is attached when the user accepts (so the hub learns the new tool).
 */
function attachProposals(ctx: Context, store: Store | undefined, logger: { warn: (msg: string) => void; info: (msg: string) => void }): () => void {
  if (!store) return () => {}
  let createMessage: ((input: { content: Array<{ type: 'text'; text: string }>; source: Record<string, unknown> }) => unknown) | undefined
  const ensureFactory = async () => {
    if (!createMessage) {
      const llm = await loadHostModule('@deepseek-ai/dsh-llm')
      createMessage = llm.createUserMessage as typeof createMessage
    }
    return createMessage!
  }
  return ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const messages = decision.messages ?? []
    if (!messages.some((m) => m.source?.kind === 'user')) return decision
    try {
      const pending: Array<[string, Signal]> = []
      for (const [key, signal] of store.signals.entries()) {
        if (signal.proposalStatus === 'pending' && signal.proposedAt !== undefined) pending.push([key, signal])
      }
      if (pending.length === 0) return decision
      const signal = pending[0][1]
      const answer = await ctx.userQuestions.ask({
        questions: [{
          id: 'supermemory-toolize',
          header: '工具化提议',
          question: `检测到重复流程「${signal.pattern}」（已出现 ${signal.count} 次）。要固化为组合工具吗？`,
          detail: `样例：${(signal.examples ?? []).slice(0, 3).join('；') || '（无）'}`,
          options: [
            { label: '固化为组合工具', description: '生成可一次调用完成的组合工具并持久化' },
            { label: '以后再说', description: '保留提议，下次再问' },
            { label: '不再提示', description: '忽略此模式' },
          ],
        }],
        ...(payload.agent ? { agent: payload.agent as never } : {}),
        ...(payload.signal ? { signal: payload.signal } : {}),
      })
      const selected = answer?.answers?.[0]?.selected?.[0] ?? ''
      const key = pending[0][0]
      if (selected === '固化为组合工具') {
        const { compileComposite, registerComposite, persistComposite } = await import('./composite.ts')
        const samples = (signal.samples ?? []).map((raw) => {
          try {
            return JSON.parse(raw) as { tools: string[]; args: Array<Record<string, unknown>> }
          } catch {
            return undefined
          }
        }).filter((s): s is { tools: string[]; args: Array<Record<string, unknown>> } => s !== undefined)
        const spec = compileComposite(signal, samples)
        await registerComposite(ctx, store, spec)
        await persistComposite(store, spec, key)
        await store.signals.update(key, (r) => ({ ...r, proposalStatus: 'accepted' }))
        logger.info(`supermemory: composite tool ${spec.name} registered`)
        const factory = await ensureFactory()
        const note = factory({
          content: [{ type: 'text', text: `[SuperMemory] 已固化为组合工具 ${spec.name}：${spec.description}。后续同样流程优先一次调用它。` }],
          source: { kind: 'supermemory', form: 'notice', summary: '组合工具已固化' },
        })
        return { ...decision, messages: [...decision.messages, note as never] }
      }
      await store.signals.update(key, (r) => ({
        ...r,
        proposalStatus: selected === '不再提示' ? 'declined' : r.proposalStatus,
      }))
      return decision
    } catch (error) {
      logger.warn(`supermemory: proposal flow skipped: ${String(error).slice(0, 200)}`)
      return decision
    }
  })
}

const PROMPT_TEXT = [  '[SuperMemory 记忆]',
  '- 涉及历史结论、约定、构建命令、文件用途、"之前说过/做过什么"时，先调用 memory_recall 检索再作答。',
  '- 用户明确要求记住某事、或某事实值得跨会话保留时，调用 memory_remember 写入（按工作区隔离）。',
  '- 你是记忆中枢：判断、派发、整合汇报；实质工作用 memory_dispatch 分派到话题集分支，分支结果会以 relay 主动送回，届时轻量转述。',
  '- 简单问答不要派发——上下文卡/recall 能答的直接答。',
  '- 对话中可能出现 [SuperMemory 相关记忆] / [SuperMemory 话题集] 注入卡片：仅供参考，与用户当前指令冲突时以当前指令为准。',
].join('\n')

export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('supermemory')
  if (!config?.enabled) {
    logger.info('supermemory: disabled by config')
    return
  }

  // Storage domain: a failure degrades memory features, never the session.
  let store: Store | undefined
  try {
    store = await openStore(ctx.storageDomain, logger)
  } catch (error) {
    logger.warn(`supermemory: storage domain unavailable, memory features disabled: ${String(error)}`)
  }
  ctx.effect(() => () => { void store?.close().catch(() => {}) }, 'supermemory: domain')

  const modelDeps: ModelDeps = { ctx, store: store as Store, logger }

  try {
    const toolsDeps: ToolsDeps = {
      ctx,
      store: store as Store,
      dispatch: { ctx, store: store as Store, logger },
      model: modelDeps,
      logger,
    }
    const disposeTools = await attachTools(ctx, toolsDeps, {
      rememberEnabled: true,
      recall: {
        maxItems: config.recall.maxItems,
        minScore: config.recall.minScore,
        halfLifeDays: config.recall.halfLifeDays,
      },
    })
    ctx.effect(() => disposeTools, 'supermemory: tools')
  } catch (error) {
    logger.warn(`supermemory: tool registration failed: ${String(error)}`)
  }

  // pre-step: recall card (§P0) then topicset routing (P1) — both waterfall-safe.
  ctx.effect(() => attachPreStep(ctx, store, {
    enabled: true,
    maxItems: config.recall.maxItems,
    minScore: config.recall.minScore,
    halfLifeDays: config.recall.halfLifeDays,
    maxChars: config.recall.maxChars,
    injectStyle: config.recall.injectStyle,
  }, logger), 'supermemory: pre-step')

  const routeDeps: RouteDeps = {
    store: store as Store,
    config: {
      enabled: config.route.enabled,
      driftTurns: config.route.driftTurns,
      driftThreshold: config.route.driftThreshold,
      confirm: config.route.confirm,
      llmFallback: config.route.llmFallback,
    },
    logger,
  }
  ctx.effect(() => attachRoute(ctx, routeDeps), 'supermemory: route')

  // P3: composite tools are rebuilt from durable JSON on every start.
  if (store) {
    void (async () => {
      try {
        const { rebuildComposites, attachCompositeHint } = await import('./composite.ts')
        const count = await rebuildComposites(ctx, store)
        if (count > 0) logger.info(`supermemory: rebuilt ${count} composite tool(s)`)
        ctx.effect(() => attachCompositeHint(ctx, store), 'supermemory: composite-hint')
      } catch (error) {
        logger.warn(`supermemory: composite rebuild failed: ${String(error).slice(0, 200)}`)
      }
    })()
  }

  // P3: pending tool-ization proposals are asked at the next user interaction.
  ctx.effect(() => attachProposals(ctx, store, logger), 'supermemory: proposals')

  ctx.effect(() => attachObserve(ctx, {
    ctx,
    store: store as Store,
    config: {
      enabled: config.observe.enabled,
      maxTokensPolicy: config.observe.maxTokensPolicy,
    },
    logger,
  }), 'supermemory: observe')

  ctx.effect(() => attachMaintenance(ctx, store, {
    enabled: config.maintenance.enabled,
    signalsThreshold: config.maintenance.signalsThreshold,
    summaryEveryTurns: config.maintenance.summaryEveryTurns,
  }, logger), 'supermemory: maintenance')

  const commandDeps: CommandsDeps = {
    ctx,
    store,
    model: modelDeps,
    logger,
    workspaceKeyOfCwd: workspaceKeyOf,
  }
  ctx.effect(() => attachCommands(ctx, commandDeps), 'supermemory: commands')

  // §1.5: host-side panel data channel for the (deferred) sidebar client half.
  ctx.effect(() => attachPanel(ctx, store), 'supermemory: panel')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'supermemory:role',
    order: 900,
    text: PROMPT_TEXT,
  }), 'supermemory: prompt')

  // §2.4: startup reconciliation, detached.
  if (store) runReconciliation({ ctx, store, logger })

  // D5: idle branch release sweep (never releases the hub; never with pending outbox).
  if (store) {
    const releaseStore = store
    const timer = setInterval(() => {
      try {
        const now = Date.now()
        for (const sessionId of releasableBranches(releaseStore, now, config.dispatch.idleReleaseMs)) {
          const handle = branchHandles.get(sessionId)
          if (!handle) continue
          void handle.dispose().then(() => {
            branchHandles.delete(sessionId)
            logger.info(`supermemory: released idle branch ${sessionId.slice(0, 13)}`)
          }).catch(() => { /* release is best-effort */ })
        }
      } catch { /* sweep is best-effort */ }
    }, 300000)
    ctx.effect(() => () => clearInterval(timer), 'supermemory: release-sweep')
  }

  logger.info(`supermemory: active (store=${store ? 'open' : 'degraded'})`)
}
