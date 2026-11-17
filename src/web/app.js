'use strict'

/* SuperMemory 管理台 — Plan A 前端（vanilla JS，无框架无外链） */
const API = '/supermemory/api'
const TOKEN = (document.querySelector('meta[name="sm-token"]') || {}).content || ''
const URL_PARAMS = new URLSearchParams(location.search)
const URL_SESSION = URL_PARAMS.get('session') || ''

const SECTIONS = [
  ['overview', '总览'],
  ['topicsets', '话题集'],
  ['memories', '事实记忆'],
  ['requirements', '需求'],
  ['dispatch', '派发与交付'],
  ['episodes', '归档梗概'],
  ['filemap', '文件地图'],
  ['signals', '信号与工具'],
]

const state = {
  ws: null,
  workspaces: [],
  data: null,
  section: (location.hash || '').replace('#', '') || 'overview',
  auto: localStorage.getItem('sm-auto') !== '0',
  memQuery: '',
  memFilter: 'all',
  editing: new Set(),
}

const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—')
const short = (id) => esc(id ? String(id).slice(0, 8) : '—')
const kwHtml = (kws) => (kws || []).map((k) => `<span class="kw">${esc(k)}</span>`).join(' ')
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
  $('#sections').innerHTML = SECTIONS.map(([id, label]) =>
    `<button type="button" class="nav-item${state.section === id ? ' active' : ''}" data-action="nav" data-id="${id}">${label}</button>`).join('')
  $('#ws-select').innerHTML = state.workspaces.map((w) =>
    `<option value="${esc(w.key)}"${w.key === state.ws ? ' selected' : ''}>${esc(w.key)}</option>`).join('')
  $('#gen-at').textContent = state.data ? '更新于 ' + fmtTime(state.data.generatedAt) : ''
  $('#auto-refresh').checked = state.auto
  const renderer = {
    overview: renderOverview, topicsets: renderTopicsets, memories: renderMemories,
    requirements: renderRequirements, dispatch: renderDispatch, episodes: renderEpisodes,
    filemap: renderFilemap, signals: renderSignals,
  }[state.section]
  $('#content').innerHTML = renderer && state.data ? renderer(state.data) : '<div class="empty">加载中…</div>'
}

/* ---------- 分区渲染 ---------- */

function renderOverview(d) {
  const dq = d.dispatches.reduce((m, x) => { m[x.status] = (m[x.status] || 0) + 1; return m }, {})
  const cards = [
    ['话题集', d.topicsets.filter((t) => t.status === 'active').length + ' 活跃 / ' + d.topicsets.filter((t) => t.status === 'archived').length + ' 归档'],
    ['事实记忆', d.memories.filter((m) => m.status === 'active').length + ' 生效 / ' + d.memories.filter((m) => m.status === 'superseded').length + ' 软删'],
    ['需求', d.requirements.filter((r) => r.status === 'open').length + ' 未完成 / ' + d.requirements.filter((r) => r.status === 'closed').length + ' 已完成'],
    ['归档梗概', d.episodes.length],
    ['派发', Object.keys(dq).length ? Object.entries(dq).map(([k, v]) => k + ' ' + v).join(' · ') : '无'],
    ['待交付 outbox', d.outbox.filter((o) => o.status === 'pending').length],
    ['重复信号', d.signals.length],
    ['组合工具', d.toolMemory.length],
    ['文件地图', d.filemap.length],
  ]
  const tsTitle = (id) => { const t = d.topicsets.find((x) => x.id === id); return t ? t.title : '（已删除）' }
  return `
  <div class="cards">${cards.map(([k, v]) => `<div class="card-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
  <div class="panel"><header>会话 → 活跃话题集</header><div class="body">
    ${d.routing.length
      ? `<table><tr><th>会话</th><th>活跃话题集</th><th class="num">漂移计数</th><th>更新时间</th></tr>${d.routing.map((r) => `<tr><td>${short(r.sessionId)}</td><td>${esc(tsTitle(r.activeTopicSetId))}</td><td class="num">${r.driftCount}</td><td>${fmtTime(r.updatedAt)}</td></tr>`).join('')}</table>`
      : '<div class="empty">暂无会话路由记录</div>'}
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
  const list = d.topicsets.length
    ? d.topicsets.map((t) => topicSetCard(t, d, defaultSession)).join('')
    : '<div class="empty">暂无话题集</div>'
  return head + list
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
        ? `<table><tr><th>分支</th><th>类型</th><th>标题</th><th>状态</th><th>模型</th><th>最后活跃</th></tr>${t.members.map((m) => `<tr><td>${short(m.sessionId)}</td><td>${m.kind}</td><td>${esc(m.title || '—')}</td><td>${badge(m.status)}</td><td>${esc(m.model || '默认')}${m.modelOverridden ? '（覆盖）' : ''}</td><td>${fmtTime(m.lastActiveAt)}</td></tr>`).join('')}</table>`
        : '<div class="muted" style="padding:6px 0">无分支</div>'}
      <div class="row-meta">创建 ${fmtTime(t.createdAt)} · 更新 ${fmtTime(t.updatedAt)} · 活跃 ${fmtTime(t.lastActiveAt)} · id ${short(t.id)}</div>
    </div>
  </div>`
}

function renderMemories(d) {
  const q = state.memQuery.trim().toLowerCase()
  const list = d.memories.filter((m) =>
    (state.memFilter === 'all' || m.status === state.memFilter)
    && (!q || (m.text + ' ' + (m.keywords || []).join(' ') + ' ' + (m.key || '')).toLowerCase().includes(q)))
  const head = `
  <div class="panel"><header>新建记忆</header><div class="body">
    <form data-form="mem-create" class="form-inline">
      <textarea name="text" placeholder="要记住的事实（简洁自包含）" required style="min-height:44px"></textarea>
      <input type="text" name="keywords" placeholder="关键词，逗号分隔（可选）" style="flex:1;min-width:170px">
      <button class="btn primary" type="submit">记住</button>
    </form>
  </div></div>
  <div class="toolbar">
    <input type="text" id="mem-q" placeholder="搜索记忆…" value="${esc(state.memQuery)}">
    <select id="mem-filter">
      <option value="all"${state.memFilter === 'all' ? ' selected' : ''}>全部 ${d.memories.length}</option>
      <option value="active"${state.memFilter === 'active' ? ' selected' : ''}>生效</option>
      <option value="superseded"${state.memFilter === 'superseded' ? ' selected' : ''}>已软删</option>
    </select>
    <span class="muted">显示 ${list.length} 条</span>
  </div>`
  const rows = list.length ? list.map((m) => memoryRow(m)).join('') : '<div class="empty">没有匹配的记忆</div>'
  return head + `<div class="panel"><div class="body">${rows}</div></div>`
}

function memoryRow(m) {
  const editing = state.editing.has('mem:' + m.id)
  return `
  <div class="row" data-id="${m.id}">
    <div class="row-main">
      <div class="row-text">
        ${editing
          ? `<div><textarea data-role="mem-text">${esc(m.text)}</textarea>
               <div class="toolbar" style="margin-top:6px"><input type="text" data-role="mem-kw" value="${esc((m.keywords || []).join(', '))}" placeholder="关键词，逗号分隔"></div></div>`
          : `<div class="clamp" title="点击展开/收起">${esc(m.text)}</div>`}
        <div class="row-meta">
          ${badge(m.status)} ${kwHtml(m.keywords)}
          <span>来源 ${short(m.sourceSessionId)} #${m.sourceSeq}</span>
          <span>更新 ${fmtTime(m.updatedAt)}</span>
          ${m.key ? `<span>key ${esc(m.key)}</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        ${editing
          ? `<button class="btn small primary" type="button" data-action="mem-save" data-id="${m.id}">保存</button><button class="btn small" type="button" data-action="edit-cancel" data-id="mem:${m.id}">取消</button>`
          : `<button class="btn small" type="button" data-action="mem-edit" data-id="${m.id}">编辑</button>
             ${m.status === 'active'
               ? `<button class="btn small danger" type="button" data-action="mem-soft" data-id="${m.id}">软删</button>`
               : `<button class="btn small" type="button" data-action="mem-restore" data-id="${m.id}">恢复</button>`}
             <button class="btn small danger" type="button" data-action="mem-del" data-id="${m.id}">彻底删除</button>`}
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
  const task = (x) => esc(x.task.length > 60 ? x.task.slice(0, 60) + '…' : x.task)
  return `
  <div class="panel"><header>派发（dispatches）</header><div class="body">
    ${d.dispatches.length
      ? `<table><tr><th>任务</th><th>分支</th><th>话题集</th><th>状态</th><th>终态原因</th><th>创建</th><th></th></tr>${d.dispatches.map((x) => `<tr><td title="${esc(x.task)}">${task(x)}</td><td>${short(x.branchSessionId)}</td><td>${esc(tsTitle(x.topicSetId))}</td><td>${badge(x.status)}</td><td class="muted">${esc(x.turnEndReason || '—')}</td><td>${fmtTime(x.createdAt)}</td><td><button class="btn small danger" type="button" data-action="dsp-del" data-id="${x.id}">删除</button></td></tr>`).join('')}</table>`
      : '<div class="empty">暂无派发记录</div>'}
  </div></div>
  <div class="panel"><header>交付箱（outbox）</header><div class="body">
    ${d.outbox.length
      ? `<table><tr><th>类型</th><th>状态</th><th>内容</th><th>入队</th><th>投递</th></tr>${d.outbox.map((o) => `<tr><td>${o.kind}</td><td>${badge(o.status)}</td><td class="clamp" title="点击展开/收起">${esc(o.payload)}</td><td>${fmtTime(o.enqueuedAt)}</td><td>${fmtTime(o.relayedAt)}</td></tr>`).join('')}</table>`
      : '<div class="empty">交付箱为空</div>'}
  </div></div>`
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
  const rows = d.filemap.length
    ? `<div class="panel"><div class="body" style="overflow-x:auto"><table>
        <tr><th>路径</th><th>角色</th><th>说明</th><th>关键词</th><th>标注时间</th></tr>
        ${d.filemap.map((f) => `<tr><td>${esc(f.path)}</td><td>${esc(f.role)}</td><td class="muted">${esc(f.summary || '—')}</td><td>${kwHtml(f.keywords)}</td><td>${fmtTime(f.annotatedAt)}</td></tr>`).join('')}
      </table></div></div>`
    : '<div class="empty">暂无文件地图条目，先点「触发重扫」</div>'
  return head + rows
}

function renderSignals(d) {
  const sig = d.signals.length
    ? `<div class="panel"><header>重复流程信号</header><div class="body" style="overflow-x:auto"><table>
        <tr><th>模式</th><th class="num">次数</th><th>提议状态</th><th>样例</th><th>最近出现</th></tr>
        ${d.signals.map((s) => `<tr><td>${esc(s.pattern)}</td><td class="num">${s.count}</td><td>${s.proposalStatus ? badge(s.proposalStatus) : '<span class="muted">未提议</span>'}</td><td class="muted clamp" title="点击展开/收起">${esc((s.examples || []).join('；'))}</td><td>${fmtTime(s.lastSeen)}</td></tr>`).join('')}
      </table></div></div>`
    : '<div class="panel"><div class="empty">暂无重复流程信号</div></div>'
  const tools = d.toolMemory.length
    ? `<div class="panel"><header>组合工具 / 工具记忆</header><div class="body" style="overflow-x:auto"><table>
        <tr><th>触发</th><th>类型</th><th>说明</th><th class="num">使用次数</th><th>状态</th></tr>
        ${d.toolMemory.map((t) => `<tr><td>${esc(t.trigger)}</td><td>${t.kind}</td><td class="muted">${esc(t.description)}</td><td class="num">${t.useCount}</td><td>${badge(t.status)}</td></tr>`).join('')}
      </table></div></div>`
    : '<div class="panel"><div class="empty">暂无组合工具</div></div>'
  return sig + tools
}

/* ---------- 事件 ---------- */

document.addEventListener('click', async (ev) => {
  const clamp = ev.target.closest('.clamp')
  if (clamp) { clamp.classList.toggle('open'); return }
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
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
    case 'mem-edit': state.editing.add('mem:' + id); render(); return
    case 'edit-cancel': state.editing.delete(id); render(); return
    case 'mem-save': await run(async () => {
      const row = btn.closest('.row')
      await post('/memory/update', { ws: state.ws, id, text: row.querySelector('[data-role="mem-text"]').value, keywords: row.querySelector('[data-role="mem-kw"]').value })
      state.editing.delete('mem:' + id); toast('记忆已保存')
    }); return
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
    default: return
  }
})

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
    state.memQuery = t.value
    const pos = t.selectionStart
    render()
    const q = $('#mem-q')
    if (q) { q.focus(); q.setSelectionRange(pos, pos) }
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
      await api('/memory/create', { method: 'POST', body: { ws: state.ws, text, keywords: val('keywords') } })
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
  if (state.editing.size > 0) return true
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
