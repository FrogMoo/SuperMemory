/**
 * workspace-scope-smoke — R50 统一能力的工作区隔离（A3 语义 + sm_cap_ 执行面）。
 *
 * W1 纯判定：scope/行级归属/全局/子目录包含。
 * W2 列表：capabilityRecordsOf / 面板 listTools / capabilityHealthOf 都只看本工作区。
 * W3 注册：同名能力在两个工作区各自一行，互不覆盖。
 * W4 执行面：跨工作区调用拒绝（不执行、不计数）；本工作区正常执行。
 * W5 重建：rebuildCapabilities 带行级归属注册；内置能力播种落到 scope 工作区。
 * W6 迁移：旧 capability 行（kind=composite + spec.kind=capability）保留归属并改名
 *      sm_cap_*；旧工具序列行退役且不注册。
 *
 * Usage: node scripts/workspace-scope-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { delimiter } from 'node:path'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const stubRoot = new URL('./__fixtures__/stub-node-modules', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
  process.env.NODE_PATH = [process.env.NODE_PATH, stubRoot].filter(Boolean).join(delimiter)
  const child = spawnSync(process.execPath, ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

const DSH_HOME = mkdtempSync(join(tmpdir(), 'sm-ws-r50-home-'))
process.env.DSH_HOME = DSH_HOME

const capability = await import('../src/capability.ts')
const { SupermemoryPanelService } = await import('../src/panel.ts')
const { workspaceKeyOf } = await import('../src/store.ts')

let passed = 0
const ok = (name) => { passed += 1; console.log('ok - ' + name) }

function table(seed = []) {
  const map = new Map(seed)
  return {
    get: (k) => map.get(k),
    keys: () => map.keys(),
    entries: () => map.entries(),
    get size() { return map.size },
    put: async (k, v) => { map.set(k, v) },
    update: async (k, fn) => { map.set(k, fn(map.get(k))) },
    delete: async (k) => map.delete(k),
  }
}
const fakeStore = (seed = {}) => ({
  toolMemory: table(seed.toolMemory ?? []),
  signals: table(seed.signals ?? []),
  dispatches: table(seed.dispatches ?? []),
  memories: table(),
  topicsets: table(),
  episodes: table(),
  requirements: table(),
  filemap: table(),
  routing: table(),
  hotcache: table(),
  memoryCollections: table(),
  hubs: table(),
  hubPolicies: table(),
  modelDefaults: table(),
  questions: table(),
  outbox: table(),
  meta: table(),
})

const base = mkdtempSync(join(tmpdir(), 'sm-ws-r50-'))
const dirA = join(base, 'workspace-a')
const dirB = join(base, 'workspace-b')
mkdirSync(join(dirA, '.git'), { recursive: true })
mkdirSync(join(dirB, '.git'), { recursive: true })
const WS_A = workspaceKeyOf(dirA)
const WS_B = workspaceKeyOf(dirB)

const ctxOf = () => {
  const captured = []
  return {
    captured,
    ctx: { tools: { register: (def, opts) => { captured.push({ def, opts }); return () => {} }, get: () => undefined } },
  }
}
const legacyCap = (name, scope, extra = {}) => ({
  kind: 'composite', workspaceKey: scope, title: name, tags: [], trigger: 'capability/' + name,
  description: name + ' 描述', entry: JSON.stringify({ name, kind: 'capability', description: name + ' 描述', entry: 'echo ' + name, scope, runnable: true, steps: [], parameters: [], version: 1, ...extra }),
  useCount: 2, status: 'active', createdAt: 1,
})

// ---- W1 纯判定 ----
{
  assert.equal(capability.capabilityAppliesToWorkspace({ scope: WS_A }, WS_A), true)
  assert.equal(capability.capabilityAppliesToWorkspace({ scope: WS_A }, WS_B), false, 'scope 指向别的工作区=不适用')
  assert.equal(capability.capabilityAppliesToWorkspace({ scope: WS_A }, WS_B, WS_B), true, '行级归属优先于 scope')
  assert.equal(capability.capabilityAppliesToWorkspace({}, WS_B), true, '无归属无 scope=全局能力')
  assert.equal(capability.capabilityAppliesToWorkspace({ scope: WS_A }, undefined), true, '无调用方工作区=不判定')
  assert.equal(capability.scopeContains(WS_A, join(WS_A, 'src')), true, '子目录在 scope 内')
  assert.equal(capability.scopeContains(WS_A, WS_B), false, '别的工作区在 scope 外')
  assert.equal(capability.scopeContains(undefined, WS_B), true, '无 scope=不限制')
  ok('W1 纯判定：scope/行级归属/全局/子目录包含')
}

// ---- W2 列表隔离 ----
{
  const store = fakeStore({
    toolMemory: [
      ['tm-a', legacyCap('sm_composite_scope_a', WS_A)],
      ['tm-b', legacyCap('sm_composite_scope_b', WS_B)],
      ['tm-global', { ...legacyCap('sm_composite_global', ''), workspaceKey: undefined }],
      ['tm-seq', { kind: 'composite', workspaceKey: WS_A, title: '序列', tags: [], trigger: 'ws/x/seq/a>b', description: 'd', entry: JSON.stringify({ name: 'sm_composite_seq', steps: [{ tool: 'a', arguments: {} }], parameters: [] }), useCount: 0, status: 'active', createdAt: 1 }],
    ],
  })
  const names = (ws) => capability.capabilityRecordsOf(store, ws).map((row) => row.spec.name).sort()
  assert.deepEqual(names(WS_A), ['global', 'scope-a'], 'A sees its own + the global capability')
  assert.deepEqual(names(WS_B), ['global', 'scope-b'])
  assert.equal(capability.capabilityRecordsOf(store).length, 3, '无工作区参数=全量')
  const panel = new SupermemoryPanelService(store)
  const viewsA = panel.listTools(dirA)
  assert.deepEqual(viewsA.filter((view) => view.kind === 'capability').map((view) => view.name).sort(), ['sm_cap_global', 'sm_cap_scope_a'])
  const viewsB = panel.listTools(dirB)
  assert.deepEqual(viewsB.filter((view) => view.kind === 'capability').map((view) => view.name).sort(), ['sm_cap_global', 'sm_cap_scope_b'])
  assert.deepEqual(capability.capabilityHealthOf(store, WS_A).map((row) => row.name).sort(), ['global', 'scope-a'])
  ok('W2 列表隔离：capabilityRecordsOf / 面板 listTools / capabilityHealthOf 只看本工作区')
}

// ---- W3 同名能力两个工作区各自一行 ----
{
  const store = fakeStore()
  const { ctx } = ctxOf()
  const a = await capability.registerCapability(ctx, store, { name: 'shared-cap', description: 'A 侧', entry: 'echo a', scope: dirA }, WS_A)
  const b = await capability.registerCapability(ctx, store, { name: 'shared-cap', description: 'B 侧', entry: 'echo b', scope: dirB }, WS_B)
  assert.equal(a.status, 'ok', a.message)
  assert.equal(b.status, 'ok', b.message)
  assert.notEqual(a.id, b.id, 'same logical name in two workspaces = two rows')
  assert.equal(store.toolMemory.size, 2)
  assert.deepEqual(capability.capabilityRecordsOf(store, WS_A).map((row) => row.spec.description), ['A 侧'])
  assert.deepEqual(capability.capabilityRecordsOf(store, WS_B).map((row) => row.spec.description), ['B 侧'])
  ok('W3 注册隔离：同名能力在两个工作区各自一行，互不覆盖')
}

// ---- W4 执行面跨工作区拒绝 ----
{
  const store = fakeStore()
  const { ctx, captured } = ctxOf()
  const reg = await capability.registerCapability(ctx, store, {
    name: 'gate-cap', description: '执行面门禁', entry: 'echo gate-ok', scope: dirA,
  }, WS_A)
  assert.equal(reg.status, 'ok')
  const def = captured.find((item) => item.def.name === 'sm_cap_gate_cap')?.def
  assert.ok(def, 'the execution face is registered as sm_cap_*')
  const here = await def.execute({}, { signal: new AbortController().signal, agent: { session: { header: { cwd: dirA } } } })
  assert.equal(here.status, 'completed', here.summary)
  const other = await def.execute({}, { signal: new AbortController().signal, agent: { session: { header: { cwd: dirB } } } })
  assert.equal(other.status, 'failed', 'a cross-workspace call is refused')
  const rec = capability.findCapabilityRow(store, { id: reg.id })
  assert.equal(rec.record.runCount, 1, 'the refused call is not counted')
  ok('W4 执行面：跨工作区调用拒绝且不计数，本工作区正常执行')
}

// ---- W5 重建带归属 + 内置播种 ----
{
  const store = fakeStore({
    toolMemory: [
      ['tm-a', legacyCap('sm_composite_scope_a', WS_A)],
      ['tm-b', legacyCap('sm_composite_scope_b', WS_B)],
    ],
  })
  const seen = []
  const { ctx } = ctxOf()
  const count = await capability.rebuildCapabilities(ctx, store, {
    register: async (_c, _s, entry, workspaceKey) => { seen.push({ name: entry.record.name, workspaceKey }); return () => {} },
  })
  assert.ok(count >= 2, 'rebuild registers active executable rows: ' + count)
  const a = seen.find((item) => item.name === 'scope-a')
  assert.equal(a && a.workspaceKey, WS_A, 'row-level ownership is passed to registration')
  const b = seen.find((item) => item.name === 'scope-b')
  assert.equal(b && b.workspaceKey, WS_B)
  assert.ok(!seen.some((item) => item.name.includes('composite')), 'no legacy sequence row is registered')
  const builtin = capability.capabilityRows(store).find((entry) => entry.record.name === 'git-sync-supermemory')
  assert.ok(builtin, 'builtin capability seeded')
  assert.equal(builtin.row.workspaceKey, workspaceKeyOf(capability.capabilityRows(store).find((e) => e.record.name === 'git-sync-supermemory').record.scope), 'builtin seeded to its scope workspace')
  ok('W5 重建：行级归属传给注册；内置能力播种到 scope 工作区；序列行永不注册')
}

// ---- W6 迁移保留归属 + 改名 ----
{
  const store = fakeStore({
    toolMemory: [
      ['tm-legacy', { ...legacyCap('sm_composite_legacy_cap', WS_A), useCount: 5 }],
      ['tm-seq', { kind: 'composite', workspaceKey: WS_A, title: '序列', tags: [], trigger: 'ws/a/seq/read>bash', description: 'd', entry: JSON.stringify({ name: 'sm_composite_legacy_seq', steps: [{ tool: 'read', arguments: {} }], parameters: [] }), useCount: 3, status: 'active', createdAt: 1 }],
    ],
  })
  const report = await capability.migrateCapabilities(store, { root: join(DSH_HOME, 'skills'), now: 1000 })
  assert.ok(report.migratedCapabilities >= 1)
  assert.equal(store.toolMemory.get('tm-legacy').workspaceKey, WS_A, 'workspace ownership survives migration')
  const rec = JSON.parse(store.toolMemory.get('tm-legacy').entry)
  assert.equal(rec.name, 'legacy-cap')
  assert.equal(rec.entry, 'echo sm_composite_legacy_cap')
  assert.equal(capability.capabilityToolName(rec.name), 'sm_cap_legacy_cap')
  assert.equal(store.toolMemory.get('tm-seq').status, 'retired', 'legacy sequence row retired')
  assert.equal(capability.capabilityRows(store).some((entry) => entry.record.name.includes('legacy-seq')), false, 'retired sequence is not a capability')
  ok('W6 迁移：旧能力保留归属并改名 sm_cap_*；旧序列行退役且不可见')
}

rmSync(base, { recursive: true, force: true })
rmSync(DSH_HOME, { recursive: true, force: true })
console.log('\nworkspace-scope-smoke: ' + passed + ' groups passed')
process.exit(0)
