/**
 * R19 需求⑥: LLM-authored topic-set shape (title + tags + body).
 *
 * A topic set is the retrieval index of a conversation; asking a human (or the
 * hub model) to invent its title/tags/summary on every activation is exactly
 * the kind of bookkeeping an LLM should do. This module:
 *
 * 1. builds a bounded corpus of what the set currently contains (members,
 *    archived episodes, requirements, recent dispatches);
 * 2. asks the configured model for `{title, tags, summary}` in strict JSON;
 * 3. writes only the fields that parsed, and **keeps the old values on any
 *    failure** (no model, timeout, malformed JSON);
 * 4. throttles regeneration: a set whose content fingerprint did not change
 *    never calls the model, and even a changed set is regenerated at most once
 *    per {@link TOPIC_SHAPE_MIN_INTERVAL_MS}.
 *
 * The fingerprint is persisted on the topic-set row (`shapeFingerprint`), so a
 * plugin reload does not re-burn tokens for a set that was already generated.
 * @module supermemory/topic-shape
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TopicSet } from './schema.ts'
import type { Store } from './store.ts'
import { updateTopicSetShape } from './topicsets.ts'
import { enumerateModels, hubSelection } from './model.ts'
import { TITLE_MAX, normalizeTags } from './retrieval.ts'

/** Hard cap of an LLM-generated topic-set body (the UI also caps at 500). */
export const TOPIC_SHAPE_SUMMARY_MAX = 500

/** A changed set is regenerated at most this often (token guard). */
export const TOPIC_SHAPE_MIN_INTERVAL_MS = 3 * 60_000

/** One parsed model answer. */
export interface TopicShape {
  title: string
  tags: string[]
  summary: string
}

/** What the generator may use as context for a new/updated set. */
export interface TopicShapeInput {
  title: string
  tags?: readonly string[]
  summary?: string
  /** Extra free text (e.g. the creator's seed) appended to the corpus. */
  seedText?: string
  /** Existing set whose members/episodes/requirements feed the corpus. */
  topicSetId?: string
}

export interface TopicShapeDeps {
  ctx?: Context
  store: Store
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void }
}

interface LlmStreamChunkLike {
  type?: string
  text?: string
}

interface LlmLike {
  stream?(options: Record<string, unknown>): AsyncIterable<LlmStreamChunkLike>
}

/** Last attempt per set id (throttle, including failures). */
const lastAttemptAt = new Map<string, number>()
/** In-flight regenerations, so two activations do not call twice. */
const inflight = new Map<string, Promise<void>>()

/** FNV-1a 32-bit, hex — a cheap stable digest for the content snapshot. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * Content snapshot of one set: everything a regeneration would read. The
 * persisted row's own title/tags/body participate, so a manual edit also marks
 * the set stale (the next activation refines it once).
 */
export function topicSetFingerprint(
  store: Store,
  topicSetId: string,
  overrides: Partial<Pick<TopicSet, 'title' | 'summary' | 'keywords'>> = {},
): string {
  const record = store.topicsets.get(topicSetId)
  if (!record) return ''
  const topicSet = { ...record, ...overrides }
  const parts: string[] = [topicSet.title, topicSet.summary, topicSet.keywords.join(',')]
  for (const member of topicSet.members) {
    parts.push(`m:${member.sessionId}:${member.kind}:${member.title}:${member.summary}:${member.status}:${member.lastActiveAt}`)
  }
  for (const [id, episode] of store.episodes.entries()) {
    if (episode.topicSetId !== topicSetId) continue
    parts.push(`e:${id}:${episode.timeEnd}:${episode.summary}:${episode.decisions.join('|')}`)
  }
  for (const [id, requirement] of store.requirements.entries()) {
    if (requirement.topicSetId !== topicSetId) continue
    parts.push(`r:${id}:${requirement.status}:${requirement.text}`)
  }
  for (const [id, dispatch] of store.dispatches.entries()) {
    if (dispatch.topicSetId !== topicSetId) continue
    parts.push(`d:${id}:${dispatch.status}:${dispatch.updatedAt ?? dispatch.createdAt}:${dispatch.task}`)
  }
  const joined = parts.join('\n')
  return `${fnv1a(joined)}-${joined.length}`
}

/**
 * Bounded textual corpus of one set's current content. Recent episodes and
 * open requirements come first (they are the durable conclusions), then member
 * titles and recent dispatch tasks.
 */
export function buildTopicCorpus(store: Store, topicSetId: string, maxChars = 4000): string {
  const topicSet = store.topicsets.get(topicSetId)
  if (!topicSet) return ''
  const lines: string[] = [
    `话题集：${topicSet.title}`,
    ...(topicSet.keywords.length ? [`现有标签：${topicSet.keywords.join('、')}`] : []),
    ...(topicSet.summary ? [`现有正文：${topicSet.summary}`] : []),
  ]
  const episodes = [...store.episodes.entries()]
    .filter(([, episode]) => episode.topicSetId === topicSetId)
    .sort((a, b) => b[1].timeEnd - a[1].timeEnd)
    .slice(0, 5)
  if (episodes.length > 0) {
    lines.push('最近归档结论：')
    for (const [, episode] of episodes) {
      lines.push(`- ${episode.summary || '（无梗概）'}${episode.decisions.length ? `；决策：${episode.decisions.join('；')}` : ''}`)
    }
  }
  const requirements = [...store.requirements.entries()]
    .filter(([, requirement]) => requirement.topicSetId === topicSetId)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, 5)
  if (requirements.length > 0) {
    lines.push('需求：')
    for (const [, requirement] of requirements) lines.push(`- [${requirement.status}] ${requirement.text}`)
  }
  const members = topicSet.members.slice(0, 10)
  if (members.length > 0) {
    lines.push('会话：')
    for (const member of members) {
      lines.push(`- ${member.kind === 'fork' ? '分支' : '中枢'} ${member.title || member.sessionId}${member.summary ? `：${member.summary}` : ''}`)
    }
  }
  const dispatches = [...store.dispatches.entries()]
    .filter(([, dispatch]) => dispatch.topicSetId === topicSetId)
    .sort((a, b) => (b[1].updatedAt ?? b[1].createdAt) - (a[1].updatedAt ?? a[1].createdAt))
    .slice(0, 6)
  if (dispatches.length > 0) {
    lines.push('最近派发：')
    for (const [, dispatch] of dispatches) lines.push(`- [${dispatch.status}] ${dispatch.task.slice(0, 160)}`)
  }
  return lines.join('\n').slice(0, maxChars)
}

/**
 * Resolve the route used for generation: the set's own default model, the hub
 * model of the acting session, then the first enumerated route. `undefined`
 * means "no model available" — callers then keep the old shape.
 */
export async function resolveTopicShapeModel(
  ctx: Context | undefined,
  store: Store,
  topicSetId: string,
  sessionId?: string,
): Promise<{ provider: string; model: string; reasoningEffort?: string } | undefined> {
  if (!ctx) return undefined
  const topicSet = store.topicsets.get(topicSetId)
  if (topicSet?.defaultModel?.provider && topicSet.defaultModel.model) return { ...topicSet.defaultModel }
  if (sessionId) {
    try {
      const agent = (ctx as unknown as { agents?: { get?: (id: string) => unknown } }).agents?.get?.(sessionId)
      const hub = hubSelection(agent)
      if (hub) return hub
    } catch { /* no live agent: fall through to the catalog */ }
  }
  try {
    const { models } = await enumerateModels(ctx)
    const first = models[0]
    if (first) return { provider: first.provider, model: first.id }
  } catch { /* no catalog: no model */ }
  return undefined
}

/** Strip code fences/quotes and collapse the title to one line. */
function cleanTitle(value: string, fallback: string): string {
  let text = String(value ?? '').trim()
  text = text.replace(/^```[a-z]*\s*|```$/gi, '').replace(/^["'「『]+|["'」』]+$/g, '').trim()
  text = text.split(/\r?\n/)[0]?.trim() || ''
  if (!text) return fallback.slice(0, TITLE_MAX)
  return Array.from(text).slice(0, TITLE_MAX).join('')
}

/** Validate one parsed answer; an unusable answer yields undefined. */
export function normalizeTopicShape(raw: unknown, fallbackTitle: string): TopicShape | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as { title?: unknown; tags?: unknown; summary?: unknown }
  const title = cleanTitle(String(record.title ?? ''), fallbackTitle)
  const tags = normalizeTags(record.tags).slice(0, 8)
  const summary = String(record.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, TOPIC_SHAPE_SUMMARY_MAX)
  if (!title && tags.length === 0 && !summary) return undefined
  return { title, tags, summary }
}

/** Extract the first JSON object from a model answer (fences tolerated). */
export function parseTopicShapeText(text: string, fallbackTitle: string): TopicShape | undefined {
  const clean = String(text ?? '').replace(/```[a-z]*/gi, '').replace(/```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return normalizeTopicShape(JSON.parse(clean.slice(start, end + 1)), fallbackTitle)
  } catch {
    return undefined
  }
}

/**
 * One model call. Returns undefined when there is no model, the call fails, it
 * times out (20 s), or the answer does not contain a usable JSON object — the
 * caller keeps the old shape in every one of those cases.
 */
export async function generateTopicShape(
  deps: TopicShapeDeps,
  input: TopicShapeInput,
  route?: { provider: string; model: string; reasoningEffort?: string },
): Promise<TopicShape | undefined> {
  const { ctx, store } = deps
  if (!ctx) return undefined
  let llm: LlmLike | undefined
  try {
    llm = (ctx as unknown as { get?: (name: string) => unknown }).get?.('llm') as LlmLike | undefined
  } catch {
    llm = undefined
  }
  if (!llm || typeof llm.stream !== 'function') return undefined
  const selected = route ?? (input.topicSetId ? await resolveTopicShapeModel(ctx, store, input.topicSetId) : undefined)
  if (!selected) return undefined
  const corpus = input.topicSetId ? buildTopicCorpus(store, input.topicSetId) : ''
  const context = [
    corpus,
    input.seedText ? `补充说明：${input.seedText}` : '',
    `当前标题：${input.title}`,
    input.tags && input.tags.length ? `当前标签：${input.tags.join('、')}` : '当前标签：（无）',
    `当前正文：${input.summary || '（无）'}`,
  ].filter(Boolean).join('\n').slice(0, 6000)
  const system = [
    '你在维护 SuperMemory 话题集的检索索引。只输出一个 JSON 对象，不要代码围栏、不要解释。',
    '字段：{"title":"一句话可扫读的标题（≤40字）","tags":["3–8个短词"],"summary":"这个话题集要做什么、已经形成的结论与决策（≤300字）"}',
    '内容必须是结论性、可复用的事实或决策；禁止过程流水账（谁先做了什么、执行了哪些命令、第几步、工具调用日志）。',
    '标题要稳定：除非旧标题明显跑题，否则沿用它的措辞。',
  ].join('\n')
  const user = `请根据以下材料重新生成话题集索引：\n\n${context}\n\n只返回 JSON。`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  let text = ''
  try {
    const stream = llm.stream({
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 600,
      temperature: 0.2,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
  } catch (error) {
    deps.logger?.warn(`supermemory: topic-shape generation failed: ${String(error).slice(0, 160)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
  const shape = parseTopicShapeText(text, input.title)
  if (!shape) deps.logger?.warn('supermemory: topic-shape answer did not contain usable JSON; keeping the old shape')
  return shape
}

/**
 * Fill a freshly created set. The creator-supplied title is authoritative; only
 * empty tags/body are filled, so an explicit seeding is never overwritten.
 * Both layers already present = no model call at all.
 */
export async function fillTopicShapeOnCreate(
  deps: TopicShapeDeps,
  topicSetId: string,
  seedText = '',
  fill: { tags?: boolean; summary?: boolean } = {},
): Promise<TopicShape | undefined> {
  const { store } = deps
  const topicSet = store.topicsets.get(topicSetId)
  if (!topicSet) return undefined
  // Callers that only DERIVED tags locally (panel/webui) ask for a model fill
  // explicitly; the default still fills only genuinely empty layers.
  const needTags = fill.tags ?? (topicSet.keywords.length === 0)
  const needSummary = fill.summary ?? (!topicSet.summary.trim())
  if (!needTags && !needSummary) return undefined
  const shape = await generateTopicShape(deps, {
    title: topicSet.title,
    tags: topicSet.keywords,
    summary: topicSet.summary,
    seedText,
    topicSetId,
  })
  if (!shape) return undefined
  const summary = needSummary ? (shape.summary || topicSet.summary) : topicSet.summary
  const keywords = needTags ? (shape.tags.length ? shape.tags : topicSet.keywords) : topicSet.keywords
  // Fingerprint the shape that is ABOUT to be written — hashing the pre-write
  // row would make the very next activation look stale and re-burn tokens.
  const fingerprint = topicSetFingerprint(store, topicSetId, { title: topicSet.title, summary, keywords })
  await updateTopicSetShape(store, topicSetId, {
    title: topicSet.title,
    summary,
    keywords,
    fingerprint,
    generatedAt: Date.now(),
  })
  return shape
}

/**
 * Regenerate one set after an activation **only when its content changed**.
 *
 * Guards: archived sets are skipped; an unchanged fingerprint is skipped; a
 * changed set is regenerated at most once per {@link TOPIC_SHAPE_MIN_INTERVAL_MS};
 * concurrent callers share one in-flight promise. Failure keeps the old
 * title/tags/body and the old fingerprint (the next activation retries, still
 * under the throttle).
 */
export function maybeRefreshTopicShape(
  deps: TopicShapeDeps,
  topicSetId: string,
  reason = 'activation',
): Promise<void> {
  const { store } = deps
  const topicSet = store.topicsets.get(topicSetId)
  if (!topicSet || topicSet.status !== 'active') return Promise.resolve()
  const fingerprint = topicSetFingerprint(store, topicSetId)
  if (topicSet.shapeFingerprint && topicSet.shapeFingerprint === fingerprint) return Promise.resolve()
  const now = Date.now()
  const previous = lastAttemptAt.get(topicSetId) ?? 0
  if (now - previous < TOPIC_SHAPE_MIN_INTERVAL_MS) return Promise.resolve()
  const running = inflight.get(topicSetId)
  if (running) return running
  lastAttemptAt.set(topicSetId, now)
  const run = (async (): Promise<void> => {
    try {
      const shape = await generateTopicShape(deps, {
        title: topicSet.title,
        tags: topicSet.keywords,
        summary: topicSet.summary,
        seedText: '',
        topicSetId,
      })
      if (!shape) return
      const latest = store.topicsets.get(topicSetId)
      if (!latest) return
      const title = shape.title || latest.title
      const summary = shape.summary || latest.summary
      const keywords = shape.tags.length ? shape.tags : latest.keywords
      const fingerprint = topicSetFingerprint(store, topicSetId, { title, summary, keywords })
      await updateTopicSetShape(store, topicSetId, {
        title,
        summary,
        keywords,
        fingerprint,
        generatedAt: Date.now(),
      })
      deps.logger?.info?.(`supermemory: refreshed topic shape for ${latest.title} (${reason})`)
    } catch (error) {
      deps.logger?.warn(`supermemory: topic-shape refresh skipped: ${String(error).slice(0, 160)}`)
    } finally {
      inflight.delete(topicSetId)
    }
  })()
  inflight.set(topicSetId, run)
  return run
}

/** Activation hook: fire-and-forget, never blocks or fails the routing write. */
export function noteTopicSetActivated(deps: TopicShapeDeps, topicSetId: string): void {
  void maybeRefreshTopicShape(deps, topicSetId, 'activation').catch(() => { /* already logged */ })
}

/** Test seam: drop the throttle/in-flight state. */
export function resetTopicShapeState(): void {
  lastAttemptAt.clear()
  inflight.clear()
}

/** The shape fields a UI renders (kept separate from the stored record type). */
export function shapeOf(topicSet: TopicSet): TopicShape {
  return { title: topicSet.title, tags: topicSet.keywords, summary: topicSet.summary }
}
