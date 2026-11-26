/**
 * Custom message source declaration for the supermemory producer.
 *
 * `kind` answers who produced the message; `form` (official vocabulary) answers
 * what kind of thing it is. `deliveryId` is our own field — it is NOT a shared
 * MessageSource field — and carries the outbox idempotency key for relays.
 *
 * R57: the host's Chat row derives its 「上下文注入 <label>」 label from
 * `source.kind` (dsh-client-ui-chat conversation-nodes/event-projection.ts:60
 * `contextProducer`: default branch label = kind). To give each injection its
 * own card title we therefore emit ONE kind per registered card name:
 * `injectionSource(kind)` sets source.kind = `injectionLabel(kind)`, while the
 * card's first content line stays `injectionTitle(kind)` = `[label]`.
 * Relay/dispatch sources keep the private `supermemory` kind: the relay pipeline
 * confirms deliveries by that kind + deliveryId and their cards are rendered by
 * this plugin's own client card, not by the host's injection row.
 * @module supermemory/source
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { INJECTION_TITLES, type InjectionKind, type InjectionLabel } from './injection-titles.ts'

/** One registered card label (the host's 「上下文注入 <label>」 segment). */
export type InjectionSourceKind = InjectionLabel

/**
 * The source of one plugin injection card: `kind` IS the card label, so a
 * reader of the durable log and the Chat row agree without a second mapping.
 */
export type InjectionSource<K extends InjectionKind = InjectionKind> =
  { readonly kind: (typeof INJECTION_TITLES)[K] } & ContextFormed

/**
 * Register every card label as its own merge-extensible `MessageSourceMap`
 * entry: the host keeps unknown producers visible by their durable kind, and
 * typing them here keeps `createUserMessage` honest at the call sites.
 */
type InjectionSourceMap = { readonly [K in InjectionLabel]: { readonly kind: K } & ContextFormed }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap extends InjectionSourceMap {}
  interface MessageSourceMap {
    supermemory: { kind: 'supermemory'; deliveryId?: string } & ContextFormed
  }
}

export type SupermemorySource =
  | InjectionSource
  | { kind: 'supermemory'; form?: never; deliveryId?: string }
  | { kind: 'supermemory'; form: 'recall' }
  | { kind: 'supermemory'; form: 'relay'; deliveryId?: string }

/**
 * Build one injection card's source. The label comes from the registry — never
 * hand-write `kind: 'supermemory'` for a card (that would collapse every card
 * back to the same 「上下文注入 supermemory」 title).
 * @param kind - Registered card kind.
 * @param formed - Host presentation form (and its required fields), if any.
 * @returns The message source whose `kind` is the card label.
 */
export function injectionSource<K extends InjectionKind>(
  kind: K,
  formed: ContextFormed = {},
): InjectionSource<K> {
  return { kind: INJECTION_TITLES[kind], ...formed } as InjectionSource<K>
}
