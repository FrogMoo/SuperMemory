/**
 * Local event and service declarations.
 *
 * The host packages that own `session/event`, `ctx.sessions`,
 * `ctx.sessionPersistence`, `ctx.commands` and `ctx.systemPrompt`
 * (`@deepseek-ai/dsh-session`, `-session-persistence`, `-commands`,
 * `-system-prompt`) are host-internal: they are not published and not part of
 * this workspace's type sources, so their Context/Events augmentations are not
 * visible here. These structural declarations cover exactly the surface this
 * plugin consumes; they are compile-time only and never shadow the host.
 * @module supermemory/services
 */
import type { SessionEventLike, SessionLike } from './events.ts'

export type { SessionEventLike, SessionLike }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event'(session: SessionLike, event: SessionEventLike): void
  }

  interface Context {
    /** Live in-memory session store. */
    sessions: {
      get(id: string): (SessionLike & Record<string, unknown>) | undefined
    }
    /** Durable session-log persistence seam. */
    sessionPersistence: {
      open(id: string, access: 'read' | 'write'): Promise<{
        header?: { cwd?: string }
        read(offset?: number, length?: number): Promise<{ events: SessionEventLike[] }>
        close(): Promise<void>
      }>
    }
    /** Slash-command runtime. */
    commands: {
      register(definition: {
        name: string
        description: string
        input?: { hint: string; attachments?: boolean }
        handler: (invocation: {
          agent?: { id?: string; session?: { header?: { cwd?: string } } }
          rawInput: string
          attachments: readonly unknown[]
          signal: AbortSignal
        }) => { kind: 'success'; text?: string } | { kind: 'error'; text: string } | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
      }): () => void
    }
    /** System-prompt assembly service. */
    systemPrompt: {
      section(section: {
        name: string
        order: number
        text: string | ((context: unknown) => string)
      }): () => void
    }
    /** User-question service (validation + scoped answerer waterfall). */
    userQuestions: {
      ask(request: {
        questions: Array<{
          id: string
          question: string
          header?: string
          detail?: string
          options?: Array<{ label: string; description?: string }>
          multiSelect?: boolean
        }>
        agent?: unknown
        signal?: AbortSignal
      }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
    }
    /** Workspace registry (project grouping; branch visibility). */
    workspaceRegistry: {
      resolveByPath(path: string): Promise<{ attachSession(sessionId: string): Promise<void> } | undefined>
      create(path: string, title?: string): Promise<{ attachSession(sessionId: string): Promise<void> }>
    }
  }
}
