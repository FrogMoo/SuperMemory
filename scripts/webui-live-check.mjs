/**
 * webui-live-check — end-to-end verification against a RUNNING console.
 *
 * Usage: node scripts/webui-live-check.mjs <baseUrl> <token>
 *   baseUrl e.g. http://127.0.0.1:62816/supermemory
 *   token   the ?k= value from /memory ui (or scraped from the served shell)
 *
 * Performs a safe write round-trip (create -> verify -> update -> delete) and
 * checks the cross-workspace guard, so the live store is left untouched.
 */
const [base, token] = process.argv.slice(2)
if (!base || !token) {
  console.error('usage: node scripts/webui-live-check.mjs <baseUrl> <token>')
  process.exit(2)
}

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'x-sm-key': token, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
const get = (path) => fetch(base + path, { headers: { 'x-sm-key': token } }).then((r) => r.json())

let failed = 0
const check = (label, cond, detail) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''))
  if (!cond) failed++
}

;(async () => {
  const wsList = await get('/api/workspaces')
  check('workspaces reachable', wsList.ok === true && wsList.workspaces.length > 0, wsList.workspaces.map((w) => w.key).join(' | '))
  const ws = wsList.workspaces[0].key

  const created = await post('/api/memory/create', {
    ws, text: '[webui-live-test] 管理台 API 实测记忆，稍后自动删除', keywords: 'webui,test', sessionId: 'live-check',
  })
  const id = created.json && created.json.id
  check('memory create', created.status === 200 && !!id, created.status + ' ' + JSON.stringify(created.json))
  if (!id) process.exit(1)

  let st = await get('/api/state?ws=' + encodeURIComponent(ws))
  const m = st.memories.find((x) => x.id === id)
  check('memory visible in state', !!m && m.status === 'active' && Array.isArray(m.keywords) && m.keywords.length === 2,
    m ? m.status + ' ' + JSON.stringify(m.keywords) : 'missing')

  const upd = await post('/api/memory/update', { ws, id, text: '[webui-live-test] 改过的文本' })
  check('memory update', upd.status === 200 && upd.json.ok === true, JSON.stringify(upd.json))
  st = await get('/api/state?ws=' + encodeURIComponent(ws))
  check('updated text lands', (st.memories.find((x) => x.id === id) || {}).text === '[webui-live-test] 改过的文本')

  const del = await post('/api/memory/delete', { ws, id })
  check('memory delete', del.status === 200 && del.json.ok === true, JSON.stringify(del.json))
  st = await get('/api/state?ws=' + encodeURIComponent(ws))
  check('deleted memory gone', !st.memories.some((x) => x.id === id), 'total=' + st.memories.length)

  // A FOREIGN workspace key must be rejected. This must not depend on a second
  // workspace existing (with one workspace the old code sent this workspace's
  // own key and the check inverted into a guaranteed FAIL), and it must not
  // dereference an absent memory row.
  const foreignWs = wsList.workspaces.map((w) => w.key).find((key) => key !== ws) || ws + '\\__other__'
  const crossTarget = (st.memories[0] || {}).id ?? id
  const cross = await post('/api/memory/update', { ws: foreignWs, id: crossTarget, text: 'x' })
  check('cross-workspace write rejected', cross.status === 400, cross.status + ' ' + JSON.stringify(cross.json))

  const bad = await fetch(base + '/api/state?ws=' + encodeURIComponent(ws))
  check('unauthenticated read rejected', bad.status === 401, String(bad.status))

  console.log(failed === 0 ? '\nALL LIVE CHECKS PASSED' : '\n' + failed + ' CHECK(S) FAILED')
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
