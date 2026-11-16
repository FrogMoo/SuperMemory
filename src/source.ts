/**
 * Custom message source declaration for the supermemory producer.
 *
 * `kind` answers who produced the message; `form` (official vocabulary) answers
 * what kind of thing it is. `deliveryId` is our own field — it is NOT a shared
 * MessageSource field — and carries the outbox idempotency key for relays.
 * @module supermemory/source
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    supermemory: { kind: 'supermemory'; deliveryId?: string } & ContextFormed
  }
}

export type SupermemorySource =
  | { kind: 'supermemory'; form?: never; deliveryId?: string }
  | { kind: 'supermemory'; form: 'recall' }
  | { kind: 'supermemory'; form: 'relay'; deliveryId?: string }
