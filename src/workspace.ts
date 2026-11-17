/**
 * Workspace visibility for branch sessions (§1.5 / P1): plugin-created
 * sessions do NOT join the project grouping automatically — `attachSession`
 * must be called explicitly, and it validates the session header's cwd
 * against the workspace's canonical path (which is why branches are created
 * with the hub's cwd).
 * @module supermemory/workspace
 */
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** Structural view of the workspace registry service. */
interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<{ attachSession(sessionId: string): Promise<void> } | undefined>
  create(path: string, title?: string): Promise<{ attachSession(sessionId: string): Promise<void> }>
}

export async function attachBranchToWorkspace(
  ctx: Context,
  branchSessionId: string,
  cwd: string,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<void> {
  const registry = (ctx as unknown as { workspaceRegistry?: WorkspaceRegistryLike }).workspaceRegistry
  if (!registry) {
    logger.warn('supermemory: workspaceRegistry unavailable; branch stays ungrouped')
    return
  }
  let path: string
  try {
    path = realpathSync(cwd)
  } catch {
    path = cwd
  }
  let workspace = await registry.resolveByPath(path)
  if (!workspace) {
    workspace = await registry.create(path)
    logger.info(`supermemory: created workspace for ${path}`)
  }
  await workspace.attachSession(branchSessionId)
}
