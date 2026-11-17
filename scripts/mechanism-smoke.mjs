/**
 * mechanism-smoke — unit checks for requirement A (in-request recall) and
 * requirement B (auto tool-ization + structured composite catalog).
 *
 * Host-free: the pure helpers and the injectable auto-toolize seam are driven
 * directly, so these invariants hold without a DSH host. Section E drives the
 * real attachPanel() with a fake typert registry, which is the regression gate
 * for the 2026-11-18 GUI 404 (descriptors never registered, silently).
 * Usage: node scripts/mechanism-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

// src/panel.ts (section E below) uses TypeScript parameter properties, which
// Node strip-only mode rejects. Re-exec once with the full transform; every
// other .ts import in this script behaves the same either way.
if (!process.execArgv.includes('--experimental-transform-types')) {
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

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
  topicsets: table(seed.topicsets ?? []),
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

// ---- requirement C: session naming ----
const { sessionTitleFor, cleanTitleText, truncateChars, ensureMemberTitle, applySessionTitle } = await import('../src/title.ts')

{
  const title = sessionTitleFor('导出功能', '## 修复 **CSV** 导出' + String.fromCharCode(10) + '第二行说明', [])
  assert.equal(title.startsWith('导出功能 · '), true, 'title must join topic and task')
  assert.equal(title.includes('##'), false, 'heading markup must be stripped')
  assert.equal(title.includes('**'), false, 'emphasis markup must be stripped')
  assert.equal(Array.from(title).length <= 40, true, 'title must stay within 40 chars')
  assert.equal(Array.from(sessionTitleFor('', '一'.repeat(60))).length, 16, 'task snippet is capped at 16 chars')
  assert.equal(sessionTitleFor('', ''), '新会话', 'empty input falls back to a readable default')
  assert.equal(cleanTitleText('- [ ] 待办事项'), '待办事项', 'task box and bullet stripped')
  ok('C1 命名规则：去标记 / 首行截断 16 / 总长 40 / 空任务兜底')
}

{
  const first = sessionTitleFor('导出功能', '修复导出', [])
  const second = sessionTitleFor('导出功能', '修复导出', [first])
  const third = sessionTitleFor('导出功能', '修复导出', [first, second])
  assert.equal(second.endsWith('（2）'), true, 'a duplicate appends an ordinal')
  assert.equal(third.endsWith('（3）'), true, 'the ordinal keeps counting')
  assert.equal(Array.from(second).length <= 40, true, 'the ordinal never overflows the cap')
  ok('C2 去重：同话题集重名追加序号且不超长')
}

{
  const store = fakeStore({ topicsets: [['ts-1', { workspaceKey: 'ws', title: '导出功能', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }]] })
  const title = await ensureMemberTitle(store, 'ts-1', { sessionId: 'branch-1', kind: 'root' }, '导出功能', '# 修复 CSV 导出')
  assert.equal(title, '导出功能 · 修复 CSV 导出')
  const member = store.topicsets.get('ts-1').members[0]
  assert.equal(member.sessionId, 'branch-1')
  assert.equal(member.title, title, 'the dispatch member title must be persisted')
  const again = await ensureMemberTitle(store, 'ts-1', { sessionId: 'branch-1', kind: 'root' }, '导出功能', '完全不同的任务')
  assert.equal(again, title, 'reuse keeps the first stable name')
  ok('C3 dispatch 后 member title 被设置（复用保持首次命名）')
}

{
  const calls = []
  const session = { append(type, data) { calls.push([type, data]) } }
  const host = { sessions: { get: () => session }, get: () => ({ get: () => undefined, rename: (_s, t) => { calls.push(['rename', t]) } }) }
  assert.equal(applySessionTitle(host, 's', '标题 · 任务', logger), 'host')
  assert.deepEqual(calls[0], ['rename', '标题 · 任务'])
  const already = { sessions: { get: () => session }, get: () => ({ get: () => ({ title: '旧标题' }), rename: () => { throw new Error('must not rename') } }) }
  assert.equal(applySessionTitle(already, 's', '新标题', logger), 'already')
  const fallback = { sessions: { get: () => session }, get: () => undefined }
  assert.equal(applySessionTitle(fallback, 's', '回退标题', logger), 'fallback')
  assert.deepEqual(calls[calls.length - 1][0], 'session/title')
  assert.equal(calls[calls.length - 1][1].source.kind, 'user')
  assert.equal(applySessionTitle({ sessions: { get: () => undefined } }, 's', 'x', logger), 'none')
  ok('C4 宿主命名优先；无服务时回退 session/title 日志事件；已有标题不覆盖')
}

// ---- requirement D: interrupted settlement (abort / timeout / reload) ----
const { settleInterruptedDispatches } = await import('../src/observe.ts')
const dDeps = (dispatches, options = {}) => {
  const store = { dispatches: table(dispatches), outbox: table(), episodes: table(), ...options }
  return { deps: { ctx: { agents: { get: () => undefined } }, store, config: { enabled: true, maxTokensPolicy: 'deliver-partial' }, logger }, store }
}

{
  const stale = now - 3600000
  const { deps, store } = dDeps([['dsp-1', { branchSessionId: 'b1', task: '任务甲', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', createdAt: stale, updatedAt: stale }]])
  const first = await settleInterruptedDispatches(deps, { timeoutMs: 60000, now, reason: '超时未结算' })
  assert.equal(first.length, 1)
  assert.equal(store.dispatches.get('dsp-1').status, 'interrupted')
  const row = store.outbox.get('dlv-dsp-1')
  assert.equal(!!row, true, 'the interrupt must enqueue a relay')
  assert.equal(row.payload.includes('分支中断'), true)
  assert.equal(row.payload.includes('超时未结算'), true)
  const second = await settleInterruptedDispatches(deps, { timeoutMs: 60000, now })
  assert.equal(second.length, 0, 'a second sweep must not duplicate')
  assert.equal(store.outbox.size, 1)
  ok('D1 超时无终态 → 标记 interrupted 并补发一次回执（幂等）')
}

{
  const stale = now - 3600000
  const { deps, store } = dDeps([['dsp-2', { branchSessionId: 'b2', task: '任务乙', hubSessionId: 'hub', startSeq: 0, status: 'failed', turnEndReason: 'aborted', createdAt: stale, updatedAt: stale }]])
  const settled = await settleInterruptedDispatches(deps, { timeoutMs: 60000, now })
  assert.equal(settled.length, 1, 'a failed dispatch that never reached the hub is backfilled')
  assert.equal(store.outbox.get('dlv-dsp-2').payload.includes('aborted'), true)
  ok('D2 已 failed 但从未送达 → 启动对账补发回执')
}

{
  const fresh = now - 1000
  const { deps: freshDeps, store: freshStore } = dDeps([['dsp-3', { branchSessionId: 'b3', task: '任务丙', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', lastActivityAt: fresh, createdAt: fresh, updatedAt: fresh }]])
  const quietRun = await settleInterruptedDispatches(freshDeps, { timeoutMs: 60000, now })
  assert.equal(quietRun.length, 0, 'a live branch with recent activity is untouched')
  assert.equal(freshStore.dispatches.get('dsp-3').status, 'dispatched')
  // dispose path: timeout 0 interrupts anything still open
  const drained = await settleInterruptedDispatches(freshDeps, { timeoutMs: 0, now, reason: '插件重载/卸载导致分支中断' })
  assert.equal(drained.length, 1)
  assert.equal(freshStore.outbox.get('dlv-dsp-3').payload.includes('插件重载/卸载'), true)
  ok('D3 活跃分支不误伤；插件卸载时 timeout=0 立即结算在途派发')
}

// ---- panel wire contract: registration, binding, client parity ----
// Regression gate for the 2026-11-18 GUI 404: attachPanel used to read
// `ctx.typert.register(...)` (a proxy property that throws without inject)
// inside a silent catch, so no descriptor ever reached the typert registry and
// the API Gateway answered 404 for every /api/supermemoryPanel/* call.
const { attachPanel } = await import('../src/panel.ts')
const { PANEL_REMOTE } = await import('../src/client/remote.ts')

const member = (sessionId, status, lastActiveAt) => ({ sessionId, kind: 'root', title: sessionId, summary: '', status, lastActiveAt })
const topicSet = (id, status, members, lastActiveAt = now) => ({ workspaceKey: 'ws', title: id, summary: '', keywords: [], status, members, createdAt: now, updatedAt: now, lastActiveAt })
const panelStore = () => fakeStore({ topicsets: [
  ['ts-live', topicSet('ts-live', 'active', [member('branch-1', 'live', now - 1000), member('branch-2', 'idle', now)])],
  ['ts-other', topicSet('ts-other', 'active', [member('branch-1', 'live', now - 5000)], now - 6000)],
  ['ts-archived', topicSet('ts-archived', 'archived', [member('branch-3', 'live', now)])],
] })
const fakeCtx = (services) => ({
  provide: (key, value) => { services[key] = value },
  get: (name) => (name === 'typert' ? services.typert : services[name]),
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
})

{
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  const registered = []
  const services = { typert: { register: (contribution) => { registered.push(contribution); return () => {} } } }
  attachPanel(fakeCtx(services), panelStore())
  console.warn = originalWarn
  assert.equal(registered.length, 1, 'attachPanel must register exactly one contribution')
  assert.equal(warnings.length, 0, 'a healthy host must not warn')
  const contribution = registered[0]
  assert.equal(contribution.package, 'dsh-supermemory')
  assert.equal(contribution.face, 'host')
  const hostIds = contribution.invocations.map((d) => d.id)
  assert.ok(hostIds.includes('dsh-supermemory#supermemoryPanel/listTopicSets'))
  assert.ok(hostIds.includes('dsh-supermemory#supermemoryPanel/sessionBadge'))
  const service = services.supermemoryPanel
  assert.ok(service, 'the panel service must be provided as supermemoryPanel')
  assert.equal(service.typertRemote.serviceKey, 'supermemoryPanel')
  assert.equal(service.typertRemote.service, service, 'the binding must point at the instance')
  assert.equal(service.typertRemote.namespace, 'supermemoryPanel')
  assert.equal(Object.keys(service).includes('typertRemote'), false, 'the binding must stay non-enumerable')
  // every descriptor must satisfy the host validateInvocation rules
  for (const d of contribution.invocations) {
    assert.ok(d.id.length > 0, 'invocation id must be nonempty')
    assert.ok(d.service.length > 0 && !d.service.includes('#'), 'service key must be a segment')
    assert.match(d.namespace, /^[A-Za-z0-9_$.-]+$/)
    assert.match(d.method, /^[A-Za-z0-9_$.-]+$/)
    assert.ok(d.result.typeSymbol.length > 0)
    assert.equal(typeof d.result.create, 'function')
    for (const parameter of d.parameters) {
      assert.match(parameter.name, /^[A-Za-z0-9_$.-]+$/)
      assert.match(parameter.wire, /^[A-Za-z0-9_$.-]+$/)
      assert.ok(parameter.codec.typeSymbol.length > 0)
      assert.equal(typeof parameter.codec.create, 'function')
    }
  }
  const clientIds = PANEL_REMOTE.descriptors.map((d) => d.id)
  assert.deepEqual([...hostIds].sort(), [...clientIds].sort(), 'host and client descriptor id sets must match')
  ok('E1 面板 typert 注册：ctx.get(typert) 注册一次 + typertRemote 绑定 + 描述符合法 + 合同 parity')
}

{
  const services = { typert: { register: () => () => {} } }
  attachPanel(fakeCtx(services), panelStore())
  const service = services.supermemoryPanel
  assert.deepEqual(service.sessionBadge('branch-1'), { kind: 'branch', topicSetId: 'ts-live', topicSetTitle: 'ts-live', status: 'live' }, 'two hits resolve to the newest lastActiveAt')
  assert.deepEqual(service.sessionBadge('branch-2'), { kind: 'branch', topicSetId: 'ts-live', topicSetTitle: 'ts-live', status: 'idle' })
  assert.deepEqual(service.sessionBadge('branch-3'), { kind: 'hub' }, 'an archived topic set never marks a branch')
  assert.deepEqual(service.sessionBadge('hub-session'), { kind: 'hub' })
  ok('E2 sessionBadge：活跃话题集成员→分支（最新 lastActiveAt 取胜），归档/未知→中枢')
}

{
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  const missing = {}
  const dispose = attachPanel(fakeCtx(missing), panelStore())
  console.warn = originalWarn
  assert.equal(typeof dispose, 'function')
  assert.ok(missing.supermemoryPanel, 'the service is still provided without a registry')
  assert.ok(warnings.some((w) => w.includes('typert registry unavailable')), 'a missing registry must warn')
  const thrown = { typert: { register: () => { throw new Error('typert: package face is already registered') } } }
  const warnings2 = []
  console.warn = (...args) => { warnings2.push(args.map(String).join(' ')) }
  attachPanel(fakeCtx(thrown), panelStore())
  console.warn = originalWarn
  assert.ok(warnings2.some((w) => w.includes('typert register failed')), 'a failed registration must warn')
  assert.equal(attachPanel(fakeCtx({}), undefined)(), undefined, 'no store means a no-op')
  ok('E3 降级路径：typert 缺失/注册抛错只 warn 不静默，无 store 时空挂载')
}

// ---- requirement R7: hub quick launcher (catalogs + session options) ----
// Drives the real SupermemoryPanelService with a fake context: the catalog
// readers, the option-carrying session creation and the composite-tool delete
// must behave (and degrade) without a DSH host.
const { SupermemoryPanelService } = await import('../src/panel.ts')
const { deleteCompositeTool } = await import('../src/composite.ts')

const serviceCtx = (services = {}) => ({
  get: (name) => services[name],
  agents: services.agents ?? { create: async () => ({}), get: () => undefined },
  sessions: services.sessions ?? { get: () => undefined },
  workspaceRegistry: services.workspaceRegistry,
  sessionTitle: services.sessionTitle,
})

{
  const created = []
  const applied = []
  const services = {
    agents: {
      create: async (options) => { created.push(options); return { agent: { session: { id: options.sessionId } } } },
      get: (id) => ({ id, session: { id } }),
    },
    agentPresets: {
      defaultId: 'default-preset',
      list: async () => [
        { id: 'default-preset', name: '默认模式', description: 'd' },
        { id: 'plan', name: '计划模式' },
        { id: 'broken', broken: 'mount failed' },
      ],
    },
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async (provider) => [{ provider, id: 'step-5', name: 'Step 5' }],
    },
    permissionPresets: {
      catalog: () => ({ options: [{ value: 'workspace-write', name: 'workspace-write', description: 'w' }, { value: 'danger-full-access', name: 'danger-full-access' }], defaultPreset: 'workspace-write' }),
      set: (session, name) => { applied.push([session.id, name]) },
    },
    sessions: { get: (id) => ({ id, append: () => {} }) },
    workspaceRegistry: { resolveByPath: async () => ({ attachSession: async () => {} }) },
  }
  const service = new SupermemoryPanelService(fakeStore(), serviceCtx(services))
  const presets = await service.listAgentPresets()
  assert.deepEqual(presets.map((p) => [p.id, p.isDefault]), [['default-preset', true], ['plan', false], ['broken', false]], 'the roster keeps declaration order and marks the default')
  const catalog = await service.listModelCatalog()
  assert.deepEqual(catalog.models, [{ provider: 'deepseek', id: 'step-5', name: 'Step 5' }], 'the model catalog comes from the runtime llm service')
  const permissions = await service.listPermissions()
  assert.equal(permissions.defaultPreset, 'workspace-write')
  assert.deepEqual(permissions.options.map((o) => o.value), ['workspace-write', 'danger-full-access'])
  const hub = await service.createHubSession('F:\\ws', { agentPreset: 'plan', model: { provider: 'deepseek', model: 'step-5' }, permission: 'danger-full-access' })
  assert.equal(hub.status, 'ok', 'a hub session is created')
  assert.ok(hub.id.startsWith('session-'), 'the hub session id uses the session prefix')
  assert.equal(created.length, 1, 'exactly one agent is created')
  assert.equal(created[0].meta.cwd, 'F:\\ws')
  assert.equal(created[0].meta.agentPreset, 'plan', 'the preset rides the creation metadata')
  assert.deepEqual(created[0].agentOptions, { provider: 'deepseek', model: 'step-5' }, 'the model rides the agent options')
  assert.deepEqual(applied, [[created[0].sessionId, 'danger-full-access']], 'the permission preset is applied to the created session')
  const bare = await service.createHubSession('', {})
  assert.equal(bare.status, 'error', 'a missing workspace is refused')
  const noCtx = new SupermemoryPanelService(fakeStore(), undefined)
  assert.equal((await noCtx.createHubSession('F:\\ws')).status, 'error', 'no host context is reported, not thrown')
  ok('F1 快速启动目录与选项：预设/模型/权限目录映射 + 中枢会话携带 agentPreset/model/permission')
}

{
  const services = {}
  const service = new SupermemoryPanelService(fakeStore(), serviceCtx(services))
  assert.deepEqual(await service.listAgentPresets(), [], 'a missing preset service degrades to an empty roster')
  assert.deepEqual(await service.listModelCatalog(), { providers: [], models: [] }, 'a missing llm service degrades to an empty catalog')
  assert.deepEqual(await service.listPermissions(), { options: [], defaultPreset: '' }, 'a missing permission service degrades to an empty catalog')
  ok('F2 降级：宿主目录服务缺失时快速启动仍可用（各自为空，不抛错）')
}

{
  const store = fakeStore({ topicsets: [['ts-1', { workspaceKey: 'ws', title: '话题一', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }]] })
  const created = []
  const services = {
    agents: { create: async (options) => { created.push(options); return {} }, get: () => undefined },
    sessions: { get: (id) => ({ id, append: () => {} }) },
    workspaceRegistry: { resolveByPath: async () => ({ attachSession: async () => {} }) },
  }
  const service = new SupermemoryPanelService(store, serviceCtx(services))
  const result = await service.createTopicSetSession('F:\\ws', ['ts-1', 'ts-missing'], { agentPreset: 'plan', permission: 'workspace-write' })
  assert.equal(result.status, 'ok', 'a topic-set session is created')
  assert.equal(created[0].meta.agentPreset, 'plan', 'the topic-set path forwards the preset too')
  const member = store.topicsets.get('ts-1').members[0]
  assert.equal(member.sessionId, result.id, 'the session joins the topic set')
  assert.equal(member.title, '话题一', 'the member row is named')
  const none = await service.createTopicSetSession('F:\\ws', [], {})
  assert.equal(none.status, 'error', 'no valid topic set is refused')
  ok('F3 话题集会话：选项透传 + 成员登记 + 空选择拒绝')
}

{
  // deleteCompositeTool: durable row + trigger signal + live registration.
  const disposed = []
  const spec = { name: 'sm_composite_a_b', description: 'd', steps: [{ tool: 'a', arguments: {} }], parameters: [] }
  const store = fakeStore({
    toolMemory: [['tm-1', { kind: 'composite', trigger: 'ws/ws/seq/a>b', description: 'd', entry: JSON.stringify(spec), useCount: 0, status: 'retired' }]],
    signals: [['ws/ws/seq/a>b', { workspaceKey: 'ws', pattern: 'a>b', count: 3, lastSeen: now, examples: [], sequence: ['a', 'b'], samples: [], proposedAt: now, proposalStatus: 'accepted' }]],
  })
  const missing = await deleteCompositeTool(serviceCtx(), store, 'tm-nope')
  assert.equal(missing.status, 'error', 'an unknown tool is refused')
  const done = await deleteCompositeTool(serviceCtx(), store, 'tm-1')
  assert.equal(done.status, 'ok')
  assert.equal(store.toolMemory.size, 0, 'the durable row is gone')
  assert.equal(store.signals.size, 0, 'the creating signal is gone (a repeat must cross the threshold again)')
  // A LIVE registration is unregistered through the same dispose path the
  // retire button uses (editCompositeTool); the real registerComposite needs
  // the host @deepseek-ai/dsh-tools module, which this host-free smoke cannot
  // import, so the live branch is covered by the panel retire flow instead.
  const broken = fakeStore({ toolMemory: [['tm-3', { kind: 'composite', trigger: '', description: 'd', entry: '{oops', useCount: 0, status: 'active' }]] })
  const brokenResult = await deleteCompositeTool(serviceCtx(), broken, 'tm-3')
  assert.equal(brokenResult.status, 'ok', 'a broken definition still deletes')
  assert.equal(broken.toolMemory.size, 0, 'the broken row is gone too')
  assert.deepEqual(disposed, [], 'no live registration exists to dispose in this smoke')
  ok('F4 组合工具删除：行 + 信号 + 损坏定义均可删除，未知 id 拒绝')
}


console.log(String.fromCharCode(10) + passed + ' checks passed')
process.exit(0)
