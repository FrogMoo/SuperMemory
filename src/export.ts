/**
 * Shared markdown export builder (P2 `/memory export` + web console).
 * Extracted from the command handler so both surfaces emit the same shape.
 * @module supermemory/export
 */
import type { Store } from './store.ts'
import { filemapEntries } from './filemap.ts'
import { openRequirements } from './requirements.ts'
import { getTopicSet, topicSetIdsOf } from './topicsets.ts'

export interface ExportResult {
  /** The full markdown document. */
  text: string
  /** Counts for the command/UI receipt. */
  memories: number
  requirements: number
  files: number
}

/**
 * Build the export document for one workspace.
 *
 * @param store - the open domain store
 * @param workspaceKey - workspace isolation key (D4)
 * @param activeTopicSetId - optional topic set rendered as the document head
 */
export function buildExport(store: Store, workspaceKey: string, activeTopicSetId?: string): ExportResult {
  const topicSet = activeTopicSetId ? getTopicSet(store, activeTopicSetId) : undefined
  const lines: string[] = ['# SuperMemory 导出', '']
  if (topicSet) {
    lines.push(`## 话题集：${topicSet.title}`, '', topicSet.summary || '（暂无梗概）', '')
  }
  const mems: string[] = []
  for (const [, record] of store.memories.entries()) {
    if (record.workspaceKey === workspaceKey && record.status === 'active') mems.push(`- ${record.text}`)
  }
  if (mems.length) lines.push('## 事实记忆', '', ...mems, '')
  const reqs = openRequirements(store, workspaceKey)
  if (reqs.length) lines.push('## 未完成需求', '', ...reqs.map(([, r]) => `- ${r.text}`), '')
  // Episodes are workspace-isolated through their topic set (D4).
  const ownTopicSetIds = topicSetIdsOf(store, workspaceKey)
  const eps: string[] = []
  for (const [, episode] of store.episodes.entries()) {
    if (!episode.topicSetId || !ownTopicSetIds.has(episode.topicSetId)) continue
    if (episode.summary) eps.push(`- ${episode.summary}`)
  }
  if (eps.length) lines.push('## 归档梗概', '', ...eps.slice(-20), '')
  const files = filemapEntries(store, workspaceKey)
  if (files.length) {
    lines.push('## 项目文件地图', '')
    for (const [, entry] of files) lines.push(`- \`${entry.path}\` — ${entry.role}${entry.summary ? '：' + entry.summary : ''}`)
    lines.push('')
  }
  return { text: lines.join('\n'), memories: mems.length, requirements: reqs.length, files: files.length }
}
