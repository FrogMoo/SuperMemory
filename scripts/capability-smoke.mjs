/**
 * capability-smoke — R26 固化能力持续维护的源级单测（host-free）：
 *   C1 计数：dry-run/实跑/失败都累加，needs-confirm 不计；成败分列、连续失败
 *      （成功后归零）、lastUsedAt/lastStatus/lastDryRun/lastExitCode/lastSummary 落库；
 *   C2 register 同名更新：version+1、updatedAt、changelog（自定义+缺省）、usage 保留；
 *   C3 内置播种：空库播种 + 落适用范围工作区 + 重启重建拾取 + 幂等；
 *   C4 内置升级：旧版/无版本行→定义覆盖、计数与 usage 保留、changelog 记录；
 *   C5 现场保留：本地版本新于内置时不覆盖、报告 localNewer；
 *   C6 健康报告：连续失败/从未成功/文档缺失/零使用/scope 缺失信号；
 *   C7 路由规则：单一来源文案进入每个能力工具的描述。
 * 纯函数 + 假 store + 直接驱动 capabilityToolDef.execute（无需宿主）。
 * Usage: node scripts/capability-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

// src/composite.ts 等源码是 TypeScript；Node strip-only 模式不够时整体重放一次。
if (!process.execArgv.includes('--experimental-transform-types')) {
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

const {
  bumpCompositeUse, buildCapabilitySpec, capabilityToolDef, capabilityToolDescription,
  capabilityHealthOf, mergeBuiltinCapabilities, persistComposite, rebuildComposites, registerCapability,
} = await import('../src/composite.ts')
const { BUILTIN_CAPABILITIES } = await import('../src/builtin-capabilities.ts')
const { CAPABILITY_ROUTING_RULES } = await import('../src/route.ts')
const { workspaceKeyOf } = await import('../src/store.ts')

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
const fakeStore = (seed = {}) => ({
  toolMemory: table(seed.toolMemory ?? []),
  signals: table(seed.signals ?? []),
})
const quietExec = { signal: new AbortController().signal }
const GIT_TOOL = 'sm_composite_git_sync_supermemory'

let passed = 0
const ok = (label) => { passed += 1; console.log('ok - ' + label) }

// ---- C1 计数：dry-run/实跑/失败都计，needs-confirm 不计；统计明细落库 ----
{
  const store = fakeStore()
  const spec = {
    name: 'sm_composite_cap_count', kind: 'capability', description: '计数冒烟', title: '计数',
    entry: 'echo cap-count-ok', steps: [], parameters: [], runnable: true, dryRunArg: '--dry-run',
  }
  await store.toolMemory.put('tm-1', {
    kind: 'composite', trigger: 'capability/x', description: '计数冒烟',
    entry: JSON.stringify(spec), useCount: 0, status: 'active',
  })
  const def = capabilityToolDef(store, spec)
  const usageOf = () => JSON.parse(store.toolMemory.get('tm-1').entry).usage

  const dry = await def.execute({}, quietExec)
  assert.equal(dry.status, 'completed', 'echo 必须成功: ' + dry.summary)
  assert.equal(dry.dryRun, true, '定义了 dryRunArg → 默认预演')
  assert.equal(store.toolMemory.get('tm-1').useCount, 1, '预演也计数')
  assert.equal(usageOf().useCount, 1)
  assert.equal(usageOf().successCount, 1)
  assert.equal(usageOf().failCount, 0)
  assert.equal(usageOf().consecutiveFailures, 0)
  assert.equal(usageOf().lastDryRun, true)
  assert.equal(usageOf().lastStatus, 'completed')
  assert.ok(usageOf().lastUsedAt > 0, '刷新 lastUsedAt')
  assert.ok(usageOf().lastSummary.includes('exit 0'), '最近一次结果摘要: ' + usageOf().lastSummary)

  const real = await def.execute({ confirm: true }, quietExec)
  assert.equal(real.status, 'completed')
  assert.equal(real.dryRun, false, 'confirm=true 真实执行')
  assert.equal(store.toolMemory.get('tm-1').useCount, 2, '实跑计数')
  assert.equal(usageOf().useCount, 2)
  assert.equal(usageOf().successCount, 2)
  assert.equal(usageOf().lastDryRun, false)
  ok('C1a 能力执行计数：dry-run 与真实执行都累加，lastUsedAt/成败/摘要落库')
}

{
  // 失败也计数；连续失败累计；needs-confirm 没有执行，不计。
  const store = fakeStore()
  const spec = {
    name: 'sm_composite_cap_fail', kind: 'capability', description: '失败计数',
    entry: 'exit 3', steps: [], parameters: [], runnable: true, dryRunArg: '--dry-run',
  }
  await store.toolMemory.put('tm-2', {
    kind: 'composite', trigger: '', description: '失败计数',
    entry: JSON.stringify(spec), useCount: 0, status: 'active',
  })
  const def = capabilityToolDef(store, spec)
  const usageOf = () => JSON.parse(store.toolMemory.get('tm-2').entry).usage
  const f1 = await def.execute({ confirm: true }, quietExec)
  assert.equal(f1.status, 'failed')
  assert.equal(f1.exitCode, 3)
  assert.equal(store.toolMemory.get('tm-2').useCount, 1, '执行失败也计数')
  assert.equal(usageOf().failCount, 1)
  assert.equal(usageOf().consecutiveFailures, 1)
  assert.equal(usageOf().lastStatus, 'failed')
  assert.equal(usageOf().lastExitCode, 3)
  await def.execute({ confirm: true }, quietExec)
  assert.equal(usageOf().consecutiveFailures, 2, '连续失败累计')
  assert.equal(usageOf().failCount, 2)
  // 同一条能力随后一次成功（经 bump 落库）：连续失败归零、成功分列 +1。
  await bumpCompositeUse(store, spec.name, {
    status: 'completed', stdout: '', stderr: '', durationMs: 1, dryRun: false, command: spec.entry, summary: 'exit 0（实跑，1ms）',
  })
  assert.equal(usageOf().consecutiveFailures, 0, '成功后连续失败归零')
  assert.equal(usageOf().successCount, 1)
  assert.equal(usageOf().failCount, 2, '失败分列不清零')
  assert.equal(store.toolMemory.get('tm-2').useCount, 3)

  const wstore = fakeStore()
  const wspec = {
    name: 'sm_composite_cap_gate', kind: 'capability', description: '确认闸',
    entry: 'echo gate-should-not-run', steps: [], parameters: [], runnable: true, writeConfirm: true,
  }
  await wstore.toolMemory.put('tm-3', {
    kind: 'composite', trigger: '', description: '确认闸',
    entry: JSON.stringify(wspec), useCount: 0, status: 'active',
  })
  const blocked = await capabilityToolDef(wstore, wspec).execute({}, quietExec)
  assert.equal(blocked.status, 'needs-confirm')
  assert.equal(wstore.toolMemory.get('tm-3').useCount, 0, 'needs-confirm 没有执行，不计')
  ok('C1b 失败计数与连续失败累计/归零；needs-confirm 不计')
}

{
  // 序列组合工具：计数照旧，且定义不被 usage 改写（能力统计只属于 capability）。
  const store = fakeStore()
  const seqSpec = { name: 'sm_composite_seq_x', description: '序列', steps: [{ tool: 'read', arguments: {} }], parameters: [] }
  await store.toolMemory.put('tm-seq', { kind: 'composite', trigger: 'ws/ws/seq/a>b', description: '序列', entry: JSON.stringify(seqSpec), useCount: 0, status: 'active' })
  await bumpCompositeUse(store, 'sm_composite_seq_x')
  const row = store.toolMemory.get('tm-seq')
  assert.equal(row.useCount, 1, '序列组合工具计数照旧')
  assert.equal(row.entry, JSON.stringify(seqSpec), '序列定义不被 usage 改写')
  ok('C1c 序列组合工具：计数照旧、定义不被改写')
}

// ---- C2 register 同名更新：version+1 / updatedAt / changelog / usage 保留 ----
{
  const store = fakeStore()
  const ctx = { tools: { register: () => () => {}, get: () => undefined } }
  const deps = { register: async () => () => {}, persist: persistComposite, toolExists: () => false }
  const seed = {
    name: 'git-sync-supermemory', description: 'v1 描述', entry: 'pnpm git:sync',
    doc: 'docs/git-sync.md', scope: 'G:\\09 - dsh\\SuperMemory',
    dryRunArg: '--dry-run', writeConfirm: true, tags: ['git'],
  }
  const first = await registerCapability(ctx, store, seed, 'ws', deps)
  assert.equal(first.status, 'ok', '首次注册必须成功: ' + first.message)
  assert.equal(store.toolMemory.size, 1)
  const id = [...store.toolMemory.keys()][0]
  assert.equal(JSON.parse(store.toolMemory.get(id).entry).version, 1, '首次注册 version=1')
  // 旧式两参调用（面板/控制台路径）：只计总数，也落 usage 明细。
  await bumpCompositeUse(store, GIT_TOOL)
  const afterBump = store.toolMemory.get(id)
  assert.equal(afterBump.useCount, 1)
  assert.equal(JSON.parse(afterBump.entry).usage.useCount, 1, '两参调用也落 usage')
  // 同名更新：version+1、changelog 自定义行、usage/行级计数保留。
  const again = await registerCapability(ctx, store, { ...seed, description: 'v2 描述', changelog: '修订入口命令' }, 'ws', deps)
  assert.equal(again.status, 'ok')
  assert.ok(again.message.includes('v2'), '回执带新版本号: ' + again.message)
  assert.equal(store.toolMemory.size, 1, '同名更新不建新行')
  const spec = JSON.parse(store.toolMemory.get(id).entry)
  assert.equal(spec.version, 2, '同名更新 version+1')
  assert.ok(spec.updatedAt > 0, '记 updatedAt')
  assert.equal(spec.changelog[0], '修订入口命令')
  assert.equal(spec.usage.useCount, 1, 'usage 跨更新保留')
  assert.equal(store.toolMemory.get(id).useCount, 1, '行级计数跨更新保留')
  assert.equal(spec.description, 'v2 描述')
  // 缺省 changelog：自动生成一行。
  const third = await registerCapability(ctx, store, { ...seed, description: 'v3 描述' }, 'ws', deps)
  assert.equal(third.status, 'ok')
  const spec3 = JSON.parse(store.toolMemory.get(id).entry)
  assert.equal(spec3.version, 3)
  assert.ok(spec3.changelog[0].includes('更新能力定义'), '缺省 changelog 自动生成: ' + spec3.changelog[0])
  assert.equal(spec3.changelog.length, 3, 'changelog 累积（注册行 + 两次更新行）')
  assert.equal(spec3.changelog[1], '修订入口命令', '上一次的变更说明仍在')
  assert.ok(spec3.changelog[2].includes('注册能力'), '首次注册的自动行仍在')
  ok('C2 register 同名更新：version+1/updatedAt/changelog（自定义+缺省）/usage 保留/不建新行')
}

// ---- C3 内置播种：空库播种 + 落适用范围工作区 + 重启重建拾取 + 幂等 ----
{
  const store = fakeStore()
  const ctx = { tools: { register: () => () => {}, get: () => undefined } }
  const report = await mergeBuiltinCapabilities(store)
  assert.deepEqual(report.seeded, [GIT_TOOL])
  assert.deepEqual(report.upgraded, [])
  assert.equal(report.changed.length, 1)
  assert.equal(store.toolMemory.size, 1)
  const [id, row] = [...store.toolMemory.entries()][0]
  const spec = JSON.parse(row.entry)
  assert.equal(spec.kind, 'capability')
  assert.equal(spec.version, BUILTIN_CAPABILITIES[0].version)
  assert.equal(spec.entry, 'pnpm git:sync')
  assert.equal(spec.doc, 'docs/git-sync.md')
  assert.equal(spec.dryRunArg, '--dry-run')
  assert.equal(spec.writeConfirm, true)
  assert.equal(row.workspaceKey, workspaceKeyOf('G:\\09 - dsh\\SuperMemory'), '播种落到适用范围的工作区')
  assert.equal(row.trigger, 'capability/' + GIT_TOOL)
  // 重启：rebuildComposites 注册拾取（含刚播种的内置能力）。
  const registered = []
  const count = await rebuildComposites(ctx, store, { register: async (c, s, sp) => { registered.push(sp.name); return () => {} } })
  assert.equal(count, 1)
  assert.deepEqual(registered, [GIT_TOOL])
  // 幂等：再合并不播种不升级。
  const again = await mergeBuiltinCapabilities(store)
  assert.deepEqual(again.seeded, [])
  assert.deepEqual(again.upgraded, [])
  assert.deepEqual(again.current, [GIT_TOOL])
  assert.equal(store.toolMemory.size, 1)
  ok('C3 内置播种：空库播种+落工作区+重启重建拾取+幂等')
}

// ---- C4 内置升级：旧版/无版本行→定义覆盖、计数与 usage 保留 ----
{
  const store = fakeStore()
  const legacySpec = {
    name: GIT_TOOL, kind: 'capability', description: '被改坏的旧描述',
    entry: 'pnpm git:sync', doc: 'docs/git-sync.md', scope: 'G:\\09 - dsh\\SuperMemory',
    steps: [], parameters: [], runnable: true, dryRunArg: '--dry-run', writeConfirm: true,
    // 无 version 字段：内置化之前的现场行。
    usage: { useCount: 6, successCount: 4, failCount: 2, consecutiveFailures: 2 },
  }
  await store.toolMemory.put('tm-legacy', {
    kind: 'composite', workspaceKey: 'G:\\09 - dsh\\SuperMemory',
    trigger: 'capability/' + GIT_TOOL, title: '旧标题', tags: ['旧'],
    description: '被改坏的旧描述', entry: JSON.stringify(legacySpec), useCount: 6, status: 'active',
  })
  const report = await mergeBuiltinCapabilities(store)
  assert.deepEqual(report.upgraded, [GIT_TOOL])
  const row = store.toolMemory.get('tm-legacy')
  const spec = JSON.parse(row.entry)
  assert.equal(spec.version, 1, '升级到内置版本')
  assert.equal(spec.description, BUILTIN_CAPABILITIES[0].description, '定义恢复为内置')
  assert.ok(spec.routeNote && spec.routeNote.length > 0, '补上路由描述')
  assert.equal(row.useCount, 6, '行级计数保留')
  assert.deepEqual(spec.usage, { useCount: 6, successCount: 4, failCount: 2, consecutiveFailures: 2 }, 'usage 明细保留')
  assert.equal(row.workspaceKey, 'G:\\09 - dsh\\SuperMemory', '工作区归属不改写')
  assert.equal(row.status, 'active')
  assert.ok(spec.changelog[0].includes('v1'), 'changelog 含内置说明: ' + spec.changelog[0])
  assert.ok(spec.updatedAt > 0)
  ok('C4 内置升级：旧版/无版本行→定义覆盖、计数与 usage 保留、changelog 记录')
}

// ---- C5 现场保留：本地版本新于内置时不覆盖 ----
{
  const store = fakeStore()
  const localSpec = {
    name: GIT_TOOL, kind: 'capability', description: '本地定制描述',
    entry: 'pnpm git:sync', doc: 'docs/git-sync.md', scope: 'G:\\09 - dsh\\SuperMemory',
    steps: [], parameters: [], runnable: true, dryRunArg: '--dry-run', writeConfirm: true,
    version: 99, changelog: ['本地大改'],
  }
  await store.toolMemory.put('tm-local', {
    kind: 'composite', trigger: '', description: '本地定制描述',
    entry: JSON.stringify(localSpec), useCount: 3, status: 'active',
  })
  const report = await mergeBuiltinCapabilities(store)
  assert.deepEqual(report.localNewer, [GIT_TOOL])
  assert.deepEqual(report.upgraded, [])
  const spec = JSON.parse(store.toolMemory.get('tm-local').entry)
  assert.equal(spec.description, '本地定制描述', '现场新于内置：定义不被覆盖')
  assert.equal(spec.version, 99)
  ok('C5 现场保留：本地版本新于内置时不覆盖、报告 localNewer')
}

// ---- C6 健康报告：连续失败/从未成功/文档缺失/零使用/scope 缺失 ----
{
  const store = fakeStore()
  const badSpec = {
    name: 'sm_composite_cap_bad', kind: 'capability', description: '坏能力', title: '坏能力',
    entry: 'pnpm health', doc: 'docs/nope.md', scope: 'G:\\09 - dsh\\SuperMemory',
    steps: [], parameters: [], runnable: true,
    usage: { useCount: 3, successCount: 0, failCount: 3, consecutiveFailures: 3, lastStatus: 'failed' },
  }
  await store.toolMemory.put('tm-bad', {
    kind: 'composite', trigger: '', description: '坏能力',
    entry: JSON.stringify(badSpec), useCount: 3, status: 'active',
  })
  const idleSpec = {
    name: 'sm_composite_cap_idle', kind: 'capability', description: '闲置',
    entry: 'echo idle', scope: 'G:\\nope\\dir', steps: [], parameters: [], runnable: true,
  }
  await store.toolMemory.put('tm-idle', {
    kind: 'composite', trigger: '', description: '闲置',
    entry: JSON.stringify(idleSpec), useCount: 0, status: 'active',
  })
  const health = capabilityHealthOf(store)
  assert.equal(health.length, 2, '序列组合工具不混入能力健康报告')
  const bad = health.find((h) => h.name === 'sm_composite_cap_bad')
  assert.ok(bad, '坏能力在报告里')
  assert.equal(bad.consecutiveFailures, 3)
  assert.equal(bad.docMissing, true)
  assert.equal(bad.scopeMissing, false)
  assert.ok(bad.notes.some((n) => n.includes('连续失败')), '连续失败信号: ' + JSON.stringify(bad.notes))
  assert.ok(bad.notes.some((n) => n.includes('从未成功')))
  assert.ok(bad.notes.some((n) => n.includes('文档缺失')))
  const idle = health.find((h) => h.name === 'sm_composite_cap_idle')
  assert.equal(idle.scopeMissing, true)
  assert.equal(idle.useCount, 0)
  assert.ok(idle.notes.some((n) => n.includes('零使用')))
  assert.ok(idle.notes.some((n) => n.includes('适用范围目录不存在')))
  ok('C6 健康报告：连续失败/从未成功/文档缺失/零使用/scope 缺失信号')
}

// ---- C7 路由规则：单一来源文案进入每个能力工具的描述 ----
{
  assert.ok(CAPABILITY_ROUTING_RULES.includes('优先调用已固化能力'))
  assert.ok(CAPABILITY_ROUTING_RULES.includes('不要绕过'))
  assert.ok(CAPABILITY_ROUTING_RULES.includes('refresh-builtin'))
  const built = buildCapabilitySpec({
    name: 'git-sync-supermemory', description: '路由描述冒烟', entry: 'pnpm git:sync',
    doc: 'docs/git-sync.md', scope: 'G:\\09 - dsh\\SuperMemory',
    dryRunArg: '--dry-run', writeConfirm: true,
  })
  assert.equal(built.status, 'ok')
  const text = capabilityToolDescription(built.spec)
  assert.ok(text.includes('pnpm git:sync'), '描述带入口命令')
  assert.ok(text.includes('--dry-run'), '描述带预演语义')
  assert.ok(text.includes('confirm=true'), '描述带写操作确认语义')
  assert.ok(text.includes(CAPABILITY_ROUTING_RULES), '描述带能力路由规则')
  ok('C7 路由规则：单一来源文案进入每个能力工具的描述')
}

console.log(String.fromCharCode(10) + passed + ' checks passed')
process.exit(0)
