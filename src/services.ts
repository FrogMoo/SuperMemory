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
    /**
     * Live in-memory session store. A session exposes its log `append` method:
     * the shape required by the `session/title` fallback in title.ts.
     */
    sessions: {
      get(id: string): (SessionLike & {
        readonly seq?: number
        append?(type: string, data: unknown): unknown
      } & Record<string, unknown>) | undefined
    }
    /** Durable session-log persistence seam. */
    sessionPersistence: {
      open(id: string, access: 'read' | 'write'): Promise<{
        header?: { cwd?: string }
        read(offset?: number, length?: number): Promise<{ events: SessionEventLike[] }>
        close(): Promise<void>
      }>
    }
    /**
     * Log-backed session titles (`@deepseek-ai/dsh-session-title`). Host-internal
     * and OPTIONAL: read it with `ctx.get('sessionTitle')` so a profile without the
     * seam degrades to the log-append fallback instead of leaving the fiber pending.
     * `rename` appends a `session/title` event with `source: { kind: 'user' }`.
     */
    sessionTitle?: {
      get(session: unknown): { title: string; eventSeq?: number; updatedAt?: number } | undefined
      rename(session: unknown, title: string): unknown
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
    /**
     * Host HTTP server — the Web GUI's own carrier (dsh-host-webserver).
     * Optional: absent in headless/CLI profiles, so read it with ctx.get().
     */
    webServer?: {
      readonly port: number
      readonly protocol: string
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
    }
  }
}
