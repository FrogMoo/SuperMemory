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
import { attachObserve, flushObserve, settleInterruptedDispatches } from './observe.ts'
import { attachToolActivity } from './activity.ts'
import { createTracker } from './inrequest.ts'
import { attachPreStep } from './prestep.ts'
import { sweepAutoToolize, type ToolizeConfig } from './toolize.ts'
import { loadHostModule } from './host.ts'
import { runReconciliation } from './reconcile.ts'
import { attachRoute, type RouteDeps } from './route.ts'
import type { Signal } from './schema.ts'
import { attachPanel } from './panel.ts'
import { openStore, workspaceKeyOf, type Store } from './store.ts'
import { attachTools, type ToolsDeps } from './tools.ts'
import { attachWebui } from './webui.ts'
import './services.ts'
import './source.ts'

export const name = 'supermemory'

/** Services this plugin consumes; the fiber stays PENDING until all exist. */
export const inject = [
  'sessions', 'tools', 'storageDomain', 'sessionPersistence',
  'commands', 'systemPrompt', 'userQuestions', 'agents', 'workspaceRegistry',
]

/**
 * Config for the profile patch: every knob is documented in Chinese because the
 * settings page renders these descriptions verbatim.
 */
export interface Config {
  enabled: boolean
  recall: {
    maxItems: number
    minScore: number
    halfLifeDays: number
    maxChars: number
    injectStyle: 'gentle' | 'plain'
    repeat: {
      enabled: boolean
      everySteps: number
      maxCardsPerRequest: number
      maxCharsPerRequest: number
      dedupe: boolean
      hotSignal: boolean
    }
  }
  route: {
    enabled: boolean
    driftTurns: number
    driftThreshold: number
    hint: boolean
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
    interruptAfterMs: number
  }
  maintenance: {
    enabled: boolean
    signalsThreshold: number
    summaryEveryTurns: number
    autoToolize: boolean
    toolizeCooldownMs: number
    toolizeMax: number
    toolizeMinSteps: number
    toolizeMinDistinctTools: number
    nearMissHint: boolean
    recycleIdleToolDays: number
  }
  ui: {
    enabled: boolean
    token: string
    carrier: 'own' | 'auto'
  }
}

/**
 * Project the plugin Config onto the tool-ization knobs (one place, so the
 * maintenance loop and the tool-activity listener never disagree).
 */
export function toolizeConfig(config: Config): ToolizeConfig {
  return {
    enabled: config.maintenance.autoToolize,
    threshold: config.maintenance.signalsThreshold,
    cooldownMs: config.maintenance.toolizeCooldownMs,
    maxActive: config.maintenance.toolizeMax,
    minSteps: config.maintenance.toolizeMinSteps,
    minDistinctTools: config.maintenance.toolizeMinDistinctTools,
    nearMissHint: config.maintenance.nearMissHint,
    recycleIdleDays: config.maintenance.recycleIdleToolDays,
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
    repeat: Schema.object({
      enabled: Schema.boolean().description('过程内再召回开关（需求 A：同一请求执行过程中继续召回，不只在开头注入一次）').default(true),
      everySteps: Schema.natural().description('自上次召回后又执行了多少次工具调用才再次召回（默认 3，保守；每次召回后计数清零）').default(3),
      maxCardsPerRequest: Schema.natural().description('同一请求内召回卡片总数上限（含开头那张）').default(4),
      maxCharsPerRequest: Schema.natural().description('同一请求内召回卡片字符总量上限').default(6000),
      dedupe: Schema.boolean().description('已注入过的 memory id 不再重复注入').default(true),
      hotSignal: Schema.boolean().description('高信号变化提前触发：工具报错，或与已有记忆关键词重合度显著上升（新路径单独出现不算，避免每读一个文件就注入）').default(true),
    }).description('过程内再召回参数').default({}),
  }).description('检索注入参数').default({}),
  route: Schema.object({
    enabled: Schema.boolean().description('话题集路由开关').default(true),
    driftTurns: Schema.natural().description('连续多少轮低重合才重新路由').default(3),
    driftThreshold: Schema.natural().description('重合度阈值（命中 token 数）').default(1),
    hint: Schema.boolean().description('关键词命中话题集时注入静默提示卡片（不询问、不切换）').default(true),
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
    interruptAfterMs: Schema.natural().description('需求 D：派发超过多少毫秒没有任何分支活动就判定中断并补发回执（默认 15 分钟）').default(900000),
  }).description('观察投递参数').default({}),
  maintenance: Schema.object({
    enabled: Schema.boolean().description('维护循环开关').default(true),
    signalsThreshold: Schema.natural().description('工具化序列阈值（同一短流程出现次数）').default(3),
    summaryEveryTurns: Schema.natural().description('话题集梗概滚动更新间隔（轮）').default(10),
    autoToolize: Schema.boolean().description('需求 B：达到阈值自动固化为组合工具（不再等用户确认）；关闭时保留原有人工确认路径').default(true),
    toolizeCooldownMs: Schema.natural().description('自动固化冷却毫秒数（同一工作区两次固化之间的最小间隔，防止无限增长）').default(60000),
    toolizeMax: Schema.natural().description('组合工具数量上限（达到后不再自动新增）').default(8),
    toolizeMinSteps: Schema.natural().description('自动固化的最少步数（默认 2）').default(2),
    toolizeMinDistinctTools: Schema.natural().description('自动固化要求的最少不同工具数（默认 2；同一工具重复不构成流程）').default(2),
    nearMissHint: Schema.boolean().description('模型手工执行组合工具前几步时，注入一句可直接调用组合工具的提示（走 post-execute additionalContexts，真实可见）').default(true),
    recycleIdleToolDays: Schema.natural().description('零使用组合工具回收天数（0=关闭，只记录不回收）').default(0),
  }).description('维护循环参数').default({}),
  ui: Schema.object({
    enabled: Schema.boolean().description('Web 管理台总开关（/supermemory 路由）').default(true),
    token: Schema.string().description('管理台访问令牌：留空=每次启动随机生成；off=不校验（仅可信 loopback）；其他值=固定令牌').default(''),
    carrier: Schema.union([Schema.const('own'), Schema.const('auto')])
      .description('HTTP 载体：own=自有 loopback 端口（与 GUI 不同源，侧边栏 browser tab 能打开，默认）；auto=优先宿主 webServer（GUI 同源，省一个端口，但侧边栏 browser tab 会以「应用自身」为由拒绝打开，仅适合系统浏览器）').default('own'),
  }).description('Web 管理台参数').default({}),
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
  '- 对话连续性：用户在当前对话框直接对话时，你就在当前对话的上下文中继续回答，不要询问是否切换话题、不要自行切换话题集；',
  '  话题集只在用户显式 @话题集名、在 SuperMemory 面板中激活、或执行 /memory switch 时才切换。',
  '- 实质工作必须开新对话执行：当用户提出问题需要实际操作（读改文件、执行命令、多步调研、修复与验证等）时，',
  '  调用 memory_dispatch 把任务派发到话题集分支会话中完成，由分支汇报结果——不要在主对话框里直接完成整套操作或长篇大论；',
  '  主对话框只做：判断、派发、收到 relay 结果后轻量转述。纯问答、简单确认、记忆检索类问题不要派发。',
  '- 用户要求可视化管理记忆/打开记忆面板时：SuperMemory 面板已内置在左侧边栏（插件/自动化任务下方的"超级记忆"入口），',
  '  直接提示用户点击该入口即可；memory_ui 返回的浏览器管理台链接仅在用户明确要求外部链接时给出。',
  '- 对话中可能出现 [SuperMemory 相关记忆] / [SuperMemory 话题集] / [SuperMemory 话题提示] 注入卡片：仅供参考，',
  '  与用户当前指令冲突时以当前指令为准；[SuperMemory 话题提示] 只是候选列表，不代表已切换话题。',
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

  // Per-step context: opening recall (P0) + in-request repeat cards (需求 A).
  // agent/pre-step is the only supported place to append model-visible, logged
  // messages on EVERY step of a request (see inrequest.ts header).
  const tracker = createTracker()
  ctx.effect(() => attachPreStep(ctx, store, {
    enabled: true,
    maxItems: config.recall.maxItems,
    minScore: config.recall.minScore,
    halfLifeDays: config.recall.halfLifeDays,
    maxChars: config.recall.maxChars,
    injectStyle: config.recall.injectStyle,
    repeat: config.recall.repeat,
    tracker,
  }, logger), 'supermemory: pre-step')

  // Tool activity: repeat-recall input, composite near-miss records and live
  // auto-toolization, on the supported post-execute waterfall.
  ctx.effect(() => attachToolActivity(ctx, store, tracker, {
    repeat: config.recall.repeat,
    nearMissHint: config.maintenance.nearMissHint,
    toolize: toolizeConfig(config),
  }, logger), 'supermemory: tool-activity')

  const routeDeps: RouteDeps = {
    store: store as Store,
    config: {
      enabled: config.route.enabled,
      driftTurns: config.route.driftTurns,
      driftThreshold: config.route.driftThreshold,
      hint: config.route.hint,
      llmFallback: config.route.llmFallback,
    },
    logger,
  }
  ctx.effect(() => attachRoute(ctx, routeDeps), 'supermemory: route')

  // P3: composite tools are rebuilt from durable JSON on every start.
  if (store) {
    void (async () => {
      try {
        const { rebuildComposites } = await import('./composite.ts')
        const count = await rebuildComposites(ctx, store)
        if (count > 0) logger.info('supermemory: rebuilt ' + count + ' composite tool(s)')
        // 需求 B: signals that crossed the threshold before autoToolize existed
        // are fixated at boot; zero-use composites are audited there as well.
        const sweepCreated = await sweepAutoToolize(ctx, store, toolizeConfig(config), logger)
        if (sweepCreated > 0) logger.info('supermemory: auto-toolized ' + sweepCreated + ' composite(s) at boot')
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
    autoToolize: config.maintenance.autoToolize,
    toolizeCooldownMs: config.maintenance.toolizeCooldownMs,
    toolizeMax: config.maintenance.toolizeMax,
    toolizeMinSteps: config.maintenance.toolizeMinSteps,
    toolizeMinDistinctTools: config.maintenance.toolizeMinDistinctTools,
    nearMissHint: config.maintenance.nearMissHint,
    recycleIdleToolDays: config.maintenance.recycleIdleToolDays,
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

  // Plan A: visual memory console (no client bundle).
  ctx.effect(() => attachWebui(ctx, store, {
    enabled: config.ui?.enabled ?? true,
    token: config.ui?.token ?? '',
    carrier: config.ui?.carrier ?? 'own',
  }, logger), 'supermemory: web-console')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'supermemory:role',
    order: 900,
    text: PROMPT_TEXT,
  }), 'supermemory: prompt')

  // §2.4: startup reconciliation, detached.
  if (store) {
    runReconciliation({
      ctx, store, logger,
      observe: { enabled: config.observe.enabled, maxTokensPolicy: config.observe.maxTokensPolicy, interruptAfterMs: config.observe.interruptAfterMs },
    })
    // D: a dispatch that died before it could relay (crash/reload between settle and
    // deliver) is backfilled here; open dispatches wait for the periodic sweep.
    void settleInterruptedDispatches(
      { ctx, store, config: { enabled: config.observe.enabled, maxTokensPolicy: config.observe.maxTokensPolicy, interruptAfterMs: config.observe.interruptAfterMs }, logger },
      { timeoutMs: 0, terminalOnly: true, reason: '启动对账补发历史中断' },
    ).catch(() => { /* startup backfill is best-effort */ })
  }

  // D5: idle branch release sweep (never releases the hub; never with pending outbox).
  if (store) {
    const releaseStore = store
    const observeConfig = { enabled: config.observe.enabled, maxTokensPolicy: config.observe.maxTokensPolicy, interruptAfterMs: config.observe.interruptAfterMs }
    const timer = setInterval(() => {
      try {
        // Self-healing delivery: re-send relays that were stranded while the hub
        // was offline (startup reconciliation alone is not a retry loop).
        void flushObserve({ ctx, store: releaseStore, config: observeConfig, logger })
          .catch(() => { /* flush is best-effort */ })
        // D: a branch that died (stop/crash/reload) never emits turn/end, so the
        // timeout sweep is the only thing that turns silence into a relay.
        void settleInterruptedDispatches({ ctx, store: releaseStore, config: observeConfig, logger }, { timeoutMs: config.observe.interruptAfterMs })
          .catch(() => { /* interrupt sweep is best-effort */ })
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

    // D: disposing the plugin (reload/disable) kills live branch handles, so the
    // hub must learn about it instead of waiting forever for a turn/end.
    ctx.effect(() => () => {
      void settleInterruptedDispatches(
        { ctx, store: releaseStore, config: observeConfig, logger },
        { timeoutMs: 0, reason: '插件重载/卸载导致分支中断' },
      ).catch(() => { /* dispose settlement is best-effort */ })
    }, 'supermemory: settle-on-dispose')
  }

  logger.info(`supermemory: active (store=${store ? 'open' : 'degraded'})`)
}
