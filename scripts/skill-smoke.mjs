/**
 * skill-smoke — R45/R48「重复任务 → DSH skill」的源级单测（host-free）：
 *
 * 核心机制（沿用 R45 编号，语义改为任务级）：
 *   S1  任务级草稿：任务签名 → kebab 名（不含 flow/bash）+ 路由描述 + 六节正文
 *   S2  落盘：SKILL.md + frontmatter（含 sm-task-key）+ tool_memory mirror
 *   S3  幂等：内容相同（仅统计变化）→ unchanged、不升版
 *   S4  升版：定义变化 → version+1、changelog 最新在前并保留 v1
 *   S5  人工编辑保护：preserved，正文不被覆盖
 *   S6  启用/停用：disable-model-invocation 与行状态同步，task key 保留
 *   S7  改描述：只改 frontmatter，正文不变，version+1
 *   S8  识别：任务级阈值/跨会话/时间衰减 + 能力执行；legacy 序列被忽略
 *   S9  无 git 工作区：回退 <DSH_HOME>/skills，名字带 sm-ws<token>- 前缀
 *   S10 项目根：含 .git 的工作区落到 <项目根>/.dsh/skills
 *   S11 面板：listSkills/updateSkill 可见且可启停/改描述
 *   S12 兼容：kind='skill' 行不会被组合工具注册
 *   S13 手工登记：memory_toolize register 的 skill 路径可落盘
 *   S14 接线：recordTurnSequences 跨阈值 + 跨会话自动生成任务 skill
 *   S15 启动扫尾：task 信号补生成；legacy seq 信号永不生成
 *   S16 上限：每个根最多 8 个自动 skill；manual 不占额度；已存在可更新
 *
 * R48 机制修正：
 *   S17 任务签名抽取：纯工具序列/泛化 bash/无可命名对象一律不产出
 *   S18 合并同类：同一任务签名的不同工具序列 → 一个 signal → 一个 skill
 *   S19 壳子不生成：legacy 序列信号不产生任何 skill 文件
 *   S20 命名与描述：真实任务 → sync-gitee-github / release-package-tgz 等
 *   S21 阈值与衰减：≥3 次、≥2 会话、30 天内有发生才生成
 *   S22 存量清理：只归档自动 shell skill，manifest 可回滚，二次执行幂等
 *   S23 人工 register：清理不碰 manual，之后仍可正常升版
 *
 * Usage: node scripts/skill-smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  archiveDirForRoot, archiveShellSkills, draftSkillFromCapability, draftSkillFromManual,
  draftSkillFromTaskSignal, extractWorkflowFacts, isReadableTaskSkillName, isShellSkill,
  listSkills, parseSkillMarkdown, persistSkillDraft, persistTaskSkillForSignature,
  readSkillFiles, recordTaskObservation, resolveSkillRoot, setSkillEnabled,
  signatureFromSignal, skillNameForCapability, skillNameForTask, syncRepeatedTransactions,
  updateSkillDescription, workspaceSkillToken, SKILL_DESCRIPTION_MAX, SKILL_MAX_PER_ROOT,
  SKILL_MIN_SESSIONS, SKILL_RECENCY_DAYS,
} = await import('../src/skill-forge.ts')
const {
  extractTaskSignature, looksLikeToolFlowName, taskNameSimilarity,
} = await import('../src/task-signature.ts')
const { activeComposites } = await import('../src/toolize.ts')
const { SupermemoryPanelService } = await import('../src/panel.ts')
const { workspaceKeyOf } = await import('../src/store.ts')

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const quiet = { info: () => {}, warn: () => {} }
const DAY = 86400000
const NOW = Date.now()

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
  dispatches: table(seed.dispatches ?? []),
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
function scopeOf(root, shared = false) {
  return { root, scope: shared ? 'user' : 'project', shared, note: '' }
}

const TASK = '修复自动生成的 skill 只是工具序列壳子：改为任务级识别并清理低价值技能'
const TASK_OBS = () => ({
  task: TASK,
  tools: ['read', 'edit', 'bash'],
  args: [
    { file_path: 'src/skill-forge.ts' },
    { file_path: 'src/skill-forge.ts' },
    { command: 'pnpm typecheck' },
  ],
})
const sampleJson = (observation) => JSON.stringify({
  tools: observation.tools,
  args: observation.args,
  ...(observation.task ? { task: observation.task } : {}),
  ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
  ...(observation.dispatchId ? { dispatchId: observation.dispatchId } : {}),
  at: NOW,
})

/** Seed one durable task signal (exactly the shape recordTaskObservation writes). */
function taskSignal(seed) {
  const samples = seed.samples ?? [sampleJson({ task: seed.task ?? TASK, tools: seed.tools ?? ['read', 'edit'], args: seed.args ?? [{ file_path: 'src/skill-forge.ts' }, { file_path: 'src/skill-forge.ts' }], sessionId: (seed.sessions ?? ['s1'])[0] })]
  return {
    workspaceKey: seed.workspaceKey,
    pattern: 'task:' + (seed.key ?? 'fix/skill'),
    count: seed.count ?? 3,
    lastSeen: seed.lastSeen ?? NOW,
    examples: [seed.task ?? TASK],
    sequence: (seed.tools ?? ['read', 'edit']),
    samples,
    sessions: seed.sessions ?? ['s1', 's2'],
    dispatches: seed.dispatches ?? [],
  }
}

/** Record 3 observations across 2 sessions and persist the crossed task skill. */
async function persistOneTask(store, workspaceKey, root, options = {}) {
  const observation = TASK_OBS()
  const sessions = [options.sessionId ?? 's1', options.sessionId ?? 's1', options.secondSession ?? 's2']
  for (let index = 0; index < 3; index += 1) {
    await recordTaskObservation(store, workspaceKey, { ...observation, sessionId: sessions[index], ...(options.dispatchId ? { dispatchId: options.dispatchId } : {}) }, { threshold: 3, now: NOW + index })
  }
  return persistTaskSkillForSignature(store, workspaceKey, 'fix/skill', {
    threshold: 3, minSessions: 2, now: NOW + 10, root, ...(options.shared ? { shared: true } : {}),
  })
}

// ---- S1 任务级草稿 ----
{
  const observation = TASK_OBS()
  const signature = extractTaskSignature({ ...observation, sessionId: 's1' })
  assert.ok(signature, '有效任务必须产出签名')
  assert.equal(signature.key, 'fix/skill', 'key 来自任务动词+对象: ' + signature.key)
  assert.equal(signature.nameBase, 'fix-skill')
  assert.ok(signature.files.includes('src/skill-forge.ts'), '文件族来自真实样本: ' + signature.files.join(','))
  assert.ok(signature.commands.includes('pnpm typecheck'), '命令家族来自真实样本: ' + signature.commands.join(','))
  assert.ok(signature.confidence >= 0.5)
  const signal = taskSignal({ workspaceKey: 'ws-s1', pattern: 'task:fix/skill', key: 'fix/skill', count: 4, sessions: ['s1', 's2'] })
  const samples = [{ ...observation, sessionId: 's1' }, { ...observation, sessionId: 's2' }]
  const draft = draftSkillFromTaskSignal(signal, samples, { signature, sessions: 2 })
  assert.ok(draft, '任务信号应生成草稿')
  assert.equal(draft.name, 'sm-fix-skill')
  assert.match(draft.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(isReadableTaskSkillName(draft.name))
  assert.ok(!draft.name.includes('flow') && !draft.name.includes('bash'), '名字不得是工具序列: ' + draft.name)
  assert.equal(draft.taskKey, 'fix/skill')
  assert.ok(draft.description.length <= SKILL_DESCRIPTION_MAX)
  assert.ok(draft.description.includes('修复 skill'), '描述写清什么任务: ' + draft.description)
  assert.ok(!draft.description.includes('→'), '描述不得写工具顺序')
  for (const section of ['## 何时用（触发条件）', '## 决策清单', '## 步骤纲要', '## 关键坑', '## 验证方式', '## 反例（不要这样用）']) {
    assert.ok(draft.body.includes(section), '正文缺少小节: ' + section)
  }
  const facts = extractWorkflowFacts(samples)
  assert.ok(facts.commands.includes('pnpm typecheck'), '命令从真实样本提取')
  assert.ok(facts.files.includes('src/skill-forge.ts'), '文件从真实样本提取')
  assert.ok(draft.body.includes('pnpm typecheck'), '正文含可复用命令')
  assert.ok(draft.body.includes('src/skill-forge.ts'), '正文含真实文件')
  assert.equal(skillNameForTask(signature), draft.name, '同一签名名字稳定')
  ok('R48-S1 任务草稿：任务签名 → 可读 kebab 名 + 任务级描述 + 六节正文 + 真实事实')
}

// ---- S2 落盘 ----
{
  const store = fakeStore()
  const root = tempDir()
  const signature = extractTaskSignature({ ...TASK_OBS(), sessionId: 's1' })
  const signal = taskSignal({ workspaceKey: 'ws-s2', key: signature.key, count: 3, sessions: ['s1', 's2'] })
  const samples = [TASK_OBS(), TASK_OBS()]
  const draft = draftSkillFromTaskSignal(signal, samples, { signature, sessions: 2 })
  const result = await persistSkillDraft(store, 'ws-s2', draft, { root, now: NOW })
  assert.equal(result.status, 'created')
  assert.equal(result.version, 1)
  const text = readFileSync(result.path, 'utf8')
  assert.ok(text.startsWith('---\nname: ' + result.name + '\n'), 'frontmatter 以 name 开头')
  const parsed = parseSkillMarkdown(text, result.name)
  assert.ok(parsed, '宿主 provider 同款解析必须成功')
  assert.equal(parsed.name, result.name)
  assert.equal(parsed.source, 'task')
  assert.equal(parsed.taskKey, 'fix/skill', 'task key 落进 frontmatter')
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.occurrences, 3)
  assert.ok(parsed.body.includes('## 决策清单'))
  const row = store.toolMemory.get('ws/ws-s2/skill/' + result.name)
  assert.ok(row, 'tool_memory 镜像行存在')
  assert.equal(row.kind, 'skill')
  assert.equal(row.entry, result.path)
  assert.equal(row.status, 'active')
  const views = listSkills(store, 'ws-s2', scopeOf(root))
  assert.equal(views.length, 1)
  assert.equal(views[0].version, 1)
  assert.equal(views[0].source, 'task')
  ok('R48-S2 落盘：SKILL.md（source=task + task key）+ 可解析 frontmatter + mirror + listSkills')
}

// ---- S3 幂等（只变统计不升版） ----
{
  const store = fakeStore()
  const root = tempDir()
  const first = await persistOneTask(store, 'ws-s3', root)
  const before = readFileSync(first.path, 'utf8')
  const observation = TASK_OBS()
  await recordTaskObservation(store, 'ws-s3', { ...observation, sessionId: 's3' }, { threshold: 3, now: NOW + 20 })
  const again = await persistTaskSkillForSignature(store, 'ws-s3', 'fix/skill', { threshold: 3, now: NOW + 21, root })
  const after = readFileSync(again.path, 'utf8')
  assert.equal(again.status, 'unchanged', '同定义重复生成必须幂等')
  assert.equal(again.version, 1, '不升版')
  const beforeParsed = parseSkillMarkdown(before, first.name)
  const afterParsed = parseSkillMarkdown(after, first.name)
  assert.equal(afterParsed.body, beforeParsed.body, '正文逐字不变')
  assert.equal(afterParsed.occurrences, 4, '统计仍更新到 frontmatter')
  assert.deepEqual(afterParsed.changelog, beforeParsed.changelog, 'changelog 不变')
  ok('R48-S3 幂等：内容相同 → unchanged、正文/changelog 不变、occurrences 更新')
}

// ---- S4 升版 + changelog ----
{
  const store = fakeStore()
  const root = tempDir()
  const signature = extractTaskSignature({ ...TASK_OBS(), sessionId: 's1' })
  const signal = taskSignal({ workspaceKey: 'ws-s4', key: signature.key })
  const draft = draftSkillFromTaskSignal(signal, [TASK_OBS(), TASK_OBS()], { signature, sessions: 2 })
  const first = await persistSkillDraft(store, 'ws-s4', draft, { root, now: 1000 })
  const changed = { ...draft, description: draft.description + '（新坑：并发分支只做精确编辑）' }
  const second = await persistSkillDraft(store, 'ws-s4', changed, { root, now: 2000 })
  assert.equal(second.status, 'updated')
  assert.equal(second.version, 2)
  const parsed = parseSkillMarkdown(readFileSync(second.path, 'utf8'), second.name)
  assert.equal(parsed.version, 2)
  assert.ok(parsed.changelog[0].startsWith('v2:'), 'changelog 最新在前: ' + parsed.changelog[0])
  assert.ok(parsed.changelog.some((line) => line.startsWith('v1:')), 'v1 保留')
  assert.equal(parsed.taskKey, 'fix/skill', '升版保留 task key')
  ok('R48-S4 升版：version+1、changelog 最新在前且保留 v1、task key 不丢')
}

// ---- S5 人工编辑保护 ----
{
  const store = fakeStore()
  const root = tempDir()
  const first = await persistOneTask(store, 'ws-s5', root)
  const file = first.path
  writeFileSync(file, readFileSync(file, 'utf8') + '\n## 人工补充\n- 本地环境需要先跑 pnpm install。\n')
  const observation = TASK_OBS()
  await recordTaskObservation(store, 'ws-s5', { ...observation, sessionId: 's3' }, { threshold: 3, now: NOW + 30 })
  const second = await persistTaskSkillForSignature(store, 'ws-s5', 'fix/skill', { threshold: 3, now: NOW + 31, root })
  const text = readFileSync(file, 'utf8')
  assert.equal(second.status, 'preserved', '检测到人工编辑应保留正文: ' + second.status)
  assert.ok(text.includes('## 人工补充'), '人工正文仍在')
  assert.equal(second.version, 1, '统计更新不升版')
  ok('R48-S5 人工编辑保护：preserved，正文不被覆盖')
}

// ---- S6 启用/停用 ----
{
  const store = fakeStore()
  const root = tempDir()
  const scope = scopeOf(root)
  const first = await persistOneTask(store, 'ws-s6', root)
  const off = await setSkillEnabled(store, 'ws-s6', scope, first.name, false)
  assert.equal(off.status, 'updated')
  let parsed = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name)
  assert.equal(parsed.enabled, false)
  assert.ok(readFileSync(first.path, 'utf8').includes('disable-model-invocation: true'))
  assert.equal(parsed.taskKey, 'fix/skill', '启停保留 task key')
  assert.equal(store.toolMemory.get('ws/ws-s6/skill/' + first.name).status, 'retired')
  assert.equal(listSkills(store, 'ws-s6', scope)[0].enabled, false)
  const on = await setSkillEnabled(store, 'ws-s6', scope, first.name, true)
  assert.equal(on.status, 'updated')
  parsed = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name)
  assert.equal(parsed.enabled, true)
  const escape = await setSkillEnabled(store, 'ws-s6', scope, '../evil', false)
  assert.equal(escape.status, 'error', '非法名（路径穿越）必须拒绝')
  ok('R48-S6 启停：disable-model-invocation 与行状态同步，task key 保留，非法名拒绝')
}

// ---- S7 改描述 ----
{
  const store = fakeStore()
  const root = tempDir()
  const scope = scopeOf(root)
  const first = await persistOneTask(store, 'ws-s7', root)
  const bodyBefore = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name).body
  const upd = await updateSkillDescription(store, 'ws-s7', scope, first.name, '当需要修复 skill 任务级识别时加载（人工改写）')
  assert.equal(upd.status, 'updated')
  assert.equal(upd.version, 2)
  const parsed = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name)
  assert.equal(parsed.description, '当需要修复 skill 任务级识别时加载（人工改写）')
  assert.equal(parsed.body, bodyBefore, '正文不变')
  assert.equal(parsed.taskKey, 'fix/skill', '改描述保留 task key')
  ok('R48-S7 改描述：只改 frontmatter，正文与 task key 不变，version+1')
}

// ---- S8 识别：任务级阈值/跨会话/衰减 + 能力 ----
{
  const ws = 'ws-s8'
  const inner = {
    workspaceKey: ws, pattern: 'task:fix/skill', count: 5, lastSeen: NOW,
    examples: [], sequence: ['read', 'edit'],
    samples: [sampleJson({ task: TASK, tools: ['read', 'edit'], args: [{ file_path: 'src/skill-forge.ts' }, { file_path: 'src/skill-forge.ts' }], sessionId: 's1' })],
    sessions: ['s1', 's2'],
  }
  const oneSession = { ...inner, pattern: 'task:add/memory', samples: [sampleJson({ task: '实现记忆版本控制', tools: ['read', 'edit'], args: [{ file_path: 'src/memory-versions.ts' }, { file_path: 'src/memory-versions.ts' }], sessionId: 's1' })], sessions: ['s1'] }
  const stale = { ...inner, pattern: 'task:sync/gitee', lastSeen: NOW - (SKILL_RECENCY_DAYS + 5) * DAY, samples: [sampleJson({ task: '同步 Gitee 远端', tools: ['bash'], args: [{ command: 'git push' }], sessionId: 's1' })], sessions: ['s1', 's2'] }
  const legacy = { workspaceKey: ws, pattern: 'bash>bash>bash', count: 99, lastSeen: NOW, examples: [], sequence: ['bash', 'bash', 'bash'], samples: ['{"tools":["bash","bash","bash"],"args":[{},{},{}]}'], sessions: ['s1', 's2'] }
  const capSpec = {
    name: 'git-sync-supermemory', kind: 'capability', title: 'git 同步', entry: 'pnpm git:sync', doc: 'docs/git-sync.md',
    scope: REPO_ROOT, dryRunArg: '--dry-run', writeConfirm: true, description: 'git 同步',
  }
  const store = fakeStore({
    signals: [['ws/' + ws + '/task/fix/skill', inner], ['ws/' + ws + '/task/add/memory', oneSession], ['ws/' + ws + '/task/sync/gitee', stale], ['ws/' + ws + '/seq/bash>bash>bash', legacy]],
    toolMemory: [[
      'cap-1',
      { kind: 'composite', entry: JSON.stringify(capSpec), useCount: 5, status: 'active', title: capSpec.title, tags: [], description: capSpec.description, trigger: 'capability/git-sync-supermemory', workspaceKey: ws, createdAt: 1 },
    ]],
  })
  const root = tempDir()
  const { drafts, results } = await syncRepeatedTransactions(store, ws, scopeOf(root), {
    threshold: 3, minSessions: 2, recencyDays: SKILL_RECENCY_DAYS, now: NOW,
  })
  assert.equal(drafts.length, 2, '合格 task + 能力 = 2 条草稿（单会话/过期/legacy 被排除）: ' + JSON.stringify(drafts.map((d) => d.name)))
  assert.ok(drafts.some((draft) => draft.name === 'sm-fix-skill'))
  assert.ok(drafts.some((draft) => draft.name === 'sm-cap-git-sync-supermemory'))
  assert.ok(!drafts.some((draft) => draft.name.includes('flow')), 'legacy 序列不得生成 flow 名')
  assert.equal(results.filter((result) => result.status === 'created').length, 2)
  const views = listSkills(store, ws, scopeOf(root))
  assert.equal(views.length, 2)
  assert.ok(views.some((view) => view.source === 'capability'))
  ok('R45-S8/R48 识别：任务阈值 + 跨 2 会话 + 时间衰减 + 能力；单会话/过期/legacy 序列排除')
}

// ---- S9 无 git 工作区：共享目录 + 名前缀隔离 ----
{
  const projectless = tempDir('sm-skill-nogit-')
  const dshHome = tempDir('sm-skill-home-')
  const info = resolveSkillRoot(projectless, dshHome)
  assert.equal(info.scope, 'user')
  assert.equal(info.shared, true)
  assert.equal(info.root, join(dshHome, 'skills'))
  const storeA = fakeStore()
  const storeB = fakeStore()
  const tokenA = workspaceSkillToken('ws-a')
  const tokenB = workspaceSkillToken('ws-b')
  const a = await persistOneTask(storeA, 'ws-a', info.root, { shared: true })
  const b = await persistOneTask(storeB, 'ws-b', info.root, { shared: true })
  assert.ok(a.name.startsWith('sm-' + tokenA + '-'), '共享目录名字带工作区 token: ' + a.name)
  assert.ok(b.name.startsWith('sm-' + tokenB + '-'))
  assert.notEqual(a.name, b.name, '不同工作区不互相覆盖')
  assert.deepEqual(listSkills(storeA, 'ws-a', info).map((row) => row.name), [a.name], 'A 只看到自己的 skill')
  assert.deepEqual(listSkills(storeB, 'ws-b', info).map((row) => row.name), [b.name], 'B 只看到自己的 skill')
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
  const scope = scopeOf(join(project, '.dsh', 'skills'))
  const first = await persistOneTask(store, workspaceKeyOf(project), scope.root)
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
  const first = await persistOneTask(store, 'ws-s12', root)
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
  assert.equal(parsed.source, 'manual')
  ok('R45-S13 手工登记：memory_toolize register 的 skill 路径可落盘（source=manual）')
}

// ---- S14 接线：recordTurnSequences 跨阈值 → 任务 skill ----
{
  const project = gitProject()
  const store = fakeStore()
  const { recordTurnSequences } = await import('../src/toolize.ts')
  const config = {
    enabled: false, autoSkill: true, threshold: 3, cooldownMs: 0, maxActive: 8,
    minSteps: 2, minDistinctTools: 2, nearMissHint: false, recycleIdleDays: 0,
    skillMinSessions: 2, skillRecencyDays: 30,
  }
  const tools = ['read', 'edit']
  const args = [{ file_path: 'src/skill-forge.ts' }, { file_path: 'src/skill-forge.ts' }]
  const tick = (sessionId, now) => recordTurnSequences({}, store, workspaceKeyOf(project), tools, args, config, quiet, undefined, { sessionId, task: TASK, now })
  await tick('s1', NOW)
  await tick('s1', NOW + 1)
  assert.equal(listSkills(store, workspaceKeyOf(project), resolveSkillRoot(project)).length, 0, '单会话重复不生成（跨会话阈值）')
  await tick('s2', NOW + 2)
  const views = listSkills(store, workspaceKeyOf(project), resolveSkillRoot(project))
  assert.equal(views.length, 1, '跨阈值 + 跨会话后生成 1 个 skill: ' + JSON.stringify(views.map((v) => v.name)))
  assert.equal(views[0].name, 'sm-fix-skill')
  assert.ok(views[0].path.startsWith(join(project, '.dsh', 'skills')), '落在项目 skill 目录')
  assert.equal(views[0].version, 1)
  await tick('s2', NOW + 3)
  assert.equal(listSkills(store, workspaceKeyOf(project), resolveSkillRoot(project))[0].version, 1, '再次 tick 不重复升版')
  ok('R45-S14/R48 接线：recordTurnSequences 跨阈值+跨会话自动生成任务 skill（单会话不生成）')
}

// ---- S15 启动扫尾 ----
{
  const project = gitProject()
  const ws = workspaceKeyOf(project)
  const store = fakeStore({
    signals: [
      ['ws/' + ws + '/task/fix/skill', taskSignal({ workspaceKey: ws, count: 7, sessions: ['s1', 's2'], lastSeen: NOW })],
      ['ws/' + ws + '/seq/bash>bash>bash', { workspaceKey: ws, pattern: 'bash>bash>bash', count: 100, lastSeen: NOW, examples: [], sequence: ['bash', 'bash', 'bash'], samples: ['{"tools":["bash","bash","bash"],"args":[{},{},{}]}'], sessions: ['s1', 's2'] }],
    ],
  })
  const { sweepSkillDrafts } = await import('../src/toolize.ts')
  const config = { enabled: false, autoSkill: true, threshold: 3, cooldownMs: 0, maxActive: 8, minSteps: 2, minDistinctTools: 2, nearMissHint: false, recycleIdleDays: 0, skillMinSessions: 2, skillRecencyDays: 30 }
  const created = await sweepSkillDrafts(store, config, quiet)
  assert.equal(created, 1, '启动扫尾只补 task 信号，legacy seq 不生成')
  const views = listSkills(store, ws, resolveSkillRoot(project))
  assert.equal(views.length, 1)
  assert.ok(!views[0].name.includes('flow'))
  assert.equal(await sweepSkillDrafts(store, { ...config, autoSkill: false }, quiet), 0, 'autoSkill 关闭时扫尾不动')
  ok('R45-S15/R48 启动扫尾：task 信号补生成；legacy seq 信号永不生成')
}

// ---- S16 自动增长上限 ----
{
  const store = fakeStore()
  const root = tempDir()
  // manual register does NOT consume the auto cap.
  const manual = draftSkillFromManual({ name: 'notes', title: '笔记', description: '手工笔记' })
  await persistSkillDraft(store, 'ws-s16', manual, { root })

  const signals = []
  for (let index = 0; index < 10; index += 1) {
    const task = '修复 lib' + index + ' 模块的边界问题'
    const tools = ['read', 'edit']
    const args = [{ file_path: 'src/lib' + index + '.ts' }, { file_path: 'src/lib' + index + '.ts' }]
    signals.push(['ws/ws-s16/task/fix/lib' + index, {
      workspaceKey: 'ws-s16', pattern: 'task:fix/lib' + index, count: 3, lastSeen: NOW,
      examples: [task], sequence: tools,
      samples: [sampleJson({ task, tools, args, sessionId: 's1' })],
      sessions: ['s1', 's2'],
    }])
  }
  const seeded = fakeStore({ signals, toolMemory: [] })
  // Reuse the manual file written above: copy it into the seeded store's root is
  // not needed — the cap counts FILES, and persistSkillDraft wrote the manual.
  const { results } = await syncRepeatedTransactions(seeded, 'ws-s16', scopeOf(root), {
    threshold: 3, minSessions: 2, recencyDays: 30, now: NOW,
  })
  assert.equal(results.filter((result) => result.status === 'created').length, SKILL_MAX_PER_ROOT, '自动路径最多 ' + SKILL_MAX_PER_ROOT + ' 个: ' + results.filter((result) => result.status === 'created').length)
  assert.equal(results.filter((result) => result.status === 'created').length + 1, readSkillFiles(root).length, 'manual 不占自动额度')
  // Updating an existing name is still allowed at the cap.
  const first = readSkillFiles(root).find((entry) => entry.parsed.source === 'task')
  assert.ok(first)
  const updated = await persistTaskSkillForSignature(seeded, 'ws-s16', first.parsed.taskKey, { threshold: 3, minSessions: 2, recencyDays: 30, now: NOW + 1, root })
  assert.ok(updated, '已存在 skill 在达到上限后仍可更新')
  ok('R45-S16/R48 上限：自动 skill ≤' + SKILL_MAX_PER_ROOT + ' 个/根；manual 不占额度；已存在可更新')
}

// ---- S17 任务签名抽取：否定用例 ----
{
  assert.equal(extractTaskSignature({ tools: ['bash', 'bash'], args: [{ command: 'ls' }, { command: 'git status' }] }), undefined, '纯工具序列无任务文本 → 不产出')
  assert.equal(extractTaskSignature({ task: '继续', tools: ['read', 'edit'], args: [{ file_path: 'src/a.ts' }, { file_path: 'src/a.ts' }] }), undefined, '任务文本过短 → 不产出')
  assert.equal(extractTaskSignature({ task: '跑一下命令看看', tools: ['bash', 'bash'], args: [{ command: 'ls -la' }, { command: 'git status' }] }), undefined, '只有泛化 bash/pnpm 命令 → 不产出')
  assert.equal(extractTaskSignature({ task: 'bash bash bash 序列', tools: ['bash', 'bash', 'bash'], args: [{ command: 'ls' }, { command: 'pwd' }, { command: 'echo ok' }] }), undefined, '只有工具词 → 不产出')
  assert.equal(extractTaskSignature({ task: '修复 src/alpha.ts 的边界问题', tools: ['read', 'edit'], args: [{ file_path: 'src/alpha.ts' }, { file_path: 'src/alpha.ts' }] })?.object, 'alpha')
  const valid = extractTaskSignature({ task: '同步并推送 Gitee + GitHub 双远端', tools: ['bash', 'bash'], args: [{ command: 'git push origin main' }, { command: 'git push gitee main' }] })
  assert.ok(valid, '有对象+命令的短任务仍可产出')
  assert.equal(valid.verb, 'sync')
  assert.ok(valid.confidence >= 0.5)
  assert.ok(!looksLikeToolFlowName('sm-fix-skill'))
  assert.ok(looksLikeToolFlowName('sm-flow-bash-bash-1mso2t'))
  assert.ok(!isReadableTaskSkillName('sm-flow-bash-bash-1mso2t'), '壳子名不可读')
  ok('R48-S17 签名抽取：纯序列/短文本/泛化命令/工具词一律不产出；有对象+命令可产出')
}

// ---- S18 合并同类任务 ----
{
  const store = fakeStore()
  const ws = 'ws-s18'
  const root = tempDir()
  const runs = [
    { task: TASK, tools: ['read', 'edit', 'bash'], args: [{ file_path: 'src/skill-forge.ts' }, { file_path: 'src/skill-forge.ts' }, { command: 'pnpm typecheck' }], sessionId: 's1' },
    { task: TASK, tools: ['write', 'bash'], args: [{ file_path: 'src/toolize.ts' }, { command: 'pnpm build' }], sessionId: 's2' },
    { task: TASK, tools: ['grep', 'read', 'edit'], args: [{ pattern: 'skillNameForFlow' }, { file_path: 'src/skill-forge.ts' }, { file_path: 'src/skill-forge.ts' }], sessionId: 's1' },
  ]
  for (const [index, run] of runs.entries()) await recordTaskObservation(store, ws, run, { threshold: 3, now: NOW + index })
  const taskSignals = [...store.signals.entries()].filter(([, signal]) => signal.pattern.startsWith('task:'))
  assert.equal(taskSignals.length, 1, '三种工具序列必须合并为一个任务 signal')
  assert.equal(taskSignals[0][1].count, 3)
  assert.deepEqual([...store.signals.entries()].filter(([, signal]) => !signal.pattern.startsWith('task:')), [], '不得再产生工具序列 signal 用于 skill')
  const first = await persistTaskSkillForSignature(store, ws, 'fix/skill', { threshold: 3, minSessions: 2, now: NOW + 10, root })
  assert.equal(first.status, 'created')
  assert.equal(first.name, 'sm-fix-skill')
  const body = parseSkillMarkdown(readFileSync(first.path, 'utf8'), first.name).body
  assert.ok(body.includes('src/toolize.ts'), '合并后正文包含其他工具序列的真实文件')
  assert.ok(body.includes('pnpm build') || body.includes('pnpm typecheck'), '合并后正文保留真实命令')
  await recordTaskObservation(store, ws, runs[0], { threshold: 3, now: NOW + 20 })
  const again = await persistTaskSkillForSignature(store, ws, 'fix/skill', { threshold: 3, now: NOW + 21, root })
  assert.ok(['unchanged', 'updated'].includes(again.status), '同一任务再次检测 → 只更新既有 skill: ' + again.status)
  assert.equal(again.name, first.name, '不得新建近似名')
  assert.equal(readSkillFiles(root).length, 1, '目录里只有一个 skill')
  const third = await persistTaskSkillForSignature(store, ws, 'fix/skill', { threshold: 3, now: NOW + 22, root })
  assert.equal(third.status, 'unchanged', '样本形态稳定后再检测 → unchanged（不无限升版）')
  ok('R48-S18 合并：同任务不同工具序列 → 1 个 signal/1 个 skill；重复检测只更新统计')
}

// ---- S19 壳子不生成 ----
{
  const store = fakeStore({
    signals: [['ws/ws-s19/seq/bash>bash>bash', {
      workspaceKey: 'ws-s19', pattern: 'bash>bash>bash', count: 999, lastSeen: NOW,
      examples: [], sequence: ['bash', 'bash', 'bash'],
      samples: [JSON.stringify({ tools: ['bash', 'bash', 'bash'], args: [{ command: 'pnpm build' }, { command: 'pnpm typecheck' }, { command: 'git status' }] })],
      sessions: ['s1', 's2'],
    }]],
  })
  const root = tempDir()
  const { drafts, results } = await syncRepeatedTransactions(store, 'ws-s19', scopeOf(root), { threshold: 3, minSessions: 2, now: NOW })
  assert.equal(drafts.length, 0, 'legacy 序列信号不得生成草稿')
  assert.equal(results.length, 0)
  assert.equal(readSkillFiles(root).length, 0, '目录里不得出现 sm-flow-*')
  assert.equal(existsSync(join(root, 'sm-flow-bash-bash-1mso2t')), false)
  ok('R48-S19 壳子不生成：即使 legacy 序列计数 999、跨会话，也不落任何 skill 文件')
}

// ---- S20 命名与描述（真实任务样本） ----
{
  const cases = [
    {
      task: '同步并推送 Gitee + GitHub 双远端，确认三方一致',
      tools: ['bash', 'bash'],
      args: [{ command: 'git push origin main' }, { command: 'git push gitee main' }],
      name: 'sm-sync-gitee-github',
    },
    {
      task: '发布新版本并打包 tgz 资产',
      tools: ['bash', 'bash', 'bash'],
      args: [{ command: 'pnpm build' }, { command: 'npm pack' }, { command: 'tar -czf package.tgz package' }],
      name: 'sm-release-package-tgz',
    },
    {
      task: '面板页签重排：中枢/话题集/分支会话/记忆顺序调整',
      tools: ['read', 'edit'],
      args: [{ file_path: 'src/client/panel-page.tsx' }, { file_path: 'src/client/panel-page.tsx' }],
      name: 'sm-refactor-panel-tab',
    },
  ]
  for (const item of cases) {
    const signature = extractTaskSignature({ task: item.task, tools: item.tools, args: item.args })
    assert.ok(signature, '真实任务应产出签名: ' + item.task)
    const name = skillNameForTask(signature)
    assert.equal(name, item.name, '任务级命名: ' + name)
    assert.match(name, /^sm-[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(!/flow|bash|read-|write-|edit-/.test(name), '名字不得含工具序列词: ' + name)
    const signal = taskSignal({ workspaceKey: 'ws-s20-' + item.name, key: signature.key, count: 3, sessions: ['s1', 's2'], samples: [sampleJson({ ...item, sessionId: 's1' })] })
    const draft = draftSkillFromTaskSignal(signal, [{ task: item.task, tools: item.tools, args: item.args, sessionId: 's1' }], { signature, sessions: 2 })
    assert.ok(draft.description.includes(signature.title), '描述写清任务: ' + draft.description)
    assert.ok(!draft.description.includes('→'), '描述不得回退成工具顺序')
    assert.ok(draft.description.length <= SKILL_DESCRIPTION_MAX)
  }
  assert.ok(taskNameSimilarity('sm-fix-skill', 'sm-fix-skill-forge') < 1)
  ok('R48-S20 命名：sync-gitee-github / release-package-tgz / refactor-panel-tab；描述任务化、无工具顺序')
}

// ---- S21 阈值与时间衰减 ----
{
  const build = (count, sessions, lastSeen) => fakeStore({
    signals: [['ws/ws-s21/task/fix/skill', {
      workspaceKey: 'ws-s21', pattern: 'task:fix/skill', count, lastSeen,
      examples: [TASK], sequence: ['read', 'edit'],
      samples: [sampleJson({ ...TASK_OBS(), sessionId: sessions[0] })],
      sessions,
    }]],
  })
  const root = tempDir()
  const scope = scopeOf(root)
  const below = await syncRepeatedTransactions(build(2, ['s1', 's2'], NOW), 'ws-s21', scope, { threshold: 3, minSessions: 2, recencyDays: 30, now: NOW })
  assert.equal(below.drafts.length, 0, '次数不足 3 → 不生成')
  const oneSession = await syncRepeatedTransactions(build(5, ['s1'], NOW), 'ws-s21', scope, { threshold: 3, minSessions: 2, recencyDays: 30, now: NOW })
  assert.equal(oneSession.drafts.length, 0, '只跨 1 个会话 → 不生成')
  const stale = await syncRepeatedTransactions(build(5, ['s1', 's2'], NOW - 31 * DAY), 'ws-s21', scope, { threshold: 3, minSessions: 2, recencyDays: 30, now: NOW })
  assert.equal(stale.drafts.length, 0, '超过 ' + SKILL_RECENCY_DAYS + ' 天未再出现 → 不新增/不升版')
  const good = await syncRepeatedTransactions(build(3, ['s1', 's2'], NOW - 2 * DAY), 'ws-s21', scope, { threshold: 3, minSessions: 2, recencyDays: 30, now: NOW })
  assert.equal(good.drafts.length, 1, '≥3 次 + ≥2 会话 + 窗口内 → 生成')
  assert.equal(good.drafts[0].source.sessions, 2)
  assert.equal(SKILL_MIN_SESSIONS, 2)
  ok('R48-S21 阈值与衰减：≥3 次、≥2 会话、30 天窗口；任一不满足都不生成')
}

// ---- S22 存量清理：归档 + manifest + 幂等 ----
{
  const project = gitProject()
  const userHome = tempDir('sm-skill-home-')
  const projectRoot = join(project, '.dsh', 'skills')
  const userRoot = join(userHome, 'skills')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(userRoot, { recursive: true })
  const writeSkill = (root, name, source, description, body = '## 何时用') => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + JSON.stringify(description) + '\nsm-source: ' + JSON.stringify(source) + '\nsm-version: 3\nsm-occurrences: 5\n---\n\n' + body)
  }
  writeSkill(projectRoot, 'sm-flow-bash-bash-1mso2t', 'sequence', '当任务需要按 bash → bash 的顺序反复处理同类改动时加载：含触发条件、决策清单、步骤纲要、关键坑与验证方式（自动化沉淀的重复事务）。')
  writeSkill(projectRoot, 'sm-flow-run-code-run-code-1lwcpc', 'sequence', '当任务需要按 run_code → run_code 的顺序反复处理同类改动时加载：含触发条件。')
  writeSkill(projectRoot, 'sm-cap-git-sync', 'capability', '遇到 git 同步类重复工作时加载')
  writeSkill(projectRoot, 'sm-manual-notes', 'manual', '手工登记', '## 人工正文\n- 保留我')
  writeSkill(projectRoot, 'sm-fix-skill', 'task', '当任务属于「修复 skill」这一类时加载')
  writeSkill(userRoot, 'sm-ws13tln-flow-run-code-run-code-1lwcpc', 'sequence', '当任务需要按 run_code → run_code 的顺序反复处理同类改动时加载：含触发条件。')
  const parsedShell = readSkillFiles(projectRoot).find((entry) => entry.name === 'sm-flow-bash-bash-1mso2t').parsed
  assert.equal(isShellSkill(parsedShell), true, '旧壳子应被识别')
  assert.equal(isShellSkill(readSkillFiles(projectRoot).find((entry) => entry.name === 'sm-manual-notes').parsed), false, 'manual 不得被识别')
  const first = await archiveShellSkills({ roots: [projectRoot, userRoot], now: NOW })
  assert.equal(first.totalArchived, 3, '两个根共归档 3 个壳子: ' + first.totalArchived)
  assert.equal(first.totalScanned, 6)
  const projectReport = first.roots.find((item) => item.root === projectRoot)
  assert.equal(projectReport.skippedManual, 1)
  assert.equal(projectReport.skippedOther, 2, 'capability + task 不动')
  assert.ok(existsSync(join(projectRoot, 'sm-manual-notes', 'SKILL.md')), 'manual 正文保留')
  assert.ok(existsSync(join(projectRoot, 'sm-cap-git-sync', 'SKILL.md')), 'capability 保留')
  assert.ok(existsSync(join(projectRoot, 'sm-fix-skill', 'SKILL.md')), 'task skill 保留')
  assert.ok(!existsSync(join(projectRoot, 'sm-flow-bash-bash-1mso2t')), '壳子已移出 skills 根')
  const archiveDir = archiveDirForRoot(projectRoot)
  assert.ok(archiveDir.endsWith('skills-archive') && dirname(archiveDir) === dirname(projectRoot), '归档目录是 skills 根的兄弟目录: ' + archiveDir)
  assert.ok(existsSync(join(archiveDir, 'sm-flow-bash-bash-1mso2t', 'SKILL.md')))
  const manifest = JSON.parse(readFileSync(join(archiveDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.entries.length, 2, '项目根 manifest 记录 2 条')
  for (const entry of manifest.entries) {
    assert.ok(entry.name && entry.from && entry.archivedAt && entry.reason, 'manifest 记录原名/来源/时间/原因')
  }
  const beforeSecond = readFileSync(join(archiveDir, 'manifest.json'), 'utf8')
  const second = await archiveShellSkills({ roots: [projectRoot, userRoot], now: NOW + 1000 })
  assert.equal(second.totalArchived, 0, '二次执行必须幂等（归档 0）')
  assert.equal(readFileSync(join(archiveDir, 'manifest.json'), 'utf8'), beforeSecond, '幂等执行不改 manifest')
  assert.equal(readdirSync(userRoot).length, 0, '用户根壳子也已被归档')
  ok('R48-S22 清理：仅归档自动 shell（manual/capability/task 保留）；manifest 可回滚；二次执行幂等')
}

// ---- S23 人工 register 不受清理影响，仍可升版 ----
{
  const root = tempDir()
  const store = fakeStore()
  const draft = draftSkillFromManual({ name: 'ops-runbook', title: '运维手册', description: '当需要按运维手册操作时加载' })
  const first = await persistSkillDraft(store, 'ws-s23', draft, { root })
  const archived = await archiveShellSkills({ roots: [root], store, now: NOW })
  assert.equal(archived.totalArchived, 0)
  assert.equal(archived.roots[0].skippedManual, 1)
  const updated = await persistSkillDraft(store, 'ws-s23', { ...draft, description: draft.description + '（补充）' }, { root })
  assert.equal(updated.status, 'updated')
  assert.equal(updated.version, 2)
  assert.ok(readFileSync(first.path, 'utf8').includes('运维手册') || readFileSync(first.path, 'utf8').includes('补充'))
  ok('R48-S23 人工 register：清理跳过 manual（skippedManual），之后仍可正常升版')
}

for (const root of roots) { try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } }
console.log('\nskill-smoke: ' + passed + ' 组断言通过')
