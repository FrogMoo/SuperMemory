/**
 * workspace-scope-smoke — A 部分（工作区隔离）的源级单测（host-free）：
 *   W1 话题集/会话列表按工作区过滤（listTopicSets / hubState 计数 / listWorkspaceBranches）；
 *   W2 跨工作区能力不暴露（capabilityRecordsOf / 面板 listTools / capabilityHealthOf）；
 *   W3 能力执行门禁（跨工作区调用拒绝执行且不计数；本工作区正常执行；无上下文放行）；
 *   W4 register 同名能力按工作区归属分流（别的工作区的行不被误更新）；
 *   W5 重启重建带行级归属（rebuild 后跨工作区门禁依然生效，内置播种落 scope 工作区）；
 *   W6 适用性判定纯函数语义（行级归属优先 / 全局能力 / 无上下文放行）。
 * 注意：.mjs 自身不做 TS 类型擦除（本脚本保持纯 JS），但 src/panel.ts 用了
 * TypeScript 参数属性，strip-only 模式会拒绝——整体重放一次带 transform 的节点。
 * Usage: node scripts/workspace-scope-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

const {
  capabilityAppliesToWorkspace, capabilityHealthOf, capabilityRecordsOf, capabilityToolDef,
  mergeBuiltinCapabilities, persistComposite, rebuildComposites, registerCapability,
} = await import('../src/composite.ts')
const { listTopicSets } = await import('../src/topicsets.ts')
const { listWorkspaceBranches } = await import('../src/hub-branches.ts')
const { SupermemoryPanelService } = await import('../src/panel.ts')
const { workspaceKeyOf } = await import('../src/store.ts')
const { BUILTIN_CAPABILITIES } = await import('../src/builtin-capabilities.ts')

function table(seed = []) {
  const map = new Map(seed)
  return {
    get: (k) => map.get(k),
    keys: () => map.keys(),
    values: () => map.values(),
    get size() { return map.size },
    entries: () => map.entries(),
    put: async (k, v) => { map.set(k, v) },
    update: async (k, fn) => { map.set(k, fn(map.get(k))) },
    delete: async (k) => map.delete(k),
  }
}
const fakeStore = (seed = {}) => ({
  memories: table(seed.memories ?? []),
  toolMemory: table(seed.toolMemory ?? []),
  signals: table(seed.signals ?? []),
  topicsets: table(seed.topicsets ?? []),
  dispatches: table(seed.dispatches ?? []),
  episodes: table(seed.episodes ?? []),
  requirements: table(seed.requirements ?? []),
  filemap: table(seed.filemap ?? []),
  routing: table(seed.routing ?? []),
  hotcache: table(seed.hotcache ?? []),
  outbox: table(seed.outbox ?? []),
  questions: table(seed.questions ?? []),
  meta: table(seed.meta ?? []),
})
const now = Date.now()
// 两个工作区：A 用真实仓库路径（workspaceKeyOf 走 realpath），B 用虚构路径
// （workspaceKeyOf 对不存在的目录退化为 resolve，键值稳定可断言）。
// A 必须取自本仓库：W3 会真的在这个 cwd 里 spawn（硬编码旧克隆路径 G:\09 - dsh\
// SuperMemory 在本机不存在，spawnSync 直接 ENOENT）；用 workspaceKeyOf 归一化还能
// 保证行级归属键与过滤时算出的键严格一致（realpath 幂等）。
const WS_A = workspaceKeyOf(fileURLToPath(new URL('..', import.meta.url)))
const WS_B = 'G:\\scope-smoke-b'
const GIT_TOOL = 'sm_composite_git_sync_supermemory'
const capSpec = (name, scope, extra = {}) => ({
  name, kind: 'capability', description: name + ' 描述', title: name,
  entry: 'echo ' + name, steps: [], parameters: [], runnable: true, dryRunArg: '--dry-run',
  scope, version: 1, ...extra,
})
const capRow = (id, ws, spec, useCount = 0) => ({
  kind: 'composite', workspaceKey: ws, trigger: 'capability/' + spec.name,
  title: spec.title, tags: [], description: spec.description,
  entry: JSON.stringify(spec), useCount, status: 'active',
})
const seqRow = () => ({
  kind: 'composite', trigger: 'ws/ws/seq/read>bash', title: '序列', tags: [], description: '序列',
  entry: JSON.stringify({ name: 'sm_composite_seq_scope', steps: [{ tool: 'read', arguments: {} }], parameters: [] }),
  useCount: 0, status: 'active',
})

let passed = 0
const ok = (label) => { passed += 1; console.log('ok - ' + label) }

// ---- W1 话题集/会话列表按工作区过滤 ----
{
  const store = fakeStore({
    topicsets: [
      ['ts-a', { workspaceKey: WS_A, title: 'A 集', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }],
      ['ts-b', { workspaceKey: WS_B, title: 'B 集', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }],
    ],
    dispatches: [
      ['dsp-b', { topicSetId: 'ts-b', branchSessionId: 'branch-b', task: 'B 的任务', hubSessionId: 'session-b', startSeq: 0, status: 'dispatched', createdAt: now, updatedAt: now }],
    ],
    episodes: [
      ['ep-b', { topicSetId: 'ts-b', branchSessionId: 'branch-b', timeStart: now, timeEnd: now, summary: 's', result: 'r', decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'branch-b', sourceSeqStart: 0, sourceSeqEnd: 1 }],
    ],
  })
  assert.deepEqual(listTopicSets(store, WS_A).map(([id]) => id), ['ts-a'], 'A 工作区只见 A 的话题集')
  assert.deepEqual(listTopicSets(store, WS_B).map(([id]) => id), ['ts-b'], 'B 工作区只见 B 的话题集')
  assert.deepEqual(listWorkspaceBranches(store, WS_A).map((b) => b.branchSessionId), [], 'A 的分支列表不含 B 的分支')
  assert.deepEqual(listWorkspaceBranches(store, WS_B).map((b) => b.branchSessionId), ['branch-b'], 'B 的分支列表含自己的分支')
  const service = new SupermemoryPanelService(store)
  const stateA = service.hubState(WS_A, 'session-a')
  assert.deepEqual(stateA.topicSets.map((t) => t.id), ['ts-a'], '面板 hubState 只返回本工作区话题集')
  assert.equal(stateA.counts.dispatches, 0, '进行中派发计数不含别的工作区')
  assert.equal(stateA.counts.episodes, 0, '归档计数不含别的工作区')
  const stateB = service.hubState(WS_B, 'session-b')
  assert.equal(stateB.counts.dispatches, 1, '本工作区的派发正常计数')
  assert.equal(stateB.counts.episodes, 1, '本工作区的归档正常计数')
  ok('W1 话题集/分支/计数按工作区过滤（listTopicSets / hubState / listWorkspaceBranches）')
}

// ---- W2 跨工作区能力不暴露 ----
{
  const store = fakeStore({
    toolMemory: [
      ['tm-a', capRow('tm-a', WS_A, capSpec('sm_composite_scope_a', WS_A), 2)],
      ['tm-b', capRow('tm-b', WS_B, capSpec('sm_composite_scope_b', WS_B), 0)],
      ['tm-seq', seqRow()],
    ],
  })
  assert.deepEqual(capabilityRecordsOf(store, WS_A).map((c) => c.spec.name), ['sm_composite_scope_a'])
  assert.deepEqual(capabilityRecordsOf(store, WS_B).map((c) => c.spec.name), ['sm_composite_scope_b'])
  assert.equal(capabilityRecordsOf(store).length, 2, '无工作区参数=全量（维护/合并路径用）')
  const service = new SupermemoryPanelService(store)
  const viewsA = service.listTools(WS_A)
  assert.deepEqual(viewsA.filter((v) => v.kind === 'capability').map((v) => v.name), ['sm_composite_scope_a'], '面板能力卡片只列本工作区')
  assert.ok(viewsA.some((v) => v.name === 'sm_composite_seq_scope'), '序列组合工具无归属=全局，任何工作区可见')
  assert.equal(viewsA.find((v) => v.name === 'sm_composite_scope_a').version, 1, '版本透出到面板视图')
  const viewsB = service.listTools(WS_B)
  assert.deepEqual(viewsB.filter((v) => v.kind === 'capability').map((v) => v.name), ['sm_composite_scope_b'], '切到 B 只列 B 的能力')
  assert.deepEqual(capabilityHealthOf(store, WS_A).map((h) => h.name), ['sm_composite_scope_a'], '健康报告同样按工作区过滤')
  ok('W2 跨工作区能力不暴露（capabilityRecordsOf / 面板 listTools / capabilityHealthOf）')
}

// ---- W3 能力执行门禁 ----
{
  const store = fakeStore({
    toolMemory: [
      ['tm-a', capRow('tm-a', WS_A, capSpec('sm_composite_scope_a', WS_A), 2)],
    ],
  })
  const spec = capSpec('sm_composite_scope_a', WS_A)
  const def = capabilityToolDef(store, spec, WS_A)
  const execFor = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } })
  const here = await def.execute({}, execFor(WS_A))
  assert.equal(here.status, 'completed', '本工作区正常执行: ' + here.summary)
  assert.ok(here.stdout.includes('sm_composite_scope_a'))
  assert.equal(store.toolMemory.get('tm-a').useCount, 3, '本工作区执行计数')
  const there = await def.execute({}, execFor(WS_B))
  assert.equal(there.status, 'failed', '跨工作区调用被拒绝')
  assert.ok(there.summary.includes('工作区隔离'), '拒绝原因说清是工作区隔离: ' + there.summary)
  assert.equal(there.stdout, '', '跨工作区拒绝不执行任何命令')
  assert.equal(store.toolMemory.get('tm-a').useCount, 3, '跨工作区拒绝不计数')
  const noCtx = await def.execute({}, { signal: new AbortController().signal })
  assert.equal(noCtx.status, 'completed', '无调用方工作区上下文（测试/headless）不拦截')
  ok('W3 能力执行门禁：跨工作区拒绝执行且不计数；本工作区/无上下文正常')
}

// ---- W4 register 同名能力按工作区归属分流 ----
{
  const store = fakeStore()
  const ctx = { tools: { register: () => () => {}, get: () => undefined } }
  const deps = { register: async () => () => {}, persist: persistComposite, toolExists: () => false }
  const seed = { name: 'shared-cap', description: 'A 的描述', entry: 'echo shared', scope: WS_A }
  const first = await registerCapability(ctx, store, seed, WS_A, deps)
  assert.equal(first.status, 'ok', 'A 首次注册: ' + first.message)
  assert.equal(store.toolMemory.size, 1)
  const other = await registerCapability(ctx, store, { ...seed, description: 'B 的描述', entry: 'echo shared-b', scope: WS_B }, WS_B, deps)
  assert.equal(other.status, 'ok', 'B 同名注册成功')
  assert.equal(store.toolMemory.size, 2, '同名能力在不同工作区各占一行，互不覆盖')
  const rowA = [...store.toolMemory.values()].find((r) => r.workspaceKey === WS_A)
  assert.equal(JSON.parse(rowA.entry).description, 'A 的描述', 'B 的注册不污染 A 的行')
  const again = await registerCapability(ctx, store, { ...seed, description: 'A 更新', changelog: 'A 侧更新' }, WS_A, deps)
  assert.equal(again.status, 'ok')
  assert.equal(store.toolMemory.size, 2, '同工作区同名=原地更新，不建新行')
  const rowA2 = [...store.toolMemory.values()].find((r) => r.workspaceKey === WS_A)
  assert.equal(JSON.parse(rowA2.entry).version, 2, '同工作区更新 version+1')
  assert.equal(JSON.parse(rowA2.entry).description, 'A 更新')
  ok('W4 register 同名能力按工作区分流：跨工作区各占一行，同工作区原地更新')
}

// ---- W5 重启重建带行级归属 + 内置播种落 scope 工作区 ----
{
  const store = fakeStore({
    toolMemory: [
      ['tm-a', capRow('tm-a', WS_A, capSpec('sm_composite_scope_a', WS_A), 2)],
      ['tm-b', capRow('tm-b', WS_B, capSpec('sm_composite_scope_b', WS_B), 0)],
      ['tm-seq', seqRow()],
    ],
  })
  const ctx = { tools: { register: () => () => {}, get: () => undefined } }
  const seen = []
  const count = await rebuildComposites(ctx, store, {
    register: async (_c, _s, spec, workspaceKey) => { seen.push({ name: spec.name, workspaceKey }); return () => {} },
  })
  // 3 条既有行 + 内置能力播种 1 条。
  assert.equal(count, 4, 'rebuild 注册全部活跃行（含播种的内置能力）: ' + count)
  const capA = seen.find((s) => s.name === 'sm_composite_scope_a')
  assert.equal(capA && capA.workspaceKey, WS_A, 'rebuild 把行级工作区归属传给注册')
  const capB = seen.find((s) => s.name === 'sm_composite_scope_b')
  assert.equal(capB && capB.workspaceKey, WS_B)
  // 播种键来自内置定义自己的 scope（composite.ts: `workspaceKeyOf(builtin.scope)`），
  // 不是测试里的 WS_A——scope 是本仓库的绝对路径，换克隆目录即不同，断言必须通过定义推导。
  const builtinDef = BUILTIN_CAPABILITIES.find((c) => c.name === 'git-sync-supermemory')
  assert.ok(builtinDef && builtinDef.scope, '内置能力定义带 scope')
  const builtinRow = [...store.toolMemory.values()].find((r) => r.workspaceKey === workspaceKeyOf(builtinDef.scope) && JSON.parse(r.entry).name === GIT_TOOL)
  assert.ok(builtinRow, '内置能力播种并落到 scope 所属工作区')
  // 重新合并（幂等）：不再播种。
  const again = await mergeBuiltinCapabilities(store)
  assert.deepEqual(again.seeded, [], '二次合并不重复播种')
  ok('W5 重启重建带行级归属；内置播种落 scope 工作区且幂等')
}

// ---- W6 适用性判定纯函数 ----
{
  assert.equal(capabilityAppliesToWorkspace({ scope: WS_A }, WS_A), true)
  assert.equal(capabilityAppliesToWorkspace({ scope: WS_A }, WS_B), false, 'scope 指向别的工作区=不适用')
  assert.equal(capabilityAppliesToWorkspace({ scope: WS_A }, WS_B, WS_A), false)
  assert.equal(capabilityAppliesToWorkspace({ scope: WS_A }, WS_B, WS_B), true, '行级归属优先于 scope')
  assert.equal(capabilityAppliesToWorkspace({}, WS_B), true, '无归属无 scope=全局能力')
  assert.equal(capabilityAppliesToWorkspace({ scope: WS_A }, undefined), true, '无调用方工作区=不判定')
  assert.equal(workspaceKeyOf(WS_B), WS_B, '虚构路径的键值稳定（resolve 退化）')
  ok('W6 适用性判定：行级归属优先 / scope 推导 / 全局能力 / 无上下文放行')
}

console.log(String.fromCharCode(10) + passed + ' checks passed')
process.exit(0)
