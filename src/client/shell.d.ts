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
    }
    /** Client-side session navigation owned by the shell. */
    uiWorkspace: {
      openSession(sessionId: unknown): void
      startSession(): void
    }
  }
}
