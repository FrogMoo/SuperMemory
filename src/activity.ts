/**
 * Tool activity: feeds the in-request tracker, records composite near-misses
 * and auto-toolizes a window that repeats inside ONE request.
 *
 * Host surface (verified): tools/post-execute is a waterfall whose accept
 * decision carries additionalContexts for the NEXT request - a supported,
 * model-visible channel. tools/pre-execute CANNOT carry context
 * (PreToolDecision is only allow/deny/cancel/ask), which is why the old
 * pre-execute hint was dead code; this listener replaces it. Everything runs
 * after next(); an exception is logged and swallowed so the tool pipeline is
 * never broken.
 * @module supermemory/activity
 */
import type { Context } from '@deepseek-ai/cordis'
import type * as Tools from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { loadHostModule } from './host.ts'
import type { RepeatConfig, ToolObservation, Tracker } from './inrequest.ts'
import type { Signal } from './schema.ts'
import { workspaceKeyOf, type Store } from './store.ts'
import {
  activeComposites,
  autoToolizeFromSequence,
  pickCompositeMatch,
  repeatedWindow,
  type CompositeMatch,
  type ToolizeConfig,
  type ToolizeDeps,
} from './toolize.ts'

export interface ActivityConfig {
  repeat: RepeatConfig
  toolize: ToolizeConfig
  nearMissHint: boolean
}

/** Text content of one tool result (success and failure both carry content). */
function contentText(result: unknown): string {
  const blocks = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? []
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text) parts.push(String(block.text))
  }
  return parts.join('\n').slice(0, 2000)
}

/** Parsed arguments of one execution (host may already have parsed them). */
function argsOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Best-effort durable near-miss counter for one composite. */
function recordNearMiss(store: Store, workspaceKey: string, match: CompositeMatch, logger: { info: (msg: string) => void }): void {
  const key = 'ws/' + workspaceKey + '/nearmiss/' + match.spec.name
  const now = Date.now()
  const existing = store.signals.get(key)
  const signal: Signal = existing
    ? { ...existing, count: existing.count + 1, lastSeen: now, examples: [...existing.examples, match.recent.join(' > ')].slice(-3) }
    : { workspaceKey, pattern: 'nearmiss:' + match.spec.name, count: 1, lastSeen: now, examples: [match.recent.join(' > ')], sequence: match.recent, samples: [] }
  void store.signals.put(key, signal).catch(() => { /* advisory counter */ })
  logger.info('supermemory: composite near-miss ' + match.spec.name + ' (hits=' + match.hits + ')')
}

/** Create one model-facing notice message (used for the immediate hint). */
async function buildNotice(text: string) {
  const llm = await loadHostModule('@deepseek-ai/dsh-llm')
  return llm.createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'supermemory', form: 'notice', summary: '组合工具提示' },
  })
}

/** Attach the tool-activity listener; returns the effect disposer. */
export function attachToolActivity(
  ctx: Context,
  store: Store | undefined,
  tracker: Tracker,
  config: ActivityConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  deps?: ToolizeDeps,
): () => void {
  if (!store) return () => {}
  const activeStore: Store = store
  const memoryCap = 400
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    let decision
    try {
      decision = await next()
    } catch (error) {
      logger.warn('supermemory: tool post-execute next() failed: ' + String(error))
      throw error
    }
    try {
      const execution = exec as unknown as {
        name?: string
        parent?: unknown
        arguments?: unknown
        agent?: { id?: string; session?: { header?: { cwd?: string } } }
      }
      const name = String(execution.name ?? '')
      if (!name) return decision
      if (execution.parent !== undefined) return decision
      const sessionId = String(execution.agent?.id ?? '')
      if (!sessionId) return decision
      const workspaceKey = workspaceKeyOf(execution.agent?.session?.header?.cwd)
      const observation: ToolObservation = {
        name,
        args: argsOf(execution.arguments),
        text: contentText(result),
        isError: Boolean((result as { isError?: boolean }).isError),
      }
      tracker.observe(sessionId, observation, config.repeat, activeStore.memories.entries(), memoryCap)
      // R45: 调用/命中统计——模型每次用 skill 工具加载我们生成的 sm-* 技能就计数，
      // 面板「设置 → 已生成的 skills」据此判断路由是否真的生效。
      if (name === 'skill') {
        const loaded = typeof observation.args.name === 'string' ? observation.args.name : ''
        if (loaded.startsWith('sm-')) {
          try {
            const { bumpSkillUse } = await import('./skill-forge.ts')
            await bumpSkillUse(activeStore, workspaceKey, loaded)
          } catch { /* statistics are advisory */ }
        }
      }
      const state = tracker.get(sessionId)
      if (!state) return decision
      const recent = state.recent.map((entry) => entry.name)
      const match = pickCompositeMatch(recent, activeComposites(activeStore))
      if (match && match.hits >= 2) recordNearMiss(activeStore, workspaceKey, match, logger)
      const repeat = config.toolize.enabled || config.toolize.autoSkill ? repeatedWindow(state, config.toolize) : undefined
      if (repeat && config.toolize.enabled) {
        await autoToolizeFromSequence(ctx, activeStore, workspaceKey, repeat.tools, repeat.samples, config.toolize, logger, deps)
      }
      // R45: 一次请求内就重复的窗口是「重复事务」的强信号——即使组合工具关闭，
      // 也把它沉淀成 skill（技能比流水线更容易被下一次任务路由到）。
      if (repeat && config.toolize.autoSkill) {
        try {
          const { persistSequenceSkill } = await import('./skill-forge.ts')
          await persistSequenceSkill(activeStore, workspaceKey, repeat.tools, repeat.samples, repeat.count)
        } catch (error) {
          logger.warn('supermemory: skill draft (in-request) failed: ' + String(error).slice(0, 160))
        }
      }
      if (!config.nearMissHint || !match || match.hits < 2) return decision
      if (tracker.hasHinted(sessionId, match.spec.name)) return decision
      if (decision.kind !== 'accept') return decision
      tracker.markHinted(sessionId, match.spec.name)
      const text = '[SuperMemory 提示] 刚执行的 ' + match.recent.join(' → ') + ' 与组合工具 ' + match.spec.name + ' 的前 ' + match.hits + ' 步一致。同样的流程可以直接调用它一次完成。'
      const notice = await buildNotice(text)
      const existingContexts = (decision as { additionalContexts?: UserMessage[] }).additionalContexts ?? []
      return { ...decision, additionalContexts: [...existingContexts, notice] } as never
    } catch (error) {
      logger.warn('supermemory: tool activity skipped: ' + String(error).slice(0, 200))
      return decision
    }
  })
}
