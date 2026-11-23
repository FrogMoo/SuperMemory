// Apply the R29 memory cleanup decisions to the supermemory storage file.
// Usage:
//   node apply-cleanup.mjs          # dry-run: validate + print, no write
//   node apply-cleanup.mjs --write  # backup + delete + atomic write + verify
//
// Safety: every id must exist in the expected table and carry the expected
// workspaceKey; any mismatch aborts before touching the file. The backup is
// written before the first modification. Must run while the plugin is DISABLED
// (the JSON backend rewrites the whole unit on every in-memory write).
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STORE = 'C:/Users/admin/.dsh/storages/supermemory.json'
const BACKUP_DIR = 'C:/Users/admin/.dsh/storages/supermemory-backups'
const DECISIONS = new URL('./decisions.json', import.meta.url)
const WRITE = process.argv.includes('--write')

const decisions = JSON.parse(readFileSync(DECISIONS, 'utf8'))
const WS = decisions.workspaceKey
const raw = readFileSync(STORE, 'utf8')
const d = JSON.parse(raw)
const tables = d.tables

const problems = []
const plan = []

function checkTable(name) {
  if (!tables[name] || typeof tables[name] !== 'object') problems.push(`table ${name} missing`)
}

checkTable('requirements')
checkTable('memories')
checkTable('topicsets')
checkTable('routing')

// --- validate every deletion -------------------------------------------------
for (const id of decisions.deleteRequirements.ids) {
  const row = tables.requirements?.[id]
  if (!row) { problems.push(`requirement ${id} not found`); continue }
  if (row.workspaceKey !== WS) problems.push(`requirement ${id} wrong workspace: ${row.workspaceKey}`)
  plan.push(['requirements', id, String(row.text || '').replace(/\s+/g, ' ').slice(0, 80)])
}
for (const id of decisions.deleteMemories.ids) {
  const row = tables.memories?.[id]
  if (!row) { problems.push(`memory ${id} not found`); continue }
  if (row.workspaceKey !== WS) problems.push(`memory ${id} wrong workspace: ${row.workspaceKey}`)
  plan.push(['memories', id, String(row.title || '').slice(0, 80)])
}
for (const id of decisions.deleteTopicSets.ids) {
  const row = tables.topicsets?.[id]
  if (!row) { problems.push(`topicset ${id} not found`); continue }
  if (row.workspaceKey !== WS) problems.push(`topicset ${id} wrong workspace: ${row.workspaceKey}`)
  plan.push(['topicsets', id, String(row.title || '').slice(0, 80)])
}
for (const sid of decisions.clearRoutingActiveTopicSet.sessionIds) {
  const row = tables.routing?.[sid]
  if (!row) { problems.push(`routing ${sid} not found`); continue }
  if (row.activeTopicSetId && !decisions.deleteTopicSets.ids.includes(row.activeTopicSetId)) {
    problems.push(`routing ${sid} points at ${row.activeTopicSetId}, not in delete list`)
  }
  plan.push(['routing', sid, `clear activeTopicSetId=${row.activeTopicSetId}`])
}

// --- sanity: counts of untouched rows in this workspace -----------------------
const wsCount = (name) => Object.values(tables[name] ?? {}).filter((r) => r && r.workspaceKey === WS).length
const before = {
  requirements: wsCount('requirements'),
  memories: wsCount('memories'),
  topicsets: wsCount('topicsets'),
}

console.log('mode:', WRITE ? 'WRITE' : 'DRY-RUN')
console.log('workspace:', WS)
console.log('before (workspace rows):', JSON.stringify(before))
console.log('planned actions:', plan.length)
for (const [table, id, label] of plan) console.log(`  - [${table}] ${id} :: ${label}`)

if (problems.length > 0) {
  console.error('\nABORT — validation problems:')
  for (const p of problems) console.error('  ! ' + p)
  process.exit(1)
}

if (!WRITE) {
  console.log('\ndry-run OK (no write). Re-run with --write while the plugin is disabled.')
  process.exit(0)
}

// --- backup -------------------------------------------------------------------
if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupPath = join(BACKUP_DIR, `manual-cleanup-r29-${stamp}.json`)
copyFileSync(STORE, backupPath)
console.log('\nbackup written:', backupPath, `(${raw.length} bytes)`)

// --- apply --------------------------------------------------------------------
for (const id of decisions.deleteRequirements.ids) delete tables.requirements[id]
for (const id of decisions.deleteMemories.ids) delete tables.memories[id]
for (const id of decisions.deleteTopicSets.ids) delete tables.topicsets[id]
for (const sid of decisions.clearRoutingActiveTopicSet.sessionIds) {
  const row = tables.routing[sid]
  if (row) delete row.activeTopicSetId
}

// --- verify serialization round-trip ------------------------------------------
const out = JSON.stringify(d)
const reparsed = JSON.parse(out)
const after = {
  requirements: Object.values(reparsed.tables.requirements).filter((r) => r && r.workspaceKey === WS).length,
  memories: Object.values(reparsed.tables.memories).filter((r) => r && r.workspaceKey === WS).length,
  topicsets: Object.values(reparsed.tables.topicsets).filter((r) => r && r.workspaceKey === WS).length,
}
console.log('after  (workspace rows):', JSON.stringify(after))
const expectAfter = {
  requirements: before.requirements - decisions.deleteRequirements.ids.length,
  memories: before.memories - decisions.deleteMemories.ids.length,
  topicsets: before.topicsets - decisions.deleteTopicSets.ids.length,
}
if (JSON.stringify(after) !== JSON.stringify(expectAfter)) {
  console.error('ABORT — after-counts mismatch:', JSON.stringify(after), 'expected', JSON.stringify(expectAfter))
  process.exit(1)
}
// other workspaces must be untouched
const otherWs = new Set(Object.values(reparsed.tables.requirements).map((r) => r?.workspaceKey).filter(Boolean))
console.log('workspaceKeys still present in requirements:', JSON.stringify([...otherWs]))

// --- atomic write ---------------------------------------------------------------
const tmp = STORE + `.tmp-${stamp}`
writeFileSync(tmp, out, 'utf8')
renameSync(tmp, STORE)
console.log('store rewritten atomically:', STORE, `(${out.length} bytes)`)
