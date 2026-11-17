/**
 * Ambient module contracts for the browser half (`src/client`).
 *
 * The client bundle is compiled against the SHELL's runtime, not against
 * installable packages: `react` is a platform-provided external, and the
 * shell-only client packages have no npm releases in this workspace. These
 * declarations pin exactly what the bundle imports so `tsc -p tsconfig.client.json`
 * can check it. Host-context augmentation lives in `shell.d.ts` (a module file,
 * as module augmentation requires).
 */

declare module 'react' {
  export type ReactNode = unknown
  export type ReactElement = unknown
  export function createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): ReactElement
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void]
  export function useState<S = undefined>(): [S | undefined, (next: S | undefined | ((previous: S | undefined) => S | undefined)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T>(callback: T, deps: readonly unknown[]): T
}

declare namespace React {
  type ReactElement = unknown
  type ReactNode = unknown
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {
  /** Opaque panel identifier accepted by the `main` slot key. */
  export type MainPanelId = string
}

declare module '@deepseek-ai/dsh-api-remotes/client' {
  export interface RemoteFailure {
    message?: string
  }
  export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }
}
