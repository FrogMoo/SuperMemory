/**
 * Slash commands: `/memory` (P0: `status` only).
 *
 * Command names are lowercase without the leading slash; sub-arguments arrive
 * verbatim in `invocation.rawInput` and are parsed by the handler — the host
 * has no sub-command schema.
 * @module supermemory/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from './store.ts'
import { workspaceKeyOf } from './store.ts'

export interface CommandsDeps {
  store: Store | undefined
  workspaceKeyOfCwd: (cwd: string | undefined) => string
}

/** Attach the /memory command; returns the effect disposer. */
export function attachCommands(ctx: Context, deps: CommandsDeps): () => void {
  return ctx.commands.register({
    name: 'memory',
    description: 'SuperMemory 记忆总览：/memory status 查看记忆库状态',
    handler: async (invocation) => {
      const sub = (invocation.rawInput ?? '').trim().split(/\s+/)[0] ?? ''
      if (sub === '' || sub === 'status') {
        const store = deps.store
        if (!store) return { kind: 'error' as const, text: 'SuperMemory 存储域未打开，记忆功能不可用。' }
        const cwd = (invocation.agent as unknown as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
        const workspaceKey = deps.workspaceKeyOfCwd(cwd)
        let memories = 0
        let ownMemories = 0
        let episodes = 0
        let requirements = 0
        let signals = 0
        let cursor = '无'
        for (const [, record] of store.memories.entries()) {
          memories++
          if (record.workspaceKey === workspaceKey && record.status === 'active') ownMemories++
        }
        episodes = store.episodes.size
        for (const [, record] of store.requirements.entries()) {
          if (record.workspaceKey === workspaceKey && record.status === 'open') requirements++
        }
        for (const [, record] of store.signals.entries()) {
          if (record.workspaceKey === workspaceKey) signals++
        }
        const hot = store.hotcache.get(String(invocation.agent?.id ?? ''))
        if (hot?.lastMaintainedSeq !== undefined) cursor = String(hot.lastMaintainedSeq)
        const lines = [
          'SuperMemory 状态',
          `- 工作区：${workspaceKey}`,
          `- 事实记忆：${ownMemories} 条（全库 ${memories} 条）`,
          `- 归档梗概：${episodes} 条`,
          `- 未完成需求：${requirements} 条`,
          `- 重复模式信号：${signals} 个`,
          `- 本会话维护游标：${cursor}`,
        ]
        return { kind: 'success' as const, text: lines.join('\n') }
      }
      if (sub === 'help') {
        return {
          kind: 'success' as const,
          text: 'SuperMemory 命令：/memory status（状态总览）。话题集路由与派发命令（topicsets/switch/new/reqs/scan/export/wrap）在 P1 提供。',
        }
      }
      return {
        kind: 'error' as const,
        text: `未知子命令 /memory ${sub}；P0 仅支持 /memory status 与 /memory help。`,
      }
    },
  })
}
