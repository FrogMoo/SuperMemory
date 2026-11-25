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
  proposalVerdict, isBroadSequence, cleanupToolize,
} = await import('../src/toolize.ts')
// R22/R50 能力（capability）：统一记录 / 执行安全闸 / 注册-持久化-重建 / 面板一键执行。
const {
  buildCapabilityRecord, capabilityToolName, capabilityToolDef, capabilityRecordsOf,
  capabilityRows, deleteCapability, editCapability, isValidCapabilityName, liveCapabilityToolNames,
  registerCapability, registerCapabilityTool, rebuildCapabilities, runCapability,
  highConfidenceEntryDraft,
} = await import('../src/capability.ts')

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
  questions: table(seed.questions ?? []),
  // R33/R35: positive hub records (role authority + panel badge truth). A
  // fixture without this table still works (guarded reads), but badge tests
  // must seed it explicitly.
  hubs: table(seed.hubs ?? []),
  meta: table(seed.meta ?? []),
  // R39: the hub-policy whitelist table (seeded by the dynamic-catalog tests).
  hubPolicies: table(seed.hubPolicies ?? []),
  // R41: per-workspace default models (settings tab).
  modelDefaults: table(seed.modelDefaults ?? []),
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
  const hintBlock = '[SuperMemory 提示]\n- 可用能力 sm_cap_read_edit：先预演再实跑'
  const text = renderRepeatCard(items, 'gentle', hintBlock)
  assert.ok(text.includes('过程内补充'), 'repeat card must be distinguishable from the opening card')
  assert.ok(text.includes('可用能力'), 'hint block must be present')
  assert.ok(text.includes('sm_cap_read_edit'), 'hint block names the capability')
  assert.ok(buildQuery({ baseQuery: 'a', toolText: 'b' }, 10) === 'a' + String.fromCharCode(10) + 'b')
  assert.equal(extractPaths('open G:/repo/src/a.ts and ./b/c.ts').length >= 1, true)
  assert.equal(memoryOverlap('构建命令 pnpm build', memories.entries(), 10) >= 3, true)
  ok('A6 卡片标题/结构化目录/查询拼接/路径与重合度工具函数')
}

// R47: the repeat card is budget-aware — the assembled card (catalog included)
// never exceeds its budget, and when records must be clipped the catalog is
// shed FIRST and the card says what it left out. The legacy no-budget call
// above (A6) keeps rendering everything.
{
  const { charCount } = await import('../src/clip.ts')
  const catalog = '[SuperMemory 提示]\n- 可用能力 sm_cap_read_edit：先预演再实跑'
  const longText = '这条结论说明构建与发布流程的关键约束。'.repeat(30)
  const items = [
    { memoryId: 'r1', title: '结论甲', text: longText, score: 9, createdAt: now, keywords: ['构建', '闸门'] },
    { memoryId: 'r2', title: '结论乙', text: longText, score: 8, createdAt: now, keywords: ['发布'] },
  ]
  const hint = '复取：memory_recall 「构建命令」'
  const tight = renderRepeatCard(items, 'gentle', catalog, { budget: 420, hint })
  assert.ok(charCount(tight) <= 420, 'R47: the repeat card must stay inside its budget (' + charCount(tight) + ')')
  assert.ok(!tight.includes('sm_cap_read_edit'), 'R47: the hint block is shed before a memory body is cut')
  assert.ok(tight.includes('【结论甲】') && tight.includes('｜标签: 构建、闸门'), 'R47: title and tags stay whole')
  assert.ok(/…（原文 \d+ 字，已省略 \d+ 字，复取：memory_recall 「结论甲」）/.test(tight),
    'R47: a clipped body names its size and how to re-fetch it')
  assert.ok(/…（已省略 \d+ 项/.test(tight), 'R47: the shed records are counted')
  const roomy = renderRepeatCard([{ memoryId: 'r3', title: '结论丙', text: '短结论：构建走 pnpm。', score: 9, createdAt: now, keywords: [] }], 'gentle', catalog, { budget: 900, hint })
  assert.ok(roomy.includes('sm_cap_read_edit') && charCount(roomy) <= 900,
    'R47: the catalog still rides along when the budget has room')
  ok('R47-8 过程内补充卡预算化：整卡 ≤ 预算、目录先于正文牺牲、正文句界省略带复取线索、丢卡计数')
}

// ---- requirement B: tool-ization (R49: observe-only + explicit accept) ----

{
  assert.equal(isBroadSequence(['run_code', 'run_code']), true, 'a run_code chain is broad by construction')
  assert.equal(isBroadSequence(['bash', 'edit']), true)
  assert.equal(isBroadSequence(['read', 'edit', 'write']), true)
  assert.equal(isBroadSequence(['memory_recall', 'memory_dispatch']), true, 'memory_* is generic')
  assert.equal(isBroadSequence(['sm_cap_git_sync_supermemory', 'bash']), true, 'a capability tool itself is generic')
  assert.equal(isBroadSequence(['erp_sync_orders', 'erp_push_invoice']), false, 'a business-object sequence stays a candidate')
  assert.equal(proposalVerdict(['erp_sync_orders', 'erp_sync_orders']).valuable, false, 'one repeated tool is not a flow')
  assert.equal(proposalVerdict(['erp_sync_orders']).valuable, false)
  ok('B1 R50 宽泛序列表述（仅清理分类）：run_code/bash/read/edit/write/memory_*/sm_cap_* 不构成业务对象，业务序列保留')
}

{
  // R49: no automatic entrance may register; the boot cleanup only clears/prunes.
  const broadSignal = { workspaceKey: 'ws-s', pattern: 'run_code>run_code', count: 2706, lastSeen: now, examples: [], sequence: ['run_code', 'run_code'], samples: [], proposedAt: now, proposalStatus: 'pending' }
  const broadStore = fakeStore({ signals: [['ws/ws-s/seq/run_code>run_code', broadSignal]] })
  const swept = await cleanupToolize({ store: broadStore, dropPending: true })
  assert.equal(swept.clearedProposals, 1, 'a broad pending proposal is cleared at boot')
  assert.equal(broadStore.signals.size, 0, 'never fixated into a signal row')
  assert.equal(broadStore.toolMemory.size, 0, 'the boot cleanup must not register/persist anything')
  const valuable = { workspaceKey: 'ws-s', pattern: 'erp_sync_orders>erp_push_invoice', count: 3, lastSeen: now, examples: [], sequence: ['erp_sync_orders', 'erp_push_invoice'], samples: [], proposedAt: now, proposalStatus: 'pending' }
  const keptStore = fakeStore({ signals: [['ws/ws-s/seq/erp_sync_orders>erp_push_invoice', valuable]] })
  const kept = await cleanupToolize({ store: keptStore, dropPending: false })
  assert.equal(kept.clearedProposals, 0, 'a valuable proposal survives while the legacy switch is on')
  assert.equal(keptStore.signals.get('ws/ws-s/seq/erp_sync_orders>erp_push_invoice').proposalStatus, 'pending')
  assert.equal(keptStore.toolMemory.size, 0, 'surviving the boot cleanup still registers nothing')
  const offStore = fakeStore({ signals: [['ws/ws-s/seq/erp_sync_orders>erp_push_invoice', valuable]] })
  const off = await cleanupToolize({ store: offStore, dropPending: true })
  assert.equal(off.clearedProposals, 1, 'with the legacy switch off every pending is cleared')
  ok('B2 R49 启动清理只清理/保留提议、永不注册；开关关闭时清空 pending')
}

{
  assert.equal(capabilityToolName('read-edit'), 'sm_cap_read_edit')
  assert.equal(capabilityToolName('git-sync-supermemory'), 'sm_cap_git_sync_supermemory')
  assert.equal(isValidCapabilityName('read-edit'), true)
  assert.equal(isValidCapabilityName('bad name'), false)
  assert.equal(liveCapabilityToolNames.has('sm_composite_read_edit'), false, 'no legacy composite name is live')
  ok('B4 命名：执行面统一 sm_cap_<name>；旧 sm_composite_* 不再注册')
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
  // R33 需求⑦: the relay card fields are durable with the outbox row.
  assert.equal(row.fromSessionId, 'b1', 'the relay source is the real branch session')
  assert.equal(row.fromKind, 'branch')
  assert.equal(row.task, '任务甲', 'the card keeps the task')
  assert.equal(row.capability, '', 'an old dispatch row without a capability keeps an empty card row')
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
  assert.equal(store.outbox.get('dlv-dsp-2').fromSessionId, 'b2', 'the failure relay also names its branch')
  assert.equal(store.outbox.get('dlv-dsp-2').task, '任务乙')
  ok('D2 已 failed 但从未送达 → 启动对账补发回执')
}

// ---- R42: relay 重复投递修复（中断回执只送达一次）----
// 真实病例（store + hub 会话日志双向实证）：同一批巡检里同分支同任务的两条派发
// （中枢在 host 工具报错后重试派发）各自投了一份逐字相同的「⏹ 中断终态」relay；
// 插件重载后中断清单 notice 又整批重投（内存签名去重不跨重载）。
const { deliverRelay } = await import('../src/observe.ts')
const { notifyInterruptedDispatches } = await import('../src/resume.ts')
// A LIVE hub that counts every followup, plus the R33 message-factory seam so no
// host module is needed. A fresh deps object over the SAME store simulates a
// plugin reload (module state gone, ledger kept).
const liveDeps = (dispatches, extra = {}) => {
  const sent = []
  const store = { dispatches: table(dispatches), outbox: table(), episodes: table(), topicsets: table(), ...extra }
  const ctx = { agents: { get: (id) => (id === 'hub' ? { followup: (message) => sent.push(message) } : undefined) } }
  const deps = {
    ctx, store,
    config: { enabled: true, maxTokensPolicy: 'deliver-partial' },
    logger,
    createMessage: (input) => ({ content: input.content, source: input.source }),
  }
  return { deps, store, sent }
}

{
  // 同一派发：连续多次巡检 + 重载（新 deps、同一 store）都只投一次。
  const stale = now - 3600000
  const seed = [['dsp-r1', { branchSessionId: 'b-r1', task: '任务甲', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', createdAt: stale, updatedAt: stale }]]
  const first = liveDeps(seed)
  const one = await settleInterruptedDispatches(first.deps, { timeoutMs: 60000, now, reason: '超时未结算' })
  assert.equal(one.length, 1, 'the first sweep interrupts the stale dispatch')
  assert.equal(first.sent.length, 1, 'exactly one relay reaches the hub')
  assert.equal(first.store.outbox.get('dlv-dsp-r1').status, 'relayed')
  const two = await settleInterruptedDispatches(first.deps, { timeoutMs: 60000, now })
  assert.equal(two.length, 0, 'a second sweep in the SAME process sends nothing')
  assert.equal(first.sent.length, 1)
  // reload: fresh deps (fresh module state), same ledger.
  const reloaded = liveDeps([...first.store.dispatches.entries()], { outbox: first.store.outbox })
  const three = await settleInterruptedDispatches(reloaded.deps, { timeoutMs: 60000, now })
  assert.equal(three.length, 0, 'after a reload the ledger alone suppresses the re-send')
  assert.equal(reloaded.sent.length, 0, 'no duplicate relay after reload')
  assert.equal(first.store.outbox.size, 1, 'still exactly one outbox row')
  ok('R42-1 中断派发多次巡检/重载只投一次（持久幂等）')
}

{
  // deliver 自身的持久守卫：已 relayed/confirmed 的行任何路径都不再发送。
  const stale = now - 3600000
  const { deps, store, sent } = liveDeps([['dsp-r2', { branchSessionId: 'b-r2', task: '任务乙', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: stale, updatedAt: stale }]])
  await deliverRelay(deps, { deliveryId: 'dlv-dsp-r2', dispatchId: 'dsp-r2', hubSessionId: 'hub', text: '回执一' })
  assert.equal(sent.length, 1)
  await deliverRelay(deps, { deliveryId: 'dlv-dsp-r2', dispatchId: 'dsp-r2', hubSessionId: 'hub', text: '回执一（重试）' })
  assert.equal(sent.length, 1, 'an already-relayed delivery is never re-sent')
  assert.equal(store.outbox.get('dlv-dsp-r2').status, 'relayed', 'and the confirmation is not destroyed')
  await store.outbox.update('dlv-dsp-r2', (r) => ({ ...r, status: 'confirmed' }))
  await deliverRelay(deps, { deliveryId: 'dlv-dsp-r2', dispatchId: 'dsp-r2', hubSessionId: 'hub', text: '回执一（再次）' })
  assert.equal(sent.length, 1, 'a confirmed delivery is final')
  ok('R42-2 deliver 持久守卫：relayed/confirmed 不重投、不覆盖确认')
}

{
  // 同分支 + 同任务的两条派发（中枢重试派发）在同一批巡检里只投一份回执。
  const stale = now - 3600000
  const seed = [
    ['dsp-r3a', { branchSessionId: 'b-r3', task: '同一个任务', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', createdAt: stale, updatedAt: stale }],
    ['dsp-r3b', { branchSessionId: 'b-r3', task: '同一个任务', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', createdAt: stale + 14000, updatedAt: stale + 14000 }],
  ]
  const { deps, store, sent } = liveDeps(seed)
  const settled = await settleInterruptedDispatches(deps, { timeoutMs: 60000, now })
  assert.equal(settled.length, 2, 'both dispatch rows are still marked interrupted')
  assert.equal(store.dispatches.get('dsp-r3a').status, 'interrupted')
  assert.equal(store.dispatches.get('dsp-r3b').status, 'interrupted')
  assert.equal(sent.length, 1, 'the twin is NOT re-sent: one relay for one logical interruption')
  assert.equal(store.outbox.get('dlv-dsp-r3b').suppressedOf, 'dsp-r3a', 'the twin ledger row names the dispatch that carried it')
  assert.equal(store.outbox.get('dlv-dsp-r3b').status, 'relayed', 'and is marked handled so flush never retries it')
  assert.equal(store.outbox.size, 2, 'both rows exist in the ledger')
  // 换一批（不同任务）不受影响：照样投递。
  const other = liveDeps([['dsp-r3c', { branchSessionId: 'b-r3', task: '另一个任务', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', createdAt: stale, updatedAt: stale }]])
  const sent2 = await settleInterruptedDispatches(other.deps, { timeoutMs: 60000, now })
  assert.equal(sent2.length, 1)
  assert.equal(other.sent.length, 1, 'a different task on the same branch is still announced')
  ok('R42-3 同分支同任务的双重派发只投一份（ledger 代投标记）')
}

{
  // 中断清单 notice 的持久增量：重载（全新签名表）后不重复公告。
  const stale = now - 3600000
  const seed = [
    ['dsp-r4a', { topicSetId: 'ts-1', branchSessionId: 'b-r4', task: '任务甲', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', turnEndReason: 'silent', createdAt: stale, updatedAt: stale }],
    ['dsp-r4b', { topicSetId: 'ts-1', branchSessionId: 'b-r4', task: '任务乙', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', turnEndReason: 'silent', createdAt: stale, updatedAt: stale }],
  ]
  const first = liveDeps(seed, { topicsets: table([['ts-1', { workspaceKey: 'ws', title: '集一', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }]]) })
  // ResumeDeps 未声明 createMessage（生产走 host 锚）；先赋给变量再传，绕过字面量
  // 的多余属性检查——deliver 在运行时仍会优先用它（R33 测试缝）。
  const rdeps = { ctx: first.deps.ctx, store: first.store, logger, createMessage: first.deps.createMessage }
  const n1 = await notifyInterruptedDispatches(rdeps, { now, state: { signatures: new Map() } })
  assert.equal(n1, 1, 'the first pass announces the batch once')
  assert.equal(first.sent.length, 1, 'one notice message reaches the hub')
  assert.ok(String(first.sent[0].content[0].text).includes('2 个被中断的任务'), 'the notice lists both dispatches')
  assert.equal(!!first.store.dispatches.get('dsp-r4a').interruptNoticedAt, true, 'the delta marker is persisted')
  assert.equal(!!first.store.dispatches.get('dsp-r4b').interruptNoticedAt, true)
  // reload: fresh signature map (the old in-memory dedup is gone), same ledger.
  const reloaded = liveDeps([...first.store.dispatches.entries()], { outbox: first.store.outbox, topicsets: first.store.topicsets })
  const rdeps2 = { ctx: reloaded.deps.ctx, store: reloaded.store, logger, createMessage: reloaded.deps.createMessage }
  const n2 = await notifyInterruptedDispatches(rdeps2, { now, state: { signatures: new Map() } })
  assert.equal(n2, 0, 'after a reload the SAME batch is not re-announced')
  assert.equal(reloaded.sent.length, 0, 'no duplicate notice after reload')
  // 清单刷新：新中断加入时只公告新增的那条。
  await reloaded.store.dispatches.put('dsp-r4c', { topicSetId: 'ts-1', branchSessionId: 'b-r4', task: '任务丙', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', turnEndReason: 'silent', createdAt: stale, updatedAt: stale })
  const n3 = await notifyInterruptedDispatches(rdeps2, { now, state: { signatures: new Map() } })
  assert.equal(n3, 1, 'a new interruption is announced')
  assert.equal(reloaded.sent.length, 1, 'exactly one new notice')
  assert.ok(String(reloaded.sent[0].content[0].text).includes('dsp-r4c'), 'the delta notice carries only the new dispatch')
  assert.ok(!String(reloaded.sent[0].content[0].text).includes('dsp-r4a'), 'and never re-lists the announced ones')
  ok('R42-4 中断公告持久增量：重载/清单刷新不重复（只报新增）')
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
const panelStore = () => fakeStore({
  topicsets: [
    ['ts-live', topicSet('ts-live', 'active', [member('branch-1', 'live', now - 1000), member('branch-2', 'idle', now), member('hub-root', 'live', now - 2000, 'root'), member('branch-fresh', 'live', now - 1500, 'root')])],
    ['ts-other', topicSet('ts-other', 'active', [member('branch-1', 'live', now - 5000)], now - 6000)],
    ['ts-archived', topicSet('ts-archived', 'archived', [member('branch-3', 'live', now)])],
  ],
  // R35: the non-member `session-*` badge is driven by POSITIVE hub records, not
  // by the id shape.
  hubs: [
    ['session-plain', { workspaceKey: 'ws', sessionId: 'session-plain', title: '中枢', source: 'panel', createdAt: now, updatedAt: now }],
  ],
})
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
  // Arity parity, not just id parity. The mounted client api validates the
  // ARGUMENT COUNT against the CLIENT declaration, so a method the host declares
  // with parameters but the client declares 0-arity throws at call time
  // ("client api: supermemoryPanel/listTools expected 0 argument(s), got 1") and
  // takes the whole panel down with it. Id-set parity alone cannot see that, so
  // the parameter contract is compared name by name, optionality included.
  const contractOf = (descriptor) => descriptor.parameters.map((p) => `${p.name}${p.acceptsUndefined ? '?' : ''}`)
  for (const hostDescriptor of contribution.invocations) {
    const clientDescriptor = PANEL_REMOTE.descriptors.find((d) => d.id === hostDescriptor.id)
    assert.ok(clientDescriptor, `the client half must declare ${hostDescriptor.id}`)
    assert.deepEqual(
      contractOf(clientDescriptor),
      contractOf(hostDescriptor),
      `parameter contract drift on ${hostDescriptor.id}: host [${contractOf(hostDescriptor)}] vs client [${contractOf(clientDescriptor)}]`,
    )
  }
  ok('E1 面板 typert 注册：ctx.get(typert) 注册一次 + typertRemote 绑定 + 描述符合法 + 合同 parity（id 集合 + 逐方法参数契约）')
}

{
  const services = { typert: { register: () => () => {} } }
  attachPanel(fakeCtx(services), panelStore())
  const service = services.supermemoryPanel
  assert.deepEqual(service.sessionBadge('branch-1'), { kind: 'branch', topicSetId: 'ts-live', topicSetTitle: 'ts-live', status: 'live' }, 'two hits resolve to the newest lastActiveAt')
  assert.deepEqual(service.sessionBadge('branch-2'), { kind: 'branch', topicSetId: 'ts-live', topicSetTitle: 'ts-live', status: 'idle' })
  // R31 需求②: an archived set never marks a branch — and the id shape decides
  // the non-member case, so a plugin branch is `none` (no badge), never a hub.
  assert.deepEqual(service.sessionBadge('branch-3'), { kind: 'none' }, 'an archived topic set never marks a branch (and a branch-* id is not a hub)')
  // R19 需求③④：root member = the set's own hub conversation. It must NOT be
  // labelled a branch (the R18 bug) and must carry its topic-set name instead.
  assert.deepEqual(service.sessionBadge('hub-root'), { kind: 'hub-set', topicSetId: 'ts-live', topicSetTitle: 'ts-live' })
  // A fresh dispatch records kind 'root' (its own session root) but its id is
  // `branch-*`: it must stay a branch, never become a hub-set.
  assert.deepEqual(service.sessionBadge('branch-fresh'), { kind: 'branch', topicSetId: 'ts-live', topicSetTitle: 'ts-live', status: 'live' })
  // R35: the non-member rule is POSITIVE evidence (hub_sessions record), never
  // the `session-*` id shape — a stale/foreign session-* id must not claim the
  // 中枢 badge just because of how it was minted.
  assert.deepEqual(service.sessionBadge('session-plain'), { kind: 'hub' }, 'a session-* id WITH a hub record is a hub')
  assert.deepEqual(service.sessionBadge('session-unrecorded'), { kind: 'none' },
    'a session-* id WITHOUT a hub record gets no badge (id shape is not a role)')
  assert.deepEqual(service.sessionBadge('hub-session'), { kind: 'none' }, 'an id this plugin cannot classify is not a hub')
  assert.deepEqual(service.sessionBadge('branch-lonely'), { kind: 'none' }, 'a plugin branch with no set yet gets no badge')
  ok('E2 sessionBadge：fork→分支（最新 lastActiveAt），root→hub-set，非成员按正证据（hub 记录→hub，无记录→none）')
}

// ---- R35: routing must use the ONE branch authority (resolveRole) ----
{
  // Regression: route.ts used to own a local prefix+fork branch rule that missed
  // `dispatches.branchSessionId`. A dispatch branch reached through mode:continue
  // on a non-branch-* id was therefore routed as a hub (topic hint injected).
  const { routeBatch } = await import('../src/route.ts')
  const { workspaceKeyOf } = await import('../src/store.ts')
  const cwd = process.cwd()
  const ws = workspaceKeyOf(cwd)
  const routeNow = Date.now()
  const routeStore = fakeStore({
    topicsets: [['ts-route', {
      workspaceKey: ws, title: '构建命令发布', summary: '', keywords: ['构建'], status: 'active',
      members: [], createdAt: routeNow, updatedAt: routeNow, lastActiveAt: routeNow,
    }]],
    dispatches: [['dsp-route', {
      branchSessionId: 'session-route-branch', task: '路由分支', hubSessionId: 'session-route-hub',
      startSeq: 0, status: 'dispatched', capability: '', title: '', tags: [],
      createdAt: routeNow, updatedAt: routeNow,
    }]],
  })
  const routeDeps = {
    store: routeStore,
    config: { enabled: true, driftTurns: 3, driftThreshold: 0.2, hint: true, llmFallback: false },
    logger: { warn: () => {}, info: () => {} },
  }
  const routeAgent = (id) => ({ id, session: { header: { cwd } } })
  const control = await routeBatch(undefined, routeDeps, routeAgent('session-route-plain'), 'session-route-plain', '构建命令发布')
  assert.ok(control.card?.includes('[SuperMemory 话题提示]'),
    'an ordinary session still gets the silent topic hint')
  const branch = await routeBatch(undefined, routeDeps, routeAgent('session-route-branch'), 'session-route-branch', '构建命令发布')
  assert.deepEqual(branch, {},
    'a dispatch branch (only dispatches.branchSessionId) is not routed like a hub')
  ok('R35-3 路由跳过分支统一走 resolveRole：dispatches.branchSessionId 命中的会话不再注入话题提示，普通会话行为不变')
}

// ---- R41 需求③: direct session names + one-time cleanup of prefixed titles ----
{
  const { migrateHubSessionTitles, HUB_TITLES_MIGRATION_VERSION } = await import('../src/hub-title-migration.ts')
  const { hubSessionTitle, workspaceLabel } = await import('../src/hub-sessions.ts')
  const { branchTitleFor } = await import('../src/branch-meta.ts')
  const { describeSessionTitle, stripLeadingDescription } = await import('../src/title.ts')
  const cwd = process.cwd()
  // R43 需求②③: a hub name is 「<工作区名> · <主题>」, so every expectation
  // below derives the label instead of hardcoding the repo directory name.
  const ws = workspaceLabel(cwd)

  // 1) generation: the work itself, no brand prefix / id token / lead-in.
  assert.equal(describeSessionTitle('R31：整理发布流程'), '整理发布流程')
  assert.equal(describeSessionTitle('任务：修构建'), '修构建')
  assert.equal(describeSessionTitle('分支 · 补测试'), '补测试')
  assert.equal(describeSessionTitle('R41-B · 任务：设置页签'), '设置页签')
  assert.equal(describeSessionTitle(''), '新会话')
  assert.equal(hubSessionTitle('session-abcd1234'), '新会话', 'no content and no workspace = neutral name, never an id token')
  assert.equal(hubSessionTitle('session-abcd1234', 'R41：检查设置页签'), '检查设置页签', 'without a workspace the topic stands alone')
  assert.equal(branchTitleFor('R31：修构建'), '修构建', 'branch title is the task, not the round label')

  // R42: the strip now also covers 「Rnn + 单个空格」 (dispatch titles are
  // «R32 只读复核：…»); the anchor is what keeps mid-sentence mentions safe.
  assert.equal(stripLeadingDescription('R31 的需求'), '的需求', 'R42: a round token at the START strips after one space')
  assert.equal(stripLeadingDescription('参考 R31 的实现'), '参考 R31 的实现', 'a round MENTIONED inside a sentence is never mutilated')

  // R42: the strip now also covers the label forms 「项目：」「背景：」「仓库：」
  // (a label keeps requiring a separator).
  assert.equal(stripLeadingDescription('R32 只读复核：代码落地质量'), '只读复核：代码落地质量', 'Rnn + single space strips at the start')
  assert.equal(stripLeadingDescription('第 3 轮 收尾'), '收尾', '第 N 轮 + space strips')
  assert.equal(stripLeadingDescription('Round 3 总结'), '总结', 'Round N + space strips')
  assert.equal(stripLeadingDescription('项目：整理发布'), '整理发布', 'a 项目： label strips')
  assert.equal(stripLeadingDescription('背景：仓库 F:\\repo'), '仓库 F:\\repo', 'a 背景： label strips')
  assert.equal(stripLeadingDescription('仓库：F:\\repo'), 'F:\\repo', 'a 仓库： label strips')
  assert.equal(stripLeadingDescription('需求分析：保持完整'), '需求分析：保持完整', 'a label WORD without a separator stays whole')
  assert.equal(describeSessionTitle('R38 只读核验：重载后运行时数据是否落库'), '只读核验：重载后运行时数据是否落库')

  // 2) one-time migration: only old branded/legacy hubs and plugin branches are
  //    touched; content comes from the first user message when readable.
  const titles = new Map([
    ['session-brand1', 'SuperMemory 中枢 · rand'],   // branded hub, readable content
    ['session-legacy2', '新会话 · lega'],             // pre-R31 hub, readable content
    ['session-useredit', '我自己起的名字'],             // user rename → never touched
    ['branch-work1', '话题集甲 · R31：修构建'],          // branch: strip set prefix + lead-in
    ['session-child4', 'SuperMemory 中枢 · hild'],    // parented → not a hub
    ['session-agent5', 'SuperMemory 中枢 · gent'],    // subagent → not a hub
  ])
  const contents = new Map([
    ['session-brand1', 'R41：检查设置页签'],
    ['session-legacy2', '整理发布流程'],
  ])
  const records = [
    { header: { id: 'session-brand1', cwd } },
    { header: { id: 'session-legacy2', cwd } },
    { header: { id: 'session-useredit', cwd } },
    { header: { id: 'branch-work1', cwd } },
    { header: { id: 'session-child4', cwd, parentSession: 'session-parent' } },
    { header: { id: 'session-agent5', cwd, origin: 'subagent' } },
  ]
  const writes = []
  const titleService = {
    get: (session) => ({ title: titles.get(session.id) ?? '' }),
    rename: (session, text) => { writes.push([session.id, text]); titles.set(session.id, text) },
  }
  const ctx = {
    sessions: { get: (id) => (titles.has(id) ? { id, append: () => {} } : undefined) },
    get: (name) => (name === 'sessionTitle' ? titleService : undefined),
  }
  const seam = {
    listSessions: async () => records,
    readTitleSnapshots: async (ids) => ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: { title: titles.get(id) ?? '' } } })),
    readSurface: async (id) => ({
      events: contents.has(id)
        ? [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: contents.get(id) }] } } }]
        : [],
    }),
  }
  const ctxWithSeam = { ...ctx, get: (name) => (name === 'sessionQuery' ? seam : name === 'sessionTitle' ? titleService : undefined) }
  const quiet = { warn: () => {}, info: () => {} }
  const member = { sessionId: 'branch-work1', kind: 'fork', title: '话题集甲 · R31：修构建', summary: '', status: 'idle', modelOverridden: false, lastActiveAt: 1 }
  const store = {
    meta: table(),
    hubs: table(),
    topicsets: table([['ts-a', { workspaceKey: cwd, title: '话题集甲', summary: '', keywords: [], status: 'active', members: [member], createdAt: 1, updatedAt: 1, lastActiveAt: 1 }]]),
    dispatches: table([['d1', {
      topicSetId: 'ts-a', branchSessionId: 'branch-work1', task: 'R31：修构建', hubSessionId: 'session-brand1',
      startSeq: 0, status: 'queued', title: 'R31：修构建', tags: [], capability: '', createdAt: 1, updatedAt: 1,
    }]]),
  }

  const dry = await migrateHubSessionTitles({ ctx: ctxWithSeam, store, logger: quiet }, { dryRun: true, ignoreMarker: true })
  assert.equal(dry.status, 'planned')
  assert.equal(dry.plan.length, 3, 'branded hub + legacy hub + work branch (user title, child, subagent excluded)')
  assert.deepEqual(
    dry.plan.map((row) => row.sessionId + ' => ' + row.to).sort(),
    ['branch-work1 => 修构建', `session-brand1 => ${ws} · 检查设置页签`, `session-legacy2 => ${ws} · 整理发布流程`],
  )
  assert.equal(writes.length, 0, 'dry-run writes nothing')
  assert.equal(store.dispatches.get('d1').title, 'R31：修构建', 'dry-run does not clean durable titles')

  const applied = await migrateHubSessionTitles({ ctx: ctxWithSeam, store, logger: quiet }, { ignoreMarker: true })
  assert.equal(applied.status, 'applied')
  assert.equal(applied.renamed, 3)
  assert.equal(titles.get('session-useredit'), '我自己起的名字', 'a user-renamed title is never overwritten')
  assert.equal(store.hubs.get('session-brand1')?.title, `${ws} · 检查设置页签`, 'a branded hub gets a positive record BEFORE the prefix disappears (R35 evidence)')
  assert.equal(store.hubs.get('session-brand1')?.source, 'title-migration')
  assert.equal(store.dispatches.get('d1').title, '修构建', 'durable dispatch title is cleaned')
  assert.equal(store.topicsets.get('ts-a').members[0].title, '修构建', 'durable branch member title is cleaned')
  assert.equal(store.meta.get('hub-titles')?.hubTitlesMigrationVersion, HUB_TITLES_MIGRATION_VERSION, 'a clean pass writes the version-2 marker')

  // 3) marker guard + no-host degradation.
  const again = await migrateHubSessionTitles({ ctx: ctxWithSeam, store, logger: quiet })
  assert.equal(again.status, 'already-done')
  assert.equal(again.renamed, 0)
  const noHost = await migrateHubSessionTitles({ ctx: undefined, store: { meta: table() }, logger: quiet }, { ignoreMarker: true })
  assert.equal(noHost.status, 'no-host')
  ok('R41-1 会话名称直接描述工作内容：生成去品牌前缀/令牌前缀（48 字）；迁移只改旧前缀中枢+插件分支（用户改名/子代理/子会话不碰），先写 hub 记录再改名，标记 v2 幂等 + durable 标题同步清理')

// ---- R42 需求③ 收尾：前缀规则补强 + 冷会话兜底 + 迁移 marker 收敛 ----
{
  const { migrateHubSessionTitles, finishPendingHubTitle, attachPendingHubTitleRename, HUB_TITLES_MIGRATION_VERSION } = await import('../src/hub-title-migration.ts')
  const { isLegacyHubTitle, isNeutralHubTitle, durableHubTitle, listHubSessions, workspaceLabel } = await import('../src/hub-sessions.ts')
  const cwd = process.cwd()
  assert.equal(HUB_TITLES_MIGRATION_VERSION, 3, 'R42 bumps the marker to v3')
  // R43 需求②: hub names are workspace-qualified, so the cold-session
  // expectations below derive the label rather than hardcode the repo name.
  const ws = workspaceLabel(cwd)

  // 1) legacy detection: brand prefix and 新会话 · <id> are legacy; a bare
  //    neutral name must not be treated as legacy.
  assert.equal(isLegacyHubTitle('SuperMemory 中枢 · ry6q'), true)
  assert.equal(isLegacyHubTitle('新会话 · s5vx5v'), true)
  assert.equal(isLegacyHubTitle('新会话'), false, 'the neutral name is not a legacy shape')
  assert.equal(isLegacyHubTitle('重载后只读核验'), false)

  // 2) the rail fallback: a COLD session keeps its legacy host title; the row
  //    shows the DURABLE record title instead (pure store read, no live session).
  const hubRow = (over = {}) => ({ workspaceKey: cwd, sessionId: 'session-cold', title: '', source: 'title-migration', createdAt: now, updatedAt: now, ...over })
  const fallbackStore = {
    hubs: table([
      ['session-cold', hubRow({ title: '重载后只读核验' })],
      ['session-warm', hubRow({ sessionId: 'session-warm', title: '直接描述的名字' })],
    ]),
    topicsets: table(),
    dispatches: table(),
  }
  const seam = {
    listSessions: async () => [
      { header: { id: 'session-cold', cwd } },
      { header: { id: 'session-warm', cwd } },
      { header: { id: 'session-norecord', cwd } },
    ],
    readTitleSnapshots: async (ids) => ids.map((id) => ({
      sessionId: id, status: 'fulfilled',
      value: { title: { title: id === 'session-cold' ? '新会话 · cold' : id === 'session-warm' ? 'SuperMemory 中枢 · warm' : 'SuperMemory 中枢 · nore' } },
    })),
  }
  const railCtx = { get: (name) => (name === 'sessionQuery' ? seam : undefined), sessions: { get: () => undefined } }
  const railRows = await listHubSessions(railCtx, fallbackStore, cwd)
  const byId = new Map(railRows.map((row) => [row.sessionId, row.title]))
  assert.equal(byId.get('session-cold'), '重载后只读核验', 'a legacy host title yields to the durable record title')
  assert.equal(byId.get('session-warm'), '直接描述的名字', 'a legacy host title yields to the durable record title (brand prefix case)')
  assert.equal(byId.get('session-norecord'), 'SuperMemory 中枢 · nore', 'without a durable record the host title stays')
  assert.equal(durableHubTitle(fallbackStore, 'session-cold'), '重载后只读核验')
  assert.equal(durableHubTitle(fallbackStore, 'session-norecord'), '', 'no record = no durable title')

  // 3) v3 convergence: an unattachable candidate is recorded as PENDING and the
  //    marker is still written, so the next startup does not rescan.
  const titles = new Map([['session-cold2', '新会话 · cold2']])
  const contents = new Map([['session-cold2', '重载后只读核验']])
  const live = new Set() // session-cold2 is NOT live during the startup pass
  const writes = []
  const titleService = {
    get: (session) => ({ title: titles.get(session.id) ?? '' }),
    rename: (session, text) => { titles.set(session.id, text); writes.push([session.id, text]) },
  }
  const coldSeam = {
    listSessions: async () => [{ header: { id: 'session-cold2', cwd } }],
    readTitleSnapshots: async (ids) => ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: { title: titles.get(id) ?? '' } } })),
    readSurface: async (id) => ({ events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: contents.get(id) ?? '' }] } } }] }),
  }
  const coldCtx = {
    // R43: the live session carries its header cwd, which is the workspace
    // fallback when a pending id has no durable hub record.
    sessions: { get: (id) => (live.has(id) ? { id, header: { cwd }, append: () => {} } : undefined) },
    get: (name) => (name === 'sessionQuery' ? coldSeam : name === 'sessionTitle' ? titleService : undefined),
  }
  const coldStore = {
    meta: table(),
    hubs: table(),
    topicsets: table(),
    dispatches: table([['d-cold', {
      topicSetId: 'ts-a', branchSessionId: 'branch-cold', task: 'R32 只读复核：x', hubSessionId: 'session-cold2',
      startSeq: 0, status: 'delivered', title: 'R32 只读复核：x', tags: [], capability: '', createdAt: 1, updatedAt: 1,
    }]]),
  }
  const pass = await migrateHubSessionTitles({ ctx: coldCtx, store: coldStore, logger: quiet }, { ignoreMarker: true })
  assert.equal(pass.status, 'applied')
  assert.equal(pass.pending, 1, 'the unattachable candidate is pending')
  const marker = coldStore.meta.get('hub-titles')
  assert.equal(marker?.hubTitlesMigrationVersion, 3)
  assert.deepEqual(marker?.hubTitlesPendingIds, ['session-cold2'], 'the pending id is recorded')
  assert.equal(coldStore.dispatches.get('d-cold').title, '只读复核：x', 'durable dispatch titles are still cleaned this pass')
  const converged = await migrateHubSessionTitles({ ctx: coldCtx, store: coldStore, logger: quiet })
  assert.equal(converged.status, 'already-done', 'the marker converged: no rescan on the next startup')

  // 4) the first live event finishes the pending rename and settles the id.
  assert.equal(await finishPendingHubTitle({ ctx: coldCtx, store: coldStore, logger: quiet }, 'session-cold2'), 'no-host', 'still not live = stays pending')
  live.add('session-cold2')
  assert.equal(await finishPendingHubTitle({ ctx: coldCtx, store: coldStore, logger: quiet }, 'session-cold2'), 'renamed')
  assert.equal(titles.get('session-cold2'), `${ws} · 重载后只读核验`, 'the cold session is renamed from its first user message')
  assert.deepEqual(coldStore.meta.get('hub-titles')?.hubTitlesPendingIds ?? [], [], 'the pending set drained')
  assert.ok((coldStore.meta.get('hub-titles')?.hubTitlesProcessedIds ?? []).includes('session-cold2'))
  assert.equal(await finishPendingHubTitle({ ctx: coldCtx, store: coldStore, logger: quiet }, 'session-cold2'), 'not-pending')

  // 5) the hook: one session/event listener renames pending ids on first activity.
  let listener
  const hookCtx = { ...coldCtx, on: (_type, cb) => { listener = cb; return () => {} } }
  const off = attachPendingHubTitleRename(hookCtx, coldStore, quiet)
  assert.equal(typeof listener, 'function', 'the hook registers one session/event listener')
  assert.equal(typeof off, 'function')
  await coldStore.meta.put('hub-titles', { hubTitlesMigrationVersion: 3, hubTitlesPendingIds: ['session-cold3'], hubTitlesProcessedIds: ['session-cold2'] })
  titles.set('session-cold3', '新会话 · cold3')
  // cold3 is pending but has no session object yet -> stays pending.
  await new Promise((resolve) => { listener({ id: 'session-cold3' }); setTimeout(resolve, 10) })
  assert.deepEqual(coldStore.meta.get('hub-titles')?.hubTitlesPendingIds ?? [], ['session-cold3'], 'an unreachable id stays pending')
  // now it goes live with readable content -> renamed and settled.
  live.add('session-cold3')
  contents.set('session-cold3', '冷会话补改名')
  await new Promise((resolve) => { listener({ id: 'session-cold3' }); setTimeout(resolve, 10) })
  assert.equal(titles.get('session-cold3'), `${ws} · 冷会话补改名`)
  assert.deepEqual(coldStore.meta.get('hub-titles')?.hubTitlesPendingIds ?? [], [], 'the hook drains the pending set')
  assert.equal(writes.filter(([id]) => id === 'session-cold2').length, 1, 'a settled id is not renamed twice')
  off()

  // 6) durable hub records are cleaned by the same rule.
  const hubCleanStore = {
    meta: table(),
    hubs: table([['session-legacy-hub', hubRow({ sessionId: 'session-legacy-hub', title: '背景：仓库 F:\\repo（DSH 插件）。面板页…' })]]),
    topicsets: table(),
    dispatches: table(),
  }
  await migrateHubSessionTitles({ ctx: coldCtx, store: hubCleanStore, logger: quiet }, { ignoreMarker: true })
  assert.equal(hubCleanStore.hubs.get('session-legacy-hub')?.title, '仓库 F:\\repo（DSH 插件）。面板页…', 'hub record titles are cleaned too')
  ok('R42-5 会话名称收尾：前缀规则补强（Rnn+空格/标签形式，句中轮次不误伤）+ 冷会话面板兜底（旧前缀让位记录标题）+ 迁移 marker v3 收敛（pending 集合 + 首事件补改名 + hub 记录标题同步清理）')
}

// ---- R43: card click must not become 新建 + hub/branch names say the topic ----
{
  const { hubSessionTitle, isNeutralHubTitle, workspaceLabel, HUB_TITLE_MAX_CHARS, listHubSessions } = await import('../src/hub-sessions.ts')
  const { attachHubTitleFromFirstMessage } = await import('../src/hub-title-migration.ts')
  const { TITLE_BRANCH_TASK_CHARS, describeSessionTitle } = await import('../src/title.ts')
  const cwd = 'F:\\10-SuperMemory'
  const ws = workspaceLabel(cwd)
  assert.equal(ws, '10-SuperMemory', 'the workspace label is the last path segment')

  // 1) hub naming: 「<工作区名> · <主题>」, never a bare 新会话.
  assert.equal(hubSessionTitle('session-x', '', cwd), '10-SuperMemory · 新会话',
    'no topic yet still says WHICH workspace (never the bare 新会话)')
  assert.equal(hubSessionTitle('session-x', 'R43：修卡片跳转', cwd), '10-SuperMemory · 修卡片跳转')
  assert.equal(hubSessionTitle('session-x', 'R43：修卡片跳转'), '修卡片跳转',
    'without a workspace path the topic stands alone (R41 shape)')
  const long = 'R43 需求：把分支卡片点击从跳新建改成打开对应会话，并让中枢与分支名称说清楚主题且允许更长'
  assert.equal(hubSessionTitle('session-x', long, cwd).length <= HUB_TITLE_MAX_CHARS, true,
    'the workspace-qualified title respects the 60-char budget')
  assert.ok(hubSessionTitle('session-x', long, cwd).startsWith('10-SuperMemory · '), 'the workspace prefix survives clipping')

  // 2) neutral detection: what may be upgraded, what must be kept.
  assert.equal(isNeutralHubTitle('新会话'), true)
  assert.equal(isNeutralHubTitle(''), true)
  assert.equal(isNeutralHubTitle('SuperMemory 中枢 · ry6q'), true, 'the old brand prefix is neutral (upgradeable)')
  assert.equal(isNeutralHubTitle('新会话 · s5vx5v'), true, 'the pre-R31 shape is neutral (upgradeable)')
  assert.equal(isNeutralHubTitle('10-SuperMemory · 新会话', cwd), true, 'the R43 default carries no topic')
  assert.equal(isNeutralHubTitle('10-SuperMemory · 修卡片跳转', cwd), false, 'a topic-bearing title is NOT neutral')
  assert.equal(isNeutralHubTitle('我自己起的名字', cwd), false, 'a human rename is kept')
  assert.equal(isNeutralHubTitle('重载后只读核验', cwd), false, 'a host/LLM title is kept')

  // 3) branch budget: 60 chars, not 48 (the user asked for the whole topic).
  assert.equal(TITLE_BRANCH_TASK_CHARS, 60)
  const task48 = 'R43 需求：把分支卡片点击从跳新建改成打开对应会话，并让中枢与分支会话名称都说清楚主题且允许更长一些，避免过度截断'
  assert.ok(describeSessionTitle(task48, 48).endsWith('…'), '48 chars still clipped (the old behaviour)')
  assert.ok(!describeSessionTitle(task48, TITLE_BRANCH_TASK_CHARS).endsWith('…'),
    '60 chars keep a normal one-line task whole')

  // 4) the first-message hook: names a neutral hub from the user's own message
  //    wherever it is typed (the shell path the panel never covered).
  const titles = new Map([['session-hub1', '新会话']])
  const writes = []
  const titleService = {
    get: (session) => ({ title: titles.get(session.id) ?? '' }),
    rename: (session, text) => { writes.push([session.id, text]); titles.set(session.id, text) },
  }
  const recordTitle = new Map()
  const hubStore = {
    hubs: {
      get: (id) => (id === 'session-hub1'
        ? { sessionId: id, workspaceKey: cwd, title: '新会话', source: 'panel', createdAt: 1, updatedAt: 1 }
        : undefined),
    },
  }
  const hookCtx = {
    sessions: { get: (id) => (titles.has(id) ? { id, append: () => {} } : undefined) },
    get: (name) => (name === 'sessionTitle' ? titleService : undefined),
    on: (_type, cb) => { hookListener = cb; return () => {} },
  }
  let hookListener
  const off = attachHubTitleFromFirstMessage(hookCtx, hubStore, { warn: () => {}, info: () => {} })
  assert.equal(typeof hookListener, 'function', 'the hook registers one session/event listener')
  const userMessage = (text, kind = 'user') => ({
    type: 'user/message', seq: 1, time: 1,
    data: { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind } },
  })
  await new Promise((resolve) => { hookListener({ id: 'session-hub1' }, userMessage('R43：修卡片跳转')); setTimeout(resolve, 10) })
  assert.equal(titles.get('session-hub1'), '10-SuperMemory · 修卡片跳转', 'the shell-path first message names the hub')
  assert.equal(writes.length, 1, 'exactly one rename')
  // A second message must not rename again (the Set + the neutral check).
  await new Promise((resolve) => { hookListener({ id: 'session-hub1' }, userMessage('第二条消息')); setTimeout(resolve, 10) })
  assert.equal(writes.length, 1, 'a second message never renames')
  // A relay/notice (kind supermemory) is not the user's words.
  await new Promise((resolve) => { hookListener({ id: 'session-hub2' }, userMessage('分支回报正文', 'supermemory')); setTimeout(resolve, 10) })
  assert.equal(writes.length, 1, 'a relay must not name a session')
  // An ordinary conversation (no hub record) is never touched.
  await new Promise((resolve) => { hookListener({ id: 'session-plain' }, userMessage('普通对话')); setTimeout(resolve, 10) })
  assert.equal(writes.length, 1, 'a session without a plugin hub record is never renamed')
  // A title a person chose is kept even though the message arrives.
  titles.set('session-hub3', '我自己起的名字')
  const hubStore3 = {
    hubs: { get: (id) => (id === 'session-hub3' ? { sessionId: id, workspaceKey: cwd, title: '我自己起的名字', source: 'panel', createdAt: 1, updatedAt: 1 } : undefined) },
  }
  let listener3
  const off3 = attachHubTitleFromFirstMessage(
    { ...hookCtx, on: (_t, cb) => { listener3 = cb; return () => {} } },
    hubStore3, { warn: () => {}, info: () => {} },
  )
  await new Promise((resolve) => { listener3({ id: 'session-hub3' }, userMessage('R43：新消息')); setTimeout(resolve, 10) })
  assert.equal(titles.get('session-hub3'), '我自己起的名字', 'a human rename is never overwritten by the hook')
  assert.equal(writes.length, 1)
  // 5) the rail: a COLD hub whose host title is the new neutral default still
  //    shows the DURABLE topic (the R42 fallback, widened to the R43 shape).
  const railHubStore = {
    hubs: table([['session-cold4', { workspaceKey: cwd, sessionId: 'session-cold4', title: '重载后只读核验', source: 'panel', createdAt: 1, updatedAt: 1 }]]),
    topicsets: table(),
    dispatches: table(),
  }
  const railSeam = {
    listSessions: async () => [{ header: { id: 'session-cold4', cwd } }],
    readTitleSnapshots: async (ids) => ids.map((id) => ({
      sessionId: id, status: 'fulfilled', value: { title: { title: '10-SuperMemory · 新会话' } },
    })),
  }
  const railCtx2 = { get: (name) => (name === 'sessionQuery' ? railSeam : undefined), sessions: { get: () => undefined } }
  const railRows2 = await listHubSessions(railCtx2, railHubStore, cwd)
  assert.equal(railRows2[0]?.title, '重载后只读核验',
    'a neutral host title yields to the durable record title (R42 fallback widened to the R43 shape)')

  off(); off3()
  ok('R43-1 命名规则：中枢「<工作区名> · <主题>」（无主题=工作区+新会话，60 字预算）+ 中性名判定（可升级/须保留）+ 分支任务预算 60 + shell 路径首条消息补名（只认 user 消息、只升中性名、一次性）')
}
}

{
  const { readModelDefaults, writeModelDefaults, defaultModelFor } = await import('../src/model-defaults.ts')
  const store = { modelDefaults: table() }
  assert.equal(readModelDefaults(store, 'ws-a').source, 'default', 'no row = follow the existing chain')
  await writeModelDefaults(store, 'ws-a', {
    hub: { provider: 'step', model: 'step-5' },
    branch: { provider: 'step', model: 'step-4', reasoningEffort: 'high' },
  })
  assert.deepEqual(readModelDefaults(store, 'ws-a').hub, { provider: 'step', model: 'step-5' })
  assert.equal(defaultModelFor(store, 'ws-a', 'branch').model, 'step-4')
  assert.equal(defaultModelFor(store, 'ws-a', 'branch').reasoningEffort, 'high')
  assert.equal(readModelDefaults(store, 'ws-b').source, 'default', 'defaults are workspace-scoped')
  await writeModelDefaults(store, 'ws-a', { hub: null })
  assert.equal(readModelDefaults(store, 'ws-a').hub, undefined, 'null clears one kind')
  assert.equal(readModelDefaults(store, 'ws-a').branch.model, 'step-4', 'the sibling survives')
  await writeModelDefaults(store, 'ws-a', { reset: true })
  assert.equal(readModelDefaults(store, 'ws-a').source, 'default', 'reset drops the row')
  ok('R41-2 默认模型设置：按工作区持久化 + 单项清空 + reset + 无行回退既有链路')
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

const serviceCtx = (services = {}) => ({
  get: (name) => services[name],
  // R39: the dynamic hub-policy catalog reads ctx.tools.definitions().
  tools: services.tools,
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
  // R41 需求①b/③a through the REAL panel service: persisted defaults are used
  // by a new hub (explicit composer choice wins), and the title is the work.
  const created = []
  const titles = new Map()
  const services = {
    agents: {
      create: async (options) => { created.push(options); return { agent: { session: { id: options.sessionId } } } },
      get: (id) => ({ id, session: { id } }),
    },
    sessionTitle: {
      get: (session) => ({ title: titles.get(session.id) ?? '' }),
      rename: (session, text) => { titles.set(session.id, text) },
    },
    sessions: { get: (id) => ({ id, append: () => {} }) },
    workspaceRegistry: { resolveByPath: async () => ({ attachSession: async () => {} }) },
  }
  const service = new SupermemoryPanelService(fakeStore(), serviceCtx(services))
  const cwd = 'F:\\ws-r41-defaults'
  assert.equal(service.getModelDefaults(cwd).source, 'default', 'no row reads as default')
  const saved = await service.setModelDefaults(cwd, {
    hub: { provider: 'deepseek', model: 'step-5' },
    branch: { provider: 'deepseek', model: 'step-4' },
  })
  assert.equal(saved.status, 'ok')
  assert.equal(service.getModelDefaults(cwd).hub.model, 'step-5', 'hub default is persisted')
  assert.equal(service.getModelDefaults(cwd).branch.model, 'step-4', 'branch default is persisted')
  const hub = await service.createHubSession(cwd, {}, 'R41：检查设置页签')
  assert.equal(hub.status, 'ok')
  assert.deepEqual(created.at(-1).agentOptions, { provider: 'deepseek', model: 'step-5' }, 'a new hub uses the hub default')
  assert.equal(titles.get(hub.id), 'ws-r41-defaults · 检查设置页签', 'R43: the hub title is 「<工作区名> · <首条消息>」')
  await service.createHubSession(cwd, { model: { provider: 'deepseek', model: 'manual' } }, '')
  assert.deepEqual(created.at(-1).agentOptions, { provider: 'deepseek', model: 'manual' }, 'an explicit model wins over the default')
  const cleared = await service.setModelDefaults(cwd, { hub: null })
  assert.equal(cleared.status, 'ok')
  assert.equal(service.getModelDefaults(cwd).hub, undefined, 'null clears the hub default')
  assert.equal(service.getModelDefaults(cwd).branch.model, 'step-4', 'the branch default survives')
  await service.setModelDefaults(cwd, { reset: true })
  assert.equal(service.getModelDefaults(cwd).source, 'default', 'reset drops the row')
  await service.createHubSession(cwd, {}, '')
  assert.ok(!created.at(-1).agentOptions, 'after reset the host default applies (no forced model)')
  assert.equal(titles.get(created.at(-1).sessionId), 'ws-r41-defaults · 新会话', 'R43: no content = 「<工作区名> · 新会话」, never a bare name')
  ok('R41-3 设置页签（真实服务）：默认模型按工作区保存/单项清空/reset；新建中枢用中枢默认且显式选择优先；标题取「<工作区名> · 首条消息」/无内容=工作区+新会话')
}

{
  // R41 需求②: exactly ONE rail highlight in any state (root cause of the
  // double-highlight bug: sessionId OR open-chat id matched two rows).
  const { isRailCurrent } = await import('../src/rail-selection.ts')
  assert.equal(isRailCurrent({ kind: 'hub' }, 'hub-a', 'hub-a'), true, 'the shell session is selected on the hub tab')
  assert.equal(isRailCurrent({ kind: 'hub' }, 'hub-b', 'hub-a'), false)
  assert.equal(isRailCurrent({ kind: 'chat', id: 'hub-b' }, 'hub-b', 'hub-a'), true, 'the opened chat wins')
  assert.equal(isRailCurrent({ kind: 'chat', id: 'hub-b' }, 'hub-a', 'hub-a'), false,
    'the shell session is NOT highlighted while another chat is open (the old OR highlighted both)')
  const rows = ['hub-a', 'hub-b'].filter((id) => isRailCurrent({ kind: 'chat', id: 'hub-b' }, id, 'hub-a'))
  assert.deepEqual(rows, ['hub-b'], 'exactly one row is current')
  assert.equal(isRailCurrent({ kind: 'chat', id: 'branch-x' }, 'hub-a', 'hub-a'), false,
    'a branch chat highlights no hub row')
  assert.equal(isRailCurrent({ kind: 'settings' }, 'hub-a', 'hub-a'), true, 'settings keeps the shell selection')
  ok('R41-4 侧栏单选唯一高亮：聊天视图按 chat id 判定、其它视图按 shell 会话判定；任何状态只命中一行')
}

{
  const services = {}
  const service = new SupermemoryPanelService(fakeStore(), serviceCtx(services))
  assert.deepEqual(await service.listAgentPresets(), [], 'a missing preset service degrades to an empty roster')
  assert.deepEqual(await service.listModelCatalog(), { providers: [], models: [] }, 'a missing llm service degrades to an empty catalog')
  assert.deepEqual(await service.listPermissions(), { options: [], defaultPreset: '' }, 'a missing permission service degrades to an empty catalog')
  ok('F2 降级：宿主目录服务缺失时快速启动仍可用（各自为空，不抛错）')
}

// ---- requirement R39: 「中枢权限」dynamic catalog (runtime sources + stale + fallback) ----
// Drives the REAL panel service with fake ctx.tools.definitions(): the default
// path is the dynamic runtime catalog grouped by source; unknown tools are
// listed and default-denied; disappeared whitelist entries are listed and
// cleanable; enumeration failure falls back to the built-in list with a warning.
{
  const { workspaceKeyOf } = await import('../src/store.ts')
  const cwd = 'F:\\ws-policy'
  const WS = workspaceKeyOf(cwd)
  let definitions = [
    { name: 'memory_recall', description: '召回结论\n第二行不该出现' },
    { name: 'read', description: '读取文件' },
    { name: 'mcp__rea__analyze_function', description: '分析函数' },
    { name: 'brand_new_tool', description: '未来工具' },
  ]
  const store = fakeStore({
    hubPolicies: [['hub-policy-dyn', {
      workspaceKey: WS,
      tools: ['memory_recall', 'read', 'retired_tool'],
      prefixes: ['schedule_'],
      updatedAt: now,
    }]],
  })
  const service = new SupermemoryPanelService(store, serviceCtx({ tools: { definitions: () => definitions } }))
  const first = service.getHubPolicy(cwd)
  assert.equal(first.catalogMeta.mode, 'dynamic', 'the default path is the dynamic runtime catalog')
  assert.ok(first.catalogMeta.generatedAt > 0)
  assert.equal(first.catalogMeta.groupCount, first.catalog.length)
  const ids = first.catalog.map((group) => group.id)
  assert.ok(ids.includes('source:supermemory'))
  assert.ok(ids.includes('source:mcp:rea'))
  assert.ok(ids.includes('source:host-session'))
  assert.ok(ids.includes('source:host'))
  assert.equal(ids[ids.length - 1], 'stale', 'the stale bucket is listed last')
  assert.deepEqual(first.stale.map((entry) => entry.name).sort(), ['retired_tool'],
    'whitelisted names that vanished from the runtime are listed, not dropped; the schedule_ prefix matches the synthetic schedule tools')
  const hostSession = first.catalog.find((group) => group.id === 'source:host-session')
  assert.equal(hostSession?.synthetic, true, 'the host-session group is marked synthetic')
  for (const name of ['plugin_manager', 'run_code', 'ask_user_question', 'job_output']) {
    const entry = hostSession?.items.find((item) => item.name === name)
    assert.equal(entry?.synthetic, true, 'the host/session tool is synthesized: ' + name)
    assert.equal(entry?.available, true, 'the synthesized entry is available: ' + name)
    assert.equal(entry?.stale, undefined, 'the synthesized entry is not stale: ' + name)
  }
  const unknown = first.catalog.flatMap((group) => group.items).find((entry) => entry.name === 'brand_new_tool')
  assert.equal(unknown.enabled, false, 'an unknown runtime tool is listed and default-denied')
  assert.equal(first.catalog.find((group) => group.id === 'source:supermemory').items[0].description, '召回结论',
    'only the first description line is projected')
  assert.equal(first.catalog.find((group) => group.id === 'source:supermemory').inferred, true,
    'the memory_* attribution is labelled as inference')

  // Refresh: a tool registered after the first call appears on the next one,
  // and the schedule_ prefix stops being stale because it now matches.
  definitions = [...definitions, { name: 'schedule_create', description: '建计划' }]
  const refreshed = service.getHubPolicy(cwd)
  assert.ok(refreshed.catalog.some((group) => group.id === 'source:schedule'
    && group.items.some((entry) => entry.name === 'schedule_create')), 'a refresh reflects a newly registered tool')
  assert.equal(refreshed.stale.some((entry) => entry.name === 'schedule_'), false,
    'the prefix is no longer stale once it matches a runtime tool')
  assert.ok(refreshed.catalogMeta.generatedAt >= first.catalogMeta.generatedAt)

  // One-click cleanup: the vanished name is removed, locked entries are kept,
  // and a prefix that now matches is kept.
  const cleaned = await service.cleanupStaleHubPolicy(cwd)
  assert.equal(cleaned.status, 'ok', 'cleanup succeeds with a runtime list')
  assert.match(cleaned.message, /已清理 1 个失效条目/)
  const row = [...store.hubPolicies.entries()][0][1]
  assert.equal(row.tools.includes('retired_tool'), false, 'the stale name is gone from the stored whitelist')
  assert.equal(row.tools.includes('memory_dispatch'), true, 'locked entries are never cleaned')
  assert.deepEqual(row.prefixes, ['schedule_'], 'a prefix that now matches a runtime tool is kept')
  assert.equal(row.tools.includes('read'), true)

  // Save → the refreshed snapshot keeps the checked state.
  const saved = await service.setHubPolicy(cwd, { tools: ['read'], prefixes: [] })
  assert.equal(saved.status, 'ok')
  const afterSave = service.getHubPolicy(cwd)
  assert.equal(afterSave.tools.includes('memory_dispatch'), true, 'the writer keeps locked entries')
  assert.equal(afterSave.catalog.flatMap((group) => group.items).find((entry) => entry.name === 'read').enabled, true)
  assert.equal(afterSave.catalog.flatMap((group) => group.items).find((entry) => entry.name === 'brand_new_tool').enabled, false,
    'an unlisted tool is unticked after the refresh (memory_recall stays locked)')

  // Fallback: enumeration failure keeps the page renderable and warns loudly;
  // cleanup refuses to guess without a runtime list.
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  const broken = new SupermemoryPanelService(fakeStore(), serviceCtx({
    tools: { definitions: () => { throw new Error('simulated enumeration failure') } },
  }))
  const fallback = broken.getHubPolicy(cwd)
  console.warn = originalWarn
  assert.equal(fallback.catalogMeta.mode, 'fallback', 'a failure degrades to the built-in catalog')
  assert.match(fallback.catalogMeta.warning, /内置清单/, 'the panel receives an explicit warning')
  assert.ok(warnings.some((message) => message.includes('已回退内置清单')), 'the fallback is also logged')
  assert.ok(fallback.catalog.flatMap((group) => group.items).some((entry) => entry.name === 'memory_recall'),
    'the fallback still lists known tools (no blank page)')
  const fallbackPm = fallback.catalog.flatMap((group) => group.items).find((entry) => entry.name === 'plugin_manager')
  assert.equal(fallbackPm?.synthetic, true, 'the fallback labels host/session tools synthetic')
  assert.equal(fallbackPm?.available, true, 'the fallback may claim availability for the explicit synthetic list')
  assert.equal((await broken.cleanupStaleHubPolicy(cwd)).status, 'error',
    'cleanup refuses to guess when the runtime list is unavailable')
  const noTools = new SupermemoryPanelService(fakeStore(), serviceCtx({}))
  assert.equal(noTools.getHubPolicy(cwd).catalogMeta.mode, 'fallback',
    'a host without ctx.tools also degrades to the fallback instead of throwing')
  ok('R39-1 中枢权限动态目录：运行时工具按来源分组（推断标注）+ 未知工具默认拒绝且可勾选 + 失效条目单列/可清理 + 刷新反映新增工具 + 枚举失败回退内置清单并告警')
}

// ---- requirement R40: host/session synthetic entries through the REAL panel service ----
// The user-facing failure was plugin_manager showing up under 「已失效条目」. This
// drives getHubPolicy / setHubPolicy / cleanupStaleHubPolicy with a fake global
// definitions() that omits plugin_manager (the real Web composition does), and
// asserts the synthetic host-session surface: available, never stale, never
// cleaned, still switchable, and replaced by a real definition when one exists.
{
  const { workspaceKeyOf } = await import('../src/store.ts')
  const cwd = 'F:\\ws-host-session'
  const WS = workspaceKeyOf(cwd)
  const globalDefs = [
    { name: 'memory_recall', description: '召回结论' },
    { name: 'read', description: '读取文件' },
  ]
  const store = fakeStore({
    hubPolicies: [['hub-policy-host-session', {
      workspaceKey: WS,
      tools: ['plugin_manager', 'run_code', 'read'],
      prefixes: ['schedule_'],
      updatedAt: now,
    }]],
  })
  const service = new SupermemoryPanelService(store, serviceCtx({ tools: { definitions: () => globalDefs } }))
  const view = service.getHubPolicy(cwd)
  const hostGroup = view.catalog.find((group) => group.id === 'source:host-session')
  assert.equal(hostGroup?.synthetic, true, 'the panel receives a synthetic host-session group')
  for (const name of ['plugin_manager', 'run_code', 'ask_user_question', 'send_message', 'job_output', 'schedule_create']) {
    const entry = hostGroup?.items.find((item) => item.name === name)
    assert.ok(entry, 'the host/session tool is listed: ' + name)
    assert.equal(entry.synthetic, true, 'it is synthetic: ' + name)
    assert.equal(entry.available, true, 'it is available: ' + name)
    assert.equal(entry.stale, undefined, 'it is not stale: ' + name)
  }
  assert.equal(view.stale.length, 0, 'the stale group is empty for a whitelist of host/session tools')
  assert.ok(view.catalogMeta.syntheticCount >= 18, 'the snapshot reports how many entries are synthetic')

  // Cleanup must not remove any synthetic entry.
  const cleaned = await service.cleanupStaleHubPolicy(cwd)
  assert.equal(cleaned.status, 'ok')
  assert.match(cleaned.message, /没有失效条目需要清理/)
  const row = [...store.hubPolicies.entries()][0][1]
  assert.equal(row.tools.includes('plugin_manager'), true, 'cleanup keeps plugin_manager')
  assert.equal(row.tools.includes('run_code'), true, 'cleanup keeps run_code')
  assert.deepEqual(row.prefixes, ['schedule_'], 'cleanup keeps the schedule_ prefix (synthetic schedule tools match)')

  // Switching plugin_manager off removes it from the whitelist, and the panel
  // still shows it as a re-checkable (unlocked) synthetic row.
  assert.equal((await service.setHubPolicy(cwd, { tools: ['read'], prefixes: [] })).status, 'ok')
  const afterOff = service.getHubPolicy(cwd)
  const pmOff = afterOff.catalog.flatMap((group) => group.items).find((item) => item.name === 'plugin_manager')
  assert.equal(pmOff?.enabled, false, 'plugin_manager is off after saving without it')
  assert.equal(pmOff?.available, true, 'it stays available while off')
  assert.equal(pmOff?.synthetic, true, 'it stays synthetic while off')
  assert.equal(pmOff?.locked, undefined, 'it is not locked: the user may switch it back on')
  assert.equal(afterOff.stale.some((item) => item.name === 'plugin_manager'), false,
    'switching it off never puts it in the stale group')

  assert.equal((await service.setHubPolicy(cwd, { tools: ['read', 'plugin_manager'], prefixes: [] })).status, 'ok')
  assert.equal(service.getHubPolicy(cwd).catalog.flatMap((group) => group.items)
    .find((item) => item.name === 'plugin_manager')?.enabled, true, 'switching it back on works')
  assert.equal((await service.setHubPolicy(cwd, { reset: true })).status, 'ok')
  assert.equal(service.getHubPolicy(cwd).catalog.flatMap((group) => group.items)
    .find((item) => item.name === 'plugin_manager')?.enabled, true,
  'restoring the default brings plugin_manager back (it is in the built-in default list)')

  // A host that DOES register plugin_manager globally wins: one row, real text.
  const realService = new SupermemoryPanelService(fakeStore(), serviceCtx({
    tools: { definitions: () => [...globalDefs, { name: 'plugin_manager', description: '真实注册的第一行' }] },
  }))
  const realView = realService.getHubPolicy(cwd)
  const pmItems = realView.catalog.flatMap((group) => group.items).filter((item) => item.name === 'plugin_manager')
  assert.equal(pmItems.length, 1, 'the real definition is not duplicated by the synthetic list')
  assert.equal(pmItems[0].synthetic, undefined, 'the real definition is not labelled synthetic')
  assert.equal(pmItems[0].description, '真实注册的第一行', 'the real description is shown')
  assert.equal(realView.catalog.find((group) => group.id === 'source:host-session')?.items
    .some((item) => item.name === 'plugin_manager'), false,
  'the real plugin_manager is not also listed in the synthetic group')
  ok('R40-2 面板服务：plugin_manager/run_code 在全局 definitions 缺失时仍在 host-session 组（available/不失效）'
    + ' + 清理不移除 + 关闭后仍可重新勾选 + 恢复默认回来 + 真实定义优先不重复')
}

// ---- requirement R55: locked sm_cap_doc + one-time merge + panel badges ----
// A pre-R55 stored row omits the locked entries; the guard already allows them
// (isHubAllowedTool), and this one-time merge makes the durable row truthful so
// the panel reads it back as checked. The second boot is a no-op (marker), and
// the panel surfaces the R55 boundary badges.
{
  const { workspaceKeyOf } = await import('../src/store.ts')
  const hubPolicy = await import('../src/hub-policy.ts')
  const cwd = 'F:\\ws-r55'
  const WS = workspaceKeyOf(cwd)
  const store = fakeStore({
    hubPolicies: [['hub-policy-r55', {
      workspaceKey: WS, tools: ['read', 'memory_recall'], prefixes: ['schedule_'], updatedAt: now,
    }]],
  })
  const merged = await hubPolicy.mergeLockedHubPolicies(store)
  assert.equal(merged.status, 'merged', 'the first pass merges locked entries')
  assert.equal(merged.updated, 1)
  assert.ok(merged.added.includes('sm_cap_doc'), 'sm_cap_doc is the R55 addition: ' + merged.added.join(','))
  const row = [...store.hubPolicies.entries()][0][1]
  for (const name of hubPolicy.LOCKED_HUB_TOOLS) {
    assert.ok(row.tools.includes(name), 'the stored row now carries the locked entry: ' + name)
  }
  assert.ok(row.tools.includes('read') && row.tools.includes('memory_recall'), 'user entries are preserved')
  assert.deepEqual(row.prefixes, ['schedule_'], 'prefixes are untouched')
  const marker = store.meta.get('hub-policy-locked')
  assert.equal(marker?.hubPolicyLockedVersion, 1, 'the merge marker records the schema version')
  assert.equal(marker?.hubPolicyLockedUpdated, 1)
  const again = await hubPolicy.mergeLockedHubPolicies(store)
  assert.equal(again.status, 'already-done', 'a second boot is a no-op (marker)')
  assert.equal(again.updated, 0)
  const forced = await hubPolicy.mergeLockedHubPolicies(store, { ignoreMarker: true })
  assert.equal(forced.updated, 0, 're-scanning finds nothing missing (idempotent)')
  assert.deepEqual(forced.added, [])
  // The guard/policy read reflects the merged row; locked cannot be removed by a save.
  const resolved = hubPolicy.readHubPolicy(store, WS)
  assert.ok(resolved.tools.includes('sm_cap_doc'), 'the resolved policy carries the locked read-only tool')

  const cwd2 = 'F:\\ws-r55-panel'
  const WS2 = workspaceKeyOf(cwd2)
  const definitions = [
    { name: 'sm_cap_doc', description: '按需读取能力知识面' },
    { name: 'sm_cap_git_sync_supermemory', description: '执行 git 同步能力' },
    { name: 'memory_recall', description: '召回结论' },
    { name: 'read', description: '读取文件' },
  ]
  const panelStore = fakeStore({
    hubPolicies: [['hub-policy-r55-panel', { workspaceKey: WS2, tools: ['read'], prefixes: [], updatedAt: now }]],
  })
  const service = new SupermemoryPanelService(panelStore, serviceCtx({ tools: { definitions: () => definitions } }))
  await hubPolicy.mergeLockedHubPolicies(panelStore)
  const view = service.getHubPolicy(cwd2)
  assert.ok(view.locked.includes('sm_cap_doc'), 'the panel receives sm_cap_doc as a locked entry')
  const items = view.catalog.flatMap((group) => group.items)
  const docItem = items.find((item) => item.name === 'sm_cap_doc')
  assert.equal(docItem?.locked, true, 'the knowledge face renders as locked')
  assert.equal(docItem?.noteKey, 'capabilityDoc', 'the knowledge face carries the read-only-routing badge')
  assert.equal(docItem?.enabled, true, 'locked means always enabled')
  const execItem = items.find((item) => item.name === 'sm_cap_git_sync_supermemory')
  assert.equal(execItem?.noteKey, 'capabilityExecDenied', 'the execution face carries the hub-cannot-execute badge')
  assert.equal(execItem?.enabled, false, 'the execution face is outside the hub whitelist by default')
  assert.equal(execItem?.locked, undefined, 'the execution face is not locked (ticking it still never grants hub execution)')
  // A save that omits sm_cap_doc cannot remove it (writeHubPolicy merges locks).
  assert.equal((await service.setHubPolicy(cwd2, { tools: ['read'], prefixes: [] })).status, 'ok')
  const savedRow = [...panelStore.hubPolicies.entries()][0][1]
  assert.ok(savedRow.tools.includes('sm_cap_doc'), 'the writer keeps the locked read-only tool')
  // Cleanup keeps locked entries even when the fake runtime omits them.
  assert.equal((await service.cleanupStaleHubPolicy(cwd2)).status, 'ok')
  assert.ok([...panelStore.hubPolicies.entries()][0][1].tools.includes('sm_cap_doc'),
    'cleanup never removes a locked entry')
  // The fallback catalog (no runtime enumeration) still renders the locked row.
  const fallback = new SupermemoryPanelService(fakeStore(), serviceCtx({})).getHubPolicy(cwd2)
  const fallbackDoc = fallback.catalog.flatMap((group) => group.items).find((item) => item.name === 'sm_cap_doc')
  assert.equal(fallbackDoc?.locked, true, 'the fallback catalog locks sm_cap_doc too')
  assert.equal(fallbackDoc?.noteKey, 'capabilityDoc')
  ok('R55-4 锁定与合并：sm_cap_doc 默认允许且锁定（存盘/清理不可移除）；旧存储行一次性合并+标记+二次幂等；面板锁定/中枢不可执行徽标（动态与回退目录）')
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
  // R50 deleteCapability: durable row removed, knowledge face archived (if any),
  // unknown id refused, a broken capability row is refused rather than guessed.
  const spec = { schema: 'sm.capability/1', name: 'a-b', kind: 'capability', title: 'AB', description: 'd', entry: 'echo ab', runnable: true, steps: [], parameters: [] }
  const store = fakeStore({
    toolMemory: [['tm-1', { kind: 'capability', trigger: 'capability/a-b', description: 'd', entry: JSON.stringify(spec), useCount: 0, status: 'active' }]],
  })
  const missing = await deleteCapability(serviceCtx(), store, 'tm-nope')
  assert.equal(missing.status, 'error', 'an unknown capability is refused')
  const done = await deleteCapability(serviceCtx(), store, 'tm-1')
  assert.equal(done.status, 'ok')
  assert.equal(store.toolMemory.size, 0, 'the durable row is gone')
  const broken = fakeStore({ toolMemory: [['tm-3', { kind: 'capability', trigger: '', description: 'd', entry: '{oops', useCount: 0, status: 'active' }]] })
  const brokenResult = await deleteCapability(serviceCtx(), broken, 'tm-3')
  assert.equal(brokenResult.status, 'error', 'a broken definition is not deleted blindly')
  assert.equal(broken.toolMemory.size, 1, 'the broken row is kept for inspection')
  ok('F4 能力删除：行删除 + 未知 id 拒绝；损坏定义不盲删')
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
    kind: 'capability', title: '发布流程', tags: ['bash', 'test'], trigger: 'capability/release-flow', description: '能力：bash → test',
    entry: JSON.stringify({ schema: 'sm.capability/1', name: 'release-flow', kind: 'capability', title: '发布流程', description: '能力：bash → test', tags: ['bash', 'test'], entry: 'echo release', runnable: true, steps: [], parameters: [] }), useCount: 3, status: 'active',
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
    // R22 需求⑧: attached but finished — ONLINE, never a green "running" dot.
    { header: { id: 'hub-idle', cwd: WS, createdAt: 1200 }, live: true, persisted: true },
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
    get: (name) => {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => records,
          readTitleSnapshots: async (ids) => {
            requestedIds = ids
            return [
              { sessionId: 'hub-new', status: 'fulfilled', value: { title: { title: '新中枢', updatedAt: 9000 } } },
              { sessionId: 'hub-old', status: 'rejected' },
            ]
          },
        }
      }
      // R22 需求⑧: only hub-new is RUNNING; hub-idle exists but finished.
      if (name === 'agents') return { get: (id) => ({ id, status: id === 'hub-new' ? 'running' : 'idle' }) }
      return undefined
    },
  }
  const hubs = await listHubSessions(ctx, store, WS)
  assert.deepEqual(hubs.map((h) => h.sessionId), ['hub-new', 'hub-member', 'hub-idle', 'hub-old', 'session-fresh'],
    'subagents, forks, fork members (archived included) and other workspaces are excluded; a ROOT member stays a hub')
  assert.ok(!hubs.some((h) => h.sessionId.startsWith('branch-')), 'every branch- id is excluded, even a root-kind fresh dispatch')
  assert.ok(hubs.some((h) => h.sessionId === 'session-fresh'), 'a session- id outside every topic set stays a hub')
  assert.deepEqual([...requestedIds].sort(), ['hub-idle', 'hub-member', 'hub-new', 'hub-old', 'session-fresh'], 'titles are read in ONE batch request')
  assert.equal(hubs[0].title, '新中枢', 'the batch title is used')
  assert.equal(hubs[1].title, '未命名会话 ' + 'hub-member'.slice(-4), 'a rejected/absent title falls back to the id suffix')
  assert.equal(hubs[2].title, '未命名会话 ' + 'hub-idle'.slice(-4), 'a rejected/absent title falls back to the id suffix')
  assert.equal(hubs[3].title, '未命名会话 ' + 'hub-old'.slice(-4), 'a rejected title falls back to the id suffix')
  assert.equal(hubs[4].title, '未命名会话 ' + 'session-fresh'.slice(-4), 'the surviving session- hub gets a fallback title too')
  assert.equal(hubs[0].live, true, 'a RUNNING session lights the dot')
  assert.equal(hubs[0].online, true, 'a running session is also attached/online')
  assert.equal(hubs[1].live, false, 'a cold/persisted-only session is not running')
  assert.equal(hubs[1].online, false, 'a cold/persisted-only session is offline')
  assert.equal(hubs[2].live, false, 'an attached-but-idle session is NOT running (the permanent-green-dot bug)')
  assert.equal(hubs[2].online, true, '…but it is still online, exposed as a separate field')
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
  assert.equal(fallback[0].online, true, 'the fallback corpus rows are attached')
  assert.equal(fallback[0].live, false, 'no agent registry -> activity is UNKNOWN -> the dot stays dark')
  ok('H5 中枢会话列表：过滤规则（父/子代理/fork 成员含归档/他工作区/branch- 前缀）、root 成员保留并带话题集、标题批量读取、排序与上限、降级、活跃判定（只有 running 亮绿点，未知不亮）')
}

{
  // R22 需求⑧: the activity probe's own degradation matrix — one `agents.list()`
  // enumeration is preferred, a throwing list falls back to per-id `get()`, and
  // every unknown/throwing path must answer false ("unknown stays dark").
  const WS = nodePath.resolve('ws-live')
  const store = fakeStore()
  const record = { header: { id: 'hub-list', cwd: WS, createdAt: 1 }, live: true, persisted: true }
  const ctxWith = (agents) => ({
    get: (name) => {
      if (name === 'sessionQuery') {
        return { listSessions: async () => [record], readTitleSnapshots: async () => [] }
      }
      return name === 'agents' ? agents : undefined
    },
  })
  const run = async (agents) => (await listHubSessions(ctxWith(agents), store, WS))[0]
  assert.equal((await run({ list: () => [{ id: 'hub-list', status: 'running' }] })).live, true,
    'agents.list(): a running id lights the dot')
  assert.equal((await run({ list: () => [{ id: 'hub-list', status: 'idle' }] })).live, false,
    'agents.list(): an idle agent stays dark')
  assert.equal((await run({
    list: () => { throw new Error('registry unavailable') },
    get: () => ({ status: 'running' }),
  })).live, true, 'a throwing list falls back to agents.get()')
  assert.equal((await run({ get: () => { throw new Error('registry unavailable') } })).live, false,
    'a throwing get() is unknown -> dark')
  assert.equal((await run(undefined)).live, false, 'no agents service is unknown -> dark')
  ok('H5b 活跃判定降级：agents.list 枚举优先，list 抛错回退 get；list/get 缺失或抛错都保持不亮')
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

// ---- R30 需求③④⑥: 中枢管理视图 / 分支标题+标签 / 派发脚本带中枢会话 id ----
// DSH sessions carry a native TITLE but no tags (verified in dsh-session-title),
// so the branch's 标题/标签 live on the dispatch record and are projected by
// hub-branches.ts into the hub card, the panel rows and the web console.
{
  const nodePath3 = await import('node:path')
  const WS3 = nodePath3.resolve('ws-r30b')
  const now3 = Date.now()
  const { branchTitleFor, branchTagsFor, roundTokensOf, latestBranchMeta } = await import('../src/branch-meta.ts')
  assert.equal(branchTitleFor('## 【R30-B：中枢-分支协同】\n第二行'), '中枢-分支协同', '标题取任务首行（去标记/去轮次前缀）')
  // R43 需求③: the branch budget is 60 (was 48) — the user reported names as
  // over-truncated, so a normal one-line task now stays whole.
  assert.equal(branchTitleFor('任'.repeat(80)).length, 60, '标题 60 字预算并以 … 标记截断')
  assert.ok(branchTitleFor('任'.repeat(80)).endsWith('…'), '截断以 … 标记')
  assert.deepEqual(roundTokensOf('【R30-B：…】与 R30 相关'), ['R30-B', 'R30'], '轮次令牌含裸轮次')
  assert.deepEqual(
    branchTagsFor({ topicTags: ['supermemory'], task: '【R30-B：…】', kind: 'verify', capability: 'full' }),
    ['supermemory', 'R30-B', 'R30', '验证', 'full'],
    '标签 = 话题集标签 + 轮次 + 任务性质 + 能力档位',
  )
  const metaStore = fakeStore({ dispatches: [
    ['d-old', { topicSetId: 'ts', branchSessionId: 'b-1', task: '老', hubSessionId: 'hub', startSeq: 0, status: 'delivered', title: '老标题', tags: ['旧'], createdAt: now3 - 5000, updatedAt: now3 - 4000 }],
    ['d-new', { topicSetId: 'ts', branchSessionId: 'b-1', task: '【R30-B：新】', hubSessionId: 'hub', startSeq: 0, status: 'dispatched', title: '【R30-B：新】', tags: ['R30-B'], createdAt: now3 - 1000, updatedAt: now3 }],
  ] })
  assert.deepEqual(latestBranchMeta(metaStore).get('b-1'), { title: '【R30-B：新】', tags: ['R30-B'] }, '最新派发行持有该映射')
  ok('R30-B1 分支标题/标签：推导规则 + latestBranchMeta 投影')
}

{
  // 需求③: the hub's management view — every topic set (archived included) and
  // every branch across sets, plus the branch row's explicit title/tags.
  const nodePath4 = await import('node:path')
  const WS4 = nodePath4.resolve('ws-r30b-panel')
  const now4 = Date.now()
  const m = (sessionId, kind = 'fork') => ({ sessionId, kind, title: sessionId, summary: '', status: 'idle', modelOverridden: false, lastActiveAt: now4 })
  const store = {
    topicsets: table([
      ['ts-live', { workspaceKey: WS4, title: '活跃集', summary: '', keywords: ['a'], status: 'active', members: [m('branch-1'), m('hub-root', 'root')], createdAt: now4, updatedAt: now4, lastActiveAt: now4 - 500 }],
      ['ts-old', { workspaceKey: WS4, title: '归档集', summary: '', keywords: ['b'], status: 'archived', members: [m('branch-2')], createdAt: now4, updatedAt: now4, lastActiveAt: now4 - 9000 }],
    ]),
    memories: table(), episodes: table(), requirements: table(), filemap: table(),
    toolMemory: table(), signals: table(), outbox: table(), routing: table(), hotcache: table(), questions: table(),
    dispatches: table([
      ['d-1', { topicSetId: 'ts-live', branchSessionId: 'branch-1', task: '【R30-B：任务一】', hubSessionId: 'hub-1', startSeq: 0, status: 'dispatched', title: '【R30-B：任务一】', tags: ['R30-B', 'full'], createdAt: now4 - 3000, updatedAt: now4 - 2000 }],
      ['d-2', { topicSetId: 'ts-old', branchSessionId: 'branch-2', task: '旧任务', hubSessionId: 'hub-1', startSeq: 0, status: 'delivered', title: '旧任务', tags: [], createdAt: now4 - 8000, updatedAt: now4 - 7000 }],
    ]),
  }
  const service = new SupermemoryPanelService(store, undefined)
  const allSets = service.listAllTopicSets(WS4)
  assert.equal(allSets.length, 2, '全部话题集含归档')
  assert.equal(allSets[0].id, 'ts-live', '活跃集在前')
  assert.equal(allSets[1].status, 'archived', '归档集带状态')
  const row = allSets[0].branches.find((b) => b.sessionId === 'branch-1')
  assert.equal(row.title, '【R30-B：任务一】', '面板分支行显示显式标题')
  assert.deepEqual(row.tags, ['R30-B', 'full'], '面板分支行带标签')
  assert.equal(service.listTopicSets(WS4).length, 1, '话题集页签保持只看活跃')
  assert.equal(service.listAllBranches(WS4).length, 2, '全部分支跨话题集')
  assert.equal(service.listAllBranches(WS4, 'ts-live').length, 1, '按话题集筛选')
  ok('R30-B2 面板：listAllTopicSets/listAllBranches + 分支行标题/标签')
}

{
  // 需求⑤.2 + ⑥.1: the hub card carries the matched set's branches; the
  // dispatch script names the hub session the relay returns to.
  const { renderHubBranchesCard, listHubBranches } = await import('../src/hub-branches.ts')
  const now5 = Date.now()
  const store = fakeStore({
    topicsets: [['ts-1', { workspaceKey: 'ws', title: '话题集甲', summary: '', keywords: ['supermemory'], status: 'active', members: [{ sessionId: 'b-1', kind: 'fork', title: '成员名', summary: '', status: 'idle', lastActiveAt: now5 - 1000 }], createdAt: now5, updatedAt: now5, lastActiveAt: now5 }]],
    dispatches: [['d-1', { topicSetId: 'ts-1', branchSessionId: 'b-1', task: '【R30-A：记忆版本控制】全文……', hubSessionId: 'hub-1', startSeq: 0, status: 'dispatched', title: '【R30-A：记忆版本控制】', tags: ['supermemory', 'R30-A', 'full'], createdAt: now5 - 9000, updatedAt: now5 - 8000 }]],
  })
  const rows = listHubBranches(store, 'hub-1')
  assert.equal(rows[0].title, '【R30-A：记忆版本控制】', '显式标题优先于成员标题')
  assert.deepEqual(rows[0].tags, ['supermemory', 'R30-A', 'full'])
  const card = renderHubBranchesCard(rows, { now: now5, topicSets: [{ title: '话题集甲', rows }] })
  assert.match(card, /标签 supermemory \/ R30-A \/ full/, '中枢卡显示标签')
  assert.match(card, /话题集「话题集甲」的分支（按话题集检索，可继续\/复用）：/, '命中话题集的分支随卡带出')
  assert.equal(renderHubBranchesCard([], { now: now5 }), '', '无分支无话题集段 → 空卡（行为不回退）')
  // Pre-R30 rows keep the legacy card shape (no tag segment).
  const legacy = renderHubBranchesCard([{ ...rows[0], tags: [] }], { now: now5 })
  assert.ok(!legacy.includes('标签'), '无标签时不出现标签段（向后兼容）')

  const script = buildDispatchScript({ task: '修构建', capabilities: 'full', topicTitle: '发布', branchSessionId: 'branch-9', dispatchId: 'dsp-9', hubSessionId: 'session-abc' })
  assert.ok(script.includes('中枢会话：session-abc'), '派发首条消息点名中枢会话（⑥）')
  assert.ok(script.includes('relay 回送目标'), '并说明 relay 回送目标就是它')
  const dry = buildDispatchScript({ task: '审阅', capabilities: 'read', topicTitle: 'x' })
  assert.ok(!dry.includes('中枢会话：'), 'dry-run 不带任何 id（R18 契约保持）')
  ok('R30-B3 注入卡带出命中话题集分支 + 派发脚本带中枢会话 id')
}

{
  // 需求③.1 防回归：新建中枢会话不绑定任何话题集（R29 的行为，R30 复核锁定）。
  const nodePath5 = await import('node:path')
  const WS5 = nodePath5.resolve('ws-r30b-hub')
  const now6 = Date.now()
  const store = fakeStore({
    topicsets: [['ts-1', { workspaceKey: WS5, title: '甲', summary: '', keywords: [], status: 'active', members: [], createdAt: now6, updatedAt: now6, lastActiveAt: now6 }]],
  })
  const created = []
  const agentsService = {
    create: async (options) => {
      created.push(options)
      return { agent: { followup: () => {} }, dispose: async () => {} }
    },
  }
  const services = { typert: { register: () => () => {} } }
  const fakeCtx = {
    agents: agentsService,
    provide: (k, v) => { services[k] = v },
    get: (n) => (n === 'typert' ? services.typert : services[n]),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  attachPanel(fakeCtx, store)
  const service = services.supermemoryPanel
  const result = await service.createHubSession(WS5, {}, '')
  assert.equal(result.status, 'ok', result.message)
  assert.equal(created.length, 1, 'exactly one host session is created')
  assert.equal(created[0].meta.cwd, WS5, 'the session carries the workspace')
  assert.equal(store.topicsets.get('ts-1').members.length, 0, 'createHubSession adds NO topic-set member（③.1）')
  assert.deepEqual(service.sessionBadge(result.id), { kind: 'hub' }, 'the new hub is badged as a plain hub')
  ok('R30-B4 新中枢会话不绑定话题集（③.1 防回归）')
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
  // R33 需求⑦: the group card's SOURCE is the first member BRANCH; the group id
  // is its own field — the pre-R33 code put the groupId into fromSessionId.
  assert.equal(groupRow[1].fromSessionId, 'd1', 'a group relay names the first member branch as its source')
  assert.equal(groupRow[1].groupId, 'grp-i', 'the group id stays in the group field')
  assert.equal(groupRow[1].fromKind, 'group')
  assert.equal(groupRow[1].fromTitle, '并行组', 'a group without a set/title keeps the explicit group label')
  assert.equal(groupRow[1].task, '任务-d1', 'the group card carries the first member task')
  ok('R19-协同1c 组回送卡：来源=首个成员分支、groupId 单列、任务/能力随行')
  ok('R19-协同1b 中断成员：interrupted 纳入组终态，整组汇总立即收敛且中断单独标注')
}

// ---- R33 需求⑦: flushObserve reconstructs a pre-R33 pending outbox row ----
// A row written by an older round carries only dispatchId/payload; the flush
// pass must resolve the source branch, its live/durable title, the task, the
// topic set and the capability, SEND them on the source marker, and persist
// them so the next restart needs no reconstruction.
{
  const { flushObserve } = await import('../src/observe.ts')
  const stamp = Date.now()
  const store = fakeStore({
    topicsets: [['ts-f', {
      workspaceKey: 'ws', title: '字段话题', summary: '', keywords: [], status: 'active',
      members: [{ sessionId: 'branch-f', kind: 'root', title: '分支F', summary: '', status: 'idle', lastActiveAt: stamp }],
      createdAt: stamp, updatedAt: stamp, lastActiveAt: stamp,
    }]],
    dispatches: [['dsp-f', {
      topicSetId: 'ts-f', branchSessionId: 'branch-f', task: '补字段', hubSessionId: 'hub-f',
      startSeq: 0, status: 'delivered', capability: 'full', title: '', tags: [], createdAt: stamp, updatedAt: stamp,
    }]],
    outbox: [['dlv-dsp-f', { kind: 'single', dispatchId: 'dsp-f', status: 'pending', enqueuedAt: stamp, payload: '回送正文' }]],
  })
  const seen = []
  const ctx = { agents: { get: () => ({ followup: (message) => { seen.push(message) } }) } }
  await flushObserve({
    ctx, store,
    config: { enabled: true, maxTokensPolicy: 'deliver-partial' },
    logger,
    createMessage: (input) => input,
  })
  assert.equal(seen.length, 1, 'the pending row is delivered when the hub is live again')
  const source = seen[0].source
  assert.equal(source.fromSessionId, 'branch-f', 'the source session is the branch, not a group id')
  assert.equal(source.fromTitle, '分支F', 'flushObserve resolves the missing source title')
  assert.equal(source.task, '补字段', 'the flush card carries the task')
  assert.equal(source.topicSetTitle, '字段话题', 'the flush card carries the topic set')
  assert.equal(source.capability, 'full', 'the flush card carries the capability')
  assert.equal(source.fromKind, 'branch')
  const row = store.outbox.get('dlv-dsp-f')
  assert.equal(row.status, 'relayed')
  assert.equal(row.fromSessionId, 'branch-f')
  assert.equal(row.fromTitle, '分支F')
  assert.equal(row.task, '补字段')
  assert.equal(row.topicSetTitle, '字段话题')
  assert.equal(row.capability, 'full', 'the resolved fields are persisted with the relayed status')
  ok('R33-7 flushObserve：来源=真实分支、fromTitle/任务/话题集/能力补齐并固化')
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

// ---- R22/R50 能力（capability）：统一记录（知识面 + 执行面） ----
// 一个记录两个投影：SKILL.md（知识面）+ sm_cap_<name>（执行面，固定入口，
// 默认预演、写操作 confirm=true）。
{
  assert.equal(isValidCapabilityName('git-sync-supermemory'), true)
  assert.equal(isValidCapabilityName('bad name'), false)
  assert.equal(isValidCapabilityName(''), false)
  assert.equal(isValidCapabilityName('-lead'), false)
  assert.equal(capabilityToolName('git-sync-supermemory'), 'sm_cap_git_sync_supermemory')
  const built = buildCapabilityRecord({
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
  assert.equal(built.record.kind, 'capability')
  assert.equal(built.record.name, 'git-sync-supermemory', 'logical name, not the tool name')
  assert.equal(capabilityToolName(built.record.name), 'sm_cap_git_sync_supermemory')
  assert.equal(built.record.entry, 'pnpm git:sync')
  assert.equal(built.record.doc, 'docs/git-sync.md')
  assert.equal(built.record.scope, 'G:\\09 - dsh\\SuperMemory')
  assert.equal(built.record.runnable, true)
  assert.equal(built.record.dryRunArg, '--dry-run')
  assert.equal(built.record.writeConfirm, true)
  assert.deepEqual(built.record.tags, ['git', '同步', '推送', '流程固化'])
  assert.equal(built.record.entryVerified, true)
  // R50: no entry = knowledge-only capability (valid, not an error).
  const knowledge = buildCapabilityRecord({ name: 'notes', description: '仅知识' })
  assert.equal(knowledge.status, 'ok')
  assert.equal(knowledge.record.kind, 'knowledge')
  assert.equal(knowledge.record.entry, '')
  assert.equal(knowledge.record.runnable, false)
  assert.equal(buildCapabilityRecord({ name: 'x', description: '' }).status, 'error', 'description is required')
  assert.equal(buildCapabilityRecord({ name: 'bad name', description: 'd' }).status, 'error', 'the name must be a legal slug')
  ok('K1 能力数据模型：逻辑名/sm_cap_ 工具名/仅知识（无 entry）/非法名缺描述拒绝')
}

{
  const rec = buildCapabilityRecord({
    name: 'cap-echo', description: 'd', entry: 'echo capability-dry-run-marker', dryRunArg: '--dry-run',
  }).record
  const r = runCapability(rec, {})
  assert.equal(r.status, 'completed', 'echo must succeed: ' + r.summary)
  assert.equal(r.exitCode, 0)
  assert.equal(r.dryRun, true, 'a defined dryRunArg makes dry-run the default')
  assert.ok(r.stdout.includes('capability-dry-run-marker'), 'stdout is captured')
  assert.equal(r.command, 'echo capability-dry-run-marker --dry-run')
  assert.ok(r.durationMs >= 0)
  ok('K2 能力执行（dry-run 默认）：捕获 stdout/退出码/耗时，命令自动附加预演参数')
}

{
  const write = buildCapabilityRecord({
    name: 'gate-test', description: 'd', entry: 'echo gate-should-not-run', writeConfirm: true,
  }).record
  const blocked = runCapability(write, {})
  assert.equal(blocked.status, 'needs-confirm', 'a write capability without confirm must be refused')
  assert.equal(blocked.stdout, '', 'nothing may be executed')
  assert.equal(blocked.dryRun, false)
  const allowed = runCapability(write, { confirm: true })
  assert.equal(allowed.status, 'completed')
  assert.ok(allowed.stdout.includes('gate-should-not-run'), 'confirm=true really runs it')
  assert.equal(allowed.dryRun, false)
  const dry = runCapability({ ...write, dryRunArg: '--dry-run' }, {})
  assert.equal(dry.status, 'completed')
  assert.equal(dry.dryRun, true)
  assert.ok(dry.command.includes('--dry-run'), 'the dry-run arg is appended')
  const noDry = runCapability(write, { dryRun: true })
  assert.equal(noDry.status, 'failed')
  assert.ok(noDry.summary.includes('无法预演'))
  assert.equal(noDry.stdout, '', 'still nothing executed')
  const off = runCapability({ ...write, runnable: false }, { confirm: true })
  assert.equal(off.status, 'failed')
  assert.ok(off.summary.includes('未开放执行'))
  const knowledge = buildCapabilityRecord({ name: 'k', description: 'd' }).record
  assert.equal(runCapability(knowledge, { confirm: true }).status, 'failed')
  ok('K3 执行安全闸：写操作需 confirm、默认预演、无预演参数拒绝预演、未开放执行/仅知识拒绝')
}

{
  // 注册 → 持久化 → 重启重建拾取 → 同名更新（不重复建行）。
  const registered = []
  const store = fakeStore()
  const ctx = { tools: { register: () => () => {}, get: () => undefined } }
  const deps = {
    register: async (c, s, entry) => { registered.push(entry.record.name); return () => {} },
  }
  const seed = {
    name: 'git-sync-supermemory',
    title: 'git 同步/提交/推送（SuperMemory 仓库）',
    description: '本仓库 git 同步/提交/推送的固化流程。',
    entry: 'pnpm git:sync',
    doc: 'docs/git-sync.md',
    runnable: true,
    dryRunArg: '--dry-run',
    writeConfirm: true,
    tags: ['git', '同步'],
  }
  const first = await registerCapability(ctx, store, seed, undefined, deps)
  assert.equal(first.status, 'ok', 'register must succeed: ' + first.message)
  assert.equal(first.name, 'git-sync-supermemory')
  assert.equal(store.toolMemory.size, 1, 'the capability must be persisted')
  const [, row] = [...store.toolMemory.entries()][0]
  assert.equal(row.kind, 'capability', 'R50 row kind is capability')
  const rec = JSON.parse(row.entry)
  assert.equal(rec.schema, 'sm.capability/1')
  assert.equal(rec.entry, 'pnpm git:sync')
  assert.equal(rec.writeConfirm, true)
  assert.deepEqual(registered, ['git-sync-supermemory'], 'the live tool is registered once')
  const rebuilt = []
  const count = await rebuildCapabilities(ctx, store, { register: async (c, s, entry) => { rebuilt.push(entry.record.name); return () => {} } })
  assert.ok(count >= 1)
  assert.ok(rebuilt.includes('git-sync-supermemory'), 'rebuild picks up the capability')
  const sizeBefore = store.toolMemory.size
  const again = await registerCapability(ctx, store, { ...seed, description: '更新后的路由描述' }, undefined, deps)
  assert.equal(again.status, 'ok')
  assert.equal(store.toolMemory.size, sizeBefore, 're-registering the same name updates in place')
  const caps = capabilityRecordsOf(store)
  const own = caps.find((cap) => cap.spec.name === 'git-sync-supermemory')
  assert.ok(own, 'capabilityRecordsOf lists the capability')
  assert.equal(own.spec.entry, 'pnpm git:sync')
  assert.equal(own.spec.description, '更新后的路由描述')
  ok('K4 能力注册→持久化→重启重建拾取→同名原地更新→列表')
}

{
  // 面板 runTool：能力可跑且计数、needs-confirm 不计数、仅知识/历史序列不可一键执行。
  const capabilityEntry = (spec) => JSON.stringify({
    schema: 'sm.capability/1', kind: 'capability', title: '面板能力', runnable: true,
    steps: [], parameters: [], ...spec,
  })
  const store = fakeStore({ toolMemory: [['tm-cap', {
    kind: 'capability', workspaceKey: 'ws', title: '面板能力', tags: ['git'], trigger: 'capability/panel-cap',
    description: '面板执行冒烟', entry: capabilityEntry({ name: 'panel-cap', description: '面板执行冒烟', entry: 'echo panel-capability-ok', dryRunArg: '--dry-run' }), useCount: 0, status: 'active',
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
  assert.equal(JSON.parse(store.toolMemory.get('tm-cap').entry).runCount, 1, 'a real run bumps runCount')
  const wstore = fakeStore({ toolMemory: [['tm-w', {
    kind: 'capability', title: '写能力', tags: [], trigger: 'capability/panel-w', description: 'd',
    entry: capabilityEntry({ name: 'panel-w', description: 'd', entry: 'echo panel-w-ok', writeConfirm: true }), useCount: 0, status: 'active',
  }]] })
  const wservice = new SupermemoryPanelService(wstore, serviceCtx())
  const dryFirst = await wservice.runTool('tm-w')
  assert.equal(dryFirst.status, 'needs-confirm', 'writeConfirm without dryRunArg cannot be previewed; it asks for confirm')
  const blocked = await wservice.runTool('tm-w', { dryRun: false })
  assert.equal(blocked.status, 'needs-confirm')
  assert.equal(JSON.parse(wstore.toolMemory.get('tm-w').entry).runCount ?? 0, 0, 'needs-confirm does not count as use')
  const ran = await wservice.runTool('tm-w', { confirm: true })
  assert.equal(ran.status, 'completed')
  assert.equal(ran.dryRun, false, 'confirm=true really runs')
  assert.equal(JSON.parse(wstore.toolMemory.get('tm-w').entry).runCount, 1)
  const sstore = fakeStore({ toolMemory: [['tm-s', {
    kind: 'composite', title: '历史序列', tags: [], trigger: 'ws/ws/seq/a>b', description: 'd',
    entry: JSON.stringify({ name: 'sm_composite_s', steps: [{ tool: 'read', arguments: {} }], parameters: [] }), useCount: 0, status: 'active',
  }]] })
  const seqResult = await new SupermemoryPanelService(sstore, serviceCtx()).runTool('tm-s')
  assert.equal(seqResult.status, 'failed', 'a legacy sequence row is not one-click runnable')
  ok('K5 面板执行：能力可跑且计数、needs-confirm 不计数、历史序列/仅知识不可执行')
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
  // R2b: 续跑完成（delivered）后原派发必须永久退出清单——旧逻辑只在续跑仍
  // 「在途」时排除，续跑一交付原派发就重新冒出来，导致 memory_resume 清单与
  // 每轮中断提醒反复列出已完成任务。另覆盖：只有后继写了 resumeOf 的历史单边
  // 关联、续跑链、以及续跑自身唤醒失败（resume-wake-failed）时保留原派发可重试。
  const store = fakeStore({
    dispatches: [
      ['dsp-x1', { branchSessionId: 'b-x1', task: '甲', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: now, updatedAt: now, resumedBy: 'dsp-x2' }],
      ['dsp-x2', { branchSessionId: 'b-x1', task: '甲', hubSessionId: 'hub', startSeq: 0, status: 'delivered', resumeOf: 'dsp-x1', createdAt: now, updatedAt: now }],
      // Legacy one-sided link: only the successor carries resumeOf.
      ['dsp-x3', { branchSessionId: 'b-x3', task: '乙', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: now, updatedAt: now }],
      ['dsp-x4', { branchSessionId: 'b-x3', task: '乙', hubSessionId: 'hub', startSeq: 0, status: 'delivered', resumeOf: 'dsp-x3', createdAt: now, updatedAt: now }],
      // Resume wake failed: the original is still the actionable row.
      ['dsp-x5', { branchSessionId: 'b-x5', task: '丙', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: now, updatedAt: now, resumedBy: 'dsp-x6' }],
      ['dsp-x6', { branchSessionId: 'b-x5', task: '丙', hubSessionId: 'hub', startSeq: 0, status: 'failed', turnEndReason: 'resume-wake-failed', resumeOf: 'dsp-x5', createdAt: now, updatedAt: now }],
      // Chain: interrupted -> interrupted -> delivered: nothing should surface.
      ['dsp-x7', { branchSessionId: 'b-x7', task: '丁', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: now, updatedAt: now, resumedBy: 'dsp-x8' }],
      ['dsp-x8', { branchSessionId: 'b-x7', task: '丁', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', resumeOf: 'dsp-x7', resumedBy: 'dsp-x9', createdAt: now, updatedAt: now }],
      ['dsp-x9', { branchSessionId: 'b-x7', task: '丁', hubSessionId: 'hub', startSeq: 0, status: 'delivered', resumeOf: 'dsp-x8', createdAt: now, updatedAt: now }],
    ],
  })
  const views = listInterruptedDispatches(store, { now })
  assert.deepEqual(views.map((view) => view.dispatchId), ['dsp-x5'],
    'a delivered successor permanently hides the original (forward/one-sided/chain links); a failed resume keeps it retryable')
  const deps = { ctx: {}, store, logger }
  const blocked = await resumeDispatch(deps, 'dsp-x1')
  assert.equal(blocked.status, 'error')
  assert.ok(blocked.message.includes('接替'), 'an already-completed successor rejects re-resuming the original')
  ok('R2b 续跑完成后原派发永久退出中断清单（含历史单边关联与续跑链）；续跑唤醒失败仍保留可重试，已接替的拒绝重复续跑')
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
  // R25: the continuation input lands as a human-form user message (kind
  // 'user', no form) so the branch's session-list recency advances.
  assert.equal(follows[0].source.kind, 'user', 'the resume input lands as kind user')
  // R32 需求③: kind stays 'user' (recency) but the plugin's form marker turns
  // the branch-side message into the same collapsible card as a relay.
  assert.equal(follows[0].source.form, 'supermemory-dispatch', 'R32 card marker on the resume input')
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
  assert.ok(DISPATCH_NEXT_ACTION.startsWith('已派发，结束本轮，等待 relay'), 'the dispatch receipt opens with the mandated wording')
  assert.ok(DISPATCH_NEXT_ACTION.includes('立即结束本轮回复'), 'the dispatch receipt tells the hub to end its turn')
  assert.ok(DISPATCH_NEXT_ACTION.includes('wait_agent') && DISPATCH_NEXT_ACTION.includes('轮询'), 'the receipt forbids waiting/polling explicitly')
  assert.ok(DISPATCH_NEXT_ACTION.includes('relay'), 'the receipt names the relay that opens the next turn')
  assert.ok(RESUME_NEXT_ACTION.startsWith('已续跑，结束本轮，等待 relay'), 'the resume receipt opens with the mandated wording')
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
  // R55: the hub role prompt moved to its own module (index.ts is not
  // importable host-free); read it from there.
  const hubRole = readFileSync('src/hub-role-text.ts', 'utf8')
  const route = readFileSync('src/route.ts', 'utf8')
  const tools = readFileSync('src/tools.ts', 'utf8')
  const dispatchSource = readFileSync('src/dispatch.ts', 'utf8')
  assert.ok(hubRole.includes('立即结束本轮回复'), 'hub role text: end the turn right after the receipt')
  assert.ok(hubRole.includes('subagent 树') && hubRole.includes('wait_agent'), 'hub role text: branches are not subagent-tree members')
  assert.ok(index.includes('派发后即结束本轮回复'), 'the memory prompt block repeats the rule')
  assert.ok(route.includes('立即结束本轮回复'), 'the routing card repeats the rule')
  assert.ok(tools.includes('R24 收口') && tools.includes('wait_agent'), 'both tool descriptions repeat the rule')
  assert.ok(tools.includes('RESUME_NEXT_ACTION'), 'memory_resume receipt is wired to the shared constant')
  // R22 需求①: the receipt path must never sleep/probe the branch while the hub's
  // tool call (and therefore its turn) is open. The old 300ms setTimeout lived
  // here; observation/reconciliation own everything after `followup()`.
  assert.ok(!/setTimeout\s*\(/.test(dispatchSource), 'the dispatch receipt path contains no wait/sleep')
  ok('R24-3 中枢/记忆提示/路由卡/两个工具描述与回执同源（文案不再只靠软提示）；回执路径无 sleep/轮询')
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


// ---- R23: topic-set merge (plan / apply / marker idempotency) ----
{
  const { planTopicSetMerges, applyPlanToStore, mergeTopicSets, renderMergeReport, TOPIC_MERGE_THRESHOLD } = await import('../src/topicset-merge.ts')
  const { topicSetIdsOf } = await import('../src/topicsets.ts')
  const { workspaceKeyOf } = await import('../src/store.ts')
  const { verifyTopicSetTitle } = await import('../src/topicset-match.ts')
  const cwd = process.cwd()
  const ws = workspaceKeyOf(cwd)
  const row = (over = {}) => ({
    workspaceKey: ws, title: '集合', summary: '', keywords: [], status: 'active', members: [],
    createdAt: now, updatedAt: now, lastActiveAt: now, ...over,
  })
  const member = (sessionId, title, kind = 'fork') => ({ sessionId, kind, title, summary: '', status: 'idle', modelOverridden: false, lastActiveAt: now })
  const dsp = (topicSetId, branchSessionId, task, createdAt = now) => ({
    topicSetId, branchSessionId, task, hubSessionId: 'hub-1', startSeq: 0, status: 'delivered', createdAt, updatedAt: now,
  })
  const fixture = () => fakeStore({
    topicsets: [
      // A 簇：git 同步三集（主集=成员最多）
      ['ts-git-a', row({ title: '同步并提交 SuperMemory 仓库的 Git', members: [member('b-git', '旧标题甲')], keywords: ['git'], createdAt: now - 3000 })],
      ['ts-git-b', row({ title: '同步并提交 SuperMemory 仓库的 Git 改动', members: [member('b-git', '旧标题甲', 'root')], createdAt: now - 2000 })],
      ['ts-git-c', row({ title: '同步并提交 SuperMemory 仓库', createdAt: now - 1000 })],
      // B 簇：插件修复两集（主集=成员最多）
      ['ts-dev-x', row({ title: '修复 SuperMemory 插件三个 GUI 问题', members: [member('b-dev-1', '修复甲'), member('b-dev-2', '修复乙')], createdAt: now - 500 })],
      ['ts-dev-y', row({ title: '修复 SuperMemory 插件 GUI 问题', createdAt: now - 400 })],
      // C 簇：一次性验证两集 → 目标即「<项目> · 验证」（不存在则新建）
      ['ts-c1', row({ title: '派发复测任务：请直接回复', summary: '这是 P1 派发链路的复测', members: [member('b-c1', '验证旧标题')], createdAt: now - 350 })],
      ['ts-c2', row({ title: '最终链路验证：请直接回复', summary: 'P1 最终链路验证', createdAt: now - 340 })],
      // 只共享「验证」二字的集合：不得误并（设计里的反例）
      ['ts-lonely', row({ title: '命名验证', createdAt: now - 300 })],
      // 边界对：共享两个标题词（6 分 < 阈值），只报告不合并
      ['ts-border-a', row({ title: '导出功能确认一下', createdAt: now - 290 })],
      ['ts-border-b', row({ title: '导出报表确认二次', createdAt: now - 280 })],
      // 0 成员 0 记录：空集归档
      ['ts-empty', row({ title: '空集一', createdAt: now - 270 })],
      // 0 成员但有记录：待人工处理
      ['ts-orphan', row({ title: '孤儿集', createdAt: now - 260 })],
    ],
    dispatches: [
      ['d-git-a', dsp('ts-git-a', 'b-git', '同步并提交 SuperMemory 仓库的 Git 改动并推送')],
      ['d-git-b', dsp('ts-git-b', 'b-git', '同步并提交 SuperMemory 仓库的 Git 改动并推送')],
      ['d-git-c', dsp('ts-git-c', 'b-other', '同步并提交 SuperMemory 仓库')],
      ['d-dev-x', dsp('ts-dev-x', 'b-dev-1', '修复 SuperMemory 插件三个 GUI 问题')],
      ['d-dev-y', dsp('ts-dev-y', 'b-dev-2', '修复 SuperMemory 插件 GUI 问题')],
      ['d-c1', dsp('ts-c1', 'b-c1', '派发复测任务：请直接回复一行')],
      ['d-orphan', dsp('ts-orphan', 'b-orphan', '无人认领的任务')],
    ],
    episodes: [
      ['e-git-c', { topicSetId: 'ts-git-c', branchSessionId: 'b-other', timeStart: now, timeEnd: now, summary: 'C 的归档', result: '', decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'b-other', sourceSeqStart: 0, sourceSeqEnd: 1 }],
      ['e-dev-y', { topicSetId: 'ts-dev-y', branchSessionId: 'b-dev-2', timeStart: now, timeEnd: now, summary: 'Y 的归档', result: '', decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'b-dev-2', sourceSeqStart: 0, sourceSeqEnd: 1 }],
    ],
    requirements: [
      ['r-dev-y', { topicSetId: 'ts-dev-y', workspaceKey: ws, text: '需求一', constraints: [], status: 'open', sourceSessionId: 'b-dev-2', sourceSeq: 0, createdAt: now }],
    ],
    questions: [
      ['q-dev-y', { topicSetId: 'ts-dev-y', dispatchId: 'd-dev-y', branchSessionId: 'b-dev-2', title: '问题一', question: '怎么做？', options: [], severity: 'medium', blocking: false, progress: '', defaultPlan: '', status: 'open', branchTask: '', createdAt: now, updatedAt: now }],
    ],
    routing: [
      ['hub-1', { activeTopicSetId: 'ts-dev-y', driftCount: 0, updatedAt: now }],
      ['hub-2', { activeTopicSetId: 'ts-git-c', driftCount: 0, updatedAt: now }],
    ],
    meta: [],
  })

  // M8: plan — 聚类、主集、验证集目标、边界/空集/孤儿
  {
    const store = fixture()
    const plan = planTopicSetMerges(store)
    assert.equal(plan.clusters.length, 3, 'three clusters: git / dev / verify')
    const git = plan.clusters.find((c) => c.target.topicSetId === 'ts-git-a')
    assert.ok(git, 'the git cluster targets the set with the most members')
    assert.ok(git.target.reason.includes('成员最多'), 'the primary reason is stated')
    assert.equal(git.sources.length, 2)
    assert.equal(git.membersAfter, 1, 'a session in two sets is kept ONCE')
    assert.equal(git.memberChanges.length, 1, 'the merged member title is recomputed')
    assert.ok(git.memberChanges[0].to.startsWith('同步并提交 SuperMemory 仓库的 Git'), 'the new title carries the target topic title')
    const dev = plan.clusters.find((c) => c.target.topicSetId === 'ts-dev-x')
    assert.ok(dev, 'the dev cluster targets the 2-member set')
    assert.equal(dev.records.dispatches, 1)
    assert.equal(dev.records.episodes, 1)
    assert.equal(dev.records.requirements, 1)
    assert.equal(dev.records.questions, 1)
    assert.equal(dev.records.routing, 1)
    const verify = plan.clusters.find((c) => c.verifyNature)
    assert.ok(verify, 'the one-shot verification family is detected')
    assert.equal(verify.target.toCreate, true, 'its target is the workspace verify set, minted on apply')
    assert.equal(verify.target.title, verifyTopicSetTitle(ws))
    assert.equal(verify.sources.length, 2, 'every set of the cluster is archived into it')
    assert.equal(plan.emptySets.map((s) => s.topicSetId).includes('ts-empty'), true, 'a 0-member 0-record set is an empty-archive candidate')
    assert.equal(plan.orphans.map((s) => s.topicSetId).includes('ts-orphan'), true, 'a 0-member set with records is flagged, untouched')
    const border = plan.borderline.find((b) => b.topicSetId === 'ts-border-a')
    assert.ok(border && border.partnerId === 'ts-border-b' && border.score < TOPIC_MERGE_THRESHOLD, 'a sub-threshold pair is reported as borderline only')
    assert.equal(plan.clusters.some((c) => c.sources.some((s) => s.topicSetId === 'ts-lonely')), false,
      'a set sharing only the word 验证 is never merged')
    ok('M8 合并计划：连通簇 + 主集规则 + 验证集目标 + 边界/空集/孤儿分类')
  }

  // M9: apply — 6 处 FK 全搬迁、成员去重、源集 archived 可查、标题重算
  {
    const store = fixture()
    const plan = planTopicSetMerges(store)
    await applyPlanToStore(store, plan)
    // dispatches / episodes / requirements / questions / routing moved
    assert.equal(store.dispatches.get('d-git-c').topicSetId, 'ts-git-a', 'dispatches.topicSetId moved')
    assert.equal(store.episodes.get('e-git-c').topicSetId, 'ts-git-a', 'episodes.topicSetId moved')
    assert.equal(store.episodes.get('e-dev-y').topicSetId, 'ts-dev-x', 'episodes of the dev source moved')
    assert.equal(store.requirements.get('r-dev-y').topicSetId, 'ts-dev-x', 'requirements.topicSetId moved')
    assert.equal(store.questions.get('q-dev-y').topicSetId, 'ts-dev-x', 'questions.topicSetId moved')
    assert.equal(store.routing.get('hub-1').activeTopicSetId, 'ts-dev-x', 'routing.activeTopicSetId moved (hub-1)')
    assert.equal(store.routing.get('hub-2').activeTopicSetId, 'ts-git-a', 'routing.activeTopicSetId moved (hub-2)')
    // sources archived but still readable (never deleted)
    assert.equal(store.topicsets.get('ts-git-c').status, 'archived', 'the source is archived, not deleted')
    assert.ok(store.topicsets.get('ts-git-c').title.length > 0, 'the archived row is still queryable')
    assert.equal(store.topicsets.get('ts-dev-y').status, 'archived')
    // members: one row per sessionId, kind conflict resolves to root
    const target = store.topicsets.get('ts-git-a')
    assert.equal(target.members.length, 1, 'the duplicated session collapses to one row')
    assert.equal(target.members[0].kind, 'root', 'a kind conflict resolves to root')
    assert.ok(target.members[0].title.includes('同步并提交 SuperMemory 仓库的 Git'), 'the member title was recomputed')
    // the verify set was minted and owns the C members
    const minted = [...store.topicsets.entries()].filter(([id]) => id.startsWith('ts-')).map(([id, r]) => r).find((r) => r.title === verifyTopicSetTitle(ws))
    assert.ok(minted, 'the verify set was created')
    assert.equal(store.topicsets.get('ts-c1').status, 'archived')
    assert.equal(store.topicsets.get('ts-c2').status, 'archived')
    assert.equal(minted.members.length, 1, 'the C member moved into the verify set')
    // empty set archived; orphan untouched
    assert.equal(store.topicsets.get('ts-empty').status, 'archived', 'the empty set is archived')
    assert.equal(store.topicsets.get('ts-orphan').status, 'active', 'the orphan set is left alone')
    assert.equal(store.dispatches.get('d-orphan').topicSetId, 'ts-orphan', 'the orphan keeps its records')
    // questions never dangle: the workspace filter still sees them
    const own = topicSetIdsOf(store, ws)
    assert.equal(own.has(store.questions.get('q-dev-y').topicSetId), true, 'a moved question stays inside the workspace scope')
    // marker written
    const marker = store.meta.get('merges')
    assert.equal(marker.mergesVersion, 1)
    assert.ok(marker.mergeSignatures.length >= 3, 'executed cluster signatures are recorded')
    ok('M9 合并执行：6 处 FK 搬迁 + 成员去重(root 优先) + 源集 archived 可查 + 验证集新建 + 空集归档 + 孤儿不动')
  }

  // M10: marker idempotency — 已执行簇签名不再出现；手工重新激活的源集被重新收敛
  {
    const store = fixture()
    const plan = planTopicSetMerges(store)
    await store.meta.put('merges', { mergesVersion: 1, mergeSignatures: plan.clusters.map((c) => c.signature), lastMergeAt: now })
    const skipped = planTopicSetMerges(store)
    assert.equal(skipped.clusters.length, 0, 'an executed cluster signature is never re-proposed')
    assert.equal(skipped.executedSignatures.length, 3, 'the executed signatures are reported')
    assert.equal(skipped.emptySets.map((s) => s.topicSetId).includes('ts-empty'), true, 'non-cluster proposals are unaffected by the marker')
    // a hand-reactivated source is re-proposed into the SAME target (recovery)
    const store2 = fixture()
    await applyPlanToStore(store2, planTopicSetMerges(store2))
    assert.equal(planTopicSetMerges(store2).clusters.length, 0, 'after apply a re-plan finds no cluster (sources archived)')
    await store2.topicsets.update('ts-git-c', (r) => ({ ...r, status: 'active' }))
    const revived = planTopicSetMerges(store2)
    const git = revived.clusters.find((c) => c.target.topicSetId === 'ts-git-a')
    assert.ok(git && git.sources.length === 1 && git.sources[0].topicSetId === 'ts-git-c',
      'a reactivated source is re-proposed into its former target (recovery, not duplication)')
    await applyPlanToStore(store2, revived)
    assert.equal(store2.topicsets.get('ts-git-c').status, 'archived', 're-apply re-archives it — the end state is idempotent')
    assert.equal(planTopicSetMerges(store2).clusters.length, 0)
    ok('M10 幂等：marker 记录已执行簇签名；源集被手工激活时按恢复语义重新收敛，终态仍幂等')
  }

  // M11: mergeTopicSets — dry-run 不写库；apply 才写库并回报
  {
    const store = fixture()
    const ctx = { agents: { get: () => undefined }, sessions: { get: () => ({ seq: 0, append: () => {} }) }, get: () => undefined }
    const deps = { ctx, store, logger }
    const dry = await mergeTopicSets(deps, { dryRun: true })
    assert.equal(dry.status, 'planned')
    assert.equal(store.topicsets.get('ts-git-c').status, 'active', 'dry-run must not write the store')
    assert.equal(store.meta.size, 0, 'dry-run writes no marker')
    assert.ok(renderMergeReport(dry).includes('预演') && renderMergeReport(dry).includes('主集'))
    const applied = await mergeTopicSets(deps, { dryRun: false })
    assert.equal(applied.status, 'applied')
    assert.equal(applied.applied.archived > 0, true)
    assert.equal(store.topicsets.get('ts-git-c').status, 'archived', 'apply writes the store')
    const again = await mergeTopicSets(deps, { dryRun: false })
    assert.equal(again.status, 'nothing-to-do', 'a second apply has nothing left to do')
    ok('M11 /memory merge 契约：默认 dry-run 不写库；apply 显式写库；二次 apply 无事可做')
  }

  // 单「已有主集」簇 + 验证类簇的夹具（对应当前存量：簇 2 已批准改名、簇 1 新建验证集）
  const renameFixture = () => fakeStore({
    topicsets: [
      ['ts-git-a', row({ title: '同步并提交 SuperMemory 仓库的 Git', members: [member('b-git', '旧标题甲')], keywords: ['git'], createdAt: now - 3000 })],
      ['ts-git-b', row({ title: '同步并提交 SuperMemory 仓库的 Git 改动', members: [member('b-git', '旧标题甲', 'root')], createdAt: now - 2000 })],
      ['ts-git-c', row({ title: '同步并提交 SuperMemory 仓库', createdAt: now - 1000 })],
      ['ts-c1', row({ title: '派发复测任务：请直接回复', summary: '这是 P1 派发链路的复测', members: [member('b-c1', '验证旧标题')], createdAt: now - 350 })],
      ['ts-c2', row({ title: '最终链路验证：请直接回复', summary: 'P1 最终链路验证', createdAt: now - 340 })],
    ],
    dispatches: [
      ['d-git-a', dsp('ts-git-a', 'b-git', '同步并提交 SuperMemory 仓库的 Git 改动并推送')],
      ['d-git-b', dsp('ts-git-b', 'b-git', '同步并提交 SuperMemory 仓库的 Git 改动并推送')],
      ['d-git-c', dsp('ts-git-c', 'b-other', '同步并提交 SuperMemory 仓库')],
      ['d-c1', dsp('ts-c1', 'b-c1', '派发复测任务：请直接回复一行')],
    ],
    episodes: [
      ['e-git-c', { topicSetId: 'ts-git-c', branchSessionId: 'b-other', timeStart: now, timeEnd: now, summary: 'C 的归档', result: '', decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'b-other', sourceSeqStart: 0, sourceSeqEnd: 1 }],
    ],
    routing: [['hub-2', { activeTopicSetId: 'ts-git-c', driftCount: 0, updatedAt: now }]],
    meta: [],
  })

  // M12: --rename 干跑——目标标题与成员标题全部按新标题计算，聚类不受影响
  {
    const NEW = 'SuperMemory 仓库与插件维护'
    const plan = planTopicSetMerges(renameFixture(), { rename: NEW })
    const git = plan.clusters.find((c) => c.target.topicSetId === 'ts-git-a')
    assert.ok(git, 'fixture still clusters')
    assert.equal(git.target.title, NEW, 'the existing target is relabeled')
    assert.equal(git.target.renameFrom, '同步并提交 SuperMemory 仓库的 Git')
    assert.ok(git.memberChanges.length > 0 && git.memberChanges.every((c) => c.to.startsWith(NEW)), 'every member title carries the NEW prefix')
    const report = renderMergeReport({ ...plan, status: 'planned', applied: { clusters: 0, archived: 0, created: 0, moved: { dispatches: 0, episodes: 0, requirements: 0, questions: 0, routing: 0 }, hostRenamed: 0, hostSkipped: 0 } })
    assert.ok(report.includes('目标集改名') && report.includes(NEW), 'the report shows the rename')
    const plain = planTopicSetMerges(renameFixture())
    assert.equal(plain.clusters.find((c) => c.target.topicSetId === 'ts-git-a').target.title, '同步并提交 SuperMemory 仓库的 Git', 'clustering still uses the current titles')
    ok('M12 --rename 干跑：目标标题 + 成员标题按新标题计算；聚类按原标题进行')
  }

  // M13: --rename apply——合并→改名→成员重算同一 plan，无旧前缀残留，marker 仍幂等
  {
    const NEW = 'SuperMemory 仓库与插件维护'
    const store = renameFixture()
    const planned = planTopicSetMerges(store, { rename: NEW })
    const gitPlanned = planned.clusters.find((c) => c.target.topicSetId === 'ts-git-a')
    await applyPlanToStore(store, planned)
    const target = store.topicsets.get('ts-git-a')
    assert.equal(target.title, NEW, 'the target is renamed')
    assert.equal(target.members.length, gitPlanned.membersAfter)
    for (const change of gitPlanned.memberChanges) {
      const row = target.members.find((m) => m.sessionId === change.sessionId)
      assert.ok(row, 'member ' + change.sessionId + ' exists')
      assert.equal(row.title, change.to, 'the stored title equals the planned one')
    }
    assert.ok(target.members.every((m) => m.title.startsWith(NEW)), 'no member keeps the old target prefix')
    assert.ok(target.members.some((m) => m.sessionId === 'b-git'), 'the target own member is kept')
    assert.equal(store.topicsets.get('ts-git-c').status, 'archived')
    assert.equal(store.dispatches.get('d-git-c').topicSetId, 'ts-git-a', 'FK 搬迁不受改名影响')
    assert.equal(store.meta.get('merges').mergeSignatures.includes(gitPlanned.signature), true, 'marker 幂等（签名用 id 不用标题）')
    assert.equal(planTopicSetMerges(store).clusters.length, 0, 'a re-plan finds nothing (sources archived)')
    ok('M13 --rename apply：同一 plan 完成合并+改名+成员重算；无旧前缀；marker 幂等')
  }

  // M14: 多个「已有主集」簇 + --rename → 明确报错；不带 rename 不受影响
  {
    const store = fakeStore({
      topicsets: [
        ['ts-x1', row({ title: '同步并提交 SuperMemory 仓库的 Git', members: [member('bx1', '甲')], createdAt: now - 3000 })],
        ['ts-x2', row({ title: '同步并提交 SuperMemory 仓库的 Git 改动', createdAt: now - 2000 })],
        ['ts-y1', row({ title: '修复 SuperMemory 插件三个 GUI 问题', members: [member('by1', '乙')], createdAt: now - 1000 })],
        ['ts-y2', row({ title: '修复 SuperMemory 插件 GUI 问题', createdAt: now - 900 })],
      ],
    })
    assert.throws(() => planTopicSetMerges(store, { rename: '合并集' }), /不明确/, 'two existing-target clusters make --rename ambiguous')
    assert.equal(planTopicSetMerges(store).clusters.length, 2, 'without --rename both clusters are planned')
    ok('M14 多已有主集簇 + --rename：明确报错并提示分批/管理台；不带 rename 不受影响')
  }

  // M15: 命令层契约——mergeTopicSets 带 rename 的 dry-run/apply
  {
    const NEW = 'SuperMemory 仓库与插件维护'
    const store = renameFixture()
    const ctx = { agents: { get: () => undefined }, sessions: { get: () => ({ seq: 0, append: () => {} }) }, get: () => undefined }
    const deps2 = { ctx, store, logger }
    const dry = await mergeTopicSets(deps2, { dryRun: true, rename: NEW })
    assert.equal(dry.status, 'planned')
    assert.equal(store.topicsets.get('ts-git-a').title, '同步并提交 SuperMemory 仓库的 Git', 'dry-run 不写库')
    const applied = await mergeTopicSets(deps2, { dryRun: false, rename: NEW })
    assert.equal(applied.status, 'applied')
    assert.equal(store.topicsets.get('ts-git-a').title, NEW, 'apply 落新标题')
    assert.equal(applied.applied.hostRenamed > 0, true, '宿主侧改名同样走新标题')
    ok('M15 命令层契约：--rename 干跑不写库、apply 写库且宿主改名用新标题')
  }
}


// ---- R25: dispatch/resume inputs are human-form (kind 'user') so a reused branch sorts up ----
{
  const { isDispatchInput } = await import('../src/observe.ts')
  const msg = (source) => ({ id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source })
  assert.equal(isDispatchInput(msg({ kind: 'user' })), true,
    'a plain user prompt inside a dispatch window is the dispatch input')
  assert.equal(isDispatchInput(msg({ kind: 'supermemory', form: 'recall' })), false, 'recall cards are context')
  assert.equal(isDispatchInput(msg({ kind: 'supermemory', form: 'notice' })), false, 'notice cards are context')
  assert.equal(isDispatchInput(msg({ kind: 'supermemory', form: 'relay' })), false, 'relay cards are context')
  assert.equal(isDispatchInput(msg({ kind: 'agent' })), false, 'a non-user kind is never our input')
  const { readFileSync } = await import('node:fs')
  const observeSrc = readFileSync('src/observe.ts', 'utf8')
  assert.ok(observeSrc.includes('relaySource({'),
    'relay cards stay supermemory-kind through the shared card source builder')
  const dispatchSrc = readFileSync('src/dispatch.ts', 'utf8')
  assert.ok(dispatchSrc.includes('dispatchSource({'),
    'the dispatch wake message lands as a human-form user message carrying the R32 card marker')
  const panelSrc = readFileSync('src/panel.ts', 'utf8')
  assert.equal((panelSrc.match(/source: \{ kind: 'supermemory' \}/g) || []).length, 0,
    'no human-initiated panel delivery is left on the private kind')
  ok('R25-1 归属形态：派发/续跑/面板输入 kind=user；recall/notice/relay 卡仍是 supermemory 上下文')
}

{
  // Drive the REAL dispatch wake and read the message source it hands the branch.
  const { runDispatch } = await import('../src/dispatch.ts')
  const cwd = process.cwd()
  const store = {
    topicsets: table([['ts-r25', {
      workspaceKey: cwd, title: '置顶形态验证', summary: '', keywords: [], status: 'active', members: [],
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
  const seen = []
  const result = await runDispatch(
    { ctx, store, logger, createMessage: (input) => { seen.push(input); return input } },
    { topicSetId: 'ts-r25', task: 'R25 置顶形态验证任务' },
    { agent: { id: 'hub-r25', session: { header: { cwd } } } },
  )
  assert.equal(result.status, 'dispatched')
  assert.equal(seen.length, 1, 'the branch is woken once')
  assert.equal(seen[0].source.kind, 'user',
    'the dispatch input records as user → lastPromptAt advances → the branch sorts to the top')
  // R32 需求③: the form marker is additive — recency still keys off kind 'user'.
  assert.equal(seen[0].source.form, 'supermemory-dispatch', 'R32 card marker on the dispatch input')
  assert.equal(seen[0].source.fromSessionId, 'hub-r25', 'card source id is the dispatching hub session')
  ok('R25-2 派发输入实测：runDispatch 交给分支的消息 source.kind=user（R32 卡片标记，recency 不变）')
}

// ---- R7: 重启后分支会话恢复（branch-restore：从持久台账重建分支注册表）----
// 插件重启后 branchHandles 从空开始，而启动路径里只有 reconcile 会 resume 分支
// （且只针对 queued/dispatched 且无执行痕迹的行）。R7 锁定新的启动恢复路径：
// 收集器只汇总真正的分支会话；恢复只 attach 绝不 dispose/投递；失败不丢台账。
const { collectBranchRestoreTargets, restoreBranchSessions, renderBranchRestoreSummary } = await import('../src/branch-restore.ts')

{
  // R7-1: 收集器汇总成员 + 派发台账里的分支会话；话题集 root 成员（session-*
  // 中枢会话）与非插件 id 的派发行都不是分支；成员事实优先；按活动倒序。
  const stale = now - 3600000
  const store = fakeStore({
    topicsets: [
      ['ts-r7a', {
        workspaceKey: 'ws', title: '话题甲', summary: '', keywords: [], status: 'active',
        members: [
          { sessionId: 'branch-r7a', kind: 'root', title: '分支甲', summary: '', status: 'live', lastActiveAt: now - 1000 },
          { sessionId: 'session-r7hub', kind: 'root', title: '中枢', summary: '', status: 'live', lastActiveAt: now },
        ],
        createdAt: stale, updatedAt: stale, lastActiveAt: stale,
      }],
      ['ts-r7b', {
        workspaceKey: 'ws', title: '话题乙', summary: '', keywords: [], status: 'active',
        members: [
          { sessionId: 'fork-r7b', kind: 'fork', title: '', summary: '', status: 'live', lastActiveAt: now - 5000 },
        ],
        createdAt: stale, updatedAt: stale, lastActiveAt: stale,
      }],
    ],
    dispatches: [
      ['dsp-r7a', { topicSetId: 'ts-r7a', branchSessionId: 'branch-r7a', task: '任务甲', hubSessionId: 'hub-1', startSeq: 0, status: 'delivered', createdAt: stale, updatedAt: now - 1000 }],
      ['dsp-r7b', { topicSetId: 'ts-r7b', branchSessionId: 'fork-r7b', task: '任务乙（续）', hubSessionId: 'hub-2', startSeq: 0, status: 'interrupted', createdAt: stale, updatedAt: now - 5000 }],
      ['dsp-r7c', { topicSetId: 'ts-r7b', branchSessionId: 'session-r7hub', task: '派到中枢', hubSessionId: 'hub-2', startSeq: 0, status: 'delivered', createdAt: stale, updatedAt: now - 50 }],
    ],
  })
  const targets = collectBranchRestoreTargets(store)
  assert.deepEqual(targets.map((t) => t.sessionId), ['branch-r7a', 'fork-r7b'],
    'branch members + plugin-minted dispatch rows are collected; a hub root member is not a branch')
  assert.equal(targets[0].memberTitle, '分支甲', 'member facts win over dispatch-only facts')
  assert.equal(targets[0].task, '任务甲', 'the dispatch task rides along')
  assert.equal(targets[0].topicSetId, 'ts-r7a')
  assert.equal(targets[1].task, '任务乙（续）', 'a fork member inherits its dispatch task')
  assert.equal(targets[1].topicTitle, '话题乙')
  assert.deepEqual(collectBranchRestoreTargets(undefined), [], 'no store yields no targets')
  ok('R7-1 收集器：成员 + 派发台账汇总分支会话（root 成员/非插件 id 排除，成员事实优先）')
}

{
  // R7-2: 恢复路径——已 live 的直接采用；死掉的经 agents.resume 重连并登记
  // branchHandles；绝不 dispose、绝不投递；成员状态刷新为 live。
  const stale = now - 3600000
  const store = fakeStore({
    topicsets: [['ts-r7c', {
      workspaceKey: 'ws', title: '话题丙', summary: '', keywords: [], status: 'active',
      members: [
        { sessionId: 'branch-r7live', kind: 'root', title: '在线分支', summary: '', status: 'idle', lastActiveAt: now - 60000 },
        { sessionId: 'branch-r7dead', kind: 'root', title: '', summary: '', status: 'idle', lastActiveAt: now - 60000 },
      ],
      createdAt: stale, updatedAt: stale, lastActiveAt: stale,
    }]],
    dispatches: [
      ['dsp-r7live', { topicSetId: 'ts-r7c', branchSessionId: 'branch-r7live', task: '任务丙', hubSessionId: 'hub', startSeq: 0, status: 'delivered', createdAt: stale, updatedAt: stale }],
      ['dsp-r7dead', { topicSetId: 'ts-r7c', branchSessionId: 'branch-r7dead', task: '任务丁', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: stale, updatedAt: stale }],
    ],
  })
  const liveAgent = { id: 'branch-r7live', followup: () => { throw new Error('restore must not wake a branch') } }
  const resumed = []
  const disposed = []
  const ctx = {
    get: (key) => (key === 'agents' ? {
      get: (id) => (id === 'branch-r7live' ? liveAgent : undefined),
      resume: async (options) => {
        resumed.push(options.resumeSessionId)
        return { agent: { id: options.resumeSessionId }, dispose: async () => { disposed.push(options.resumeSessionId) } }
      },
    } : undefined),
    sessions: { get: () => undefined },
  }
  const outcome = await restoreBranchSessions({ ctx, store, logger })
  assert.deepEqual(resumed, ['branch-r7dead'], 'only the dead branch is resumed')
  assert.deepEqual(outcome.live, ['branch-r7live'], 'a live branch is adopted as-is')
  assert.deepEqual(outcome.resumed, ['branch-r7dead'])
  assert.equal(branchHandles.has('branch-r7dead'), true, 'the reconnected handle is registered again')
  assert.deepEqual(disposed, [], 'restore never disposes a session (只 attach)')
  assert.equal(store.topicsets.get('ts-r7c').members.find((m) => m.sessionId === 'branch-r7dead').status, 'live',
    'the restored member is marked live')
  assert.equal(store.topicsets.get('ts-r7c').members.find((m) => m.sessionId === 'branch-r7live').status, 'live',
    'the adopted live member stays live')
  assert.ok(store.topicsets.get('ts-r7c').members.find((m) => m.sessionId === 'branch-r7dead').title.length > 0,
    'an unnamed member is titled from the ledger on restore')
  assert.ok(renderBranchRestoreSummary(outcome).includes('resumed 1'), 'the summary names the resumed count')
  branchHandles.delete('branch-r7dead')
  ok('R7-2 恢复路径：live 采用 / 死分支 agents.resume 重连并登记 handle（不 dispose 不投递）')
}

{
  // R7-3: 恢复失败不丢会话——resume 抛错记 failed、成员标记 idle（live 计数
  // 如实），台账原样保留（memory_resume/面板后续仍可续接）。
  const stale = now - 3600000
  const store = fakeStore({
    topicsets: [['ts-r7d', {
      workspaceKey: 'ws', title: '话题丁', summary: '', keywords: [], status: 'active',
      members: [
        { sessionId: 'branch-r7gone', kind: 'root', title: '丢失分支', summary: '', status: 'live', lastActiveAt: now - 60000 },
      ],
      createdAt: stale, updatedAt: stale, lastActiveAt: stale,
    }]],
    dispatches: [
      ['dsp-r7gone', { topicSetId: 'ts-r7d', branchSessionId: 'branch-r7gone', task: '任务戊', hubSessionId: 'hub', startSeq: 0, status: 'interrupted', createdAt: stale, updatedAt: stale }],
    ],
  })
  const ctx = {
    get: (key) => (key === 'agents' ? {
      get: () => undefined,
      resume: async () => { throw new Error('session log gone') },
    } : undefined),
  }
  const outcome = await restoreBranchSessions({ ctx, store, logger })
  assert.deepEqual(outcome.resumed, [], 'an unrecoverable branch is not resumed')
  assert.equal(outcome.failed.length, 1)
  assert.equal(outcome.failed[0].sessionId, 'branch-r7gone')
  assert.equal(store.topicsets.get('ts-r7d').members[0].status, 'idle',
    'an unrecoverable branch is marked idle so the live count stays truthful')
  assert.equal(store.dispatches.get('dsp-r7gone').status, 'interrupted',
    'the ledger row is untouched — memory_resume can still continue it later')
  ok('R7-3 恢复失败不丢会话：failed 记录 + 成员 idle + 台账原样（后续可续跑）')
}

{
  // R7-4: 宿主没有 agents 缝隙（minimal profile）时全部跳过，不炸不抛。
  const stale = now - 3600000
  const store = fakeStore({
    topicsets: [['ts-r7e', {
      workspaceKey: 'ws', title: '话题戊', summary: '', keywords: [], status: 'active',
      members: [
        { sessionId: 'branch-r7e', kind: 'root', title: '分支戊', summary: '', status: 'live', lastActiveAt: now - 60000 },
      ],
      createdAt: stale, updatedAt: stale, lastActiveAt: stale,
    }]],
    dispatches: [
      ['dsp-r7e', { topicSetId: 'ts-r7e', branchSessionId: 'branch-r7e', task: '任务己', hubSessionId: 'hub', startSeq: 0, status: 'delivered', createdAt: stale, updatedAt: stale }],
    ],
  })
  const outcome = await restoreBranchSessions({ ctx: { get: () => undefined }, store, logger })
  assert.deepEqual(outcome.resumed, [])
  assert.deepEqual(outcome.failed, [])
  assert.deepEqual(outcome.skipped, ['branch-r7e'], 'without the agents seam every target is skipped, not failed')
  ok('R7-4 无 agents 缝隙：全部跳过（台账仍可在面板/管理台枚举）')
}

{
  // R22 需求④⑤: 记忆集合 + 条目。这里守两件事：
  //  (a) 工具契约——模型只看得到 parameters/description，模型写 collection、
  //      读 collectionTitle 的前提是声明存在；
  //  (b) 数据模型——集合表声明在 store/domain 里、条目的 collectionId 是**可选**字段
  //      （旧扁平记忆与 panel/webui/maintenance 的写路径不能被破坏）。
  const toolsSource = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const rememberStart = toolsSource.indexOf("name: 'memory_remember'")
  assert.ok(rememberStart > 0, 'memory_remember 定义存在')
  const rememberOutput = toolsSource.indexOf('output:', rememberStart)
  const rememberDecl = toolsSource.slice(rememberStart, rememberOutput)
  assert.match(rememberDecl, /记忆集合/, 'remember 描述说明集合层')
  assert.match(rememberDecl, /collection:\s*\{\s*type: 'string'/, 'parameters 声明 collection（集合标题）')
  assert.match(rememberDecl, /collectionId:\s*\{\s*type: 'string'/, 'parameters 声明 collectionId')
  const rememberOutDecl = toolsSource.slice(rememberOutput, toolsSource.indexOf("name: 'memory_recall'", rememberOutput))
  assert.match(rememberOutDecl, /collectionTitle:\s*\{\s*type: 'string'/, 'output 回执带 collectionTitle')
  assert.match(rememberOutDecl, /collectionTier:/, 'output 回执带复用档位')
  // R27 需求④.2/④.3: 一条写入可拆成多条原子记忆；集合归属可由模型判定。
  assert.match(rememberDecl, /大模型在候选集合中判定/, 'remember 描述说明模型判定集合归属')
  assert.match(rememberDecl, /整形为多条原子记忆/, 'remember 描述说明原子拆分')
  assert.match(rememberOutDecl, /split:\s*\{\s*type: 'integer'/, 'output 回执带拆分数')
  assert.match(rememberOutDecl, /entries:\s*\{\s*type: 'array'/, 'output 回执带逐条 entries')
  assert.match(rememberOutDecl, /'llm'/, 'collectionTier 枚举含 llm（模型判定档位）')
  const recallStart = toolsSource.indexOf("name: 'memory_recall'")
  const recallOutput = toolsSource.indexOf('output:', recallStart)
  const recallDecl = toolsSource.slice(recallStart, recallOutput)
  assert.match(recallDecl, /两级检索/, 'recall 描述说明两级检索')
  const recallOutDecl = toolsSource.slice(recallOutput, recallOutput + 4000)
  assert.match(recallOutDecl, /collections:\s*\{\s*type: 'array'/, 'recall output 声明 collections')
  assert.match(recallOutDecl, /collectionTitle:/, 'recall item 带集合标题')

  const schemaSource = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8')
  assert.match(schemaSource, /memory_collections: sd\.domainTable|memory_collections: memoryCollections/, 'schema 返回 memory_collections 表')
  assert.match(schemaSource, /collectionId: z\.string\(\)\.optional\(\)/, '条目的 collectionId 是可选字段（旧记录/其他写路径兼容）')
  const storeSource = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
  assert.match(storeSource, /memoryCollections: Table<MemoryCollection>/, 'store 暴露 memoryCollections 访问器')
  assert.match(storeSource, /memory_collections: sd\.domainTable/, 'domain 注册记忆集合表')
  ok('R22-7 记忆集合契约：remember/recall 参数与输出声明 + 集合表注册 + collectionId 可选兼容')
}

{
  // R22 需求⑤（写入侧回归）：连续两条同主题结论只应有一个集合——第二条复用第一条
  // 建出来的集合，而不是每写一条就新开一个。
  const { resolveCollectionForEntry, listCollections, migrateFlatMemories } = await import('../src/memory-collections.ts')
  const WS = 'ws'
  const collectionsTable = table()
  const memoriesTable = table()
  const store = { memories: memoriesTable, memoryCollections: collectionsTable }
  const first = await resolveCollectionForEntry(store, WS,
    { title: 'git 同步 约定', keywords: ['git', '同步', '推送'], text: '用 pnpm git:sync' }, { now })
  assert.ok(!('error' in first) && first.created, '第一条结论新建集合')
  const second = await resolveCollectionForEntry(store, WS,
    { title: 'git 同步 的凭据', keywords: ['git', '同步', '凭据'], text: '先清 helper 再用 store' }, { now })
  assert.ok(!('error' in second))
  assert.equal(second.created, false, '第二条复用已有集合（需求⑤）')
  assert.equal(second.collectionId, first.collectionId, '两条结论落在同一集合')
  assert.equal(listCollections(store, WS).length, 1, '同主题连续写入不新开集合')

  // 迁移后写入：旧条目被迁移进集合，新条目命中该集合而不是另开。
  await memoriesTable.put('legacy', {
    workspaceKey: WS, title: 'git 推送 要清 helper', text: '旧结论：推送前清 helper', keywords: ['git', '推送'],
    sourceSessionId: 's', sourceSeq: 1, status: 'active', createdAt: now, updatedAt: now,
  })
  const migrated = await migrateFlatMemories(store, WS, now)
  assert.equal(migrated.entries, 1, '旧条目被迁入集合')
  const third = await resolveCollectionForEntry(store, WS,
    { title: 'git 推送 的凭据顺序', keywords: ['git', '推送', 'helper'], text: '先清 helper' }, { now })
  assert.ok(!('error' in third))
  assert.equal(third.created, false, '迁移后的旧集合也能被新结论复用')
  assert.equal(third.collectionId, memoriesTable.get('legacy').collectionId, '新结论进旧条目所在集合')
  ok('R22-8 集合复用回归：同主题连续写入 + 迁移后的旧集合都可复用（不新开集合）')
}

{
  // R29 需求①: 「新会话」 must not be a dead click. The client entry creates the
  // hub session and hands the receipt to the panel through this signal module.
  // The panel is often NOT mounted when the host call resolves (selectPanel
  // mounts it a beat later), so the pending slot is the contract that makes the
  // receipt survive that race — and it must be drained exactly once.
  const { publishHubReceipt, subscribeHubReceipt, takePendingHubReceipt } =
    await import('../src/client/open-dispatch.ts')
  assert.equal(takePendingHubReceipt(), undefined, 'nothing pending before the first receipt')
  publishHubReceipt({ id: 'session-a', message: '已创建中枢会话。', kind: 'hub' })
  assert.deepEqual(takePendingHubReceipt(), { id: 'session-a', message: '已创建中枢会话。', kind: 'hub' },
    'a receipt published with no listener is kept for the next panel mount')
  assert.equal(takePendingHubReceipt(), undefined, 'the pending receipt is drained exactly once')

  const seen = []
  const unsubscribe = subscribeHubReceipt((receipt) => seen.push(receipt))
  publishHubReceipt({ id: 'session-b', message: '已创建中枢会话。', kind: 'hub' })
  unsubscribe()
  publishHubReceipt({ id: 'session-c', message: '已创建中枢会话。', kind: 'hub' })
  assert.deepEqual(seen.map((row) => row.id), ['session-b'], 'a live listener sees publishes, an unsubscribed one does not')
  assert.deepEqual(takePendingHubReceipt(), { id: 'session-c', message: '已创建中枢会话。', kind: 'hub' },
    'after the last listener unsubscribes a receipt is kept pending again')
  ok('R29-1 新会话回执信号：无监听时留待下次挂载、只消费一次、退订后回到 pending')
}

console.log(String.fromCharCode(10) + passed + ' checks passed')

process.exit(0)
