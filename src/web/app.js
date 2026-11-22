'use strict'

/* SuperMemory 管理台 — Plan A 前端（vanilla JS，无框架无外链） */
const API = '/supermemory/api'
const TOKEN = (document.querySelector('meta[name="sm-token"]') || {}).content || ''
const URL_PARAMS = new URLSearchParams(location.search)
const URL_SESSION = URL_PARAMS.get('session') || ''

// R18 需求⑥: fixed left navigation — 中枢会话/话题集/记忆/组合工具/统计 first,
// the operational detail sections under a second group.
const SECTIONS = [
  ['hubs', '中枢会话', 'primary'],
  ['topicsets', '话题集', 'primary'],
  ['memories', '记忆', 'primary'],
  ['tools', '固化能力', 'primary'],
  ['overview', '统计', 'primary'],
  ['requirements', '需求', 'more'],
  ['dispatch', '派发与交付', 'more'],
  ['episodes', '归档梗概', 'more'],
  ['filemap', '文件地图', 'more'],
  ['signals', '信号', 'more'],
]

const state = {
  ws: null,
  workspaces: [],
  data: null,
  section: SECTIONS.some(([id]) => id === (location.hash || '').replace('#', ''))
    ? (location.hash || '').replace('#', '')
    : 'hubs',
  auto: localStorage.getItem('sm-auto') !== '0',
  memQuery: '',
  memFilter: 'all',
  // R30 需求②: 记忆两级页——memCollection=null 在第一级（集合卡片），
  // 为字符串（含 '' 未归集）时在第二级（集合内条目）；memDetail 为记忆 id
  // 时在第三级（详情 + 历史版本）。memHistory 缓存已拉取的历史版本。
  memCollection: null,
  memDetail: null,
  memHistory: {},
  memVersionOpen: null,
  // R11: 话题集按标题/标签过滤（索引检索，不扫正文）
  tsQuery: '',
  // R30 需求③: 中枢会话页按话题集筛选分支行（'' = 全部话题集）。
  branchFilter: '',
  editing: new Set(),
  // R19 需求⑦: memory editing is a modal, exactly like the in-app panel.
  editMem: null,
  // R22 能力：执行结果弹窗 + 写操作二次确认弹窗。
  capRun: null,
  capConfirm: null,
  // R27：注册新能力表单的展开状态（render 重建 #content 后要保留）。
  capOpen: false,
}

const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—')
// R27 修复：会话 id 形如 session-<uuid>，只截前 8 字符会把每条都渲染成
// "session-"，下拉框里所有选项看起来一模一样。改为「头 8 + … + 尾 6」的中间
// 省略，短 id 原样显示。
const short = (id) => {
  const s = String(id == null ? '' : id)
  if (!s) return '—'
  if (s.length <= 14) return esc(s)
  return esc(s.slice(0, 8) + '…' + s.slice(-6))
}
const kwHtml = (kws) => (kws || []).map((k) => `<span class="kw">${esc(k)}</span>`).join(' ')

/**
 * R30 需求④: branchSessionId → 最新一次派发的显式标题/标签（管理台本地投影，
 * 与宿主 hub-branches 的 newest-row-wins 同一规则；旧派发无这两个字段时为空）。
 */
function branchMeta(d) {
  const map = new Map()
  for (const x of d.dispatches || []) {
    if (!x.branchSessionId) continue
    const at = Math.max(x.updatedAt || 0, x.createdAt || 0)
    const cur = map.get(x.branchSessionId)
    if (cur && at < cur.at) continue
    map.set(x.branchSessionId, { title: x.title || '', tags: x.tags || [], at })
  }
  return map
}
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { 'x-sm-key': TOKEN } }
  if (options.body) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const res = await fetch(API + path, init)
  let json = null
  try { json = await res.json() } catch { /* 非 JSON 错误页 */ }
  if (res.status === 401) throw new Error('认证失败：请通过 /memory ui 重新打开管理台')
  if (!res.ok || !json || json.ok !== true) throw new Error((json && json.error) || ('HTTP ' + res.status))
  return json
}

let toastTimer = 0
function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200)
}
function showError(e) {
  const b = $('#banner')
  b.textContent = (e && e.message) || String(e)
  b.classList.remove('hidden')
}
function clearError() { $('#banner').classList.add('hidden') }

async function loadWorkspaces() {
  state.workspaces = (await api('/workspaces')).workspaces || []
}
async function loadState() {
  clearError()
  try {
    state.data = await api('/state?ws=' + encodeURIComponent(state.ws))
    render()
  } catch (e) { showError(e) }
}

function render() {
  let group = ''
  $('#sections').innerHTML = SECTIONS.map(([id, label, grp]) => {
    const head = grp !== group ? `<div class="nav-group">${grp === 'primary' ? '记忆中枢' : '运维明细'}</div>` : ''
    group = grp
    return head + `<button type="button" class="nav-item${state.section === id ? ' active' : ''}" data-action="nav" data-id="${id}">${label}</button>`
  }).join('')
  $('#ws-select').innerHTML = state.workspaces.map((w) =>
    `<option value="${esc(w.key)}"${w.key === state.ws ? ' selected' : ''}>${esc(w.key)}</option>`).join('')
  $('#gen-at').textContent = state.data ? '更新于 ' + fmtTime(state.data.generatedAt) : ''
  $('#auto-refresh').checked = state.auto
  const renderer = {
    hubs: renderHubs, overview: renderOverview, topicsets: renderTopicsets, memories: renderMemories,
    tools: renderTools, requirements: renderRequirements, dispatch: renderDispatch, episodes: renderEpisodes,
    filemap: renderFilemap, signals: renderSignals,
  }[state.section]
  $('#content').innerHTML = (renderer && state.data ? renderer(state.data) : '<div class="empty">加载中…</div>') + memoryModal() + capRunModal() + capConfirmModal()
}

/* ---------- 分区渲染 ---------- */

function renderOverview(d) {
  const dq = d.dispatches.reduce((m, x) => { m[x.status] = (m[x.status] || 0) + 1; return m }, {})
  const cards = [
    ['话题集', d.topicsets.filter((t) => t.status === 'active').length + ' 活跃 / ' + d.topicsets.filter((t) => t.status === 'archived').length + ' 归档'],
    ['话题集会话', d.topicsets.reduce((n, t) => n + ((t.members || []).length), 0) + ' 个会话'],
    ['事实记忆', d.memories.filter((m) => m.status === 'active').length + ' 生效 / ' + d.memories.filter((m) => m.status === 'superseded').length + ' 软删'],
    ['需求', d.requirements.filter((r) => r.status === 'open').length + ' 未完成 / ' + d.requirements.filter((r) => r.status === 'closed').length + ' 已完成'],
    ['归档梗概', d.episodes.length],
    ['派发', Object.keys(dq).length ? Object.entries(dq).map(([k, v]) => k + ' ' + v).join(' · ') : '无'],
    ['待交付 outbox', d.outbox.filter((o) => o.status === 'pending').length],
    ['重复信号', d.signals.length],
    ['固化能力', d.toolMemory.length],
    ['文件地图', d.filemap.length],
  ]
  const tsTitle = (id) => { const t = d.topicsets.find((x) => x.id === id); return t ? t.title : '（已删除）' }
  return `
  <div class="cards">${cards.map(([k, v]) => `<div class="card-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
  <div class="panel"><header>会话 → 活跃话题集</header><div class="body">
    <div class="card-list">${d.routing.length
      ? d.routing.map((r) => `
        <div class="list-card">
          <div class="list-card-head"><b>${short(r.sessionId)}</b>${badge('drift ' + r.driftCount)}<span class="grow"></span><span class="muted">${fmtTime(r.updatedAt)}</span></div>
          <div class="row-meta"><span>活跃话题集 ${esc(tsTitle(r.activeTopicSetId))}</span></div>
        </div>`).join('')
      : '<div class="empty">暂无会话路由记录</div>'}</div>
  </div></div>
  <div class="panel"><header>导出</header><div class="body">
    <button class="btn" type="button" data-action="export">导出 .supermemory-export.md</button>
    <span class="muted">写入工作区根目录，与插件 /memory export 同格式。</span>
  </div></div>`
}

function renderTopicsets(d) {
  const sessions = d.routing.map((r) => r.sessionId)
  const defaultSession = sessions.includes(URL_SESSION) ? URL_SESSION : (sessions[0] || '')
  const head = `
  <div class="panel"><header>新建话题集</header><div class="body">
    <form data-form="ts-create" class="form-inline">
      <input type="text" name="title" placeholder="标题（≤40 字）" required style="flex:1;min-width:200px">
      <input type="text" name="keywords" placeholder="关键词，逗号分隔（可选）" style="flex:1;min-width:180px">
      <button class="btn primary" type="submit">创建</button>
    </form>
  </div></div>`
  // 标题 + 标签是索引：先按索引过滤，命中数为 0 时才回退到正文（梗概）匹配。
  const needle = (state.tsQuery || '').trim().toLowerCase()
  const indexHit = (t) => !needle
    || String(t.title || '').toLowerCase().includes(needle)
    || (t.keywords || []).some((k) => String(k).toLowerCase().includes(needle))
  const bodyHit = (t) => !needle || String(t.summary || '').toLowerCase().includes(needle)
  const indexed = d.topicsets.filter(indexHit)
  const shown = indexed.length > 0 ? indexed : d.topicsets.filter(bodyHit)
  const totalSessions = d.topicsets.reduce((n, t) => n + ((t.members || []).length), 0)
  const bar = `
  <div class="toolbar">
    <input type="text" id="ts-q" placeholder="按标题或标签搜索话题集…" value="${esc(state.tsQuery || '')}">
    <span class="muted">显示 ${shown.length} / ${d.topicsets.length} 个话题集 · 共 ${totalSessions} 个会话</span>
  </div>`
  const list = shown.length
    ? shown.map((t) => topicSetCard(t, d, defaultSession)).join('')
    : '<div class="empty">没有匹配的话题集</div>'
  return head + bar + list
}

function topicSetCard(t, d, defaultSession) {
  const editing = state.editing.has('ts:' + t.id)
  const model = t.defaultModel ? t.defaultModel.provider + '/' + t.defaultModel.model : '未设置'
  const sessions = d.routing.map((r) => r.sessionId)
  const kw = (t.keywords || []).join(', ')
  return `
  <div class="panel">
    <header>
      <b>${esc(t.title)}</b> ${badge(t.status)}
      <span class="badge info">${(t.members || []).length} 个会话</span>
      <span class="muted">模型 ${esc(model)}</span>
      <span class="grow"></span>
      ${editing
        ? `<button class="btn small primary" type="button" data-action="ts-save" data-id="${t.id}">保存</button><button class="btn small" type="button" data-action="edit-cancel" data-id="ts:${t.id}">取消</button>`
        : `<button class="btn small" type="button" data-action="ts-edit" data-id="${t.id}">编辑</button>${t.status === 'active'
            ? `<button class="btn small" type="button" data-action="ts-archive" data-id="${t.id}">归档</button>`
            : `<button class="btn small" type="button" data-action="ts-unarchive" data-id="${t.id}">恢复</button>`}
          <button class="btn small danger" type="button" data-action="ts-del" data-id="${t.id}">删除</button>`}
    </header>
    <div class="body">
      ${editing
        ? `<div><textarea name="summary" placeholder="话题集梗概">${esc(t.summary)}</textarea>
             <div class="toolbar" style="margin:6px 0 0"><input type="text" name="keywords" value="${esc(kw)}" placeholder="关键词，逗号分隔"></div></div>`
        : `<div>${t.summary ? esc(t.summary) : '<span class="muted">（暂无梗概）</span>'}</div>
           <div class="row-meta">${kwHtml(t.keywords)}</div>`}
      <div class="toolbar" style="margin-top:8px">
        <select data-role="ts-session">${sessions.length
          ? sessions.map((s) => `<option value="${esc(s)}"${s === defaultSession ? ' selected' : ''}>会话 ${short(s)}</option>`).join('')
          : '<option value="">（无会话）</option>'}</select>
        <button class="btn small" type="button" data-action="ts-activate" data-id="${t.id}">激活到该会话</button>
      </div>
      ${t.members && t.members.length
        ? `<table><tr><th>分支</th><th>类型</th><th>标题</th><th>标签</th><th>状态</th><th>模型</th><th>最后活跃</th></tr>${t.members.map((m) => {
            // R30 需求④: 分支标签取自最新一次派发记录（与面板/中枢卡同一映射）。
            const meta = branchMeta(d).get(m.sessionId)
            return `<tr><td>${short(m.sessionId)}</td><td>${m.kind}</td><td>${esc((meta && meta.title) || m.title || '—')}</td><td>${meta && meta.tags.length ? kwHtml(meta.tags) : '<span class="muted">—</span>'}</td><td>${badge(m.status)}</td><td>${esc(m.model || '默认')}${m.modelOverridden ? '（覆盖）' : ''}</td><td>${fmtTime(m.lastActiveAt)}</td></tr>`
          }).join('')}</table>`
        : '<div class="muted" style="padding:6px 0">无分支</div>'}
      <div class="row-meta">创建 ${fmtTime(t.createdAt)} · 更新 ${fmtTime(t.updatedAt)} · 活跃 ${fmtTime(t.lastActiveAt)} · id ${short(t.id)}</div>
    </div>
  </div>`
}

function memGroups(d) {
  // R30 需求②: 集合 → 条目。未归集（无 collectionId）归到 id 为 '' 的虚拟集合，
  // 保证旧数据在两级导航里仍然可见，不丢条目。
  const groups = new Map()
  for (const m of d.memories || []) {
    const id = m.collectionId || ''
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(m)
  }
  return groups
}

function latestOf(rows) {
  return (rows || []).reduce((max, m) => (m.updatedAt > max ? m.updatedAt : max), 0)
}

/** R30 需求②: 第一级——只展示记忆集卡片（标题/标签/条目数/最近更新）。 */
function renderMemories(d) {
  if (state.memDetail) return renderMemoryDetail(d)
  if (state.memCollection !== null) return renderMemoryCollection(d)
  const q = state.memQuery.trim().toLowerCase()
  const groups = memGroups(d)
  const specs = []
  for (const c of d.memoryCollections || []) {
    const rows = groups.get(c.id) || []
    specs.push({ id: c.id, title: c.title, tags: c.keywords || [], summary: c.summary || '', rows, latest: latestOf(rows) })
  }
  const loose = groups.get('') || []
  if (loose.length > 0) specs.push({ id: '', title: '未归集', tags: [], summary: '', rows: loose, latest: latestOf(loose) })
  specs.sort((a, b) => b.latest - a.latest)
  const list = q
    ? specs.filter((s) => s.title.toLowerCase().includes(q) || s.tags.some((t) => String(t).toLowerCase().includes(q)))
    : specs
  const head = `
  <div class="panel"><header>新建记忆</header><div class="body">
    <form data-form="mem-create">
      <div class="toolbar" style="margin:0 0 6px">
        <input type="text" name="title" placeholder="标题（≤48 字，检索权重最高）" style="flex:1;min-width:200px">
        <input type="text" name="keywords" placeholder="标签，逗号分隔（用于检索）" style="flex:1;min-width:180px">
      </div>
      <textarea name="text" placeholder="正文：要记住的事实（简洁自包含）" required style="min-height:56px;width:100%"></textarea>
      <div class="toolbar" style="margin-top:6px"><button class="btn primary" type="submit">记住</button>
      <span class="muted">标题 + 标签用于检索，正文是权威内容。</span></div>
    </form>
  </div></div>
  <div class="toolbar">
    <input type="text" id="mem-q" placeholder="按标题或标签搜索记忆集合…" value="${esc(state.memQuery)}">
    <span class="muted">${list.length} 个集合</span>
  </div>`
  const rows = list.length ? list.map((s) => `
  <div class="row" data-id="${esc(s.id)}">
    <div class="row-main">
      <div class="row-text">
        <div class="row-title"><a href="javascript:void(0)" data-action="mem-collection" data-id="${esc(s.id)}" title="打开这个记忆集合的条目">${esc(s.title)}</a></div>
        <div class="row-meta">
          ${kwHtml(s.tags)}
          <span>${s.rows.length} 条</span>
          <span>更新 ${fmtTime(s.latest)}</span>
          ${s.summary ? `<span class="clamp">${esc(s.summary)}</span>` : ''}
        </div>
      </div>
    </div>
  </div>`).join('') : '<div class="empty">没有匹配的记忆集合</div>'
  return head + `<div class="panel"><div class="body">${rows}</div></div>`
}

/** R30 需求②: 第二级——一个集合内的全部条目（标题/标签/版本徽标/更新时间）。 */
function renderMemoryCollection(d) {
  const cid = state.memCollection
  const groups = memGroups(d)
  const all = groups.get(cid) || []
  const title = cid
    ? ((d.memoryCollections || []).find((c) => c.id === cid) || {}).title || cid
    : '未归集'
  const q = state.memQuery.trim().toLowerCase()
  const indexHit = (m) => !q
    || String(m.title || '').toLowerCase().includes(q)
    || (m.keywords || []).some((k) => String(k).toLowerCase().includes(q))
    || String(m.key || '').toLowerCase().includes(q)
  const bodyHit = (m) => !q || String(m.text || '').toLowerCase().includes(q)
  const list = all.filter((m) =>
    (state.memFilter === 'all' || m.status === state.memFilter) && (indexHit(m) || bodyHit(m)))
  const head = `
  <div class="toolbar">
    <button class="btn" type="button" data-action="mem-back">← 返回记忆集合</button>
    <span class="muted">记忆 / ${esc(title)}</span>
  </div>
  <div class="toolbar">
    <input type="text" id="mem-q" placeholder="搜索该集合内的记忆…" value="${esc(state.memQuery)}">
    <select id="mem-filter">
      <option value="all"${state.memFilter === 'all' ? ' selected' : ''}>全部 ${all.length}</option>
      <option value="active"${state.memFilter === 'active' ? ' selected' : ''}>生效</option>
      <option value="superseded"${state.memFilter === 'superseded' ? ' selected' : ''}>已软删</option>
    </select>
    <span class="muted">显示 ${list.length} 条</span>
  </div>`
  const rows = list.length ? list.map((m) => memoryRow(m)).join('') : '<div class="empty">这个集合里没有匹配的记忆</div>'
  return head + `<div class="panel"><div class="body">${rows}</div></div>`
}

/** R30 需求②: 第三级——记忆详情：完整正文、当前版本、历史版本列表（可展开）。 */
function renderMemoryDetail(d) {
  const id = state.memDetail
  const m = (d.memories || []).find((row) => row.id === id)
  if (!m) {
    return `<div class="toolbar"><button class="btn" type="button" data-action="mem-detail-back">← 返回</button></div>
    <div class="empty">这条记忆已不存在（可能被删除）。</div>`
  }
  const collectionRow = m.collectionId ? (d.memoryCollections || []).find((c) => c.id === m.collectionId) : undefined
  const collectionTitle = (collectionRow && collectionRow.title) || '未归集'
  const versions = state.memHistory[id] || []
  const head = `
  <div class="toolbar">
    <button class="btn" type="button" data-action="mem-detail-back">← 返回${esc(collectionTitle)}</button>
    <span class="muted">记忆 / ${esc(collectionTitle)} / ${esc(m.title || (m.text || '').slice(0, 48))}</span>
  </div>`
  const detail = `
  <div class="panel"><header>${esc(m.title || (m.text || '').slice(0, 48))}</header><div class="body">
    <div class="row-meta" style="margin-bottom:8px">
      ${badge(m.status)}
      <span class="badge">v${m.version == null ? 1 : m.version}</span>
      ${kwHtml(m.keywords)}
      <span>来源 ${short(m.sourceSessionId)} #${m.sourceSeq}</span>
      <span>更新 ${fmtTime(m.updatedAt)}</span>
      ${m.key ? `<span>key ${esc(m.key)}</span>` : ''}
    </div>
    <div style="white-space:pre-wrap;word-break:break-word">${esc(m.text)}</div>
    <div class="toolbar" style="margin-top:10px">
      <button class="btn small" type="button" data-action="mem-edit" data-id="${m.id}">编辑</button>
      ${m.status === 'active'
        ? `<button class="btn small danger" type="button" data-action="mem-soft" data-id="${m.id}">软删</button>`
        : `<button class="btn small" type="button" data-action="mem-restore" data-id="${m.id}">恢复</button>`}
      <button class="btn small danger" type="button" data-action="mem-del" data-id="${m.id}">彻底删除</button>
    </div>
  </div></div>`
  const history = versions.length === 0
    ? `<div class="panel"><header>历史版本</header><div class="body"><div class="empty">正在加载历史版本…（若始终为空，说明该记忆还没有版本历史）</div></div></div>`
    : `<div class="panel"><header>历史版本（${versions.length}）</header><div class="body">${versions.map((v) => {
        const open = state.memVersionOpen === `${m.id}:${v.version}`
        const typeLabel = v.changeType === 'create' ? '新建' : v.changeType === 'update' ? '更新' : '迁移'
        return `
        <div class="row" data-id="${m.id}:${v.version}">
          <div class="row-main">
            <div class="row-text">
              <div class="row-title">
                <a href="javascript:void(0)" data-action="mem-version" data-id="${m.id}:${v.version}" title="展开/收起这个版本的完整内容">${open ? '▾' : '▸'} v${v.version}</a>
                <span class="badge">${typeLabel}</span>
                <span class="muted">${esc(v.title || '—')} · ${fmtTime(v.updatedAt)}</span>
              </div>
              ${open ? `<div class="clamp" style="white-space:pre-wrap;word-break:break-word">${esc(v.text)}</div>` : ''}
              <div class="row-meta">${kwHtml(v.tags)}</div>
            </div>
          </div>
        </div>`
      }).join('')}</div></div>`
  return head + detail + history
}

function memoryRow(m) {
  return `
  <div class="row" data-id="${m.id}">
    <div class="row-main">
      <div class="row-text">
          <div class="row-title"><a href="javascript:void(0)" data-action="mem-open" data-id="${m.id}" title="打开详情与历史版本">${esc(m.title || (m.text || '').slice(0, 48))}</a>
            <span class="badge">v${m.version == null ? 1 : m.version}</span>
          </div>
        <div class="clamp" title="点击展开/收起">${esc(m.text)}</div>
        <div class="row-meta">
          ${badge(m.status)} ${kwHtml(m.keywords)}
          <span>来源 ${short(m.sourceSessionId)} #${m.sourceSeq}</span>
          <span>更新 ${fmtTime(m.updatedAt)}</span>
          ${m.key ? `<span>key ${esc(m.key)}</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        <button class="btn small" type="button" data-action="mem-edit" data-id="${m.id}">编辑</button>
        ${m.status === 'active'
          ? `<button class="btn small danger" type="button" data-action="mem-soft" data-id="${m.id}">软删</button>`
          : `<button class="btn small" type="button" data-action="mem-restore" data-id="${m.id}">恢复</button>`}
        <button class="btn small danger" type="button" data-action="mem-del" data-id="${m.id}">彻底删除</button>
      </div>
    </div>
  </div>`
}

/** R19 需求⑦: the memory edit modal (same interaction as the in-app panel). */
function memoryModal() {
  const m = state.editMem
  if (!m) return ''
  return `
  <div class="modal-backdrop" data-action="modal-close">
    <div class="modal" role="dialog" aria-modal="true">
      <h3>编辑记忆</h3>
      <p class="modal-hint">只写结论性、可复用的事实/决策；过程步骤留在会话里。标题与标签用于检索。</p>
      <div class="toolbar" style="margin:0 0 8px">
        <input type="text" data-role="edit-title" value="${esc(m.title || '')}" placeholder="标题（≤48 字）" style="flex:1;min-width:180px">
        <input type="text" data-role="edit-kw" value="${esc((m.keywords || []).join(', '))}" placeholder="标签，逗号分隔" style="flex:1;min-width:180px">
      </div>
      <textarea data-role="edit-text" style="min-height:120px;width:100%">${esc(m.text)}</textarea>
      <div class="toolbar" style="margin-top:10px">
        <button class="btn primary" type="button" data-action="mem-save-modal" data-id="${m.id}">保存</button>
        <button class="btn" type="button" data-action="modal-close">取消</button>
      </div>
    </div>
  </div>`
}

function renderRequirements(d) {
  const tsTitle = (id) => { const t = d.topicsets.find((x) => x.id === id); return t ? t.title : '—' }
  const head = `
  <div class="panel"><header>新建需求</header><div class="body">
    <form data-form="req-create" class="form-inline">
      <input type="text" name="text" placeholder="需求内容" required style="flex:1;min-width:220px">
      <select name="topicSetId"><option value="">不挂话题集</option>${d.topicsets.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select>
      <button class="btn primary" type="submit">添加</button>
    </form>
  </div></div>`
  const rows = d.requirements.length ? d.requirements.map((r) => {
    const editing = state.editing.has('req:' + r.id)
    return `
    <div class="row" data-id="${r.id}">
      <div class="row-main">
        <div class="row-text">
          ${editing ? `<textarea data-role="req-text">${esc(r.text)}</textarea>` : `<div>${esc(r.text)}</div>`}
          <div class="row-meta">
            ${badge(r.status)}
            ${r.topicSetId ? `<span>话题集 ${esc(tsTitle(r.topicSetId))}</span>` : ''}
            <span>创建 ${fmtTime(r.createdAt)}</span>
            ${r.closedAt ? `<span>完成 ${fmtTime(r.closedAt)}</span>` : ''}
          </div>
        </div>
        <div class="row-actions">
          ${editing
            ? `<button class="btn small primary" type="button" data-action="req-save" data-id="${r.id}">保存</button><button class="btn small" type="button" data-action="edit-cancel" data-id="req:${r.id}">取消</button>`
            : `<button class="btn small" type="button" data-action="req-edit" data-id="${r.id}">编辑</button>
               <button class="btn small" type="button" data-action="req-toggle" data-id="${r.id}">${r.status === 'open' ? '标记完成' : '重新打开'}</button>
               <button class="btn small danger" type="button" data-action="req-del" data-id="${r.id}">删除</button>`}
        </div>
      </div>
    </div>`
  }).join('') : '<div class="empty">暂无需求</div>'
  return head + `<div class="panel"><div class="body">${rows}</div></div>`
}

function renderDispatch(d) {
  const tsTitle = (id) => { const t = d.topicsets.find((x) => x.id === id); return t ? t.title : '—' }
  const task = (x) => esc(x.task.length > 90 ? x.task.slice(0, 90) + '…' : x.task)
  const rows = d.dispatches.length
    ? d.dispatches.map((x) => `
      <div class="list-card">
        <div class="list-card-head">
          <b>${task(x)}</b>
          ${badge(x.status)}
          <span class="grow"></span>
          <button class="btn small danger" type="button" data-action="dsp-del" data-id="${x.id}">删除</button>
        </div>
        <div class="row-meta">
          <span>话题集 ${esc(tsTitle(x.topicSetId))}</span>
          <span>分支 ${short(x.branchSessionId)}</span>
          <span>创建 ${fmtTime(x.createdAt)}</span>
          ${x.turnEndReason ? `<span>终态 ${esc(x.turnEndReason)}</span>` : ''}
        </div>
      </div>`).join('')
    : '<div class="empty">暂无派发记录</div>'
  const outbox = d.outbox.length
    ? d.outbox.map((o) => `
      <div class="list-card">
        <div class="list-card-head"><b>${esc(o.kind)}</b>${badge(o.status)}<span class="grow"></span><span class="muted">入队 ${fmtTime(o.enqueuedAt)}</span></div>
        <div class="list-card-body clamp" title="点击展开/收起">${esc(o.payload)}</div>
        <div class="row-meta"><span>投递 ${fmtTime(o.relayedAt)}</span></div>
      </div>`).join('')
    : '<div class="empty">交付箱为空</div>'
  return `
  <div class="panel"><header>派发 <span class="badge info">${d.dispatches.length}</span></header><div class="body"><div class="card-list">${rows}</div></div></div>
  <div class="panel"><header>交付箱 <span class="badge info">${d.outbox.length}</span></header><div class="body"><div class="card-list">${outbox}</div></div></div>`
}

function renderEpisodes(d) {
  if (!d.episodes.length) return '<div class="empty">暂无归档梗概</div>'
  const tsTitle = (id) => { const t = d.topicsets.find((x) => x.id === id); return t ? t.title : '—' }
  const chips = (label, arr) => (arr && arr.length
    ? `<div class="row-meta"><b class="muted">${label}</b>${arr.map((x) => `<span class="badge info">${esc(x)}</span>`).join(' ')}</div>`
    : '')
  return d.episodes.map((e) => `
  <div class="panel"><header>
    ${fmtTime(e.timeStart)} → ${fmtTime(e.timeEnd)}
    <span class="grow"></span>
    <span class="muted">${esc(tsTitle(e.topicSetId))} · 分支 ${short(e.branchSessionId)}</span>
    <button class="btn small danger" type="button" data-action="ep-del" data-id="${e.id}">删除</button>
  </header><div class="body">
    <div>${e.summary ? esc(e.summary) : '<span class="muted">（无梗概）</span>'}</div>
    ${chips('决策', e.decisions)}${chips('下一步', e.nextSteps)}${chips('文件', e.files)}
  </div></div>`).join('')
}

function renderFilemap(d) {
  const head = `
  <div class="panel"><header>项目文件地图</header><div class="body">
    <button class="btn" type="button" data-action="scan">触发重扫</button>
    <span class="muted">按内容 hash 失效旧条目；当前共 ${d.filemap.length} 条。</span>
  </div></div>`
  const cards = d.filemap.length
    ? `<div class="panel"><div class="body"><div class="card-list">${d.filemap.map((f) => `
        <div class="list-card">
          <div class="list-card-head"><b>${esc(f.path)}</b>${badge(f.role)}<span class="grow"></span><span class="muted">${fmtTime(f.annotatedAt)}</span></div>
          <div class="list-card-body">${esc(f.summary || '—')}</div>
          <div class="row-meta">${kwHtml(f.keywords)}</div>
        </div>`).join('')}</div></div></div>`
    : '<div class="empty">暂无文件地图条目，先点「触发重扫」</div>'
  return head + cards
}

/** R18: 中枢会话 — top-level sessions that belong to no topic set. */
function renderHubs(d) {
  const hubs = d.hubs || []
  if (!hubs.length) {
    return '<div class="panel"><header>中枢会话</header><div class="body"><div class="empty">'
      + '当前工作区还没有中枢会话（无父会话、非子代理、且不属于任何话题集）'
      + '</div></div></div>'
  }
  // R19 协同②③: hub → branches (the same projection the panel uses). A branch
  // belongs to its topic set and may be shared by several hubs; the card names
  // the owning set and the share count instead of pretending a 1:1 ownership.
  const branches = d.hubBranches || []
  const byHub = new Map()
  for (const b of branches) {
    if (!byHub.has(b.hubSessionId)) byHub.set(b.hubSessionId, [])
    byHub.get(b.hubSessionId).push(b)
  }
  const stateText = (s) => s === 'working' ? '工作中' : s === 'failed' ? '失败待处理' : '空闲'
  // R30 需求③: 按话题集筛选（本地过滤，切换即生效）；被筛掉的分支不计入计数。
  const filter = state.branchFilter || ''
  const setsOf = (b) => (filter && b.topicSetId !== filter ? [] : [b])
  const cards = hubs.map((h) => {
    const all = byHub.get(h.sessionId) || []
    const rows = all.flatMap(setsOf)
    if (filter && rows.length === 0) return ''
    const working = rows.filter((b) => b.status === 'working').length
    const branchHtml = rows.length === 0
      ? '<div class="row-meta"><span class="muted">尚未拉起分支</span></div>'
      : `<div class="row-meta"><span>分支 ${rows.length}</span><span>工作中 ${working}</span></div>`
        + `<div class="card-list" style="margin-top:6px">${rows.map((b) => `
            <div class="list-card">
              <div class="list-card-head">
                <b>${esc(b.title)}</b>
                <span class="badge ${b.status === 'working' ? 'ok' : b.status === 'failed' ? 'warn' : ''}">${stateText(b.status)}</span>
                ${b.shared ? `<span class="badge info">共享 ${b.hubs.length} 中枢</span>` : ''}
                <span class="grow"></span>
                <span class="muted">${fmtTime(b.lastActivityAt)}</span>
              </div>
              <div class="row-meta">
                <span>${b.topicSetTitle ? '话题集 ' + esc(b.topicSetTitle) : '无话题集'}</span>
                <span>派发 ${b.dispatches}</span>
                <span>会话 ${short(b.branchSessionId)}</span>
              </div>
              ${b.tags && b.tags.length ? `<div class="row-meta">${kwHtml(b.tags)}</div>` : ''}
              ${b.task ? `<div class="row-meta"><span class="muted">任务</span> ${esc(b.task)}</div>` : ''}
            </div>`).join('')}</div>`
    return `
    <div class="list-card">
      <div class="list-card-head">
        <b>${esc(h.title)}</b>
        ${h.topicSetTitle ? `<span class="badge info" title="该中枢是该话题集的 root 会话">话题集 · ${esc(h.topicSetTitle)}</span>` : ''}
        ${h.live
          ? '<span class="badge ok">运行中</span>'
          : h.online
            ? '<span class="badge info">在线</span>'
            : '<span class="badge">离线</span>'}
        <span class="grow"></span>
        <span class="muted">更新 ${fmtTime(h.updatedAt)}</span>
      </div>
      <div class="row-meta">
        <span>会话 ${short(h.sessionId)}</span>
        <span>创建 ${fmtTime(h.createdAt)}</span>
      </div>
      ${branchHtml}
    </div>`
  }).join('')
  // R30 需求③: 按话题集筛选分支（管理台与面板同一份 ledger 投影）。
  const setOptions = (d.topicsets || []).map((t) =>
    `<option value="${esc(t.id)}"${state.branchFilter === t.id ? ' selected' : ''}>${esc(t.title)}${t.status === 'archived' ? '（归档）' : ''}</option>`).join('')
  const filterBar = (d.topicsets || []).length > 0
    ? `<div class="toolbar"><select data-role="branch-filter"><option value="">全部话题集</option>${setOptions}</select>
       <span class="muted">${filter ? '已按话题集筛选分支行' : `共 ${branches.length} 个分支`}</span></div>`
    : ''
  const visible = cards.join('')
  const body = visible
    ? `${filterBar}<div class="card-list">${visible}</div>`
    : `<div class="empty">${filter ? '该话题集下没有分支会话' : '当前工作区还没有中枢会话（无父会话、非子代理、且不属于任何话题集）'}</div>`
  return `<div class="panel"><header>中枢会话 <span class="badge info">${hubs.length}</span><span class="muted">当前工作区 ${esc(d.workspace || '')}</span></header>`
    + `<div class="body">${body}</div></div>`
}

/** R22: 解析一条 toolMemory 记录的能力定义；非能力返回 null。 */
function capabilitySpecOf(t) {
  try {
    const spec = JSON.parse(t.entry || '')
    return (spec && spec.kind === 'capability' && spec.entry) ? spec : null
  } catch { return null }
}

/** R18: 序列组合工具卡片（自动固化的工具序列，保持原样）。 */
function sequenceCard(t) {
  return `
    <div class="list-card">
      <div class="list-card-head">
        <b>${esc(t.title || t.trigger || t.kind)}</b>
        ${badge(t.kind)} ${badge(t.status)}
        <span class="grow"></span>
        <span class="muted">使用 ${t.useCount} 次</span>
      </div>
      <div class="row-meta">${kwHtml(t.tags) || '<span class="muted">（无标签）</span>'}</div>
      <div class="list-card-body">${esc(t.description || '—')}</div>
    </div>`
}

/** R26+B4: 能力使用明细一行（成败/连续失败/最近一次执行）；无明细返回空。 */
function capUsageLine(usage) {
  if (!usage || !usage.lastStatus) return ''
  const ok = usage.lastStatus === 'completed'
  const dry = usage.lastDryRun ? '（预演）' : ''
  const exit = usage.lastExitCode === undefined ? '—' : usage.lastExitCode
  const fail = usage.consecutiveFailures >= 2
    ? ` · <span class="badge warn">连续失败 ${usage.consecutiveFailures}</span>`
    : ''
  return `<div class="row-meta"><span class="muted">最近执行</span> ${ok ? '成功' : '失败'}${dry} · exit ${exit} · ${fmtTime(usage.lastUsedAt)} · 成功 ${usage.successCount || 0}/失败 ${usage.failCount || 0}${fail}</div>`
}

/** R22: 能力卡片 — 入口命令（可复制）/适用范围/文档/预演参数 + 运行/确认执行/启停/删除。 */
function capabilityCard(t, spec) {
  // 写操作能力若没定义预演参数，预演无从谈起（避免把真实命令当预演跑掉）。
  const canDryRun = !(spec.writeConfirm && !spec.dryRunArg)
  return `
    <div class="list-card">
      <div class="list-card-head">
        <b>${esc(t.title || spec.name)}</b>
        <span class="badge info">能力</span> ${badge(t.status)}
        ${spec.writeConfirm ? '<span class="badge warn">写操作需确认</span>' : ''}
        ${spec.runnable === false ? '<span class="badge danger">未开放执行</span>' : ''}
        ${typeof spec.version === 'number' ? `<span class="badge" title="能力定义版本（register 同名更新 +1）">v${spec.version}</span>` : ''}
        <span class="grow"></span>
        <span class="muted">使用 ${t.useCount} 次</span>
      </div>
      <div class="row-meta">${kwHtml(t.tags) || '<span class="muted">（无标签）</span>'}</div>
      <div class="list-card-body">${esc(t.description || '—')}</div>
      <div class="row-meta">
        <span class="muted">入口</span> <code>${esc(spec.entry)}</code>
        <button class="btn small" type="button" data-action="cap-copy" data-text="${esc(spec.entry)}">复制</button>
        ${spec.dryRunArg ? `<span class="muted">预演参数</span> <code>${esc(spec.dryRunArg)}</code>` : ''}
      </div>
      <div class="row-meta">
        <span class="muted">适用范围</span> <code>${esc(spec.scope || '当前目录')}</code>
        ${spec.doc ? `<span class="muted">文档</span> <code>${esc(spec.doc)}</code>` : ''}
      </div>
      ${capUsageLine(spec.usage)}
      <div class="row-actions">
        <button class="btn small primary" type="button" data-action="cap-run" data-id="${t.id}"${canDryRun ? '' : ' disabled title="该能力未定义预演参数，无法预演；请用确认执行"'}>运行（预演）</button>
        ${spec.writeConfirm ? `<button class="btn small danger" type="button" data-action="cap-run-confirm" data-id="${t.id}">确认执行</button>` : ''}
        ${t.status === 'active'
          ? `<button class="btn small" type="button" data-action="tool-status" data-id="${t.id}" data-status="retired">停用</button>`
          : `<button class="btn small" type="button" data-action="tool-status" data-id="${t.id}" data-status="active">启用</button>`}
        <button class="btn small danger" type="button" data-action="tool-del" data-id="${t.id}">删除</button>
      </div>
    </div>`
}

/** R22: 能力执行结果弹窗（stdout/stderr + 退出码 + 耗时）。 */
function capRunModal() {
  const r = state.capRun
  if (!r) return ''
  const pre = 'white-space:pre-wrap;word-break:break-all;max-height:280px;overflow:auto;background:rgba(0,0,0,.06);padding:8px;border-radius:6px'
  return `
  <div class="modal-backdrop" data-action="modal-close">
    <div class="modal" role="dialog" aria-modal="true">
      <h3>执行结果</h3>
      <p class="modal-hint">${esc(r.command || '')} · ${r.dryRun ? '预演' : '实跑'} · ${r.durationMs}ms · exit ${r.exitCode === undefined ? '—' : r.exitCode}</p>
      ${r.summary ? `<p class="modal-hint">${esc(r.summary)}</p>` : ''}
      <pre style="${pre}">${esc(r.stdout || '（无 stdout）')}</pre>
      ${r.stderr ? `<pre style="${pre}">${esc(r.stderr)}</pre>` : ''}
      <div class="toolbar" style="margin-top:10px">
        <button class="btn primary" type="button" data-action="modal-close">关闭</button>
      </div>
    </div>
  </div>`
}

/** R22: 写操作能力的二次确认弹窗（确认后才带 confirm=true 真跑）。 */
function capConfirmModal() {
  const c = state.capConfirm
  if (!c) return ''
  return `
  <div class="modal-backdrop" data-action="modal-close">
    <div class="modal" role="dialog" aria-modal="true">
      <h3>确认执行（写操作）</h3>
      <p class="modal-hint">将在 <code>${esc(c.scope || '当前目录')}</code> 内真实执行：</p>
      <pre style="white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.06);padding:8px;border-radius:6px">${esc(c.command)}</pre>
      <p class="modal-hint">该操作可能写远端/改状态。确定继续？</p>
      <div class="toolbar" style="margin-top:10px">
        <button class="btn danger" type="button" data-action="cap-run-do" data-id="${c.id}">确认执行</button>
        <button class="btn" type="button" data-action="modal-close">取消</button>
      </div>
    </div>
  </div>`
}

/** R18+R22: 组合工具页签 — 能力（可一键执行）与序列组合工具（自动固化）两类卡片。 */
function renderTools(d) {
  const seqs = []
  const caps = []
  for (const t of d.toolMemory || []) {
    const spec = capabilitySpecOf(t)
    if (spec) caps.push([t, spec])
    else seqs.push(t)
  }
  if (!seqs.length && !caps.length) {
    return '<div class="panel"><header>固化能力</header><div class="body"><div class="empty">'
      + '暂无固化能力：可手动注册（入口命令 + 文档 + 适用范围，一键执行，默认预演，写操作需确认）；'
      + '重复流程出现 3 次后也会自动提议固化为序列（一次调用完成确定性子序列）。'
      + '</div></div></div>'
  }
  const capPanel = `<div class="panel"><header>能力（可一键执行） <span class="badge info">${caps.length}</span></header><div class="body">`
    + (caps.length
      ? `<div class="card-list">${caps.map(([t, spec]) => capabilityCard(t, spec)).join('')}</div>`
      : '<div class="empty">还没有能力。用 memory_toolize register 注册，或在下面表单录入（首个样板：git 同步/提交/推送）。</div>')
    + `<details id="cap-form" style="margin-top:10px"${state.capOpen ? " open" : ""}><summary>注册新能力</summary>
      <form data-form="cap-create" class="form-inline">
        <input type="text" name="name" placeholder="能力名（git-sync-supermemory）" required style="flex:0 0 220px">
        <input type="text" name="title" placeholder="标题" style="flex:1;min-width:160px">
        <input type="text" name="entry" placeholder="入口命令（pnpm git:sync）" required style="flex:1;min-width:220px">
        <input type="text" name="scope" placeholder="适用范围目录（仓库根，通常留空=全局）" style="flex:1;min-width:200px">
        <input type="text" name="doc" placeholder="文档路径（docs/git-sync.md）" style="flex:1;min-width:200px">
        <input type="text" name="dryRunArg" placeholder="预演参数（--dry-run）" style="flex:0 0 160px">
        <input type="text" name="tags" placeholder="标签，逗号分隔" style="flex:0 0 180px">
        <label class="muted"><input type="checkbox" name="writeConfirm" checked> 写操作需确认</label>
        <label class="muted"><input type="checkbox" name="runnable" checked> 可执行</label>
        <textarea name="description" placeholder="描述 + 路由：何时优先用本能力、关键坑是什么（模型据此路由）" style="min-height:56px;width:100%"></textarea>
        <button class="btn primary" type="submit">注册能力</button>
      </form>
    </details></div></div>`
  const seqPanel = seqs.length
    ? `<div class="panel"><header>自动固化序列（重复流程的附带产物） <span class="badge info">${seqs.length}</span></header>`
      + `<div class="body"><div class="card-list">${seqs.map(sequenceCard).join('')}</div></div></div>`
    : ''
  return capPanel + seqPanel
}

/** R18: 信号 — repeated-flow candidates, as cards. */
function renderSignals(d) {
  if (!d.signals.length) {
    return '<div class="panel"><header>重复流程信号</header><div class="body"><div class="empty">暂无重复流程信号</div></div></div>'
  }
  const cards = d.signals.map((s) => `
    <div class="list-card">
      <div class="list-card-head">
        <b>${esc(s.pattern)}</b>
        ${s.proposalStatus ? badge(s.proposalStatus) : '<span class="muted">未提议</span>'}
        <span class="grow"></span>
        <span class="muted">${s.count} 次 · 最近 ${fmtTime(s.lastSeen)}</span>
      </div>
      <div class="list-card-body clamp" title="点击展开/收起">${esc((s.examples || []).join('；') || '—')}</div>
    </div>`).join('')
  return `<div class="panel"><header>重复流程信号 <span class="badge info">${d.signals.length}</span></header>`
    + `<div class="body"><div class="card-list">${cards}</div></div></div>`
}

/* ---------- 事件 ---------- */

document.addEventListener('click', async (ev) => {
  const clamp = ev.target.closest('.clamp')
  if (clamp) { clamp.classList.toggle('open'); return }
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  // R27 修复：过去弹窗用内联 onclick="event.stopPropagation()" 阻止冒泡，结果把
  // document 上的委托监听也一起挡掉——弹窗里的「保存 / 取消 / 关闭 / 确认执行」
  // 全是死按钮。现在改为只忽略「点遮罩空白处」：遮罩自身带 modal-close，点击
  // 落在 .modal 内部且命中的就是遮罩时才忽略；弹窗里显式的 modal-close 按钮照常
  // 生效。
  if (action === 'modal-close' && btn.classList.contains('modal-backdrop') && ev.target.closest('.modal')) return
  const id = btn.dataset.id || ''
  const post = (path, body) => api(path, { method: 'POST', body })
  const run = async (fn) => {
    try { btn.disabled = true; await fn(); await loadState() }
    catch (e) { showError(e); toast('操作失败：' + e.message) }
    finally { btn.disabled = false }
  }
  switch (action) {
    case 'nav': state.section = id; location.hash = id; render(); return
    case 'ts-edit': state.editing.add('ts:' + id); render(); return
    case 'req-edit': state.editing.add('req:' + id); render(); return
    case 'mem-edit': {
      const memory = (state.data && state.data.memories || []).find((m) => m.id === id)
      if (!memory) return
      state.editMem = { id: memory.id, title: memory.title || '', keywords: memory.keywords || [], text: memory.text || '' }
      render()
      return
    }
    // R30 需求②: 两级导航——进入集合 / 返回集合 / 打开记忆详情 / 返回详情 /
    // 展开或收起某个历史版本。
    case 'mem-collection': state.memCollection = id; state.memQuery = ''; render(); return
    case 'mem-back': state.memCollection = null; state.memQuery = ''; render(); return
    case 'mem-detail-back': state.memDetail = null; state.memVersionOpen = null; render(); return
    case 'mem-version':
      state.memVersionOpen = state.memVersionOpen === id ? null : id
      render()
      return
    case 'mem-open': {
      state.memDetail = id
      state.memVersionOpen = null
      render()
      if (!state.memHistory[id]) {
        try {
          const r = await api('/memory/history', { method: 'POST', body: { ws: state.ws, id } })
          state.memHistory[id] = r.versions || []
        } catch (e) {
          state.memHistory[id] = []
          showError(e)
        }
        render()
      }
      return
    }
    case 'modal-close': state.editMem = null; state.capRun = null; state.capConfirm = null; render(); return
    case 'mem-save-modal': await run(async () => {
      const modal = document.querySelector('.modal')
      if (!modal) throw new Error('编辑框已关闭')
      const title = modal.querySelector('[data-role="edit-title"]').value
      const keywords = modal.querySelector('[data-role="edit-kw"]').value
      const text = modal.querySelector('[data-role="edit-text"]').value
      const r = await post('/memory/update', { ws: state.ws, id, title, keywords, text })
      state.editMem = null
      // R30 需求①: 编辑会就地升版——历史缓存作废，下次打开详情重新拉取。
      delete state.memHistory[id]
      toast(r && r.version ? `记忆已保存（v${r.version}）` : '记忆已保存')
    }); return
    case 'edit-cancel': state.editing.delete(id); render(); return
    case 'mem-soft':
      if (!confirm('软删除后 recall 不再命中该记忆，可在「已软删」过滤中恢复。确定？')) return
      await run(async () => { await post('/memory/status', { ws: state.ws, id, status: 'superseded' }); toast('已软删除') }); return
    case 'mem-restore':
      await run(async () => { await post('/memory/status', { ws: state.ws, id, status: 'active' }); toast('已恢复') }); return
    case 'mem-del':
      if (!confirm('彻底删除不可恢复，确定？')) return
      await run(async () => { await post('/memory/delete', { ws: state.ws, id }); toast('已彻底删除') }); return
    case 'ts-save': await run(async () => {
      const panel = btn.closest('.panel')
      await post('/topicset/update', { ws: state.ws, id, summary: panel.querySelector('[name="summary"]').value, keywords: panel.querySelector('[name="keywords"]').value })
      state.editing.delete('ts:' + id); toast('话题集已保存')
    }); return
    case 'ts-archive':
      await run(async () => { await post('/topicset/update', { ws: state.ws, id, status: 'archived' }); toast('已归档') }); return
    case 'ts-unarchive':
      await run(async () => { await post('/topicset/update', { ws: state.ws, id, status: 'active' }); toast('已恢复') }); return
    case 'ts-del':
      if (!confirm('删除话题集会级联删除它的归档梗概、派发记录与交付行，且不可恢复。确定？')) return
      await run(async () => {
        const r = await post('/topicset/delete', { ws: state.ws, id })
        toast('已删除话题集（梗概 ' + r.episodes + ' · 派发 ' + r.dispatches + ' · 交付 ' + r.outbox + '）')
      }); return
    case 'ep-del':
      if (!confirm('删除这条归档梗概？不可恢复。')) return
      await run(async () => { await post('/episode/delete', { ws: state.ws, id }); toast('已删除梗概') }); return
    case 'dsp-del':
      if (!confirm('删除这条派发记录及其交付行？不可恢复。')) return
      await run(async () => { await post('/dispatch/delete', { ws: state.ws, id }); toast('已删除派发记录') }); return
    case 'ts-activate': await run(async () => {
      const sessionId = btn.closest('.panel').querySelector('[data-role="ts-session"]').value
      if (!sessionId) throw new Error('没有可选会话')
      await post('/topicset/activate', { ws: state.ws, id, sessionId })
      toast('已激活到会话 ' + short(sessionId))
    }); return
    case 'req-save': await run(async () => {
      const row = btn.closest('.row')
      await post('/requirement/update', { ws: state.ws, id, text: row.querySelector('[data-role="req-text"]').value })
      state.editing.delete('req:' + id); toast('需求已保存')
    }); return
    case 'req-toggle': await run(async () => {
      const cur = state.data.requirements.find((r) => r.id === id)
      const next = cur && cur.status === 'open' ? 'closed' : 'open'
      await post('/requirement/update', { ws: state.ws, id, status: next })
      toast(next === 'closed' ? '已标记完成' : '已重新打开')
    }); return
    case 'req-del':
      if (!confirm('删除该需求不可恢复，确定？')) return
      await run(async () => { await post('/requirement/delete', { ws: state.ws, id }); toast('已删除') }); return
    case 'scan':
      if (!confirm('立即重扫工作区文件地图？')) return
      await run(async () => {
        const r = await post('/filemap/scan', { ws: state.ws, cwd: state.ws })
        toast('扫描 ' + r.scanned + ' · 新增 ' + r.added + ' · 失效 ' + r.stale + ' · 共 ' + r.total)
      }); return
    case 'export':
      if (!confirm('把当前工作区内容导出为 .supermemory-export.md？')) return
      await run(async () => {
        const r = await post('/export', { ws: state.ws, cwd: state.ws })
        toast('已导出 ' + r.path)
      }); return
    // ---- R22 能力（capability）----
    case 'cap-run': await run(async () => {
      const r = await post('/tool/run', { ws: state.ws, id })
      state.capRun = r
      // B2 收尾：执行后重新拉取状态——使用次数/版本/最近执行状态即时刷新，
      // 不再停留在页面加载时的旧快照。
      await loadState()
    }); return
    case 'cap-run-confirm': {
      const t = (state.data && state.data.toolMemory || []).find((x) => x.id === id)
      const spec = t && capabilitySpecOf(t)
      if (!spec) return
      state.capConfirm = { id, scope: spec.scope, command: spec.entry }
      render()
      return
    }
    case 'cap-run-do': await run(async () => {
      const c = state.capConfirm
      if (!c) return
      const r = await post('/tool/run', { ws: state.ws, id: c.id, confirm: true })
      state.capConfirm = null
      state.capRun = r
      // B2 收尾：同上——确认执行后也刷新状态。
      await loadState()
    }); return
    case 'tool-status': await run(async () => {
      const status = btn.dataset.status === 'retired' ? 'retired' : 'active'
      await post('/tool/status', { ws: state.ws, id, status })
      toast(status === 'retired' ? '已停用（重启后不会重新注册）' : '已启用')
      await loadState()
    }); return
    case 'tool-del':
      if (!confirm('删除该固化能力/自动固化序列不可恢复，确定？')) return
      await run(async () => { await post('/tool/delete', { ws: state.ws, id }); toast('已删除'); await loadState() }); return
    case 'cap-copy': {
      const copyText = btn.dataset.text || ''
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(copyText); toast('已复制：' + copyText) }
        catch { toast('复制失败，请手动复制：' + copyText) }
      } else { toast('请手动复制：' + copyText) }
      return
    }
    default: return
  }
})

/* R27 修复：搜索框「输入即筛选」。#mem-q / #ts-q 过去只监听 change（失焦或回车
 * 才生效），用户敲完字看不到列表变化。render() 会整体重建 #content，所以重绘后
 * 要把焦点和光标位置还原；中文输入法合成期间（isComposing）不重绘，否则合成串
 * 会被打断，改为合成结束后再触发。 */
let searchTimer = 0
document.addEventListener('input', (ev) => {
  const t = ev.target
  if (!t || (t.id !== 'mem-q' && t.id !== 'ts-q')) return
  if (ev.isComposing) return
  const id = t.id
  const value = t.value
  const pos = t.selectionStart == null ? value.length : t.selectionStart
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if (id === 'mem-q') {
      if (state.memQuery === value) return
      state.memQuery = value
    } else {
      if (state.tsQuery === value) return
      state.tsQuery = value
    }
    render()
    const next = $('#' + id)
    if (!next) return
    next.focus()
    try { next.setSelectionRange(pos, pos) } catch { /* 输入框已被替换 */ }
  }, 140)
})

// R27 修复：render() 会整体重建 #content，「注册新能力」的展开状态原本每次都
// 丢失（注册完/自动刷新一过就折叠，正在填的表单也随之消失）。记住展开状态，
// 重绘后保留。
document.addEventListener('toggle', (ev) => {
  const t = ev.target
  if (t && t.id === 'cap-form') state.capOpen = t.open
}, true)

document.addEventListener('change', async (ev) => {
  const t = ev.target
  if (t.id === 'ws-select') {
    state.ws = t.value
    localStorage.setItem('sm-ws', state.ws)
    await loadState()
  } else if (t.id === 'auto-refresh') {
    state.auto = t.checked
    localStorage.setItem('sm-auto', state.auto ? '1' : '0')
  } else if (t.id === 'mem-filter') {
    state.memFilter = t.value
    render()
  } else if (t.id === 'mem-q') {
    if (state.memQuery === t.value) return
    state.memQuery = t.value
    const pos = t.selectionStart
    render()
    const q = $('#mem-q')
    if (q) { q.focus(); q.setSelectionRange(pos, pos) }
  } else if (t.id === 'ts-q') {
    if (state.tsQuery === t.value) return
    state.tsQuery = t.value
    const pos = t.selectionStart
    render()
    const q = $('#ts-q')
    if (q) { q.focus(); q.setSelectionRange(pos, pos) }
  } else if (t.matches('[data-role="branch-filter"]')) {
    // R30 需求③: 中枢会话页按话题集筛选分支行（本地过滤，无需重新拉取）。
    if (state.branchFilter === t.value) return
    state.branchFilter = t.value
    render()
  }
})

document.addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const form = ev.target
  const kind = form.dataset.form
  const fd = new FormData(form)
  const val = (k) => String(fd.get(k) || '').trim()
  try {
    if (kind === 'mem-create') {
      const text = val('text')
      if (!text) return
      await api('/memory/create', { method: 'POST', body: { ws: state.ws, title: val('title'), text, keywords: val('keywords') } })
      toast('已记住')
    } else if (kind === 'ts-create') {
      const title = val('title')
      if (!title) return
      await api('/topicset/create', { method: 'POST', body: { ws: state.ws, title, keywords: val('keywords') } })
      toast('话题集已创建')
    } else if (kind === 'req-create') {
      const text = val('text')
      if (!text) return
      await api('/requirement/create', { method: 'POST', body: { ws: state.ws, text, topicSetId: val('topicSetId') } })
      toast('需求已添加')
    } else if (kind === 'cap-create') {
      // R22: 注册一个能力（入口命令 + 文档 + 适用范围，可一键执行，默认预演）。
      const name = val('name')
      const entry = val('entry')
      const description = val('description')
      if (!name || !entry || !description) { toast('能力名、入口命令、描述为必填'); return }
      await api('/tool/register', { method: 'POST', body: {
        ws: state.ws, name, title: val('title'), entry, scope: val('scope'), doc: val('doc'),
        dryRunArg: val('dryRunArg'), tags: val('tags'), description,
        writeConfirm: fd.get('writeConfirm') === 'on', runnable: fd.get('runnable') === 'on',
      } })
      toast('能力已注册')
    }
    form.reset()
    await loadState()
  } catch (e) { showError(e); toast('操作失败：' + e.message) }
})

/* ---------- 启动 ---------- */

/**
 * True while the user is mid-edit inside the console. render() replaces
 * #content wholesale, so an auto-refresh tick would destroy a half-typed
 * memory / topic-set form (and the row being edited).
 */
function typingInConsole() {
  if (state.editing.size > 0 || state.editMem) return true
  const el = document.activeElement
  if (!el) return false
  return !!(el.closest && el.closest('#content') && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

async function boot() {
  $('#refresh').addEventListener('click', () => { loadState() })
  $('#auto-refresh').checked = state.auto
  try {
    await loadWorkspaces()
    const urlWs = new URLSearchParams(location.search).get('ws')
    state.ws = urlWs || localStorage.getItem('sm-ws') || (state.workspaces[0] && state.workspaces[0].key)
    if (!state.ws) {
      $('#content').innerHTML = '<div class="empty">未发现任何工作区数据——先在任何会话里聊几句，或运行 /memory scan。</div>'
      return
    }
    localStorage.setItem('sm-ws', state.ws)
    await loadState()
  } catch (e) { showError(e) }
  setInterval(() => { if (state.auto && !document.hidden && !typingInConsole()) loadState() }, 10000)
}
boot()
