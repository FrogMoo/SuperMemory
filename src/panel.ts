/**
 * Host-side panel data channel (§1.5): a `supermemoryPanel` service exposed to
 * the Web client through the typert remote registry, so the sidebar half (P1.5,
 * deferred) can list topic sets and activate one. The command/tool fallbacks
 * (/memory topicsets, /memory switch, memory_topicsets) cover the same data
 * today; this service is the seam the client bundle will call.
 * @module supermemory/panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'
import { getRouting, listTopicSets, setRouting, touchTopicSet } from './topicsets.ts'

export interface TopicSetView {
  id: string
  title: string
  summary: string
  branches: Array<{ sessionId: string; title: string; status: string; model?: string }>
  model?: string
}

/** Plain data service (no host imports needed at definition time). */
export class SupermemoryPanelService {
  constructor(private readonly store: Store) {}

  /** Topic sets of one workspace, newest first. */
  listTopicSets(cwd: string): TopicSetView[] {
    const workspaceKey = workspaceKeyOf(cwd)
    return listTopicSets(this.store, workspaceKey).map(([id, topicSet]) => ({
      id,
      title: topicSet.title,
      summary: topicSet.summary,
      branches: topicSet.members.map((m) => ({
        sessionId: m.sessionId,
        title: m.title,
        status: m.status,
        ...(m.model ? { model: m.model } : {}),
      })),
      ...(topicSet.defaultModel ? { model: `${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}` } : {}),
    }))
  }

  /** Activate a topic set for one session (sidebar click). */
  activate(sessionId: string, topicSetId: string): boolean {
    const topicSet = this.store.topicsets.get(topicSetId)
    if (!topicSet) return false
    void setRouting(this.store, sessionId, { activeTopicSetId: topicSetId, driftCount: 0 })
    void touchTopicSet(this.store, topicSetId)
    return true
  }

  /** The active topic set of one session. */
  activeTopicSet(sessionId: string): TopicSetView | undefined {
    const active = getRouting(this.store, sessionId)?.activeTopicSetId
    if (!active) return undefined
    const topicSet = this.store.topicsets.get(active)
    if (!topicSet) return undefined
    return {
      id: active,
      title: topicSet.title,
      summary: topicSet.summary,
      branches: topicSet.members.map((m) => ({
        sessionId: m.sessionId,
        title: m.title,
        status: m.status,
        ...(m.model ? { model: m.model } : {}),
      })),
      ...(topicSet.defaultModel ? { model: `${topicSet.defaultModel.provider}/${topicSet.defaultModel.model}` } : {}),
    }
  }
}

/** Remote descriptors for the panel service (wire contract). */
const PANEL_DESCRIPTORS = Object.freeze([
  {
    id: 'dsh-supermemory#supermemoryPanel/listTopicSets',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'listTopicSets',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetViews', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [{ name: 'cwd', wire: 'cwd', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#Cwd', create: () => ({ parse: (v: unknown) => v }) } }],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/activate',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'activate',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#ActivateResult', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionId', create: () => ({ parse: (v: unknown) => v }) } },
      { name: 'topicSetId', wire: 'topicSetId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetId', create: () => ({ parse: (v: unknown) => v }) } },
    ],
  },
  {
    id: 'dsh-supermemory#supermemoryPanel/activeTopicSet',
    service: 'supermemoryPanel', namespace: 'supermemoryPanel', method: 'activeTopicSet',
    invocation: { kind: 'direct' },
    result: { mode: 'strict', typeSymbol: 'dsh-supermemory#TopicSetView', create: () => ({ parse: (v: unknown) => v }) },
    parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict', typeSymbol: 'dsh-supermemory#SessionId', create: () => ({ parse: (v: unknown) => v }) } }],
  },
])

/** Mount the panel service + register its remote descriptors. */
export function attachPanel(ctx: Context, store: Store | undefined): () => void {
  if (!store) return () => {}
  const service = new SupermemoryPanelService(store)
  ctx.provide('supermemoryPanel', service)
  try {
    (ctx as unknown as { typert?: { register: (entry: unknown) => void } }).typert?.register({
      package: 'dsh-supermemory',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: PANEL_DESCRIPTORS,
    })
  } catch { /* typert registration is best-effort in hosts without it */ }
  return () => { /* service disposal is fiber-scoped */ }
}
