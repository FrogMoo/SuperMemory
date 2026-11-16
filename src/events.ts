/**
 * Structural shapes of the session event stream (host-internal types).
 * @module supermemory/events
 */

/** The live session object as this plugin consumes it. */
export interface SessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/** One committed session-log event, as delivered by `session/event`. */
export interface SessionEventLike<
  T extends string = string,
  D = unknown,
> {
  readonly type: T
  readonly seq: number
  readonly time: number
  readonly data: D
}

/** `user/message` data: a durable user-role message. */
export interface UserMessageLike {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { type: string; text?: string }[]
  readonly source: { kind?: string; form?: string; deliveryId?: string }
}
