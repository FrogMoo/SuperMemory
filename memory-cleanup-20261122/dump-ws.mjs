// Workspace-filtered dump + reference checks. Read-only.
import { readFileSync } from 'node:fs'

const WS = 'F:\\10-SuperMemory'
const path = 'C:/Users/admin/.dsh/storages/supermemory.json'
const d = JSON.parse(readFileSync(path, 'utf8'))
const tables = d.tables

console.log('=== unit/global structure (checksum?) ===')
console.log('unit:', JSON.stringify(d.unit)?.slice(0, 400))
console.log('global:', JSON.stringify(d.global)?.slice(0, 400))

function rows(name) {
  const t = tables[name]
  if (!t) return []
  return Object.entries(t)
}
const inWs = (r) => r && r.workspaceKey === WS

console.log('\n=== REQUIREMENTS in workspace ===')
let n = 0
for (const [id, r] of rows('requirements')) {
  if (!inWs(r)) continue
  n++
  console.log([id, r.status, r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 19) : '', (r.text || '').replace(/\s+/g, ' ').slice(0, 110)].join(' | '))
}
console.log('count:', n)

console.log('\n=== MEMORIES in workspace ===')
n = 0
for (const [id, m] of rows('memories')) {
  if (!inWs(m)) continue
  n++
  console.log([id, m.status, String(m.collectionId || '-'), String(m.title || '').replace(/\s+/g, ' ').slice(0, 70)].join(' | '))
}
console.log('count:', n)

console.log('\n=== MEMORY_COLLECTIONS in workspace ===')
n = 0
for (const [id, c] of rows('memory_collections')) {
  if (!inWs(c)) continue
  n++
  console.log([id, c.status, JSON.stringify(c.title)].join(' | '))
}
console.log('count:', n)

console.log('\n=== TOPICSETS in workspace ===')
n = 0
for (const [id, t] of rows('topicsets')) {
  if (!inWs(t)) continue
  n++
  console.log([id, t.status, JSON.stringify(t.title), 'members=' + JSON.stringify((t.members || []).map((m) => m.sessionId))].join(' | '))
}
console.log('count:', n)

const junkTopicSets = ['ts-mwl4q67c-wyg5pi', 'ts-mwm1r5xl-itf4rn']
console.log('\n=== references to junk topic sets ===')
for (const [id, dp] of rows('dispatches')) {
  if (junkTopicSets.includes(dp.topicSetId)) console.log('dispatch', id, dp.status, '->', dp.topicSetId)
}
for (const [id, r] of rows('routing')) {
  if (junkTopicSets.includes(r.activeTopicSetId)) console.log('routing', id, '->', r.activeTopicSetId)
}
for (const [id, e] of rows('episodes')) {
  if (junkTopicSets.includes(e.topicSetId)) console.log('episode', id, '->', e.topicSetId)
}
for (const [id, t] of rows('topicsets')) {
  if (junkTopicSets.includes(id)) console.log('topicset row', id, 'members:', JSON.stringify(t.members))
}
console.log('(no output above = no references)')

console.log('\n=== QUESTIONS ===')
for (const [id, q] of rows('questions')) {
  console.log([id, q.status || '(no status)', String(q.title || '').slice(0, 60)].join(' | '))
}
