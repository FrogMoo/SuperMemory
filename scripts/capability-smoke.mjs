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
 *
 * Usage: node scripts/capability-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const skillFile = join(root, 'sm-git-sync-supermemory', 'SKILL.md')
  assert.ok(existsSync(skillFile), 'knowledge face generated for the migrated capability')
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
  const skillFile = join(ws, '.dsh', 'skills', 'sm-r50-facts', 'SKILL.md')
  assert.ok(existsSync(skillFile), 'SKILL.md written under the project skill root')
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
  // Manual skill without markers: first auto touch appends facts only.
  const manualDir = join(ws, '.dsh', 'skills', 'sm-r50-manual', 'SKILL.md')
  mkdirSync(join(ws, '.dsh', 'skills', 'sm-r50-manual'), { recursive: true })
  const manualBody = '---\nname: sm-r50-manual\ndescription: "手工"\n---\n\n# 手工正文\n\n不要改我。\n'
  writeFileSync(manualDir, manualBody, 'utf8')
  const manualStore = fakeStore()
  const migrated = await capability.migrateCapabilities(manualStore, { root: join(ws, '.dsh', 'skills') })
  assert.ok(migrated.linkedSkills >= 1, 'a marker-less manual skill becomes a knowledge capability')
  const manualText = readFileSync(manualDir, 'utf8')
  assert.ok(manualText.includes('不要改我。'), 'manual prose untouched')
  assert.ok(manualText.includes('<!-- sm:facts:start -->'), 'facts block appended on first touch')
  ok('R50-3 事实块：六节 + 事实块；自动刷新只改事实块；人工散文保留；无标记手工 skill 首触只追加事实块')
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
  const accepted = await capability.acceptProposal(ctx, store, pending[0].id, { root: join(ws, '.dsh', 'skills') })
  assert.equal(accepted.status, 'ok', accepted.message)
  const cap = capability.findCapabilityRow(store, { id: accepted.id })
  assert.equal(cap.record.kind, 'capability')
  assert.equal(cap.record.runnable, false, 'accepted draft stays non-runnable')
  assert.equal(cap.record.entryVerified, false)
  assert.equal(cap.record.entry, '', 'draft is not promoted to entry')
  assert.ok(existsSync(join(ws, '.dsh', 'skills', 'sm-r50-proposal', 'SKILL.md')), 'acceptance generates the knowledge face')
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
  const rootSkills = join(root, 'cap-root', '.dsh', 'skills')
  mkdirSync(rootSkills, { recursive: true })
  for (let index = 0; index < 8; index += 1) {
    const built = capability.buildCapabilityRecord({ name: 'r50-auto-' + index, description: 'auto', entry: 'echo x' })
    built.record.source = 'auto'
    built.record.skillPath = join(rootSkills, 'sm-r50-auto-' + index, 'SKILL.md')
    mkdirSync(join(rootSkills, 'sm-r50-auto-' + index), { recursive: true })
    writeFileSync(built.record.skillPath, '---\nname: sm-r50-auto-' + index + '\ndescription: "x"\n---\n\n# x\n')
    await capability.saveCapabilityRecord(capStore, built.record, { workspaceKey })
  }
  const ninth = await capability.createProposal(capStore, {
    workspaceKey, name: 'r50-ninth', title: '第九', description: 'ninth', body: '# x', source: 'auto',
  })
  const { ctx } = ctxOf()
  const accepted = await capability.acceptProposal(ctx, capStore, ninth.id, { root: rootSkills })
  assert.equal(accepted.status, 'error', 'the 9th auto capability is refused')
  assert.match(accepted.message, /上限 8/)
  ok('R50-7 上限：pending ≤20、每 skills 根自动生成 ≤8、30 天过期')
}

// ---- R50-8 删除归档 ----
{
  const store = fakeStore()
  const { ctx } = ctxOf()
  const reg = await capability.registerCapability(ctx, store, {
    name: 'r50-delete', description: '删除归档', entry: 'echo del', scope: ws,
  }, workspaceKey)
  const skillFile = join(ws, '.dsh', 'skills', 'sm-r50-delete', 'SKILL.md')
  assert.ok(existsSync(skillFile))
  const deleted = await capability.deleteCapability(ctx, store, reg.id)
  assert.equal(deleted.status, 'ok', deleted.message)
  assert.equal(store.toolMemory.get(reg.id), undefined, 'row removed')
  assert.ok(deleted.archivePath && existsSync(deleted.archivePath), 'skill directory archived, not hard-deleted')
  assert.ok(!existsSync(skillFile), 'original skill directory is gone (moved)')
  ok('R50-8 删除：知识面归档到 <root>-archive，行删除，可回滚')
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

rmSync(root, { recursive: true, force: true })
console.log('\ncapability-smoke: ' + passed + ' groups passed')
process.exit(0)
