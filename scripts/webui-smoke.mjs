/**
 * webui-smoke — host-side integration check for the Plan A web console.
 *
 * Runs src/webui.ts against an in-memory store stub and a real loopback HTTP
 * server, so the route/API/auth surface is verified without a DSH host.
 * Usage: node scripts/webui-smoke.mjs   (Node >= 22.6 for TS type stripping)
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// src/panel.ts 用了 TypeScript 参数属性，Node 的 strip-only 模式会拒绝——整体
// 重放一次带 transform 的节点（与 capability/workspace-scope 两套 smoke 一致）。
if (!process.execArgv.includes('--experimental-transform-types')) {
  const child = spawnSync(
    process.execPath,
    ['--experimental-transform-types', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

const { attachWebui, getWebui } = await import('../src/webui.ts')
const { workspaceKeyOf } = await import('../src/store.ts')

/** In-memory Table stub with the same surface as the domain layer. */
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
const cwd = mkdtempSync(join(tmpdir(), 'sm-smoke-'))
const ws = workspaceKeyOf(cwd)
mkdirSync(join(cwd, 'src'), { recursive: true })
writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1\n')
writeFileSync(join(cwd, 'README.md'), '# smoke\n')

const store = {
  topicsets: table([['ts-1', {
    workspaceKey: ws, title: '话题集一', summary: '梗概', keywords: ['k'], status: 'active',
    members: [{ sessionId: 'sess-1', kind: 'root', title: '根分支', summary: '', status: 'live', modelOverridden: false, lastActiveAt: now }],
    createdAt: now, updatedAt: now, lastActiveAt: now,
  }]]),
  memories: table([['mem-1', { workspaceKey: ws, text: '旧记忆', keywords: ['old'], status: 'active', sourceSessionId: 'sess-1', sourceSeq: 1, createdAt: now, updatedAt: now }]]),
  episodes: table([['ep-1', { topicSetId: 'ts-1', timeStart: now - 1000, timeEnd: now, summary: '一次归档', decisions: ['D1'], files: [], nextSteps: [], reqIds: [], sourceSessionId: 'sess-1', sourceSeqStart: 0, sourceSeqEnd: 1 }]]),
  requirements: table([['req-1', { workspaceKey: ws, topicSetId: 'ts-1', text: '待办一', constraints: [], status: 'open', sourceSessionId: 'sess-1', sourceSeq: 1, createdAt: now }]]),
  filemap: table(),
  toolMemory: table([['tm-1', { kind: 'composite', trigger: 'x', description: 'd', entry: 'e', useCount: 2, status: 'active' }]]),
  signals: table([['sig-1', { workspaceKey: ws, pattern: 'p', count: 3, lastSeen: now, examples: [], sequence: [], samples: [], proposalStatus: 'pending', proposedAt: now }]]),
  dispatches: table([['d-1', { topicSetId: 'ts-1', branchSessionId: 'br-1', task: '任务', hubSessionId: 'sess-1', startSeq: 0, status: 'delivered', createdAt: now, updatedAt: now }]]),
  outbox: table([['ob-1', { dispatchId: 'd-1', kind: 'single', payload: '交付内容', status: 'confirmed', enqueuedAt: now }]]),
  routing: table([['sess-1', { driftCount: 0, updatedAt: now }]]),
  hotcache: table(),
  // R22 需求④⑤: 记忆集合表（真实 domain 里是新表；管理台的写路径会用它归集）。
  memoryCollections: table(),
}

const server = http.createServer()
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
// One permanent listener dispatches to the currently-registered routes, so a
// disposed route still answers (stub 404) instead of hanging the socket.
const routes = []
server.on('request', (req, res) => {
  const path = req.url?.split('?')[0] ?? '/'
  for (const route of routes) {
    if (path === route.path || path.startsWith(route.path + '/')) return route.handler(req, res)
  }
  res.statusCode = 404
  res.end('stub 404')
})
const webServer = {
  port,
  protocol: 'http:',
  register: (route) => {
    routes.push(route)
    return () => {
      const i = routes.indexOf(route)
      if (i >= 0) routes.splice(i, 1)
    }
  },
}

const logs = []
const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
const ctx = { get: (name) => (name === 'webServer' ? webServer : undefined), effect: (factory) => factory() }

const TOKEN = 'smoke-token'
// Watchdog: never hang the dev loop on a stuck request.
const watchdog = setTimeout(() => { console.error('WATCHDOG: smoke test stalled'); process.exit(2) }, 30000)
watchdog.unref()
const dispose = attachWebui(ctx, store, { enabled: true, token: TOKEN, carrier: 'auto' }, logger)
const base = `http://127.0.0.1:${port}/supermemory`
const auth = { 'x-sm-key': TOKEN }
const json = (body) => ({ method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })

let passed = 0
const ok = (label) => { passed++; console.log(`ok - ${label}`) }

// handle + url
const handle = getWebui()
assert.equal(handle.enabled, true)
assert.equal(handle.port, port)
assert.match(handle.url('sess-1', ws), new RegExp(`^http://127\\.0\\.0\\.1:${port}/supermemory/\\?k=${TOKEN}&session=sess-1&ws=`))
ok('handle exposes tokenised url')

// static shell
const shell = await fetch(base + '/?k=' + TOKEN)
assert.equal(shell.status, 200)
assert.match(shell.headers.get('content-type'), /text\/html/)
const shellText = await shell.text()
assert.match(shellText, /sm-token|SuperMemory/)
assert.match(shellText, /<meta name="sm-token" content="smoke-token">/, 'token must be injected into the shell')
ok('shell served with injected token')

// SECURITY regression: an unauthenticated caller must never receive the token,
// and the static shell must not be CORS-readable by a foreign origin (a foreign
// localhost page could otherwise fetch the token and use the whole API).
const anonShell = await fetch(base + '/', { headers: { origin: 'https://evil.example' } })
assert.equal(anonShell.status, 200)
const anonHtml = await anonShell.text()
assert.ok(!anonHtml.includes(TOKEN), 'token must not be injected for an unauthenticated request')
assert.match(anonHtml, /<meta name="sm-token" content="">/)
assert.equal(anonShell.headers.get('access-control-allow-origin'), null, 'static shell must not be CORS-open')
const authedShell = await fetch(base + '/?k=' + TOKEN)
assert.ok((await authedShell.text()).includes(TOKEN), 'authorized shell still receives the token')
ok('shell hands the token only to authorized requests')

// real assets from src/web/
for (const [asset, marker] of [['app.js', 'SuperMemory 管理台'], ['style.css', '--accent']]) {
  const res = await fetch(base + '/' + asset)
  assert.equal(res.status, 200, asset + ' status')
  const text = await res.text()
  assert.ok(text.includes(marker), asset + ' content')
}
ok('app.js / style.css served from src/web')

// R18 需求⑥: the console ships a fixed nav with the five memory-centre
// sections, card lists instead of wide tables, and the responsive fold.
const appSrc = await (await fetch(base + '/app.js')).text()
const cssSrc = await (await fetch(base + '/style.css')).text()
for (const marker of ['renderHubs', 'renderTools', '中枢会话', '固化能力', 'card-list']) {
  assert.ok(appSrc.includes(marker), 'app.js must include ' + marker)
}
assert.ok(/renderHubs/.test(appSrc) && !/<table>/.test(appSrc.slice(appSrc.indexOf('function renderDispatch'), appSrc.indexOf('function renderEpisodes'))),
  'dispatch renders cards, not a table')
for (const marker of ['.card-list', '.list-card', '.nav-group', '@media (max-width: 760px)', '.modal-backdrop', '.modal ']) {
  assert.ok(cssSrc.includes(marker), 'style.css must include ' + marker)
}
// R19 需求⑦: memory editing is a modal in the console too (same interaction as
// the in-app panel): a backdrop + dialog + save action, not an inline row.
for (const marker of ['function memoryModal', 'modal-backdrop', 'mem-save-modal', 'aria-modal="true"']) {
  assert.ok(appSrc.includes(marker), 'app.js must include ' + marker)
}
assert.ok(!appSrc.includes("data-action=\"mem-save\""), 'the old inline memory editor is gone')
ok('R19 memory editing is a modal in the console (backdrop + dialog + save action)')
ok('console shell: five-section fixed nav + card lists + responsive fold')


// auth
const noAuth = await fetch(base + '/api/workspaces')
assert.equal(noAuth.status, 401)
ok('api rejects missing token')

// CORS: sandboxed sidebar iframes (opaque origin) preflight custom headers
const preflight = await fetch(base + '/api/workspaces', {
  method: 'OPTIONS',
  headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-sm-key, content-type', origin: 'null' },
})
assert.equal(preflight.status, 204)
assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
assert.match(preflight.headers.get('access-control-allow-headers') || '', /x-sm-key/)
const corsGet = await fetch(base + '/api/workspaces', { headers: { ...auth, origin: 'null' } })
assert.equal(corsGet.headers.get('access-control-allow-origin'), '*')
ok('CORS preflight + headers answered')

// workspaces
const wsRes = await fetch(base + '/api/workspaces', { headers: auth })
assert.equal(wsRes.status, 200)
const wsBody = await wsRes.json()
assert.equal(wsBody.ok, true)
const row = wsBody.workspaces.find((w) => w.key === ws)
assert.equal(row.topicsets, 1)
assert.equal(row.memories, 1)
assert.equal(row.requirements, 1)
assert.equal(row.episodes, 1)
ok('workspaces inventory')

// state
const stRes = await fetch(`${base}/api/state?ws=${encodeURIComponent(ws)}`, { headers: auth })
const st = await stRes.json()
assert.equal(st.ok, true)
assert.equal(st.workspace, ws)
assert.equal(st.topicsets[0].id, 'ts-1')
assert.equal(st.memories[0].id, 'mem-1')
assert.equal(st.episodes.length, 1)
assert.equal(st.dispatches.length, 1)
assert.equal(st.outbox.length, 1)
assert.equal(st.routing[0].sessionId, 'sess-1')
assert.equal(st.toolMemory.length, 1)
assert.equal(st.signals.length, 1)
// R18: the 中枢会话 section reads the same hub rule as the panel rail. This
// stub host exposes no sessionQuery, so the section degrades to an empty list
// (never to an error or a missing field).
assert.deepEqual(st.hubs, [], 'a host without sessionQuery yields an empty hub list')
// R19 协同②③: the console shows hub→branch rows even when the hub list is empty:
// the projection is the dispatch table (branch d-1 → set ts-1 → workspace ws).
assert.equal(Array.isArray(st.hubBranches), true, 'the state snapshot carries hubBranches')
assert.equal(st.hubBranches.length, 1, 'the workspace branch row is projected once')
assert.equal(st.hubBranches[0].branchSessionId, 'br-1')
assert.equal(st.hubBranches[0].topicSetTitle, '话题集一', 'the branch names its owning topic set')
assert.equal(st.hubBranches[0].status, 'idle', 'a delivered dispatch leaves the branch idle')
assert.equal(st.hubBranches[0].shared, false, 'one hub is not shared')
assert.equal(st.hubBranches[0].dispatches, 1)
ok('state snapshot joins attached tables')

const badState = await fetch(base + '/api/state', { headers: auth })
assert.equal(badState.status, 400)
ok('state requires ws')

// memory CRUD
const created = await fetch(base + '/api/memory/create', json({ ws, title: ' 测试标题 ', text: '新记忆', keywords: 'a, b', sessionId: 'sess-1' }))
const createdBody = await created.json()
assert.equal(createdBody.ok, true)
const memId = createdBody.id
assert.equal(store.memories.size, 2)
assert.deepEqual(store.memories.get(memId).keywords, ['a', 'b'], 'explicit tags are kept verbatim (no auto-keyword noise)')
assert.equal(store.memories.get(memId).title, '测试标题', 'the title column is stored (trimmed)')
assert.equal(store.memories.get(memId).status, 'active')
// R22 需求⑤: the console write path joins the collection layer immediately
// (related collection → append entry), not only through recall's lazy migration.
const createdCollection = store.memories.get(memId).collectionId
assert.equal(typeof createdCollection, 'string', 'new memory carries a collection id')
assert.ok(createdCollection && createdCollection.length > 0, 'new memory lands in a collection')
assert.equal(store.memoryCollections.get(createdCollection).title, '测试标题', 'the collection is seeded from the entry title')
ok('memory create')

const upd = await fetch(base + '/api/memory/update', json({ ws, id: memId, title: '改过的标题', text: '改过的记忆', keywords: ['c'] }))
assert.equal((await upd.json()).ok, true)
assert.equal(store.memories.get(memId).text, '改过的记忆')
assert.deepEqual(store.memories.get(memId).keywords, ['c'])
assert.equal(store.memories.get(memId).title, '改过的标题')
// R10: the state snapshot the console renders must expose the index fields.
const shapeState = await (await fetch(`${base}/api/state?ws=${encodeURIComponent(ws)}`, { headers: auth })).json()
const shaped = shapeState.memories.find((m) => m.id === memId)
assert.equal(shaped.title, '改过的标题')
assert.deepEqual(shaped.tags ?? shaped.keywords, ['c'])
ok('memory update')

const soft = await fetch(base + '/api/memory/status', json({ ws, id: memId, status: 'superseded' }))
assert.equal((await soft.json()).ok, true)
assert.equal(store.memories.get(memId).status, 'superseded')
const restore = await fetch(base + '/api/memory/status', json({ ws, id: memId, status: 'active' }))
assert.equal((await restore.json()).ok, true)
assert.equal(store.memories.get(memId).status, 'active')
ok('memory soft delete + restore')

const cross = await fetch(base + '/api/memory/update', json({ ws: 'OTHER', id: memId, text: '越界' }))
assert.equal(cross.status, 400)
ok('cross-workspace write rejected')

const del = await fetch(base + '/api/memory/delete', json({ ws, id: memId }))
assert.equal((await del.json()).ok, true)
assert.equal(store.memories.size, 1)
ok('memory hard delete')

// requirement CRUD
const req = await fetch(base + '/api/requirement/create', json({ ws, text: '新需求', topicSetId: 'ts-1', constraints: ['必须'] }))
const reqId = (await req.json()).id
assert.equal(store.requirements.size, 2)
const reqClose = await fetch(base + '/api/requirement/update', json({ ws, id: reqId, status: 'closed' }))
assert.equal((await reqClose.json()).ok, true)
assert.equal(store.requirements.get(reqId).status, 'closed')
assert.ok(store.requirements.get(reqId).closedAt > 0)
const reqDel = await fetch(base + '/api/requirement/delete', json({ ws, id: reqId }))
assert.equal((await reqDel.json()).ok, true)
assert.equal(store.requirements.size, 1)
ok('requirement CRUD')

// topicset CRUD + activate
const ts = await fetch(base + '/api/topicset/create', json({ ws, title: '新话题集', summary: 's', keywords: 'x,y' }))
const tsId = (await ts.json()).id
assert.equal(store.topicsets.size, 2)
const tsUpd = await fetch(base + '/api/topicset/update', json({ ws, id: tsId, title: '改名', status: 'archived' }))
assert.equal((await tsUpd.json()).ok, true)
assert.equal(store.topicsets.get(tsId).title, '改名')
assert.equal(store.topicsets.get(tsId).status, 'archived')
const act = await fetch(base + '/api/topicset/activate', json({ ws, id: tsId, sessionId: 'sess-2' }))
assert.equal((await act.json()).ok, true)
assert.equal(store.routing.get('sess-2').activeTopicSetId, tsId)
ok('topicset CRUD + activate routing')

// filemap scan + export
const scan = await fetch(base + '/api/filemap/scan', json({ ws, cwd }))
const scanBody = await scan.json()
assert.equal(scanBody.ok, true)
assert.ok(scanBody.scanned >= 2)
assert.ok(scanBody.total >= 2)
ok('filemap scan')

const exp = await fetch(base + '/api/export', json({ ws, cwd }))
const expBody = await exp.json()
assert.equal(expBody.ok, true)
assert.ok(existsSync(join(cwd, '.supermemory-export.md')))
assert.ok(expBody.memories >= 1)
ok('export writes markdown')

// regression: a mutating route without ws must be rejected, not write an
// orphan row that belongs to no workspace; a malformed body is a 400/413, not a 500.
const memoriesBefore = store.memories.size
const noWs = await fetch(base + '/api/memory/create', json({ text: '无工作区' }))
assert.equal(noWs.status, 400)
assert.equal((await noWs.json()).ok, false)
assert.equal(store.memories.size, memoriesBefore, 'no row may be written without ws')
const badJson = await fetch(base + '/api/memory/create', {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{oops',
})
assert.equal(badJson.status, 400)
assert.equal(store.memories.size, memoriesBefore)
ok('missing ws / malformed body rejected with 400')

// destructive cleanup routes: workspace-validated, and they cascade their dependants
const dspWrong = await fetch(base + '/api/dispatch/delete', json({ ws: 'OTHER', id: 'd-1' }))
assert.equal(dspWrong.status, 400)
const dspDel = await fetch(base + '/api/dispatch/delete', json({ ws, id: 'd-1' }))
assert.equal((await dspDel.json()).ok, true)
assert.equal(store.dispatches.get('d-1'), undefined)
assert.equal(store.outbox.get('ob-1'), undefined, 'dispatch delete must drop its relay rows')
const epWrong = await fetch(base + '/api/episode/delete', json({ ws: 'OTHER', id: 'ep-1' }))
assert.equal(epWrong.status, 400)
const epDel = await fetch(base + '/api/episode/delete', json({ ws, id: 'ep-1' }))
assert.equal((await epDel.json()).ok, true)
assert.equal(store.episodes.get('ep-1'), undefined)
const tsDel = await fetch(base + '/api/topicset/delete', json({ ws, id: tsId }))
assert.equal((await tsDel.json()).ok, true)
assert.equal(store.topicsets.get(tsId), undefined)
assert.equal(store.routing.get('sess-2'), undefined, 'topicset delete must cascade its routing pointer')
ok('delete routes: workspace-validated + cascade')

// protocol edges
const unknown = await fetch(base + '/api/nope', json({ ws }))
assert.equal(unknown.status, 404)
const getMut = await fetch(base + '/api/memory/create', { headers: auth })
assert.equal(getMut.status, 405)
const head = await fetch(base + '/', { method: 'HEAD' })
assert.equal(head.status, 200)
ok('404 / 405 / HEAD edges')

// R22 能力（capability）：注册 / 一键执行 / 写操作闸门 / 启停 / 删除
{
  const capSpec = {
    name: 'sm_composite_webui_cap', kind: 'capability', description: 'webui 执行冒烟', title: 'webui 能力',
    entry: 'echo webui-capability-ok', steps: [], parameters: [], runnable: true, dryRunArg: '--dry-run',
  }
  const writeSpec = { ...capSpec, name: 'sm_composite_webui_w', writeConfirm: true }
  store.toolMemory.put('tm-cap', { kind: 'composite', workspaceKey: ws, title: 'webui 能力', tags: ['git'], trigger: 'capability/x', description: 'webui 执行冒烟', entry: JSON.stringify(capSpec), useCount: 0, status: 'active' })
  store.toolMemory.put('tm-w', { kind: 'composite', workspaceKey: ws, title: '写能力', tags: [], trigger: '', description: 'd', entry: JSON.stringify(writeSpec), useCount: 0, status: 'active' })

  // 预演执行（dryRunArg 缺省附加）
  const dry = await (await fetch(base + '/api/tool/run', json({ ws, id: 'tm-cap' }))).json()
  assert.equal(dry.ok, true)
  assert.equal(dry.status, 'completed')
  assert.equal(dry.exitCode, 0)
  assert.ok(dry.stdout.includes('webui-capability-ok'), 'stdout captured over HTTP')
  assert.equal(dry.dryRun, true)
  assert.ok(dry.command.includes('--dry-run'))
  assert.equal(store.toolMemory.get('tm-cap').useCount, 1, 'a run bumps the durable counter')
  ok('R22-1 tool/run 预演：捕获 stdout/退出码，自动附加预演参数并计数')

  // 写操作闸门：显式实跑无 confirm → needs-confirm（不执行）；confirm=true → 真跑
  const blocked = await (await fetch(base + '/api/tool/run', json({ ws, id: 'tm-w', dryRun: false }))).json()
  assert.equal(blocked.ok, true)
  assert.equal(blocked.status, 'needs-confirm')
  assert.equal(store.toolMemory.get('tm-w').useCount, 0, 'needs-confirm executes nothing')
  const confirmed = await (await fetch(base + '/api/tool/run', json({ ws, id: 'tm-w', confirm: true }))).json()
  assert.equal(confirmed.status, 'completed')
  assert.equal(confirmed.dryRun, false, 'confirm=true really runs')
  assert.ok(confirmed.stdout.includes('webui-capability-ok'))
  assert.equal(store.toolMemory.get('tm-w').useCount, 1)
  ok('R22-2 tool/run 写操作闸门：无 confirm 拒绝执行，confirm=true 才真跑')

  // 注册（headless ctx：只落库，重启后 rebuildComposites 补注册）
  const reg = await (await fetch(base + '/api/tool/register', json({
    ws, name: 'webui-registered', title: '控制台注册的能力', description: '通过管理台表单注册。',
    entry: 'echo registered-from-webui', scope: cwd, doc: 'docs/git-sync.md', dryRunArg: '--dry-run',
    writeConfirm: true, runnable: true, tags: ['git', '冒烟'],
  }))).json()
  assert.equal(reg.ok, true, 'register must succeed: ' + (reg.error || ''))
  assert.equal(reg.name, 'sm_composite_webui_registered')
  const regRow = store.toolMemory.get(reg.id)
  assert.equal(JSON.parse(regRow.entry).kind, 'capability')
  assert.equal(regRow.workspaceKey, ws)
  const bad = await fetch(base + '/api/tool/register', json({ ws, name: 'x', description: 'd', entry: '' }))
  assert.equal(bad.status, 400)
  ok('R22-3 tool/register：落库（kind=composite + spec.kind=capability，按工作区隔离），非法入参 400')

  // 启停 + 删除 + 未知 id + 序列工具不可一键执行
  const st = await (await fetch(base + '/api/tool/status', json({ ws, id: 'tm-cap', status: 'retired' }))).json()
  assert.equal(st.ok, true)
  assert.equal(store.toolMemory.get('tm-cap').status, 'retired')
  const unknownRun = await fetch(base + '/api/tool/run', json({ ws, id: 'tm-nope' }))
  assert.equal(unknownRun.status, 400)
  const del = await (await fetch(base + '/api/tool/delete', json({ ws, id: 'tm-cap' }))).json()
  assert.equal(del.ok, true)
  assert.equal(store.toolMemory.get('tm-cap'), undefined)
  store.toolMemory.put('tm-seq', { kind: 'composite', title: '序列', tags: [], trigger: '', description: 'd', entry: JSON.stringify({ name: 'sm_composite_seq', steps: [{ tool: 'read', arguments: {} }], parameters: [] }), useCount: 0, status: 'active' })
  const seqRun = await (await fetch(base + '/api/tool/run', json({ ws, id: 'tm-seq' }))).json()
  assert.equal(seqRun.ok, false)
  assert.match(seqRun.error, /只有能力/)
  ok('R22-4 tool/status 停用 + tool/delete 删除 + 未知 id 拒绝 + 序列工具不可一键执行')

  // R22 需求③：面板 listTools 必须把一条能力的完整定义带出来（入口命令、文档、
  // 适用范围、路由描述、执行/预演方式、健康信号），否则面板详情只能显示描述。
  {
    const goodSpec = {
      name: 'sm_composite_webui_detail', kind: 'capability', title: '详情能力',
      description: '详情冒烟', entry: 'echo detail', doc: 'README.md', scope: cwd,
      routeNote: '重复构建类事务优先用它', runnable: true, dryRunArg: '--dry-run',
      writeConfirm: true, steps: [], parameters: [], version: 1,
    }
    const badSpec = { ...goodSpec, name: 'sm_composite_webui_bad', scope: join(cwd, 'nope'), doc: 'gone.md' }
    store.toolMemory.put('tm-detail', {
      kind: 'composite', workspaceKey: ws, title: '详情能力', tags: [], trigger: '',
      description: '详情冒烟', entry: JSON.stringify(goodSpec), useCount: 0, status: 'active',
    })
    store.toolMemory.put('tm-detail-bad', {
      kind: 'composite', workspaceKey: ws, title: '坏范围', tags: [], trigger: '',
      description: '坏范围冒烟', entry: JSON.stringify(badSpec), useCount: 0, status: 'active',
    })
    const { SupermemoryPanelService } = await import('../src/panel.ts')
    const rows = new SupermemoryPanelService(store).listTools(cwd)
    const row = rows.find((tool) => tool.name === 'sm_composite_webui_detail')
    assert.ok(row, 'the panel lists the capability for its workspace')
    assert.equal(row.kind, 'capability')
    assert.equal(row.entry, 'echo detail')
    assert.equal(row.doc, 'README.md')
    assert.equal(row.scope, cwd)
    assert.equal(row.routeNote, '重复构建类事务优先用它')
    assert.equal(row.runnable, true)
    assert.equal(row.dryRunArg, '--dry-run')
    assert.equal(row.writeConfirm, true)
    assert.equal(row.builtin, false)
    assert.equal(row.docMissing, false)
    assert.equal(row.scopeMissing, false)
    assert.ok(Array.isArray(row.notes), 'health notes ship with the row')
    const badRow = rows.find((tool) => tool.name === 'sm_composite_webui_bad')
    assert.ok(badRow, 'a capability whose scope vanished is still listed (row-level ownership wins)')
    assert.equal(badRow.scopeMissing, true)
    assert.ok(badRow.notes.some((note) => note.includes('适用范围目录不存在')), 'the health note explains the missing scope')
    ok('R22-5 面板 listTools 带出能力详情（入口/文档/适用范围/路由/执行方式/健康信号）')
  }
}
// dispose removes the route
dispose()
const after = await fetch(base + '/api/workspaces', { headers: auth })
assert.equal(after.status, 404)
assert.equal(getWebui(), undefined)
ok('dispose unregisters route')

// fallback carrier: host without ctx.webServer -> own loopback server
const ctxNoWs = { get: () => undefined, effect: (factory) => factory() }
const dispose2 = attachWebui(ctxNoWs, store, { enabled: true, token: 'own-token', carrier: 'auto' }, logger)
const handle2 = getWebui()
assert.equal(handle2.enabled, true)
// listen(0) binds asynchronously; the port settles on the next tick.
for (let i = 0; i < 100 && handle2.port === 0; i++) await new Promise((r) => setTimeout(r, 10))
assert.ok(handle2.port > 0, 'own server must listen')
const base2 = 'http://127.0.0.1:' + handle2.port + '/supermemory'
const own = await fetch(base2 + '/api/workspaces', { headers: { 'x-sm-key': 'own-token' } })
assert.equal(own.status, 200)
assert.ok((await own.json()).workspaces.length >= 1)
assert.match(handle2.url(), new RegExp('^http://127\\.0\\.0\\.1:' + handle2.port + '/supermemory/\\?k=own-token$'))
ok('own-http fallback carrier serves console')
dispose2()
assert.equal(getWebui(), undefined)
ok('fallback carrier disposes')

// carrier 'own' must ignore an AVAILABLE ctx.webServer (sidebar-openable origin)
const dispose3 = attachWebui(ctx, store, { enabled: true, token: 'own-token', carrier: 'own' }, logger)
const handle3 = getWebui()
for (let i = 0; i < 100 && handle3.port === 0; i++) await new Promise((r) => setTimeout(r, 10))
assert.ok(handle3.port > 0 && handle3.port !== port, 'carrier=own must use its own port, not the host webServer port')
const base3 = 'http://127.0.0.1:' + handle3.port + '/supermemory'
const own3 = await fetch(base3 + '/api/workspaces', { headers: { 'x-sm-key': 'own-token' } })
assert.equal(own3.status, 200)
// the host webServer route must NOT have been registered by carrier=own
const hostRoute = await fetch(base + '/api/workspaces', { headers: auth })
assert.equal(hostRoute.status, 404, 'carrier=own must not register on the host webServer')
ok("carrier 'own' ignores host webServer (different origin, sidebar-openable)")
dispose3()
assert.equal(getWebui(), undefined)
ok("carrier 'own' disposes")

server.closeAllConnections?.()
server.close()
rmSync(cwd, { recursive: true, force: true })
console.log(`\n${passed} checks passed; log lines: ${logs.length}`)
console.log(logs.slice(0, 3).join('\n'))
clearTimeout(watchdog)
process.exit(0)
