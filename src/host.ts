/**
 * Host-anchored module loading.
 *
 * `@deepseek-ai/dsh-*` packages are NOT resolvable from a plugin's own package
 * scope (the profile's node_modules only hoists non-dsh runtime deps). The
 * proven third-party pattern (dsh-vscode-mode) resolves the specifier against
 * the running DSH entry (`process.argv[1]`) and imports the resolved file URL,
 * which lands on the host's bundled copy. Import failures after successful
 * resolution are preserved, not hidden by an older copy.
 * @module supermemory/host
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** One imported host module namespace. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModule = any

const cache = new Map<string, Promise<AnyModule>>()

/**
 * Import a host package, preferring the copy the running DSH entry resolves.
 * @param specifier - host package name, e.g. `@deepseek-ai/dsh-tools`.
 * @returns the evaluated module namespace (cached per specifier).
 */
export async function loadHostModule(specifier: string): Promise<AnyModule> {
  let pending = cache.get(specifier)
  if (!pending) {
    pending = (async () => {
      const anchor = process.argv[1]
      let resolved: string | undefined
      if (anchor) {
        try {
          resolved = createRequire(anchor).resolve(specifier)
        } catch {
          /* host does not provide it; fall back to the plugin scope */
        }
      }
      return resolved ? import(pathToFileURL(resolved).href) : import(specifier)
    })()
    cache.set(specifier, pending)
  }
  return pending
}
