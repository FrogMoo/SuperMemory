/**
 * core-smoke — pure-logic regression checks for the host half (no DSH host).
 *
 * Runs the data-layer helpers against in-memory table stubs so the invariants
 * that unit-testing cannot reach through the web console are still covered.
 * Usage: node scripts/core-smoke.mjs   (Node >= 22.6 for TS type stripping)
 */
import assert from 'node:assert/strict'

const { buildExport } = await import('../src/export.ts')
const {
  collectionRows, findMemoryConflict, listCollections, matchCollections, migrateFlatMemories,
  recallEntriesWithCollections, resolveCollectionForEntry, shapeScore, tierOfScore,
} = await import('../src/memory-collections.ts')
const { topicSetIdsOf } = await import('../src/topicsets.ts')
const { recallMemories } = await import('../src/recall.ts')
const { renderRecordLine } = await import('../src/retrieval.ts')
const { rankMembers } = await import('../src/topicsets.ts')
const { extractRequirements } = await import('../src/requirements.ts')
const { extractFacts } = await import('../src/extract.ts')
// R22 需求④⑤: 记忆集合 + 条目的断言集中在独立模块里（也可单独运行）。
const { runMemoryCollectionChecks } = await import('./memory-collections-smoke.mjs')
// R23：记忆整理（集合重排/合并/清占位）的引擎断言（也可单独运行）。
const { runMemoryOrganizeChecks } = await import('./memory-organize-smoke.mjs')

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
    deleteMany: async (ks) => { let n = 0; for (const k of ks) if (map.delete(k)) n++; return n },
  }
}

const now = Date.now()
const WS_A = 'G:\\work\\alpha'
const WS_B = 'G:\\work\\beta'
const store = {
  topicsets: table([
    ['ts-a', { workspaceKey: WS_A, title: 'A 话题', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }],
    ['ts-b', { workspaceKey: WS_B, title: 'B 话题', summary: '', keywords: [], status: 'active', members: [], createdAt: now, updatedAt: now, lastActiveAt: now }],
  ]),
  memories: table([
    ['mem-a', { workspaceKey: WS_A, text: 'alpha 的构建命令是 pnpm build', keywords: ['pnpm', 'build'], status: 'active', sourceSessionId: 's1', sourceSeq: 1, createdAt: now, updatedAt: now }],
    ['mem-b', { workspaceKey: WS_B, text: 'beta 的构建命令是 make', keywords: ['make'], status: 'active', sourceSessionId: 's2', sourceSeq: 1, createdAt: now, updatedAt: now }],
  ]),
  episodes: table([
    ['epi-a', { topicSetId: 'ts-a', branchSessionId: 'br-a', timeStart: now, timeEnd: now, summary: 'A 的归档', decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'br-a', sourceSeqStart: 0, sourceSeqEnd: 1 }],
    ['epi-b', { topicSetId: 'ts-b', branchSessionId: 'br-b', timeStart: now, timeEnd: now, summary: 'B 的归档', decisions: [], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'br-b', sourceSeqStart: 0, sourceSeqEnd: 1 }],
  ]),
  requirements: table([
    ['req-a', { workspaceKey: WS_A, text: 'A 必须用 pnpm', constraints: [], status: 'open', sourceSessionId: 's1', sourceSeq: 1, createdAt: now }],
  ]),
  filemap: table(),
  toolMemory: table(),
  signals: table(),
  dispatches: table(),
  outbox: table(),
  routing: table(),
  hotcache: table(),
  // R22 需求④: 记忆集合（默认空表；集合相关的断言自己建 fixture）。
  memoryCollections: table(),
}

let passed = 0
const ok = (label) => { passed++; console.log('ok - ' + label) }

// 1. workspace isolation: an export must never leak another workspace's episodes.
const exportedA = buildExport(store, WS_A)
assert.ok(exportedA.text.includes('A 的归档'))
assert.ok(!exportedA.text.includes('B 的归档'), 'foreign episode leaked into the export')
assert.ok(exportedA.text.includes('alpha 的构建命令'))
assert.ok(!exportedA.text.includes('beta 的构建命令'))
ok('export is workspace-isolated (memories + episodes)')

// 2. topic-set join helper is the single source of that isolation.
assert.deepEqual([...topicSetIdsOf(store, WS_A)], ['ts-a'])
ok('topicSetIdsOf scopes to one workspace')

// 3. recall threshold gates on the RAW match, decay only reorders (DEV-NOTES §3).
const ranked = recallMemories([...store.memories.entries()], '构造 pnpm build 命令', {
  limit: 5, minScore: 1, halfLifeDays: 0.0001, now: now + 30 * 86400000,
})
assert.ok(ranked.some((item) => item.memoryId === 'mem-a'), 'aged memory must still match (decay is not a filter)')
ok('recall minScore applies to the raw score')

// 3b. R10 retrieval shape: title + tags are the index. A title hit must beat
// an identical body hit, and the card/export render the three layers apart.
const shapeMemories = table([
  ['m-title', { workspaceKey: WS_A, title: '构建命令', text: '与查询无关的正文', keywords: [], sourceSessionId: 's', sourceSeq: 1, status: 'active', createdAt: now, updatedAt: now }],
  ['m-body', { workspaceKey: WS_A, title: '', text: '构建命令', keywords: [], sourceSessionId: 's', sourceSeq: 2, status: 'active', createdAt: now, updatedAt: now }],
])
const shapeStore = { ...store, memories: shapeMemories }
const shapeRanked = recallMemories([...shapeMemories.entries()], '构建命令', {
  limit: 5, minScore: 1, halfLifeDays: 30, now,
})
assert.equal(shapeRanked[0].memoryId, 'm-title', 'a title hit must outrank an equal body hit')
assert.equal(shapeRanked[0].title, '构建命令', 'the recall item carries its title')
const cardText = renderRecordLine({ title: '构建命令', text: '用 pnpm build', tags: ['构建'] })
assert.ok(cardText.includes('【构建命令】') && cardText.includes('标签: 构建'), 'the card renders title + tags + body')
const titledExport = buildExport(shapeStore, WS_A)
assert.ok(titledExport.text.includes('【构建命令】'), 'the export keeps the title layer')
ok('memory retrieval shape: title/tag index outranks the body, export keeps it')

// 4. conservative rule extraction: explicit markers only.
assert.deepEqual(extractRequirements('这个功能必须支持导出'), ['支持导出'])
assert.deepEqual(extractRequirements('今天天气不错'), [])
assert.deepEqual(extractFacts('记住：构建命令是 pnpm build').map((f) => f.text), ['构建命令是 pnpm build'])
assert.deepEqual(extractFacts('随便聊聊这个项目'), [])
ok('requirement/fact extraction stays conservative')

// 5. member ranking must actually rank: the title/summary spread bug made every
// score 0, degrading auto/fork branch selection to "most recently active".
const members = [
  { sessionId: 'm-a', kind: 'root', title: '导出 Markdown', summary: 'export', status: 'live', modelOverridden: false, lastActiveAt: 1 },
  { sessionId: 'm-b', kind: 'root', title: '管理台 UI', summary: 'web console', status: 'live', modelOverridden: false, lastActiveAt: 2 },
]
const ranking = rankMembers({ workspaceKey: WS_A, title: 't', summary: '', keywords: [], status: 'active', members, createdAt: now, updatedAt: now, lastActiveAt: now }, new Set(['export']))
assert.equal(ranking[0].sessionId, 'm-a', 'the member matching the task must rank first')
ok('rankMembers ranks by task overlap')

// 6. R19 需求⑧：记忆写入是结论，不是流水账；recall 能定位命中的话题集。
{
  const { assessConclusion } = await import('../src/retrieval.ts')
  const { matchTopicSets } = await import('../src/recall.ts')
  const { normalizeTopicShape, parseTopicShapeText, topicSetFingerprint } = await import('../src/topic-shape.ts')
  const NL = String.fromCharCode(10)

  assert.deepEqual(assessConclusion('构建命令是 pnpm build（先安装依赖）。'), { ok: true }, 'a normal conclusion is accepted')
  assert.deepEqual(assessConclusion('- 构建用 pnpm' + NL + '- 测试用 pnpm test'), { ok: true }, 'a bulleted conclusion list is accepted')
  assert.equal(assessConclusion('步骤1 打开终端' + NL + '步骤2 运行 pnpm build' + NL + '步骤3 复制产物').ok, false, 'a numbered process log is refused')
  assert.equal(assessConclusion('x'.repeat(1600)).ok, false, 'an overlength transcript is refused')

  const sets = [
    ['ts-export', { title: '导出与 Markdown', keywords: ['markdown', 'export'], summary: '把记忆导出为 Markdown 文件', status: 'active' }],
    ['ts-build', { title: '构建与发布', keywords: ['pnpm', 'build'], summary: '构建命令与发布流程', status: 'active' }],
    ['ts-old', { title: '导出的旧方案', keywords: ['export'], summary: '旧导出方案', status: 'archived' }],
  ]
  const exportHits = matchTopicSets(sets, '导出 markdown')
  assert.equal(exportHits[0]?.id, 'ts-export', 'the topic set whose title/tags match the query ranks first')
  assert.ok(!exportHits.some((hit) => hit.id === 'ts-old'), 'archived sets never match')
  assert.equal(matchTopicSets(sets, '构建 pnpm')[0]?.id, 'ts-build')

  const parsed = parseTopicShapeText('```json' + NL + '{"title":"导出与 Markdown","tags":["markdown","导出"],"summary":"把记忆导出为文件"}' + NL + '```', 'fallback')
  assert.deepEqual(parsed, { title: '导出与 Markdown', tags: ['markdown', '导出'], summary: '把记忆导出为文件' })
  assert.equal(parseTopicShapeText('not json', '旧标题'), undefined, 'an unusable answer keeps the old shape')
  assert.deepEqual(normalizeTopicShape({ title: '   ', tags: [], summary: '' }, '旧标题'), { title: '旧标题', tags: [], summary: '' })

  const fingerprintStore = {
    topicsets: table([['ts-shape', { workspaceKey: WS_A, title: '索引', summary: '', keywords: [], status: 'active', members: [], shapeFingerprint: '', shapeGeneratedAt: 0, createdAt: now, updatedAt: now, lastActiveAt: now }]]),
    episodes: table(), requirements: table(), dispatches: table(),
  }
  const firstFingerprint = topicSetFingerprint(fingerprintStore, 'ts-shape')
  await fingerprintStore.topicsets.update('ts-shape', (row) => ({
    ...row, members: [{ sessionId: 'branch-new', kind: 'fork', title: '新分支', summary: '', status: 'live', modelOverridden: false, lastActiveAt: now }],
  }))
  const secondFingerprint = topicSetFingerprint(fingerprintStore, 'ts-shape')
  assert.notEqual(firstFingerprint, secondFingerprint, 'new content changes the fingerprint (regeneration trigger)')
  assert.equal(secondFingerprint, topicSetFingerprint(fingerprintStore, 'ts-shape'), 'an unchanged set keeps one fingerprint')
  ok('R19: 结论校验 + recall 话题集定位 + 话题集形态解析与内容指纹')
}

// ---- R19 协同①②③: parallel branch selection + hub→branch association ----
// The dispatch selection is a pure plan (branchCandidates) so the invariants can
// be checked without a DSH host: a parallel group must claim DISTINCT branches,
// `auto` must not merge into a busy branch, `continue` may queue on it, and
// selection is topic-set-scoped (never hub-scoped) so a second hub can continue
// the same idle branch.
{
  const { branchCandidates, busyBranches } = await import('../src/dispatch.ts')
  const {
    listHubBranches, listTopicSetBranches, listWorkspaceBranches, hubsByBranch,
    renderHubBranchesCard, isHubSession, relativeAgo,
  } = await import('../src/hub-branches.ts')
  const member = (sessionId, title, kind = 'fork', lastActiveAt = now) =>
    ({ sessionId, kind, title, summary: '', status: 'idle', modelOverridden: false, lastActiveAt })
  const ts = { title: '构建', members: [member('branch-a', '修构建'), member('branch-b', '修构建二'), member('branch-c', '无关')] }

  const auto = branchCandidates(ts, '修构建', 'auto', new Set(), new Set())
  assert.deepEqual(auto.candidates.map((m) => m.sessionId), ['branch-a', 'branch-b', 'branch-c'],
    'auto ranks matching idle branches (hub identity does not scope selection)')
  const busyA = branchCandidates(ts, '修构建', 'auto', new Set(['branch-a']), new Set())
  assert.deepEqual(busyA.candidates.map((m) => m.sessionId), ['branch-b', 'branch-c'],
    'auto never merges into a busy branch')
  const cont = branchCandidates(ts, '修构建', 'continue', new Set(['branch-a']), new Set())
  assert.deepEqual(cont.candidates.map((m) => m.sessionId), ['branch-a', 'branch-b', 'branch-c'],
    'continue may queue on the busy branch (explicit intent)')
  const claimed = branchCandidates(ts, '修构建', 'auto', new Set(), new Set(['branch-a']))
  assert.deepEqual(claimed.candidates.map((m) => m.sessionId), ['branch-b', 'branch-c'],
    'a parallel group excludes branches already claimed by a sibling task')
  assert.deepEqual(branchCandidates(ts, '修构建', 'new', new Set(), new Set()).candidates, [],
    'new forces a fresh branch')
  assert.equal(branchCandidates(ts, '修构建', 'fork', new Set(), new Set()).forkParent.sessionId, 'branch-a',
    'fork names the ranked parent')
  assert.deepEqual([...busyBranches({ dispatches: table([
    ['d1', { branchSessionId: 'branch-a', status: 'dispatched' }],
    ['d2', { branchSessionId: 'branch-b', status: 'delivered' }],
    ['d3', { branchSessionId: 'branch-a', status: 'failed' }],
  ]) })], ['branch-a'], 'busy = any open dispatch row')
  ok('R19-协同1 分支选择：并行组独占分支、auto 避开忙碌分支、continue 可排队、fork/new 语义')

  const store = {
    topicsets: table([
      ['ts-1', { workspaceKey: WS_A, title: '构建', status: 'active', members: [
        member('branch-a', '修构建', 'fork', now),
        member('session-root', '集内中枢', 'root', now),
      ] }],
      ['ts-archived', { workspaceKey: WS_A, title: '归档集', status: 'archived', members: [member('branch-old', '旧分支')] }],
      ['ts-other', { workspaceKey: WS_B, title: '别的工作区', status: 'active', members: [] }],
    ]),
    dispatches: table([
      ['d1', { topicSetId: 'ts-1', branchSessionId: 'branch-a', task: '修构建', hubSessionId: 'hub-1', startSeq: 0, status: 'delivered', createdAt: now - 5000, updatedAt: now - 4000 }],
      ['d2', { topicSetId: 'ts-1', branchSessionId: 'branch-a', task: '再修构建', hubSessionId: 'hub-2', startSeq: 0, status: 'dispatched', createdAt: now - 3000, updatedAt: now - 1000 }],
      ['d3', { topicSetId: 'ts-1', branchSessionId: 'branch-2', task: '独立任务', hubSessionId: 'hub-1', startSeq: 0, status: 'failed', turnEndReason: 'error', createdAt: now - 6000, updatedAt: now - 5000 }],
    ]),
  }
  const rows = listHubBranches(store, 'hub-2')
  assert.equal(rows.length, 1, 'hub-2 sees exactly the branch it dispatched into')
  assert.equal(rows[0].branchSessionId, 'branch-a')
  assert.equal(rows[0].status, 'working', 'a branch is working while it owes a relay')
  assert.equal(rows[0].dispatches, 2, 'the row counts every hub\'s dispatches')
  assert.deepEqual(rows[0].hubs, ['hub-2', 'hub-1'], 'the row names every hub sharing the branch')
  assert.equal(rows[0].shared, true, 'more than one hub = shared')
  assert.equal(rows[0].topicSetTitle, '构建', 'the row names its owning topic set')
  assert.equal(rows[0].title, '修构建', 'the member title wins over the task excerpt')
  assert.deepEqual(listTopicSetBranches(store, 'ts-1').map((r) => r.branchSessionId).sort(), ['branch-2', 'branch-a'],
    'a topic-set view lists every branch of the set regardless of hub')
  assert.deepEqual(listWorkspaceBranches(store, WS_A).map((r) => r.branchSessionId).sort(), ['branch-2', 'branch-a'],
    'the console view is workspace-scoped through the set')
  assert.equal(listWorkspaceBranches(store, WS_B).length, 0, 'another workspace sees no branch')
  assert.equal(hubsByBranch(store).get('branch-a').length, 2)
  assert.equal(listHubBranches(store, 'hub-1')[1].status, 'failed', 'a failed terminal branch stays visibly failed')
  assert.equal(relativeAgo(now - 30_000, now), '刚刚')
  assert.match(relativeAgo(now - 120_000, now), /分钟前/)
  const card = renderHubBranchesCard(listHubBranches(store, 'hub-2'), { now })
  assert.match(card, /\[supermemory 关联分支\]/, 'the hub card has a stable header')
  assert.match(card, /工作中/, 'the card states the branch state')
  assert.match(card, /与另外 1 个中枢共享/, 'the card states the cross-hub sharing')
  assert.match(card, /mode=continue/, 'the card repeats the continue rule')
  assert.equal(renderHubBranchesCard([], { now }), '', 'no branch = no card (no per-turn noise)')

  assert.equal(isHubSession(store, { id: 'session-root', session: { header: { cwd: WS_A } } }), true,
    'a root member stays a hub (a set\'s own conversation)')
  assert.equal(isHubSession(store, { id: 'branch-a', session: { header: { cwd: WS_A } } }), false,
    'a fork member is a branch, never a hub')
  assert.equal(isHubSession(store, { id: 'branch-minted', session: { header: { cwd: WS_A } } }), false,
    'a plugin-minted branch id is excluded even without a member row')
  assert.equal(isHubSession(store, { id: 'child', session: { header: { cwd: WS_A, parentSession: 'hub-1' } } }), false,
    'a subagent/child session is never a hub')
  ok('R19-协同2/3 中枢↔分支关联：状态/共享/所属话题集/工作区隔离 + 中枢判定')
}

// R22 需求④⑤：记忆集合模型（集合复用 / 旧数据迁移 / 两级检索 / 同 key / 导出分组）
passed += await runMemoryCollectionChecks({ ok, now })
passed += await runMemoryOrganizeChecks({ ok, now })

// ---- R27 需求④.2 原子拆分（记忆整形）+ ④.3 抽取净化 ----
{
  const { mayHoldMultipleFacts, normalizeSplitResult, splitMemoryEntries } = await import('../src/memory-split.ts')
  const { keywordsOf } = await import('../src/extract.ts')

  // 假 llm：拆分类请求（提示词带「待整形材料」）回答拆分答案，集合判定请求按序回答决策。
  const routingLlm = (splitAnswer, decisions) => {
    const calls = []
    let decisionIndex = 0
    const llm = {
      listProviders: () => [{ id: 'p', name: 'P' }],
      listModels: async () => [{ provider: 'p', id: 'm', name: 'M' }],
      stream(request) {
        calls.push(request)
        const asked = (request.messages?.[0]?.content ?? [])
          .map((block) => (block?.type === 'text' ? String(block.text ?? '') : '')).join('\n')
        const isSplit = asked.includes('待整形材料')
        const answer = isSplit ? splitAnswer : decisions[Math.min(decisionIndex, decisions.length - 1)]
        if (!isSplit) decisionIndex += 1
        return (async function* () { yield { type: 'text-delta', text: answer } })()
      },
    }
    return { ctx: { get: (name) => (name === 'llm' ? llm : undefined) }, calls }
  }

  const NL = String.fromCharCode(10)
  const multiText = [
    'git 同步用 pnpm git:sync：凭据走仓库本地 GCM（Windows 凭据存储托管），不要再写 -c credential.helper=store。',
    '推送前先 git fetch 确认无分叉，确认远端没有新提交冲突之后再推送，绝不 force push。',
    'logs/ 与 *.bak 不提交，已经写入根 .gitignore；带日期后缀的备份要手动排除。',
    '日常同步跑入口命令 pnpm git:sync，预演加 --dry-run，提交信息写文件后 git commit -F。',
  ].join(NL)

  // 8.1 预判：明显单条不调用模型，多行正文才可能拆
  assert.equal(mayHoldMultipleFacts('构建命令是 pnpm build'), false, '短单句不触发拆分（不烧 token）')
  assert.equal(mayHoldMultipleFacts(multiText), true, '多行长文判定为可能多事实')

  // 8.2 有模型：拆成 2 条 → 各自判重 + 集合归属后落库（两条都带集合）
  {
    const store = {
      memories: table([]),
      memoryCollections: table([['mc-git', {
        workspaceKey: WS_A, title: 'git 同步 记忆', keywords: ['git', '同步', '推送'],
        summary: 'git 同步与推送约定', status: 'active', createdAt: now, updatedAt: now,
      }]]),
    }
    const llm = routingLlm(
      JSON.stringify({ entries: [
        { title: 'git 同步用 pnpm git:sync', tags: ['git', '同步'], text: 'git 同步用 pnpm git:sync：凭据走仓库本地 GCM。' },
        { title: '推送前先 fetch', tags: ['git', '推送'], text: '推送前先 git fetch 确认无分叉，绝不 force push。' },
      ] }),
      ['{"collectionId":"mc-git"}', '{"collectionId":"mc-git"}'],
    )
    const drafts = await splitMemoryEntries({ ctx: llm.ctx }, multiText, { title: 'git 同步 约定', tags: ['git'] })
    assert.equal(drafts.length, 2, '模型拆出 2 条原子记忆')
    assert.equal(drafts[0].title, 'git 同步用 pnpm git:sync')
    assert.deepEqual(drafts[0].tags, ['git', '同步'])
    assert.equal(llm.calls.length, 1, '整形只调用一次模型')
    // 模拟 memory_remember 的写入循环：逐条判重 + 集合归属 + 落库
    const written = []
    for (const draft of drafts) {
      assert.equal(findMemoryConflict(store, WS_A, { text: draft.text }), null, '新片段不误判重复')
      const assignment = await resolveCollectionForEntry(
        store, WS_A, { title: draft.title, keywords: draft.tags, text: draft.text },
        { now, deps: { ctx: llm.ctx } },
      )
      assert.ok(!('error' in assignment))
      await store.memories.put('mem-' + written.length, {
        workspaceKey: WS_A, title: draft.title, text: draft.text, keywords: draft.tags,
        ...(assignment.collectionId ? { collectionId: assignment.collectionId } : {}),
        sourceSessionId: 's', sourceSeq: 1, status: 'active', createdAt: now, updatedAt: now,
      })
      written.push(assignment)
    }
    assert.equal(store.memories.size, 2, '两条原子记忆都落库')
    assert.equal(written[0].collectionId, 'mc-git', '第一条归入已有集合（模型判定）')
    assert.equal(written[0].tier, 'llm')
    assert.equal(written[1].collectionId, 'mc-git', '第二条同样归入该集合')
    assert.equal(collectionRows(store).length, 1, '同主题两条不新开集合')
    assert.equal(llm.calls.length, 3, '一次整形 + 两次集合判定（每条一次，token 护栏）')
  }

  // 8.3 无模型 / 调用失败：保持 1 条（与旧行为一致）
  assert.equal(await splitMemoryEntries({}, multiText, { title: 't', tags: ['git'] }), undefined, '无 ctx 不拆分')
  assert.equal(await splitMemoryEntries({ ctx: { get: () => undefined } }, multiText, { title: 't', tags: ['git'] }), undefined,
    '无 llm 服务不拆分')
  const broken = { ctx: { get: () => ({ stream: () => { throw new Error('boom') } }) } }
  assert.equal(await splitMemoryEntries(broken, multiText, { title: 't', tags: ['git'] }), undefined, '模型抛错不拆分')

  // 8.4 答案净化：上限 5 条、组内去重、丢弃步骤日志、标签回退
  {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: 'T' + i, tags: ['a'], text: '结论' + i + '：用 pnpm build 构建' }))
    assert.equal(normalizeSplitResult({ entries: many }, { title: 't', tags: [] }).length, 5, '拆分数上限 5 条')
    assert.deepEqual(
      normalizeSplitResult([{ title: 'A', tags: [], text: '同一条结论' }, { title: 'B', tags: [], text: '同一条结论' }], { title: 't', tags: [] })
        .map((draft) => draft.text),
      ['同一条结论'],
      '组内重复只留一条',
    )
    assert.equal(normalizeSplitResult({ entries: [{ title: 'A', text: '步骤1 打开终端\n步骤2 运行\n步骤3 复制' }] }, { title: 't', tags: [] }),
      undefined, '步骤日志片段被丢弃')
    assert.equal(normalizeSplitResult({ entries: [] }, { title: 't', tags: [] }), undefined, '空答案不可用')
    assert.equal(normalizeSplitResult('nope', { title: 't', tags: [] }), undefined, '非对象不可用')
    const fallback = normalizeSplitResult([{ title: 'A', text: '端口是 62590' }], { title: 't', tags: ['部署'] })
    assert.deepEqual(fallback[0].tags, ['部署'], '模型没给标签时沿用调用方标签')
  }

  // 8.5 抽取净化：派发包装 / 纯命令行 / 版本行 / 疑问句 / 数字主语不再成记忆
  assert.deepEqual(extractFacts('记住：1. git --version').map((f) => f.text), [], '纯命令行不成记忆')
  assert.deepEqual(extractFacts('记住：node -v').map((f) => f.text), [], '命令行不成记忆')
  assert.deepEqual(extractFacts('记住：v1.2.3').map((f) => f.text), [], '纯版本行不成记忆')
  assert.deepEqual(extractFacts('本任务是并行组 grp-x 的一员：只负责这一个任务').map((f) => f.text), [], '派发包装文本不成记忆')
  assert.deepEqual(extractFacts('记住：原派发 dsp-abcd1234 的续跑任务由分支完成').map((f) => f.text), [], '续跑包装文本不成记忆')
  assert.deepEqual(extractFacts('记住：分支会话 branch-mwryiywu-5uapt9 已交付').map((f) => f.text), [], '分支会话信封不成记忆')
  assert.deepEqual(extractFacts('记住：这两个项目前端和后端如何分工？').map((f) => f.text), [], '疑问句不成记忆')
  assert.deepEqual(extractFacts('这两个项目前端和后端是做什么的？').map((f) => f.text), [], '定义式疑问句不成记忆')
  assert.deepEqual(extractFacts('12 是部署端口配置').map((f) => f.text), [], '纯数字主语不成记忆')
  assert.deepEqual(extractFacts('记住：构建命令是 pnpm build').map((f) => f.text), ['构建命令是 pnpm build'], '正常结论仍然入库')
  assert.deepEqual(extractRequirements('这个功能必须支持导出'), ['支持导出'], '正常需求仍然入库')
  assert.deepEqual(extractRequirements('是否需要导出功能？'), [], '疑问句不成需求')

  // 8.6 关键词不再产出双字滑窗碎片
  assert.deepEqual(keywordsOf('构建命令是 pnpm build'), ['pnpm', 'build', '构建命令'], 'CJK 按功能字切段取词')
  const kw = keywordsOf('本任务是并行组的一员，构建命令是 pnpm build，端口是 62590')
  for (const fragment of ['本任', '务是', '是并', '的一', '行组']) {
    assert.ok(!kw.includes(fragment), '不再产出跨功能字的双字碎片: ' + fragment)
  }
  assert.ok(kw.includes('本任务'), '切段后取到完整词: ' + kw.join(','))
  assert.ok(kw.length <= 24, '关键词总数受限')
  ok('R27-2 记忆整形：原子拆分（上限 5 / 去重 / 丢步骤日志 / 无模型不拆）+ 抽取净化（包装/命令行/疑问句/滑窗碎片）')
}

console.log(String.fromCharCode(10) + passed + ' checks passed')
process.exit(0)
