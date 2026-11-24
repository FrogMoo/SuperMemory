/**
 * Shell-side Cordis context contract for the browser half.
 *
 * A MODULE file on purpose: module augmentation (`declare module`) only merges
 * with the real `@deepseek-ai/cordis` module from a module scope. Declaring
 * these on a global script file would SHADOW cordis and hide `ctx.get`/`ctx.effect`.
 *
 * Keep in sync with the shell's client-side services: the build does not
 * typecheck, so this is the only compile-time guard.
 */
export {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Localised dictionaries + translator binding. */
    locale: {
      register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
      bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
    }
    /** UI contribution registry (slot injection + registration). */
    slots: {
      inject(name: string, callback: () => () => void): () => void
      register(definition: unknown, component: unknown): () => void
      /**
       * R32 需求③: every live registration behind one slot (raw order, NOT the
       * per-cell winners). The card renderer uses it to delegate every message
       * it does not own back to the host's shipped node renderer. Optional:
       * a shell that does not expose it keeps the shipped renderers untouched.
       */
      entries?(name: string): ReadonlyArray<{
        options?: { key?: string; id?: string; priority?: number }
        component?: unknown
      }>
    }
    /** Client-side session navigation owned by the shell. */
    uiWorkspace: {
      openSession(sessionId: unknown): void
      /**
       * Start a New Session. The optional workspace id targets one workspace;
       * omission lets the shell inherit the current/most-recent workspace
       * (dsh-client-ui-workspace navigation contract).
       */
      startSession(workspaceId?: unknown): void
    }
  }
}
