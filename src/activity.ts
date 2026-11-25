/**
 * Tool activity: feeds the in-request tracker and counts knowledge-face loads.
 *
 * R50 (2026-11-26) removed the composite-tool mechanism, so this listener no
 * longer performs near-miss detection, hints, or any kind of registration. Its
 * two remaining jobs are:
 *   1. feed one tool observation into the in-request recall tracker (repeat
 *      recall, requirement A);
 *   2. when the model loads one of our skills (the skill tool with an sm-* name),
 *      increment the capability's loadCount — the denominator of the
 *      loads-to-runs conversion shown in the panel.
 *
 * Host surface (verified): tools/post-execute is a waterfall; everything runs
 * after next(), an exception is logged and swallowed so the tool pipeline is
 * never broken.
 * @module supermemory/activity
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RepeatConfig, ToolObservation, Tracker } from './inrequest.ts'
import { workspaceKeyOf, type Store } from './store.ts'

export interface ActivityConfig {
  repeat: RepeatConfig
  /** Kept for config compatibility; R50 has no composite hints. */
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

/** Attach the tool-activity listener; returns the effect disposer. */
export function attachToolActivity(
  ctx: Context,
  store: Store | undefined,
  tracker: Tracker,
  config: ActivityConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
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
      if (name === 'skill') {
        const loaded = typeof observation.args.name === 'string' ? observation.args.name : ''
        if (loaded.startsWith('sm-')) {
          try {
            const { bumpCapabilityLoad } = await import('./capability.ts')
            await bumpCapabilityLoad(activeStore, workspaceKey, loaded)
          } catch { /* statistics are advisory */ }
        }
      }
      return decision
    } catch (error) {
      logger.warn('supermemory: tool activity skipped: ' + String(error).slice(0, 200))
      return decision
    }
  })
}
