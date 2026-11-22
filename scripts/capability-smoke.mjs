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
 *   C9 when 门禁（A3 检索侧）：能力/序列两条注册路径都传 { when }；适用工作区
 *      admitted、跨工作区不 admitted、无 cwd/坏 agent 形状放行、when 对坏 spec
 *      不抛（驱动 registerComposite，经 NODE_PATH 供 smoke 桩 dsh-tools）。
 * 纯函数 + 假 store + 直接驱动 capabilityToolDef.execute（无需宿主）。
 * Usage: node scripts/capability-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The health report resolves `doc` relative to `scope` on the REAL filesystem, so
// the fixtures below must not hardcode one machine's clone path (the repo moved
// from G:\09 - dsh\SuperMemory to F:\10-SuperMemory and C6 went red): anchor on
// this repository instead.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

// src/composite.ts 等源码是 TypeScript；Node strip-only 模式不够时整体重放一次。
// 重放前把 smoke 专用桩根目录（scripts/__fixtures__/stub-node-modules，内含
// @deepseek-ai/dsh-tools，defineTool 恒等）加进 NODE_PATH：C9 要驱动
// registerComposite，它经 loadHostModule 解析宿主 @deepseek-ai/dsh-tools——
// smoke 环境没有宿主包。NODE_PATH 条目按 node_modules 根解析（拼上包名），
// 所以指到含 @deepseek-ai/ 的上一层。桩只影响本仓库内进程的包解析（宿主运行时
// 锚定自己的入口解析内置副本，永远拿不到这个桩）。
if (!process.execArgv.includes('--experimental-transform-types')) {
  const stubRoot = fileURLToPath(new URL('__fixtures__/stub-node-modules', import.meta.url))
  process.env.NODE_PATH = [process.env.NODE_PATH, stubRoot].filter(Boolean).join(delimiter)
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

const {
  bumpCompositeUse, buildCapabilitySpec, capabilityToolDef, capabilityToolDescription,
  capabilityExecEnv, capabilityHealthOf, compositeWhenGate, mergeBuiltinCapabilities, persistComposite,
  rebuildComposites, registerCapability, registerComposite, runCapability,
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
// C9 用的两个工作区：A = 本仓库（真实路径，workspaceKeyOf 幂等），B = 虚构路径。
const WS_A = workspaceKeyOf(REPO_ROOT)
const WS_B = 'G:\\cap-smoke-b'
// 注册门禁 context：宿主把 preparing agent 放在 context.agent；缺省/坏形状也要覆盖。
const whenCtx = (cwd) => (cwd === undefined ? {} : { agent: { session: { header: { cwd } } } })

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
  assert.equal(row.workspaceKey, workspaceKeyOf(BUILTIN_CAPABILITIES[0].scope), '播种落到适用范围（自动推导的 scope）的工作区')
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
  assert.equal(spec.version, BUILTIN_CAPABILITIES[0].version, '升级到内置版本')
  assert.equal(spec.description, BUILTIN_CAPABILITIES[0].description, '定义恢复为内置')
  assert.ok(spec.routeNote && spec.routeNote.length > 0, '补上路由描述')
  assert.equal(row.useCount, 6, '行级计数保留')
  assert.deepEqual(spec.usage, { useCount: 6, successCount: 4, failCount: 2, consecutiveFailures: 2 }, 'usage 明细保留')
  // v2：scope 由插件位置推导，旧 scope 与本机不同；该行归属恰好等于旧 scope 推导值
  // ⇒ 是内置定义自己继承来的，必须随 scope 一起迁移，否则能力在新工作区仍不生效。
  assert.equal(spec.scope, BUILTIN_CAPABILITIES[0].scope, 'scope 升级为内置（推导）定义')
  assert.equal(row.workspaceKey, workspaceKeyOf(BUILTIN_CAPABILITIES[0].scope), '继承自旧 scope 的归属随 scope 迁移')
  assert.equal(row.status, 'active')
  // 升级行的 changelog 顶端必须是内置最新一条（不写死版本号，内置升到 v3/v4 也成立）。
  assert.equal(spec.changelog[0], BUILTIN_CAPABILITIES[0].changelog[0], 'changelog 顶端是内置最新说明: ' + spec.changelog[0])
  assert.ok(spec.updatedAt > 0)
  ok('C4 内置升级：旧版/无版本行→定义覆盖、计数与 usage 保留、changelog 记录、归属随 scope 迁移')
}

// ---- C4b 归属迁移边界：现场显式指定别的工作区的行不被改写 ----
{
  const store = fakeStore()
  const elsewhere = workspaceKeyOf('G:\\scope-elsewhere')
  const legacy = {
    name: GIT_TOOL, kind: 'capability', entry: 'pnpm git:sync', doc: 'docs/git-sync.md',
    scope: 'G:\\09 - dsh\\SuperMemory', steps: [], parameters: [], runnable: true,
  }
  await store.toolMemory.put('tm-elsewhere', {
    kind: 'composite', workspaceKey: elsewhere, trigger: 'capability/' + GIT_TOOL,
    title: '现场行', tags: [], description: 'd', entry: JSON.stringify(legacy), useCount: 0, status: 'active',
  })
  const report = await mergeBuiltinCapabilities(store)
  assert.deepEqual(report.upgraded, [GIT_TOOL])
  assert.equal(store.toolMemory.get('tm-elsewhere').workspaceKey, elsewhere, '现场显式指定的归属不被改写')
  ok('C4b 归属迁移边界：只搬「继承自旧 scope」的行，现场指定别的工作区的行保持不动')
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
    entry: 'pnpm health', doc: 'docs/__sm_missing_doc__.md', scope: REPO_ROOT,
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

// ---- C8 执行环境 PATH 兜底 + git-sync 的 bash 解析（R27 的 exit 127 回归） ----
{
  // (a) PATH 里连 node 目录都没有时，capabilityExecEnv 必须把「宿主 node 目录」补回来，
  //     且不破坏原有顺序、不重复追加。用真实 stripped PATH 跑一次 `node --version`：
  //     解析得出来 → exit 0，这就是「模拟 PATH 不含 pnpm/node 仍可解析」的端到端断言。
  const strippedPath = process.platform === 'win32'
    ? 'C:' + String.fromCharCode(92) + 'Windows' + String.fromCharCode(92) + 'system32'
    : '/nonexistent-bin'
  const originalPathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const injected = capabilityExecEnv({ ...process.env, [originalPathKey]: strippedPath })
  const injectedPath = String(injected[Object.keys(injected).find((k) => k.toLowerCase() === 'path') ?? 'PATH'] ?? '')
  assert.ok(injectedPath.startsWith(strippedPath), '原有 PATH 顺序保持不变: ' + injectedPath)
  assert.ok(
    injectedPath.toLowerCase().includes(dirname(process.execPath).toLowerCase()),
    '注入宿主 node 目录: ' + dirname(process.execPath),
  )
  const entries = injectedPath.split(process.platform === 'win32' ? ';' : ':')
  assert.equal(new Set(entries.map((e) => e.toLowerCase())).size, entries.length, 'PATH 不出现重复项')
  // 用注入后的 PATH 执行 node：宿主 node 目录被补进 PATH，因此能被解析到。
  const probe = spawnSync('node --version', { shell: true, encoding: 'utf8', env: injected, timeout: 30000 })
  assert.equal(probe.status, 0, 'stripped PATH + 注入后仍能解析 node: ' + String(probe.stdout || probe.stderr).slice(0, 200))
  assert.match(String(probe.stdout), /^v\d+\./, 'node 版本输出正常: ' + String(probe.stdout).trim())
  // 幂等：对已注入过的 env 再注入一次不改变结果。
  assert.equal(capabilityExecEnv(injected)[originalPathKey], injected[originalPathKey], '重复注入幂等')

  // (b) git-sync 的 bash 解析：WSL 启动器必须被识别并排除，Git for Windows 的 bash
  //     必须排在候选里（这就是 exit 127 的根因：旧实现先命中 System32 里的 bash.exe）。
  const bashMod = await import('../scripts/git-sync-push.mjs')
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:' + String.fromCharCode(92) + 'WINDOWS'
    const wsl = join(sysRoot, 'system32', 'bash.exe')
    assert.equal(bashMod.isWslBash(wsl), true, 'System32\bash.exe = WSL 启动器: ' + wsl)
    assert.equal(bashMod.isWslBash(join(sysRoot, 'system32', 'cmd.exe')), false, 'cmd.exe 不是 bash')
    const candidates = bashMod.bashCandidates()
    assert.ok(candidates.length > 0, 'Windows 上至少有一个候选')
    assert.ok(
      candidates.every((c) => !bashMod.isWslBash(c)),
      '候选里排除 WSL 启动器: ' + JSON.stringify(candidates),
    )
    const findBash = bashMod.findBash()
    assert.ok(findBash, '真实环境中能选出一个可用 bash: ' + JSON.stringify(candidates))
    assert.equal(bashMod.isWslBash(findBash), false, '选中的不是 WSL 启动器: ' + findBash)
    assert.equal(bashMod.usableBash(findBash), true, '选中的 bash 能看见 git-sync-push.sh: ' + findBash)
  } else {
    assert.equal(bashMod.isWslBash('/bin/bash'), false, '非 Windows 不判定 WSL')
    assert.ok(bashMod.findBash(), 'POSIX 上能找到 bash/sh')
  }

  // (c) runCapability 确实把自己的 env（含注入）交给子进程：让入口命令把子进程看到的
  //     PATH 打出来，必须包含宿主 node 目录。
  const echoPath = {
    name: 'sm_composite_cap_env_probe', kind: 'capability', description: '执行环境探针',
    // `set`（cmd）/ `env`（POSIX）都是纯内建，不需要引号，把子进程环境原样打出来。
    entry: process.platform === 'win32' ? 'set' : 'env',
    steps: [], parameters: [], runnable: true,
  }
  const envRun = runCapability(echoPath, { dryRun: false })
  assert.equal(envRun.status, 'completed', '能力子进程能执行 node: ' + envRun.summary + ' / ' + envRun.stderr.slice(0, 120))
  assert.ok(
    String(envRun.stdout).toLowerCase().includes(dirname(process.execPath).toLowerCase()),
    '子进程 PATH 含宿主 node 目录: ' + String(envRun.stdout).slice(0, 200),
  )
  ok('C8 执行环境：PATH 兜底注入宿主 node 目录（stripped PATH 下 node 仍可解析）+ WSL bash 排除')
}

// ---- C9 when 门禁（A3 检索侧）：适用 admitted / 跨工作区 not admitted / 坏形状放行 ----
{
  // registerComposite 两条注册路径都要把 { when } 交给宿主；宿主按 step 对每个
  // 可见工具调用 when(context)，false = 不进 admitted set（模型不可见）。
  const captured = []
  const ctx = {
    tools: {
      register: (def, opts) => { captured.push({ def, opts }); return () => {} },
      get: () => undefined,
    },
  }
  const capSpecWhen = {
    name: 'sm_composite_cap_when', kind: 'capability', description: 'when 门禁', title: 'when',
    entry: 'echo when', steps: [], parameters: [], runnable: true, dryRunArg: '--dry-run',
    scope: WS_A, version: 1,
  }
  await registerComposite(ctx, fakeStore(), capSpecWhen, WS_A)
  const capReg = captured.find((c) => c.def.name === capSpecWhen.name)
  assert.ok(capReg && capReg.opts && typeof capReg.opts.when === 'function', '能力注册路径传入 { when }')
  const when = capReg.opts.when
  assert.equal(when(whenCtx(WS_A)), true, '适用工作区 admitted')
  assert.equal(when(whenCtx(WS_B)), false, '跨工作区不 admitted')
  assert.equal(when({}), true, '无 agent 形状放行')
  assert.equal(when({ agent: undefined }), true, 'agent 缺失放行')
  assert.equal(when({ agent: { session: { header: {} } } }), true, '无 cwd 放行')
  assert.equal(when({ agent: { session: { header: { cwd: 123 } } } }), true, 'cwd 非字符串放行')
  assert.equal(when(null), true, 'null context 放行')
  // when 对坏 spec 不抛：宿主会把 when 的异常升级为 ToolActivationError（整个 step 失败）。
  // 坏 spec 只有在「无行级归属」时才会真正触到 spec.scope（短路求值），否则
  // 行级归属优先、根本不读 spec——两个形状都断言。
  const badGate = compositeWhenGate(undefined, undefined)
  assert.equal(badGate(whenCtx(WS_B)), true, '坏 spec（无行级归属）不抛，退化为放行')
  const badGate2 = compositeWhenGate(null, undefined)
  assert.equal(badGate2(whenCtx(WS_B)), true, 'null spec 不抛，退化为放行')
  const badGate3 = compositeWhenGate(undefined, WS_A)
  assert.equal(badGate3(whenCtx(WS_A)), true, '坏 spec + 行级归属：本工作区仍放行（不读 spec）')
  const rowGate = compositeWhenGate({ scope: WS_A }, WS_A)
  assert.equal(rowGate(whenCtx(WS_A)), true, '纯函数门禁：本工作区放行')
  assert.equal(rowGate(whenCtx(WS_B)), false, '纯函数门禁：跨工作区拦截')
  // 序列路径同样带 when：有行级归属的序列跨工作区不可见；无归属 = 全局可见。
  const captured2 = []
  const ctx2 = {
    tools: {
      register: (def, opts) => { captured2.push({ def, opts }); return () => {} },
      get: () => undefined,
    },
  }
  await registerComposite(ctx2, fakeStore(), { name: 'sm_composite_seq_when', description: '序列 when', steps: [{ tool: 'read', arguments: {} }], parameters: [] }, WS_A)
  await registerComposite(ctx2, fakeStore(), { name: 'sm_composite_seq_glob', description: '全局序列', steps: [{ tool: 'read', arguments: {} }], parameters: [] })
  const seqReg = captured2.find((c) => c.def.name === 'sm_composite_seq_when')
  assert.ok(seqReg && seqReg.opts && typeof seqReg.opts.when === 'function', '序列注册路径也传入 { when }')
  assert.equal(seqReg.opts.when(whenCtx(WS_A)), true, '本工作区序列 admitted')
  assert.equal(seqReg.opts.when(whenCtx(WS_B)), false, '跨工作区序列不 admitted')
  const globReg = captured2.find((c) => c.def.name === 'sm_composite_seq_glob')
  assert.equal(globReg.opts.when(whenCtx(WS_B)), true, '无归属序列=全局，任何工作区 admitted')
  ok('C9 when 门禁：适用/跨工作区/坏形状放行/坏 spec 不抛；能力与序列两条注册路径都带门禁')
}

console.log(String.fromCharCode(10) + passed + ' checks passed')
process.exit(0)
