/**
 * Shared markdown export builder (P2 `/memory export` + web console).
 * Extracted from the command handler so both surfaces emit the same shape.
 *
 * R22 需求④: memories are exported as 记忆集合 → 条目 (the two-level model),
 * with uncollected entries kept in a trailing 「未归集」 section so an export
 * never loses a record.
 * @module supermemory/export
 */
import type { Store } from './store.ts'
import { filemapEntries } from './filemap.ts'
import { openRequirements } from './requirements.ts'
import { getTopicSet, topicSetIdsOf } from './topicsets.ts'
import { renderRecordLine } from './retrieval.ts'
import { listCollections } from './memory-collections.ts'

export interface ExportResult {
  /** The full markdown document. */
  text: string
  /** Counts for the command/UI receipt. */
  memories: number
  requirements: number
  files: number
  /** R22: how many memory collections the document groups entries under. */
  collections: number
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
    const tags = topicSet.keywords.length > 0 ? `

标签：${topicSet.keywords.join('、')}` : ''
    lines.push(`## 话题集：${topicSet.title}${tags}`, '', topicSet.summary || '（暂无梗概）', '')
  }
  // Memory collections → entries (R22). Entries are grouped by their collection
  // and the uncollected ones stay visible, so old media export unchanged content.
  const collections = new Map(listCollections(store, workspaceKey))
  const grouped = new Map<string, string[]>()
  const loose: string[] = []
  let memoryCount = 0
  for (const [, record] of store.memories.entries()) {
    if (record.workspaceKey !== workspaceKey || record.status !== 'active') continue
    const line = `- ${renderRecordLine({ title: record.title, text: record.text, tags: record.keywords })}`
    const collectionId = record.collectionId && collections.has(record.collectionId) ? record.collectionId : ''
    if (!collectionId) {
      loose.push(line)
      memoryCount += 1
      continue
    }
    const bucket = grouped.get(collectionId) ?? []
    bucket.push(line)
    grouped.set(collectionId, bucket)
    memoryCount += 1
  }
  if (memoryCount > 0) {
    lines.push('## 事实记忆', '')
    for (const [collectionId, rows] of grouped) {
      const collection = collections.get(collectionId)
      const tags = collection && collection.keywords.length > 0 ? `（标签：${collection.keywords.join('、')}）` : ''
      lines.push(`### 记忆集合：${collection?.title ?? collectionId}${tags}`, '')
      if (collection?.summary) lines.push(collection.summary, '')
      lines.push(...rows, '')
    }
    if (loose.length > 0) {
      lines.push('### 未归集', '', ...loose, '')
    }
  }
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
  return {
    text: lines.join('\n'),
    memories: memoryCount,
    requirements: reqs.length,
    files: files.length,
    collections: grouped.size,
  }
}
