/**
 * TopicSet data layer: CRUD, membership, and the per-session routing table.
 * All writes go through the `supermemory` domain; reads are synchronous.
 * Writes are AWAITED by callers that read the result back immediately — the
 * domain updates its in-memory map only when a queued write lands.
 * @module supermemory/topicsets
 */
import type { Store } from './store.ts'
import { newId } from './store.ts'
import type { Routing, TopicSet } from './schema.ts'

export interface CreateTopicSetInput {
  workspaceKey: string
  title: string
  summary?: string
  keywords?: string[]
  defaultModel?: TopicSet['defaultModel']
}

export async function createTopicSet(store: Store, input: CreateTopicSetInput): Promise<string> {
  const now = Date.now()
  const topicSetId = newId('ts')
  const record: TopicSet = {
    workspaceKey: input.workspaceKey,
    title: input.title,
    summary: input.summary ?? '',
    keywords: input.keywords ?? [],
    status: 'active',
    defaultModel: input.defaultModel,
    members: [],
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  }
  await store.topicsets.put(topicSetId, record)
  return topicSetId
}

export function getTopicSet(store: Store, topicSetId: string): TopicSet | undefined {
  return store.topicsets.get(topicSetId)
}

export function listTopicSets(store: Store, workspaceKey: string): Array<[string, TopicSet]> {
  const out: Array<[string, TopicSet]> = []
  for (const entry of store.topicsets.entries()) {
    if (entry[1].workspaceKey === workspaceKey && entry[1].status === 'active') out.push(entry)
  }
  out.sort((a, b) => b[1].lastActiveAt - a[1].lastActiveAt)
  return out
}

/** Topic-set ids of one workspace (episodes/dispatches join through them). */
export function topicSetIdsOf(store: Store, workspaceKey: string): Set<string> {
  const ids = new Set<string>()
  for (const [id, record] of store.topicsets.entries()) {
    if (record.workspaceKey === workspaceKey) ids.add(id)
  }
  return ids
}

export async function touchTopicSet(store: Store, topicSetId: string): Promise<void> {
  const existing = store.topicsets.get(topicSetId)
  if (!existing) return
  await store.topicsets.update(topicSetId, (record) => ({ ...record, lastActiveAt: Date.now(), updatedAt: Date.now() }))
    .catch(() => { /* touch is best-effort */ })
}

export async function updateTopicSetSummary(store: Store, topicSetId: string, summary: string, keywords?: string[]): Promise<void> {
  await store.topicsets.update(topicSetId, (record) => ({
    ...record,
    summary,
    ...(keywords ? { keywords } : {}),
    updatedAt: Date.now(),
  })).catch(() => { /* summary update is best-effort */ })
}

export async function setTopicSetModel(store: Store, topicSetId: string, model: TopicSet['defaultModel']): Promise<void> {
  await store.topicsets.update(topicSetId, (record) => ({ ...record, defaultModel: model, updatedAt: Date.now() }))
    .catch(() => { /* model update is best-effort */ })
}

export async function addMember(
  store: Store,
  topicSetId: string,
  member: { sessionId: string; kind: 'root' | 'fork'; title?: string; model?: string },
): Promise<void> {
  await store.topicsets.update(topicSetId, (record) => {
    if (record.members.some((m) => m.sessionId === member.sessionId)) return record
    const now = Date.now()
    return {
      ...record,
      members: [...record.members, {
        sessionId: member.sessionId,
        kind: member.kind,
        title: member.title ?? '',
        summary: '',
        status: 'live',
        model: member.model,
        modelOverridden: false,
        lastActiveAt: now,
      }],
      lastActiveAt: now,
      updatedAt: now,
    }
  })
}

export async function updateMember(
  store: Store,
  topicSetId: string,
  sessionId: string,
  patch: Partial<{ title: string; summary: string; status: 'live' | 'idle'; model: string; modelOverridden: boolean }>,
): Promise<void> {
  await store.topicsets.update(topicSetId, (record) => ({
    ...record,
    members: record.members.map((m) => (m.sessionId === sessionId
      ? { ...m, ...patch, lastActiveAt: Date.now() }
      : m)),
    updatedAt: Date.now(),
  })).catch(() => { /* member update is best-effort */ })
}

/** Routing table: one row per session. */
export function getRouting(store: Store, sessionId: string): Routing | undefined {
  return store.routing.get(sessionId)
}

export async function setRouting(store: Store, sessionId: string, patch: { activeTopicSetId?: string; driftCount?: number }): Promise<void> {
  const existing = store.routing.get(sessionId)
  const next: Routing = {
    activeTopicSetId: patch.activeTopicSetId !== undefined ? patch.activeTopicSetId : existing?.activeTopicSetId,
    driftCount: patch.driftCount !== undefined ? patch.driftCount : existing?.driftCount ?? 0,
    updatedAt: Date.now(),
  }
  await store.routing.put(sessionId, next)
}

/** Members of one topic set that look relevant to a task (rule: keyword overlap). */
export function rankMembers(
  topicSet: TopicSet,
  taskTokens: Set<string>,
): TopicSet['members'] {
  return [...topicSet.members].sort((a, b) => {
    const score = (m: TopicSet['members'][number]) => {
      // NOTE: the old [...m.title, ...m.summary] spread the STRINGS into single
      // characters, so bag.has(wordToken) was always false and ranking silently
      // degraded to lastActiveAt (which also broke the auto/fork decision).
      const bag = new Set([m.title, m.summary].join(' ').toLowerCase().split(/[\s,，。.;；:：]+/).filter(Boolean))
      let hits = 0
      for (const token of taskTokens) if (bag.has(token)) hits++
      return hits
    }
    return score(b) - score(a) || b.lastActiveAt - a.lastActiveAt
  })
}
