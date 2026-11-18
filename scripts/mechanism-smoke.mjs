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
import { readFileSync } from 'node:fs'
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
// R22 能力（capability）：数据模型 / 执行安全闸 / 注册-持久化-重建 / 面板一键执行。
const {
  buildCapabilitySpec, capabilityToolName, isValidCapabilityName, runCapability,
  registerCapability, capabilityRecordsOf, rebuildComposites, persistComposite,
} = await import('../src/composite.ts')

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
  // Every read model (R19 hub-branches / panel view / topic shape) may touch
  // these tables; a fixture missing one must fail a test, not throw a TypeError.
  dispatches: table(seed.dispatches ?? []),
  episodes: table(seed.episodes ?? []),
  requirements: table(seed.requirements ?? []),
  filemap: table(seed.filemap ?? []),
  routing: table(seed.routing ?? []),
  hotcache: table(seed.hotcache ?? []),
  outbox: table(seed.outbox ?? []),
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
  assert.equal(Array.from(title).length <= 80, true, 'title must stay within 80 chars')
  const longSnippet = sessionTitleFor('', '一'.repeat(60))
  assert.equal(Array.from(longSnippet).length, 48, 'a 60-char task is clipped to the 48-char snippet budget')
  assert.equal(longSnippet.endsWith('…'), true, 'the clipped snippet is marked with an ellipsis')
  assert.equal(sessionTitleFor('', '修'.repeat(40)), '修'.repeat(40), 'a 40-char task is shown whole')
  assert.equal(sessionTitleFor('', ''), '新会话', 'empty input falls back to a readable default')
  assert.equal(cleanTitleText('- [ ] 待办事项'), '待办事项', 'task box and bullet stripped')
  ok('C1 命名规则：去标记 / 任务≤48 字完整展示、超长省略号 / 总长 80 / 空任务兜底')
}

{
  const first = sessionTitleFor('导出功能', '修复导出', [])
  const second = sessionTitleFor('导出功能', '修复导出', [first])
  const third = sessionTitleFor('导出功能', '修复导出', [first, second])
  assert.equal(second.endsWith('（2）'), true, 'a duplicate appends an ordinal')
  assert.equal(third.endsWith('（3）'), true, 'the ordinal keeps counting')
  assert.equal(Array.from(second).length <= 80, true, 'the ordinal never overflows the cap')
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

// ---- title migration: repair rows damaged by the legacy truncation ----
const { planTitlesMigration, applyPlanToStore, migrateTruncatedTitles, renderTitlesMigrationReport, TITLES_MIGRATION_VERSION } = await import('../src/title-migration.ts')
const { clipEllipsis, firstLine } = await import('../src/title.ts')

const tsRow = (over = {}) => ({ workspaceKey: 'ws', title: '', summary: '', keywords: [], status: 'active', members: [], shapeFingerprint: '', shapeGeneratedAt: 0, createdAt: now, updatedAt: now, lastActiveAt: now, ...over })
const dspRow = (over = {}) => ({ topicSetId: 'ts-1', branchSessionId: 'b-1', task: '任务', hubSessionId: 'hub', startSeq: 0, status: 'delivered', createdAt: now, updatedAt: now, ...over })
const memberRow = (sessionId, title, over = {}) => ({ sessionId, kind: 'root', title, summary: '', status: 'idle', modelOverridden: false, lastActiveAt: now, ...over })

{
  // T1: a topic-set title still cut at 12 chars by the dispatch auto-create,
  // and a member title still carrying the 16-char task snippet: both are
  // rebuilt from the dispatch's full task text.
  const task = '修复 SuperMemory 插件（工作区 G:/09 - dsh/SuperMemory）中「话题集标题」和「分支会话标题」被过度截断的问题。用户反馈：这两类标题都有被截断的情况，需要修复。'
  const store = {
    topicsets: table([['ts-1', tsRow({ title: task.slice(0, 12), members: [memberRow('b-1', task.slice(0, 12) + ' · ' + task.slice(0, 16))] })]]),
    dispatches: table([['dsp-1', dspRow({ task })]]),
    meta: table(),
  }
  const plan = planTitlesMigration(store)
  assert.equal(plan.topicSetsTotal, 1)
  assert.equal(plan.membersTotal, 1)
  assert.equal(plan.topicSets.length, 1, 'the 12-cut topic title is recoverable from its dispatch')
  assert.equal(plan.topicSets[0].from, task.slice(0, 12))
  assert.equal(plan.topicSets[0].to, clipEllipsis(firstLine(cleanTitleText(task)), 60))
  assert.equal(plan.members.length, 1, 'the 16-char snippet member title is refreshed')
  assert.equal(plan.members[0].to, sessionTitleFor(plan.topicSets[0].to, task, []))
  assert.ok(plan.members[0].to.includes(' · '), 'the member title keeps the topic · task shape')
  assert.ok(Array.from(plan.members[0].to).length <= 80, 'the refreshed title respects the 80-char cap')
  await applyPlanToStore(store, plan)
  assert.equal(store.topicsets.get('ts-1').title, plan.topicSets[0].to)
  assert.equal(store.topicsets.get('ts-1').members[0].title, plan.members[0].to)
  assert.equal(planTitlesMigration(store).members.length, 0, 'a second plan over the same store is empty')
  ok('T1 旧 12 字话题集标题 + 16 字成员标题 → 按派发任务全文重算（60/48/80），二次规划为空')
}

{
  // T2: without a dispatch row there is no source text: the damaged title is
  // reported and left untouched; model-regenerated and natural titles stay.
  const store = {
    topicsets: table([
      ['ts-cut', tsRow({ title: '我在dsh的插件中看不到' })],
      ['ts-model', tsRow({ title: '【任务】把 SuperM 相关事项推进（目标与范围待补全）', shapeGeneratedAt: now })],
      ['ts-natural', tsRow({ title: '命名验证' })],
    ]),
    dispatches: table(),
    meta: table(),
  }
  const plan = planTitlesMigration(store)
  assert.equal(plan.topicSets.length, 0, 'nothing is recoverable without a dispatch source')
  assert.equal(plan.topicSetsTotal, 3)
  assert.equal(plan.unrecoverable.length, 1, 'the 12-cut title without a source is reported, not touched')
  assert.equal(plan.unrecoverable[0].topicSetId, 'ts-cut')
  assert.equal(plan.unrecoverable[0].title, '我在dsh的插件中看不到')
  ok('T2 无派发源的 12 字标题：保持不动并计入不可恢复；模型/自然标题不动')
}

{
  // T3: a member with no dispatch row is refreshed only when its title IS the
  // old topic-set title (a panel-created root session); a hand-edited title
  // and a bare legacy snippet without a source are never guessed.
  const store = {
    topicsets: table([['ts-1', tsRow({ title: '同步并提交 SuperM', members: [
      memberRow('session-1', '同步并提交 SuperM', { status: 'live' }),
      memberRow('session-2', '手改的标题', { status: 'live' }),
    ] })]]),
    dispatches: table([['dsp-1', dspRow({ task: '同步并提交 SuperMemory 仓库的 Git。' })]]),
    meta: table(),
  }
  const plan = planTitlesMigration(store)
  assert.equal(plan.topicSets.length, 1, 'the topic title is recovered from the dispatch')
  assert.equal(plan.members.length, 1, 'only the member echoing the old topic title is refreshed')
  assert.equal(plan.members[0].sessionId, 'session-1')
  assert.equal(plan.members[0].to, '同步并提交 SuperMemory 仓库的 Git。')
  assert.equal(plan.unrecoverable.length, 0, 'a short hand-edited title is not misreported')
  ok('T3 无派发记录的成员：仅「等于旧话题集标题」的根会话被刷新，手改标题不动')
}

{
  // T4: two members of one set sharing a task keep the ordinal suffix, and a
  // legacy bare snippet without a dispatch row is reported unrecoverable.
  const task = '终验任务：请直接回复一行文字：终验分支确认。不要调用任何工具。'
  const oldTitle = task.slice(0, 12) + ' · ' + task.slice(0, 16)
  const store = {
    topicsets: table([['ts-1', tsRow({ title: task.slice(0, 12), members: [
      memberRow('b-1', oldTitle),
      memberRow('b-2', oldTitle),
      memberRow('b-3', '这是一个派发链路验证任务。请直接'),
    ] })]]),
    dispatches: table([
      ['dsp-1', dspRow({ branchSessionId: 'b-1', task })],
      ['dsp-2', dspRow({ branchSessionId: 'b-2', task, createdAt: now + 1 })],
    ]),
    meta: table(),
  }
  const plan = planTitlesMigration(store)
  assert.equal(plan.members.length, 2, 'both dispatched members are refreshed')
  assert.equal(plan.members[0].to.endsWith('（2）'), false)
  assert.equal(plan.members[1].to.endsWith('（2）'), true, 'the duplicate title gets the ordinal suffix')
  assert.equal(plan.unrecoverable.length, 1, 'the bare 16-char snippet without a dispatch is reported')
  assert.equal(plan.unrecoverable[0].sessionId, 'b-3')
  await applyPlanToStore(store, plan)
  assert.equal(planTitlesMigration(store).members.length, 0, 'a second plan is empty (idempotent)')
  ok('T4 同任务重名追加（2）；无源 16 字片段计入不可恢复；二次规划为空')
}

{
  // T5: the startup pass is marker-guarded; the manual pass re-plans but finds
  // nothing left; dry-run writes nothing; the report renders every bucket.
  const task = '命名验证：直接回复一行文字「命名分支确认」，不要调用任何工具。'
  const store = {
    topicsets: table([['ts-1', tsRow({ title: task.slice(0, 12), members: [memberRow('b-1', task.slice(0, 12) + ' · ' + task.slice(0, 16))] })]]),
    dispatches: table([['dsp-1', dspRow({ task })]]),
    meta: table(),
  }
  const deps = { ctx: { sessions: { get: () => undefined } }, store, logger }
  const preview = await migrateTruncatedTitles(deps, { dryRun: true, ignoreMarker: true })
  assert.equal(preview.status, 'planned')
  assert.equal(preview.members.length, 1)
  assert.equal(store.topicsets.get('ts-1').title, task.slice(0, 12), 'dry-run must not write the store')
  assert.equal(store.meta.size, 0, 'dry-run must not write the marker')
  const applied = await migrateTruncatedTitles(deps)
  assert.equal(applied.status, 'applied')
  assert.equal(applied.applied.topicSets, 1)
  assert.equal(applied.applied.members, 1)
  assert.equal(applied.applied.hostRenamed, 0, 'a dead session is store-only (no host rename faked)')
  assert.equal(store.meta.get('titles').titlesMigrationVersion, TITLES_MIGRATION_VERSION)
  const again = await migrateTruncatedTitles(deps)
  assert.equal(again.status, 'already-done', 'the marker stops a restart from rescanning')
  assert.equal(again.members.length, 0)
  const manual = await migrateTruncatedTitles(deps, { ignoreMarker: true })
  assert.equal(manual.status, 'applied', 'a manual re-scan applies (an empty plan is still a valid apply)')
  assert.equal(manual.members.length + manual.topicSets.length, 0, 'a manual re-scan after the repair finds nothing')
  const report = renderTitlesMigrationReport(applied)
  assert.ok(report.includes('标题补正刷新') && report.includes('分支成员标题') && report.includes('宿主会话改名'), 'the report renders the applied buckets')
  ok('T5 启动迁移有标记幂等；dry-run 不写库；手动重扫空跑；报告渲染各Bucket')
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

const member = (sessionId, status, lastActiveAt, kind = 'fork') => ({ sessionId, kind, title: sessionId, summary: '', status, lastActiveAt })
const topicSet = (id, status, members, lastActiveAt = now) => ({ workspaceKey: 'ws', title: id, summary: '', keywords: [], status, members, createdAt: now, updatedAt: now, lastActiveAt })
const panelStore = () => fakeStore({ topicsets: [
  ['ts-live', topicSet('ts-live', 'active', [member('branch-1', 'live', now - 1000), member('branch-2', 'idle', now), member('hub-root', 'live', now - 2000, 'root'), member('branch-fresh', 'live', now - 1500, 'root')])],
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
  // R19 需求③④：root member = the set's own hub conversation. It must NOT be
  // labelled a branch (the R18 bug) and must carry its topic-set name instead.
  assert.deepEqual(service.sessionBadge('hub-root'), { kind: 'hub-set', topicSetId: 'ts-live', topicSetTitle: 'ts-live' })
  // A fresh dispatch records kind 'root' (its own session root) but its id is
  // `branch-*`: it must stay a branch, never become a hub-set.
  assert.deepEqual(service.sessionBadge('branch-fresh'), { kind: 'branch', topicSetId: 'ts-live', topicSetTitle: 'ts-live', status: 'live' })
  assert.deepEqual(service.sessionBadge('hub-session'), { kind: 'hub' })
  ok('E2 sessionBadge：fork→分支（最新 lastActiveAt），root→hub-set（不再错标分支），归档/未知→中枢')
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

{
  // 2026-11-18 GUI "its strict definition was withdrawn and SRC fallback is
  // forbidden": a plugin reload raced the old fiber's teardown, the new
  // instance's register collided with the still-live package face, the old
  // fiber then withdrew, and nothing re-registered. The registration must retry
  // and heal inside the same process (no restart, no manual reload).
  const endpointOf = (descriptor) => `${descriptor.namespace}/${descriptor.method}`
  const live = new Map()
  let calls = 0
  let first = true
  const typert = {
    local: { get: (key) => live.get(key) },
    register: (contribution) => {
      calls += 1
      if (first) {
        first = false
        throw new Error('typert: package face "dsh-supermemory#host" is already registered')
      }
      for (const descriptor of contribution.invocations) live.set(endpointOf(descriptor), descriptor)
      return () => { for (const descriptor of contribution.invocations) live.delete(endpointOf(descriptor)) }
    },
  }
  const services = { typert }
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  const dispose = attachPanel(fakeCtx(services), panelStore())
  await new Promise((resolve) => setTimeout(resolve, 900))
  console.warn = originalWarn
  assert.ok(calls >= 2, 'a duplicate-face failure must be retried')
  assert.equal(live.size, PANEL_REMOTE.descriptors.length, 'the retry must restore the full panel contract')
  assert.equal(warnings.filter((w) => w.includes('typert register failed')).length, 1, 'a failing attempt warns once, not on every retry')
  dispose()
  assert.equal(live.size, 0, 'the disposer must withdraw the registration it owns')
  ok('E4 注册自愈：重载竞态 duplicate face 退避重试后恢复，dispose 撤销注册')
}

{
  // The same reload race can hit the storage domain: the new fiber opens while
  // the old fiber's domain disposer has not released the name yet. Only
  // `already-open` is a handover (retry); every other failure degrades at once.
  const { retryDomainOpen } = await import('../src/store.ts')
  let calls = 0
  const warned = []
  const value = await retryDomainOpen(async () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error("domain 'supermemory' is already open"), { code: 'already-open' })
    return 'store'
  }, { warn: (message) => warned.push(message) }, [1])
  assert.equal(value, 'store', 'the retry must return the store opened on the next attempt')
  assert.equal(calls, 2)
  assert.equal(warned.length, 1, 'the handover must be logged once')
  let fatalCalls = 0
  const fatal = Object.assign(new Error('unit version mismatch'), { code: 'version-mismatch' })
  await assert.rejects(
    () => retryDomainOpen(async () => { fatalCalls += 1; throw fatal }, { warn: () => {} }, [1]),
    (error) => error === fatal,
  )
  assert.equal(fatalCalls, 1, 'a non-handover failure must not be retried')
  ok('E5 存储域交接：already-open 退避重试，其它失败立即上抛')
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


// ---- requirement R9: dispatched branches inherit the hub's capabilities ----
// A branch created bare by ctx.agents.create() composes only the Host plugins,
// which is why a dispatched branch had no file/shell tools. These checks drive
// the exported composition seam: the hub preset is mounted and the hub's
// permission facts are appended as the branch's durable session events.
const { hubComposition, compositionSetup } = await import('../src/dispatch.ts')

const presetCtx = (overrides = {}) => ({
  get: (name) => ({
    agentPresets: {
      presetForSession: overrides.recorded === undefined ? () => 'standard' : () => overrides.recorded,
      mount: async (_agentCtx, id) => { (overrides.mounted ??= []).push(id) },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    approval: { overrideOf: () => 'never', config: { policy: 'ask' } },
    permissionPresets: { current: () => 'full' },
    ...overrides.services,
  })[name],
})

{
  const hubSession = { id: 'hub', header: { agentPreset: 'standard' } }
  const ctx = presetCtx()
  const composition = hubComposition(ctx, { session: hubSession })
  assert.deepEqual(composition, { presetId: 'standard', sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
    'the hub preset and both permission facts are read')

  const appended = []
  const mounted = []
  const setupCtx = presetCtx({ mounted, recorded: null })
  // recorded:null → the fresh branch has no log yet, so the hub preset is used
  const branchSession = { id: 'branch-1', header: { cwd: 'F:\ws' }, append: (type, data) => appended.push([type, data]) }
  await compositionSetup(setupCtx, composition, logger)({ id: 'agentCtx' }, { session: branchSession })
  assert.deepEqual(mounted, ['standard'], 'the preset is mounted onto the branch agent scope')
  assert.deepEqual(appended, [
    ['sandbox/mode', { mode: 'danger-full-access', source: 'delegation' }],
    ['approval/policy', { policy: 'never', source: 'delegation' }],
  ], 'the branch records the hub sandbox mode and approval policy')
  ok('F5 分支能力继承：中枢 preset 挂载 + 沙箱/审批模式随派发复制')
}

{
  // A resumed branch logs the preset it actually ran under; that record must
  // win over the hub's so one session keeps one composition.
  const mounted = []
  const ctx = presetCtx({ mounted, recorded: 'recorded-preset' })
  await compositionSetup(ctx, { presetId: 'standard' }, logger)({ id: 'c' }, { session: { id: 'b', append: () => {} } })
  assert.deepEqual(mounted, ['recorded-preset'], 'the session-log preset wins on resume')

  // A failed mount must not fail the dispatch, but it must be reported.
  const warnings = []
  const failing = { get: (name) => (name === 'agentPresets'
    ? { presetForSession: () => null, mount: async () => { throw new Error('roster lost') } }
    : undefined) }
  const appended = []
  await compositionSetup(failing, { presetId: 'gone' }, { info: () => {}, warn: (m) => warnings.push(m) })(
    { id: 'c' }, { session: { id: 'b', append: (t, d) => appended.push([t, d]) } },
  )
  assert.equal(warnings.length, 1, 'the degradation is logged')
  assert.deepEqual(appended, [], 'no permission facts are copied without a composition')
  ok('F6 分支继承降级：日志内 preset 优先，mount 失败只告警不失败')
}

// ---- requirement R10/R11: title + tags + body, and the 话题集 session count ----
// The panel contract is the same record shape everywhere: topic sets expose
// tags + session counts, memories expose title/tags, tools expose title/tags,
// and a title/tag match outranks a body-only match in the panel search.
{
  const now2 = Date.now()
  // The panel normalises its cwd argument with path.resolve (src/store.ts
  // workspaceKeyOf), so the fixture must use the same normalised key.
  const WS = (await import('node:path')).resolve('ws')
  const store = fakeStore({ topicsets: [[
    'ts-shape',
    {
      workspaceKey: WS, title: '导出', summary: '把记忆导出为 Markdown', keywords: ['markdown', 'export'],
      status: 'active',
      members: [
        { sessionId: 'b1', kind: 'root', title: '', summary: '', status: 'live', modelOverridden: false, lastActiveAt: 1 },
        { sessionId: 'b2', kind: 'root', title: '', summary: '', status: 'idle', modelOverridden: false, lastActiveAt: 2 },
      ],
      createdAt: now2, updatedAt: now2, lastActiveAt: now2,
    },
  ]] })
  store.memories = table([
    ['mem-t', { workspaceKey: WS, title: '构建命令', tags: [], keywords: ['构建命令'], text: '构建命令是 pnpm build', status: 'active', sourceSessionId: 's', sourceSeq: 1, createdAt: now2, updatedAt: now2 }],
    ['mem-b', { workspaceKey: WS, title: '杂项', keywords: [], text: '构建命令写在文档里', status: 'active', sourceSessionId: 's', sourceSeq: 2, createdAt: now2 - 1000, updatedAt: now2 - 1000 }],
  ])
  store.toolMemory = table([['tm-1', {
    kind: 'composite', title: '发布流程', tags: ['bash', 'test'], trigger: 'ws/x/seq', description: '组合工具：bash → test',
    entry: JSON.stringify({ name: 'sm_composite_a', steps: [{ tool: 'bash', arguments: {} }], parameters: [] }), useCount: 3, status: 'active',
  }]])

  const service = new SupermemoryPanelService(store, serviceCtx({}))
  const sets = service.listTopicSets('ws')
  assert.deepEqual(sets[0].tags, ['markdown', 'export'], 'topic sets expose their tags')
  assert.equal(sets[0].sessions, 2, 'the 话题集 view carries the session count')
  assert.equal(sets[0].live, 1, 'and how many of them are live')

  const searched = service.listMemories('ws', '构建命令')
  assert.deepEqual(searched.map((m) => m.id), ['mem-t', 'mem-b'], 'a title hit outranks a body-only hit')
  const tools = service.listTools()
  assert.equal(tools[0].title, '发布流程')
  assert.deepEqual(tools[0].tags, ['bash', 'test'])

  // Editing keeps the three layers independent: tags alone, body alone.
  await service.updateMemory('ws', 'mem-t', '构建命令是 pnpm build', undefined, '构建命令（改）', ['pnpm'])
  const edited = service.listMemories('ws').find((m) => m.id === 'mem-t')
  assert.equal(edited.title, '构建命令（改）')
  assert.deepEqual(edited.tags, ['pnpm'])
  assert.equal(edited.text, '构建命令是 pnpm build', 'the body is untouched by a title/tag edit')
  await service.updateTopicSetSummary('ts-shape', '新梗概', ['new-tag'])
  assert.deepEqual(store.topicsets.get('ts-shape').keywords, ['new-tag'])
  assert.equal(store.topicsets.get('ts-shape').summary, '新梗概')
  ok('G1 记录形态：话题集(标签+会话数)/记忆(标题+标签)/工具(标题+标签) 分离可检索')
}

// ---- requirement R18: hub rail / capability profiles / delegation script ----
// The four capability profiles are the durable contract: static deny lists,
// intersected with the live registry (tools.restrict() rejects unknown names),
// and copied verbatim into the branch's first message.
const { resolveCapabilities, applyCapabilities, DEFAULT_CAPABILITY } = await import('../src/capabilities.ts')
const { buildDispatchScript } = await import('../src/script-delegation.ts')
const { listHubSessions } = await import('../src/hub-sessions.ts')
const { buildTopicSetOpening } = await import('../src/panel.ts')
const nodePath = await import('node:path')

{
  assert.equal(DEFAULT_CAPABILITY, 'read-write')
  assert.deepEqual(resolveCapabilities('full').deny, [], 'full grants everything')
  const read = resolveCapabilities('read')
  for (const name of ['write', 'edit', 'apply_patch', 'bash', 'terminal_open', 'memory_dispatch']) {
    assert.ok(read.deny.includes(name), 'read must deny ' + name)
  }
  assert.ok(!read.deny.includes('read'), 'read must keep the file reader')
  const rw = resolveCapabilities('read-write')
  assert.ok(rw.deny.includes('bash') && rw.deny.includes('terminal_open'), 'read-write has no shell')
  assert.ok(!rw.deny.includes('write') && !rw.deny.includes('edit'), 'read-write keeps write/edit')
  assert.ok(!rw.deny.includes('memory_dispatch'), 'read-write may still dispatch further')
  assert.ok(resolveCapabilities('minimal').deny.includes('web_fetch'), 'minimal denies non-work tools')
  assert.equal(resolveCapabilities('bogus').profile, 'read-write', 'an unknown value falls back to the default')
  assert.equal(resolveCapabilities(undefined).profile, 'read-write')
  ok('H1 能力档位：minimal/read/read-write/full 四档 deny 词表 + 未知回退 read-write')
}

{
  const script = buildDispatchScript({
    task: '修掉构建报错', capabilities: 'full', topicTitle: '发布流程', branchSessionId: 'branch-9', dispatchId: 'dsp-9',
  })
  assert.match(script, /^\[supermemory-dispatch dsp-9\]/, 'the header carries the dispatch id')
  assert.ok(script.includes('话题集：发布流程'))
  assert.ok(script.includes('任务：修掉构建报错'))
  assert.ok(script.includes('本轮能力边界：完全能力'))
  assert.ok(script.includes('越界请汇报而不是硬做'), 'the boundary is explicit in the script, not left to the model')
  assert.ok(script.includes('不要在本分支对话里直接向用户提问'), 'the branch is told not to ask the user directly')
  const read = buildDispatchScript({ task: '审阅', capabilities: 'read', topicTitle: 'x' })
  assert.ok(read.includes('本轮能力边界：只读审阅'))
  assert.ok(read.includes('不能执行 shell/终端命令'))
  // no dispatch id/branch id: the dry-run form still builds a complete script
  assert.ok(!read.includes('分支会话：'))
  ok('H2 派发脚本：能力边界固化成首条消息文本（含四档标签与越界指令）')
}

{
  // read-write: only the names the registry really reports reach restrict().
  const calls = []
  const tools = {
    restrict: (filter) => { calls.push(filter); return () => {} },
    definitions: () => [{ name: 'read' }, { name: 'write' }, { name: 'bash' }, { name: 'memory_dispatch' }],
  }
  const applied = applyCapabilities(tools, { id: 'agent' }, resolveCapabilities('read-write'), logger)
  assert.equal(applied.status, 'applied')
  assert.deepEqual(applied.denied, ['bash'], 'only the present member of the static list is denied')
  assert.deepEqual(calls[0].deny, ['bash'])

  // minimal: deny everything except read / send_message / wait_agent / memory_*.
  const minimalTools = {
    restrict: (filter) => { calls.push(filter); return () => {} },
    definitions: () => [
      { name: 'read' }, { name: 'write' }, { name: 'bash' },
      { name: 'memory_remember' }, { name: 'send_message' }, { name: 'wait_agent' }, { name: 'web_fetch' },
    ],
  }
  applyCapabilities(minimalTools, { id: 'agent' }, resolveCapabilities('minimal'), logger)
  assert.deepEqual([...calls[1].deny].sort(), ['bash', 'web_fetch', 'write'],
    'minimal denies every visible tool outside its allow list')

  // full: nothing to restrict, and restrict() is not even called.
  const before = calls.length
  const full = applyCapabilities(tools, { id: 'agent' }, resolveCapabilities('full'), logger)
  assert.equal(full.status, 'applied')
  assert.equal(calls.length, before, 'full never touches the registry')

  // The registry rejects unknown names; the failure must be reported, not thrown.
  const warns = []
  const throwing = {
    restrict: () => { throw new Error('tools.restrict() names unknown global tool "bash"') },
    definitions: () => [{ name: 'bash' }],
  }
  const failed = applyCapabilities(throwing, { id: 'agent' }, resolveCapabilities('read'), { warn: (m) => warns.push(m) })
  assert.equal(failed.status, 'failed')
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('未生效'))

  // One bounded retry: a name the registry refuses (a scope-local registration
  // is not restrictable) is dropped while the rest of the profile still applies.
  let attempts = 0
  const partial = {
    restrict: () => {
      attempts += 1
      if (attempts === 1) throw new Error('tools.restrict() names unknown global tool "bash"; known global tools: read, write')
    },
    definitions: () => [{ name: 'read' }, { name: 'write' }, { name: 'bash' }],
  }
  const retried = applyCapabilities(partial, { id: 'agent' }, resolveCapabilities('read'), logger)
  assert.equal(retried.status, 'applied', 'the retry keeps the profile minus the refused name')
  assert.deepEqual(retried.denied, ['write'])
  assert.equal(attempts, 2)

  // No tool service (older host / fake scope): quiet degradation, not a failure.
  const missing = applyCapabilities(undefined, { id: 'agent' }, resolveCapabilities('read'), { warn: () => { throw new Error('must not warn') } })
  assert.equal(missing.status, 'unsupported')
  ok('H3 能力落实：静态 deny 与真实工具集求交，full 不动注册表，restrict 抛错只告警，无 tools 静默降级')
}

{
  // The restriction is applied on the BRANCH agent scope, after the preset was
  // mounted (so definitions() sees the preset's tools too).
  const restricted = []
  const agentCtx = {
    id: 'branch-ctx',
    tools: {
      restrict: (filter) => { restricted.push(filter); return () => {} },
      definitions: () => [{ name: 'read' }, { name: 'write' }, { name: 'bash' }],
    },
  }
  await compositionSetup(presetCtx({ recorded: null }), { presetId: 'standard' }, logger, resolveCapabilities('read-write'))(
    agentCtx,
    { session: { id: 'branch-1', append: () => {} } },
  )
  assert.equal(restricted.length, 1, 'compositionSetup applies the capability profile to the branch scope')
  assert.deepEqual(restricted[0].deny, ['bash'], 'the read-write profile removes exactly the shell tools present')
  // Without a profile (an older caller) nothing is restricted.
  const untouched = []
  await compositionSetup(presetCtx({ recorded: null }), { presetId: 'standard' }, logger)(
    { id: 'branch-ctx', tools: { restrict: (f) => { untouched.push(f); return () => {} } } },
    { session: { id: 'b', append: () => {} } },
  )
  assert.equal(untouched.length, 0)
  ok('H4 分支 setup：能力限制挂在 agent scope（preset 挂载之后），无档位时不限制')
}

{
  const WS = nodePath.resolve('ws-hubs')
  const OTHER = nodePath.resolve('ws-other')
  const member = (sessionId, kind = 'fork') => ({ sessionId, kind, title: sessionId, summary: '', status: 'idle', lastActiveAt: 1 })
  const setOf = (status, members) => ({
    workspaceKey: WS, title: status, summary: '', keywords: [], status, members,
    createdAt: 1, updatedAt: 1, lastActiveAt: 1,
  })
  const store = fakeStore({ topicsets: [
    ['ts-active', setOf('active', [member('branch-active'), member('hub-member', 'root'), member('branch-fresh', 'root')])],
    ['ts-archived', setOf('archived', [member('branch-archived')])],
  ] })
  const records = [
    { header: { id: 'hub-new', cwd: WS, createdAt: 2000 }, live: true, persisted: true },
    { header: { id: 'hub-member', cwd: WS, createdAt: 1500 }, live: false, persisted: true },
    { header: { id: 'hub-old', cwd: WS, createdAt: 1000 }, live: false, persisted: true },
    { header: { id: 'child', cwd: WS, createdAt: 3000, origin: 'subagent' } },
    { header: { id: 'fork', cwd: WS, createdAt: 3000, parentSession: 'hub-new' } },
    { header: { id: 'branch-active', cwd: WS, createdAt: 3000 } },
    { header: { id: 'branch-archived', cwd: WS, createdAt: 3000 } },
    // A dispatch that never joined any topic set: only the id prefix catches it.
    { header: { id: 'branch-orphan', cwd: WS, createdAt: 3000 } },
    // A fresh dispatch joined to a set: kind 'root', id `branch-*`.
    { header: { id: 'branch-fresh', cwd: WS, createdAt: 3000 } },
    // A host-native session the plugin minted, still outside every topic set.
    { header: { id: 'session-fresh', cwd: WS, createdAt: 500 } },
    { header: { id: 'other-ws', cwd: OTHER, createdAt: 4000 } },
  ]
  let requestedIds
  const ctx = {
    get: (name) => (name === 'sessionQuery'
      ? {
          listSessions: async () => records,
          readTitleSnapshots: async (ids) => {
            requestedIds = ids
            return [
              { sessionId: 'hub-new', status: 'fulfilled', value: { title: { title: '新中枢', updatedAt: 9000 } } },
              { sessionId: 'hub-old', status: 'rejected' },
            ]
          },
        }
      : undefined),
  }
  const hubs = await listHubSessions(ctx, store, WS)
  assert.deepEqual(hubs.map((h) => h.sessionId), ['hub-new', 'hub-member', 'hub-old', 'session-fresh'],
    'subagents, forks, fork members (archived included) and other workspaces are excluded; a ROOT member stays a hub')
  assert.ok(!hubs.some((h) => h.sessionId.startsWith('branch-')), 'every branch- id is excluded, even a root-kind fresh dispatch')
  assert.ok(hubs.some((h) => h.sessionId === 'session-fresh'), 'a session- id outside every topic set stays a hub')
  assert.deepEqual([...requestedIds].sort(), ['hub-member', 'hub-new', 'hub-old', 'session-fresh'], 'titles are read in ONE batch request')
  assert.equal(hubs[0].title, '新中枢', 'the batch title is used')
  assert.equal(hubs[1].title, '未命名会话 ' + 'hub-member'.slice(-4), 'a rejected/absent title falls back to the id suffix')
  assert.equal(hubs[2].title, '未命名会话 ' + 'hub-old'.slice(-4), 'a rejected title falls back to the id suffix')
  assert.equal(hubs[3].title, '未命名会话 ' + 'session-fresh'.slice(-4), 'the surviving session- hub gets a fallback title too')
  assert.equal(hubs[0].live, true)
  assert.equal(hubs[1].live, false)
  assert.equal(hubs[0].updatedAt, 9000, 'the latest title event orders the rail')
  assert.equal(hubs[0].origin, 'hub')
  assert.equal(hubs[0].cwd, WS, 'rows carry the session cwd (workspace filter is explicit)')
  assert.equal(hubs[0].workspaceKey, nodePath.resolve(WS), 'rows carry the canonical workspace key')
  const rootHub = hubs.find((h) => h.sessionId === 'hub-member')
  assert.equal(rootHub.topicSetId, 'ts-active', 'a root member row names its topic set (for the 「话题集」 badge)')
  assert.equal(rootHub.topicSetTitle, 'active')
  assert.equal((await listHubSessions(ctx, store, WS, 1)).length, 1, 'the row cap is honoured')
  assert.deepEqual(await listHubSessions(undefined, store, WS), [], 'no host context -> empty rail, no throw')

  // Degradation: no sessionQuery but a live session store.
  const liveCtx = {
    get: (name) => (name === 'sessions'
      ? { list: () => [{ id: 'live-hub', header: { id: 'live-hub', cwd: WS, createdAt: 5 } }] }
      : undefined),
  }
  const fallback = await listHubSessions(liveCtx, store, WS)
  assert.deepEqual(fallback.map((h) => h.sessionId), ['live-hub'])
  assert.equal(fallback[0].title, '未命名会话 ' + 'live-hub'.slice(-4))
  ok('H5 中枢会话列表：过滤规则（父/子代理/fork 成员含归档/他工作区/branch- 前缀）、root 成员保留并带话题集、标题批量读取、排序与上限、降级')
}

{
  const WS = nodePath.resolve('ws-sets')
  const store = fakeStore()
  const service = new SupermemoryPanelService(store, serviceCtx({}))
  const created = await service.createTopicSet(WS, '  发布流程  ', undefined, '把发布拆成可执行步骤')
  assert.equal(created.status, 'ok')
  const row = store.topicsets.get(created.id)
  assert.equal(row.title, '发布流程', 'the title is trimmed')
  assert.equal(row.summary, '把发布拆成可执行步骤', 'the body is stored on creation')
  assert.ok(row.keywords.length > 0, 'omitted tags are derived from title/body — a new set is never index-less')
  assert.ok(created.message.includes('标签：'), 'the receipt shows the auto tags')
  const tagged = await service.createTopicSet(WS, '导出', ['markdown', 'export'])
  assert.deepEqual(store.topicsets.get(tagged.id).keywords, ['markdown', 'export'], 'explicit tags win')
  assert.equal((await service.createTopicSet(WS, '  ')).status, 'error', 'an empty title is refused')

  const shape = service.suggestMemoryShape('构建命令是 pnpm build，先装依赖再打包。')
  assert.ok(shape.title.startsWith('构建命令'), 'the derived title is the first clause')
  assert.ok(shape.tags.length > 0, 'the derived tags index the body')
  assert.deepEqual(service.suggestMemoryShape(''), { title: '', tags: [] })

  const opening = buildTopicSetOpening(store, [created.id, tagged.id], '开始吧')
  assert.ok(opening.startsWith('[supermemory-topic-set] 话题集：发布流程、导出'))
  assert.ok(opening.includes('标签:'))
  assert.ok(opening.includes('话题集梗概：把发布拆成可执行步骤'))
  assert.ok(opening.includes('用户开场：开始吧'))
  assert.equal(buildTopicSetOpening(store, [created.id], ''), '', 'an empty opening sends nothing')
  ok('H6 话题集三层写入 + 记忆形态建议 + 话题集会话首条消息携带标题/标签/正文')
}

{
  // R18: "read args.tags/summary in execute" is useless unless the tool
  // contract declares them — a model only sees `parameters`. Assert on the
  // declaration slice (name .. output), because output.schema also carries
  // `tags` and would otherwise mask a missing input parameter.
  const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'memory_new_topicset'")
  assert.ok(start > 0, 'the memory_new_topicset definition exists')
  const outputAt = source.indexOf('output:', start)
  assert.ok(outputAt > start, 'the declaration has an output block')
  const declaration = source.slice(start, outputAt)
  assert.match(declaration, /必须同时给出 title \+ tags \+ summary/, 'the description demands all three layers')
  assert.match(declaration, /不要只给标题/, 'the description says a bare title is not enough')
  assert.match(declaration, /tags:\s*\{[^}]*type:\s*'array'/, 'parameters declare tags as an array, so a model can pass them')
  assert.match(declaration, /tags:\s*\{[^}]*items:\s*\{\s*type:\s*'string'\s*\}/, 'tags items are strings')
  assert.match(declaration, /summary:\s*\{\s*type:\s*'string'/, 'parameters declare summary as a string')
  ok('H7 memory_new_topicset 工具契约：parameters 声明 tags/summary 且描述要求三层齐给（R18 需求②）')
}

{
  // R19 需求⑤：面板内对话 = 读 sessionQuery.readSurface + 发送 followup。
  const { projectChatEvents, chatBlockText, SupermemoryPanelService } = await import('../src/panel.ts')
  assert.equal(chatBlockText({ type: 'text', text: '你好' }), '你好')
  assert.equal(chatBlockText({ type: 'tool-call', name: 'read' }), '（调用 read）')
  assert.equal(chatBlockText({ type: 'reasoning', text: '内部思考' }), '', 'reasoning never becomes chat text')

  const NL = String.fromCharCode(10)
  const events = [
    { seq: 1, type: 'system/message', data: { message: { content: [{ type: 'text', text: 'SYS' }] } } },
    { seq: 2, type: 'user/message', time: 10, data: { message: { content: [{ type: 'text', text: '开始' }] } } },
    { seq: 3, type: 'assistant/message', time: 20, data: { message: { content: [{ type: 'text', text: '好的' }, { type: 'tool-call', name: 'bash' }] } } },
    { seq: 4, type: 'tool/result', time: 30, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: 'stop' } },
  ]
  const projected = projectChatEvents(events, 80)
  assert.deepEqual(projected.messages.map((m) => m.role), ['user', 'assistant', 'tool'])
  assert.ok(projected.messages[1].text.includes('（调用 bash）'))
  assert.equal(projected.truncated, false)
  const capped = projectChatEvents(events, 2)
  assert.equal(capped.messages.length, 2, 'the window keeps the most recent rows')
  assert.equal(capped.truncated, true)

  const WS_CHAT = nodePath.resolve('ws-chat')
  const chatStore = fakeStore({ topicsets: [['ts-chat', {
    workspaceKey: WS_CHAT, title: '对话', summary: '', keywords: [], status: 'active', members: [],
    createdAt: 1, updatedAt: 1, lastActiveAt: 1,
  }]] })
  const chatCtx = serviceCtx({
    sessionQuery: {
      readSurface: async (id) => ({ session: { id }, events }),
      readTitleSnapshots: async () => [{ sessionId: 'session-chat', status: 'fulfilled', value: { title: { title: '我的中枢' } } }],
    },
    // `get` above answers sessionQuery; agents is the dedicated property.
    agents: { get: (id) => ({ id }), create: async () => ({}) },
  })
  const chatService = new SupermemoryPanelService(chatStore, chatCtx)
  const chat = await chatService.readSessionMessages('session-chat', 80)
  assert.equal(chat.title, '我的中枢')
  assert.equal(chat.live, true)
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant', 'tool'])

  // A host without sessionQuery degrades with an explicit note, never throws.
  const coldService = new SupermemoryPanelService(chatStore, { get: () => undefined })
  const cold = await coldService.readSessionMessages('session-cold')
  assert.equal(cold.messages.length, 0)
  assert.ok(cold.note && cold.note.includes('sessionQuery'), 'the missing capability is named')
  ok('H8 面板内对话：surface→user/assistant/tool 投影（跳系统/推理/生命周期）、窗口截断、标题、无 sessionQuery 降级')
}

{
  // R19 需求⑥：模型填写话题集三层；内容指纹 + 节流只在确有新增时重生成；
  // 失败保留旧值（不烧 token、不破坏索引）。
  const { fillTopicShapeOnCreate, maybeRefreshTopicShape, resetTopicShapeState, topicSetFingerprint } = await import('../src/topic-shape.ts')
  const WS_SHAPE = nodePath.resolve('ws-shape')
  const shapeStore = fakeStore({ topicsets: [['ts-shape', {
    workspaceKey: WS_SHAPE, title: '发布流程', summary: '', keywords: [], status: 'active', members: [],
    shapeFingerprint: '', shapeGeneratedAt: 0, createdAt: 1, updatedAt: 1, lastActiveAt: 1,
  }]] })
  let calls = 0
  let answer = '{"title":"发布流程与回滚","tags":["发布","回滚","pnpm"],"summary":"发布与回滚的结论性流程"}'
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [{ provider: 'p', id: 'm', name: 'M' }],
    stream: async function* () {
      calls += 1
      yield { type: 'text-delta', text: answer }
    },
  }
  const shapeCtx = { get: (name) => (name === 'llm' ? llm : undefined) }
  const created = await fillTopicShapeOnCreate({ ctx: shapeCtx, store: shapeStore, logger: { warn: () => {} } }, 'ts-shape', '')
  assert.equal(created?.summary, '发布与回滚的结论性流程')
  const stored = shapeStore.topicsets.get('ts-shape')
  assert.equal(stored.title, '发布流程', 'the creator-supplied title is authoritative on creation')
  assert.deepEqual(stored.keywords, ['发布', '回滚', 'pnpm'])
  assert.equal(stored.summary, '发布与回滚的结论性流程')
  assert.ok(stored.shapeFingerprint, 'the content snapshot is persisted')
  const callsAfterCreate = calls
  // Both layers present -> no second call.
  await fillTopicShapeOnCreate({ ctx: shapeCtx, store: shapeStore, logger: { warn: () => {} } }, 'ts-shape', '')
  assert.equal(calls, callsAfterCreate, 'a fully shaped set costs no tokens')

  resetTopicShapeState()
  // Unchanged content -> activation does not call the model.
  await maybeRefreshTopicShape({ ctx: shapeCtx, store: shapeStore, logger: { warn: () => {} } }, 'ts-shape')
  assert.equal(calls, callsAfterCreate, 'an unchanged fingerprint skips regeneration')

  // New content changes the fingerprint -> one regeneration updates the index.
  await shapeStore.topicsets.update('ts-shape', (row) => ({
    ...row,
    members: [{ sessionId: 'branch-x', kind: 'fork', title: '回滚演练', summary: '', status: 'idle', modelOverridden: false, lastActiveAt: 2 }],
  }))
  assert.notEqual(topicSetFingerprint(shapeStore, 'ts-shape'), stored.shapeFingerprint)
  answer = '{"title":"发布与回滚","tags":["发布","回滚","演练"],"summary":"发布、回滚与演练结论"}'
  await maybeRefreshTopicShape({ ctx: shapeCtx, store: shapeStore, logger: { warn: () => {} } }, 'ts-shape')
  assert.equal(calls, callsAfterCreate + 1, 'changed content triggers exactly one call')
  assert.equal(shapeStore.topicsets.get('ts-shape').summary, '发布、回滚与演练结论')

  // A malformed answer keeps every old value.
  resetTopicShapeState()
  answer = 'the model refused'
  await shapeStore.topicsets.update('ts-shape', (row) => ({ ...row, summary: '旧正文' }))
  const beforeFailure = shapeStore.topicsets.get('ts-shape')
  const failedShape = await maybeRefreshTopicShape({ ctx: shapeCtx, store: shapeStore, logger: { warn: () => {} } }, 'ts-shape')
  void failedShape
  const afterFailure = shapeStore.topicsets.get('ts-shape')
  assert.equal(afterFailure.summary, beforeFailure.summary, 'a failed generation keeps the old body')
  assert.deepEqual(afterFailure.keywords, beforeFailure.keywords, 'a failed generation keeps the old tags')
  ok('H9 话题集自动三层：创建补全、内容指纹去重、激活节流、失败保留旧值')
}


// ---- requirement R20: branch questions go to the hub, never the user ----
// A branch records a STRUCTURED question against its dispatch; the hub
// aggregates every open question and asks the user ONCE. Non-blocking questions
// never stop the branch, and the one group relay carries the merged block.
const {
  dispatchOfBranch, raiseQuestion, openQuestionsOfDispatch, openQuestionsOfGroup,
  openQuestionsForHub, renderQuestionsBlock, renderQuestionList, resolveQuestions, questionsSupported,
} = await import('../src/questions.ts')
const { groupRelayText } = await import('../src/group.ts')

{
  const script = buildDispatchScript({ task: '调研', topicTitle: 'x' })
  assert.ok(script.includes('memory_raise_question'), 'the branch contract names the question tool')
  assert.ok(script.includes('最合理解释'), 'disagreement never stalls the branch')
  assert.ok(script.includes('blocking=true'), 'the blocking exception is stated')
  assert.ok(script.includes('不要在本分支对话里直接向用户提问'), 'the branch never asks the user itself')
  ok('R20-1 派发脚本：分支提问只走上交工具，非阻塞继续按最合理解释推进')
}

{
  const WS = nodePath.resolve('ws-questions')
  const store = {
    topicsets: table([['ts-q', {
      workspaceKey: WS, title: '问题集', summary: '', keywords: [], status: 'active',
      members: [], createdAt: now, updatedAt: now, lastActiveAt: now,
    }]]),
    dispatches: table([
      ['dsp-q1', { topicSetId: 'ts-q', groupId: 'grp-q', branchSessionId: 'branch-q1', task: '改构建', hubSessionId: 'hub-q', startSeq: 0, status: 'dispatched', createdAt: now, updatedAt: now }],
      ['dsp-q2', { topicSetId: 'ts-q', groupId: 'grp-q', branchSessionId: 'branch-q2', task: '补文档', hubSessionId: 'hub-q', startSeq: 0, status: 'dispatched', createdAt: now + 1, updatedAt: now + 1 }],
    ]),
    questions: table(),
  }
  assert.equal(questionsSupported(store), true)
  assert.equal(dispatchOfBranch(store, 'branch-q1')[0], 'dsp-q1', 'a question is attributed to the owning dispatch')

  const blocking = await raiseQuestion(store, 'branch-q1', {
    title: '构建目标不明确', question: '要保留旧产物的兼容层吗？', options: ['保留', '删除'],
    blocking: true, progress: '已定位到 esbuild 配置', defaultPlan: '先保留兼容层',
  })
  assert.equal(blocking.status, 'recorded')
  assert.equal(blocking.blocking, true)
  assert.ok(blocking.message.includes('阻塞'))

  const nonBlocking = await raiseQuestion(store, 'branch-q2', {
    title: '文档放哪', question: 'README 还是 docs/？', severity: 'low',
  })
  assert.equal(nonBlocking.status, 'recorded')
  assert.equal(nonBlocking.blocking, false, 'blocking defaults to false: the branch keeps working')
  assert.ok(nonBlocking.message.includes('继续'))

  // Not a branch -> refuse, instead of storing a question the hub would never see.
  assert.equal((await raiseQuestion(store, 'hub-q', { title: 'x', question: 'y' })).status, 'error')

  assert.equal(openQuestionsOfDispatch(store, 'dsp-q1').length, 1)
  assert.equal(openQuestionsOfGroup(store, 'grp-q').length, 2)
  const hubRows = openQuestionsForHub(store, WS, 'hub-q')
  assert.equal(hubRows.length, 2, 'the hub sees every branch question of its workspace')

  const block = renderQuestionsBlock(openQuestionsOfGroup(store, 'grp-q'))
  assert.ok(block.includes('[阻塞]') && block.includes('[非阻塞]'))
  assert.ok(block.includes('memory_questions'), 'the relay tells the hub how to aggregate')
  const listing = renderQuestionList(hubRows)
  assert.ok(listing.includes('改构建') && listing.includes('默认备选'), 'the hub listing names source, progress and fallback')

  // The ONE group relay carries the merged block, not one relay per branch.
  const relay = groupRelayText(store, 'grp-q', new Map())
  assert.ok(relay.includes('[supermemory-questions]'), 'the group relay carries the question block')
  assert.ok(relay.includes('构建目标不明确') && relay.includes('文档放哪'))

  // Resolve closes only the ids it is given and keeps the user's answer.
  const resolved = await resolveQuestions(store, [blocking.questionId, 'q-foreign'], '保留，先别删')
  assert.equal(resolved, 1)
  assert.equal(openQuestionsOfDispatch(store, 'dsp-q1').length, 0)
  assert.equal(store.questions.get(blocking.questionId).answer, '保留，先别删')
  ok('R20-2 分支问题：结构化上交 / 派发归属 / 中枢汇总可见 / 组 relay 合并 / resolve 记录答复')
}

// ---- R19 协同②③: panel projection of hub → branches ----
// The panel service must expose the association (name/state/set/share count)
// and filter foreign workspaces; a branch card in the topic view carries how
// many hubs dispatched into it.
{
  const nodePath2 = await import('node:path')
  const WS = nodePath2.resolve('ws-comm')
  const now2 = Date.now()
  const member = (sessionId, title, kind = 'fork') => ({
    sessionId, kind, title, summary: '', status: 'idle', modelOverridden: false, lastActiveAt: now2,
  })
  const fork = (sessionId, title) => member(sessionId, title, 'fork')
  const store = {
    topicsets: table([
      ['ts-comm', {
        workspaceKey: WS, title: '协作', summary: '', keywords: ['协作'], status: 'active',
        // R19 fix: a FRESH dispatch records kind 'root' (dispatch.ts), so the
        // shared count must not depend on the raw member kind.
        members: [fork('branch-a', '修构建'), fork('branch-b', '写文档'), member('branch-fresh', '新派发分支', 'root')],
        createdAt: now2, updatedAt: now2, lastActiveAt: now2,
      }],
      ['ts-foreign', {
        workspaceKey: nodePath2.resolve('ws-foreign'), title: '别处', summary: '', keywords: [], status: 'active',
        members: [fork('branch-z', '外部')], createdAt: now2, updatedAt: now2, lastActiveAt: now2,
      }],
    ]),
    memories: table(), episodes: table(), requirements: table(), filemap: table(),
    toolMemory: table(), signals: table(), outbox: table(), routing: table(), hotcache: table(), questions: table(),
    dispatches: table([
      ['d1', { topicSetId: 'ts-comm', branchSessionId: 'branch-a', task: '修构建', hubSessionId: 'hub-1', startSeq: 0, status: 'delivered', createdAt: now2 - 4000, updatedAt: now2 - 3000 }],
      ['d2', { topicSetId: 'ts-comm', branchSessionId: 'branch-a', task: '继续修', hubSessionId: 'hub-2', startSeq: 0, status: 'dispatched', createdAt: now2 - 2000, updatedAt: now2 - 1000 }],
      ['d3', { topicSetId: 'ts-foreign', branchSessionId: 'branch-z', task: '外部', hubSessionId: 'hub-9', startSeq: 0, status: 'delivered', createdAt: now2 - 5000, updatedAt: now2 - 5000 }],
      ['d4', { topicSetId: 'ts-comm', branchSessionId: 'branch-fresh', task: '新任务', hubSessionId: 'hub-3', startSeq: 0, status: 'delivered', createdAt: now2 - 3000, updatedAt: now2 - 2500 }],
      ['d5', { topicSetId: 'ts-comm', branchSessionId: 'branch-fresh', task: '接力', hubSessionId: 'hub-4', startSeq: 0, status: 'delivered', createdAt: now2 - 2400, updatedAt: now2 - 2000 }],
    ]),
  }
  const service = new SupermemoryPanelService(store, undefined)
  const rows = service.listHubBranches(WS, 'hub-2')
  assert.equal(rows.length, 1, 'the panel returns exactly the hub\'s branches')
  assert.equal(rows[0].branchSessionId, 'branch-a')
  assert.equal(rows[0].shared, true, 'a branch shared by two hubs is marked shared')
  assert.equal(rows[0].hubs.length, 2)
  assert.equal(rows[0].status, 'working', 'the open dispatch keeps the branch working')
  assert.equal(rows[0].topicSetTitle, '协作')
  assert.equal(service.listHubBranches(WS, '').length, 0, 'no hub id -> no rows')
  // workspace guard: a hub id from a foreign workspace's dispatch is filtered.
  assert.equal(service.listHubBranches(WS, 'hub-9').length, 0, 'foreign workspace rows are filtered out')

  const view = service.listTopicSets(WS)[0]
  const sharedBranch = view.branches.find((b) => b.sessionId === 'branch-a')
  assert.equal(sharedBranch.hubs, 2, 'the topic-set card says how many hubs share the branch')
  const ownBranch = view.branches.find((b) => b.sessionId === 'branch-b')
  assert.equal(ownBranch.hubs, undefined, 'a branch with no dispatch has no share count')
  assert.equal(ownBranch.topicSetId, 'ts-comm', 'a branch row carries its owning set id')
  assert.equal(ownBranch.topicSetTitle, '协作', 'a branch row carries its owning set title')
  // R19 fix: a fresh dispatch is a kind-root member but still a branch, and its
  // shared count must render exactly like a fork member's.
  const freshBranch = view.branches.find((b) => b.sessionId === 'branch-fresh')
  assert.equal(freshBranch.kind, 'fork', 'a plugin-minted branch is labelled as a branch')
  assert.equal(freshBranch.hubs, 2, 'a kind-root dispatched branch reports its two hubs')
  assert.equal(freshBranch.topicSetTitle, '协作', 'the fresh branch still names its owning set')
  ok('R19-协同2/3 面板投影：中枢分支列表 + 共享计数 + 所属话题集 + 工作区过滤')
}

// ---- R19 协同①: a parallel group claims distinct branches and never aborts ----
// This drives the REAL runDispatch group loop with a stubbed agent registry. The
// branch wake itself fails in a host-free process (no @deepseek-ai/dsh-llm), so
// every member ends failed — precisely the case that used to abort the loop and
// lose the remaining tasks. The assertions are about allocation and accounting,
// not about a successful turn.
{
  const { runDispatch } = await import('../src/dispatch.ts')
  const cwd = process.cwd()
  const member = (sessionId, title) => ({
    sessionId, kind: 'fork', title, summary: '', status: 'idle', modelOverridden: false, lastActiveAt: Date.now(),
  })
  const store = {
    topicsets: table([['ts-parallel', {
      workspaceKey: cwd, title: '并行协作', summary: '', keywords: ['构建'], status: 'active',
      members: [member('branch-existing', '修构建')],
      createdAt: Date.now(), updatedAt: Date.now(), lastActiveAt: Date.now(),
    }]]),
    dispatches: table(), episodes: table(), outbox: table(), routing: table(),
  }
  const created = []
  const existingAgent = { id: 'branch-existing', followup: () => {}, session: { header: { cwd } } }
  const ctx = {
    agents: {
      get: (id) => (id === 'branch-existing' ? existingAgent : undefined),
      create: async (options) => {
        created.push(options.sessionId)
        return { agent: { id: options.sessionId, followup: () => {}, session: { header: { cwd } } }, dispose: async () => {} }
      },
      resume: async () => { throw new Error('resume not available in the host-free gate') },
      turnBoundaryOf: () => ({ openTurnStartSeq: 0, lastTurn: 1 }),
    },
    sessions: { get: () => ({ seq: 0, append: () => {} }) },
    get: () => undefined,
  }
  const result = await runDispatch(
    { ctx, store, logger },
    { topicSetId: 'ts-parallel', tasks: ['修构建 甲', '修构建 乙', '修构建 丙'] },
    { agent: { id: 'hub-parallel', session: { header: { cwd } } } },
  )
  const branches = (result.branches ?? []).map((row) => row.branchSessionId)
  assert.equal(result.groupId?.startsWith('grp-'), true, 'the group id is minted')
  assert.equal(branches.length, 3, 'every task gets a receipt row (no task is dropped)')
  assert.equal(new Set(branches).size, 3, 'each task owns a DISTINCT branch (no task merge)')
  assert.equal(branches[0], 'branch-existing', 'the first task reuses the matching idle branch')
  assert.equal(created.length, 2, 'the remaining tasks create fresh branches instead of queueing into one')
  assert.equal(store.dispatches.size, 3, 'one dispatch row per task')
  const grouped = [...store.dispatches.entries()].filter(([, row]) => row.groupId === result.groupId)
  assert.equal(grouped.length, 3, 'all three rows share the group id')
  assert.ok(grouped.every(([, row]) => row.groupId === result.groupId))
  assert.equal(grouped.every(([, row]) => row.status === 'failed'), true,
    'a wake failure is recorded per member (the group can still complete and annotate it)')
  assert.equal(result.status, 'error', 'no task was dispatched, so the receipt is an error')
  ok('R19-协同1 并行组：独占分支 + 复用空闲分支 + 失败仍逐任务落账（不中止、不丢任务）')
}

// ---- R19 协同① fix: an INTERRUPTED member is terminal, so the group closes ----
// Before the fix, groupComplete() only accepted delivered/failed: one branch that
// was stopped/timed out stayed "open" forever, and because group members never
// relay individually the hub received NOTHING for the whole group.
{
  const { groupComplete, groupRelayText } = await import('../src/group.ts')
  const { settleInterruptedDispatches } = await import('../src/observe.ts')
  const now3 = Date.now()
  const row = (id, groupId, status, extra = {}) => [id, {
    topicSetId: 'ts-int', groupId, branchSessionId: id, task: '任务-' + id, hubSessionId: 'hub-int',
    startSeq: 0, status, createdAt: now3 - 5000, updatedAt: now3 - 5000, ...extra,
  }]
  const store = {
    dispatches: table([row('d1', 'grp-i', 'delivered', { turnEndReason: 'completed' }), row('d2', 'grp-i', 'dispatched')]),
    outbox: table(), episodes: table(),
  }
  assert.equal(groupComplete(store, 'grp-i'), false, 'an open member keeps the group open')
  store.dispatches.update('d2', (r) => ({ ...r, status: 'interrupted', turnEndReason: 'silent' }))
  assert.equal(groupComplete(store, 'grp-i'), true, 'interrupted is a terminal member state (R19 fix)')
  const relayText = groupRelayText(store, 'grp-i', new Map())
  assert.match(relayText, /中断终态/, 'the relay labels an interruption as such')
  assert.match(relayText, /1 成功 \/ 0 失败 \/ 1 中断/, 'the summary counts interruptions separately')

  // End-to-end: the interrupt sweep must both mark the member and enqueue the
  // ONE group relay immediately (the message send itself may fail host-free; the
  // outbox payload is the durable proof the relay was assembled and queued).
  const store2 = {
    dispatches: table([row('d1', 'grp-i', 'delivered', { turnEndReason: 'completed' }), row('d2', 'grp-i', 'dispatched')]),
    outbox: table(), episodes: table(),
  }
  const deps = {
    ctx: { agents: { get: () => ({ followup: () => {} }) } },
    store: store2,
    config: { enabled: true, maxTokensPolicy: 'deliver-partial', interruptAfterMs: 1000 },
    logger,
  }
  const settled = await settleInterruptedDispatches(deps, { timeoutMs: 1000, now: now3 })
  assert.deepEqual(settled, ['d2'], 'only the open member is interrupted')
  assert.equal(store2.dispatches.get('d2').status, 'interrupted')
  const groupRow = [...store2.outbox.entries()].find(([, item]) => item.groupId === 'grp-i')
  assert.ok(groupRow, 'the group relay is enqueued right after the interrupt sweep')
  assert.match(groupRow[1].payload, /\[supermemory-group-relay grp-i\]/)
  assert.match(groupRow[1].payload, /中断终态/, 'the queued group relay carries the interruption annotation')
  ok('R19-协同1b 中断成员：interrupted 纳入组终态，整组汇总立即收敛且中断单独标注')
}


// ---- R21: the relay must deliver the branch's WHOLE answer ----
// Regression (2026-11-18): the relay body used to be built from the episode's
// 400-char `summary`, so the hub silently lost most of every branch result.
{
  const { episodeResult, clipRelayResult, RELAY_RESULT_MAX_CHARS } = await import('../src/relay-text.ts')
  const { groupEpisodeSummaries, groupRelayText } = await import('../src/group.ts')

  // the full answer wins; the short summary is a fallback, never the source
  assert.equal(episodeResult({ result: '完整答案', summary: '短梗概' }), '完整答案')
  assert.equal(episodeResult({ result: '', summary: '旧记录的短梗概' }), '旧记录的短梗概', 'episodes written before result fall back to summary')
  assert.equal(episodeResult(undefined), '')
  ok('R21-1 episodeResult：relay 取完整 result，旧记录回退 summary')

  // a normal-length answer passes through untouched: the 400-char clip is gone
  const long = '重'.repeat(5000)
  assert.equal(clipRelayResult(long, 'br-1'), long, 'a 5000-char answer is delivered whole')
  assert.equal(clipRelayResult('短', 'br-1'), '短')
  // only a runaway turn is clipped, and the marker says so instead of cutting silently
  const clipped = clipRelayResult('x'.repeat(RELAY_RESULT_MAX_CHARS + 10), 'br-9')
  assert.ok(clipped.includes('已截断') && clipped.includes('br-9'), 'an oversized answer is clipped with an explicit marker')
  ok('R21-2 clipRelayResult：正常长度原样送达，超长才截断且明确标注')

  // the group relay carries the full result of every delivered member
  const stamp = Date.now()
  const store = fakeStore({
    dispatches: [
      ['d-r', { topicSetId: 'ts-r', branchSessionId: 'br-r', task: '修复 relay 截断', hubSessionId: 'hub-1', startSeq: 0, status: 'delivered', groupId: 'grp-r', createdAt: stamp, updatedAt: stamp }],
    ],
    episodes: [
      ['epi-r', { topicSetId: 'ts-r', branchSessionId: 'br-r', timeStart: stamp, timeEnd: stamp, summary: '只有前 400 字的梗概', result: '分支的完整最终答案：' + '细节'.repeat(300), decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'br-r', sourceSeqStart: 0, sourceSeqEnd: 1 }],
    ],
  })
  const results = groupEpisodeSummaries(store, 'grp-r')
  assert.equal(results.get('br-r'), store.episodes.get('epi-r').result, 'the group relay reads the full result, not the 400-char summary')
  assert.ok(results.get('br-r').length > 400, 'a long answer survives the group path')
  const relay = groupRelayText(store, 'grp-r', results)
  assert.ok(relay.includes('分支的完整最终答案'), 'the group relay text carries the full answer')
  assert.ok(!relay.includes('只有前 400 字的梗概'), 'the short summary is not what the hub receives')
  ok('R21-3 组 relay：送达完整 result 而非 400 字梗概')
}

// ---- R22 能力（capability）：流程固化为受管能力，可一键执行 ----
// 序列组合工具回答"按什么顺序调哪些工具"；能力回答"这件事现在怎么做"——
// 入口命令 + 文档 + 适用范围 + 路由描述，落库后可被模型与管理台一键执行
// （默认预演，写操作二次确认）。
{
  assert.equal(isValidCapabilityName('git-sync-supermemory'), true)
  assert.equal(isValidCapabilityName('bad name'), false)
  assert.equal(isValidCapabilityName(''), false)
  assert.equal(isValidCapabilityName('-lead'), false)
  assert.equal(capabilityToolName('git-sync-supermemory'), 'sm_composite_git_sync_supermemory')
  const built = buildCapabilitySpec({
    name: 'git-sync-supermemory',
    title: 'git 同步/提交/推送（SuperMemory 仓库）',
    description: '本仓库 git 同步/提交/推送的固化流程：先判断工作区，再走入口命令。',
    entry: 'pnpm git:sync',
    doc: 'docs/git-sync.md',
    scope: 'G:\\09 - dsh\\SuperMemory',
    runnable: true,
    dryRunArg: '--dry-run',
    writeConfirm: true,
    tags: ['git', '同步', '推送', '流程固化'],
  })
  assert.equal(built.status, 'ok')
  assert.equal(built.spec.kind, 'capability')
  assert.equal(built.spec.name, 'sm_composite_git_sync_supermemory')
  assert.equal(built.spec.entry, 'pnpm git:sync')
  assert.equal(built.spec.doc, 'docs/git-sync.md')
  assert.equal(built.spec.scope, 'G:\\09 - dsh\\SuperMemory')
  assert.equal(built.spec.runnable, true)
  assert.equal(built.spec.dryRunArg, '--dry-run')
  assert.equal(built.spec.writeConfirm, true)
  assert.deepEqual(built.spec.tags, ['git', '同步', '推送', '流程固化'])
  assert.deepEqual(built.spec.steps, [], 'a capability carries no steps')
  assert.equal(buildCapabilitySpec({ name: 'x', description: 'd', entry: '' }).status, 'error', 'entry is required')
  assert.equal(buildCapabilitySpec({ name: 'x', description: '', entry: 'pnpm git:sync' }).status, 'error', 'description is required')
  assert.equal(buildCapabilitySpec({ name: 'bad name', description: 'd', entry: 'e' }).status, 'error', 'the name must be a legal slug')
  assert.equal(buildCapabilitySpec({ name: 'x', description: 'd', entry: 'e' }).spec.runnable, true, 'runnable defaults to true')
  ok('K1 能力数据模型：命名规则/字段默认值/缺 entry 缺描述非法名均拒绝')
}

{
  const spec = {
    name: 'sm_composite_cap_echo', kind: 'capability', description: 'd',
    entry: 'echo capability-dry-run-marker', steps: [], parameters: [],
    runnable: true, dryRunArg: '--dry-run',
  }
  const r = runCapability(spec, {})
  assert.equal(r.status, 'completed', 'echo must succeed: ' + r.summary)
  assert.equal(r.exitCode, 0)
  assert.equal(r.dryRun, true, 'a defined dryRunArg makes dry-run the default')
  assert.ok(r.stdout.includes('capability-dry-run-marker'), 'stdout is captured')
  assert.equal(r.command, 'echo capability-dry-run-marker --dry-run')
  assert.ok(r.durationMs >= 0)
  ok('K2 能力执行（dry-run 默认）：捕获 stdout/退出码/耗时，命令自动附加预演参数')
}

{
  // 写操作闸门：无 confirm 拒绝执行且不跑命令；confirm=true 才真跑。
  const writeSpec = {
    name: 'sm_composite_gate_test', kind: 'capability', description: 'd',
    entry: 'echo gate-should-not-run', steps: [], parameters: [],
    runnable: true, writeConfirm: true,
  }
  const blocked = runCapability(writeSpec, {})
  assert.equal(blocked.status, 'needs-confirm', 'a write capability without confirm must be refused')
  assert.equal(blocked.stdout, '', 'nothing may be executed')
  assert.equal(blocked.dryRun, false)
  const allowed = runCapability(writeSpec, { confirm: true })
  assert.equal(allowed.status, 'completed')
  assert.ok(allowed.stdout.includes('gate-should-not-run'), 'confirm=true really runs it')
  assert.equal(allowed.dryRun, false)
  // 预演缺省：定义了 dryRunArg 时默认预演，无需 confirm。
  const dry = runCapability({ ...writeSpec, dryRunArg: '--dry-run' }, {})
  assert.equal(dry.status, 'completed')
  assert.equal(dry.dryRun, true)
  assert.ok(dry.command.includes('--dry-run'), 'the dry-run arg is appended')
  // 写操作能力没有预演参数时，预演必须拒绝——不能把真实命令当预演跑掉。
  const noDry = runCapability(writeSpec, { dryRun: true })
  assert.equal(noDry.status, 'failed')
  assert.ok(noDry.summary.includes('无法预演'))
  assert.equal(noDry.stdout, '', 'still nothing executed')
  // runnable=false 直接拒绝；非能力定义拒绝。
  const off = runCapability({ ...writeSpec, runnable: false }, { confirm: true })
  assert.equal(off.status, 'failed')
  assert.ok(off.summary.includes('未开放执行'))
  assert.equal(runCapability({ name: 'x', description: 'd', steps: [], parameters: [] }).status, 'failed')
  ok('K3 执行安全闸：写操作需 confirm、默认预演、无预演参数拒绝预演、未开放执行拒绝')
}

{
  // 注册 → 持久化 → 重启重建拾取 → 同名更新（不重复建行）→ 宿主冲突拒绝。
  const registered = []
  const store = fakeStore()
  const ctx = { tools: { register: () => () => {}, get: () => undefined } }
  const deps = {
    register: async (c, s, spec) => { registered.push(spec.name); return () => {} },
    persist: persistComposite,
    toolExists: () => false,
  }
  const seed = {
    name: 'git-sync-supermemory',
    title: 'git 同步/提交/推送（SuperMemory 仓库）',
    description: '本仓库 git 同步/提交/推送的固化流程。',
    entry: 'pnpm git:sync',
    doc: 'docs/git-sync.md',
    scope: 'G:\\09 - dsh\\SuperMemory',
    runnable: true,
    dryRunArg: '--dry-run',
    writeConfirm: true,
    tags: ['git', '同步'],
  }
  const first = await registerCapability(ctx, store, seed, 'ws-cap', deps)
  assert.equal(first.status, 'ok', 'register must succeed: ' + first.message)
  assert.equal(first.name, 'sm_composite_git_sync_supermemory')
  assert.equal(store.toolMemory.size, 1, 'the capability must be persisted')
  const [, row] = [...store.toolMemory.entries()][0]
  assert.equal(row.kind, 'composite', 'the row stays kind=composite (domain schema unchanged)')
  assert.equal(row.workspaceKey, 'ws-cap', 'the capability is scoped to its workspace')
  const spec = JSON.parse(row.entry)
  assert.equal(spec.kind, 'capability')
  assert.equal(spec.entry, 'pnpm git:sync')
  assert.equal(spec.writeConfirm, true)
  assert.deepEqual(registered, ['sm_composite_git_sync_supermemory'], 'the live tool is registered once')
  // 重启：rebuildComposites 必须拾取能力记录。
  const rebuilt = []
  const count = await rebuildComposites(ctx, store, { register: async (c, s, sp) => { rebuilt.push(sp); return () => {} } })
  assert.equal(count, 1)
  assert.equal(rebuilt[0].kind, 'capability', 'rebuild picks up the capability')
  assert.equal(rebuilt[0].name, 'sm_composite_git_sync_supermemory')
  // 重注册同名能力 = 原地更新。
  const again = await registerCapability(ctx, store, { ...seed, description: '更新后的路由描述' }, 'ws-cap', deps)
  assert.equal(again.status, 'ok')
  assert.equal(store.toolMemory.size, 1, 're-registering the same name updates in place')
  assert.equal(JSON.parse([...store.toolMemory.entries()][0][1].entry).description, '更新后的路由描述')
  // 与宿主既有工具冲突 → 拒绝（且不落库）。用默认 deps，让冲突检查走
  // ctx.tools.get 这条真实路径（注入缝的 toolExists 恒 false，测不到冲突）。
  const clashCtx = { tools: { register: () => () => {}, get: (n) => (n === 'sm_composite_other_cap' ? {} : undefined) } }
  const clash = await registerCapability(clashCtx, store, { ...seed, name: 'other-cap' }, 'ws-cap')
  assert.equal(clash.status, 'error')
  assert.ok(clash.message.includes('已被占用'))
  assert.equal(store.toolMemory.size, 1, 'a refused register persists nothing')
  // capabilityRecordsOf 列出能力（供 memory_toolize list / 控制台）。
  const caps = capabilityRecordsOf(store)
  assert.equal(caps.length, 1)
  assert.equal(caps[0].spec.entry, 'pnpm git:sync')
  assert.equal(caps[0].useCount, 0)
  ok('K4 能力注册→持久化→重启重建拾取→同名原地更新→宿主冲突拒绝→列表')
}

{
  // 面板 runTool：能力可跑且计数、needs-confirm 不计数、序列工具拒绝一键执行。
  const capSpec = {
    name: 'sm_composite_panel_cap', kind: 'capability', description: '面板执行冒烟', title: '面板能力',
    entry: 'echo panel-capability-ok', steps: [], parameters: [], runnable: true, dryRunArg: '--dry-run',
  }
  const store = fakeStore({ toolMemory: [['tm-cap', {
    kind: 'composite', workspaceKey: 'ws', title: '面板能力', tags: ['git'], trigger: 'capability/x',
    description: '面板执行冒烟', entry: JSON.stringify(capSpec), useCount: 0, status: 'active',
  }]] })
  const service = new SupermemoryPanelService(store, serviceCtx())
  const views = service.listTools()
  assert.equal(views[0].kind, 'capability', 'listTools exposes the capability kind')
  assert.equal(views[0].entry, 'echo panel-capability-ok')
  assert.equal(views[0].dryRunArg, '--dry-run')
  const r = await service.runTool('tm-cap')
  assert.equal(r.status, 'completed')
  assert.ok(r.stdout.includes('panel-capability-ok'))
  assert.equal(r.dryRun, true)
  assert.equal(store.toolMemory.get('tm-cap').useCount, 1, 'a real run bumps the durable counter')
  const wstore = fakeStore({ toolMemory: [['tm-w', {
    kind: 'composite', title: '写能力', tags: [], trigger: '', description: 'd',
    entry: JSON.stringify({ ...capSpec, name: 'sm_composite_panel_w', writeConfirm: true }), useCount: 0, status: 'active',
  }]] })
  const wservice = new SupermemoryPanelService(wstore, serviceCtx())
  // 预演缺省仍在（dryRunArg 已定义）：直接调用是预演，不计确认流程。
  const dryFirst = await wservice.runTool('tm-w')
  assert.equal(dryFirst.status, 'completed')
  assert.equal(dryFirst.dryRun, true)
  assert.equal(wstore.toolMemory.get('tm-w').useCount, 1)
  // 显式要求实跑（dryRun:false）但没有 confirm → needs-confirm，不执行。
  const blocked = await wservice.runTool('tm-w', { dryRun: false })
  assert.equal(blocked.status, 'needs-confirm')
  assert.equal(wstore.toolMemory.get('tm-w').useCount, 1, 'needs-confirm does not count as use')
  // confirm=true = 确认真实执行（自动脱离预演缺省）。
  const ran = await wservice.runTool('tm-w', { confirm: true })
  assert.equal(ran.status, 'completed')
  assert.equal(ran.dryRun, false, 'confirm=true really runs')
  assert.equal(wstore.toolMemory.get('tm-w').useCount, 2)
  const sstore = fakeStore({ toolMemory: [['tm-s', {
    kind: 'composite', title: '序列', tags: [], trigger: '', description: 'd',
    entry: JSON.stringify({ name: 'sm_composite_s', steps: [{ tool: 'read', arguments: {} }], parameters: [] }), useCount: 0, status: 'active',
  }]] })
  const seqResult = await new SupermemoryPanelService(sstore, serviceCtx()).runTool('tm-s')
  assert.equal(seqResult.status, 'failed', 'a sequence composite is not one-click runnable')
  ok('K5 面板执行：能力可跑且计数、needs-confirm 不计数、序列工具拒绝一键执行')
}

// ---- requirement E: interrupted dispatch preservation + resume ----
// 插件被中断/关闭时分支会话保留（不 kill/abort/delete），恢复后扫描台账列出
// 被中断任务，由用户决定续跑：优先续接被保留的分支会话，失败才带上下文重派发。
const { listInterruptedDispatches, renderInterruptedList, resumeDispatch, isCutOffDispatch } = await import('../src/resume.ts')
const { detachIdleBranches, releasableBranches, branchHandles } = await import('../src/dispatch.ts')

{
  // R1: dispose/清理路径不删除分支会话——空闲释放只摘除插件侧 handle，
  // 不调用宿主 dispose（停 loop/关闭写句柄/注销 agent），会话与台账原样保留。
  const store = fakeStore({
    topicsets: [['ts-r1', {
      workspaceKey: 'ws', title: 'TS-R1', summary: '', keywords: [], status: 'active',
      members: [{ sessionId: 'branch-r1', kind: 'root', title: '分支一', summary: '', status: 'idle', lastActiveAt: now - 7200000 }],
      createdAt: now, updatedAt: now, lastActiveAt: now,
    }]],
    dispatches: [['dsp-r1', { topicSetId: 'ts-r1', branchSessionId: 'branch-r1', task: '任务一', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: now, updatedAt: now }]],
  })
  let disposeCalls = 0
  branchHandles.set('branch-r1', { agent: { id: 'branch-r1' }, dispose: async () => { disposeCalls += 1 } })
  const detached = detachIdleBranches(store, now, 1800000, logger)
  assert.deepEqual(detached, ['branch-r1'], 'an idle branch handle is released')
  assert.equal(disposeCalls, 0, 'idle release must NOT call the host dispose (branch session preserved)')
  assert.equal(branchHandles.has('branch-r1'), false, 'the plugin-side handle is gone')
  assert.equal(store.dispatches.get('dsp-r1').status, 'interrupted', 'the ledger row is untouched')
  assert.deepEqual(releasableBranches(store, now, 1800000), [], 'a detached handle is not releasable twice')
  ok('R1 保留分支会话：空闲释放只摘除 handle，绝不调用宿主 dispose')
}

{
  // R2: 重启扫描列出被中断且未终态完成的派发（含已完成部分），
  // 排除已交付 / 自主失败 / 在途 / 已被续跑接续的行；工作区过滤生效。
  const stale = now - 3600000
  const store = fakeStore({
    topicsets: [['ts-r2', {
      workspaceKey: 'ws', title: '话题甲', summary: '', keywords: [], status: 'active',
      members: [{ sessionId: 'b-a', kind: 'root', title: '分支甲', summary: '', status: 'idle', lastActiveAt: stale }],
      createdAt: stale, updatedAt: stale, lastActiveAt: stale,
    }]],
    dispatches: [
      ['dsp-r2a', { topicSetId: 'ts-r2', branchSessionId: 'b-a', task: '任务甲', hubSessionId: 'hub-1', startSeq: 0, status: 'interrupted', createdAt: stale, updatedAt: stale }],
      ['dsp-r2b', { topicSetId: 'ts-r2', branchSessionId: 'b-b', task: '任务乙', hubSessionId: 'hub-1', startSeq: 0, status: 'failed', turnEndReason: 'aborted', createdAt: stale, updatedAt: stale }],
      ['dsp-r2c', { topicSetId: 'ts-r2', branchSessionId: 'b-c', task: '任务丙', hubSessionId: 'hub-1', startSeq: 0, status: 'delivered', createdAt: stale, updatedAt: stale }],
      ['dsp-r2d', { topicSetId: 'ts-r2', branchSessionId: 'b-d', task: '任务丁', hubSessionId: 'hub-1', startSeq: 0, status: 'dispatched', lastActivityAt: now - 1000, createdAt: stale, updatedAt: stale }],
      ['dsp-r2e', { topicSetId: 'ts-r2', branchSessionId: 'b-e', task: '任务戊', hubSessionId: 'hub-1', startSeq: 0, status: 'interrupted', createdAt: stale, updatedAt: stale, resumedBy: 'dsp-r2f' }],
      ['dsp-r2f', { topicSetId: 'ts-r2', branchSessionId: 'b-e', task: '任务戊', hubSessionId: 'hub-1', startSeq: 0, status: 'dispatched', resumeOf: 'dsp-r2e', createdAt: stale, updatedAt: now - 1000 }],
      ['dsp-r2g', { topicSetId: 'ts-r2', branchSessionId: 'b-g', task: '任务己', hubSessionId: 'hub-1', startSeq: 0, status: 'failed', turnEndReason: 'max-tokens', createdAt: stale, updatedAt: stale }],
    ],
    outbox: [['dlv-dsp-r2a', {
      kind: 'single', dispatchId: 'dsp-r2a', status: 'relayed', enqueuedAt: stale,
      payload: '[supermemory-relay b-a]\n任务：任务甲\n结果：分支中断（插件重载/卸载导致分支中断）。\n已完成部分：做完了前半段\n以上为失败事实，未伪装成答案。',
    }]],
  })
  const views = listInterruptedDispatches(store, { now })
  assert.deepEqual(views.map((v) => v.dispatchId), ['dsp-r2a', 'dsp-r2b'],
    'interrupted + cut-off failed are listed; delivered / live / resumed-chain / honest-failure are not')
  assert.equal(views[0].partial, '做完了前半段', 'the partial summary is surfaced from the interrupt relay')
  assert.equal(views[0].topicSetTitle, '话题甲')
  assert.equal(views[0].branchTitle, '分支甲')
  assert.equal(isCutOffDispatch({ status: 'failed', turnEndReason: 'branch-died' }), true)
  assert.equal(isCutOffDispatch({ status: 'failed', turnEndReason: 'max-tokens' }), false)
  assert.deepEqual(listInterruptedDispatches(store, { now, workspaceKey: 'other-ws' }), [], 'workspace scope filters foreign sets')
  const text = renderInterruptedList(views, now)
  assert.ok(text.includes('dsp-r2a') && text.includes('memory_resume') && text.includes('1 小时前'), 'the rendered list names the id, the resume entry and the age')
  ok('R2 重启扫描：列出被中断且未终态完成的派发（含已完成部分，排除已续跑/已交付/在途/自主失败）')
}

{
  // R3: 续跑优先续接被保留的分支会话（live agent 直投，不 resume），
  // 台账双向关联 resumeOf/resumedBy，relay 目标为调用方 hub。
  const store = fakeStore({
    topicsets: [['ts-r3', {
      workspaceKey: 'ws', title: '话题甲', summary: '', keywords: [], status: 'active',
      members: [{ sessionId: 'branch-r3', kind: 'root', title: '分支甲', summary: '', status: 'idle', lastActiveAt: now }],
      createdAt: now, updatedAt: now, lastActiveAt: now,
    }]],
    dispatches: [['dsp-r3', { topicSetId: 'ts-r3', branchSessionId: 'branch-r3', task: '任务甲', hubSessionId: 'hub-1', startSeq: 5, status: 'interrupted', createdAt: now, updatedAt: now }]],
  })
  const follows = []
  const agent = { id: 'branch-r3', followup: (message) => { follows.push(message) } }
  const ctx = {
    agents: {
      get: (id) => (id === 'branch-r3' ? agent : undefined),
      resume: async () => { throw new Error('a live agent must not be resumed again') },
    },
    sessions: { get: () => ({ seq: 42 }) },
  }
  const r = await resumeDispatch({ ctx, store, logger }, 'dsp-r3', {
    exec: { agent: { id: 'hub-1', session: { header: { cwd: 'G:/ws' } } } },
    createMessage: (input) => input,
  })
  assert.equal(r.status, 'resumed')
  assert.equal(r.mode, 'continued', 'a live preserved branch is continued, not resumed')
  assert.equal(r.branchSessionId, 'branch-r3')
  assert.ok(r.newDispatchId)
  assert.equal(follows.length, 1)
  const row = store.dispatches.get(r.newDispatchId)
  assert.equal(row.resumeOf, 'dsp-r3', 'the continuation links back to the interrupted dispatch')
  assert.equal(row.status, 'dispatched')
  assert.equal(row.hubSessionId, 'hub-1', 'the relay goes to the calling hub')
  assert.equal(row.startSeq, 42)
  assert.equal(store.dispatches.get('dsp-r3').resumedBy, r.newDispatchId, 'the original links forward')
  const message = follows[0].content[0].text
  assert.ok(message.includes('[supermemory-resume dsp-r3]'))
  assert.ok(message.includes('原始任务：任务甲') && message.includes('已完成部分'), 'the wake message carries task + partial')
  assert.equal(follows[0].source.form, 'instructions', 'the resume input is dispatch-owned (not recall/notice)')
  ok('R3 续跑：优先续接被保留的分支会话（live 直投），台账双向关联')
}

{
  // R4: 分支 agent 已不在注册表（重启/重载杀死）时，经 agents.resume 重连持久
  // 会话后续投；句柄重新登记到 branchHandles。
  const store = fakeStore({
    topicsets: [['ts-r4', {
      workspaceKey: 'ws', title: '话题甲', summary: '', keywords: [], status: 'active',
      members: [{ sessionId: 'branch-r4', kind: 'root', title: '分支甲', summary: '', status: 'idle', lastActiveAt: now }],
      createdAt: now, updatedAt: now, lastActiveAt: now,
    }]],
    dispatches: [['dsp-r4', { topicSetId: 'ts-r4', branchSessionId: 'branch-r4', task: '任务甲', hubSessionId: 'hub-1', startSeq: 5, status: 'interrupted', createdAt: now, updatedAt: now }]],
  })
  const follows = []
  const agent = { id: 'branch-r4', followup: (message) => { follows.push(message) } }
  let resumeCalls = 0
  const ctx = {
    agents: {
      get: () => undefined,
      resume: async (options) => {
        resumeCalls += 1
        assert.equal(options.resumeSessionId, 'branch-r4', 'the preserved session id is resumed')
        return { agent, dispose: async () => {} }
      },
    },
    sessions: { get: () => ({ seq: 7 }) },
  }
  const r = await resumeDispatch({ ctx, store, logger }, 'dsp-r4', {
    exec: { agent: { id: 'hub-1', session: { header: { cwd: 'G:/ws' } } } },
    createMessage: (input) => input,
  })
  assert.equal(r.status, 'resumed')
  assert.equal(r.mode, 'continued')
  assert.equal(resumeCalls, 1, 'a dead-but-persisted branch is reconnected through agents.resume')
  assert.equal(follows.length, 1)
  assert.equal(branchHandles.has('branch-r4'), true, 'the reconnected handle is registered again')
  branchHandles.delete('branch-r4')
  ok('R4 续跑：分支已死但会话保留 → agents.resume 重连后续投')
}

{
  // R5: 会话彻底无法恢复时，带「原始任务 + 已完成部分」上下文重派发到新分支，
  // 台账关联原 dispatchId；重派发失败如实报错。
  const store = fakeStore({
    dispatches: [['dsp-r5', { topicSetId: 'ts-r5', branchSessionId: 'b-r5', task: '任务戊', hubSessionId: 'hub-1', startSeq: 5, status: 'interrupted', createdAt: now, updatedAt: now }]],
  })
  const ctx = {
    agents: { get: () => undefined, resume: async () => { throw new Error('session log gone') } },
    sessions: { get: () => ({ seq: 0 }) },
  }
  let seen = null
  const r = await resumeDispatch({ ctx, store, logger }, 'dsp-r5', {
    exec: { agent: { id: 'hub-1', session: { header: { cwd: 'G:/ws' } } } },
    redispatch: async (task) => { seen = task; return { status: 'dispatched', dispatchId: 'dsp-r5-new', branchSessionId: 'branch-r5-new' } },
  })
  assert.equal(r.status, 'resumed')
  assert.equal(r.mode, 'redispatched')
  assert.equal(r.newDispatchId, 'dsp-r5-new')
  assert.equal(r.branchSessionId, 'branch-r5-new')
  assert.ok(seen.includes('任务戊') && seen.includes('【续跑上下文】') && seen.includes('dsp-r5'),
    'the re-dispatch carries the original task + continuation context')
  assert.equal(store.dispatches.get('dsp-r5').resumedBy, 'dsp-r5-new', 'the original links to the re-dispatch')
  const failed = await resumeDispatch({ ctx, store, logger }, 'dsp-r5', {
    redispatch: async () => ({ status: 'error', message: '分支获取失败' }),
  })
  assert.equal(failed.status, 'error', 'a failed re-dispatch is reported, never disguised')
  ok('R5 续跑：会话无法恢复 → 带上下文重派发新分支并关联原 dispatchId；失败如实报错')
}

{
  // R6: 守卫——已交付 / 仍在进行中 / 不存在 / 已有续跑在进行 都不续跑。
  const store = fakeStore({
    dispatches: [
      ['dsp-r6a', { topicSetId: 'ts', branchSessionId: 'b1', task: '甲', hubSessionId: 'hub', startSeq: 0, status: 'delivered', createdAt: now, updatedAt: now }],
      ['dsp-r6b', { topicSetId: 'ts', branchSessionId: 'b2', task: '乙', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', createdAt: now, updatedAt: now }],
      ['dsp-r6c', { topicSetId: 'ts', branchSessionId: 'b3', task: '丙', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: now, updatedAt: now, resumedBy: 'dsp-r6d' }],
      ['dsp-r6d', { topicSetId: 'ts', branchSessionId: 'b3', task: '丙', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', resumeOf: 'dsp-r6c', createdAt: now, updatedAt: now }],
    ],
  })
  const ctx = { agents: { get: () => undefined, resume: async () => { throw new Error('must not resume') } }, sessions: { get: () => ({ seq: 0 }) } }
  const deps = { ctx, store, logger }
  assert.ok((await resumeDispatch(deps, 'dsp-r6a')).message.includes('已交付'))
  assert.ok((await resumeDispatch(deps, 'dsp-r6b')).message.includes('仍在进行中'))
  assert.ok((await resumeDispatch(deps, 'nope')).message.includes('不存在'))
  assert.ok((await resumeDispatch(deps, 'dsp-r6c')).message.includes('已有续跑在进行'))
  ok('R6 守卫：已交付/在途/不存在/已有续跑 均拒绝续跑')
}


// ---- R24: a receipt ends the hub's turn (dispatch / resume never block) ----
{
  const { DISPATCH_NEXT_ACTION, RESUME_NEXT_ACTION } = await import('../src/round-end.ts')
  assert.ok(DISPATCH_NEXT_ACTION.includes('立即结束本轮回复'), 'the dispatch receipt tells the hub to end its turn')
  assert.ok(DISPATCH_NEXT_ACTION.includes('relay'), 'the receipt names the relay that opens the next turn')
  assert.ok(RESUME_NEXT_ACTION.includes('立即结束本轮回复'), 'the resume receipt repeats the rule')
  assert.notEqual(DISPATCH_NEXT_ACTION, RESUME_NEXT_ACTION, 'dispatch and resume keep their own wording (已派发 / 已续跑)')
  ok('R24-1 收口文案：派发/续跑回执都要求立即结束本轮，并说明 relay 会在新一轮送达')
}

{
  // Drive the REAL single-dispatch receipt with a stubbed host message factory
  // (a host-free gate has no @deepseek-ai/dsh-llm) and assert the field travels.
  const { runDispatch } = await import('../src/dispatch.ts')
  const { DISPATCH_NEXT_ACTION } = await import('../src/round-end.ts')
  const cwd = process.cwd()
  const store = {
    topicsets: table([['ts-r23', {
      workspaceKey: cwd, title: '收口验证', summary: '', keywords: [], status: 'active', members: [],
      createdAt: now, updatedAt: now, lastActiveAt: now,
    }]]),
    dispatches: table(), episodes: table(), outbox: table(), routing: table(),
  }
  const ctx = {
    agents: {
      get: () => undefined,
      create: async (options) => ({
        agent: { id: options.sessionId, followup: () => {}, session: { header: { cwd } } },
        dispose: async () => {},
      }),
      resume: async () => { throw new Error('resume not available in the host-free gate') },
      turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }),
    },
    sessions: { get: () => ({ seq: 0 }) },
    get: () => undefined,
  }
  const result = await runDispatch(
    { ctx, store, logger, createMessage: () => ({ content: [], source: {} }) },
    { topicSetId: 'ts-r23', task: '派发收口回执验证任务' },
    { agent: { id: 'hub-r23', session: { header: { cwd } } } },
  )
  assert.equal(result.status, 'dispatched', 'a stubbed factory completes the wake')
  assert.equal(result.nextAction, DISPATCH_NEXT_ACTION, 'the success receipt carries nextAction (single dispatch)')
  assert.equal(store.dispatches.size, 1, 'the dispatch is still recorded exactly once')
  ok('R24-2 单条派发回执带 nextAction（与 round-end.ts 同源，唤醒成功路径实测）')
}

{
  // The hub prompt / tool / routing copy must carry the same rule. index.ts is
  // not importable in a host-free process (parameter properties in its import
  // graph), so the prompt contract is asserted at the source level.
  const { readFileSync } = await import('node:fs')
  const index = readFileSync('src/index.ts', 'utf8')
  const route = readFileSync('src/route.ts', 'utf8')
  const tools = readFileSync('src/tools.ts', 'utf8')
  assert.ok(index.includes('立即结束本轮回复'), 'hub role text: end the turn right after the receipt')
  assert.ok(index.includes('subagent 树') && index.includes('wait_agent'), 'hub role text: branches are not subagent-tree members')
  assert.ok(index.includes('派发后即结束本轮回复'), 'the memory prompt block repeats the rule')
  assert.ok(route.includes('立即结束本轮回复'), 'the routing card repeats the rule')
  assert.ok(tools.includes('R24 收口') && tools.includes('wait_agent'), 'both tool descriptions repeat the rule')
  assert.ok(tools.includes('RESUME_NEXT_ACTION'), 'memory_resume receipt is wired to the shared constant')
  ok('R24-3 中枢/记忆提示/路由卡/两个工具描述与回执同源（文案不再只靠软提示）')
}


// ---- R23: dispatch-side topic-set matching (three tiers + verify set) ----
{
  const { runDispatch } = await import('../src/dispatch.ts')
  const { matchTopicSetForTask, renderTopicSetConfirm, verifyTopicSetTitle } = await import('../src/topicset-match.ts')
  const { workspaceKeyOf } = await import('../src/store.ts')
  const { clipEllipsis, firstLine, cleanTitleText } = await import('../src/title.ts')
  const cwd = process.cwd()
  const ws = workspaceKeyOf(cwd)
  const tsRow = (over = {}) => ({
    workspaceKey: ws, title: '集合', summary: '', keywords: [], status: 'active', members: [],
    createdAt: now, updatedAt: now, lastActiveAt: now, ...over,
  })
  const stubCtx = () => {
    const created = []
    return {
      created,
      ctx: {
        agents: {
          get: () => undefined,
          create: async (options) => {
            created.push(options.sessionId)
            return { agent: { id: options.sessionId, followup: () => {}, session: { header: { cwd } } }, dispose: async () => {} }
          },
          resume: async () => { throw new Error('resume not available in the host-free gate') },
          turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }),
        },
        sessions: { get: () => ({ seq: 0, append: () => {} }) },
        get: () => undefined,
      },
    }
  }
  const deps = (ctx, store) => ({ ctx, store, logger, createMessage: () => ({ content: [], source: {} }) })
  const hubExec = (id) => ({ agent: { id, session: { header: { cwd } } } })

  // M0: the pure matcher — tier band, candidate list, and the active bonus
  // never reaching the high tier on its own.
  {
    const store = fakeStore({ topicsets: [['ts-export', tsRow({ title: '导出功能', keywords: ['export'] })]] })
    const medium = matchTopicSetForTask(store, { task: '导出 markdown 文档', workspaceKey: ws, now })
    assert.equal(medium.tier, 'medium')
    assert.equal(medium.candidates[0].id, 'ts-export')
    assert.ok(renderTopicSetConfirm(medium).includes('ts-export'))
    const zero = matchTopicSetForTask(store, { task: '完全无关的重构任务', workspaceKey: ws, activeTopicSetId: 'ts-export', now })
    assert.notEqual(zero.tier, 'high', 'bonuses alone must never reach the high tier')
    ok('M0 匹配器纯函数：中等分档 + 候选列表 + 活跃加分不越级')
  }

  // M1: high similarity reuses the set — no new set, receipt/routing/dispatch
  // row all point at the reused set.
  {
    const store = fakeStore({ topicsets: [['ts-git', tsRow({ title: '同步并提交 SuperMemory 仓库的 Git', keywords: ['supermemory', 'git'] })]] })
    const { ctx } = stubCtx()
    const r = await runDispatch(deps(ctx, store), { task: '同步并提交 SuperMemory 仓库的 git 改动并推送' }, hubExec('hub-m1'))
    assert.equal(store.topicsets.size, 1, 'high similarity must not create a new set')
    assert.equal(r.status, 'dispatched')
    assert.equal(r.topicSetId, 'ts-git', 'the receipt names the reused set')
    assert.equal(store.routing.get('hub-m1').activeTopicSetId, 'ts-git')
    assert.equal([...store.dispatches.entries()][0][1].topicSetId, 'ts-git')
    assert.ok(r.message.includes('复用') && r.message.includes('同步并提交'), 'the receipt says which set was reused')
    ok('M1 高相似：复用已有话题集（不新建，回执/routing/派发行都指向被复用集）')
  }

  // M2: medium similarity → need-confirm; nothing created, nothing dispatched.
  {
    const store = fakeStore({ topicsets: [['ts-export', tsRow({ title: '导出功能', keywords: ['export'] })]] })
    const { ctx } = stubCtx()
    const r = await runDispatch(deps(ctx, store), { task: '导出 markdown 文档' }, hubExec('hub-m2'))
    assert.equal(r.status, 'need-confirm')
    assert.equal(store.topicsets.size, 1, 'medium similarity must not create a set')
    assert.equal(store.dispatches.size, 0, 'medium similarity must not dispatch')
    assert.equal(store.routing.size, 0, 'medium similarity must not bind routing')
    assert.equal(r.candidates[0].id, 'ts-export')
    assert.ok(r.message.includes('候选话题集') && r.reason.includes('中等相似'))
    ok('M2 中等相似：need-confirm + 候选列表，不创建不派发')
  }

  // M3: low similarity keeps the legacy auto-create (title = task first line).
  {
    const store = fakeStore({ topicsets: [['ts-release', tsRow({ title: '发布流程与回滚演练', keywords: ['发布', '回滚'] })]] })
    const { ctx } = stubCtx()
    const task = '给 CLI 增加一个 --json 输出参数'
    const r = await runDispatch(deps(ctx, store), { task }, hubExec('hub-m3'))
    assert.equal(store.topicsets.size, 2, 'low similarity keeps the legacy auto-create')
    const created = [...store.topicsets.entries()].find(([id]) => id !== 'ts-release')
    assert.equal(created[1].title, clipEllipsis(firstLine(cleanTitleText(task)), 60))
    assert.equal(r.topicSetId, created[0])
    ok('M3 低相似：保持现状自动新建（标题=任务首行 60 字）')
  }

  // M4: a cross-workspace set is never a candidate.
  {
    const store = fakeStore({ topicsets: [['ts-foreign', tsRow({ workspaceKey: 'G:/other-ws', title: '同步并提交 SuperMemory 仓库的 Git', keywords: ['supermemory', 'git'] })]] })
    const { ctx } = stubCtx()
    await runDispatch(deps(ctx, store), { task: '同步并提交 SuperMemory 仓库的 git 改动并推送' }, hubExec('hub-m4'))
    assert.equal(store.topicsets.size, 2, 'a cross-workspace set is never a candidate')
    const created = [...store.topicsets.entries()].find(([id]) => id !== 'ts-foreign')
    assert.equal(created[1].workspaceKey, ws)
    ok('M4 跨工作区不匹配：候选池仅限同工作区，直接新建')
  }

  // M5: forceNewTopicSet bypasses matching even at high similarity.
  {
    const store = fakeStore({ topicsets: [['ts-git', tsRow({ title: '同步并提交 SuperMemory 仓库的 Git', keywords: ['supermemory', 'git'] })]] })
    const { ctx } = stubCtx()
    const r = await runDispatch(deps(ctx, store), { task: '同步并提交 SuperMemory 仓库的 git 改动并推送', forceNewTopicSet: true }, hubExec('hub-m5'))
    assert.equal(store.topicsets.size, 2, 'forceNewTopicSet bypasses matching')
    assert.notEqual(r.topicSetId, 'ts-git')
    ok('M5 forceNewTopicSet：绕过匹配直接新建')
  }

  // M6: kind='verify' funnels into 「<项目> · 验证」 — create once, reuse after.
  {
    const store = fakeStore({ topicsets: [] })
    const first = stubCtx()
    await runDispatch(deps(first.ctx, store), { task: '验证：只回复 OK', kind: 'verify' }, hubExec('hub-m6a'))
    assert.equal(store.topicsets.size, 1)
    const verifyId = [...store.topicsets.keys()][0]
    assert.equal(store.topicsets.get(verifyId).title, verifyTopicSetTitle(ws))
    const second = stubCtx()
    await runDispatch(deps(second.ctx, store), { task: '再验证：只回复 OK', kind: 'verify' }, hubExec('hub-m6b'))
    assert.equal(store.topicsets.size, 1, 'the second verify dispatch reuses the set (no new set)')
    assert.equal(store.routing.get('hub-m6b').activeTopicSetId, verifyId)
    assert.ok([...store.dispatches.entries()].every(([, row]) => row.topicSetId === verifyId), 'both dispatches land in the verify set')
    ok("M6 kind='verify'：首次建「<项目> · 验证」，二次复用不新建")
  }

  // M7: an empty task errors BEFORE any set is created.
  {
    const store = fakeStore({ topicsets: [] })
    const { ctx } = stubCtx()
    const r1 = await runDispatch(deps(ctx, store), {}, hubExec('hub-m7'))
    assert.equal(r1.status, 'error')
    assert.ok(r1.message.includes('task'))
    const r2 = await runDispatch(deps(ctx, store), { tasks: ['', '  '] }, hubExec('hub-m7'))
    assert.equal(r2.status, 'error')
    assert.equal(store.topicsets.size, 0, 'an empty task must not leave an empty-titled set behind')
    assert.equal(store.dispatches.size, 0)
    ok('M7 空任务护栏：先报错，不再先建空标题话题集')
  }
}

console.log(String.fromCharCode(10) + passed + ' checks passed')

process.exit(0)
