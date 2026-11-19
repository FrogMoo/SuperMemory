/**
 * R23 memory re-layout — offline dry-run / apply tool.
 *
 * The plugin applies the same plan automatically on its next load (see
 * `src/memory-organize.ts`, marker-guarded and SHA-guarded). This script is for
 * operators who want to INSPECT the plan against the current store file without
 * reloading, or — only with the DSH host fully stopped — apply it offline.
 *
 * Usage:
 *   node scripts/memory-organize.mjs                 # dry-run (read-only)
 *   node scripts/memory-organize.mjs --verify        # check current state
 *   node scripts/memory-organize.mjs --apply --force # write the store file
 *   options: --file <path>  --workspace <key>  --backup-dir <dir>
 *
 * Why `--apply` is not the default path: the storage backend's `single` JSON
 * layout keeps the unit authoritative IN MEMORY and rewrites the whole
 * `<unit>.json` on every write. Editing the file while the host runs is
 * therefore lost (or worse) on the next write; reload the plugin instead. The
 * offline apply is safe only when the host is stopped. A full snapshot of the
 * original file is written next to it before the first byte is replaced.
 * @module scripts/memory-organize
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const { workspaceKeyOf } = await import('../src/store.ts')
const { resolvePluginRepoRoot } = await import('../src/builtin-capabilities.ts')
const {
  ORGANIZE_PLAN, applyMemoryOrganize, organizeState, previewMemoryOrganize, renderMemoryOrganizeReport,
} = await import('../src/memory-organize.ts')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const file = valueOf('--file', join(dshHome, 'storages', 'supermemory.json'))
const workspaceKey = valueOf('--workspace', workspaceKeyOf(resolvePluginRepoRoot()))
const backupDir = valueOf('--backup-dir', join(dirname(file), 'supermemory-backups'))

if (!existsSync(file)) {
  console.error('未找到存储文件：' + file + '（用 --file 指定）')
  process.exit(2)
}

const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

/** Load the single-unit JSON and expose the three tables the pass touches. */
function loadStore() {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!raw || typeof raw.tables !== 'object') throw new Error('不是 storage-json single 布局的文件（缺少 tables）')
  const makeTable = (rows) => {
    const map = new Map(Object.entries(rows ?? {}))
    return {
      map,
      get: (key) => map.get(key),
      keys: () => map.keys(),
      get size() { return map.size },
      entries: () => map.entries(),
      put: async (key, value) => { map.set(key, value) },
      update: async (key, fn) => { map.set(key, fn(map.get(key))) },
      delete: async (key) => map.delete(key),
    }
  }
  const memories = makeTable(raw.tables.memories)
  const memoryCollections = makeTable(raw.tables.memory_collections)
  const meta = makeTable(raw.tables.meta)
  return { raw, memories, memoryCollections, meta }
}

const store = loadStore()
const current = organizeState(store, workspaceKey)
console.log(`存储文件：${file}`)
console.log(`工作区：${workspaceKey}`)
console.log(`当前状态：${current.counts.collections} 个集合 / ${current.counts.entries} 条记忆 / 未归集 ${current.counts.uncollected} / 空集合 ${current.counts.emptyCollections}`)
for (const row of current.collections) console.log(`  · ${row.title}（${row.entryCount} 条）`)

if (has('--verify')) {
  const problems = []
  if (current.counts.uncollected > 0) problems.push(`${current.counts.uncollected} 条记忆没有有效集合归属`)
  const old = current.collections.filter((row) => ORGANIZE_PLAN.oldCollectionIds.includes(row.id))
  if (old.length > 0) problems.push(`仍有 ${old.length} 个旧集合`)
  if (problems.length > 0) {
    console.error('校验失败：' + problems.join('；'))
    process.exit(1)
  }
  console.log('校验通过：无孤儿条目、无旧集合。')
  process.exit(0)
}

if (has('--apply')) {
  if (!has('--force')) {
    console.error('拒绝写入：--apply 会直接改写存储文件，必须同时带 --force。\n'
      + '更安全的做法：让宿主重载插件，整理会在插件加载时自动执行（标记守卫 + 正文哈希守卫）。')
    process.exit(2)
  }
  console.log('!! 警告：offline --apply 只在 DSH 宿主已完全停止时安全；宿主运行中请在 GUI 重载插件。')
  const snapshot = join(dirname(file), `supermemory.backup-organize-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  copyFileSync(file, snapshot)
  console.log(`已备份原文件：${snapshot}（sha256 ${sha(readFileSync(file, 'utf8')).slice(0, 16)}…）`)
  // Re-load a fresh copy so the pass sees exactly the snapshot we just took.
  const applied = await applyMemoryOrganize(store, workspaceKey, { plan: ORGANIZE_PLAN, backupDir })
  console.log(renderMemoryOrganizeReport(applied))
  if (applied.status !== 'applied') {
    console.log('未写回存储文件（状态：' + applied.status + '）。')
    process.exit(0)
  }
  const next = {
    ...store.raw,
    tables: {
      ...store.raw.tables,
      memories: Object.fromEntries(store.memories.entries()),
      memory_collections: Object.fromEntries(store.memoryCollections.entries()),
      meta: Object.fromEntries(store.meta.entries()),
    },
  }
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`)
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, file)
  console.log('已写回存储文件。重载插件后生效；在此之前不要再对记忆做写操作。')
  process.exit(0)
}

const preview = await previewMemoryOrganize(store, workspaceKey, ORGANIZE_PLAN)
console.log('')
console.log(renderMemoryOrganizeReport(preview))
console.log('')
console.log('（只读预演：未写任何数据。让宿主重载插件会自动执行整理；或在宿主停止后用 --apply --force。）')
