/**
 * core-smoke — pure-logic regression checks for the host half (no DSH host).
 *
 * Runs the data-layer helpers against in-memory table stubs so the invariants
 * that unit-testing cannot reach through the web console are still covered.
 * Usage: node scripts/core-smoke.mjs   (Node >= 22.6 for TS type stripping)
 */
import assert from 'node:assert/strict'

const { buildExport } = await import('../src/export.ts')
const { topicSetIdsOf } = await import('../src/topicsets.ts')
const { recallMemories } = await import('../src/recall.ts')
const { rankMembers } = await import('../src/topicsets.ts')
const { extractRequirements } = await import('../src/requirements.ts')
const { extractFacts } = await import('../src/extract.ts')

function table(seed = []) {
  const map = new Map(seed)
  return {
    get: (k) => map.get(k),
    keys: () => map.keys(),
    get size() { return map.size },
    entries: () => map.entries(),
    put: async (k, v) => { map.set(k, v) },
    update: async (k, fn) => { map.set(k, fn(map.get(k))) },
    delete: async (k) => map.delete(k),
    deleteMany: async (ks) => { let n = 0; for (const k of ks) if (map.delete(k)) n++; return n },
  }
}

const now = Date.now()
const WS_A = 'G:\\work\\alpha'
const WS_B = 'G:\\work\\beta'
const store = {
  topicsets: table([
    ['ts-a', { workspaceKey: WS_A, title: 'A 话题', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }],
    ['ts-b', { workspaceKey: WS_B, title: 'B 话题', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }],
  ]),
  memories: table([
    ['mem-a', { workspaceKey: WS_A, text: 'alpha 的构建命令是 pnpm build', keywords: ['pnpm', 'build'], status: 'active', sourceSessionId: 's1', sourceSeq: 1, createdAt: now, updatedAt: now }],
    ['mem-b', { workspaceKey: WS_B, text: 'beta 的构建命令是 make', keywords: ['make'], status: 'active', sourceSessionId: 's2', sourceSeq: 1, createdAt: now, updatedAt: now }],
  ]),
  episodes: table([
    ['epi-a', { topicSetId: 'ts-a', branchSessionId: 'br-a', timeStart: now, timeEnd: now, summary: 'A 的归档', decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'br-a', sourceSeqStart: 0, sourceSeqEnd: 1 }],
    ['epi-b', { topicSetId: 'ts-b', branchSessionId: 'br-b', timeStart: now, timeEnd: now, summary: 'B 的归档', decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'br-b', sourceSeqStart: 0, sourceSeqEnd: 1 }],
  ]),
  requirements: table([
    ['req-a', { workspaceKey: WS_A, text: 'A 必须用 pnpm', constraints: [], status: 'open', sourceSessionId: 's1', sourceSeq: 1, createdAt: now }],
  ]),
  filemap: table(),
  toolMemory: table(),
  signals: table(),
  dispatches: table(),
  outbox: table(),
  routing: table(),
  hotcache: table(),
}

let passed = 0
const ok = (label) => { passed++; console.log('ok - ' + label) }

// 1. workspace isolation: an export must never leak another workspace's episodes.
const exportedA = buildExport(store, WS_A)
assert.ok(exportedA.text.includes('A 的归档'))
assert.ok(!exportedA.text.includes('B 的归档'), 'foreign episode leaked into the export')
assert.ok(exportedA.text.includes('alpha 的构建命令'))
assert.ok(!exportedA.text.includes('beta 的构建命令'))
ok('export is workspace-isolated (memories + episodes)')

// 2. topic-set join helper is the single source of that isolation.
assert.deepEqual([...topicSetIdsOf(store, WS_A)], ['ts-a'])
ok('topicSetIdsOf scopes to one workspace')

// 3. recall threshold gates on the RAW match, decay only reorders (DEV-NOTES §3).
const ranked = recallMemories([...store.memories.entries()], '构造 pnpm build 命令', {
  limit: 5, minScore: 1, halfLifeDays: 0.0001, now: now + 30 * 86400000,
})
assert.ok(ranked.some((item) => item.memoryId === 'mem-a'), 'aged memory must still match (decay is not a filter)')
ok('recall minScore applies to the raw score')

// 4. conservative rule extraction: explicit markers only.
assert.deepEqual(extractRequirements('这个功能必须支持导出'), ['支持导出'])
assert.deepEqual(extractRequirements('今天天气不错'), [])
assert.deepEqual(extractFacts('记住：构建命令是 pnpm build').map((f) => f.text), ['构建命令是 pnpm build'])
assert.deepEqual(extractFacts('随便聊聊这个项目'), [])
ok('requirement/fact extraction stays conservative')

// 5. member ranking must actually rank: the title/summary spread bug made every
// score 0, degrading auto/fork branch selection to "most recently active".
const members = [
  { sessionId: 'm-a', kind: 'root', title: '导出 Markdown', summary: 'export', status: 'live', modelOverridden: false, lastActiveAt: 1 },
  { sessionId: 'm-b', kind: 'root', title: '管理台 UI', summary: 'web console', status: 'live', modelOverridden: false, lastActiveAt: 2 },
]
const ranking = rankMembers({ workspaceKey: WS_A, title: 't', summary: '', keywords: [], status: 'active', members, createdAt: now, updatedAt: now, lastActiveAt: now }, new Set(['export']))
assert.equal(ranking[0].sessionId, 'm-a', 'the member matching the task must rank first')
ok('rankMembers ranks by task overlap')

console.log('\n' + passed + ' checks passed')
process.exit(0)
