/**
 * SuperMemory — DSH 记忆插件（P0：事实记忆 + 跨会话 recall 注入 + 维护循环）。
 *
 * 实现依据《可行性分析与实现方案.md》v4.2：D1–D8 定稿。
 * 宿主包经 loadHostModule 锚定 `process.argv[1]` 解析（dsh-vscode-mode 实证模式）；
 * Config 用 schemastery（与宿主 loader 同一校验面）；存储走 storageDomain。
 * @module supermemory
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { attachCommands } from './commands.ts'
import { attachMaintenance } from './maintenance.ts'
import { attachPreStep } from './prestep.ts'
import { openStore, workspaceKeyOf, type Store } from './store.ts'
import { attachTools } from './tools.ts'
import './services.ts'
import './source.ts'

export const name = 'supermemory'

/** Services this plugin consumes; the fiber stays PENDING until all exist. */
export const inject = ['sessions', 'tools', 'storageDomain', 'sessionPersistence', 'commands', 'systemPrompt']

export interface Config {
  enabled: boolean
  recall: {
    maxItems: number
    minScore: number
    halfLifeDays: number
    maxChars: number
    injectStyle: 'gentle' | 'plain'
  }
  maintenance: {
    enabled: boolean
    signalsThreshold: number
  }
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().description('插件总开关').default(true),
  recall: Schema.object({
    maxItems: Schema.natural().description('recall 注入条数上限').default(5),
    minScore: Schema.natural().description('recall 注入最低分').default(1),
    halfLifeDays: Schema.natural().description('时间衰减半衰期（天）').default(14),
    maxChars: Schema.natural().description('recall 卡片字符上限').default(2400),
    injectStyle: Schema.union([
      Schema.const('gentle'),
      Schema.const('plain'),
    ]).description('注入语气：gentle 温和起步 / plain 直陈').default('gentle'),
  }).description('检索注入参数').default({}),
  maintenance: Schema.object({
    enabled: Schema.boolean().description('维护循环开关').default(true),
    signalsThreshold: Schema.natural().description('工具化信号阈值（P3）').default(3),
  }).description('维护循环参数').default({}),
}).description('SuperMemory 记忆插件配置').default({})

const PROMPT_TEXT = [
  '[SuperMemory 记忆]',
  '- 涉及历史结论、约定、构建命令、文件用途、"之前说过/做过什么"时，先调用 memory_recall 检索再作答。',
  '- 用户明确要求记住某事、或某事实值得跨会话保留时，调用 memory_remember 写入（按工作区隔离）。',
  '- 对话中可能出现 [SuperMemory 相关记忆] 注入卡片：仅供参考，与用户当前指令冲突时以当前指令为准。',
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

  try {
    const disposeTools = await attachTools(ctx, store, {
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

  ctx.effect(() => attachPreStep(ctx, store, {
    enabled: true,
    maxItems: config.recall.maxItems,
    minScore: config.recall.minScore,
    halfLifeDays: config.recall.halfLifeDays,
    maxChars: config.recall.maxChars,
    injectStyle: config.recall.injectStyle,
  }, logger), 'supermemory: pre-step')

  ctx.effect(() => attachMaintenance(ctx, store, {
    enabled: config.maintenance.enabled,
    signalsThreshold: config.maintenance.signalsThreshold,
  }, logger), 'supermemory: maintenance')

  ctx.effect(() => attachCommands(ctx, {
    store,
    workspaceKeyOfCwd: workspaceKeyOf,
  }), 'supermemory: commands')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'supermemory:role',
    order: 900,
    text: PROMPT_TEXT,
  }), 'supermemory: prompt')

  logger.info(`supermemory: active (store=${store ? 'open' : 'degraded'})`)
}
