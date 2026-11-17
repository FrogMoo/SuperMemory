/**
 * Project file map (P2): `/memory scan` walks the workspace, annotates files
 * with a rule-based role, and invalidates stale entries by hash. The point is
 * the P2 acceptance "新会话能答『这个文件干什么』": filemap entries join the
 * recall ranking alongside memories/episodes/requirements.
 *
 * Annotation is rule-based by design: subagent-parallel LLM annotation only
 * covers the skeleton (entry points, manifests, configs) and stays optional,
 * so a scan never depends on an LLM being available.
 * @module supermemory/filemap
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { FileMapEntry } from './schema.ts'
import type { Store } from './store.ts'
import { newId, workspaceKeyOf } from './store.ts'

const SKIP_DIRS = new Set(['node_modules', '.git', '.probe', 'dist', 'out', 'build', '.next', '.turbo', 'target', '_dsh_src', '.obsidian', 'Backup'])
const MAX_FILES = 600
const MAX_BYTES = 512 * 1024

/** Role inference from path and extension (rule-based skeleton). */
export function roleOf(relPath: string): string {
  const name = relPath.split(/[\\/]/).pop() ?? relPath
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (/^(package\.json|pnpm-lock\.yaml|tsconfig.*\.json|tsdown\.config\.ts|vite\.config\.ts)$/.test(name)) return '构建/依赖清单'
  if (/^README(\.\w+)?\.md$/i.test(name)) return '项目说明'
  if (/^cordis\.(patch\.)?ya?ml$/i.test(name)) return '插件组合层'
  if (name === 'DEV-NOTES.md') return '开发运维笔记'
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return '源码'
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return '脚本/产物'
  if (ext === 'md' || ext === 'markdown') return '文档'
  if (ext === 'json' || ext === 'jsonc' || ext === 'yaml' || ext === 'yml' || ext === 'toml') return '配置'
  if (ext === 'svg' || ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif') return '图片'
  if (ext === 'py') return 'Python'
  if (ext === 'sh' || ext === 'bash' || ext === 'ps1' || ext === 'cmd' || ext === 'bat') return '脚本'
  if (ext === 'log' || ext === 'jsonl') return '日志/数据'
  return '其他'
}

/** D4 key encoding: ws/<workspaceKey hash>/<path hash>-<path-safe>. */
function filemapKey(workspaceKey: string, relPath: string): string {
  const hash = createHash('sha1').update(workspaceKey).digest('hex').slice(0, 16)
  // The path hash keeps distinct paths distinct: a plain separator->'_' rewrite
  // made src/a.ts and src_a.ts share one key, so each scan overwrote the other.
  const pathHash = createHash('sha1').update(relPath).digest('hex').slice(0, 12)
  const safe = relPath.replace(/[\\/:*?"<>|]+/g, '_')
  return `ws/${hash}/${pathHash}-${safe}`
}

/** Walk the workspace and refresh the filemap; returns counts. */
export async function scanWorkspace(store: Store, cwd: string): Promise<{ scanned: number; added: number; updated: number; stale: number }> {
  const workspaceKey = workspaceKeyOf(cwd)
  const root = resolve(cwd)
  const files: string[] = []
  // A truncated walk must never drive the "file vanished" deletion below: it
  // only saw part of the tree, and deleting unseen entries made every scan past
  // the budget delete + re-add the same rows.
  let truncated = false
  const walk = (dir: string, depth: number) => {
    if (depth > 6) { truncated = true; return }
    if (files.length >= MAX_FILES) { truncated = true; return }
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return }
      const full = join(dir, name)
      let isDir = false
      let size = 0
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        size = st.size
      } catch {
        continue
      }
      if (isDir) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        walk(full, depth + 1)
      } else if (size <= MAX_BYTES) {
        files.push(relative(root, full))
      }
    }
  }
  walk(root, 0)

  const now = Date.now()
  let added = 0
  let updated = 0
  let stale = 0
  const seenKeys = new Set<string>()
  for (const rel of files) {
    const posix = rel.replace(/\\/g, '/')
    const key = filemapKey(workspaceKey, posix)
    seenKeys.add(key)
    let hash: string | undefined
    try {
      hash = createHash('sha1').update(readFileSync(join(root, rel))).digest('hex').slice(0, 16)
    } catch {
      hash = undefined
    }
    const existing = store.filemap.get(key)
    if (!existing) {
      const entry: FileMapEntry = {
        workspaceKey,
        path: posix,
        role: roleOf(posix),
        summary: '',
        keywords: keywordsOfPath(posix),
        hash,
        annotatedAt: now,
      }
      await store.filemap.put(key, entry)
      added++
    } else {
      // Always refresh: this normalises legacy record shapes (older builds
      // wrote entries without `path`) and keeps roles current. `stale` counts
      // only content changes (hash drift).
      if (existing.hash !== hash) stale++
      await store.filemap.update(key, (r) => ({ ...r, path: posix, hash, role: roleOf(posix), annotatedAt: now }))
      if (existing.hash === hash && existing.role !== roleOf(posix)) updated++
    }
  }
  // invalidate entries whose file vanished — only after a COMPLETE walk
  if (!truncated) {
    for (const [key, entry] of [...store.filemap.entries()]) {
      if (entry.workspaceKey !== workspaceKey) continue
      if (seenKeys.has(key)) continue
      await store.filemap.delete(key)
      stale++
    }
  }
  return { scanned: files.length, added, updated, stale }
}

function keywordsOfPath(relPath: string): string[] {
  const tokens = relPath.toLowerCase().split(/[\\/._\-]+/).filter((t) => t.length >= 2)
  return [...new Set(tokens)].slice(0, 12)
}

/** Filemap entries of one workspace, with readable paths. */
export function filemapEntries(store: Store, workspaceKey: string): Array<[string, FileMapEntry]> {
  const out: Array<[string, FileMapEntry]> = []
  for (const entry of store.filemap.entries()) {
    if (entry[1].workspaceKey === workspaceKey) out.push(entry)
  }
  return out
}
