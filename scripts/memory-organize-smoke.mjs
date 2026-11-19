/**
 * R23 memory re-layout — pure-logic regression checks (host-free).
 *
 * Run standalone: node scripts/memory-organize-smoke.mjs
 * core-smoke imports runMemoryOrganizeChecks() and counts these assertions.
 *
 * Covers: dry-run writes nothing; collections created/reused; entries moved
 * with title/tags/body; near-duplicate merged only into the keeper; junk
 * deleted; body-hash guard keeps an edited row; old collections removed only
 * when empty; unknown entries assigned (or fallback created); marker makes a
 * second pass a no-op; another workspace is untouched; the embedded plan's
 * shape (unique ids, collection keys, titles/tags limits, merge targets).
 * @module scripts/memory-organize-smoke
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

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

const NOW = 1_760_000_000_000
const WS = 'F:\\10-SuperMemory'
const OTHER = 'F:\\other-work'

function memory(id, text, extra = {}) {
  return [id, {
    workspaceKey: WS, title: '', text, keywords: [],
    sourceSessionId: 's', sourceSeq: 1, status: 'active',
    createdAt: NOW, updatedAt: NOW, ...extra,
  }]
}

function collection(id, title, extra = {}) {
  return [id, {
    workspaceKey: WS, title, keywords: ['t1', 't2', 't3'],
    summary: title, status: 'active', createdAt: NOW, updatedAt: NOW, ...extra,
  }]
}

export async function runMemoryOrganizeChecks(options = {}) {
  const ok = options.ok ?? ((label) => console.log('ok - ' + label))
  const {
    ORGANIZE_PLAN, ORGANIZE_VERSION, applyMemoryOrganize, organizeMarkerKey, organizeState,
    planMemoryOrganize, previewMemoryOrganize, renderMemoryOrganizeReport,
  } = await import('../src/memory-organize.ts')
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let passed = 0

  // 7) the embedded plan's shape (runs before the engine scenarios; static)
  {
    const ids = [...ORGANIZE_PLAN.entries.map((row) => row.memoryId), ...ORGANIZE_PLAN.deletes.map((row) => row.memoryId)]
    assert.equal(new Set(ids).size, ids.length, '每个记忆 id 在计划里只出现一次（条目或删除）')
    const keys = new Set(ORGANIZE_PLAN.collections.map((row) => row.key))
    assert.equal(keys.size, ORGANIZE_PLAN.collections.length, '集合 key 唯一')
    assert.equal(keys.has('other'), false, 'other 是保留 key，不能出现在正式集合里')
    for (const spec of ORGANIZE_PLAN.collections) {
      assert.ok(spec.title.length > 0 && spec.title.length <= 48, `集合标题 ≤48：${spec.title}`)
      assert.ok(spec.keywords.length >= 3 && spec.keywords.length <= 8, `集合标签 3–8：${spec.title}`)
      assert.equal(new Set(spec.keywords).size, spec.keywords.length, `集合标签不重复：${spec.title}`)
      assert.ok(spec.summary.length > 0, `集合有一句 summary：${spec.title}`)
    }
    for (const item of ORGANIZE_PLAN.entries) {
      assert.ok(keys.has(item.collection), `条目指向存在的集合 key：${item.memoryId}`)
      assert.ok(item.title.length > 0 && item.title.length <= 48, `条目标题 ≤48：${item.memoryId}`)
      assert.ok(item.keywords.length >= 3, `条目标签至少 3 个：${item.memoryId}`)
      if (item.text !== undefined || item.appendText !== undefined) {
        assert.match(item.expectTextSha256 ?? '', /^[a-f0-9]{64}$/, `合并/补注条目必须有正文哈希守卫：${item.memoryId}`)
      }
      if (item.text !== undefined) assert.ok(item.text.length <= 1500, `合并后正文不超过 1500 字：${item.memoryId}`)
    }
    for (const item of ORGANIZE_PLAN.deletes) {
      assert.equal(item.expectTextSha256.length, 64, `删除条目必须有正文哈希守卫：${item.memoryId}`)
      assert.ok(item.reason.length > 0, `删除条目必须写理由：${item.memoryId}`)
      if (item.mergedInto) {
        assert.ok(ORGANIZE_PLAN.entries.some((row) => row.memoryId === item.mergedInto), `合并目标在保留条目里：${item.mergedInto}`)
      }
    }
    assert.equal(new Set(ORGANIZE_PLAN.oldCollectionIds).size, ORGANIZE_PLAN.oldCollectionIds.length, '旧集合 id 不重复')
    assert.equal(ORGANIZE_PLAN.version, ORGANIZE_VERSION, '计划版本与常量一致')
    assert.equal(ORGANIZE_PLAN.entries.length, 12, '整理后保留 12 条结论')
    assert.equal(ORGANIZE_PLAN.deletes.length, 10, '删除/吸收 10 条（6 占位 + 4 重复）')
    ok('R23-1 整理计划形态：id 唯一、集合标题/标签合规、合并目标存在、删除均有哈希与理由')
    passed += 1
  }

  // Engine fixture: a small plan with the same semantics as the real one.
  const TEST_PLAN = {
    version: 1,
    collections: [
      { key: 'a', title: '主题 A', keywords: ['a1', 'a2', 'a3'], summary: 'A 主题的结论' },
      { key: 'b', title: '主题 B', keywords: ['b1', 'b2', 'b3'], summary: 'B 主题的结论' },
    ],
    entries: [
      { memoryId: 'm-1', collection: 'a', title: '第一条', keywords: ['a1', 'a2', 'a3'] },
      {
        memoryId: 'm-2', collection: 'a', title: '第二条（合并）', keywords: ['a1', 'a2', 'a3'],
        text: '第二条正文 + 被合并条目独有信息', expectTextSha256: sha('第二条正文'),
      },
      { memoryId: 'm-3', collection: 'b', title: '第三条', keywords: ['b1', 'b2', 'b3'] },
      { memoryId: 'm-missing', collection: 'b', title: '缺失条目', keywords: ['b1', 'b2', 'b3'] },
    ],
    deletes: [
      { memoryId: 'm-junk', title: '占位', reason: '占位无结论', expectTextSha256: sha('写结论性记忆') },
      { memoryId: 'm-absorbed', title: '被合并', reason: '已并入 m-2', mergedInto: 'm-2', expectTextSha256: sha('被合并条目正文') },
      { memoryId: 'm-edited', title: '被人改过的占位', reason: '占位无结论', expectTextSha256: sha('原始正文') },
    ],
    oldCollectionIds: ['mc-old-1'],
  }

  const seed = () => ({
    memories: table([
      memory('m-1', '第一条正文', { title: '旧标题', keywords: ['x'], collectionId: 'mc-old-1' }),
      memory('m-2', '第二条正文', { collectionId: 'mc-old-1' }),
      memory('m-3', '第三条正文', { collectionId: 'mc-old-1' }),
      memory('m-junk', '写结论性记忆', { collectionId: 'mc-old-1' }),
      memory('m-absorbed', '被合并条目正文', { collectionId: 'mc-old-1' }),
      memory('m-edited', '用户后来改成了一条真结论', { collectionId: 'mc-old-1' }),
      memory('m-unknown', '完全无关的一句话', { keywords: [] }),
      memory('m-inactive', '已停用的旧结论', { status: 'superseded', collectionId: 'mc-old-1' }),
      memory('m-other-ws', '别的仓库的记忆', { workspaceKey: OTHER }),
    ]),
    memoryCollections: table([
      collection('mc-old-1', '拥挤的大杂烩集合'),
      collection('mc-lost', '空集合', { keywords: ['t'] }),
      collection('mc-other-ws', '别的仓库集合', { workspaceKey: OTHER }),
    ]),
    meta: table(),
  })

  const backupDir = mkdtempSync(join(tmpdir(), 'sm-organize-'))

  // 2) preview: no writes at all; projection shows the after state
  {
    const store = seed()
    const beforeSize = [...store.memories.entries()].length
    const collectionsBefore = [...store.memoryCollections.entries()].length
    const result = await previewMemoryOrganize(store, WS, TEST_PLAN)
    assert.equal(result.status, 'preview', '未执行时是 preview')
    assert.equal([...store.memories.entries()].length, beforeSize, '预览不写记忆')
    assert.equal([...store.memoryCollections.entries()].length, collectionsBefore, '预览不写集合')
    assert.equal(store.meta.get(organizeMarkerKey(WS)), undefined, '预览不写标记')
    assert.equal(result.after?.uncollected, 0, '投影后没有未归集条目')
    assert.equal(result.after?.entries, 5, '投影保留 5 条 active（3 条计划内 + 冲突保留 1 条 + 计划外 1 条）')
    const counts = Object.fromEntries(result.collections.map((row) => [row.title, row.entryCount]))
    assert.equal(counts['主题 A'], 2, 'A 主题 2 条')
    assert.equal(counts['主题 B'], 1, 'B 主题 1 条（m-3）')
    assert.equal(counts['其他结论（待归类）'], 2, '无关条目与冲突保留条目落到兜底集合')
    assert.equal(counts['拥挤的大杂烩集合'], undefined, '旧集合不再有条目')
    assert.match(renderMemoryOrganizeReport(result), /预演，未写库/, '报告标注预演')
    ok('R23-2 预演只读：不写记忆/集合/标记，投影集合条目数正确')
    passed += 1
  }

  // 3) apply: collections + moves + merge + junk delete + old cleanup + marker
  {
    const store = seed()
    const result = await applyMemoryOrganize(store, WS, { plan: TEST_PLAN, now: NOW, backupDir })
    assert.equal(result.status, 'applied', '首次执行写库')
    assert.equal(result.after?.uncollected, 0, '整理后无未归集')
    assert.equal(result.before.entries, 7, '整理前 7 条本工作区 active')
    assert.equal(store.memories.get('m-junk'), undefined, '占位条目被删除')
    assert.equal(store.memories.get('m-absorbed'), undefined, '被合并条目在 keeper 写入后删除')
    assert.equal(store.memories.get('m-2')?.text, '第二条正文 + 被合并条目独有信息', 'keeper 保留合并后的正文')
    assert.equal(store.memories.get('m-3')?.text, '第三条正文', '未合并条目的正文不变')
    assert.equal(store.memories.get('m-edited')?.status, 'active', '正文被改过的条目仍保留')
    assert.equal(store.memories.get('m-other-ws')?.workspaceKey, OTHER, '别的仓库记忆不动')
    assert.ok(store.memories.get('m-inactive')?.collectionId, '已停用条目也补有效归属（不留悬挂 collectionId）')
    assert.notEqual(store.memories.get('m-inactive')?.collectionId, 'mc-old-1', '已停用条目的旧集合引用被迁移')
    assert.ok(store.memories.get('m-1')?.collectionId, '条目都有 collectionId')
    const collectionIds = [...store.memoryCollections.keys()]
    for (const [, memory] of store.memories.entries()) {
      if (memory.workspaceKey === WS && memory.status === 'active') {
        assert.ok(collectionIds.includes(memory.collectionId ?? ''), `有效归属：${memory.text}`)
      }
    }
    assert.equal(store.memoryCollections.get('mc-old-1'), undefined, '旧的大杂烩集合在清空后被删除')
    assert.ok(store.memoryCollections.get('mc-lost'), '与计划无关的集合保留')
    assert.ok(store.memoryCollections.get('mc-other-ws'), '别的仓库集合保留')
    assert.ok(store.meta.get(organizeMarkerKey(WS))?.organizeVersion >= 1, '写入整理标记')
    assert.match(result.backupPath ?? '', /organize-v1-.*\.json$/, '返回备份路径')
    assert.ok(existsSync(result.backupPath ?? ''), '备份文件真实存在')
    ok('R23-3 整理执行：分类/合并/清占位/删旧集合/补归属/备份/标记')
    passed += 1
  }

  // 4) body-hash guard: an edited row is reported, never deleted
  {
    const store = seed()
    const result = await applyMemoryOrganize(store, WS, { plan: TEST_PLAN, now: NOW, backupDir })
    const conflict = result.conflicts.find((row) => row.memoryId === 'm-edited')
    assert.ok(conflict, '被手动改过的占位条目进入冲突清单')
    assert.equal(conflict.action, 'delete', '标记为删除冲突')
    assert.ok(store.memories.get('m-edited'), '冲突条目不删除')
    ok('R23-4 正文哈希守卫：计划制定后被手动改过的条目保留并报冲突')
    passed += 1
  }

  // 5) idempotency: a second pass is a no-op (marker)
  {
    const store = seed()
    await applyMemoryOrganize(store, WS, { plan: TEST_PLAN, now: NOW, backupDir })
    const again = await applyMemoryOrganize(store, WS, { plan: TEST_PLAN, now: NOW + 1, backupDir })
    assert.equal(again.status, 'already-done', '第二次执行被标记挡住')
    ok('R23-5 幂等：标记存在时不重复执行')
    passed += 1
  }

  // 6) merge keeper missing/conflicted → absorbed row is kept (no data loss)
  {
    const store = seed()
    store.memories.update('m-2', (row) => ({ ...row, text: 'keeper 被改过' }))
    const result = await applyMemoryOrganize(store, WS, { plan: TEST_PLAN, now: NOW, backupDir })
    assert.ok(result.conflicts.some((row) => row.memoryId === 'm-absorbed' && row.action === 'merge'), 'keeper 冲突时报告合并冲突')
    assert.ok(store.memories.get('m-absorbed'), 'keeper 未写入合并正文时，被合并条目保留')
    assert.equal(store.memories.get('m-2')?.text, 'keeper 被改过', 'keeper 被手动编辑后正文不被覆盖')
    ok('R23-6 合并安全：keeper 未就绪时不删除被合并条目，也不覆盖手改正文')
    passed += 1
  }

  // 7b) content idempotency without the marker: an appended correction is not
  //     duplicated, and the already-merged body is not reported as a conflict.
  {
    const appendPlan = {
      version: 1,
      collections: [{ key: 'x', title: '主题 X', keywords: ['x1', 'x2', 'x3'], summary: 'X' }],
      entries: [{
        memoryId: 'm-append', collection: 'x', title: '带补注的条目', keywords: ['x1', 'x2', 'x3'],
        appendText: '（补注）', expectTextSha256: sha('原正文'),
      }],
      deletes: [],
      oldCollectionIds: ['mc-old-2'],
    }
    const store = {
      memories: table([memory('m-append', '原正文', { collectionId: 'mc-old-2' })]),
      memoryCollections: table([collection('mc-old-2', '旧集合二')]),
      meta: table(),
    }
    await applyMemoryOrganize(store, WS, { plan: appendPlan, now: NOW, backupDir })
    const first = store.memories.get('m-append')?.text
    const again = await applyMemoryOrganize(store, WS, { plan: appendPlan, now: NOW + 1, ignoreMarker: true, backupDir })
    assert.equal(store.memories.get('m-append')?.text, first, '重复执行不重复追加补注')
    assert.equal(again.conflicts.length, 0, '已满足的计划不报冲突（内容幂等）')
    ok('R23-7b 内容幂等：手动重跑不重复追加补注、不误报冲突')
    passed += 1
  }

  // 8) plan applies to the real pre-R23 shape with zero unknown and correct
  //    before/after arithmetic (synthetic rows carrying the real ids).
  {
    const store = seed()
    // Use the real plan against a store that contains only its keepers/old cols.
    const plan = ORGANIZE_PLAN
    const rows = []
    for (const item of plan.entries) {
      if (item.expectTextSha256) continue // hash-guarded rows need the real bodies
      rows.push(memory(item.memoryId, '正文', { collectionId: plan.oldCollectionIds[0] }))
    }
    store.memories = table(rows)
    store.memoryCollections = table(plan.oldCollectionIds.map((id, index) => collection(id, `旧集合 ${index}`, { keywords: ['t1', 't2', 't3'] })))
    const planned = planMemoryOrganize(store, WS, plan)
    assert.equal(planned.deletions.length, 0, '清库后计划里的删除项都不在场，计划自然收缩')
    assert.equal(planned.conflicts.length, 0, '在场条目无冲突')
    assert.equal(new Set(planned.present.map((row) => row.memoryId)).size, planned.present.length, '在场条目唯一')
    ok('R23-7 计划可重入：只处理仍在场的行，缺失行自动跳过（不报错）')
    passed += 1
  }

  rmSync(backupDir, { recursive: true, force: true })
  return passed
}

const invokedDirectly = process.argv[1]
  && process.argv[1].replace(/\\/g, '/').endsWith('/scripts/memory-organize-smoke.mjs')
if (invokedDirectly) {
  const passed = await runMemoryOrganizeChecks()
  console.log(String.fromCharCode(10) + passed + ' checks passed')
  process.exit(0)
}
