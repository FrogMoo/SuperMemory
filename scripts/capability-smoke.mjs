/**
 * capability-smoke — R50 统一能力（知识面 SKILL.md + 执行面 sm_cap_*）源级单测。
 *
 * R50-1 迁移：旧 capability 行（kind=composite + spec.kind=capability）迁为
 *      capability 并改名 sm_composite_* -> sm_cap_*；旧工具序列行退役；旧 skill
 *      行转 knowledge；知识面文件生成（事实块）。
 * R50-2 注册与执行：sm_cap_* 只注册固定入口 + dry_run/confirm；默认预演、
 *      writeConfirm 必须 confirm=true、scope 外拒绝、执行后统计落库。
 * R50-3 事实块：SKILL.md 六节 + 事实块；自动刷新只改事实块，人工散文保留，
 *      bodyHash/factsHash 入库。
 * R50-4 统计与转化率：runCount/loadCount/loadsToRuns/successRate/连续失败。
 * R50-5 内置能力：播种/升级保留统计，逻辑名 + sm_cap_ 工具名。
 * R50-6 提案与高置信入口：阈值规则（≥3 样本、≥2 会话、全部 exit 0、允许家族、
 *      非交互、无占位符/临时路径）；接受只产知识/entryDraft 未验证；人工启用
 *      执行后才 runnable=true。
 * R50-7 上限与过期：pending ≤20、每 skills 根自动生成 ≤8、30 天过期。
 * R50-8 删除归档：知识面目录移到 <root>-archive，行删除，可回滚。
 * R50-9 描述：路由规则进入能力工具描述，命名只用 sm_cap_*。
 * R51 壳子修复：boot 先归档壳子再迁移；source=sequence 或 flow-/tool 名字或
 *      工具顺序描述的 SKILL.md 不进 units；已收编壳子幂等退役；人工知识/
 *      人工能力不受影响；sm-git-sync-supermemory 保留。
 *
 * Usage: node scripts/capability-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const stubRoot = new URL('./__fixtures__/stub-node-modules', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
  process.env.NODE_PATH = [process.env.NODE_PATH, stubRoot].filter(Boolean).join(delimiter)
  const child = spawnSync(process.execPath, ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

const capability = await import('../src/capability.ts')
const { BUILTIN_CAPABILITIES } = await import('../src/builtin-capabilities.ts')
const { CAPABILITY_ROUTING_RULES } = await import('../src/route.ts')
const { workspaceKeyOf } = await import('../src/store.ts')
const { charCount } = await import('../src/clip.ts')

let passed = 0
function ok(name) { passed += 1; console.log('ok - ' + name) }

function table(seed = []) {
  const map = new Map(seed)
  return {
    get: (k) => map.get(k),
    keys: () => map.keys(),
    entries: () => map.entries(),
    get size() { return map.size },
    put: async (k, v) => { map.set(k, v) },
    update: async (k, fn) => { const v = map.get(k); if (v === undefined) throw new Error('missing ' + k); map.set(k, fn(v)) },
    delete: async (k) => map.delete(k),
  }
}

const fakeStore = (seed = {}) => ({
  toolMemory: table(seed.toolMemory ?? []),
  signals: table(seed.signals ?? []),
  dispatches: table(seed.dispatches ?? []),
})

const root = mkdtempSync(join(tmpdir(), 'sm-cap-r50-'))
const ws = join(root, 'repo')
mkdirSync(join(ws, '.git'), { recursive: true })
writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { typecheck: 'tsc', build: 'tsdown', 'git:sync': 'node x' } }))
const workspaceKey = workspaceKeyOf(ws)

function ctxOf() {
  const captured = []
  return {
    captured,
    ctx: { tools: { register: (def, opts) => { captured.push({ def, opts }); return () => {} }, get: () => undefined } },
  }
}

const legacyCapSpec = {
  name: 'sm_composite_git_sync_supermemory', kind: 'capability', title: 'git 同步', description: '同步/提交/推送',
  entry: 'echo sync', scope: ws, runnable: true, dryRunArg: '--dry-run', writeConfirm: true,
  steps: [], parameters: [], version: 6, changelog: ['v6 legacy'],
}

// ---- R50-1 迁移 ----
{
  const skillPath = join(root, 'manual-skill', 'SKILL.md')
  mkdirSync(join(root, 'manual-skill'), { recursive: true })
  writeFileSync(skillPath, '---\nname: sm-manual-one\ndescription: "手工 skill"\ndisable-model-invocation: false\n---\n\n# 手工\n\n正文保留。\n')
  const store = fakeStore({
    toolMemory: [
      ['legacy-cap', { kind: 'composite', workspaceKey, title: 'git 同步', tags: [], trigger: 'capability/x', description: '同步/提交/推送', entry: JSON.stringify(legacyCapSpec), useCount: 4, status: 'active', createdAt: 1 }],
      ['legacy-seq', { kind: 'composite', workspaceKey, title: '序列', tags: [], trigger: 'ws/x/seq/run_code>run_code', description: '旧序列', entry: JSON.stringify({ name: 'sm_composite_run_code_run_code', steps: [{ tool: 'run_code', arguments: {} }], parameters: [] }), useCount: 2706, status: 'active', createdAt: 1 }],
      ['legacy-skill', { kind: 'skill', workspaceKey, title: '手工', tags: [], trigger: 'skill/sm-manual-one', description: '手工 skill', entry: skillPath, useCount: 1, status: 'active', createdAt: 1 }],
    ],
  })
  const report = await capability.migrateCapabilities(store, { root, now: 1000 })
  assert.ok(report.migratedCapabilities >= 1, 'migrates the legacy capability row')
  assert.equal(store.toolMemory.get('legacy-seq').status, 'retired', 'legacy sequence rows are retired')
  assert.equal(store.toolMemory.get('legacy-skill').kind, 'knowledge', 'legacy skill row becomes knowledge')
  const capRow = store.toolMemory.get('legacy-cap')
  assert.equal(capRow.kind, 'capability')
  const rec = JSON.parse(capRow.entry)
  assert.equal(rec.schema, 'sm.capability/1')
  assert.equal(rec.name, 'git-sync-supermemory', 'legacy sm_composite_<x> maps to logical <x>')
  assert.equal(capability.capabilityToolName(rec.name), 'sm_cap_git_sync_supermemory')
  assert.equal(capRow.useCount, 4, 'execution count is carried as runCount')
  const knows = store.toolMemory.get('legacy-skill')
  assert.equal(JSON.parse(knows.entry).name, 'manual-one')
  assert.equal(capability.capabilitySkillName('manual-one'), 'sm-manual-one')
  const skillFile = join(ws, '.dsh', 'capabilities', 'git-sync-supermemory.md')
  assert.ok(existsSync(skillFile), 'knowledge face generated under .dsh/capabilities')
  const text = readFileSync(skillFile, 'utf8')
  assert.ok(text.includes('<!-- sm:facts:start -->') && text.includes('<!-- sm:facts:end -->'), 'facts block present')
  assert.ok(text.includes('sm_cap_git_sync_supermemory') || text.includes('git 同步'), 'skill names the capability')
  // idempotent: a second pass changes nothing fatal and never resurrects sequences
  const second = await capability.migrateCapabilities(store, { root, now: 2000 })
  assert.equal(store.toolMemory.get('legacy-seq').status, 'retired')
  assert.equal(second.retiredComposites, 0, 'second migration retires nothing')
  ok('R50-1 迁移：旧能力改名 sm_cap_* + 生成知识面；旧 skill 转 knowledge；旧序列退役；幂等')
}

// ---- R50-2 注册与执行闸门 ----
{
  const store = fakeStore()
  const { ctx, captured } = ctxOf()
  const registered = await capability.registerCapability(ctx, store, {
    name: 'r50-exec', title: '执行能力', description: 'R50 执行面测试', entry: 'echo r50-ok',
    scope: ws, dryRunArg: '--dry-run', writeConfirm: true, source: 'manual',
  }, workspaceKey)
  assert.equal(registered.status, 'ok', registered.message)
  assert.equal(registered.name, 'r50-exec')
  const row = store.toolMemory.get(registered.id)
  assert.equal(row.kind, 'capability')
  assert.equal(JSON.parse(row.entry).entry, 'echo r50-ok')
  const def = captured.find((item) => item.def.name === 'sm_cap_r50_exec')?.def
  assert.ok(def, 'registers exactly one sm_cap_* tool')
  assert.deepEqual(Object.keys(def.parameters).sort(), ['confirm', 'dry_run'], 'fixed dry_run/confirm inputs only')
  const dry = await def.execute({}, { signal: new AbortController().signal })
  assert.equal(dry.status, 'completed', dry.summary)
  assert.equal(dry.dryRun, true, 'dry-run is the default when dryRunArg exists')
  assert.ok(String(dry.stdout).includes('--dry-run'), 'dry-run argument appended')
  const needsConfirm = await def.execute({ dry_run: false }, { signal: new AbortController().signal })
  assert.equal(needsConfirm.status, 'needs-confirm', 'writeConfirm refuses a real run without confirm')
  const confirmed = await def.execute({ confirm: true }, { signal: new AbortController().signal })
  assert.equal(confirmed.status, 'completed', confirmed.summary)
  assert.equal(confirmed.dryRun, false)
  const persisted = JSON.parse(store.toolMemory.get(registered.id).entry)
  assert.equal(persisted.runCount, 2, 'completed runs counted; needs-confirm not counted')
  assert.equal(persisted.successCount, 2)
  // scope 外拒绝
  const outside = join(root, 'other')
  mkdirSync(outside, { recursive: true })
  const blocked = await def.execute({}, { signal: new AbortController().signal, agent: { session: { header: { cwd: outside } } } })
  assert.equal(blocked.status, 'failed')
  assert.match(blocked.summary, /范围|scope/)
  ok('R50-2 注册与执行：sm_cap_* 固定入口；默认预演；writeConfirm 必须 confirm；scope 外拒绝；统计落库')
}

// ---- R50-3 事实块合并 / 人工编辑 ----
{
  const store = fakeStore()
  const { ctx } = ctxOf()
  const reg = await capability.registerCapability(ctx, store, {
    name: 'r50-facts', title: '事实块', description: '事实块测试', entry: 'echo facts', scope: ws,
  }, workspaceKey)
  const skillFile = join(ws, '.dsh', 'capabilities', 'r50-facts.md')
  assert.ok(existsSync(skillFile), 'knowledge file written under .dsh/capabilities')
  let text = readFileSync(skillFile, 'utf8')
  assert.ok(text.includes('## 何时用') && text.includes('## 决策清单') && text.includes('## 步骤纲要') && text.includes('## 关键坑') && text.includes('## 验证方式') && text.includes('## 反例'), 'six sections')
  assert.ok(text.includes('<!-- sm:facts:start -->'), 'facts block markers')
  // Human edits the prose; auto refresh must keep it and only replace facts.
  const edited = text.replace('## 决策清单', '## 决策清单（人工补充：先问运维）')
  writeFileSync(skillFile, edited, 'utf8')
  await capability.editCapability(ctx, store, reg.id, { entry: 'echo facts-v2', changelog: '入口升级' })
  text = readFileSync(skillFile, 'utf8')
  assert.ok(text.includes('先问运维'), 'human prose preserved across auto refresh')
  assert.ok(text.includes('echo facts-v2'), 'facts block refreshed with the new entry')
  const rec = JSON.parse(store.toolMemory.get(reg.id).entry)
  assert.ok(rec.bodyHash, 'bodyHash stored')
  assert.ok(rec.factsHash, 'factsHash stored')
  assert.ok(text.includes('sm-body-hash:') && text.includes('sm-facts-hash:'), 'hashes also in frontmatter')
  // R52: a manual DSH skill is NOT adopted as a capability and stays byte-identical.
  const manualDir = join(ws, '.dsh', 'skills', 'sm-r50-manual', 'SKILL.md')
  mkdirSync(join(ws, '.dsh', 'skills', 'sm-r50-manual'), { recursive: true })
  const manualBody = '---\nname: sm-r50-manual\ndescription: "手工"\n---\n\n# 手工正文\n\n不要改我。\n'
  writeFileSync(manualDir, manualBody, 'utf8')
  const manualStore = fakeStore()
  const migrated = await capability.migrateCapabilities(manualStore, { root: join(ws, '.dsh', 'skills') })
  assert.equal(migrated.linkedSkills, 0, 'manual skills are not adopted as capabilities')
  assert.equal(capability.capabilityRows(manualStore, workspaceKey).length, 0, 'no capability row for a third-party skill')
  const manualText = readFileSync(manualDir, 'utf8')
  assert.equal(manualText, manualBody, 'manual skill file untouched')
  assert.ok(!manualText.includes('<!-- sm:facts:start -->'), 'no facts block injected into a manual skill')
  ok('R50-3 事实块：六节 + 事实块；自动刷新只改事实块；人工散文保留；人工/第三方 skill 不入编')
}

// ---- R50-4 统计 / 转化率 ----
{
  const store = fakeStore()
  const { ctx } = ctxOf()
  const reg = await capability.registerCapability(ctx, store, {
    name: 'r50-stats', description: '统计', entry: 'echo stats', scope: ws, dryRunArg: '--dry-run',
  }, workspaceKey)
  await capability.bumpCapabilityLoad(store, workspaceKey, 'sm-r50-stats')
  await capability.bumpCapabilityLoad(store, workspaceKey, 'sm-r50-stats')
  await capability.bumpCapabilityRun(store, reg.id, { status: 'completed', stdout: '', stderr: '', durationMs: 1, dryRun: true, command: 'echo stats', summary: 'ok' })
  await capability.bumpCapabilityRun(store, reg.id, { status: 'failed', stdout: '', stderr: '', durationMs: 1, dryRun: false, command: 'echo stats', summary: 'fail' })
  const health = capability.capabilityHealthOf(store, workspaceKey).find((row) => row.name === 'r50-stats')
  assert.equal(health.loadCount, 2)
  assert.equal(health.runCount, 2)
  assert.equal(health.loadsToRuns, 1, '2 runs / 2 loads = 1')
  assert.equal(health.successRate, 0.5)
  assert.equal(health.consecutiveFailures, 1)
  await capability.bumpCapabilityRun(store, reg.id, { status: 'completed', stdout: '', stderr: '', durationMs: 1, dryRun: false, command: 'echo stats', summary: 'ok' })
  const after = capability.capabilityHealthOf(store, workspaceKey).find((row) => row.name === 'r50-stats')
  assert.equal(after.consecutiveFailures, 0, 'a success resets the streak')
  ok('R50-4 统计：loadCount/runCount/loadsToRuns/successRate/连续失败归零')
}

// ---- R50-5 内置能力：命名、播种、升级保留统计 ----
{
  const store = fakeStore()
  const report = await capability.mergeBuiltinCapabilities(store)
  assert.ok(report.seeded.includes('git-sync-supermemory'), 'builtin seeds by logical name')
  const row = [...store.toolMemory.entries()].find(([, r]) => r.kind === 'capability')
  const rec = JSON.parse(row[1].entry)
  assert.equal(capability.capabilityToolName(rec.name), 'sm_cap_git_sync_supermemory', 'no sm_composite_ name survives')
  assert.equal(rec.entryVerified, true, 'builtin entries are verified')
  rec.runCount = 7; rec.successCount = 6; rec.failCount = 1
  await capability.saveCapabilityRecord(store, rec, { id: row[0], workspaceKey: row[1].workspaceKey, createdAt: row[1].createdAt })
  rec.version = 1
  await capability.saveCapabilityRecord(store, rec, { id: row[0], workspaceKey: row[1].workspaceKey, createdAt: row[1].createdAt })
  const upgraded = await capability.mergeBuiltinCapabilities(store)
  assert.ok(upgraded.upgraded.includes('git-sync-supermemory'), 'older builtin version upgrades')
  const after = capability.capabilityHealthOf(store).find((h) => h.name === 'git-sync-supermemory')
  assert.equal(after.runCount, 7, 'upgrade keeps statistics')
  ok('R50-5 内置能力：逻辑名 + sm_cap_ 工具名；播种/升级保留统计')
}

// ---- R50-6 提案 / 高置信入口 ----
{
  const store = fakeStore()
  const samples = [
    { tools: ['bash'], args: [{ command: 'pnpm typecheck' }], sessionId: 's1', ok: true },
    { tools: ['bash'], args: [{ command: 'pnpm typecheck' }], sessionId: 's2', ok: true },
    { tools: ['bash'], args: [{ command: 'pnpm typecheck ' }], sessionId: 's2', ok: true },
  ]
  const decision = capability.highConfidenceEntryDraft(samples, { scope: ws, workspaceRoot: ws })
  assert.equal(decision.status, 'ok', decision.reason)
  assert.equal(decision.entry, 'pnpm typecheck')
  assert.equal(decision.writeConfirm, false, 'read-only family is not writeConfirm')
  const failing = samples.map((sample) => ({ ...sample, ok: false }))
  assert.equal(capability.highConfidenceEntryDraft(failing, { scope: ws, workspaceRoot: ws }).status, 'none', 'any non-zero sample disqualifies')
  const oneSession = samples.map((sample) => ({ ...sample, sessionId: 's1' }))
  assert.equal(capability.highConfidenceEntryDraft(oneSession, { scope: ws, workspaceRoot: ws }).status, 'none', 'needs >=2 sessions')
  const interactive = samples.map((sample) => ({ ...sample, args: [{ command: 'pnpm typecheck -i' }] }))
  assert.equal(capability.highConfidenceEntryDraft(interactive, { scope: ws, workspaceRoot: ws }).status, 'none', 'interactive flags disqualify')
  const temp = samples.map((sample) => ({ ...sample, args: [{ command: 'bash scripts/x.sh /tmp/y' }] }))
  assert.equal(capability.highConfidenceEntryDraft(temp, { scope: ws, workspaceRoot: ws }).status, 'none', 'temp paths disqualify')
  const foreignScript = samples.map((sample) => ({ ...sample, args: [{ command: 'pnpm not-a-script' }] }))
  assert.equal(capability.highConfidenceEntryDraft(foreignScript, { scope: ws, workspaceRoot: ws }).status, 'none', 'unknown script family disqualifies')

  const proposal = await capability.createProposal(store, {
    workspaceKey, name: 'r50-proposal', title: 'R50 提案', description: '自动知识草稿',
    body: '# R50 提案\n\n六节...', taskKey: 'r50/proposal', scope: ws,
    entryDraft: decision.entry, writeConfirm: decision.writeConfirm, source: 'auto',
  })
  assert.equal(proposal.status, 'created')
  const pending = capability.pendingProposalsOf(store, workspaceKey)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].record.kind, 'proposal')
  assert.equal(pending[0].record.entryDraft, 'pnpm typecheck')
  assert.equal(pending[0].record.entryVerified, false, 'auto entry draft is unverified')
  assert.equal(pending[0].record.runnable, false, 'auto proposal is never runnable')

  const { ctx, captured } = ctxOf()
  const accepted = await capability.acceptProposal(ctx, store, pending[0].id, { root: join(ws, '.dsh', 'capabilities') })
  assert.equal(accepted.status, 'ok', accepted.message)
  const cap = capability.findCapabilityRow(store, { id: accepted.id })
  assert.equal(cap.record.kind, 'capability')
  assert.equal(cap.record.runnable, false, 'accepted draft stays non-runnable')
  assert.equal(cap.record.entryVerified, false)
  assert.equal(cap.record.entry, '', 'draft is not promoted to entry')
  assert.ok(existsSync(join(ws, '.dsh', 'capabilities', 'r50-proposal.md')), 'acceptance generates the knowledge file')
  assert.equal(captured.length, 0, 'acceptance never registers a tool')
  const enabled = await capability.enableCapabilityEntryDraft(ctx, store, cap.id)
  assert.equal(enabled.status, 'ok', enabled.message)
  const live = capability.findCapabilityRow(store, { id: cap.id })
  assert.equal(live.record.entry, 'pnpm typecheck')
  assert.equal(live.record.entryVerified, true)
  assert.equal(live.record.runnable, true)
  assert.ok(captured.some((item) => item.def.name === 'sm_cap_r50_proposal'), 'human enable step registers the tool')
  ok('R50-6 提案与入口草稿：高置信规则；只产知识；接受不注册；人工启用执行后才 runnable + 注册工具')
}

// ---- R50-7 上限与过期 ----
{
  const store = fakeStore()
  for (let index = 0; index < 20; index += 1) {
    const result = await capability.createProposal(store, {
      workspaceKey, name: 'r50-cap-' + index, title: '上限' + index, description: 'pending cap', body: '# x', source: 'auto',
    })
    assert.equal(result.status, 'created', 'pending ' + index)
  }
  const rejected = await capability.createProposal(store, {
    workspaceKey, name: 'r50-cap-20', title: '上限20', description: 'pending cap', body: '# x', source: 'auto',
  })
  assert.equal(rejected.status, 'rejected', 'pending proposals capped at 20')
  // 30-day expiry (fresh store: the pending cap above is already full)
  const expiryStore = fakeStore()
  const old = await capability.createProposal(expiryStore, {
    workspaceKey, name: 'r50-old', title: '旧', description: 'old', body: '# x', source: 'auto', now: 1000,
  })
  const expired = await capability.expireProposals(expiryStore, 1000 + 31 * 86400000)
  assert.ok(expired >= 1, 'stale proposals expire')
  const oldRow = capability.findCapabilityRow(expiryStore, { id: old.id })
  assert.equal(oldRow.record.proposalStatus, 'declined')
  // per-root cap 8 at acceptance
  const capStore = fakeStore()
  const rootCaps = join(ws, '.dsh', 'capabilities')
  mkdirSync(rootCaps, { recursive: true })
  for (let index = 0; index < 8; index += 1) {
    const built = capability.buildCapabilityRecord({ name: 'r50-auto-' + index, description: 'auto', entry: 'echo x' })
    built.record.source = 'auto'
    built.record.skillPath = join(rootCaps, 'r50-auto-' + index + '.md')
    writeFileSync(built.record.skillPath, '---\nname: sm-r50-auto-' + index + '\ndescription: "x"\n---\n\n# x\n')
    await capability.saveCapabilityRecord(capStore, built.record, { workspaceKey })
  }
  const ninth = await capability.createProposal(capStore, {
    workspaceKey, name: 'r50-ninth', title: '第九', description: 'ninth', body: '# x', source: 'auto',
  })
  const { ctx } = ctxOf()
  const accepted = await capability.acceptProposal(ctx, capStore, ninth.id, { root: rootCaps })
  assert.equal(accepted.status, 'error', 'the 9th auto capability is refused')
  assert.match(accepted.message, /上限 8/)
  ok('R50-7 上限：pending ≤20、每知识面根自动生成 ≤8、30 天过期')
}

// ---- R50-8 删除归档 ----
{
  const store = fakeStore()
  const { ctx } = ctxOf()
  const reg = await capability.registerCapability(ctx, store, {
    name: 'r50-delete', description: '删除归档', entry: 'echo del', scope: ws,
  }, workspaceKey)
  const skillFile = join(ws, '.dsh', 'capabilities', 'r50-delete.md')
  assert.ok(existsSync(skillFile))
  const deleted = await capability.deleteCapability(ctx, store, reg.id)
  assert.equal(deleted.status, 'ok', deleted.message)
  assert.equal(store.toolMemory.get(reg.id), undefined, 'row removed')
  assert.ok(deleted.archivePath && existsSync(deleted.archivePath), 'knowledge file archived, not hard-deleted')
  assert.ok(!existsSync(skillFile), 'original knowledge file is gone (moved)')
  ok('R50-8 删除：知识面归档到 capabilities-archive，行删除，可回滚')
}

// ---- R50-9 描述与命名 ----
{
  const built = capability.buildCapabilityRecord({ name: 'r50-desc', description: '描述', entry: 'pnpm typecheck', scope: ws, dryRunArg: '--dry-run' })
  const text = capability.capabilityToolDescription(built.record)
  assert.ok(text.includes(CAPABILITY_ROUTING_RULES))
  assert.ok(text.includes('sm_cap_'), 'routing rules name the sm_cap_ family')
  assert.ok(!text.includes('sm_composite_'), 'no sm_composite_ reference in the model-visible description')
  assert.equal(capability.capabilityToolName('git-sync-supermemory'), 'sm_cap_git_sync_supermemory')
  assert.equal(capability.capabilitySkillName('git-sync-supermemory'), 'sm-git-sync-supermemory')
  ok('R50-9 命名与描述：只有 sm_cap_*；路由规则进入能力描述')
}

// ---- R51 壳子修复：boot 先归档再迁移；已收编壳子幂等退役；人工/能力不受影响 ----
{
  const { cleanupToolize } = await import('../src/toolize.ts')
  const project = join(root, 'r51-repo')
  mkdirSync(join(project, '.git'), { recursive: true })
  const skillsRoot = join(project, '.dsh', 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  const wsR51 = workspaceKeyOf(project)
  const SHELL_DESC = '当任务需要按 bash → bash 的顺序反复处理同类改动时加载：含触发条件、决策清单、步骤纲要、关键坑与验证方式（自动化沉淀的重复事务）。'
  const shellFile = (name, source) => '---\nname: ' + name + '\ndescription: ' + JSON.stringify(SHELL_DESC)
    + '\nsm-source: ' + JSON.stringify(source) + '\nsm-version: 1\nsm-occurrences: 7\n---\n\n# bash → bash 重复流程\n\n## 何时用（触发条件）\n\n- ' + SHELL_DESC + '\n'
  const writeSkill = (name, text) => { mkdirSync(join(skillsRoot, name), { recursive: true }); writeFileSync(join(skillsRoot, name, 'SKILL.md'), text, 'utf8') }
  const shellName = 'sm-flow-bash-bash-1mso2t'
  const adoptedName = 'sm-flow-run-code-run-code-1lwcpc'
  const manualName = 'sm-manual-notes'
  writeSkill(shellName, shellFile(shellName, 'sequence'))
  // R50 rewrote an archived shell's face to sm-source: capability; it must STILL be a shell.
  writeSkill(adoptedName, shellFile(adoptedName, 'capability'))
  writeSkill(manualName, '---\nname: ' + manualName + '\ndescription: "手工知识"\nsm-source: "manual"\n---\n\n# 人工正文\n\n保留我。\n')
  const knowledgeEntry = (name, description, path) => JSON.stringify({
    schema: 'sm.capability/1', name: name.replace(/^sm-/, ''), kind: 'knowledge', title: name, description,
    tags: [], entry: '', entryDraft: '', entryVerified: false, doc: '', scope: '', runnable: false, enabled: true,
    dryRunArg: '', writeConfirm: false, routeNote: '', source: 'manual', taskKey: '', version: 1, updatedAt: 1,
    changelog: [], skillPath: path, bodyHash: '', factsHash: '',
  })
  const store = fakeStore({ toolMemory: [
    ['tm-shell', { kind: 'skill', status: 'active', workspaceKey: wsR51, title: shellName, tags: [], trigger: 'skill/' + shellName, description: SHELL_DESC, entry: join(skillsRoot, shellName, 'SKILL.md'), useCount: 9, createdAt: 1 }],
    ['tm-adopted', { kind: 'knowledge', status: 'active', workspaceKey: wsR51, title: adoptedName, tags: [], trigger: 'capability/' + adoptedName, description: SHELL_DESC, entry: knowledgeEntry(adoptedName, SHELL_DESC, join(skillsRoot, adoptedName, 'SKILL.md')), source: 'manual', createdAt: 1 }],
    ['tm-manual', { kind: 'skill', status: 'active', workspaceKey: wsR51, title: manualName, tags: [], trigger: 'skill/' + manualName, description: '手工知识', entry: join(skillsRoot, manualName, 'SKILL.md'), useCount: 1, createdAt: 1 }],
    ['tm-cap', { kind: 'composite', status: 'active', workspaceKey: wsR51, title: 'git 同步', tags: [], trigger: 'capability/git-sync-supermemory', description: 'git 同步', entry: JSON.stringify({ name: 'sm_composite_git_sync_supermemory', kind: 'capability', title: 'git 同步', description: 'git 同步', entry: 'pnpm git:sync', scope: project, runnable: true, dryRunArg: '--dry-run', writeConfirm: true, steps: [], parameters: [], version: 2 }), useCount: 3, createdAt: 1 }],
  ] })
  // Boot order per src/index.ts: cleanup (archive/retire) BEFORE migrate/rebuild.
  const cleanup = await cleanupToolize({ store, roots: [skillsRoot], dropPending: false })
  const migration = await capability.migrateCapabilities(store, { root: skillsRoot, now: 1000 })
  assert.equal(cleanup.archivedCount, 2, 'two shells archived before migration')
  assert.ok(!existsSync(join(skillsRoot, shellName)), 'sequence shell moved out of the skill root')
  assert.ok(!existsSync(join(skillsRoot, adoptedName)), 'R50-rewritten shell moved out of the skill root')
  assert.ok(existsSync(join(skillsRoot, manualName, 'SKILL.md')), 'manual knowledge stays on disk')
  assert.equal(store.toolMemory.get('tm-shell').status, 'retired', 'legacy skill row retired, not migrated')
  assert.equal(store.toolMemory.get('tm-adopted').status, 'retired', 'adopted shell unit retired, not migrated')
  assert.equal(store.toolMemory.get('tm-manual').status, 'active', 'manual knowledge row stays active')
  const rows = capability.capabilityRows(store, wsR51).filter((entry) => entry.record.kind !== 'proposal')
  const unitNames = rows.filter((entry) => !capability.isShellUnit(entry.record)).map((entry) => entry.record.name).sort()
  assert.deepEqual(unitNames, ['git-sync-supermemory', 'manual-notes'], 'only real units remain: ' + unitNames.join(','))
  assert.equal(rows.filter((entry) => capability.isShellUnit(entry.record) && entry.row.status !== 'retired').length, 0, 'no ACTIVE shell unit survives')
  assert.equal(migration.retiredShellUnits >= 0, true)
  // Idempotent second boot: nothing re-archives, nothing revives.
  const statuses = () => JSON.stringify([...store.toolMemory.entries()].map(([id, row]) => [id, row.status]))
  const before = statuses()
  const again = await cleanupToolize({ store, roots: [skillsRoot], dropPending: false })
  await capability.migrateCapabilities(store, { root: skillsRoot, now: 2000 })
  assert.equal(again.archivedCount, 0, 'second boot archives nothing')
  assert.equal(again.retiredShellUnits, 0, 'second boot retires no unit')
  assert.equal(statuses(), before, 'row statuses are stable (idempotent)')
  ok('R51-1 壳子修复：boot 先归档再迁移；sequence 与 R50 改写过的壳子都不进 units；人工知识/能力保留；二次启动幂等')
}

// ---- R51-2 迁移自身先归档；已收编但目录已移走的壳子被幂等退役 ----
{
  const { cleanupToolize } = await import('../src/toolize.ts')
  const project = join(root, 'r51-repo-2')
  mkdirSync(join(project, '.git'), { recursive: true })
  const skillsRoot = join(project, '.dsh', 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  const wsR51 = workspaceKeyOf(project)
  const name = 'sm-flow-edit-bash-y3ozif'
  const desc = '当任务需要按 edit → bash 的顺序反复处理同类改动时加载：含触发条件。'
  mkdirSync(join(skillsRoot, name), { recursive: true })
  writeFileSync(join(skillsRoot, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + JSON.stringify(desc) + '\nsm-source: "sequence"\n---\n\n# 壳子\n', 'utf8')
  const orphanEntry = JSON.stringify({ schema: 'sm.capability/1', name: 'flow-edit-bash-y3ozif', kind: 'knowledge', title: name, description: desc, entry: '', runnable: false, source: 'manual', skillPath: join(skillsRoot, 'gone', 'SKILL.md'), enabled: true })
  const store = fakeStore({ toolMemory: [
    ['tm-adopted-orphan', { kind: 'knowledge', status: 'active', workspaceKey: wsR51, title: name, tags: [], trigger: 'capability/flow-edit-bash-y3ozif', description: desc, entry: orphanEntry, createdAt: 1 }],
  ] })
  // Migration alone must archive BEFORE deciding anything (defence in depth).
  const report = await capability.migrateCapabilities(store, { root: skillsRoot, now: 1000 })
  assert.ok(report.archivedShells >= 1, 'migration archived the shell itself: ' + report.archivedShells)
  assert.ok(!existsSync(join(skillsRoot, name)), 'shell directory moved by migration')
  assert.equal(store.toolMemory.get('tm-adopted-orphan').status, 'retired', 'an adopted shell with no directory left is retired')
  const cleanup = await cleanupToolize({ store, dropPending: false })
  assert.equal(cleanup.retiredShellUnits, 0, 'already retired → cleanup is idempotent')
  ok('R51-2 迁移自身先归档；已收编但目录已移走的壳子被幂等退役')
}

// ---- R52 能力知识面搬离 skill 目录：路径、迁移、幂等、sm_cap_doc、第三方 skill ----
{
  const project = join(root, 'r52-repo')
  mkdirSync(join(project, '.git'), { recursive: true })
  const skillsRoot = join(project, '.dsh', 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  const wsR52 = workspaceKeyOf(project)
  const capRoot = join(project, '.dsh', 'capabilities')
  const oldDir = join(skillsRoot, 'sm-r52-cap')
  mkdirSync(oldDir, { recursive: true })
  const oldFile = join(oldDir, 'SKILL.md')
  const facts = '<!-- sm:facts:start -->\n## 事实（自动维护）\n\n- 入口：echo hi\n<!-- sm:facts:end -->'
  const body = '# 迁移能力\n\n## 何时用\n\n- 做 R52 迁移测试时。\n\n## 关键坑\n\n- 旧目录必须移走。\n\n## 验证方式\n\n- 看新路径。\n\n' + facts
  const oldText = '---\nname: sm-r52-cap\ndescription: "迁移测试"\ndisable-model-invocation: false\nsm-version: 3\nsm-updated-at: 1\nsm-source: "capability"\nsm-body-hash: "x"\nsm-facts-hash: "y"\n---\n\n' + body + '\n'
  writeFileSync(oldFile, oldText, 'utf8')
  const thirdDir = join(skillsRoot, 'third-party-skill')
  mkdirSync(thirdDir, { recursive: true })
  const thirdText = '---\nname: third-party-skill\ndescription: "第三方技能"\n---\n\n# 第三方\n\n不要动我。\n'
  writeFileSync(join(thirdDir, 'SKILL.md'), thirdText, 'utf8')
  const capRecord = {
    schema: 'sm.capability/1', name: 'r52-cap', kind: 'capability', title: '迁移能力', description: '迁移测试',
    tags: [], entry: 'echo hi', entryDraft: '', entryVerified: true, doc: '', scope: project, runnable: true,
    enabled: true, dryRunArg: '', writeConfirm: false, routeNote: '', source: 'migrated', taskKey: '',
    version: 3, updatedAt: 1, changelog: [], skillPath: oldFile, bodyHash: 'x', factsHash: 'y', facts: {},
  }
  const store = fakeStore({ toolMemory: [
    ['tm-r52-cap', { kind: 'knowledge', status: 'active', workspaceKey: wsR52, title: '迁移能力', tags: [], description: '迁移测试', entry: JSON.stringify(capRecord), createdAt: 1 }],
  ] })
  const docs = await capability.migrateCapabilityDocs(store, { now: 1000 })
  const newPath = join(capRoot, 'r52-cap.md')
  assert.equal(docs.moved, 1, 'one capability knowledge file moved: ' + JSON.stringify(docs))
  assert.ok(existsSync(newPath), 'new .dsh/capabilities/<name>.md exists')
  assert.ok(!newPath.includes('/.dsh/skills/'), 'new path is outside every skill root')
  assert.ok(capRoot.endsWith(join('.dsh', 'capabilities')), 'capability root is .dsh/capabilities')
  assert.ok(!existsSync(oldDir), 'old sm-<name> skill directory is gone')
  assert.equal(readFileSync(join(thirdDir, 'SKILL.md'), 'utf8'), thirdText, 'third-party skill untouched')
  assert.equal(readdirSync(skillsRoot).filter((name) => name.startsWith('sm-')).length, 0, 'no sm-* directory remains under .dsh/skills')
  const migratedRow = capability.readCapabilityRow(store.toolMemory.get('tm-r52-cap'), 'tm-r52-cap')
  assert.equal(migratedRow.record.skillPath, newPath, 'row skillPath points at the new file')
  const manifestFile = join(skillsRoot + '-archive', 'manifest.json')
  assert.ok(existsSync(manifestFile), 'archive manifest records the move')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  assert.ok(manifest.entries.some((entry) => entry.name === 'sm-r52-cap' && entry.from === oldDir), 'manifest has name/from/reason')
  assert.ok(manifest.entries.some((entry) => entry.reason.includes('R52')), 'manifest reason mentions R52')
  const again = await capability.migrateCapabilityDocs(store, { now: 2000 })
  assert.equal(again.moved, 0, 'second migration is idempotent')
  assert.equal(again.archivedDirs, 0, 'second migration archives nothing')

  const loaded = await capability.loadCapabilityDoc(store, wsR52, 'r52-cap')
  assert.equal(loaded.status, 'ok', loaded.message)
  assert.ok(loaded.body.includes('## 关键坑'), 'sm_cap_doc returns the full body')
  assert.ok(loaded.factsBlock.includes('sm:facts:start'), 'sm_cap_doc returns the facts block')
  assert.equal(loaded.loadCount, 1, 'successful load increments loadCount')
  const section = await capability.loadCapabilityDoc(store, wsR52, 'sm_cap_r52_cap', '关键坑')
  assert.equal(section.status, 'ok', section.message)
  assert.ok(section.body.startsWith('## 关键坑'), 'section load returns only that section')
  assert.equal(section.loadCount, 2, 'section load also increments loadCount')
  const edited = await capability.updateCapabilitySkillBody(store, 'tm-r52-cap', '## 何时用\n\n人工新正文。')
  assert.equal(edited.status, 'ok', edited.message)
  const editedText = readFileSync(newPath, 'utf8')
  assert.ok(editedText.includes('人工新正文。'), 'panel body edit saves the prose')
  assert.ok(editedText.includes('<!-- sm:facts:start -->') && editedText.includes('<!-- sm:facts:end -->'), 'panel body edit preserves the facts block')
  const current = capability.readCapabilityRow(store.toolMemory.get('tm-r52-cap'), 'tm-r52-cap')
  await capability.saveCapabilityRecord(store, { ...current.record, enabled: false }, { id: 'tm-r52-cap', workspaceKey: wsR52, createdAt: 1 })
  const disabled = await capability.loadCapabilityDoc(store, wsR52, 'r52-cap')
  assert.equal(disabled.status, 'error', 'disabled capability is not readable')
  assert.match(disabled.message, /停用/)
  const missing = await capability.loadCapabilityDoc(store, wsR52, 'no-such-cap')
  assert.equal(missing.status, 'error', 'missing capability is an explicit error')
  assert.match(missing.message, /不存在/)
  ok('R52-1 迁移/路径/幂等：能力知识面移到 .dsh/capabilities；旧目录归档；第三方 skill 不动；sm_cap_doc 正例/停用/不存在/loadCount；正文编辑保留事实块')
}

// ---- R52-2 索引卡：最多 8 条、徽标、R47 预算与省略标记 ----
{
  const rows = Array.from({ length: 10 }, (_, index) => ({
    name: 'cap-' + index,
    title: '能力' + index,
    description: '当任务需要处理第 ' + index + ' 类事务时加载（含步骤、坑与验证方式）',
    entry: index % 3 === 0 ? 'echo x' : '',
    runnable: index % 3 === 0,
    ...(index === 0 ? { entryDraft: 'echo draft', entryVerified: false } : {}),
    enabled: true,
    kind: index % 2 === 0 ? 'capability' : 'knowledge',
    status: 'active',
  }))
  const card = capability.renderCapabilityIndex(rows, { maxItems: 8, budget: 1600 })
  assert.equal(card.included, 8, 'at most 8 capability rows are indexed')
  assert.equal(card.omitted, 2, 'the rest are omitted with a count')
  assert.ok(card.text.includes('sm_cap_doc'), 'the card points at sm_cap_doc')
  assert.ok(card.text.includes('省略 2 条'), 'explicit omission marker')
  assert.ok(charCount(card.text) <= 1600, 'card honors the character budget')
  assert.ok(card.text.includes('入口待验证') && card.text.includes('仅知识') && card.text.includes('可执行'), 'three badges are rendered')
  const tight = capability.renderCapabilityIndex(rows, { maxItems: 8, budget: 260 })
  assert.ok(charCount(tight.text) <= 260, 'tight budget still bounded')
  assert.ok(tight.text.includes('省略'), 'tight budget still says what was left out')
  ok('R52-2 索引卡：最多 8 条；可执行/仅知识/入口待验证徽标；R47 预算与省略标记')
}

// ---- R52-3 接线：注入只给 hub/branch；工具声明为 sm_cap_doc；面板有正文编辑器 ----
{
  const { readFileSync: read } = await import('node:fs')
  const prestepSrc = read(new URL('../src/prestep.ts', import.meta.url), 'utf8')
  const toolsSrc = read(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const panelSrc = read(new URL('../src/client/panel-page.tsx', import.meta.url), 'utf8')
  assert.ok(prestepSrc.includes("role.role === 'hub' || role.role === 'branch'"), 'capability index is gated to hub/branch roles')
  assert.ok(prestepSrc.includes('renderCapabilityIndex') && prestepSrc.includes('capabilityIndex'), 'prestep wires the capability index')
  assert.match(toolsSrc, /name: 'sm_cap_doc'/, 'sm_cap_doc is a registered tool')
  assert.ok(toolsSrc.includes('loadCapabilityDoc'), 'sm_cap_doc executes the capability loader')
  assert.ok(panelSrc.includes("tool.body.save") && panelSrc.includes('{ body: editingTool.body }'), 'panel has a body editor using editTool(id,{body})')
  ok('R52-3 接线：能力索引仅 hub/branch；sm_cap_doc 已注册；面板正文编辑器走 editTool(id,{body})')
}


// ---- R54-1 版本单调：max(record, live file, archive)；迁移写入 changelog；二次幂等 ----
{
  const { parseSkillMarkdown } = await import('../src/skill-forge.ts')
  const project = join(root, 'r54-version-repo')
  mkdirSync(join(project, '.git'), { recursive: true })
  const wsR54 = workspaceKeyOf(project)
  const capRoot = join(project, '.dsh', 'capabilities')
  const skillsRoot = join(project, '.dsh', 'skills')
  mkdirSync(capRoot, { recursive: true })
  mkdirSync(skillsRoot, { recursive: true })
  const facts = '<!-- sm:facts:start -->\n## 事实（自动维护）\n\n- 入口：echo hi\n<!-- sm:facts:end -->'
  const body = '# 版本能力\n\n## 何时用（触发条件）\n\n- 做 R54 版本测试时。\n\n## 关键坑\n\n- 版本不许回退。\n\n' + facts
  const docText = (version, changelog) => '---\nname: sm-r54-cap\ndescription: "版本测试"\nsm-enabled: true\n'
    + 'sm-version: ' + version + '\nsm-updated-at: 1\nsm-source: "capability"\nsm-occurrences: 1\n'
    + 'sm-body-hash: "b1"\nsm-facts-hash: "f1"\nsm-changelog: ' + JSON.stringify(changelog) + '\n---\n\n' + body + '\n'
  const docPath = join(capRoot, 'r54-cap.md')
  // The R52 regression: live file v6, archived pre-R52 skill file v8.
  writeFileSync(docPath, docText(6, ['v6: 内置能力播种：生成知识面']), 'utf8')
  const archiveDir = join(skillsRoot + '-archive', 'sm-r54-cap')
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, 'SKILL.md'), docText(8, ['v8: 内置能力播种：生成知识面', 'v7: 刷新事实块/路由描述（正文人工散文保留）', 'v6: 内置能力播种：生成知识面']), 'utf8')
  const record = {
    schema: 'sm.capability/1', name: 'r54-cap', kind: 'capability', title: '版本能力', description: '版本测试',
    tags: [], entry: 'echo hi', entryDraft: '', entryVerified: true, doc: '', scope: project, runnable: true,
    enabled: true, dryRunArg: '', writeConfirm: false, routeNote: '', source: 'migrated', taskKey: '',
    version: 6, updatedAt: 1, changelog: ['v6: 定义'], skillPath: docPath, bodyHash: 'b1', factsHash: 'f1', facts: {},
  }
  const store = fakeStore({ toolMemory: [
    ['tm-r54-cap', { kind: 'capability', status: 'active', workspaceKey: wsR54, title: '版本能力', tags: [], trigger: 'capability/r54-cap', description: '版本测试', entry: JSON.stringify(record), useCount: 0, createdAt: 1 }],
  ] })
  const first = await capability.reconcileCapabilityVersions(store, { now: 1000 })
  assert.equal(first.changed, true, 'a regressed live file is reconciled')
  assert.equal(first.entries[0].version, 8, 'max(record 6, file 6, archive 8) = 8')
  const adoptedText = readFileSync(docPath, 'utf8')
  const adopted = parseSkillMarkdown(adoptedText, 'sm-r54-cap')
  assert.equal(adopted.version, 8, 'live file version is restored to 8')
  assert.ok(adopted.changelog[0].includes('R52 迁移到 .dsh/capabilities') && adopted.changelog[0].includes('保留归档版本'), 'migration is written into the file changelog')
  assert.ok(adopted.changelog.some((line) => line.startsWith('v7:')), 'archived changelog history is preserved')
  assert.ok(adoptedText.includes('# 版本能力') && adoptedText.includes('<!-- sm:facts:start -->'), 'prose and facts block are byte-preserved')
  const adoptedRow = capability.readCapabilityRow(store.toolMemory.get('tm-r54-cap'), 'tm-r54-cap')
  assert.equal(adoptedRow.record.version, 8, 'record version is written back')
  assert.ok(adoptedRow.record.changelog[0].includes('R52 迁移到 .dsh/capabilities'), 'record changelog records the restore')
  const second = await capability.reconcileCapabilityVersions(store, { now: 2000 })
  assert.equal(second.changed, false, 'second reconcile is unchanged (idempotent)')
  assert.equal(second.reconciled, 0)

  // record=6 / file=8 (no archive): adopt the file version with a changelog line.
  const adoptProject = join(root, 'r54-adopt-repo')
  mkdirSync(join(adoptProject, '.git'), { recursive: true })
  const wsAdopt = workspaceKeyOf(adoptProject)
  const adoptRoot = join(adoptProject, '.dsh', 'capabilities')
  mkdirSync(adoptRoot, { recursive: true })
  const adoptPath = join(adoptRoot, 'r54-adopt.md')
  writeFileSync(adoptPath, docText(8, ['v8: 内置能力播种：生成知识面']).replace(/sm-r54-cap/g, 'sm-r54-adopt'), 'utf8')
  const adoptRecord = { ...record, name: 'r54-adopt', title: '对齐能力', skillPath: adoptPath }
  const adoptStore = fakeStore({ toolMemory: [
    ['tm-r54-adopt', { kind: 'capability', status: 'active', workspaceKey: wsAdopt, title: '对齐能力', tags: [], trigger: 'capability/r54-adopt', description: '版本测试', entry: JSON.stringify(adoptRecord), useCount: 0, createdAt: 1 }],
  ] })
  const adopted2 = await capability.reconcileCapabilityVersions(adoptStore, { now: 1000 })
  assert.equal(adopted2.changed, true, 'record 6 + file 8 is reconciled')
  const adopted2Text = parseSkillMarkdown(readFileSync(adoptPath, 'utf8'), 'sm-r54-adopt')
  assert.equal(adopted2Text.version, 8, 'result version is 8')
  assert.ok(adopted2Text.changelog[0].startsWith('v8:'), 'changelog is appended at v8')
  const adopted2Row = capability.readCapabilityRow(adoptStore.toolMemory.get('tm-r54-adopt'), 'tm-r54-adopt')
  assert.equal(adopted2Row.record.version, 8, 'record follows the file version')
  assert.equal((await capability.reconcileCapabilityVersions(adoptStore, { now: 2000 })).changed, false, 'repeat is unchanged')
  ok('R54-1 版本单调：max(record, file, archive)；归档 v8 恢复 + changelog；record=6/file=8 → 8；二次幂等')
}

// ---- R54-2 健康口径：runCount=success+fail、lastStatus 一致、迁移写回、幂等 ----
{
  const project = join(root, 'r54-health-repo')
  mkdirSync(join(project, '.git'), { recursive: true })
  const wsHealth = workspaceKeyOf(project)
  const legacy = {
    schema: 'sm.capability/1', name: 'r54-health', kind: 'capability', title: '健康口径', description: '健康统计测试',
    tags: [], entry: 'echo hi', entryDraft: '', entryVerified: true, doc: '', scope: project, runnable: true,
    enabled: true, dryRunArg: '', writeConfirm: false, routeNote: '', source: 'migrated', taskKey: '',
    version: 2, updatedAt: 1, changelog: ['v2: 定义'], skillPath: '', bodyHash: '', factsHash: '', facts: {},
    loadCount: 4, runCount: 0, successCount: 13, failCount: 9, consecutiveFailures: 2, lastStatus: 'failed',
  }
  const direct = capability.reconcileCapabilityHealth(legacy)
  assert.equal(direct.changed, true, 'legacy split counters are reconciled')
  assert.equal(direct.record.runCount, 22, 'runCount = success + fail (history preserved)')
  assert.equal(direct.record.successCount, 13)
  assert.equal(direct.record.failCount, 9)
  assert.equal(direct.record.lastStatus, 'failed', 'lastStatus agrees with the failure streak')
  assert.equal(direct.legacyFolded, true)
  assert.equal(capability.reconcileCapabilityHealth(direct.record).changed, false, 'reconcile is idempotent')
  const successAfterFail = capability.reconcileCapabilityHealth({
    ...legacy, runCount: 0, successCount: 3, failCount: 1, consecutiveFailures: 0, lastStatus: 'failed',
  })
  assert.equal(successAfterFail.record.runCount, 4)
  assert.equal(successAfterFail.record.lastStatus, 'completed', 'a cleared streak means the last run succeeded')
  const coherent = { ...legacy, runCount: 4, successCount: 3, failCount: 1, consecutiveFailures: 0, lastStatus: 'completed' }
  assert.equal(capability.reconcileCapabilityHealth(coherent).changed, false, 'a coherent reading is untouched')

  const store = fakeStore({ toolMemory: [
    ['tm-r54-health', { kind: 'capability', status: 'active', workspaceKey: wsHealth, title: '健康口径', tags: [], trigger: 'capability/r54-health', description: '健康统计测试', entry: JSON.stringify(legacy), useCount: 0, loadCount: 4, runCount: 0, createdAt: 1 }],
  ] })
  const report = await capability.migrateCapabilities(store, { now: 1000 })
  assert.ok(report.healthReconciled >= 1, 'migration folds the legacy counters: ' + JSON.stringify(report))
  const persisted = capability.readCapabilityRow(store.toolMemory.get('tm-r54-health'), 'tm-r54-health')
  assert.equal(persisted.record.runCount, 22, 'migration writes runCount back to the row')
  assert.equal(persisted.record.lastStatus, 'failed')
  const health = capability.capabilityHealthOf(store, wsHealth).find((row) => row.name === 'r54-health')
  assert.equal(health.runCount, 22)
  assert.equal(health.loadsToRuns, 5.5, '22 runs / 4 loads — no more 0/0 contradiction')
  assert.equal(health.successRate, 13 / 22, 'success rate keeps its real denominator')
  assert.ok(health.notes.some((note) => note.includes('历史统计已校正')) || health.successCount === 13, 'the reading is internally coherent')
  const second = await capability.migrateCapabilities(store, { now: 2000 })
  assert.equal(second.healthReconciled, 0, 'second migration reconciles nothing (idempotent)')
  ok('R54-2 健康口径：runCount=success+fail；lastStatus 与最近结果一致；迁移写回；二次幂等')
}

// ---- R54-3 注入卡：何时用优先 title，无 title 退 description/whenToUse ----
{
  const rows = [
    {
      name: 'git-sync-supermemory', title: 'git 同步/提交/推送（SuperMemory 仓库）', description: '机器名描述',
      scope: 'F:\\10-SuperMemory', whenToUse: '在 F:\\10-SuperMemory 内遇到「git-sync-supermemory」类任务时加载。',
      entry: 'pnpm git:sync', runnable: true, enabled: true, kind: 'capability', status: 'active',
    },
    { name: 'no-title-cap', title: '', description: '当任务需要处理无标题能力的同类改动时加载', entry: '', runnable: false, enabled: true, kind: 'knowledge', status: 'active' },
  ]
  const card = capability.renderCapabilityIndex(rows, { maxItems: 8, budget: 1600 })
  const gitLine = card.text.split('\n').find((line) => line.startsWith('- git-sync-supermemory '))
  assert.ok(gitLine, 'the capability is indexed')
  assert.ok(gitLine.includes('「git 同步/提交/推送（SuperMemory 仓库）」'), 'the hint uses the human title: ' + gitLine)
  assert.ok(!gitLine.includes('「git-sync-supermemory」'), 'the machine name is never the subject of the hint')
  const fallbackLine = card.text.split('\n').find((line) => line.startsWith('- no-title-cap '))
  assert.ok(fallbackLine.includes('无标题能力'), 'a row without a title falls back to description/whenToUse')
  const kept = capability.capabilityIndexHint({
    name: 'x', title: '人类标题', description: 'd', scope: 'F:\\ws',
    whenToUse: '在 F:\\ws 内遇到「人类标题」类任务时加载。',
  })
  assert.equal(kept, '在 F:\\ws 内遇到「人类标题」类任务时加载。', 'a sentence that already names the title keeps its scope')
  assert.ok(capability.capabilityIndexHint({ ...rows[0], title: '' }).length > 0, 'no title → description/whenToUse fallback')
  const { readFileSync: read } = await import('node:fs')
  const prestepSrc = read(new URL('../src/prestep.ts', import.meta.url), 'utf8')
  assert.ok(prestepSrc.includes('scope: entry.record.scope'), 'prestep passes scope to the title-first renderer')
  ok('R54-3 注入卡：何时用优先 title、机器名不再当主语；无 title 退 description/whenToUse')
}


// ---- R55-1 中枢只读检查 + 执行禁令（角色闸门） ----
{
  const guard = await import('../src/role-guard.ts')
  const hubPolicy = await import('../src/hub-policy.ts')
  const hubStore = {
    hubs: table([['hub-r55', {
      workspaceKey, sessionId: 'hub-r55', title: 'R55 中枢', source: 'manual', createdAt: 1, updatedAt: 1,
    }]]),
    topicsets: table(),
    dispatches: table(),
    meta: table(),
  }
  const hubAgent = { id: 'hub-r55', session: { header: { cwd: ws } } }
  const branchAgent = { id: 'branch-r55', session: { header: { cwd: ws } } }
  const shellAgent = { id: 'shell-r55', session: { header: { cwd: ws } } }

  // 读权限：中枢/分支可读；普通 shell 会话得到明确拒绝（不是 UNKNOWN_TOOL）。
  assert.equal(guard.roleGuardDecision(hubStore, hubAgent, 'sm_cap_doc', {}), undefined,
    'a hub may READ a capability knowledge face')
  assert.equal(guard.roleGuardDecision(hubStore, branchAgent, 'sm_cap_doc', {}), undefined,
    'a branch may read the knowledge face too')
  const shellDenied = guard.roleGuardDecision(hubStore, shellAgent, 'sm_cap_doc', {})
  assert.equal(shellDenied?.info.code, 'CAPABILITY_DOC_ROLE_DENIED', 'an ordinary shell session is refused explicitly')
  assert.ok(shellDenied.reason.includes('只允许中枢/分支会话读取'), 'the refusal explains the role boundary: ' + shellDenied.reason)
  assert.equal(hubPolicy.isHubAllowedTool('sm_cap_doc', { tools: ['read'], prefixes: [] }), true,
    'sm_cap_doc is locked: a hostile stored row cannot remove it')

  // 执行禁令：中枢 sm_cap_* → 专用错误码，先于泛化白名单拒绝；分支照常。
  const execDenied = guard.roleGuardDecision(hubStore, hubAgent, 'sm_cap_r55_exec', {})
  assert.equal(execDenied?.info.code, 'HUB_CAPABILITY_EXEC_DENIED', 'a hub cannot run a capability')
  assert.ok(execDenied.reason.includes('中枢不能执行固化能力；请用 memory_dispatch 派发到分支'),
    'the refusal is corrective (dispatch), not the panel-checkbox wording: ' + execDenied.reason)
  assert.ok(execDenied.reason.includes('confirm=true') && execDenied.reason.includes('写操作需 confirm=true'),
    'the refusal states the confirm requirement for write operations')
  assert.equal(guard.roleGuardDecision(hubStore, hubAgent, 'sm_composite_legacy_cap', {})?.info.code,
    'HUB_CAPABILITY_EXEC_DENIED', 'the legacy capability prefix is denied the same way')
  assert.equal(guard.roleGuardDecision(hubStore, branchAgent, 'sm_cap_r55_exec', {}), undefined,
    'a branch still executes capabilities')
  assert.equal(guard.roleGuardDecision(hubStore, shellAgent, 'sm_cap_r55_exec', {}), undefined,
    'the execution ban targets HUBS only (ordinary sessions keep their profile)')

  // hub 调 sm_cap_doc 成功并 loadCount+1：sm_cap_doc.execute 就是 loadCapabilityDoc。
  const loadStore = fakeStore()
  const { ctx } = ctxOf()
  const reg = await capability.registerCapability(ctx, loadStore, {
    name: 'r55-doc', title: 'R55 只读能力', description: '中枢只读检查测试', entry: 'echo r55-doc', scope: ws,
  }, workspaceKey)
  assert.equal(reg.status, 'ok', reg.message)
  const first = await capability.loadCapabilityDoc(loadStore, workspaceKey, 'r55-doc')
  assert.equal(first.status, 'ok', first.message)
  assert.equal(first.loadCount, 1, 'a successful hub read increments loadCount')
  assert.ok(String(first.body).includes('R55 只读能力') || String(first.body).includes('r55-doc'), 'the body is returned')
  const second = await capability.loadCapabilityDoc(loadStore, workspaceKey, 'r55-doc')
  assert.equal(second.loadCount, 2, 'each read is counted (conversion denominator)')
  ok('R55-1 中枢只读检查：hub/branch 可读 sm_cap_doc（loadCount+1）、普通会话明确拒绝；hub 调 sm_cap_* 返回 HUB_CAPABILITY_EXEC_DENIED（先于白名单）；branch 照常执行')
}

// ---- R55-2 工具面收敛：hub 的 step 工具列表不出现 sm_cap_* ----
{
  const visibleStore = {
    ...fakeStore(),
    hubs: table([['hub-r55-vis', {
      workspaceKey, sessionId: 'hub-r55-vis', title: 'R55 中枢', source: 'manual', createdAt: 1, updatedAt: 1,
    }]]),
    topicsets: table(),
  }
  const hubAgent = { id: 'hub-r55-vis', session: { header: { cwd: ws } } }
  const branchAgent = { id: 'branch-r55-vis', session: { header: { cwd: ws } } }
  assert.equal(capability.capabilityVisibleToCaller(visibleStore, { agent: hubAgent }), false,
    'a hub step never admits the execution surface')
  assert.equal(capability.capabilityVisibleToCaller(visibleStore, { agent: branchAgent }), true,
    'a branch step keeps the execution surface')
  assert.equal(capability.capabilityVisibleToCaller(visibleStore, {}), true,
    'an unknown agent stays visible (the guard still decides execution)')
  const { ctx, captured } = ctxOf()
  const reg = await capability.registerCapability(ctx, visibleStore, {
    name: 'r55-visible', title: 'R55 工具面', description: '工具面收敛测试', entry: 'echo r55-visible', scope: ws, dryRunArg: '--dry-run',
  }, workspaceKey)
  assert.equal(reg.status, 'ok', reg.message)
  const registered = captured.find((item) => item.def.name === 'sm_cap_r55_visible')
  assert.ok(registered, 'the execution tool is registered with a step gate')
  assert.equal(registered.opts.when({ agent: hubAgent }), false, 'hub step: hidden')
  assert.equal(registered.opts.when({ agent: branchAgent }), true, 'branch step: visible')
  assert.equal(registered.opts.when({}), true, 'no agent: visible (host-side calls are guard-decided)')
  // 分支预演成功（默认 dry-run，写确认语义沿用 R50）。
  const dry = await registered.def.execute({}, { signal: new AbortController().signal, agent: branchAgent })
  assert.equal(dry.status, 'completed', dry.summary)
  assert.equal(dry.dryRun, true, 'a branch run defaults to dry-run')
  // sm_cap_doc 始终注册、且不带执行面的 when 闸门（只读检查不能被隐藏）。
  const capabilitySrc = readFileSync(new URL('../src/capability.ts', import.meta.url), 'utf8')
  assert.ok(capabilitySrc.includes('capabilityVisibleToCaller(store, context) && workspaceGate(context)'),
    'registerCapabilityTool composes the role gate with the workspace gate')
  const toolsSrc = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  assert.ok(toolsSrc.includes("name: 'sm_cap_doc'"), 'sm_cap_doc stays a registered tool for hub/branch')
  ok('R55-2 工具面收敛：hub 的 step 看不到 sm_cap_*（分支/无 agent 不受影响）；分支预演成功；sm_cap_doc 始终注册')
}

// ---- R55-3 路由与提示 + 面板锁定徽标的源码接线 ----
{
  const { HUB_ROLE_TEXT } = await import('../src/hub-role-text.ts')
  for (const needle of [
    '能力检查（R55）', 'memory_toolize', 'sm_cap_doc', 'HUB_CAPABILITY_EXEC_DENIED',
    'memory_dispatch 派发到分支', '是否先预演', '写操作需 confirm=true',
  ]) {
    assert.ok(HUB_ROLE_TEXT.includes(needle), 'HUB_ROLE_TEXT carries the capability-check instruction: ' + needle)
  }
  const card = capability.renderCapabilityIndex([{
    name: 'r55-card', title: 'R55 卡片', description: '当需要 R55 卡片时加载', entry: 'echo x', runnable: true,
    enabled: true, kind: 'capability', status: 'active',
  }], { maxItems: 8, budget: 1600 })
  assert.ok(card.text.includes('中枢只读，执行需派发分支'), 'the capability index card states the hub boundary: ' + card.text)
  assert.ok(CAPABILITY_ROUTING_RULES.includes('sm_cap_* 在中枢被 HUB_CAPABILITY_EXEC_DENIED 拒绝'),
    'the shared routing rules state the execution ban')
  const panelSrc = readFileSync(new URL('../src/client/panel-page.tsx', import.meta.url), 'utf8')
  assert.ok(panelSrc.includes("entry.noteKey === 'capabilityDoc'")
    && panelSrc.includes("entry.noteKey === 'capabilityExecDenied'"),
  'the hub-permission tab renders both capability badges')
  // R60: the read-only session-history badge is wired the same way.
  assert.ok(panelSrc.includes("entry.noteKey === 'sessionReadonly'"),
    'the hub-permission tab renders the session read-only badge')
  assert.ok(panelSrc.includes("group.id === 'source:session'"),
    'the hub-permission tab localizes the session-history group label')
  const localesSrc = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
  assert.ok(localesSrc.includes("'hubPolicy.note.capabilityDoc': '只读路由，锁定'"),
    'the locked read-only badge is localized')
  assert.ok(localesSrc.includes("'hubPolicy.note.capabilityExecDenied': '中枢不可执行'"),
    'the hub-cannot-execute badge is localized')
  assert.ok(localesSrc.includes("'hubPolicy.note.sessionReadonly': '只读'"),
    'the session read-only badge is localized (zh)')
  assert.ok(localesSrc.includes("'hubPolicy.note.sessionReadonly': 'Read-only'"),
    'the session read-only badge is localized (en)')
  assert.ok(localesSrc.includes("'hubPolicy.source.session': '会话历史（只读）'"),
    'the session-history group label is localized (zh)')
  assert.ok(localesSrc.includes("'hubPolicy.source.session': 'Session history (read-only)'"),
    'the session-history group label is localized (en)')
  ok('R55-3 路由与提示：HUB_ROLE_TEXT 能力检查+派发指令；索引卡「中枢只读，执行需派发分支」；面板锁定/不可执行徽标已接线')
}

rmSync(root, { recursive: true, force: true })
console.log('\ncapability-smoke: ' + passed + ' groups passed')
process.exit(0)
