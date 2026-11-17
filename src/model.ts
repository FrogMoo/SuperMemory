/**
 * Model management (§1.4): topic-set default models chosen at creation time
 * from a RUNTIME enumeration (`ctx.llm.listProviders()` + `listModels()`),
 * with the hub model, free input, and an empty-catalog fallback; per-set and
 * per-branch overrides through `agent.model.select()`.
 * @module supermemory/model
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TopicSet } from './schema.ts'
import type { Store } from './store.ts'
import { setTopicSetModel, updateMember } from './topicsets.ts'

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelDeps {
  ctx: Context
  store: Store
  logger: { warn: (msg: string) => void; info: (msg: string) => void }
}

interface LlmRuntimeLike {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>>
}

/** The hub agent's current selection, when readable. */
export function hubSelection(agent: unknown): ModelSelection | undefined {
  const current = (agent as { model?: { current?: () => ModelSelection | undefined } })?.model?.current?.()
  if (current?.provider && current?.model) return { provider: current.provider, model: current.model, ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) }
  return undefined
}

/** Runtime enumeration of provider/model options for the question UI. */
export async function enumerateModels(ctx: Context): Promise<{ providers: Array<{ id: string; name: string }>; models: Array<{ provider: string; id: string; name: string }> }> {
  const llm = (ctx as unknown as { llm?: LlmRuntimeLike }).llm
  if (!llm) return { providers: [], models: [] }
  const providers = llm.listProviders()
  const models: Array<{ provider: string; id: string; name: string }> = []
  for (const provider of providers) {
    try {
      const list = await llm.listModels(provider.id)
      for (const m of list) models.push({ provider: m.provider || provider.id, id: m.id, name: m.name || m.id })
    } catch { /* an adapter without a catalog is legal; keep the others */ }
  }
  return { providers, models }
}

/**
 * Ask for a topic-set default model. Falls back to the hub model when the
 * question channel is unavailable (headless / no client).
 */
export async function askDefaultModel(deps: ModelDeps, agent: unknown): Promise<TopicSet['defaultModel'] | undefined> {
  const { ctx, logger } = deps
  const hub = hubSelection(agent)
  try {
    const { models } = await enumerateModels(ctx)
    const options = [
      ...(hub ? [{ label: '跟随中枢模型', description: `${hub.provider}/${hub.model}` }] : []),
      ...models.slice(0, 12).map((m) => ({ label: `${m.provider}/${m.id}`, description: m.name })),
    ]
    if (options.length === 0) {
      // empty catalog fallback: free input only
      const answer = await ctx.userQuestions.ask({
        questions: [{
          id: 'supermemory-model',
          header: '默认模型',
          question: '该话题集使用哪个默认模型？当前没有可用目录，请直接输入 provider 与 model（如 step step-5-preview）。',
        }],
        ...(agent ? { agent: agent as never } : {}),
      })
      return parseFreeInput(answer?.answers?.[0]?.custom ?? answer?.answers?.[0]?.selected?.[0])
    }
    const answer = await ctx.userQuestions.ask({
      questions: [{
        id: 'supermemory-model',
        header: '默认模型',
        question: '该话题集使用哪个默认模型？',
        options,
      }],
      ...(agent ? { agent: agent as never } : {}),
    })
    const selected = answer?.answers?.[0]?.selected?.[0] ?? ''
    const custom = answer?.answers?.[0]?.custom
    if (selected === '跟随中枢模型' && hub) return { ...hub }
    const fromSelected = selected.includes('/') ? selected.split('/', 2) : undefined
    if (fromSelected) return { provider: fromSelected[0], model: fromSelected[1] }
    return parseFreeInput(custom) ?? (hub ? { ...hub } : undefined)
  } catch (error) {
    logger.warn(`supermemory: default-model question unavailable: ${String(error).slice(0, 160)}`)
    return hub ? { ...hub } : undefined
  }
}

function parseFreeInput(raw: string | undefined): ModelSelection | undefined {
  if (!raw) return undefined
  const parts = raw.trim().split(/[\s,，/]+/).filter(Boolean)
  if (parts.length >= 2) return { provider: parts[0], model: parts[1] }
  return undefined
}

/** Apply a model selection to a live agent and/or persist it as an override. */
export async function applyModelSelection(
  deps: ModelDeps,
  target: { topicSetId?: string; branchSessionId?: string },
  selection: ModelSelection,
): Promise<{ applied: string; live: boolean }> {
  const { ctx, store, logger } = deps
  let live = false
  if (target.branchSessionId) {
    const agent = ctx.agents.get(target.branchSessionId as never)
    if (agent) {
      agent.model.select(selection as never)
      live = true
    }
    if (target.topicSetId) {
      await updateMember(store, target.topicSetId, target.branchSessionId, { model: `${selection.provider}/${selection.model}`, modelOverridden: true })
    }
    return { applied: target.branchSessionId, live }
  }
  if (target.topicSetId) {
    await setTopicSetModel(store, target.topicSetId, { ...selection })
    const topicSet = store.topicsets.get(target.topicSetId)
    for (const member of topicSet?.members ?? []) {
      if (member.modelOverridden) continue
      const agent = ctx.agents.get(member.sessionId as never)
      if (agent) { agent.model.select(selection as never); live = true }
      await updateMember(store, target.topicSetId, member.sessionId, { model: `${selection.provider}/${selection.model}` })
    }
    return { applied: target.topicSetId, live }
  }
  logger.warn('supermemory: applyModelSelection without target')
  return { applied: '', live }
}
