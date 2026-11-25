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
import { detachIdleBranches } from './dispatch.ts'
import { attachMaintenance } from './maintenance.ts'
import type { ModelDeps } from './model.ts'
import { attachObserve, flushObserve, settleInterruptedDispatches } from './observe.ts'
import { attachToolActivity } from './activity.ts'
import { createTracker } from './inrequest.ts'
import { attachPreStep } from './prestep.ts'
import { sweepAutoToolize, type ToolizeConfig } from './toolize.ts'
import { loadHostModule } from './host.ts'
import { isPluginBranchId } from './hub-sessions.ts'
import { runReconciliation } from './reconcile.ts'
import { renderBranchRestoreSummary, restoreBranchSessions } from './branch-restore.ts'
import { migrateTruncatedTitles } from './title-migration.ts'
import { attachPendingHubTitleRename, attachHubTitleFromFirstMessage, migrateHubSessionTitles } from './hub-title-migration.ts'
import { knownWorkspaceKeys, migrateHubSessionRecords } from './hub-records-migration.ts'
import { applyMemoryOrganize } from './memory-organize.ts'
import { PLUGIN_REPO_ROOT } from './builtin-capabilities.ts'
import { notifyInterruptedDispatches, type NotifyState } from './resume.ts'
import { attachRoute, type RouteDeps } from './route.ts'
import type { Signal } from './schema.ts'
import { attachPanel } from './panel.ts'
import { openStoreWithRetry, workspaceKeyOf, type Store } from './store.ts'
import { attachTools, type ToolsDeps } from './tools.ts'
import { attachWebui } from './webui.ts'
import { isHubSession } from './hub-branches.ts'
import { backfillHubRecords } from './role.ts'
import { ROLE_GUARD_VERSION, roleGuardDecision } from './role-guard.ts'
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
    /** R45 legacy switch: auto-register composite tools (off by default). */
    autoToolize: boolean
    /** R45: auto-register composite tools (the legacy one-click entrance). */
    autoComposite: boolean
    /** R45: repeated work becomes a DSH skill (the default path). */
    autoSkill: boolean
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
    // R45: the legacy autoToolize flag keeps working for anyone who set it
    // explicitly; composite auto-registration is otherwise off, because the
    // primary fixation path is now a skill.
    enabled: config.maintenance.autoComposite || config.maintenance.autoToolize,
    autoSkill: config.maintenance.autoSkill,
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
    autoSkill: Schema.boolean().description('R45：重复事务自动沉淀为 DSH skill（写入 <仓库>/.dsh/skills，模型目录可路由；默认开）').default(true),
    autoComposite: Schema.boolean().description('R45：重复事务自动固化为组合工具（旧的一键入口；默认关）。组合工具仍可通过 memory_toolize accept 手工生成').default(false),
    autoToolize: Schema.boolean().description('需求 B 的旧开关（向后兼容）：显式 true 仍会生成组合工具；新安装请用 autoComposite').default(false),
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
    // R25: dispatch inputs are kind 'user' now, so a BRANCH passes this gate
    // too. A tool-ization proposal is a hub↔user interaction and a branch must
    // never ask the user itself (R20) — skip plugin-minted branches here.
    if (isPluginBranchId(String(payload.agent?.id ?? ''))) return decision
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

/**
 * R18 需求⑤ (软约定): the hub session's role. Injected ONLY when the initiating
 * agent is a hub of its workspace — a top-level session (no parent, not a
 * subagent) that belongs to no topic set. Branches must never receive this
 * text, or they would refuse the very work they were dispatched to do.
 *
 * Deliberately a SOFT convention: the hub keeps its tools (the user chose
 * "soft" over removing them); the prompt only states the division of labour.
 */
const HUB_ROLE_TEXT = [
  '[SuperMemory 中枢会话]',
  '- 你是中枢会话：只做判断、派发（memory_dispatch）与汇总（收到 relay 结果后转述给用户）。',
  '- 不要直接读改文件、执行命令、跑构建或长篇推理——这些操作交给分支会话完成；你的价值是定义清楚任务与边界，再整合结果。',
  // R36 需求①②: the runtime guard is a WHITELIST. Saying so in the role prompt
  // keeps the model from burning a turn on a tool that will be denied, and
  // tells it where the switch lives (panel 「中枢权限」页签).
  '- 工具白名单（默认拒绝）：你只能调用白名单内的工具；不在名单内的（含未来新增工具）会被运行时直接拒绝，'
  + '需要某项时可在超级记忆面板「中枢权限」页签勾选启用（保存后下一个工具调用即生效）。',
  '- 派发时先设定能力：要改代码/跑命令用 capabilities=full；只审阅用 read；纯代码编辑用 read-write；汇总/轻量核对用 minimal。',
  // R19 协同①: the parallel-group guidance lives in the role prompt, not only in
  // the tool description, so the model plans the fan-out before it starts.
  '- 需求多或复杂（多个独立子任务、多个方向调研、互相可并行的修复）时，用 memory_dispatch 的 tasks[] 一次拆成多个分支并行协同：',
  '  每个任务一个独立分支，全部到达终态后只回送一次汇总，失败成员会单独标注；不要把一个可拆分的大任务塞进单个分支串行做。',
  '  并行组里的每个任务必须自包含（写清目标、范围、验收），彼此不要依赖同一文件的并发修改。',
  // R19 协同②③: hub sees its branches; branches belong to the set, not the hub.
  '- 系统上下文会注入「[supermemory 关联分支]」卡：它列出你已拉起的分支（标题/标签/状态/话题集/是否被多个中枢共享），'
  + '本轮 recall 命中话题集时还带出该话题集下的分支清单（标题/标签/状态/最后活动）；先看它再决定派发。',
  '- 分支归属话题集，可被同一话题集下的其他中枢复用/共享：继续同一条分支用 mode=continue（忙则排队），新任务用 mode=auto（复用空闲分支，否则新建）。',
  '- 不要为同一件工作反复新建分支造成重复/分裂；已完成或空闲的分支优先续派。',
  // R30 需求⑤: 每次对话的检索路由——记忆 → 话题集 → 分支会话 → 复用/新建。
  '- 每轮对话按这条路由检索再动手：① 先读 recall 卡里的相关记忆（历史结论/约定/构建命令/文件用途）；'
  + '② 列出并匹配话题集（注入卡带出命中话题集的标题/标签）；'
  + '③ 按话题集检索其下分支会话（标题/标签/状态/最后活动——注入卡已带出，面板/管理台可看全部）；'
  + '④ 最后才决定复用（memory_dispatch mode=continue/auto 续派空闲分支）还是新建（mode=new）。',
  '- 命中话题集时把任务派到该话题集（派发时显式 topicSetId 或 sticky 路由都会解析），不要重新检索一遍、更不要另起炉灶。',
  // R24: a receipt ENDS the hub's turn. The host starts a NEW turn for an idle
  // session when a relay lands, and only queues it while a turn is running —
  // so waiting inside the turn stalls the relay. Branches are NOT subagent-tree
  // members either: wait_agent can never observe them. Same rule is repeated in
  // the tool descriptions and carried by the receipt's nextAction field.
  '- memory_dispatch / memory_resume 返回回执后，立即结束本轮回复：不要调用 wait_agent 等分支、不要轮询分支状态、也不要边等边做无关工作把本轮挂住。',
  '- 原因：分支不是中枢 subagent 树的成员，wait_agent 等不到它们；在本轮内等待只会让分支 relay 在队列里排队，把中枢回合卡住。',
  '- 分支完成后 relay 会作为新消息自动送回本会话并开启新一轮对话；届时再调用 memory_questions 汇总未决问题、把结果转述给用户。',
  '- 同一轮可以连续派发多个任务（含 tasks[] 并行组），全部派发完成后一次性结束本轮回复。',
  // R20: a branch never asks the user itself — it raises a structured question
  // to the hub, and the hub aggregates EVERY branch's open questions into one
  // ask_user_question. That is the only user-facing question of a round.
  '- 分支不会直接问用户：它们的疑问通过 memory_raise_question 上交到你。收到 relay 或用户新消息时，先调用 memory_questions 查看所有未解决问题（含仍在工作的分支）。',
  '- 汇总问题：去重、按主题合并成一份清单，标注来源分支 / 是否阻塞 / 已完成进度 / 默认备选方案，然后用 ask_user_question **一次**向用户提问；不要逐个转发。',
  '- 用户答复后用 memory_questions 的 resolve 结清（可带 answer），再把裁决用 memory_dispatch 派回对应分支。',
  '- 分支已按最合理解释完成、问题不阻塞时不必提问：在汇报里列出它做的假设即可。',
  '- 纯问答、简单确认、记忆检索类问题不必派发，直接答。',
  '- 写入记忆只记结论：memory_remember 里放可复用的事实/决策/约定（跨会话仍然成立）；不要写过程流水账（先做了什么、执行了哪些命令、第几步、工具日志）。',
  '- recall 命中「相关话题集」时，优先直接回答或把任务派发到该话题集，不要重新检索一遍。',
].join('\n')

const PROMPT_TEXT = [  '[SuperMemory 记忆]',
  '- 涉及历史结论、约定、构建命令、文件用途、"之前说过/做过什么"时，先调用 memory_recall 检索再作答。',
  '- 用户明确要求记住某事、或某事实值得跨会话保留时，调用 memory_remember 写入（按工作区隔离）：',
  '  只写结论性、可复用的事实/决策/约定（标题 + 标签 + 正文），禁止把过程流水账、临时步骤、工具调用日志写进记忆。',
  '- 对话连续性：用户在当前对话框直接对话时，你就在当前对话的上下文中继续回答，不要询问是否切换话题、不要自行切换话题集；',
  '  话题集只在用户显式 @话题集名、在 SuperMemory 面板中激活、或执行 /memory switch 时才切换。',
  '- 实质工作必须开新对话执行：当用户提出问题需要实际操作（读改文件、执行命令、多步调研、修复与验证等）时，',
  '  调用 memory_dispatch 把任务派发到话题集分支会话中完成，由分支汇报结果——不要在主对话框里直接完成整套操作或长篇大论；',
  '  主对话框（中枢）只做：判断、派发、收到 relay 结果后轻量转述与交付用户要的最终信息；不要直接读改文件、执行命令或长篇推理。',
  '  派发后即结束本轮回复，不要 wait_agent 等待分支；分支完成后 relay 会自动开启新一轮对话。',
  '  派发前用 capabilities 设定分支能力边界（改代码/跑命令用 full，只审阅用 read，纯编辑用 read-write，汇总/轻量核对用 minimal）；',
  '  纯问答、简单确认、记忆检索类问题不要派发。',
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
    store = await openStoreWithRetry(ctx.storageDomain, logger)
  } catch (error) {
    logger.warn(`supermemory: storage domain unavailable, memory features disabled: ${String(error)}`)
  }
  ctx.effect(() => () => { void store?.close().catch(() => {}) }, 'supermemory: domain')
  // R33 需求②: seed positive hub records from durable evidence written by
  // earlier rounds (topic-set root members + every dispatch's hubSessionId).
  // Resolution also reads those directly; the rows make the mark explicit.
  if (store) {
    void backfillHubRecords(store, logger).catch((error) => {
      logger.warn('supermemory: hub record backfill failed: ' + String(error).slice(0, 160))
    })
  }

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

  // R32 需求①②: harden the hub/branch division of labour at RUNTIME, not in
  // prompt text. `ctx.tools.guard` is DSH's monotonic pre-dispatch seam: it
  // runs after every pre-execute policy/approval and before the tool body, so a
  // denial is final. One guard covers both rules:
  //   - a branch (or any non-hub) may not call plugin_manager's mutating
  //     actions (disable/enable/install/remove) — that would kill its own agent;
  //   - a hub may not call hands-on execution tools; it must dispatch instead.
  // The relay link stays intact because memory_dispatch / recall / questions /
  // send_message and the read-only inspection tools are NOT denied, and the
  // PTC `run_code` transport necessarily remains allowed (it is how a hub
  // invokes memory_dispatch at all; see role-guard.ts + DEV-NOTES §42).
  ctx.effect(() => {
    const tools = ctx.tools as unknown as {
      guard?: (guard: (exec: { name: string; arguments: unknown; agent?: unknown }) => unknown) => () => void
    }
    // R33 需求⑧: a missing/failed guard is NOT a log line people never read.
    // The failure is logged AND persisted to the meta row 'role-guard' (survives
    // reloads, visible to the panel/console) so a silently unguarded host is
    // diagnosable. A success also stamps the row (installed/version).
    const markGuard = (patch: Record<string, unknown>): void => {
      try {
        const current = store?.meta.get('role-guard') ?? {}
        void store?.meta.put('role-guard', { ...current, ...patch }).catch(() => {})
      } catch { /* marker is best-effort; the warning below is the primary alert */ }
    }
    if (typeof tools.guard !== 'function') {
      logger.warn('supermemory: [ALERT] ctx.tools.guard unavailable; hub/branch runtime guard NOT installed (host limitation)')
      markGuard({ roleGuardFailedAt: Date.now(), roleGuardVersion: ROLE_GUARD_VERSION, roleGuardError: 'ctx.tools.guard unavailable' })
      return () => {}
    }
    try {
      const dispose = tools.guard((exec) => roleGuardDecision(
        store, exec.agent, exec.name, exec.arguments,
        (message) => logger.warn(message),
      ))
      markGuard({ roleGuardInstalledAt: Date.now(), roleGuardVersion: ROLE_GUARD_VERSION })
      return dispose
    } catch (error) {
      logger.warn('supermemory: [ALERT] ctx.tools.guard registration failed; hub/branch runtime guard NOT installed: '
        + String(error).slice(0, 200))
      markGuard({
        roleGuardFailedAt: Date.now(),
        roleGuardVersion: ROLE_GUARD_VERSION,
        roleGuardError: String(error).slice(0, 300),
      })
      return () => {}
    }
  }, 'supermemory: role guard')

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
    ...(store ? { ctx } : {}),
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
        // R45: durable repetitions that crossed the threshold before skills
        // existed are fixated as skills at boot (files survive restarts).
        const { sweepSkillDrafts } = await import('./toolize.ts')
        await sweepSkillDrafts(store, toolizeConfig(config), logger)
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
    autoToolize: config.maintenance.autoComposite || config.maintenance.autoToolize,
    autoSkill: config.maintenance.autoSkill,
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

  // R18 需求⑤: hub-role section (order 901, right after the memory rules). The
  // provider reads the initiating agent at assembly time — `currentInitiator()`
  // is the agent whose turn triggered this prompt — and contributes NOTHING
  // when that agent is not a hub. R35: "hub" is resolveRole's POSITIVE judgement
  // (hub_sessions record / topic-set ROOT member / a session that dispatched),
  // so a topic-set root DOES get the hub prompt; branches and subagents do not.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'supermemory:hub-role',
    order: 901,
    text: (context: unknown) => {
      let agent: unknown
      try {
        agent = ctx.agents.currentInitiator()
      } catch {
        agent = undefined
      }
      if (!agent) {
        // No initiator boundary (e.g. a host that assembles outside a turn):
        // the assembling scope is the Agent, which is the same subject.
        agent = (context as { scope?: unknown } | undefined)?.scope
      }
      return isHubSession(store, agent) ? HUB_ROLE_TEXT : ''
    },
  }), 'supermemory: prompt (hub role)')

  // §2.4: startup reconciliation, detached.
  if (store) {
    runReconciliation({
      ctx, store, logger,
      observe: { enabled: config.observe.enabled, maxTokensPolicy: config.observe.maxTokensPolicy, interruptAfterMs: config.observe.interruptAfterMs },
    })
    // One-time title repair: refresh rows damaged by the pre-2026-11-18
    // truncation (12/40-char topic titles, 16-char task snippets).
    // Marker-guarded via store.meta.titles and content-idempotent, so a
    // restart never repeats the work; a manual re-scan is /memory titles.
    void migrateTruncatedTitles({ ctx, store, logger }).catch((error) => {
      logger.warn('supermemory: title migration failed: ' + String(error).slice(0, 160))
    })
    // R41 需求③: one-time cleanup of plugin session names — branded hubs
    // ('SuperMemory 中枢 · <id4>') and pre-R31 hubs ('新会话 · <id4>') become
    // DIRECT work descriptions (first user message, else the neutral 「新会话」);
    // plugin branch host titles lose a known topic-set prefix and leading


    // 「R31：」「R32 」「项目：」「背景：」 tokens; durable dispatch/member/hub
    // titles are cleaned too. Marker-guarded (meta row 'hub-titles', version 3),
    // reads the live title so a human rename is never overwritten. R42: the
    // marker CONVERGES — a not-yet-attached candidate is recorded as pending
    // (renamed on its first live event by attachPendingHubTitleRename) instead
    // of keeping the marker unwritten, which used to rescan every startup.
    // Before a branded hub is renamed it receives its positive hub record — the
    // R35 hub-record migration used that prefix as evidence, and the record is
    // what role resolution actually reads. The record migration still runs after
    // this one (it also covers hubs whose title never carried the prefix).


    const hubTitlePass = migrateHubSessionTitles({ ctx, store, logger })
      .catch((error) => {
        logger.warn('supermemory: hub title migration failed: ' + String(error).slice(0, 160))
      })
      .then(() => migrateHubSessionRecords({ ctx, store, logger, workspaceKeys: knownWorkspaceKeys(store) }))
      .catch((error) => {
        logger.warn('supermemory: hub record migration failed: ' + String(error).slice(0, 160))
      })
    // R42: a COLD session keeps its legacy host title until something attaches
    // to it (applySessionTitle needs a live session). The v3 marker records
    // those ids as pending instead of blocking convergence; this hook renames
    // each one on its first live event, so the set drains without a rescan.
    ctx.effect(() => attachPendingHubTitleRename(ctx, store, logger, hubTitlePass), 'supermemory: pending-hub-titles')
    // R43 需求②: a hub opened from the rail and then used IN THE SHELL never
    // went through the panel's send path, so its title stayed the neutral
    // 「新会话」 (the R41 gap the user reported). This hook names it from the
    // user's first message wherever it is typed — same rule as creation, and
    // only while the title carries no topic.
    ctx.effect(() => attachHubTitleFromFirstMessage(ctx, store, logger), 'supermemory: hub-title-first-message')
    // R23: one-time memory re-layout into the R22 collection model. Marker-
    // guarded (meta row `organize-<digest>`), only targets this plugin
    // repo's workspace, and every destructive step is SHA-guarded against
    // bodies edited after the plan was authored. It runs HERE, through the
    // live domain, because the JSON backend's `single` layout rewrites the
    // whole unit on every write — an offline edit behind a running host would
    // be lost. `/memory-organize` previews/applies it manually.
    void applyMemoryOrganize(store, workspaceKeyOf(PLUGIN_REPO_ROOT), { logger }).catch((error) => {
      logger.warn('supermemory: memory organize failed: ' + String(error).slice(0, 200))
    })
    // D: a dispatch that died before it could relay (crash/reload between settle and
    // deliver) is backfilled here; open dispatches wait for the periodic sweep.
    void settleInterruptedDispatches(
      { ctx, store, config: { enabled: config.observe.enabled, maxTokensPolicy: config.observe.maxTokensPolicy, interruptAfterMs: config.observe.interruptAfterMs }, logger },
      { timeoutMs: 0, terminalOnly: true, reason: '启动对账补发历史中断' },
    ).catch(() => { /* startup backfill is best-effort */ })
  }

  // D5 + E: idle branch sweep. 只摘除插件侧 handle——分支会话保留、可续接
  // （acquireBranch 的 live→resume 与 memory_resume 都依赖它），绝不调用
  // handle.dispose()；同一轮里做投递自愈、中断巡检与中断清单主动触达。
  if (store) {
    const releaseStore = store
    const observeConfig = { enabled: config.observe.enabled, maxTokensPolicy: config.observe.maxTokensPolicy, interruptAfterMs: config.observe.interruptAfterMs }
    // E: 每个 hub 的中断清单通知签名去重（清单变化才再通知，不刷屏）。
    const noticeState: NotifyState = { signatures: new Map() }
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
        // E: preserve branch sessions — release the plugin-side handle only.
        detachIdleBranches(releaseStore, Date.now(), config.dispatch.idleReleaseMs, logger)
        // E: 巡检后把（新的）中断清单推给 hub；签名去重，hub 不在线则 outbox 自愈重投。
        void notifyInterruptedDispatches({ ctx, store: releaseStore, config: observeConfig, logger }, { state: noticeState })
          .catch(() => { /* interrupted notice is best-effort */ })
      } catch { /* sweep is best-effort */ }
    }, 300000)
    ctx.effect(() => () => clearInterval(timer), 'supermemory: release-sweep')

    // E: 恢复后主动检查被中断任务（需求：用户决定续跑）。等启动对账三路径跑完
    // （约 10s）再出清单，否则刚被对账判死的派发还没进台账；hub 不在线时由上面
    // 的巡检补投（outbox pending + flushObserve 自愈）。
    const noticeTimer = setTimeout(() => {
      void notifyInterruptedDispatches({ ctx, store: releaseStore, config: observeConfig, logger }, { state: noticeState })
        .catch(() => { /* startup notice is best-effort */ })
    }, 10000)
    ctx.effect(() => () => clearTimeout(noticeTimer), 'supermemory: resume-notice')

    // E+（分支保留续）：重启后从持久台账重建分支注册表——把所有保留的分支会话
    // 重新 attach 到宿主（ctx.agents.resume），分支会话因此重新出现在 GUI 会话
    // 列表，标题与成员状态同步恢复。语义与 detachIdleBranches 一致：只 attach、
    // 绝不 dispose，也不投递任何消息。错开对账路径 3（5s 后启动），35s 再补一次
    // 接住启动竞态（旧实例刚释放 persistence 句柄）下的恢复失败；重跑幂等。
    const restoreTimers: Array<ReturnType<typeof setTimeout>> = []
    const runBranchRestore = (label: string): void => {
      void restoreBranchSessions({ ctx, store: releaseStore, logger })
        .then((outcome) => {
          if (outcome.resumed.length > 0 || outcome.failed.length > 0 || outcome.live.length > 0) {
            logger.info(renderBranchRestoreSummary(outcome) + '（' + label + '）')
          }
        })
        .catch((error) => {
          logger.warn('supermemory: branch restore failed: ' + String(error).slice(0, 160))
        })
    }
    restoreTimers.push(setTimeout(() => runBranchRestore('启动恢复'), 5000))
    restoreTimers.push(setTimeout(() => runBranchRestore('启动补恢复'), 35000))
    ctx.effect(() => () => { for (const timer of restoreTimers) clearTimeout(timer) }, 'supermemory: branch-restore')

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
