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
// R32: hub/branch runtime guard + the shared dynamic card contract.
const {
  BRANCH_RELOAD_DENIED, NON_HUB_RELOAD_DENIED, roleGuardDecision,
} = await import('../src/role-guard.ts')
const {
  cardMetaOf, cardSourceLabel, dispatchSource, relaySource,
} = await import('../src/chat-card.ts')

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
    // R33: hub detection is POSITIVE. These root members are the durable marks
    // the R19/R33 hub assertions rely on (an empty member list is no longer a hub).
    ['ts-a', { workspaceKey: WS_A, title: 'A 话题', summary: '', keywords: [], status: 'active', members: [
      { sessionId: 'session-root', kind: 'root', title: 'A 中枢', summary: '', status: 'live', modelOverridden: false, lastActiveAt: now },
      { sessionId: 'session-hub1', kind: 'root', title: 'A 中枢二', summary: '', status: 'live', modelOverridden: false, lastActiveAt: now },
    ], createdAt: now, updatedAt: now, lastActiveAt: now }],
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
  // R33 需求④: the production caller passes resolveRole's predicate; a topic-set
  // ROOT member that resolves to HUB is never reused as a branch. A panel-created
  // branch-* row that happens to carry root membership is still a branch.
  const tsHub = {
    title: '构建',
    members: [
      ...ts.members,
      { sessionId: 'session-set-root', kind: 'root', title: '集中枢', summary: '', status: 'idle', modelOverridden: false, lastActiveAt: now },
      { sessionId: 'branch-panel-root', kind: 'root', title: '面板分支', summary: '', status: 'idle', modelOverridden: false, lastActiveAt: now },
    ],
  }
  const isHubMember = (id) => id === 'session-set-root' || id === 'session-conflict'
  assert.deepEqual(
    branchCandidates(tsHub, '修构建', 'auto', new Set(), new Set(), isHubMember).candidates.map((m) => m.sessionId),
    ['branch-a', 'branch-b', 'branch-c', 'branch-panel-root'],
    'a hub root member is excluded from the candidate pool; a branch-* root member is kept',
  )
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

// 9. R33 需求①②④⑧⑨: role resolution + runtime guard + dynamic card contract.
// R36 需求①②: the hub model is a WHITELIST (default deny) — the R33 blacklist
// assertions below were rewritten, not dropped: the same 20 hands-on tools are
// now "outside the whitelist", and an unknown/future tool is denied too.
{
  const { resolveRole, backfillHubRecords } = await import('../src/role.ts')
  const {
    GUARD_ERROR_NAME, ROLE_GUARD_VERSION,
  } = await import('../src/role-guard.ts')
  const {
    DEFAULT_HUB_PREFIXES, DEFAULT_HUB_TOOLS, HOST_SESSION_TOOLS, HUB_CATALOG_GROUPS, HUB_EXECUTION_TOOLS, LOCKED_HUB_TOOLS,
    buildFallbackHubCatalog, buildHubCatalog, cleanStaleHubPolicy,
    isHubAllowedTool, readHubPolicy, resetHubPolicy, writeHubPolicy,
  } = await import('../src/hub-policy.ts')
  const { readFileSync } = await import('node:fs')

  const memberRow = (sessionId, kind, title = sessionId) => ({
    sessionId, kind, title, summary: '', status: 'idle', modelOverridden: false, lastActiveAt: now,
  })
  const roleStore = {
    hubs: table([['session-hub-record', {
      workspaceKey: WS_A, sessionId: 'session-hub-record', title: '记录中枢', source: 'panel', createdAt: now, updatedAt: now,
    }]]),
    topicsets: table([
      ['ts-role', {
        workspaceKey: WS_A, title: '角色', summary: '', keywords: [], status: 'active',
        members: [
          memberRow('session-root', 'root'),
          memberRow('session-conflict', 'root'),
          memberRow('sess-fork-member', 'fork'),
        ],
        createdAt: now, updatedAt: now, lastActiveAt: now,
      }],
      ['ts-foreign', {
        workspaceKey: WS_B, title: '外部', summary: '', keywords: [], status: 'active',
        members: [memberRow('session-foreign-root', 'root')],
        createdAt: now, updatedAt: now, lastActiveAt: now,
      }],
    ]),
    dispatches: table([
      ['dsp-role', {
        topicSetId: 'ts-role', branchSessionId: 'session-conflict', task: '冲突会话',
        hubSessionId: 'session-hub-dispatch', startSeq: 0, status: 'delivered',
        capability: '', title: '', tags: [], createdAt: now, updatedAt: now,
      }],
    ]),
  }
  const agent = (id, cwd = WS_A, extra = {}) => ({ id, session: { id, header: { cwd, ...extra } } })

  // ---- positive hub marks only; branch facts win; workspace-scoped ----
  assert.equal(resolveRole(roleStore, agent('session-hub-record')).role, 'hub', 'hub record is a positive mark')
  assert.equal(resolveRole(roleStore, agent('session-hub-record')).reason, 'hub-record')
  assert.equal(resolveRole(roleStore, agent('session-root')).role, 'hub', 'topic-set root member is a hub')
  assert.equal(resolveRole(roleStore, agent('session-root')).reason, 'topic-set-root')
  assert.equal(resolveRole(roleStore, agent('session-hub-dispatch')).role, 'hub', 'dispatching is a positive hub act')
  assert.equal(resolveRole(roleStore, agent('session-hub-dispatch')).reason, 'dispatch-hub')
  assert.equal(resolveRole(roleStore, agent('branch-abcd1234')).role, 'branch', 'branch-* id is a branch')
  assert.equal(resolveRole(roleStore, agent('fork-abcd1234')).reason, 'plugin-branch-id')
  assert.equal(resolveRole(roleStore, agent('sess-fork-member')).reason, 'fork-member', 'fork member is a branch')
  assert.equal(resolveRole(roleStore, agent('session-conflict')).role, 'branch',
    'a session with a branch fact and a hub mark is a BRANCH (branch priority)')
  assert.equal(resolveRole(roleStore, agent('session-plain')).role, 'other',
    'an ordinary top-level session is NOT a hub (the R32 over-broad inference)')
  assert.equal(resolveRole(roleStore, agent('session-plain')).reason, 'no-positive-marker')
  // R35: no second branch authority may be exported again. route.ts used to own
  // its own prefix+fork rule (missing dispatches.branchSessionId); role-guard
  // also exported a projection. Both now go through resolveRole only.
  const roleGuardModule = await import('../src/role-guard.ts')
  assert.equal(Object.prototype.hasOwnProperty.call(roleGuardModule, 'isBranchSession'), false,
    'role-guard must not export a second isBranchSession authority (use resolveRole)')
  assert.equal(resolveRole(roleStore, agent('session-foreign-root', WS_A)).role, 'other',
    'a root mark from another workspace does not make a hub here')
  assert.equal(resolveRole(roleStore, agent('session-foreign-root', WS_A)).reason, 'workspace-mismatch')
  assert.equal(resolveRole(roleStore, agent('session-foreign-root', WS_B)).role, 'hub',
    'the same root member IS a hub inside its own workspace')
  assert.equal(resolveRole(roleStore, agent('session-sub', WS_A, { origin: 'subagent' })).reason, 'subagent-child')
  assert.equal(resolveRole(undefined, agent('session-hub-record')).role, 'other', 'no store = no role')
  // A table accessor that throws (a closing/reloading store) must not escape
  // the resolution: no session can be classified and the guard must stay total.
  const closedStore = Object.defineProperty({ hubs: table() }, 'topicsets', {
    get() { throw new Error('store closed') },
  })
  const closedAgent = agent('sess-closed')
  assert.equal(resolveRole(closedStore, closedAgent).role, 'other',
    'a closing store degrades to OTHER instead of throwing through the guard')
  assert.equal(resolveRole(closedStore, closedAgent).reason, 'resolution-error')
  ok('R33-2 角色判定：正标记（hub 记录/root 成员/派发中枢）+ 工作区校验 + branch 优先 + 普通顶层不再误判')

  // Positive hub records can be seeded from durable evidence written before R33.
  const backfillStore = {
    hubs: table(),
    topicsets: roleStore.topicsets,
    dispatches: roleStore.dispatches,
  }
  const seeded = await backfillHubRecords(backfillStore)
  assert.equal(seeded, 3, 'root members + dispatch hubs are seeded once')
  assert.equal(backfillStore.hubs.get('session-root').source, 'topicset-root')
  assert.equal(backfillStore.hubs.get('session-hub-dispatch').source, 'dispatch')
  assert.equal(await backfillHubRecords(backfillStore), 0, 'the backfill is idempotent')
  ok('R33-2b hub 记录回填：root 成员 + 派发中枢幂等落库')

  // R35: 一次性补记 R33 之前由面板创建、既未派发也非话题集 root 的中枢。
  // 只接受窄证据：session-* 顶层 id + 标题前缀 SuperMemory 中枢 + 本工作区；
  // 已有记录/分支事实/普通会话/外部工作区一律不写，标记防重跑。
  const {
    migrateHubSessionRecords, knownWorkspaceKeys, HUB_RECORDS_MIGRATION_VERSION,
  } = await import('../src/hub-records-migration.ts')
  const hubTitle = (suffix) => 'SuperMemory 中枢 · ' + suffix
  const titles = new Map([
    ['session-title-hub', hubTitle('thub')],
    ['session-title-plain', '普通用户会话'],
    ['session-title-branch', hubTitle('brch')],
    ['session-title-foreign', hubTitle('frgn')],
    ['session-title-parented', hubTitle('prnt')],
    ['session-title-sub', hubTitle('subs')],
    ['session-title-already', hubTitle('alrd')],
  ])
  const records = [
    { header: { id: 'session-title-hub', cwd: WS_A } },
    { header: { id: 'session-title-plain', cwd: WS_A } },
    { header: { id: 'session-title-branch', cwd: WS_A } },
    { header: { id: 'session-title-foreign', cwd: WS_B } },
    { header: { id: 'session-title-parented', cwd: WS_A, parentSession: 'session-parent' } },
    { header: { id: 'session-title-sub', cwd: WS_A, origin: 'subagent' } },
    { header: { id: 'session-title-already', cwd: WS_A } },
    { header: { id: 'branch-not-a-session', cwd: WS_A } },
    { header: { id: 'plain-id', cwd: WS_A } },
  ]
  const seam = {
    listSessions: async () => records,
    readTitleSnapshots: async (ids) => ids.map((id) => ({
      sessionId: id, status: titles.has(id) ? 'fulfilled' : 'rejected',
      value: titles.has(id) ? { title: { title: titles.get(id) } } : undefined,
    })),
  }
  const migrationCtx = { get: (name) => (name === 'sessionQuery' ? seam : undefined) }
  const migrationStore = {
    hubs: table([['session-title-already', {
      workspaceKey: WS_A, sessionId: 'session-title-already', title: hubTitle('alrd'),
      source: 'panel', createdAt: now, updatedAt: now,
    }]]),
    meta: table(),
    topicsets: table(),
    dispatches: table([['dsp-mig', {
      branchSessionId: 'session-title-branch', task: '迁移用分支', hubSessionId: 'session-hub-record',
      startSeq: 0, status: 'delivered', capability: '', title: '', tags: [], createdAt: now, updatedAt: now,
    }]]),
  }
  const quietMigrationLogger = { warn: () => {}, info: () => {} }
  const migrationDeps = { ctx: migrationCtx, store: migrationStore, logger: quietMigrationLogger, workspaceKeys: [WS_A] }

  const migrationDry = await migrateHubSessionRecords(migrationDeps, { dryRun: true, ignoreMarker: true })
  assert.equal(migrationDry.status, 'planned')
  assert.equal(migrationDry.considered, 4, 'only session-* top-level sessions of this workspace are considered')
  assert.deepEqual(migrationDry.plan.map((item) => item.sessionId), ['session-title-hub'],
    'exactly the unrecorded hub-titled session is planned')
  assert.equal(migrationDry.marked, 0)
  assert.equal(migrationStore.hubs.get('session-title-hub'), undefined, 'dry-run writes nothing')

  const migrationApplied = await migrateHubSessionRecords(migrationDeps, { ignoreMarker: true })
  assert.equal(migrationApplied.marked, 1)
  assert.equal(migrationStore.hubs.get('session-title-hub').source, 'title-migration')
  assert.equal(migrationStore.hubs.get('session-title-hub').workspaceKey, WS_A)
  assert.equal(migrationStore.hubs.get('session-title-plain'), undefined, 'a plain conversation is never marked')
  assert.equal(migrationStore.hubs.get('session-title-foreign'), undefined, 'another workspace is never marked')
  assert.equal(migrationStore.hubs.get('session-title-parented'), undefined, 'a parented child is never marked')
  assert.equal(migrationStore.hubs.get('session-title-sub'), undefined, 'a subagent is never marked')
  assert.deepEqual(
    migrationApplied.skipped.map((row) => row.sessionId + ':' + row.reason).sort(),
    ['session-title-already:already-recorded', 'session-title-branch:branch-fact'],
    'existing records and branch facts are skipped, not overwritten',
  )
  assert.equal(migrationApplied.skippedNonHub, 1, 'the ordinary title is counted as a non-hub')
  assert.equal(migrationStore.meta.get('hub-records')?.hubRecordsMigrationVersion, HUB_RECORDS_MIGRATION_VERSION)
  assert.equal(migrationStore.meta.get('hub-records')?.hubRecordsMigratedAt > 0, true)

  const migrationAgain = await migrateHubSessionRecords(migrationDeps, { ignoreMarker: true })
  assert.equal(migrationAgain.marked, 0, 'the pass is idempotent (records already exist)')
  assert.deepEqual(
    migrationAgain.skipped.filter((row) => row.sessionId === 'session-title-hub').map((row) => row.reason),
    ['already-recorded'],
  )
  assert.equal((await migrateHubSessionRecords(migrationDeps)).status, 'already-done', 'the marker short-circuits a restart')

  // An unreadable title is UNKNOWN, not "not a hub": the marker stays unwritten
  // so the next startup retries instead of losing the session forever.
  const partialStore = { hubs: table(), meta: table(), topicsets: table(), dispatches: table() }
  const partialSeam = {
    listSessions: async () => [{ header: { id: 'session-title-unk', cwd: WS_A } }],
    readTitleSnapshots: async () => [],
  }
  const partial = await migrateHubSessionRecords({
    ctx: { get: (name) => (name === 'sessionQuery' ? partialSeam : undefined) },
    store: partialStore, logger: quietMigrationLogger, workspaceKeys: [WS_A],
  }, { ignoreMarker: true })
  assert.equal(partial.marked, 0)
  assert.equal(partial.pending, 1)
  assert.equal(partialStore.meta.get('hub-records'), undefined, 'an unreadable title keeps the marker open')

  // A BLANK (fulfilled) title is a known non-hub, not an unknown: it must not
  // keep the marker open forever.
  const blankStore = { hubs: table(), meta: table(), topicsets: table(), dispatches: table() }
  const blankSeam = {
    listSessions: async () => [{ header: { id: 'session-title-blank', cwd: WS_A } }],
    readTitleSnapshots: async (ids) => ids.map((id) => ({
      sessionId: id, status: 'fulfilled', value: { title: { title: '   ' } },
    })),
  }
  const blankRun = await migrateHubSessionRecords({
    ctx: { get: (name) => (name === 'sessionQuery' ? blankSeam : undefined) },
    store: blankStore, logger: quietMigrationLogger, workspaceKeys: [WS_A],
  }, { ignoreMarker: true })
  assert.equal(blankRun.pending, 0, 'a blank title is known, not unreadable')
  assert.equal(blankRun.skippedNonHub, 1)
  assert.equal(blankStore.meta.get('hub-records')?.hubRecordsMigrationVersion, HUB_RECORDS_MIGRATION_VERSION,
    'a blank title lets the pass finish and write the marker')

  // The scope list comes from the store's own workspace-bearing tables, never
  // from a guessed cwd; 'unknown' is not a workspace.
  const knownKeys = knownWorkspaceKeys({
    topicsets: table([['t-known', { workspaceKey: WS_A }]]),
    hubs: table([['h-unknown', { workspaceKey: 'unknown' }]]),
  })
  assert.ok(knownKeys.includes(WS_A))
  assert.ok(!knownKeys.includes('unknown'))
  ok('R35-2 hub 记录迁移：窄证据（session-* + 标题前缀 + 本工作区）+ 分支/已记录/普通/外部不误标 + 幂等 + 未读标题留待重试')

  // ---- the runtime guard: complete denial list, total decisions, codes ----
  const hubAgent = agent('session-hub-record')
  const rootHubAgent = agent('session-root')
  const branchAgent = agent('branch-abcd1234')
  const plainAgent = agent('session-plain')
  const subagent = agent('session-sub', WS_A, { origin: 'subagent' })
  const reasonOf = (decision) => decision?.reason
  const codeOf = (decision) => decision?.info?.code

  assert.equal(codeOf(roleGuardDecision(roleStore, branchAgent, 'plugin_manager', { action: 'set_plugin' })), 'BRANCH_RELOAD_DENIED')
  assert.equal(reasonOf(roleGuardDecision(roleStore, branchAgent, 'plugin_manager', { action: 'set_plugin' })), BRANCH_RELOAD_DENIED)
  assert.equal(codeOf(roleGuardDecision(roleStore, branchAgent, 'plugin_manager', { action: 'set_bundle' })), 'BRANCH_RELOAD_DENIED')
  assert.equal(roleGuardDecision(roleStore, branchAgent, 'plugin_manager', { action: 'list_plugins' }), undefined,
    'branch may still LIST plugins')
  assert.equal(roleGuardDecision(roleStore, hubAgent, 'plugin_manager', { action: 'set_plugin' }), undefined,
    'a positively marked hub may reload')
  assert.equal(roleGuardDecision(roleStore, rootHubAgent, 'plugin_manager', { action: 'set_plugin' }), undefined,
    'a topic-set root hub may reload')
  assert.equal(codeOf(roleGuardDecision(roleStore, subagent, 'plugin_manager', { action: 'set_plugin' })), 'NON_HUB_RELOAD_DENIED')
  assert.equal(codeOf(roleGuardDecision(roleStore, plainAgent, 'plugin_manager', { action: 'set_plugin' })), 'NON_HUB_RELOAD_DENIED',
    'an ordinary session is not a hub, so it cannot reload (fail-closed)')
  // Missing/unreadable action is a mutation: fail-closed for every non-hub.
  assert.equal(codeOf(roleGuardDecision(roleStore, branchAgent, 'plugin_manager', {})), 'BRANCH_RELOAD_DENIED',
    'missing action on a branch is still denied (fail-closed)')
  assert.equal(codeOf(roleGuardDecision(roleStore, plainAgent, 'plugin_manager', {})), 'NON_HUB_RELOAD_DENIED',
    'missing action on an ordinary session is still denied (fail-closed)')
  assert.equal(roleGuardDecision(roleStore, hubAgent, 'plugin_manager', {}), undefined,
    'a hub keeps the reload path; the host tool itself validates the action')
  assert.equal(roleGuardDecision(undefined, branchAgent, 'plugin_manager', { action: 'set_plugin' }), undefined,
    'before the store opens the guard stays inert (feature disabled, not a global deny)')

  // ---- R36 需求①: whitelist model (default deny) ----
  // The default whitelist is the R33 allowed set; every hands-on tool that used
  // to be blacklisted is now simply OUTSIDE it, and an unknown/future tool is
  // denied by the same rule.
  const ALLOWED_DEFAULT = [
    'memory_dispatch', 'memory_questions', 'memory_resume', 'memory_recall', 'memory_remember', 'memory_history',
    'memory_topicsets', 'memory_new_topicset', 'memory_export', 'memory_scan', 'memory_set_model', 'memory_toolize',
    'ask_user_question', 'send_message', 'wait_agent', 'list_agents', 'read', 'glob', 'grep',
    'skill', 'todo_write', 'present', 'run_code', 'plugin_manager',
    // R55: read-only capability knowledge face (locked; execution is denied).
    'sm_cap_doc',
  ]
  assert.equal(DEFAULT_HUB_TOOLS.length, ALLOWED_DEFAULT.length,
    'the default whitelist has exactly the documented members (adding/removing one must fail this line)')
  for (const name of ALLOWED_DEFAULT) {
    assert.ok(DEFAULT_HUB_TOOLS.includes(name), 'default whitelist must keep: ' + name)
  }
  assert.deepEqual([...DEFAULT_HUB_PREFIXES], ['schedule_'], 'the schedule family is the default prefix entry')
  assert.equal(LOCKED_HUB_TOOLS.length, 7, 'seven core locked entries (R55 adds sm_cap_doc)')
  for (const name of LOCKED_HUB_TOOLS) {
    assert.ok(DEFAULT_HUB_TOOLS.includes(name), 'a locked entry is on the default whitelist: ' + name)
  }

  // Whitelist predicate: exact names, prefix entries, locked entries.
  const defaultPolicy = { tools: [...DEFAULT_HUB_TOOLS], prefixes: [...DEFAULT_HUB_PREFIXES] }
  assert.equal(isHubAllowedTool('memory_dispatch', defaultPolicy), true)
  assert.equal(isHubAllowedTool('schedule_create', defaultPolicy), true, 'a prefix entry matches')
  assert.equal(isHubAllowedTool('schedule_', defaultPolicy), true)
  assert.equal(isHubAllowedTool('bash', defaultPolicy), false, 'a hands-on tool is outside the whitelist')
  assert.equal(isHubAllowedTool('sm_composite_git_sync_supermemory', defaultPolicy), false,
    'a capability/composite tool is outside the whitelist (no prefix entry)')
  assert.equal(isHubAllowedTool('brand_new_future_tool', defaultPolicy), false,
    'an unknown/future tool is denied by default (the R36 core requirement)')
  assert.equal(isHubAllowedTool('', defaultPolicy), false, 'an empty name is never allowed')

  // The 20 R33 hands-on tools: denied for a hub, still executable for everyone else.
  for (const name of HUB_EXECUTION_TOOLS) {
    const decision = roleGuardDecision(roleStore, hubAgent, name, {})
    assert.equal(codeOf(decision), 'HUB_TOOL_NOT_IN_ALLOWLIST', 'a hub is denied (not whitelisted): ' + name)
    assert.ok(reasonOf(decision).includes('不在中枢白名单中') && reasonOf(decision).includes('中枢权限'),
      'the denial names the panel tab that can enable it: ' + name)
    assert.equal(decision.info.name, GUARD_ERROR_NAME)
    assert.equal(roleGuardDecision(roleStore, branchAgent, name, {}), undefined, 'a branch still executes: ' + name)
    assert.equal(roleGuardDecision(roleStore, plainAgent, name, {}), undefined, 'an ordinary session still executes: ' + name)
  }
  // Unknown/future tool: denied for a hub, allowed for other roles.
  assert.equal(codeOf(roleGuardDecision(roleStore, hubAgent, 'brand_new_future_tool', {})), 'HUB_TOOL_NOT_IN_ALLOWLIST',
    'a hub cannot call a tool nobody whitelisted')
  assert.equal(roleGuardDecision(roleStore, branchAgent, 'brand_new_future_tool', {}), undefined,
    'the whitelist restricts HUBS only; a branch is governed by its capability profile')

  // Default whitelist entries pass for a hub.
  for (const name of ALLOWED_DEFAULT) {
    assert.equal(roleGuardDecision(roleStore, hubAgent, name, {}), undefined, 'hub keeps the whitelisted tool: ' + name)
  }
  assert.equal(roleGuardDecision(roleStore, hubAgent, 'schedule_create', {}), undefined,
    'a prefix entry passes for a hub')

  // plugin_manager: allowed by default, denied once the user removes it.
  assert.equal(roleGuardDecision(roleStore, hubAgent, 'plugin_manager', { action: 'set_plugin' }), undefined,
    'plugin_manager is on the default whitelist, so a hub may still reload')
  const noPluginManager = { tools: ALLOWED_DEFAULT.filter((name) => name !== 'plugin_manager'), prefixes: ['schedule_'] }
  assert.equal(isHubAllowedTool('plugin_manager', noPluginManager), false, 'removing plugin_manager denies it')
  const policyStore = {
    ...roleStore,
    hubPolicies: table([['hub-policy-ws-a', {
      workspaceKey: WS_A, tools: noPluginManager.tools, prefixes: noPluginManager.prefixes, updatedAt: now,
    }]]),
  }
  assert.equal(codeOf(roleGuardDecision(policyStore, hubAgent, 'plugin_manager', { action: 'set_plugin' })),
    'HUB_TOOL_NOT_IN_ALLOWLIST', 'a hub that switched plugin_manager off cannot reload either')
  assert.equal(roleGuardDecision(policyStore, hubAgent, 'memory_dispatch', {}), undefined,
    'the custom policy keeps the dispatch link')

  // Locked entries survive a hostile stored row: a row that omits them still
  // allows them, so a hub can never lock itself out of dispatch/relay.
  const hostile = { tools: ['read'], prefixes: [] }
  for (const name of LOCKED_HUB_TOOLS) {
    assert.equal(isHubAllowedTool(name, hostile), true, 'locked entry passes even when the stored row omits it: ' + name)
  }
  // ...and the writer merges the locked entries back in before persisting.
  const lockStore = { ...roleStore, hubPolicies: table() }
  await writeHubPolicy(lockStore, WS_A, ['read'], [], now)
  const lockRow = [...lockStore.hubPolicies.entries()][0][1]
  for (const name of LOCKED_HUB_TOOLS) {
    assert.ok(lockRow.tools.includes(name), 'writeHubPolicy keeps the locked entry: ' + name)
  }

  // Persisted policy round-trip: write → read (stored) → reset → default.
  const roundStore = { ...roleStore, hubPolicies: table() }
  const roundWarnings = []
  assert.equal(readHubPolicy(roundStore, WS_A, (message) => roundWarnings.push(message)).source, 'default',
    'a workspace with no row reads the built-in default')
  assert.equal(roundWarnings.length, 0, 'a missing row is normal, not a warning')
  await writeHubPolicy(roundStore, WS_A, ['read', 'glob', 'bash'], ['schedule_'], now)
  const stored = readHubPolicy(roundStore, WS_A)
  assert.equal(stored.source, 'stored')
  assert.deepEqual(stored.tools, ['read', 'glob', 'bash', ...LOCKED_HUB_TOOLS], 'the stored list is read back with the locked entries merged')
  assert.equal(isHubAllowedTool('bash', stored), true, 'a user-enabled hands-on tool passes for a hub')
  assert.equal(isHubAllowedTool('write', stored), false, 'a tool outside the stored list is still denied')
  assert.equal(isHubAllowedTool('brand_new_future_tool', stored), false, 'unknown tools stay denied under a custom policy')
  assert.equal(codeOf(roleGuardDecision(roundStore, hubAgent, 'bash', {})), undefined,
    'the guard honours the stored policy (bash enabled by the user)')
  assert.equal(codeOf(roleGuardDecision(roundStore, hubAgent, 'write', {})), 'HUB_TOOL_NOT_IN_ALLOWLIST',
    'the guard denies a tool the stored policy does not list')
  assert.equal(readHubPolicy(roundStore, WS_B).source, 'default', 'another workspace keeps its own default')
  assert.equal(await resetHubPolicy(roundStore, WS_A), true, 'reset drops the stored row')
  assert.equal(readHubPolicy(roundStore, WS_A).source, 'default', 'after reset the default applies again')
  assert.equal(await resetHubPolicy(roundStore, WS_A), false, 'resetting twice is a no-op')

  // Degradation: an unreadable table falls back to the default WITH a warning —
  // neither fail-open (everything allowed) nor fail-closed (dispatch broken).
  const brokenWarnings = []
  const brokenStore = {
    ...roleStore,
    hubPolicies: {
      entries: () => { throw new Error('simulated read failure') },
    },
  }
  const broken = readHubPolicy(brokenStore, WS_A, (message) => brokenWarnings.push(message))
  assert.equal(broken.source, 'default', 'a read failure degrades to the built-in default')
  assert.ok(brokenWarnings.length === 1 && brokenWarnings[0].includes('hub policy read failed'),
    'the degradation is reported, never silent')
  assert.equal(isHubAllowedTool('memory_dispatch', broken), true, 'the default keeps the dispatch link alive')
  assert.equal(isHubAllowedTool('bash', broken), false, 'the default does NOT fail open')
  assert.equal(codeOf(roleGuardDecision(brokenStore, hubAgent, 'brand_new_future_tool', {},
    (message) => brokenWarnings.push(message))), 'HUB_TOOL_NOT_IN_ALLOWLIST',
    'a degraded read still denies unknown tools')
  // A row with both lists empty is treated as absent (default), with a warning.
  const emptyWarnings = []
  const emptyStore = {
    ...roleStore,
    hubPolicies: table([['hub-policy-empty', { workspaceKey: WS_A, tools: [], prefixes: [], updatedAt: now }]]),
  }
  assert.equal(readHubPolicy(emptyStore, WS_A, (message) => emptyWarnings.push(message)).source, 'default')
  assert.ok(emptyWarnings.length === 1 && emptyWarnings[0].includes('empty'))

  // R39 catalog: the DEFAULT path is the DYNAMIC runtime list grouped by source.
  // A fake runtime injects two different sources, one unknown tool, and one
  // whitelisted-but-gone entry; grouping, default-deny, refresh and cleanup are
  // asserted here, and the built-in list is checked only as the FALLBACK.
  const catalogNow = 1_700_000_000_000
  const runtimeDefs = [
    { name: 'memory_recall', description: 'Recall conclusions\nsecond line' },
    { name: 'read', description: 'Read a file' },
    { name: 'mcp__rea__analyze_function', description: 'Analyze a native function' },
    { name: 'brand_new_tool', description: 'A tool nobody reviewed' },
    { name: 'bash', description: 'Run a shell command' },
  ]
  const allow = ['memory_recall', 'read', 'retired_tool', ...LOCKED_HUB_TOOLS]
  const dynamic = buildHubCatalog({
    tools: runtimeDefs,
    allowTools: allow,
    prefixes: ['schedule_', 'mcp__gone__'],
    now: catalogNow,
  })
  assert.equal(dynamic.meta.mode, 'dynamic', 'the default catalog path is dynamic')
  assert.equal(dynamic.meta.generatedAt, catalogNow)
  const syntheticSeen = HOST_SESSION_TOOLS.filter((name) => !runtimeDefs.some((tool) => tool.name === name))
  assert.equal(dynamic.meta.toolCount, runtimeDefs.length + syntheticSeen.length,
    'the tool count includes both real definitions and synthesized host/session entries')
  assert.equal(dynamic.meta.syntheticCount, syntheticSeen.length,
    'the synthetic count is reported separately so the panel can label it')
  assert.deepEqual(dynamic.groups.map((group) => group.id), [
    HUB_CATALOG_GROUPS.supermemory,
    HUB_CATALOG_GROUPS.mcpPrefix + 'rea',
    HUB_CATALOG_GROUPS.hostSession,
    HUB_CATALOG_GROUPS.host,
    HUB_CATALOG_GROUPS.stale,
  ], 'runtime tools are grouped by source, with the synthetic host-session group before host and the stale bucket last')
  const groupOf = (id) => dynamic.groups.find((group) => group.id === id)
  const itemOf = (id, name) => groupOf(id)?.items.find((entry) => entry.name === name)
  assert.equal(itemOf(HUB_CATALOG_GROUPS.supermemory, 'memory_recall')?.enabled, true)
  assert.equal(itemOf(HUB_CATALOG_GROUPS.supermemory, 'memory_recall')?.description, 'Recall conclusions',
    'the item carries only the first line of the description')
  assert.equal(groupOf(HUB_CATALOG_GROUPS.supermemory)?.inferred, true, 'memory_* attribution is labelled as inference')
  assert.equal(groupOf(HUB_CATALOG_GROUPS.mcpPrefix + 'rea')?.label, 'MCP · rea')
  assert.equal(groupOf(HUB_CATALOG_GROUPS.mcpPrefix + 'rea')?.inferred, true)
  const unknown = itemOf(HUB_CATALOG_GROUPS.host, 'brand_new_tool')
  assert.ok(unknown, 'an unknown runtime tool is visible, not dropped')
  assert.equal(unknown.enabled, false, 'an unknown tool is denied by default')
  assert.equal(unknown.locked, undefined, 'an unknown tool is not locked, so the user can check it')
  assert.equal(unknown.stale, undefined, 'a present-but-unreviewed tool is not stale')
  assert.equal(isHubAllowedTool('brand_new_tool', { tools: allow, prefixes: ['schedule_'] }), false,
    'the whitelist still denies it until the user checks it')
  const afterCheck = buildHubCatalog({
    tools: runtimeDefs,
    allowTools: [...allow, 'brand_new_tool'],
    prefixes: ['schedule_'],
    now: catalogNow,
  })
  assert.equal(afterCheck.groups.flatMap((group) => group.items).find((entry) => entry.name === 'brand_new_tool')?.enabled, true,
    'checking an unknown tool whitelists it on the next generation')
  assert.equal(itemOf(HUB_CATALOG_GROUPS.host, 'bash')?.risk, true, 'hands-on tools keep the risk note')
  const synthetic = itemOf(HUB_CATALOG_GROUPS.hostSession, 'run_code')
  assert.equal(synthetic?.locked, true, 'the PTC transport is synthesized, locked, and stays out of the stale group')
  assert.equal(synthetic?.synthetic, true, 'the run_code entry is labelled as synthetic')
  assert.equal(synthetic?.available, true, 'a synthetic host/session entry is always available')
  assert.equal(groupOf(HUB_CATALOG_GROUPS.hostSession)?.synthetic, true, 'the host-session group carries the synthetic marker')
  const flatNames = dynamic.groups.flatMap((group) => group.items.map((entry) => entry.name))
  assert.equal(new Set(flatNames).size, flatNames.length, 'every catalog name appears exactly once')
  const staleNames = dynamic.stale.map((entry) => entry.name)
  for (const name of allow) {
    if (runtimeDefs.some((tool) => tool.name === name) || HOST_SESSION_TOOLS.includes(name)) continue
    assert.ok(staleNames.includes(name), 'a whitelisted name absent at runtime is listed, never silently dropped: ' + name)
  }
  assert.ok(staleNames.includes('mcp__gone__'), 'a whitelisted prefix absent at runtime is listed')
  assert.equal(staleNames.includes('schedule_'), false,
    'the schedule_ prefix matches the synthetic schedule tools, so it is not stale')
  const schedulePrefix = dynamic.groups.flatMap((group) => group.items).find((entry) => entry.prefix === true && entry.name === 'schedule_')
  assert.equal(schedulePrefix?.source, HUB_CATALOG_GROUPS.hostSession,
    'the schedule_ rule renders inside the host-session group of the tools it matches')
  assert.equal(dynamic.stale.find((entry) => entry.name === 'retired_tool')?.enabled, true)
  assert.equal(dynamic.stale.find((entry) => entry.name === 'retired_tool')?.available, false)
  assert.equal(dynamic.stale.find((entry) => entry.name === 'mcp__gone__')?.prefix, true,
    'a prefix that matches nothing is stale too')
  for (const name of LOCKED_HUB_TOOLS) {
    const listed = dynamic.groups.flatMap((group) => group.items).find((entry) => entry.name === name)
    if (runtimeDefs.some((tool) => tool.name === name) || HOST_SESSION_TOOLS.includes(name)) {
      assert.ok(listed && listed.stale !== true, 'a present or synthetic locked tool is not stale: ' + name)
      continue
    }
    // The locked tools the fake runtime omits and no synthetic list covers are stale — and still allowed.
    assert.ok(dynamic.stale.some((entry) => entry.name === name && entry.locked === true),
      'a missing locked tool is reported as stale (and still allowed): ' + name)
  }

  // Refresh: the next generation sees a newly registered tool; the real
  // definition wins over its synthetic placeholder, and the timestamp moves.
  const refreshed = buildHubCatalog({
    tools: [...runtimeDefs, { name: 'schedule_create', description: 'Create a schedule' }],
    allowTools: allow,
    prefixes: ['schedule_', 'mcp__gone__'],
    now: catalogNow + 1000,
  })
  const scheduleGroup = refreshed.groups.find((group) => group.id === HUB_CATALOG_GROUPS.schedule)
  assert.ok(scheduleGroup, 'a newly registered tool creates its own source group on the next generation')
  assert.ok(scheduleGroup.items.some((entry) => entry.name === 'schedule_create' && entry.enabled === true),
    'the schedule_ prefix enables the newly added tool')
  const realSchedule = scheduleGroup.items.find((entry) => entry.name === 'schedule_create')
  assert.equal(realSchedule?.synthetic, undefined, 'a real definition replaces the synthetic placeholder')
  assert.ok(scheduleGroup.items.some((entry) => entry.prefix === true && entry.name === 'schedule_'))
  assert.equal(refreshed.stale.some((entry) => entry.name === 'schedule_'), false,
    'the schedule_ prefix is never stale while synthetic schedule tools exist')
  assert.equal(refreshed.stale.some((entry) => entry.name === 'retired_tool'), true)
  assert.equal(refreshed.meta.generatedAt, catalogNow + 1000, 'the refresh timestamp advances')

  // Declared source: a definition that carries one is NOT labelled as inference.
  // This is future-proofing; the current host contract has no such field.
  const declared = buildHubCatalog({
    tools: [{ name: 'x_tool', description: 'x', source: 'Acme 插件' }],
    allowTools: [],
    prefixes: [],
    now: catalogNow,
  })
  assert.equal(declared.groups[0].id, HUB_CATALOG_GROUPS.declaredPrefix + 'acme')
  assert.equal(declared.groups[0].inferred, false, 'a declared source is not marked as inference')
  assert.equal(declared.meta.anyDeclaredSource, true)

  // Cleanup: exact stale names and non-matching prefixes go; locked and
  // synthetic host/session entries stay.
  const cleaned = cleanStaleHubPolicy({
    allowTools: ['read', 'retired_tool', 'memory_dispatch', 'plugin_manager', 'run_code'],
    prefixes: ['schedule_', 'mcp__gone__'],
    runtimeNames: ['read', 'memory_recall', 'schedule_create'],
  })
  assert.deepEqual(cleaned.tools, ['read', 'memory_dispatch', 'plugin_manager', 'run_code'],
    'stale names are removed; locked and synthetic host/session entries are kept')
  assert.deepEqual(cleaned.prefixes, ['schedule_'], 'only prefixes with no runtime match are removed')
  assert.deepEqual(cleaned.removedNames.sort(), ['mcp__gone__', 'retired_tool'])
  assert.equal(cleaned.removed, 2)
  const syntheticOnly = cleanStaleHubPolicy({
    allowTools: [...HOST_SESSION_TOOLS],
    prefixes: ['schedule_'],
    runtimeNames: [],
  })
  assert.deepEqual(syntheticOnly.tools, [...HOST_SESSION_TOOLS],
    'a cleanup with an empty global runtime keeps every synthetic host/session entry')
  assert.deepEqual(syntheticOnly.removedNames, [], 'no synthetic entry is ever reported as removed')

  // FALLBACK (built-in list) is kept as coverage, not as the default path: it
  // still lists every default entry and every hands-on note, never drops a
  // whitelist entry, and does not fabricate stale verdicts it cannot verify.
  const fallback = buildFallbackHubCatalog({
    allowTools: [...DEFAULT_HUB_TOOLS, 'retired_tool'],
    prefixes: [...DEFAULT_HUB_PREFIXES],
    now: catalogNow,
    warning: 'simulated enumeration failure',
  })
  assert.equal(fallback.meta.mode, 'fallback')
  assert.match(fallback.meta.warning, /simulated enumeration failure/)
  const fallbackFlat = fallback.groups.flatMap((group) => group.items)
  for (const name of DEFAULT_HUB_TOOLS) {
    assert.ok(fallbackFlat.some((entry) => entry.name === name), 'the fallback lists the default entry: ' + name)
  }
  assert.equal(fallback.groups.find((group) => group.id === HUB_CATALOG_GROUPS.hostSession)?.synthetic, true,
    'the fallback also renders the synthetic host-session group')
  for (const name of ['plugin_manager', 'run_code', 'ask_user_question', 'job_output']) {
    const entry = fallbackFlat.find((item) => item.name === name && item.prefix !== true)
    assert.equal(entry?.synthetic, true, 'the fallback marks the synthetic entry: ' + name)
    assert.equal(entry?.available, true, 'the fallback marks the synthetic entry available: ' + name)
  }
  for (const name of LOCKED_HUB_TOOLS) {
    assert.equal(fallbackFlat.find((entry) => entry.name === name)?.locked, true,
      'the fallback marks the locked entry: ' + name)
  }
  assert.ok(fallbackFlat.some((entry) => entry.name === 'bash' && entry.risk === true),
    'the fallback keeps hands-on risk notes')
  assert.ok(fallbackFlat.some((entry) => entry.name === 'retired_tool' && entry.enabled === true),
    'the fallback never silently drops a whitelist entry it does not know')
  assert.equal(fallback.groups.some((group) => group.id === HUB_CATALOG_GROUPS.stale), false,
    'the fallback does not claim stale detection it cannot verify')
  assert.equal(fallback.groups.some((group) => group.id === HUB_CATALOG_GROUPS.supermemory && group.inferred === true), true,
    'the fallback uses the same source-grouping rules')

  assert.equal(ROLE_GUARD_VERSION >= 3, true, 'the guard version is bumped so hosts can tell R33 from R36')
  ok('R39-1 动态目录：运行时工具按来源分组（推断标注）+ 未知工具默认拒绝且可勾选 + 失效条目单列可清理'
    + '+ 刷新反映新增工具 + 宿主声明来源优先 + 枚举失败回退内置清单（告警、不丢白名单条目）')

  // ---- R40: host/session synthetic entries (never stale, never cleaned) ----
  {
    const now40 = catalogNow + 5000
    const globalDefs = [
      { name: 'memory_recall', description: 'Recall conclusions' },
      { name: 'read', description: 'Real read definition' },
    ]
    const required = ['plugin_manager', 'run_code', 'ask_user_question', 'send_message', 'job_output']
    const cat40 = buildHubCatalog({
      tools: globalDefs,
      allowTools: required,
      prefixes: ['schedule_'],
      now: now40,
    })
    const flat40 = cat40.groups.flatMap((group) => group.items)
    const item40 = (name) => flat40.find((entry) => entry.name === name && entry.prefix !== true)
    for (const name of required) {
      const entry = item40(name)
      assert.ok(entry, 'a whitelisted host/session tool is listed even when the global definitions omit it: ' + name)
      assert.equal(entry.source, HUB_CATALOG_GROUPS.hostSession, 'it lands in the host-session group: ' + name)
      assert.equal(entry.synthetic, true, 'it is labelled synthetic: ' + name)
      assert.equal(entry.available, true, 'it is available: ' + name)
      assert.notEqual(entry.stale, true, 'it is never stale: ' + name)
      assert.equal(entry.enabled, true, 'a whitelisted synthetic entry is enabled: ' + name)
    }
    assert.equal(item40('plugin_manager').noteKey, 'pluginManager',
      'the existing plugin-manager warning note is kept in the dynamic path too')
    assert.equal(cat40.stale.length, 0, 'a whitelist made only of synthetic + real entries has no stale bucket')
    const hostSessionGroup = cat40.groups.find((group) => group.id === HUB_CATALOG_GROUPS.hostSession)
    assert.equal(hostSessionGroup?.synthetic, true, 'the host-session group carries the synthetic marker')
    assert.match(hostSessionGroup?.hint ?? '', /不在全局注册面/, 'the group hint states why it is synthetic')
    for (const entry of hostSessionGroup.items.filter((item) => item.prefix !== true)) {
      assert.ok((entry.description ?? '').length > 0,
        'every synthetic entry carries its per-name evidence (no guessed names): ' + entry.name)
    }
    const names40 = flat40.map((entry) => entry.name)
    assert.equal(new Set(names40).size, names40.length, 'no name appears twice')

    // Toggling plugin_manager OFF removes it from the whitelist but keeps the
    // catalog row visible, unchecked and unlockable (it is not a locked entry).
    const off = buildHubCatalog({ tools: globalDefs, allowTools: [], prefixes: [], now: now40 })
    const pmOff = off.groups.flatMap((group) => group.items).find((entry) => entry.name === 'plugin_manager')
    assert.equal(pmOff?.enabled, false, 'plugin_manager can be switched off')
    assert.equal(pmOff?.locked, undefined, 'a synthetic entry is not locked (only locked entries are unremovable from the whitelist)')
    assert.equal(pmOff?.synthetic, true)
    assert.equal(off.stale.some((entry) => entry.name === 'plugin_manager'), false,
      'switching it off does not make it stale')

    // A real definition always wins: no duplicate, no synthetic description.
    const withReal = buildHubCatalog({
      tools: [...globalDefs, { name: 'plugin_manager', description: 'Real registration first line' }],
      allowTools: ['plugin_manager'],
      prefixes: [],
      now: now40,
    })
    const realItems = withReal.groups.flatMap((group) => group.items).filter((entry) => entry.name === 'plugin_manager')
    assert.equal(realItems.length, 1, 'a real plugin_manager definition is not duplicated by the synthetic list')
    assert.equal(realItems[0].synthetic, undefined, 'the real definition is not labelled synthetic')
    assert.equal(realItems[0].description, 'Real registration first line', 'the real description is used')
    assert.equal(realItems[0].source, HUB_CATALOG_GROUPS.host, 'the real definition keeps its normal source attribution')
    const withRealRunCode = buildHubCatalog({
      tools: [...globalDefs, { name: 'run_code', description: 'A host that registers it anyway' }],
      allowTools: ['run_code'],
      prefixes: [],
      now: now40,
    })
    const runCodeItems = withRealRunCode.groups.flatMap((group) => group.items).filter((entry) => entry.name === 'run_code')
    assert.equal(runCodeItems.length, 1, 'run_code from a real definition is not duplicated either')
    assert.equal(runCodeItems[0].synthetic, undefined, 'the real run_code definition wins over the synthetic entry')

    // A global runtime that names a synthetic tool does not leave a phantom
    // host-session group for that name; the group only carries the rest.
    assert.ok(withReal.groups.some((group) => group.id === HUB_CATALOG_GROUPS.hostSession),
      'the host-session group still lists the other synthetic capabilities')
    assert.equal(withReal.groups.find((group) => group.id === HUB_CATALOG_GROUPS.hostSession)?.items
      .some((entry) => entry.name === 'plugin_manager'), false,
    'a real plugin_manager no longer appears in the synthetic group')
  }
  ok('R40-1 宿主会话工具合成项：全局 definitions 缺失时 plugin_manager/run_code 等仍列为 host-session'
    + '+ available/永不失效/清理不移除 + 可关闭后重新勾选 + 真实定义优先且不重复 + 合成组徽标')

  ok('R36-1 中枢白名单（默认拒绝）：默认名单逐条 + 前缀项 + 20 项实操工具改判「名单外拒绝」+ 未知/未来工具拒绝'
    + '+ plugin_manager 可关 + 锁定项不可去 + 存取往返 + 读失败回退默认（不 fail-open 也不断派发）')

  // ---- R37: R35 与 R36 两份并行改动必须同时存活（互相覆盖的防回归锚） ----
  // R35（收尾/迁移/唯一角色入口）与 R36（白名单）由两个会话在同一工作树上
  // 并行完成，曾互相覆盖过一次。这条断言把两侧最关键的事实钉在一起：任何
  // 一侧被改回旧版，本行必定失败——而不是等下一次重载才发现。
  {
    const routeSrc = readFileSync('src/route.ts', 'utf8')
    // R35：route 的分支判定只能走唯一权威 resolveRole，不能长回本地前缀规则。
    assert.ok(/resolveRole\(store,\s*\{\s*id:\s*sessionId\s*\}\)\.role\s*===\s*'branch'/.test(routeSrc),
      'R37: route.ts still decides branch via resolveRole(...).role === branch (R35)')
    assert.equal(routeSrc.includes("startsWith('branch-')"), false,
      'R37: route.ts must not regrow the local branch-prefix authority (R35)')
    // R35：role-guard 不再导出第二套分支权威。
    const guardModule = await import('../src/role-guard.ts')
    assert.equal(Object.prototype.hasOwnProperty.call(guardModule, 'isBranchSession'), false,
      'R37: role-guard still has no isBranchSession export (R35)')
    // R35：启动期迁移的计划/应用入口仍是可调用函数（不是被删掉的死文件）。
    assert.equal(typeof migrateHubSessionRecords, 'function',
      'R37: the hub-records migration entry is still callable (R35)')
    // R36：白名单默认拒绝仍生效，hub_policies 表仍在域声明里。
    const defaultPolicyView = { tools: [...DEFAULT_HUB_TOOLS], prefixes: [...DEFAULT_HUB_PREFIXES] }
    assert.equal(isHubAllowedTool('memory_dispatch', defaultPolicyView), true,
      'R37: the default whitelist keeps the dispatch link (R36)')
    assert.equal(isHubAllowedTool('bash', defaultPolicyView), false,
      'R37: the default whitelist still denies hands-on tools (R36)')
    assert.ok(readFileSync('src/schema.ts', 'utf8').includes('hub_policies:'),
      'R37: the hub_policies table is still registered in schema.ts (R36)')
    ok('R37 共存锚：R35（route 走 resolveRole + 无 isBranchSession 导出 + 迁移入口）与 R36（白名单默认拒绝 + hub_policies 表）同时在树')
  }

  // Total decision: a throwing store keeps plugin_manager closed and everything
  // else open, and the failure is reported (never a silent unguarded host).
  const warnings = []
  assert.equal(codeOf(roleGuardDecision(closedStore, closedAgent, 'plugin_manager', { action: 'set_plugin' },
    (message) => warnings.push(message))), 'NON_HUB_RELOAD_DENIED',
  'a failing role resolution keeps plugin_manager denied')
  assert.equal(roleGuardDecision(closedStore, closedAgent, 'bash', {}, (message) => warnings.push(message)), undefined,
    'a failing role resolution does NOT fail ordinary tools')
  assert.equal(warnings.length, 2, 'each failing resolution reports a warning')
  assert.ok(warnings.every((message) => message.includes('role guard resolution failed')))
  ok('R33-5 执行闸：结构化 code + 缺 action fail-closed + 异常时 plugin_manager 拒绝/其它放行（白名单判定见 R36-1）')

  // ---- card contract (pure half; the DOM half is asserted in client-sim) ----
  const relay = cardMetaOf({ kind: 'supermemory', form: 'relay', fromSessionId: 'branch-abcd1234', fromTitle: '分支甲 · 加测试', dispatchId: 'dsp-1', status: 'returned' })
  assert.ok(relay, 'a relay is card-marked')
  assert.equal(relay.kind, 'branch')
  assert.equal(cardSourceLabel(relay), '分支甲 · 加测试')
  assert.equal(cardSourceLabel({ fromTitle: '', fromSessionId: 'branch-abcd1234' }), '1234', 'title falls back to the id tail')
  const dispatch = dispatchSource({ fromSessionId: 'session-hub1', fromTitle: '中枢甲', task: '加测试', topicSetTitle: 'R33 话题集', capability: 'full', dispatchId: 'dsp-2', status: 'dispatched' })
  const dispatchMeta = cardMetaOf(dispatch)
  assert.equal(dispatchMeta.kind, 'hub')
  assert.equal(dispatchMeta.task, '加测试')
  assert.equal(dispatchMeta.topicSetTitle, 'R33 话题集')
  assert.equal(dispatchMeta.capability, 'full')
  assert.equal(dispatchMeta.dispatchId, 'dsp-2')
  assert.equal(cardMetaOf({ kind: 'user', form: '', text: 'hello' }), null, 'a normal user message is not card-marked')
  assert.equal(cardMetaOf({ kind: 'supermemory', form: 'notice' }), null, 'a notice is not an execution request')
  // R33 需求⑦: the relay card carries the SAME fields as the dispatch card.
  const relayFields = relaySource({
    deliveryId: 'dlv-1', fromSessionId: 'branch-abcd1234', fromTitle: '分支甲', fromKind: 'branch',
    dispatchId: 'dsp-1', status: 'returned', task: '加测试', topicSetTitle: 'R33 话题集', capability: 'full',
  })
  assert.equal(relayFields.kind, 'supermemory')
  assert.equal(relayFields.form, 'relay')
  assert.equal(relayFields.fromTitle, '分支甲')
  assert.equal(relayFields.task, '加测试', 'relay card carries the task')
  assert.equal(relayFields.topicSetTitle, 'R33 话题集', 'relay card carries the topic set')
  assert.equal(relayFields.capability, 'full', 'relay card carries the capability')
  const relayMeta = cardMetaOf(relayFields)
  assert.equal(relayMeta.task, '加测试')
  assert.equal(relayMeta.capability, 'full')

  // Wiring: the pure decision must be installed by apply() (the host seam cannot
  // be built headlessly); the client cell wiring is asserted behaviourally in
  // client-sim-smoke (delegation, t/renderSlotChain, entries() degradation).
  const indexSrc = readFileSync('src/index.ts', 'utf8')
  assert.ok(indexSrc.includes('roleGuardDecision(') && indexSrc.includes("meta.get('role-guard')"),
    'apply() installs the runtime guard and records its meta marker')
  const { zh } = await import('../src/client/locales.ts')
  assert.equal(zh['chat.card.from'], '来自 {session} 的执行请求')
  ok('R33-3 双向卡片契约：两向同字段（任务/话题集/能力/回执）+ 标题回退 + 普通消息不误伤')
}

// ---- R44 需求①②③: 面板页签结构 + i18n 对齐 ----
{
  const { readFileSync } = await import('node:fs')
  const { zh, en } = await import('../src/client/locales.ts')
  const pageSrc = readFileSync('src/client/panel-page.tsx', 'utf8')

  // ① 「中枢会话」页签不再渲染「全部话题集」「全部分支会话」两张卡（连同样式/
  //    空态/远程调用）；宿主方法保留（话题集页签与派发卡仍在用）。
  assert.ok(!pageSrc.includes("key: 'allSets'"), 'R44①: the 全部话题集 card is gone from the hub tab')
  assert.ok(!pageSrc.includes("key: 'allBranches'"), 'R44①: the 全部分支会话 card is gone from the hub tab')
  assert.ok(!pageSrc.includes("key: 'new', className: 'sm-form-col'"),
    'R44③: the 增加记忆 form is gone from the memories tab')
  assert.ok(!pageSrc.includes('fillMemoryShape') && !pageSrc.includes('setNewMemory('),
    'R44③: the add-memory state and its blur auto-fill helper are removed with the form')

  // ② 「分支会话」页签存在，且 body/tab 开关都接上了同一 View 类型。
  assert.ok(pageSrc.includes("| { kind: 'branches' }"), 'R44②: the branches View exists')
  assert.ok(pageSrc.includes("kind === 'branches' ? branchesView"), 'R44②: the body switch renders the branches view')
  assert.ok(pageSrc.includes("...tabProps('branches')"), 'R44②: the tab row renders the branches tab')
  assert.ok(pageSrc.includes('const branchesView: ReactNode'), 'R44②: the branches view is defined')
  // 关键字搜索 + 话题集筛选都在本地做，listAllBranches 仍是数据来源。
  assert.ok(pageSrc.includes('setBranchQuery'), 'R44②: the keyword search state exists')
  assert.ok(pageSrc.includes('api.listAllBranches(cwd)'), 'R44②: the data still comes from the host listAllBranches')
  // 点击沿用现有分支行交互（openChat）。
  assert.ok(/branchesView[\s\S]*openChat\(row\.branchSessionId\)/.test(pageSrc),
    'R44②: a branch row click reuses the existing openChat interaction')

  // ③ 「增加记忆」的 i18n 文案一并清理（中英对称，不残留死键）。
  for (const key of ['memory.new', 'memory.add', 'memory.new.placeholder', 'memory.title.placeholder',
    'memory.tags.placeholder', 'memory.shape.hint', 'memory.shape.auto', 'hub.allSets',
    'hub.allSets.hint', 'hub.allSets.new']) {
    assert.equal(zh[key], undefined, 'zh drops the removed key: ' + key)
    assert.equal(en[key], undefined, 'en drops the removed key: ' + key)
  }

  // 页签顺序：中枢会话 | 话题集 | 分支会话 | 记忆 | 设置（tools 在其后）。
  const tabStart = pageSrc.indexOf("h('div', { key: 'tabs'")
  const tabEnd = pageSrc.indexOf('bodyScroll', tabStart)
  assert.ok(tabStart >= 0 && tabEnd > tabStart, 'the tab row is found in the panel source')
  const tabRow = pageSrc.slice(tabStart, tabEnd)
  const order = ['tab.hub', 'tab.sets', 'tab.branches', 'tab.memories', 'tab.tools', 'tab.settings']
    .map((key) => ({ key, at: tabRow.indexOf(key) }))
    .filter((row) => row.at >= 0)
  assert.deepEqual(order.map((row) => row.key), ['tab.hub', 'tab.sets', 'tab.branches', 'tab.memories', 'tab.tools', 'tab.settings'],
    'R44④: tab order is 中枢会话 | 话题集 | 分支会话 | 记忆 | (固化能力) | 设置')

  // 新键中英齐全（缺键会让标签显示成 raw key）。
  for (const key of ['tab.branches', 'branches.search', 'branches.stats', 'hub.allBranches',
    'hub.allBranches.filter', 'hub.allBranches.allSets', 'hub.allBranches.empty', 'hub.allBranches.hint']) {
    assert.equal(typeof zh[key], 'string', 'zh keeps the branches-tab key: ' + key)
    assert.equal(typeof en[key], 'string', 'en keeps the branches-tab key: ' + key)
  }
  assert.equal(zh['tab.branches'], '分支会话')
  assert.equal(en['tab.branches'], 'Branches')
  assert.equal(zh['branches.stats'], '显示 {shown} / {total} 个分支会话')
  assert.equal(en['branches.stats'], 'Showing {shown} of {total} branch sessions')
  ok('R44-1 面板页签结构：中枢页签去掉两张管理卡 + 新增「分支会话」页签（跨话题集/筛选/搜索/沿用行交互）+ 记忆页签去掉增加入口（i18n 同步清理）+ 页签顺序断言')
}

// ---- R46: release artifacts the DSH plugin panel can actually install ----
// The host's installer reads a spec as registry name / git repository /
// .tgz-or-.tar.gz URL or path; it never queries GitHub Releases and refuses a
// release page or a .zip asset. The release tooling must keep producing an
// npm-pack tarball (and a version-less alias) next to the manual zip, and the
// docs must point users at an accepted input.
{
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const packSrc = readFileSync('scripts/package-release.mjs', 'utf8')
  const ghSrc = readFileSync('scripts/github-api-release.mjs', 'utf8')
  const installDoc = readFileSync('INSTALL.md', 'utf8')
  const readme = readFileSync('README.md', 'utf8')

  assert.ok(packSrc.includes("'pack', '--pack-destination'"),
    'R46①: package-release builds an npm-pack tarball (pnpm pack) beside the zip')
  assert.ok(packSrc.includes('package/lib/supermemory.js') && packSrc.includes('package/cordis.patch.yml'),
    'R46①: the tarball layout is validated against package/ root files')
  assert.ok(packSrc.includes("'dsh-supermemory.tgz'"),
    'R46①: a version-less dsh-supermemory.tgz alias is produced for the stable latest URL')
  assert.ok(packSrc.includes('String.fromCharCode(92)'),
    'R46①: backslash tar entries are rejected (portable archive)')
  assert.ok(packSrc.includes("'--tarball-only'") && packSrc.includes("'--out'"),
    'R46①: a dry-run mode can rebuild only the tarball without touching the manual zip')

  assert.ok(ghSrc.includes("base + '.zip', base + '.tgz'"),
    'R46②: the release uploader uploads both the manual zip and the panel tgz')
  assert.ok(ghSrc.includes("'release', 'dsh-supermemory.tgz'"),
    'R46②: the stable alias is uploaded with each release')
  assert.ok(ghSrc.includes("'application/gzip'"),
    'R46②: the tgz asset is uploaded with a tarball content type')

  const stableUrl = 'https://github.com/FrogMoo/SuperMemory/releases/latest/download/dsh-supermemory.tgz'
  assert.ok(installDoc.includes(stableUrl), 'R46③: INSTALL documents the stable panel tarball URL')
  assert.ok(readme.includes(stableUrl), 'R46③: README documents the stable panel tarball URL')
  assert.ok(installDoc.includes('a URL must point at a git repository or a tarball'),
    'R46③: INSTALL quotes the host rule that refuses a release page / .zip asset')
  assert.ok(installDoc.includes('FrogMoo/SuperMemory') && /裸 owner\/repo|会被当成 npm 包名/.test(installDoc),
    'R46③: INSTALL warns that a bare owner/repo is read as an npm package name')
  assert.ok(installDoc.includes('.tgz') && installDoc.includes('.zip'),
    'R46③: the two artifact roles (panel tgz vs manual zip) are distinguished')
  assert.equal(pkg.name, 'dsh-supermemory', 'R46: the package keeps its plugin name')
}
ok('R46-1 发布资产：zip 之外产出 npm-pack .tgz + 稳定别名，GitHub 上传双资产，文档只给安装器可接受的输入（git 仓库 / .tgz），并说明 zip 与 release 页不接受')

// ---- R47 需求②③: 注入/展示路径的截断修复（预算化 + 显式省略 + 复取线索）----
// 旧病：中枢 prestep 把整张记忆卡 `.slice(0, maxChars)`、各列表行 `.slice(0, N)`，
// 半句/半标签/无标记；超预算时既不说明省略也不给复取线索。这里用超长正文与多
// 卡片把「不越界 / 不半句 / 不半标签 / 显式省略 + 复取 / 预算内完整」钉住。
{
  const { renderRecallCard } = await import('../src/recall.ts')
  const { renderRepeatCard } = await import('../src/inrequest.ts')
  const { clipAtBoundary, clipMarked, clipWithNote, charCount } = await import('../src/clip.ts')
  const { readFileSync } = await import('node:fs')

  const sentence = '这条结论说明构建与发布流程的关键约束。'
  const longBody = sentence.repeat(20) // 380 字，句句有句号 → 只能落在句界
  const record = (index, text = longBody, tags = ['构建', '闸门']) => ({
    memoryId: 'm' + index, title: '结论标题' + index, text, score: 10 - index, createdAt: 1, keywords: tags,
  })
  const HINT = '复取：memory_recall 「构建命令」'
  const NOTE_REFETCH = /…（原文 \d+ 字，已省略 \d+ 字，复取：memory_recall 「[^」]+」）/

  // R47-1 裁剪原语：句界 / 标记 / 带注三种都不越上限，正文不半句，标签不半截。
  const sentenceCut = clipAtBoundary(longBody + '尾巴', 120)
  assert.ok(charCount(sentenceCut) <= 120, 'clipAtBoundary must respect its cap')
  assert.ok(/[。！？；;.!?]$/.test(sentenceCut), 'a body clip must land on a sentence boundary: …' + sentenceCut.slice(-6))
  const marked = clipMarked('提交第 3 个分支的完整任务描述并验证闸门', 20)
  assert.ok(charCount(marked) <= 20 && marked.endsWith('…'), 'a label clip keeps the … marker inside the cap')
  assert.equal(clipMarked('短任务：校验', 40), '短任务：校验', 'a label under the cap is never touched')
  const noted = clipWithNote(longBody, 200, '复取：memory_recall 「结论标题」')
  assert.ok(charCount(noted) <= 200, 'clipWithNote must respect its cap including the note')
  assert.ok(noted.includes('已省略') && noted.includes('memory_recall'), 'the note names the omission and the re-fetch clue')
  const emoji = '结论😀很关键。'.repeat(30)
  for (const budget of [60, 101, 200]) {
    const out = clipWithNote(emoji, budget, '')
    assert.ok(charCount(out) <= budget, 'surrogate-pair text must respect the cap (' + budget + ')')
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out) && !/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out),
      'a clip must never split a surrogate pair')
  }
  ok('R47-1 裁剪原语：句界裁剪 / 标记裁剪 / 带注裁剪都不越界，正文不半句、标签不半截、代理对不劈开')

  // R47-2 超预算记忆卡：整卡 ≤ 预算；标题/标签完整；正文句界裁剪 + 省略量 + 复取线索；
  //        丢掉的记录按整卡计数（不是从正文中段挖空）。
  const over = renderRecallCard([record(1), record(2)], 'gentle', [], { budget: 400, hint: HINT })
  assert.ok(charCount(over) <= 400, 'the recall card must stay inside its budget (' + charCount(over) + ')')
  assert.ok(over.includes('【结论标题1】'), 'the top record keeps its whole title')
  assert.ok(over.includes('｜标签: 构建、闸门'), 'a tags join is rendered whole, never half a tag')
  assert.ok(!/｜标签: [^\n]*、\s*…/.test(over), 'no half tag may survive a clip')
  assert.ok(NOTE_REFETCH.test(over), 'a clipped body reports its original size, the omission and how to re-fetch')
  assert.ok(/…（已省略 1 项，复取：memory_recall 「构建命令」）/.test(over), 'the dropped record is counted on the card')
  const clippedLine = over.split(String.fromCharCode(10)).find((line) => line.includes('原文'))
  assert.ok(/[。！？；;.!?]\s+…（原文/.test(clippedLine), 'a clipped body must not stop mid-sentence: ' + clippedLine)
  ok('R47-2 超预算记忆卡：预算内 + 标题标签完整 + 正文句界省略（字数/复取线索）+ 丢卡计数')

  // R47-3 预算内记忆卡：内容一字不少、没有省略标记（修复不能把正常卡片也削掉）。
  const within = renderRecallCard(
    [record(1, '短结论一：用 pnpm build。'), record(2, '短结论二：先 Gitee 后 GitHub。', ['推送'])],
    'gentle', [{ id: 'ts', title: 'R30 记忆版本', tags: [], score: 3 }], { budget: 2400, hint: HINT })
  assert.ok(charCount(within) <= 2400)
  assert.ok(within.includes('短结论一：用 pnpm build。') && within.includes('短结论二：先 Gitee 后 GitHub。'),
    'a card inside its budget renders every body whole')
  assert.ok(!within.includes('已省略') && !within.includes('原文'), 'no omission marker when nothing was omitted')
  assert.ok(within.includes('相关话题集：R30 记忆版本'), 'the topic-set hint is paid for before the records')
  ok('R47-3 预算内记忆卡：正文完整、无省略标记、话题集提示保留')

  // R47-4 多卡超预算：按优先级丢整卡并计数；被留下的记录仍整条（标题+标签）可读。
  const many = Array.from({ length: 6 }, (_, index) => record(index + 1))
  const dense = renderRecallCard(many, 'plain', [], { budget: 600, hint: HINT })
  const present = many.filter((item) => dense.includes('【' + item.title + '】')).length
  assert.ok(charCount(dense) <= 600, 'six long records still fit the budget (' + charCount(dense) + ')')
  assert.ok(present >= 1 && present < 6, 'some whole cards are shed instead of hollowing a body')
  assert.ok(new RegExp('…（已省略 ' + (6 - present) + ' 项').test(dense),
    'the shed count matches the missing records (' + (6 - present) + ')')
  ok('R47-4 多卡超预算：丢整卡 + 计数与缺失条数一致，不从正文中段挖空')

  // R47-5 预算扫描：任意预算下都不越界、不出现半个标签、丢卡必定有计数。
  const tagSets = [record(1).keywords.join('、'), ['短标签'].join('、')]
  let swept = 0
  for (let budget = 200; budget <= 2400; budget += 37) {
    for (const count of [1, 2, 4, 6]) {
      const items = Array.from({ length: count }, (_, index) =>
        record(index + 1, longBody, index % 2 === 0 ? record(1).keywords : ['短标签']))
      const card = renderRecallCard(items, 'gentle', [{ id: 'ts', title: '话题集', tags: [], score: 3 }], { budget, hint: HINT })
      assert.ok(charCount(card) === 0 || charCount(card) <= budget, 'budget ' + budget + ' never overruns (' + charCount(card) + ')')
      if (charCount(card) === 0) continue
      const kept = items.filter((item) => card.includes('【' + item.title + '】')).length
      if (kept < count) {
        assert.ok(new RegExp('…（已省略 ' + (count - kept) + ' 项').test(card), 'a dropped card is always counted (budget ' + budget + ')')
      }
      for (const tailText of card.split('｜标签: ').slice(1)) {
        const tailLine = tailText.split(String.fromCharCode(10))[0]
        assert.ok(tagSets.includes(tailLine), 'a tags join is never cut in half: ' + tailLine.slice(0, 24))
      }
      swept += 1
    }
  }
  assert.ok(swept >= 200, 'the budget sweep must actually run (' + swept + ' cards)')
  ok('R47-5 预算扫描（200–2400 × 1/2/4/6 条）：不越界、无半标签、丢卡必有计数')

  // R47-6 过程内补充卡优先级：目录块先于正文被牺牲；留得住时目录原样出现；整卡 ≤ 预算。
  const catalog = '可用组合工具（按命中次数）：' + String.fromCharCode(10) + '- sm_composite_read_edit（read → edit）'
  const loose = renderRepeatCard([record(1, '短结论：构建走 pnpm。')], 'gentle', catalog, { budget: 900, hint: HINT })
  assert.ok(loose.includes('可用组合工具') && loose.includes('sm_composite_read_edit'), 'the catalog rides along when there is room')
  assert.ok(charCount(loose) <= 900)
  const tight = renderRepeatCard([record(1), record(2)], 'gentle', catalog, { budget: 420, hint: HINT })
  assert.ok(charCount(tight) <= 420, 'the repeat card must stay inside its budget (' + charCount(tight) + ')')
  assert.ok(/…（原文 \d+ 字，已省略 \d+ 字，复取：memory_recall/.test(tight), 'a clipped repeat body carries the same explicit note')
  assert.ok(tight.includes('【结论标题1】') && tight.includes('｜标签: 构建、闸门'))
  const catalogOnly = renderRepeatCard([], 'plain', '可用组合工具：' + 'x'.repeat(900), { budget: 300 })
  assert.ok(charCount(catalogOnly) <= 300 && catalogOnly.includes('已省略'), 'a catalog-only card is clipped with a sized note, not silently')
  ok('R47-6 过程内补充卡：目录先于正文牺牲、留得住时原样出现、目录单卡也被显式裁剪')

  // R47-7 源守卫：所有注入/展示路径都不再裸 slice 内容字段，改用共享裁剪并带标记。
  const source = (path) => readFileSync(path, 'utf8')
  const prestep = source('src/prestep.ts')
  assert.ok(!/\.slice\(0, config\.maxChars\)/.test(prestep), 'prestep must not hard-slice the assembled card')
  assert.ok(prestep.includes('budget: config.maxChars')
    && prestep.includes('budget: Math.min(config.maxChars, remainingChars(state, config.repeat))'),
    'both prestep cards pass a budget into the renderer instead of slicing afterwards')
  const inrequest = source('src/inrequest.ts')
  assert.ok(!/return clampText\(text,/.test(inrequest) && !/card\.slice\(0,/.test(inrequest),
    'the in-request path no longer clamps/slices the assembled card')
  const toolsSrc = source('src/tools.ts')
  for (const gone of ['row.text.slice(0, 80)', 'i.summary.slice(0, 80)', 'row.task.slice(0, 40)']) {
    assert.ok(!toolsSrc.includes(gone), 'tools.ts drops the raw cut: ' + gone)
  }
  assert.ok(toolsSrc.includes("clipMarked(String(row.text ?? ''), 80)")
    && toolsSrc.includes('clipMarked(i.summary, 80)')
    && toolsSrc.includes("clipMarked(String(row.task ?? ''), 40)"), 'tools.ts excerpts go through clipMarked')
  const questionsSrc = source('src/questions.ts')
  assert.ok(!questionsSrc.includes('question.branchTask.slice(0, 40)')
    && questionsSrc.includes('clipMarked(question.branchTask, 40)'), 'the hub question digest marks its task excerpt')
  const resumeSrc = source('src/resume.ts')
  assert.ok(!resumeSrc.includes('view.partial.slice(0, 160)') && !resumeSrc.includes('row.partial.slice(0, 120)'),
    'resume receipts no longer cut the completed part mid-sentence')
  assert.ok(resumeSrc.includes('clipMarked(view.partial, 160)') && resumeSrc.includes('clipMarked(row.partial, 120)'))
  assert.ok(source('src/panel.ts').includes('return clipMarked(text, maxChars)'),
    'the panel chat preview clips at a boundary')
  const commandsSrc = source('src/commands.ts')
  assert.ok(!commandsSrc.includes('episode.summary.slice(0, 120)')
    && commandsSrc.includes("clipMarked(bits.slice(-6).join(' / '), 500)"),
    '/memory wrap stores a boundary-clipped summary, not a half sentence')
  assert.ok(!source('src/topicset-merge.ts').includes('cluster.summaryAfter.slice(0, 120)'), 'the merge preview marks its clip')
  const webApp = source('src/web/app.js')
  assert.ok(webApp.includes('const clipText =') && !webApp.includes('x.task.slice(0, 90)')
    && !webApp.includes("(m.text || '').slice(0, 48)"), 'the web console clips row excerpts at a boundary')
  assert.ok(!source('src/relay-text.ts').includes('text.slice(0, RELAY_RESULT_MAX_CHARS)'),
    'the relay valve no longer cuts mid-sentence')
  ok('R47-7 源守卫：prestep / inrequest / tools / questions / resume / panel / commands / 合并预览 / 管理台 / relay 全走共享裁剪')
}

console.log(String.fromCharCode(10) + passed + ' checks passed')
process.exit(0)
