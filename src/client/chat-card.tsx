/**
 * R32 需求③——render hub↔branch requests as ONE collapsible card in both
 * directions, titled "来自 <来源会话> 的执行请求".
 *
 * Why a client slot and not just the host card:
 *   - the host's turn-trigger card derives its title only from \`source.kind\`
 *     ("收到执行请求") and a branch's first dispatch input is a \`user\` message
 *     (R25 recency), so neither direction carries the sender's name;
 *   - the plugin owns the messages that carry its marker (\\`chat-card.ts\\`), so it
 *     shadows the two keyed cells (\`user\`, \`turn-trigger\`) at priority -100 and
 *     delegates EVERY other message back to the host's shipped renderer via
 *     \`entries()\`. Other triggers (goal/subagent/schedule/...) are untouched.
 *
 * The slot machinery is DSH's documented replacement path for a keyed cell;
 * only the client bundle is replaced here, the host checkout is never edited.
 * @module supermemory/client/chat-card
 */
import { createElement as h, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { cardMetaOf, cardSourceLabel, type ChatCardMeta } from '../chat-card.ts'
import { NS } from './locales.ts'

/**
 * The keyed cells this card can own (host node kinds). A hub relay can land as
 * a waking turn-trigger, a queued context row, or an in-turn steering row
 * depending on the hub's state; a branch dispatch lands as user/steering. All
 * four delegate non-card messages back to the shipped renderer.
 */
type CardCell = 'user' | 'steering' | 'turn-trigger' | 'context'

/** Props injected into each registered card component. */
interface ChatCardEnv {
  t: (key: string, params?: Record<string, string | number>) => string
  findOriginal: (key: string, ours: string) => unknown
}

/**
 * The host's ChatNode payload (contract/snapshot.ts): the renderer key and
 * content live under `node.data`, NOT at the node's top level. Reading
 * `node.source` (the pre-R33 bug) always yielded undefined, so no message was
 * ever recognised as a card and every card silently delegated/blanked.
 */
interface CardNode {
  kind?: string
  data?: {
    content?: unknown
    source?: unknown
    time?: unknown
  }
}

/**
 * The host locale namespace the keyed chat cells are registered under. The
 * shipped renderers' `t` comes from the registration's `locale` option, so a
 * shadowing cell that omits it hands the host renderer `t === undefined`.
 */
const CHAT_LOCALE_NS = 'chat'

/**
 * Delegation props for the host's shipped renderer.
 *
 * The shipped UserMessageNodeView needs `t` (from `locale`) and
 * `renderSlotChain` (from a declared child, or an injected no-op); the
 * turn-trigger/context views need `t`. The host injects both through our
 * registration, but a shell that binds our cell without the locale/child face
 * must not turn every ordinary message into a crashed slot entry, so fill the
 * missing two defensively. A no-op `renderSlotChain` drops the
 * `conversation.chat.user.before` decoration of a delegated user message —
 * documented in DEV-NOTES §43.
 */
function delegationProps(props: Record<string, unknown>, env: ChatCardEnv | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = { ...props }
  if (typeof next.t !== 'function' && env) next.t = env.t
  if (typeof next.renderSlotChain !== 'function') next.renderSlotChain = () => null
  return next
}

const CARD_ID_PREFIX = 'supermemory-chat-card'
const CSS_ID = 'supermemory-chat-card-css'

/** One translator bound at render time (locale switches take effect). */
function translator(ctx: Context): ChatCardEnv['t'] {
  return (key, params) => {
    try {
      return ctx.locale.bind(NS)(key, params)
    } catch {
      return key
    }
  }
}

/** Find the host's shipped renderer for one keyed cell (skip our own entry). */
function findOriginal(ctx: Context, key: CardCell, ours: string): unknown {
  try {
    const entries = ctx.slots.entries?.('conversation.chat.node') ?? []
    // Raw registration order is not the shadow order: pick the lowest-priority
    // live entry for the same cell (the one this override displaced).
    const candidates = entries
      .filter((entry) => entry.options?.key === key && entry.options?.id !== ours && entry.component !== undefined)
      .sort((left, right) => (left.options?.priority ?? 0) - (right.options?.priority ?? 0))
    if (candidates.length > 0) return candidates[0].component
  } catch {
    // A shell without the raw entry view keeps the card OFF (see attach below).
  }
  return undefined
}

/** The text of a message's content blocks (the model-facing body). */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const shaped = block as { type?: unknown; text?: unknown }
    if (shaped.type === 'text' && typeof shaped.text === 'string' && shaped.text) parts.push(shaped.text)
  }
  return parts.join('\n')
}

/** Clock label for the card header (never a locale-dependent title). */
function clockText(time: unknown): string {
  if (typeof time !== 'number' || !Number.isFinite(time)) return ''
  try {
    return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** One field row, rendered only when the source actually carries it. */
function fieldRow(
  label: string,
  value: string,
  key: string,
): unknown {
  if (!value) return null
  return h('div', { key, className: 'sm-chat-card-field' },
    h('dt', { key: 'k', className: 'sm-chat-card-field-k' }, label),
    h('dd', { key: 'v', className: 'sm-chat-card-field-v' }, value),
  )
}

/** The collapsible card itself. */
function SupermemoryCard(props: { meta: ChatCardMeta; node: CardNode | undefined; env: ChatCardEnv | undefined }) {
  const { meta, node, env } = props
  const [open, setOpen] = useState(false)
  const t = env?.t ?? ((key: string) => key)
  const title = t('chat.card.from', { session: cardSourceLabel(meta) })
  const kind = t('chat.card.kind.' + meta.kind)
  const body = contentText(node?.data?.content)
  const time = clockText(node?.data?.time)
  const receipt = [meta.dispatchId, meta.status].filter(Boolean).join(' · ')
  // R43 ①: the card head is a <button> inside the shell's chat row, and a
  // document-level capture interceptor (the plugin's own new-session entry)
  // matched this button's text as a 新建会话 control and created a hub session
  // on every card click. The interceptor now skips `[data-supermemory-card]`;
  // stopping propagation here as well keeps any ANCESTOR bubble handler (row
  // click, navigation) from acting on a click that only expands the card.
  const toggle = (event: { stopPropagation?: () => void }): void => {
    try { event?.stopPropagation?.() } catch { /* a synthetic event without it is still a toggle */ }
    setOpen((value) => !value)
  }
  return h('section', {
    className: 'sm-chat-card',
    'data-supermemory-card': meta.kind,
  },
    h('button', {
      key: 'head', type: 'button', className: 'sm-chat-card-head',
      'aria-expanded': String(open),
      'aria-label': t(open ? 'chat.card.collapse' : 'chat.card.expand'),
      onClick: toggle,
    },
      h('span', { key: 'dot', className: 'sm-chat-card-dot', 'aria-hidden': 'true' }, '↔'),
      h('span', { key: 'title', className: 'sm-chat-card-title' }, title),
      h('span', { key: 'kind', className: 'sm-chat-card-badge' }, kind),
      time ? h('time', { key: 'time', className: 'sm-chat-card-time' }, time) : null,
      h('span', { key: 'chevron', className: 'sm-chat-card-chevron', 'aria-hidden': 'true' }, open ? '▴' : '▾'),
    ),
    open
      ? h('div', { key: 'body', className: 'sm-chat-card-body' },
          h('dl', { key: 'fields', className: 'sm-chat-card-fields' },
            fieldRow(t('chat.card.task'), meta.task, 'task'),
            fieldRow(t('chat.card.topicSet'), meta.topicSetTitle, 'set'),
            fieldRow(t('chat.card.capability'), meta.capability, 'cap'),
            fieldRow(t('chat.card.dispatch'), receipt, 'receipt'),
            meta.groupId ? fieldRow(t('chat.card.kind.group'), meta.groupId, 'group') : null,
            fieldRow(t('chat.card.sourceId'), meta.fromSessionId, 'source'),
          ),
          body
            ? h('pre', { key: 'text', className: 'sm-chat-card-text' }, body)
            : h('div', { key: 'empty', className: 'sm-chat-card-empty' }, t('chat.card.empty')),
        )
      : null,
  )
}

/**
 * Build the keyed-cell component for one host node kind.
 * Card-marked messages render the card; everything else is delegated to the
 * host's shipped renderer, so no other user/trigger message changes.
 */
function createCardComponent(key: CardCell, ours: string) {
  return function SupermemoryChatNodeCard(props: Record<string, unknown>) {
    const env = props.smCardEnv as ChatCardEnv | undefined
    const node = props.node as CardNode | undefined
    const meta = cardMetaOf(node?.data?.source)
    if (!meta) {
      const Original = env?.findOriginal(key, ours)
      if (Original !== undefined) return h(Original as never, delegationProps(props, env))
      // Defensive fallback for a shell that exposes registrations but whose
      // shipped renderer has not mounted yet: show the text, never a blank row.
      const fallback = contentText(node?.data?.content)
      return fallback
        ? h('div', { key: 'fallback', className: 'sm-chat-card-fallback' },
            h('pre', { key: 'text', className: 'sm-chat-card-text' }, fallback))
        : null
    }
    return h(SupermemoryCard, { meta, env, node })
  }
}

/** Register one cell (called for both directions). */
function registerCell(ctx: Context, key: CardCell): () => void {
  const id = CARD_ID_PREFIX + '-' + key
  return ctx.slots.register({
    name: 'conversation.chat.node',
    key,
    id,
    // Shadow the shipped cell (lower priority wins); every non-card message is
    // delegated back, so this is a replacement of presentation only.
    priority: -100,
    // R33: the shipped node renderers derive `t` from this namespace. Without
    // it a delegated message received `t === undefined` and crashed the slot.
    locale: CHAT_LOCALE_NS,
    inject: () => ({
      smCardEnv: {
        t: translator(ctx),
        findOriginal: (target: string, ours: string) => findOriginal(ctx, target as CardCell, ours),
      },
      // R33: `user` and `steering` share UserMessageNodeView, which calls
      // renderSlotChain unconditionally. Declaring the `conversation.chat.user.before`
      // child here would fail activation (the shipped `user` entry already owns
      // that declaration), so inject the same no-op the shipped `steering` entry
      // uses. Cost: the user-before decoration chain is not rendered for
      // delegated messages (DEV-NOTES §43).
      ...(key === 'user' || key === 'steering' ? { renderSlotChain: () => null } : {}),
    }),
  }, createCardComponent(key, id))
}

/** Inject the card stylesheet once per page. */
function ensureCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(CSS_ID)) return
  const style = document.createElement('style')
  style.id = CSS_ID
  style.textContent = `
.sm-chat-card{margin:6px 0;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));overflow:hidden;font-size:12.5px}
.sm-chat-card-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sm-chat-card-head:hover{background:rgba(255,255,255,.04)}
.sm-chat-card-dot{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));font-size:11px;opacity:.85}
.sm-chat-card-title{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-chat-card-badge{flex:none;font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));opacity:.8}
.sm-chat-card-time{flex:none;margin-left:auto;font-size:11px;opacity:.55}
.sm-chat-card-chevron{flex:none;font-size:11px;opacity:.6}
.sm-chat-card-body{padding:0 12px 10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
.sm-chat-card-fields{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:8px 0}
.sm-chat-card-field{display:contents}
.sm-chat-card-field-k{opacity:.6;white-space:nowrap}
.sm-chat-card-field-v{min-width:0;word-break:break-word}
.sm-chat-card-text{margin:0;padding:8px;border-radius:8px;background:rgba(0,0,0,.18);white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.5}
.sm-chat-card-empty{opacity:.6;padding:6px 0}
.sm-chat-card-fallback{margin:6px 0}
`
  document.head.append(style)
}

/**
 * Mount the two shadowing card cells.
 *
 * If the shell does not expose raw registrations, the plugin deliberately does
 * NOT shadow anything: replacing a cell without a way to delegate would blank
 * every ordinary user message. That degradation is logged (never silent).
 * @param ctx - browser root context.
 */
export function attachChatCards(ctx: Context): void {
  if (typeof ctx.slots.entries !== 'function') {
    console.warn('supermemory: conversation.chat.node entries() unavailable; hub/branch chat card not mounted')
    return
  }
  ensureCss()
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => {
    const cells: CardCell[] = ['user', 'steering', 'turn-trigger', 'context']
    const disposers = cells.map((cell) => registerCell(ctx, cell))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }), 'supermemory: chat card')
}
