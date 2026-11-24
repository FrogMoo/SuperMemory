#!/usr/bin/env node
/**
 * cleanup-legacy-titles.mjs — R42 需求③ 收尾：存量会话标题一次性清理。
 *
 * 背景：R41 把「会话名称直接描述工作内容」落地后，重载核验发现 5 条存量记录仍
 * 带前置描述（4 条 dispatch 标题 + 1 条 hub 记录）。本脚本用 store 的【正规
 * 写路径】清理它们——不是手改 JSON：
 *   - 域层：@deepseek-ai/dsh-storage-domain 的 DomainFacility + defineDomain
 *     （副本来自 _dsh_src，与宿主同版本 0.2.2-rc.3），schema 来自
 *     src/schema.ts 的 buildSchemas()，因此读有 zod 校验、写走域层
 *     putRecord 写链（内存态先落介质再发 domain/changed）；
 *   - 介质层：KvUnit 适配器包住 ~/.dsh/storages/supermemory.json，每次写都是
 *     「读-改-写 + 临时文件原子替换」，把与宿主并发写的丢失窗口压到最小。
 *
 * 已知限制（DEV-NOTES §50）：宿主进程持有同一域，JSON 后端的 single 布局每次
 * 写都会用内存态整单重写——本脚本落地后，宿主的下一次写可能把它覆盖回去。
 * 因此权威清理是「重启后的 hub-titles v3 迁移」（幂等，会再清一次）；本脚本
 * 提供即时证据与「不手改 JSON」的写路径证明。重复运行安全（幂等）。
 *
 * 用法：
 *   node scripts/cleanup-legacy-titles.mjs              # 预演（只读）
 *   node scripts/cleanup-legacy-titles.mjs --apply      # 实际写入
 *   node scripts/cleanup-legacy-titles.mjs --apply --store <path>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')
const storeArgIndex = process.argv.indexOf('--store')
const storeFile = storeArgIndex > 0 && process.argv[storeArgIndex + 1]
  ? path.resolve(process.argv[storeArgIndex + 1])
  : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'supermemory.json')

if (!fs.existsSync(storeFile)) {
  console.error('介质不存在: ' + storeFile)
  process.exit(1)
}

// ---- 1) 物料化一个可解析的模块目录（.probe/ 已被 .gitignore 忽略） ----
// 域层副本在仓库里跑不起来：它 import 的 @deepseek-ai/dsh-storage 只存在于
// 宿主 app.asar 内（普通 Node 读不到）。把域层 lib 复制到 .probe 下，并为
// dsh-storage 写一个最小桩（域层只用到 StorageError / UNIT_NAME_RE /
// storageBackendServiceKey 三个符号，后两者本脚本路径都不会触发校验失败）。
const probeDir = path.join(repoRoot, '.probe', 'node_modules', '@deepseek-ai')
const sdSrc = path.join(repoRoot, '_dsh_src', 'deepseek-ai-dsh-storage-domain-0.2.2-rc.3', 'package', 'lib', 'index.js')
fs.mkdirSync(path.join(probeDir, 'dsh-storage-domain', 'lib'), { recursive: true })
fs.mkdirSync(path.join(probeDir, 'dsh-storage'), { recursive: true })
fs.copyFileSync(sdSrc, path.join(probeDir, 'dsh-storage-domain', 'lib', 'index.js'))
fs.writeFileSync(
  path.join(probeDir, 'dsh-storage', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-storage', version: '0.0.0-stub', type: 'module', main: 'index.js' }, null, 2) + '\n',
)
fs.writeFileSync(path.join(probeDir, 'dsh-storage', 'index.js'), [
  "export class StorageError extends Error {",
  "  constructor(code, message) { super(message); this.code = code; this.name = 'StorageError' }",
  "}",
  "export const UNIT_NAME_RE = /^[A-Za-z0-9_.-]+$/",
  "export const storageBackendServiceKey = (name) => 'storage.backend.' + name",
  '',
].join('\n'))

// ---- 2) 载入域层 + 插件 schema / 标题规则 ----
const fileUrl = (p) => pathToFileURL(p).href
const sd = await import(fileUrl(path.join(probeDir, 'dsh-storage-domain', 'lib', 'index.js')))
const { buildSchemas } = await import(fileUrl(path.join(repoRoot, 'src', 'schema.ts')))
const { describeSessionTitle } = await import(fileUrl(path.join(repoRoot, 'src', 'title.ts')))
const { supermemorySpec } = await import(fileUrl(path.join(repoRoot, 'src', 'store.ts')))

// ---- 3) 介质：JSON 文件的读-改-写 KvUnit ----
const readDoc = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'))
const writeDoc = (doc) => {
  const text = JSON.stringify(doc, null, 2)
  const tmp = storeFile + '.r42-tmp'
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, storeFile)
  } catch {
    // Windows 上宿主可能持有该文件：原子替换失败时退化为直接写（同一微秒内
    // 的宿主并发写仍可能互相覆盖，重启迁移会兜底）。
    fs.writeFileSync(storeFile, text)
  }
}
const unit = {
  loadAll: async () => {
    const doc = readDoc()
    return { tables: doc.tables ?? {}, global: doc.global ?? null }
  },
  putRecord: async (table, key, value) => {
    const doc = readDoc()
    doc.tables = doc.tables ?? {}
    doc.tables[table] = doc.tables[table] ?? {}
    doc.tables[table][key] = value
    writeDoc(doc)
  },
  deleteRecord: async (table, key) => {
    const doc = readDoc()
    if (!doc.tables || !doc.tables[table]) return
    delete doc.tables[table][key]
    writeDoc(doc)
  },
  deleteRecords: async (table, keys) => {
    const doc = readDoc()
    if (!doc.tables || !doc.tables[table]) return
    for (const key of keys) delete doc.tables[table][key]
    writeDoc(doc)
  },
  setGlobal: async (value) => {
    const doc = readDoc()
    doc.global = value
    writeDoc(doc)
  },
  close: async () => {},
}

// ---- 4) 通过域层打开（读路径带 zod 校验） ----
const schemas = await buildSchemas()
const spec = supermemorySpec(sd, schemas)
const logger = {
  warn: (m) => console.error('[warn] ' + m),
  info: (m) => console.log('[info] ' + m),
  error: (m) => console.error('[error] ' + m),
}
const facility = new sd.DomainFacility({
  storage: { backend: { get: () => ({ kv: { open: async () => unit } }) } },
  emit: () => {},
  logger,
}, { backend: 'json-file' })
const domain = await facility.open(spec)
const tables = {
  dispatches: domain.table('dispatches'),
  hubs: domain.table('hub_sessions'),
}

// ---- 5) 清理目标（R42 重载核验清单） ----
const TARGETS = [
  { table: 'dispatches', id: 'dsp-mwthbp9n-aaw8cr' },
  { table: 'dispatches', id: 'dsp-mwticfu5-zqaf83' },
  { table: 'dispatches', id: 'dsp-mwu4vzba-1y3xhv' },
  { table: 'dispatches', id: 'dsp-mwu8ycbg-851kjw' },
  { table: 'hubs', id: 'session-mwkvs5ec-26dg8h' },
]
const rows = []
for (const target of TARGETS) {
  const table = tables[target.table]
  const before = String(table.get(target.id)?.title ?? '')
  const after = before ? describeSessionTitle(before) : ''
  rows.push({ ...target, before, after, changed: Boolean(before) && after !== before, exists: Boolean(table.get(target.id)) })
}

console.log('介质: ' + storeFile)
console.log('模式: ' + (APPLY ? 'APPLY（写入）' : 'DRY-RUN（只读）'))
for (const row of rows) {
  if (!row.exists) {
    console.log('- ' + row.id + ' [' + row.table + '] 记录不存在，跳过')
    continue
  }
  console.log('- ' + row.id + ' [' + row.table + ']')
  console.log('    before: ' + JSON.stringify(row.before))
  console.log('    after:  ' + JSON.stringify(row.after) + (row.changed ? '' : '  （已是直接描述，跳过）'))
}

if (!APPLY) {
  await domain.close()
  console.log('dry-run 完成，未写入任何内容。')
  process.exit(0)
}

let applied = 0
for (const row of rows) {
  if (!row.changed) continue
  try {
    await tables[row.table].update(row.id, (record) => ({ ...record, title: row.after }))
    applied += 1
  } catch (error) {
    console.error('[error] 写入失败 ' + row.id + ': ' + String(error).slice(0, 200))
  }
}
console.log('已写入 ' + applied + ' 条（域层 putRecord → JSON 读-改-写）。')
for (const row of rows) {
  if (!row.exists) continue
  const now = String(tables[row.table].get(row.id)?.title ?? '')
  console.log('    readback ' + row.id + ': ' + JSON.stringify(now) + (now === row.after ? '  OK' : '  MISMATCH'))
}
await domain.close()
console.log('完成。注意：宿主进程若在运行，其下一次写可能用内存态整单重写而覆盖本次清理；重启后的 hub-titles v3 迁移会幂等重清。')
