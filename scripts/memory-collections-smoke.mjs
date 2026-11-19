/**
 * R22 需求④⑤: 记忆集合 + 条目的回归断言（纯逻辑，host-free）。
 *
 * 由 core-smoke 调用（`runMemoryCollectionChecks()`），也可以单独跑：
 *   node scripts/memory-collections-smoke.mjs
 *
 * 覆盖：
 *   1. 相似度三档（标题×4 / 标签×3 / 正文×1 的加权重合率）
 *   2. remember 的集合匹配：高/中相似复用、低相似新建、显式 id 校验
 *   3. 旧扁平记忆惰性迁移：标签聚类、只补 collectionId、幂等、软删不迁移
 *   4. recall 两级检索：集合命中带出条目并压过弱命中噪声、带集合上下文、limit 兼容
 *   5. 同 key 语义：duplicate / conflict / 工作区隔离
 *   6. memory_export 按集合分组，未归集单独一节，不丢条目
 * @module scripts/memory-collections-smoke
 */
import assert from 'node:assert/strict'

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

/** 运行全部断言；返回通过项数（失败直接抛 assert）。 */
export async function runMemoryCollectionChecks(options = {}) {
  const now = options.now ?? Date.now()
  const ok = options.ok ?? ((label) => console.log('ok - ' + label))
  const {
    buildExport,
  } = await import('../src/export.ts')
  const {
    collectionRows, findMemoryConflict, listCollections, matchCollections, migrateFlatMemories,
    recallEntriesWithCollections, resolveCollectionForEntry, shapeScore, tierOfScore,
  } = await import('../src/memory-collections.ts')
  let passed = 0

  const WS = 'G:' + String.fromCharCode(92) + 'work' + String.fromCharCode(92) + 'mem'
  const mkCollection = (id, title, keywords, summary = '') => [id, {
    workspaceKey: WS, title, keywords, summary, status: 'active', createdAt: now, updatedAt: now,
  }]
  const mkMemory = (id, title, text, keywords, extra = {}) => [id, {
    workspaceKey: WS, title, text, keywords, sourceSessionId: 's', sourceSeq: 1,
    status: 'active', createdAt: now, updatedAt: now, ...extra,
  }]

  // 1) 相似度三档
  {
    const high = shapeScore(
      { title: 'git 同步 方案', keywords: ['git', '同步', '推送'] },
      { title: 'git 同步 记忆', keywords: ['git', '同步', '推送'] },
    )
    const medium = shapeScore(
      { title: 'git 推送 时的凭据', keywords: ['git', '凭据'] },
      { title: 'git 同步 记忆', keywords: ['git', '同步', '推送'] },
    )
    const low = shapeScore(
      { title: 'Python 虚拟环境', keywords: ['python', 'venv'] },
      { title: 'git 同步 记忆', keywords: ['git', '同步', '推送'] },
    )
    assert.ok(high >= 4, '同一标题 + 同一标签必须是高相似: ' + high)
    assert.ok(medium >= 1.75 && medium < 4, '部分重叠 = 中等相似: ' + medium)
    assert.ok(low < 1.75, '无关内容 = 低相似: ' + low)
    assert.equal(tierOfScore(high), 'high')
    assert.equal(tierOfScore(medium), 'medium')
    assert.equal(tierOfScore(low), 'low')
    ok('R22-1 集合相似度三档：标题×4/标签×3/正文×1 加权重合率（高/中/低）')
    passed += 1
  }

  // 2) remember 的集合匹配
  {
    const store = {
      memories: table([]),
      memoryCollections: table([
        mkCollection('mc-git', 'git 同步 记忆', ['git', '同步', '推送'], '本仓库的 git 同步与推送约定'),
        mkCollection('mc-build', '构建命令 记忆', ['构建', 'pnpm'], '构建与测试的固定命令'),
      ]),
    }
    const reuseHigh = await resolveCollectionForEntry(store, WS,
      { title: 'git 同步 方案', keywords: ['git', '同步', '推送'], text: '用 pnpm git:sync' }, { now })
    assert.ok(!('error' in reuseHigh), '高相似必须复用成功')
    assert.equal(reuseHigh.collectionId, 'mc-git', '高相似复用同一集合')
    assert.equal(reuseHigh.tier, 'high')
    assert.equal(reuseHigh.created, false, '高相似不新建集合')
    assert.equal(collectionRows(store).length, 2, '高相似不新增集合行')

    const reuseMedium = await resolveCollectionForEntry(store, WS,
      { title: 'git 凭据 配置', keywords: ['git', '凭据'], text: '用 store helper' }, { now })
    assert.ok(!('error' in reuseMedium))
    assert.equal(reuseMedium.collectionId, 'mc-git', '中等相似也优先复用（需求⑤：不新开集合）')
    assert.equal(reuseMedium.tier, 'medium')
    assert.equal(collectionRows(store).length, 2, '中等相似同样不新增集合')

    const created = await resolveCollectionForEntry(store, WS,
      { title: 'Python 虚拟环境', keywords: ['python', 'venv'], text: '用 .venv' }, { now })
    assert.ok(!('error' in created))
    assert.equal(created.created, true, '低相似才新建集合')
    assert.equal(created.title, 'Python 虚拟环境', '新集合标题取条目标题')
    assert.equal(collectionRows(store).length, 3, '新集合落库')

    const explicit = await resolveCollectionForEntry(store, WS,
      { title: '任意', keywords: ['git'], text: 'x' }, { collectionId: 'mc-build', now })
    assert.ok(!('error' in explicit))
    assert.equal(explicit.collectionId, 'mc-build', '显式 collectionId 直接命中')
    assert.equal(explicit.tier, 'explicit', '显式指定记 explicit 档')

    const missing = await resolveCollectionForEntry(store, WS,
      { title: '任意', keywords: ['git'], text: 'x' }, { collectionId: 'mc-nope', now })
    assert.ok('error' in missing, '不存在的 collectionId 必须报错而不是静默新建')
    assert.match(missing.error, /不存在/)
    ok('R22-2 remember 集合匹配：高/中相似复用、低相似新建、显式 id 校验')
    passed += 1
  }

  // 3) 旧扁平记忆惰性迁移
  {
    const legacy = table([
      mkMemory('old-1', 'git 同步用 pnpm', 'git 同步用 pnpm git:sync', ['git', '同步']),
      mkMemory('old-2', 'git 推送要清 helper', '先清 helper 再用 store', ['git', '同步', '推送']),
      mkMemory('old-3', '构建用 pnpm build', '构建命令是 pnpm build', ['构建', 'pnpm']),
      mkMemory('old-superseded', '旧结论', '被淘汰的结论', ['git'], { status: 'superseded' }),
    ])
    const store = { memories: legacy, memoryCollections: table() }
    const result = await migrateFlatMemories(store, WS, now)
    assert.equal(result.entries, 3, '迁移只处理 active 且无归属的条目: ' + JSON.stringify(result))
    assert.equal(result.collections, 2, '标签聚成 2 个集合（git / 构建）')
    for (const id of ['old-1', 'old-2', 'old-3']) {
      assert.ok(legacy.get(id).collectionId, '旧条目补上 collectionId: ' + id)
      assert.ok(String(legacy.get(id).text).length > 0, '迁移不改写正文（不丢数据）: ' + id)
    }
    assert.equal(legacy.get('old-1').collectionId, legacy.get('old-2').collectionId, '同标签旧条目进同一集合')
    assert.notEqual(legacy.get('old-3').collectionId, legacy.get('old-1').collectionId, '不同标签不混进同一集合')
    assert.equal(legacy.get('old-superseded').collectionId, undefined, '软删条目不参与迁移')
    const again = await migrateFlatMemories(store, WS, now)
    assert.deepEqual(again, { collections: 0, entries: 0 }, '迁移幂等（第二次 0/0）')
    assert.equal(collectionRows(store).length, 2, '幂等不制造重复集合')
    ok('R22-3 旧扁平记忆惰性迁移：标签聚类 / 只补归属 / 幂等 / 软删不迁移')
    passed += 1
  }

  // 4) 两级检索
  {
    const store = {
      memories: table([
        mkMemory('m-in', '深色主题 对比度', '侧边栏对比度按主题变量计算', ['主题'], { collectionId: 'mc-ui' }),
        mkMemory('m-noise', '杂项记录', '顺带提过主题一次', ['杂项']),
        mkMemory('m-other', '构建命令', 'pnpm build', ['构建'], { collectionId: 'mc-build' }),
      ]),
      memoryCollections: table([
        mkCollection('mc-ui', 'UI 主题与对比度', ['主题', '对比度', '侧边栏'], '主题变量与对比度约定'),
        mkCollection('mc-build', '构建命令 记忆', ['构建', 'pnpm'], '构建与测试命令'),
      ]),
    }
    const recall = recallEntriesWithCollections(
      listCollections(store, WS), [...store.memories.entries()], '侧边栏 对比度 主题变量',
      { limit: 5, minScore: 1, halfLifeDays: 30, now },
    )
    assert.ok(recall.collections.length > 0, '第一级必须返回命中的集合')
    assert.equal(recall.collections[0].collectionId, 'mc-ui', '命中的集合排序第一')
    const first = recall.items[0]
    assert.equal(first.memoryId, 'm-in', '集合上下文把该集合的条目排到第一: ' + JSON.stringify(recall.items.map((i) => i.memoryId)))
    assert.equal(first.collectionTitle, 'UI 主题与对比度', '条目带所属集合标题')
    assert.deepEqual(first.collectionTags, ['主题', '对比度', '侧边栏'], '条目带所属集合标签')
    const noiseIndex = recall.items.findIndex((i) => i.memoryId === 'm-noise')
    assert.ok(noiseIndex === -1 || noiseIndex > 0, '正文弱命中的无关条目不排在集合条目之前')

    const limited = recallEntriesWithCollections(
      listCollections(store, WS), [...store.memories.entries()], '构建 pnpm',
      { limit: 1, minScore: 1, halfLifeDays: 30, now },
    )
    assert.equal(limited.items.length, 1, 'limit 仍然只返回 limit 条（兼容旧调用）')

    const withoutCollections = recallEntriesWithCollections(
      [], [...store.memories.entries()], '构建 pnpm',
      { limit: 5, minScore: 1, halfLifeDays: 30, now },
    )
    assert.ok(withoutCollections.items.some((i) => i.memoryId === 'm-other'), '没有集合时仍按旧规则直接命中（向后兼容）')

    const matches = matchCollections(listCollections(store, WS), '主题 对比度', 3)
    assert.equal(matches[0].collectionId, 'mc-ui')
    assert.ok(matches[0].score > 0)
    ok('R22-4 recall 两级检索：集合先匹配、条目带集合上下文、集合条目优先、limit 兼容')
    passed += 1
  }

  // 5) 同 key 语义
  {
    const store = {
      memories: table([
        mkMemory('m-key', '部署端口', '端口是 62590', ['部署'], { key: 'port', collectionId: 'mc-ui' }),
      ]),
      memoryCollections: table([mkCollection('mc-ui', 'UI 主题与对比度', ['主题'])]),
    }
    const dup = findMemoryConflict(store, WS, { text: '端口是 62590', key: 'port' })
    assert.equal(dup.kind, 'duplicate', '同 key 同文本 = duplicate')
    assert.equal(dup.memoryId, 'm-key')
    assert.equal(dup.collectionTitle, 'UI 主题与对比度', 'duplicate 回执带集合上下文')
    const conflict = findMemoryConflict(store, WS, { text: '端口改了', key: 'port' })
    assert.equal(conflict.kind, 'conflict', '同 key 不同文本 = conflict（不覆盖）')
    assert.equal(conflict.text, '端口是 62590', '冲突返回既有正文供裁决')
    const globalDup = findMemoryConflict(store, WS, { text: '端口是 62590' })
    assert.equal(globalDup.kind, 'duplicate', '无 key 时同文本仍判 duplicate')
    assert.equal(findMemoryConflict(store, WS, { text: '全新结论' }), null, '全新内容不误判')
    assert.equal(
      findMemoryConflict(store, 'G:' + String.fromCharCode(92) + 'other', { text: '端口是 62590' }),
      null,
      '工作区隔离（别的 ws 不算重复）',
    )
    ok('R22-5 同 key 更新语义保持：duplicate/conflict + 集合上下文 + 工作区隔离')
    passed += 1
  }

  // 6) 导出按集合分组
  {
    const store = {
      topicsets: table(),
      memories: table([
        mkMemory('e-1', '端口约定', '开发端口是 62590', ['部署'], { collectionId: 'mc-ui' }),
        mkMemory('e-2', '散装结论', '没有集合归属的结论', ['杂项']),
      ]),
      memoryCollections: table([mkCollection('mc-ui', '部署与端口 记忆', ['部署', '端口'], '部署相关约定')]),
      episodes: table(),
      requirements: table(),
      filemap: table(),
    }
    const exported = buildExport(store, WS)
    assert.match(exported.text, /### 记忆集合：部署与端口 记忆/, '导出按集合分组')
    assert.match(exported.text, /开发端口是 62590/, '集合内条目仍导出')
    assert.match(exported.text, /### 未归集/, '未归集条目单独一节（不丢数据）')
    assert.match(exported.text, /没有集合归属的结论/, '未归集条目内容仍在')
    assert.equal(exported.memories, 2, '导出条目数与集合分组无关')
    assert.equal(exported.collections, 1, '导出报告集合数')
    ok('R22-6 memory_export 按记忆集合分组（未归集单独一节，不丢条目）')
    passed += 1
  }

  return passed
}

// 单独运行时也自检（core-smoke 会把同一批断言算进它自己的计数）。
const invokedDirectly = process.argv[1]
  && process.argv[1].replace(/\\/g, '/').endsWith('/scripts/memory-collections-smoke.mjs')
if (invokedDirectly) {
  const passed = await runMemoryCollectionChecks()
  console.log(String.fromCharCode(10) + passed + ' checks passed')
  process.exit(0)
}
