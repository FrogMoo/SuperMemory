/**
 * skill-smoke — R45「重复工作 → DSH skill」的源级单测（host-free）：
 *   R45-S1 草稿生成：重复信号 → kebab-case 名 + 500 字内路由描述 + 正文必备小节；
 *      命令/文件从真实样本提取（不是命令日志堆砌）。
 *   R45-S2 落盘：SKILL.md 真实写入 <root>/<name>/SKILL.md，frontmatter 可被宿主
 *      provider 解析（name/description/whenToUse/disable-model-invocation）；
 *      tool_memory 只镜像 kind='skill' 行。
 *   R45-S3 幂等：内容相同（仅统计变化）→ unchanged、不升版，正文不变。
 *   R45-S4 升版：定义变化 → version+1、changelog 最新在前并保留 v1。
 *   R45-S5 人工编辑保护：正文被手工改过 → preserved，不覆盖正文。
 *   R45-S6 启用/停用：disable-model-invocation 与行状态同步。
 *   R45-S7 改描述：只改 frontmatter description，正文保持，version+1。
 *   R45-S8 重复事务识别：信号（达阈值/未达/nearmiss）+ 能力执行次数 → 草稿；
 *      sync 落盘；能力 skill 名 sm-cap-*。
 *   R45-S9 无 git 工作区：回退 <DSH_HOME>/skills，名字带 sm-ws<token>- 前缀隔离。
 *   R45-S10 项目根：含 .git 的工作区落到 <项目根>/.dsh/skills（宿主最高优先级）。
 *   R45-S11 面板：SupermemoryPanelService.listSkills/updateSkill 可见且可启停。
 *   R45-S12 兼容：kind='skill' 行不会被组合工具注册（activeComposites 忽略它）。
 * Usage: node scripts/skill-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  draftSkillFromCapability, draftSkillFromManual, draftSkillFromSignal, extractWorkflowFacts,
  listSkills, parseSkillMarkdown, persistSequenceSkill, persistSkillDraft, resolveSkillRoot,
  setSkillEnabled, skillNameForCapability, skillNameForFlow, syncRepeatedTransactions,
  updateSkillDescription, workspaceSkillToken, SKILL_DESCRIPTION_MAX,
} = await import('../src/skill-forge.ts')
const { activeComposites } = await import('../src/toolize.ts')
const { SupermemoryPanelService } = await import('../src/panel.ts')
const { workspaceKeyOf } = await import('../src/store.ts')

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const quiet = { info: () => {}, warn: () => {} }

function table(seed = []) {
  const map = new Map(seed)
  return {
    get: (key) => map.get(key),
    keys: () => map.keys(),
    get size() { return map.size },
    entries: () => map.entries(),
    put: async (key, value) => { map.set(key, value) },
    update: async (key, fn) => { map.set(key, fn(map.get(key))) },
    delete: async (key) => map.delete(key),
  }
}
const fakeStore = (seed = {}) => ({
  toolMemory: table(seed.toolMemory ?? []),
  signals: table(seed.signals ?? []),
})

let passed = 0
const ok = (label) => { passed += 1; console.log('ok - ' + label) }

const roots = []
function tempDir(prefix = 'sm-skill-smoke-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}
function gitProject() {
  const dir = tempDir('sm-skill-git-')
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}
function sample(tools, args) { return [{ tools, args }] }
const FLOW = ['read', 'grep', 'edit', 'bash']
const FLOW_SAMPLE = sample(FLOW, [
  { file_path: 'src/example.ts' },
  { pattern: 'needle' },
  { file_path: 'src/example.ts' },
  { command: 'pnpm typecheck', description: 'typecheck' },
])

// ---- S1 草稿生成 ----
{
  const signal = {
    workspaceKey: 'ws-s1', pattern: 'read>grep>edit>bash', count: 4, lastSeen: Date.now(),
    examples: [], sequence: FLOW, samples: [],
  }
  const draft = draftSkillFromSignal(signal, FLOW_SAMPLE)
  assert.ok(draft, 'signal 应生成草稿')
  assert.match(draft.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'name 必须 kebab-case: ' + draft.name)
  assert.ok(draft.name.startsWith('sm-flow-read-grep-edit-bash-'), 'name 带可读前缀: ' + draft.name)
  assert.ok(draft.description.length <= SKILL_DESCRIPTION_MAX, '描述不超过目录上限')
  assert.ok(draft.description.includes('read → grep → edit → bash'), '描述写清何时用（流程）')
  for (const section of ['## 何时用', '## 决策清单', '## 步骤纲要', '## 关键坑', '## 验证方式', '## 反例', '## 调用与命中统计']) {
    assert.ok(draft.body.includes(section), '正文缺少小节: ' + section)
  }
  const facts = extractWorkflowFacts(FLOW_SAMPLE)
  assert.deepEqual(facts.commands, ['pnpm typecheck', 'typecheck'], '命令从样本提取')
  assert.deepEqual(facts.files, ['src/example.ts'], '文件组合从样本提取')
  assert.ok(draft.body.includes('pnpm typecheck'), '正文含可复用命令')
  assert.equal(skillNameForFlow(FLOW), draft.name, '同一流程名字稳定')
  ok('R45-S1 草稿：kebab 名 + 路由描述 + 必备小节 + 命令/文件提取')
}

// ---- S2 落盘 ----
{
  const store = fakeStore()
  const root = tempDir()
  const result = await persistSequenceSkill(store, 'ws-s2', FLOW, FLOW_SAMPLE, 3, { root })
  assert.equal(result.status, 'created')
  assert.equal(result.version, 1)
  const text = readFileSync(result.path, 'utf8')
  assert.ok(text.startsWith('---\nname: ' + result.name + '\n'), 'frontmatter 以 name 开头')
  const parsed = parseSkillMarkdown(text, result.name)
  assert.ok(parsed, '宿主 provider 同款解析必须成功')
  assert.equal(parsed.name, result.name)
  assert.ok(parsed.description.length > 0)
  assert.equal(parsed.enabled, true, '默认启用')
  assert.equal(parsed.version, 1)
  assert.equal(parsed.occurrences, 3)
  assert.ok(parsed.body.includes('## 决策清单'), '正文已落盘')
  const row = store.toolMemory.get('ws/ws-s2/skill/' + result.name)
  assert.ok(row, 'tool_memory 镜像行存在')
  assert.equal(row.kind, 'skill')
  assert.equal(row.entry, result.path)
  assert.equal(row.status, 'active')
  assert.equal(row.useCount, 0)
  const views = listSkills(store, 'ws-s2', { root, scope: 'project', shared: false, note: '' })
  assert.equal(views.length, 1)
  assert.equal(views[0].version, 1)
  ok('R45-S2 落盘：SKILL.md + frontmatter 可解析 + tool_memory mirror + listSkills')
}

// ---- S3 幂等（只变统计不升版） ----
{
  const store = fakeStore()
  const root = tempDir()
  const first = await persistSequenceSkill(store, 'ws-s3', FLOW, FLOW_SAMPLE, 3, { root })
  const before = readFileSync(first.path, 'utf8')
  const again = await persistSequenceSkill(store, 'ws-s3', FLOW, FLOW_SAMPLE, 9, { root })
  const after = readFileSync(again.path, 'utf8')
  assert.equal(again.status, 'unchanged', '同定义重复生成必须幂等')
  assert.equal(again.version, 1, '不升版')
  const beforeParsed = parseSkillMarkdown(before, first.name)
  const afterParsed = parseSkillMarkdown(after, first.name)
  assert.equal(afterParsed.body, beforeParsed.body, '正文逐字不变')
  assert.equal(afterParsed.occurrences, 9, '统计仍更新到 frontmatter')
  assert.deepEqual(afterParsed.changelog, beforeParsed.changelog, 'changelog 不变')
  ok('R45-S3 幂等：内容相同 → unchanged、正文/changelog 不变、统计更新')
}

// ---- S4 升版 + changelog ----
{
  const store = fakeStore()
  const root = tempDir()
  const draft = draftSkillFromSignal({
    workspaceKey: 'ws-s4', pattern: FLOW.join('>'), count: 3, lastSeen: Date.now(), examples: [], sequence: FLOW, samples: [],
  }, FLOW_SAMPLE)
  const first = await persistSkillDraft(store, 'ws-s4', draft, { root, now: 1000 })
  assert.equal(first.version, 1)
  const changed = { ...draft, description: draft.description + '（新坑：并发分支只做精确编辑）' }
  const second = await persistSkillDraft(store, 'ws-s4', changed, { root, now: 2000 })
  assert.equal(second.status, 'updated')
  assert.equal(second.version, 2)
  const parsed = parseSkillMarkdown(readFileSync(second.path, 'utf8'), second.name)
  assert.equal(parsed.version, 2)
  assert.ok(parsed.changelog[0].startsWith('v2:'), 'changelog 最新在前: ' + parsed.changelog[0])
  assert.ok(parsed.changelog.some((line) => line.startsWith('v1:')), 'v1 保留')
  assert.ok(parsed.description.includes('新坑'), '新描述生效')
  ok('R45-S4 升版：version+1、changelog 最新在前且保留 v1')
}

// ---- S5 人工编辑保护 ----
{
  const store = fakeStore()
  const root = tempDir()
  const draft = draftSkillFromSignal({
    workspaceKey: 'ws-s5', pattern: FLOW.join('>'), count: 3, lastSeen: Date.now(), examples: [], sequence: FLOW, samples: [],
  }, FLOW_SAMPLE)
  const first = await persistSkillDraft(store, 'ws-s5', draft, { root })
  const file = first.path
  writeFileSync(file, readFileSync(file, 'utf8') + '\n## 人工补充\n- 本地环境需要先跑 pnpm install。\n')
  const second = await persistSkillDraft(store, 'ws-s5', { ...draft, description: draft.description + '（插件新描述）' }, { root })
  const text = readFileSync(file, 'utf8')
  assert.equal(second.status, 'preserved', '检测到人工编辑应保留正文: ' + second.status)
  assert.ok(text.includes('## 人工补充'), '人工正文仍在')
  assert.ok(!text.includes('插件新描述'), '不覆盖人工编辑')
  assert.equal(second.version, 1, '统计更新不升版')
  ok('R45-S5 人工编辑保护：preserved，正文不被覆盖')
}

// ---- S6 启用/停用 ----
{
  const store = fakeStore()
  const root = tempDir()
  const scope = { root, scope: 'project', shared: false, note: '' }
  const first = await persistSequenceSkill(store, 'ws-s6', FLOW, FLOW_SAMPLE, 3, { root })
  const off = await setSkillEnabled(store, 'ws-s6', scope, first.name, false)
  assert.equal(off.status, 'updated')
  let parsed = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name)
  assert.equal(parsed.enabled, false)
  assert.ok(readFileSync(first.path, 'utf8').includes('disable-model-invocation: true'))
  assert.equal(store.toolMemory.get('ws/ws-s6/skill/' + first.name).status, 'retired')
  assert.equal(listSkills(store, 'ws-s6', scope)[0].enabled, false)
  const on = await setSkillEnabled(store, 'ws-s6', scope, first.name, true)
  assert.equal(on.status, 'updated')
  parsed = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name)
  assert.equal(parsed.enabled, true)
  assert.equal(store.toolMemory.get('ws/ws-s6/skill/' + first.name).status, 'active')
  // 启停是元数据操作，不是人工内容编辑：之后定义变化仍应正常升版。
  const draft = draftSkillFromSignal({
    workspaceKey: 'ws-s6', pattern: FLOW.join('>'), count: 4, lastSeen: Date.now(), examples: [], sequence: FLOW, samples: [],
  }, FLOW_SAMPLE)
  const afterToggle = await persistSkillDraft(store, 'ws-s6', { ...draft, description: draft.description + '（新坑）' }, { root })
  assert.equal(afterToggle.status, 'updated', '启停后仍可正常升版: ' + afterToggle.status)
  const escape = await setSkillEnabled(store, 'ws-s6', scope, '../evil', false)
  assert.equal(escape.status, 'error', '非法名（路径穿越）必须拒绝')
  ok('R45-S6 启停：disable-model-invocation 与行状态同步（不污染人工编辑检测，非法名拒绝）')
}

// ---- S7 改描述 ----
{
  const store = fakeStore()
  const root = tempDir()
  const scope = { root, scope: 'project', shared: false, note: '' }
  const first = await persistSequenceSkill(store, 'ws-s7', FLOW, FLOW_SAMPLE, 3, { root })
  const bodyBefore = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name).body
  const upd = await updateSkillDescription(store, 'ws-s7', scope, first.name, '当需要在多个文件里定位并精确修改同一模式时加载（人工改写）')
  assert.equal(upd.status, 'updated')
  assert.equal(upd.version, 2)
  const parsed = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name)
  assert.equal(parsed.description, '当需要在多个文件里定位并精确修改同一模式时加载（人工改写）')
  assert.equal(parsed.body, bodyBefore, '正文不变')
  assert.equal(store.toolMemory.get('ws/ws-s7/skill/' + first.name).description, parsed.description)
  ok('R45-S7 改描述：只改 frontmatter，正文不变，version+1')
}

// ---- S8 重复事务识别（信号 + 能力执行） ----
{
  const ws = 'ws-s8'
  const signals = [
    ['ws/' + ws + '/seq/read>grep>edit', {
      workspaceKey: ws, pattern: 'read>grep>edit', count: 5, lastSeen: Date.now(), examples: [], sequence: ['read', 'grep', 'edit'], samples: [],
    }],
    ['ws/' + ws + '/seq/read>write', {
      workspaceKey: ws, pattern: 'read>write', count: 1, lastSeen: Date.now(), examples: [], sequence: ['read', 'write'], samples: [],
    }],
    ['ws/' + ws + '/nearmiss/x', {
      workspaceKey: ws, pattern: 'nearmiss:sm_composite_x', count: 9, lastSeen: Date.now(), examples: [], sequence: ['read', 'edit'], samples: [],
    }],
  ]
  const capSpec = {
    name: 'git-sync-supermemory', kind: 'capability', title: 'git 同步', entry: 'pnpm git:sync', doc: 'docs/git-sync.md',
    scope: REPO_ROOT, dryRunArg: '--dry-run', writeConfirm: true, description: 'git 同步',
  }
  const store = fakeStore({
    signals,
    toolMemory: [[
      'cap-1',
      { kind: 'composite', entry: JSON.stringify(capSpec), useCount: 5, status: 'active', title: capSpec.title, tags: [], description: capSpec.description, trigger: 'capability/git-sync-supermemory', workspaceKey: ws, createdAt: 1 },
    ]],
  })
  const root = tempDir()
  const scope = { root, scope: 'project', shared: false, note: '' }
  const { drafts, results } = await syncRepeatedTransactions(store, ws, scope, { threshold: 3 })
  assert.equal(drafts.length, 2, '达阈值序列 + 能力 = 2 条草稿; 未达阈值/nearmiss 排除')
  assert.ok(drafts.some((draft) => draft.name.startsWith('sm-flow-read-grep-edit')))
  assert.ok(drafts.some((draft) => draft.name.startsWith('sm-cap-git-sync-supermemory')))
  assert.equal(skillNameForCapability('git-sync-supermemory'), drafts.find((d) => d.source.kind === 'capability').name)
  assert.equal(results.filter((r) => r.status === 'created').length, 2)
  const views = listSkills(store, ws, scope)
  assert.equal(views.length, 2)
  assert.ok(views.some((view) => view.source === 'capability'))
  ok('R45-S8 识别：阈值/nearmiss 过滤 + 能力执行 → sm-cap-* 草稿并落盘')
}

// ---- S9 无 git 工作区：共享目录 + 名前缀隔离 ----
{
  const projectless = tempDir('sm-skill-nogit-')
  const dshHome = tempDir('sm-skill-home-')
  const info = resolveSkillRoot(projectless, dshHome)
  assert.equal(info.scope, 'user')
  assert.equal(info.shared, true)
  assert.equal(info.root, join(dshHome, 'skills'))
  const store = fakeStore()
  const tokenA = workspaceSkillToken('ws-a')
  const tokenB = workspaceSkillToken('ws-b')
  const a = await persistSequenceSkill(store, 'ws-a', FLOW, FLOW_SAMPLE, 3, { root: info.root, shared: true })
  const b = await persistSequenceSkill(store, 'ws-b', FLOW, FLOW_SAMPLE, 3, { root: info.root, shared: true })
  assert.ok(a.name.startsWith('sm-' + tokenA + '-'), '共享目录名字带工作区 token: ' + a.name)
  assert.ok(b.name.startsWith('sm-' + tokenB + '-'))
  assert.notEqual(a.name, b.name, '不同工作区不互相覆盖')
  const listA = listSkills(store, 'ws-a', info)
  const listB = listSkills(store, 'ws-b', info)
  assert.deepEqual(listA.map((row) => row.name), [a.name], 'A 只看到自己的 skill')
  assert.deepEqual(listB.map((row) => row.name), [b.name], 'B 只看到自己的 skill')
  ok('R45-S9 无 git：回退 <DSH_HOME>/skills，sm-ws*- 前缀隔离')
}

// ---- S10 项目根推导 ----
{
  const project = gitProject()
  const info = resolveSkillRoot(join(project, 'nested'))
  assert.equal(info.scope, 'project')
  assert.equal(info.root, join(project, '.dsh', 'skills'))
  assert.equal(resolveSkillRoot(REPO_ROOT).root, join(REPO_ROOT, '.dsh', 'skills'), '本仓库根会被识别')
  ok('R45-S10 项目根：<repo>/.dsh/skills（宿主 rank 100，重启后仍在）')
}

// ---- S11 面板可见 + 启停 ----
{
  const project = gitProject()
  const store = fakeStore()
  const scope = { root: join(project, '.dsh', 'skills'), scope: 'project', shared: false, note: '' }
  const first = await persistSequenceSkill(store, workspaceKeyOf(project), FLOW, FLOW_SAMPLE, 3, { root: scope.root })
  const panel = new SupermemoryPanelService(store)
  const rows = panel.listSkills(project)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, first.name)
  assert.equal(rows[0].version, 1)
  const toggled = await panel.updateSkill(project, first.name, { enabled: false })
  assert.equal(toggled.status, 'ok')
  assert.equal(panel.listSkills(project)[0].enabled, false)
  const described = await panel.updateSkill(project, first.name, { description: '面板改写的路由描述' })
  assert.equal(described.status, 'ok')
  assert.equal(panel.listSkills(project)[0].description, '面板改写的路由描述')
  ok('R45-S11 面板：listSkills 可见、updateSkill 启停/改描述')
}

// ---- S12 兼容：skill 行不被组合工具注册 ----
{
  const store = fakeStore()
  const root = tempDir()
  const first = await persistSequenceSkill(store, 'ws-s12', FLOW, FLOW_SAMPLE, 3, { root })
  const seqSpec = { name: 'sm_composite_read_edit', description: '旧组合工具', steps: [{ tool: 'read', arguments: {} }, { tool: 'edit', arguments: {} }], parameters: [] }
  await store.toolMemory.put('tm-seq', {
    kind: 'composite', entry: JSON.stringify(seqSpec), useCount: 2, status: 'active', title: '', tags: [], description: seqSpec.description, trigger: 'ws/ws-s12/seq/read>edit', workspaceKey: 'ws-s12', createdAt: 1,
  })
  const actives = activeComposites(store)
  assert.equal(actives.length, 1, 'skill 行不得进入组合工具注册')
  assert.equal(actives[0].spec.name, 'sm_composite_read_edit')
  assert.ok(store.toolMemory.get('ws/ws-s12/skill/' + first.name), 'skill 行仍在')
  ok('R45-S12 兼容：kind=skill 行被 activeComposites 忽略，旧 sm_composite_* 照常工作')
}

// ---- S13 手工登记 ----
{
  const store = fakeStore()
  const root = tempDir()
  const draft = draftSkillFromManual({
    name: 'Manual Skill', title: '手工登记示例',
    description: '当需要按仓库约定提交前跑 typecheck 时加载',
    whenToUse: '提交前',
    body: '## 何时用\n- 提交前\n\n## 验证方式\n- pnpm typecheck',
    tags: ['git', '提交'],
  })
  assert.equal(draft.name, 'sm-manual-skill')
  const result = await persistSkillDraft(store, 'ws-s13', draft, { root })
  assert.equal(result.status, 'created')
  const parsed = parseSkillMarkdown(readFileSync(result.path, 'utf8'), draft.name)
  assert.equal(parsed.whenToUse, '提交前')
  assert.ok(parsed.body.includes('pnpm typecheck'))
  ok('R45-S13 手工登记：memory_toolize register 的 skill 路径可落盘')
}

// ---- S14 运行时接线：recordTurnSequences 跨阈值 → 自动生成 skill ----
{
  const project = gitProject()
  const store = fakeStore()
  const { recordTurnSequences } = await import('../src/toolize.ts')
  // 短 turn 的整段序列与 2 步窗口会合并计数（occurrences=2），所以阈值用 3：
  // 第一次 tick count=2 未跨，第二次 count=4 跨过。
  const config = {
    enabled: false, autoSkill: true, threshold: 3, cooldownMs: 0, maxActive: 8,
    minSteps: 2, minDistinctTools: 2, nearMissHint: false, recycleIdleDays: 0,
  }
  const tools = ['read', 'edit']
  const args = [{ file_path: 'src/a.ts' }, { file_path: 'src/a.ts' }]
  await recordTurnSequences({}, store, workspaceKeyOf(project), tools, args, config, quiet)
  assert.equal(store.signals.size > 0, true, '信号已记录')
  assert.equal(activeComposites(store).length, 0, 'autoSkill 打开但组合工具关闭')
  assert.equal(listSkills(store, workspaceKeyOf(project), resolveSkillRoot(project)).length, 0, '未达阈值不生成')
  await recordTurnSequences({}, store, workspaceKeyOf(project), tools, args, config, quiet)
  const views = listSkills(store, workspaceKeyOf(project), resolveSkillRoot(project))
  assert.equal(views.length, 1, '跨阈值后生成 1 个 skill: ' + JSON.stringify(views.map((v) => v.name)))
  assert.ok(views[0].path.startsWith(join(project, '.dsh', 'skills')), '落在项目 skill 目录')
  assert.equal(views[0].version, 1)
  await recordTurnSequences({}, store, workspaceKeyOf(project), tools, args, config, quiet)
  assert.equal(listSkills(store, workspaceKeyOf(project), resolveSkillRoot(project))[0].version, 1, '再次 tick 不重复升版')
  ok('R45-S14 接线：recordTurnSequences 跨阈值自动落 skill（组合工具关闭，重复 tick 幂等）')
}

// ---- S15 启动扫尾：已跨阈值的 durable signal → skill ----
{
  const project = gitProject()
  const ws = workspaceKeyOf(project)
  const store = fakeStore({
    signals: [['ws/' + ws + '/seq/read>write', {
      workspaceKey: ws, pattern: 'read>write', count: 7, lastSeen: Date.now(), examples: [], sequence: ['read', 'write'], samples: [],
    }]],
  })
  const { sweepSkillDrafts } = await import('../src/toolize.ts')
  const created = await sweepSkillDrafts(store, {
    enabled: false, autoSkill: true, threshold: 3, cooldownMs: 0, maxActive: 8,
    minSteps: 2, minDistinctTools: 2, nearMissHint: false, recycleIdleDays: 0,
  }, quiet)
  assert.equal(created, 1, '启动扫尾应生成 1 个')
  assert.equal(listSkills(store, ws, resolveSkillRoot(project)).length, 1)
  assert.equal(await sweepSkillDrafts(store, {
    enabled: false, autoSkill: false, threshold: 3, cooldownMs: 0, maxActive: 8,
    minSteps: 2, minDistinctTools: 2, nearMissHint: false, recycleIdleDays: 0,
  }, quiet), 0, 'autoSkill 关闭时扫尾不动')
  ok('R45-S15 启动扫尾：已跨阈值信号补生成 skill，关闭时不动作')
}

// ---- S16 自动增长上限（防 skill 目录被滑动窗口刷爆） ----
{
  const store = fakeStore()
  const root = tempDir()
  const results = []
  for (let index = 0; index < 13; index += 1) {
    results.push(await persistSequenceSkill(store, 'ws-s16', ['read', 'edit', 'tool' + index], sample(['read', 'edit', 'tool' + index], [{}, {}, {}]), 3, { root }))
  }
  assert.equal(results.filter(Boolean).length, 12, '自动路径最多生成 12 个: ' + results.filter(Boolean).length)
  assert.equal(results[12], undefined, '第 13 个自动草稿被上限拒绝')
  assert.equal(listSkills(store, 'ws-s16', { root, scope: 'project', shared: false, note: '' }).length, 12)
  // 已存在名字的更新不受上限影响。
  const again = await persistSequenceSkill(store, 'ws-s16', ['read', 'edit', 'tool0'], sample(['read', 'edit', 'tool0'], [{}, {}, {}]), 4, { root })
  assert.equal(again.status, 'unchanged')
  ok('R45-S16 上限：自动路径最多 12 个/根；已存在 skill 仍可更新')
}

for (const root of roots) { try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } }
console.log('\nskill-smoke: ' + passed + ' 组断言通过')
