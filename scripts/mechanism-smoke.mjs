/**
 * mechanism-smoke — unit checks for requirement A (in-request recall) and
 * requirement B (auto tool-ization + structured composite catalog).
 *
 * Host-free: the pure helpers and the injectable auto-toolize seam are driven
 * directly, so these invariants hold without a DSH host.
 * Usage: node scripts/mechanism-smoke.mjs
 */
import assert from 'node:assert/strict'

const {
  createTracker, observe, triggerOf, canInjectCard, freshItems, commitCard,
  renderRepeatCard, remainingChars, buildQuery, extractPaths, memoryOverlap,
} = await import('../src/inrequest.ts')
const {
  planAutoToolize, longestPrefixMatch, pickCompositeMatch, catalogFor, renderCatalog,
  repeatedWindow, autoToolizeFromSequence, sweepAutoToolize,
} = await import('../src/toolize.ts')

const repeat = { enabled: true, everySteps: 3, maxCardsPerRequest: 4, maxCharsPerRequest: 6000, dedupe: true, hotSignal: true }
const toolize = { enabled: true, threshold: 3, cooldownMs: 60000, maxActive: 8, minSteps: 2, minDistinctTools: 2, nearMissHint: true, recycleIdleDays: 0 }
const logger = { info: () => {}, warn: () => {} }
const now = Date.now()

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
  }
}

const memories = new Map([
  ['mem-1', { workspaceKey: 'ws', text: '构建命令是 pnpm build', keywords: ['pnpm', 'build', '构建命令'], status: 'active', sourceSessionId: 's', sourceSeq: 1, createdAt: now, updatedAt: now }],
])
const fakeStore = (seed = {}) => ({
  memories: table(seed.memories ?? []),
  toolMemory: table(seed.toolMemory ?? []),
  signals: table(seed.signals ?? []),
})
const obs = (name, text, isError = false) => ({ name, args: {}, text, isError })
const quiet = { ...repeat, hotSignal: false }

let passed = 0
const ok = (label) => { passed += 1; console.log('ok - ' + label) }

// ---- requirement A: in-request recall ----
{
  const state = createTracker().begin('s1', 1, 0, '构建命令 pnpm build')
  observe(state, obs('read', 'pnpm build ok'), quiet, memories.entries(), 100)
  assert.equal(triggerOf(state, 1, quiet), undefined, 'one call must not trigger')
  observe(state, obs('read', 'pnpm build ok'), quiet, memories.entries(), 100)
  assert.equal(triggerOf(state, 2, quiet), undefined, 'two calls must not trigger')
  observe(state, obs('read', 'pnpm build ok'), quiet, memories.entries(), 100)
  assert.equal(triggerOf(state, 3, quiet), 'tools', 'three calls must trigger the repeat recall')
  ok('A1 每 N 次工具调用触发一次过程内召回（默认 3）')
}

{
  const state = createTracker().begin('s2', 1, 0, 'q')
  observe(state, obs('bash', 'ENOENT: no such file or directory', true), repeat, memories.entries(), 100)
  assert.equal(triggerOf(state, 1, repeat), 'hot', 'a failed tool call is a high-signal change')
  ok('A2 工具报错立即触发高信号召回')
}

{
  const state = createTracker().begin('s3', 1, 0, 'q')
  observe(state, obs('read', 'see src/unrelated-thing.ts at G:/repo/unrelated.ts', false), repeat, memories.entries(), 100)
  assert.equal(triggerOf(state, 1, repeat), undefined, 'a bare new path alone is routine, not hot')
  const state2 = createTracker().begin('s4', 1, 0, 'q')
  observe(state2, obs('read', 'G:/repo/build.md 记录 构建命令 pnpm build 的产物'), repeat, memories.entries(), 100)
  assert.equal(triggerOf(state2, 1, repeat), 'hot', 'new path plus real keyword overlap is hot')
  ok('A3 高信号判定保守：新路径需与记忆关键词重合')
}

{
  const item = (id) => ({ memoryId: id, text: id, score: 1, createdAt: now, keywords: [] })
  const state = createTracker().begin('s5', 1, 0, 'q')
  commitCard(state, 1, [item('m1'), item('m2')], 40)
  assert.deepEqual(freshItems([item('m1'), item('m3')], state, repeat).map((i) => i.memoryId), ['m3'])
  assert.equal(freshItems([item('m1')], state, { ...repeat, dedupe: false }).length, 1)
  ok('A4 去重：已注入的 memory id 不再注入（可配置关闭）')
}

{
  const item = (id) => ({ memoryId: id, text: id, score: 1, createdAt: now, keywords: [] })
  const state = createTracker().begin('s6', 1, 0, 'q')
  for (let index = 0; index < 4; index += 1) commitCard(state, index, [item('m' + index)], 10)
  assert.equal(canInjectCard(state, repeat), false, 'card count cap must stop further cards')
  assert.equal(remainingChars(state, repeat), 6000 - 40)
  const tiny = { ...repeat, maxCharsPerRequest: 200 }
  const state2 = createTracker().begin('s6b', 1, 0, 'q')
  commitCard(state2, 1, [], 210)
  assert.equal(canInjectCard(state2, tiny), false, 'character cap must stop further cards')
  ok('A5 上限：卡片数与字符数两条预算都会封顶')
}

{
  const items = [{ memoryId: 'm1', text: '构建命令是 pnpm build', score: 2, createdAt: now, keywords: [] }]
  const text = renderRepeatCard(items, 'gentle', renderCatalog([{ name: 'sm_composite_read_edit', steps: ['read', 'edit'], description: 'd', parameters: ['p0_path'], hits: 2 }]))
  assert.ok(text.includes('过程内补充'), 'repeat card must be distinguishable from the opening card')
  assert.ok(text.includes('可用组合工具'), 'catalog block must be present')
  assert.ok(text.includes('sm_composite_read_edit'), 'catalog must name the composite')
  assert.ok(buildQuery({ baseQuery: 'a', toolText: 'b' }, 10) === 'a' + String.fromCharCode(10) + 'b')
  assert.equal(extractPaths('open G:/repo/src/a.ts and ./b/c.ts').length >= 1, true)
  assert.equal(memoryOverlap('构建命令 pnpm build', memories.entries(), 10) >= 3, true)
  ok('A6 卡片标题/结构化目录/查询拼接/路径与重合度工具函数')
}

// ---- requirement B: auto tool-ization + catalog ----
const scenarios = () => [
  { tools: ['read', 'edit'], args: [{ path: 'a.ts' }, { old: 'x' }] },
]
const makeDeps = (log) => ({
  register: async (_ctx, _store, spec) => { log.push('register:' + spec.name); return () => {} },
  persist: async (store, spec, key) => {
    log.push('persist:' + spec.name)
    await store.toolMemory.put('tm-' + log.length, { kind: 'composite', trigger: key, description: spec.description, entry: JSON.stringify(spec), useCount: 0, status: 'active' })
    return 'tm'
  },
  toolExists: () => true,
  now: () => now,
})

{
  const log = []
  const store = fakeStore()
  const first = await autoToolizeFromSequence({}, store, 'ws-1', ['read', 'edit'], scenarios(), toolize, logger, makeDeps(log))
  assert.equal(first.action, 'create', 'crossing the threshold must register immediately')
  assert.ok(log.some((line) => line.startsWith('register:sm_composite_')))
  assert.equal(store.toolMemory.size, 1, 'the composite definition must be persisted')
  const second = await autoToolizeFromSequence({}, store, 'ws-1', ['read', 'edit'], scenarios(), toolize, logger, makeDeps(log))
  assert.equal(second.action, 'duplicate', 'the same sequence must not be fixated twice')
  ok('B1 自动固化：注册 + 持久化，重复序列不重复固化')
}

{
  const log = []
  const store = fakeStore()
  const deps = makeDeps(log)
  const first = await autoToolizeFromSequence({}, store, 'ws-cd', ['read', 'edit'], scenarios(), toolize, logger, deps)
  assert.equal(first.action, 'create')
  const second = await autoToolizeFromSequence({}, store, 'ws-cd', ['read', 'grep'], scenarios(), toolize, logger, deps)
  assert.equal(second.action, 'cooldown', 'the cooldown window must prevent a second fixation')
  assert.equal(store.toolMemory.size, 1)
  ok('B2 冷却：同一工作区冷却窗口内不再自动固化')
}

{
  const base = { existingNames: new Set(), activeCount: 0, cooldown: false, registered: new Set(['read', 'edit']), config: toolize }
  assert.equal(planAutoToolize({ ...base, tools: ['read', 'edit'], activeCount: 8, config: { ...toolize, maxActive: 8 } }).action, 'cap')
  assert.equal(planAutoToolize({ ...base, tools: ['read', 'edit'], cooldown: true }).action, 'cooldown')
  assert.equal(planAutoToolize({ ...base, tools: ['read', 'edit'], existingNames: new Set(['sm_composite_read_edit']) }).action, 'duplicate')
  assert.equal(planAutoToolize({ ...base, tools: ['run_code', 'run_code'], registered: new Set(['run_code']) }).action, 'invalid')
  assert.equal(planAutoToolize({ ...base, tools: ['read', 'missing'], registered: new Set(['read']) }).action, 'invalid')
  assert.equal(planAutoToolize({ ...base, tools: ['read', 'edit'], config: { ...toolize, enabled: false } }).action, 'disabled')
  ok('B3 上限/冷却/重复/非法序列/关闭 全部按规则拒绝')
}

{
  const spec = { name: 'sm_composite_read_edit', description: 'd', steps: [{ tool: 'read', arguments: { path: 'a' } }, { tool: 'edit', arguments: {} }], parameters: [{ name: 'p0_path', step: 0, key: 'path', description: 'path' }] }
  const candidates = [{ id: 'tm-1', spec, useCount: 2 }]
  const live = new Set(['sm_composite_read_edit'])
  assert.equal(longestPrefixMatch(['x', 'read', 'edit'], ['read', 'edit', 'test']), 2)
  const match = pickCompositeMatch(['read', 'edit'], candidates, live)
  assert.equal(match.hits, 2, 'a two-step prefix must be detected')
  assert.equal(pickCompositeMatch(['read', 'edit'], candidates, new Set()), undefined, 'a non-live composite is never advertised')
  const catalog = catalogFor(['read', 'edit'], candidates, live, 3)
  assert.equal(catalog[0].hits, 2)
  assert.ok(renderCatalog(catalog).includes('建议直接调用它'))
  ok('B4 组合工具前缀匹配与结构化目录（只列已注册工具）')
}

{
  const state = createTracker().begin('s7', 1, 0, 'q')
  for (const name of ['read', 'edit', 'read', 'edit', 'read', 'edit', 'grep']) {
    observe(state, obs(name, ''), quiet, memories.entries(), 100)
  }
  const repeatWindow = repeatedWindow(state, toolize)
  assert.ok(repeatWindow, 'a window repeated three times inside one request must be found')
  assert.equal(repeatWindow.tools.join('>'), 'read>edit')
  assert.equal(repeatWindow.count >= 3, true)
  assert.equal(repeatedWindow(createTracker().begin('s8', 1, 0, 'q'), toolize), undefined)
  ok('B5 同一请求内重复窗口即硬信号（无需用户确认）')
}

{
  const log = []
  const sample = JSON.stringify({ tools: ['read', 'edit'], args: [{ path: 'a' }, {}] })
  const store = fakeStore({ signals: [['ws/ws-s/seq/read>edit', { workspaceKey: 'ws-s', pattern: 'read>edit', count: 3, lastSeen: now, examples: [], sequence: ['read', 'edit'], samples: [sample], proposedAt: now, proposalStatus: 'pending' }]] })
  const created = await sweepAutoToolize({}, store, toolize, logger, makeDeps(log))
  assert.equal(created, 1, 'a crossed pending signal must be fixated at boot')
  assert.equal(store.signals.get('ws/ws-s/seq/read>edit').proposalStatus, 'accepted')
  assert.equal(await sweepAutoToolize({}, fakeStore(), { ...toolize, enabled: false }, logger, makeDeps([])), 0)
  ok('B6 启动扫描：已达阈值的 pending 信号自动固化（关闭时不动）')
}

console.log(String.fromCharCode(10) + passed + ' checks passed')
process.exit(0)
