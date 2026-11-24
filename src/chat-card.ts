/**
 * R32 需求③——hub↔branch communication as one collapsible, dynamically titled
 * card in BOTH directions.
 *
 * The host renders a non-human message that wakes a turn as its own
 * `turn-trigger` card ("收到执行请求"), while a branch's first dispatch message
 * is a human-shaped `user` message (source.kind 'user') because the sidebar
 * recency contract only advances on those (R25). Neither renderer knows which
 * session sent the message.
 *
 * The plugin therefore attaches a small, JSON-safe source marker when it creates
 * those messages, and its client half renders the card for exactly those
 * messages (delegating every other user/turn-trigger node back to the host's
 * shipped renderer). This module is the pure, host-and-client shared contract:
 * no DOM, no Node APIs, no store import — the smoke suite and the browser import
 * the same functions, so the title/fallback cannot drift.
 * @module supermemory/chat-card
 */

/** Card direction/source family. */
export type ChatCardKind = 'hub' | 'branch' | 'group' | 'system'

/** Source field carrying the marker for a branch's dispatch input. */
export const DISPATCH_SOURCE_FORM = 'supermemory-dispatch'

/** Source field carrying the marker for a branch→hub relay. */
export const RELAY_SOURCE_FORM = 'relay'

/** The source fields the card reads (all optional on the wire). */
export interface ChatCardSource {
  kind?: string
  form?: string
  deliveryId?: string
  fromSessionId?: string
  fromTitle?: string
  fromKind?: string
  task?: string
  topicSetTitle?: string
  capability?: string
  dispatchId?: string
  groupId?: string
  status?: string
}

/** Fully normalized card metadata (missing strings become ''). */
export interface ChatCardMeta {
  kind: ChatCardKind
  fromSessionId: string
  fromTitle: string
  task: string
  topicSetTitle: string
  capability: string
  dispatchId: string
  groupId: string
  status: string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Last four characters of an id (the documented title fallback). */
export function idTail(id: unknown): string {
  const value = text(id).trim()
  return value.length > 4 ? value.slice(-4) : value
}

/** Parse the plugin's source marker; null for every message the card must not own. */
export function cardMetaOf(source: unknown): ChatCardMeta | null {
  const shaped = record(source)
  if (!shaped) return null
  const form = text(shaped.form)
  const kind = text(shaped.kind)
  const isRelay = kind === 'supermemory' && form === RELAY_SOURCE_FORM
  const isDispatch = form === DISPATCH_SOURCE_FORM
  if (!isRelay && !isDispatch) return null
  const rawKind = text(shaped.fromKind)
  const cardKind: ChatCardKind = rawKind === 'hub' || rawKind === 'branch' || rawKind === 'group' || rawKind === 'system'
    ? rawKind
    : isRelay ? 'branch' : 'hub'
  return {
    kind: cardKind,
    fromSessionId: text(shaped.fromSessionId),
    fromTitle: text(shaped.fromTitle),
    task: text(shaped.task),
    topicSetTitle: text(shaped.topicSetTitle),
    capability: text(shaped.capability),
    dispatchId: text(shaped.dispatchId),
    groupId: text(shaped.groupId),
    status: text(shaped.status),
  }
}

/**
 * The source label the card title uses: the sender's session title, else the
 * id's last four characters, else a neutral placeholder (never an empty title).
 */
export function cardSourceLabel(meta: Pick<ChatCardMeta, 'fromTitle' | 'fromSessionId'>): string {
  const title = text(meta.fromTitle).trim()
  if (title) return title
  const tail = idTail(meta.fromSessionId)
  return tail || '未知会话'
}

/** Build the relay message source (branch → hub). */
export function relaySource(input: {
  deliveryId: string
  fromSessionId?: string
  fromTitle?: string
  fromKind?: ChatCardKind
  dispatchId?: string
  groupId?: string
  status?: string
  /** R33 需求⑦: the branch→hub card keeps the same fields as the dispatch card. */
  task?: string
  topicSetTitle?: string
  capability?: string
}): ChatCardSource {
  return {
    kind: 'supermemory',
    form: RELAY_SOURCE_FORM,
    deliveryId: input.deliveryId,
    ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
    ...(input.fromTitle ? { fromTitle: input.fromTitle } : {}),
    ...(input.fromKind ? { fromKind: input.fromKind } : {}),
    ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    // R33: task / topic set / capability used to be dropped here, so the
    // branch→hub card's rows were always empty while the hub→branch card had
    // them. Both directions now carry the same field set.
    ...(input.task ? { task: input.task } : {}),
    ...(input.topicSetTitle ? { topicSetTitle: input.topicSetTitle } : {}),
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.status ? { status: input.status } : {}),
  }
}

/**
 * Build the branch's first dispatch message source.
 *
 * `kind` stays 'user' ON PURPOSE (R25): the host's sidebar recency projection
 * only advances on `user/message` with source.kind 'user'. The plugin's client
 * card renderer keys off `form`, so the branch still sees a card while the
 * session stays on top of the list.
 */
export function dispatchSource(input: {
  fromSessionId?: string
  fromTitle?: string
  task?: string
  topicSetTitle?: string
  capability?: string
  dispatchId?: string
  groupId?: string
  status?: string
}): ChatCardSource {
  return {
    kind: 'user',
    form: DISPATCH_SOURCE_FORM,
    fromKind: 'hub',
    ...(input.fromSessionId ? { fromSessionId: input.fromSessionId } : {}),
    ...(input.fromTitle ? { fromTitle: input.fromTitle } : {}),
    ...(input.task ? { task: input.task } : {}),
    ...(input.topicSetTitle ? { topicSetTitle: input.topicSetTitle } : {}),
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.status ? { status: input.status } : {}),
  }
}
