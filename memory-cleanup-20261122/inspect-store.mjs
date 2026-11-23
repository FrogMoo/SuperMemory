// One-off read-only inspector for the supermemory storage file.
import { readFileSync, statSync } from 'node:fs'

const path = 'C:/Users/admin/.dsh/storages/supermemory.json'
const st = statSync(path)
console.log('file bytes:', st.size, '| mtime:', st.mtime.toISOString())
const d = JSON.parse(readFileSync(path, 'utf8'))
console.log('top keys:', Object.keys(d).join(','))

const tables = d.tables ?? d.data ?? d
const summary = {}
for (const [name, t] of Object.entries(tables)) {
  if (t && typeof t === 'object') {
    summary[name] = Array.isArray(t) ? `array(${t.length})` : `map(${Object.keys(t).length})`
  }
}
console.log('tables:', JSON.stringify(summary))

function rows(name) {
  const t = tables[name]
  if (!t) return []
  if (Array.isArray(t)) return t.map((v, i) => [String(i), v])
  return Object.entries(t)
}

const wks = new Set()
for (const name of ['memories', 'requirements', 'topicsets', 'memory_collections', 'dispatches', 'questions', 'episodes']) {
  for (const [, r] of rows(name)) if (r && r.workspaceKey) wks.add(r.workspaceKey)
}
console.log('workspaceKeys:', JSON.stringify([...wks]))

const firstDispatch = rows('dispatches')[0]
if (firstDispatch) console.log('dispatch row keys:', Object.keys(firstDispatch[1]).join(','))
const firstEpisode = rows('episodes')[0]
if (firstEpisode) console.log('episode row keys:', Object.keys(firstEpisode[1]).join(','))

console.log('\n=== REQUIREMENTS (all) ===')
for (const [id, r] of rows('requirements')) {
  console.log([id, r.status, r.createdAt ? new Date(r.createdAt).toISOString() : '', (r.text || '').replace(/\s+/g, ' ').slice(0, 100)].join(' | '))
}

console.log('\n=== TOPICSETS (all) ===')
for (const [id, t] of rows('topicsets')) {
  console.log([id, t.status, JSON.stringify(t.title), 'members=' + ((t.members || []).length), 'sum=' + String(t.summary || '').slice(0, 50)].join(' | '))
}

console.log('\n=== MEMORIES (all) ===')
for (const [id, m] of rows('memories')) {
  console.log([id, m.status, m.createdAt ? new Date(m.createdAt).toISOString() : '', String(m.collectionId || '-'), String(m.title || '').slice(0, 60)].join(' | '))
}

console.log('\n=== MEMORY_COLLECTIONS (all) ===')
for (const [id, c] of rows('memory_collections')) {
  console.log([id, c.status, JSON.stringify(c.title), 'entries?'].join(' | '))
}

console.log('\n=== DISPATCHES with topicSetId ===')
for (const [id, dp] of rows('dispatches')) {
  if (dp.topicSetId) console.log([id, dp.status, dp.topicSetId].join(' | '))
}
console.log('dispatches total:', rows('dispatches').length)

console.log('\n=== ROUTING (all) ===')
for (const [id, r] of rows('routing')) {
  console.log([id, r.activeTopicSetId || '(none)'].join(' | '))
}

console.log('\n=== QUESTIONS (all) ===')
for (const [id, q] of rows('questions')) {
  console.log([id, q.status || '', String(q.title || '').slice(0, 60)].join(' | '))
}

console.log('\n=== HOTCACHE reqIds refs ===')
for (const [id, h] of rows('hotcache')) {
  const ids = h?.recentRelevant?.reqIds ?? []
  if (ids.length) console.log([id, ids.join(',')].join(' | '))
}
