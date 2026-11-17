/**
 * Web management console — Plan A: visual memory management.
 *
 * Mounts a prefix route on the host web server (`ctx.webServer`, the GUI's own
 * HTTP carrier, confirmed running at the Web GUI origin) under `/supermemory`:
 * static assets are read per request from `src/web/` (so UI iteration needs no
 * plugin rebuild), and a small JSON API reads/writes the same domain tables the
 * plugin uses. No client bundle is involved, so the GUI boot path stays
 * untouched — that was the blocker for the native sidebar tab (§1.5).
 *
 * Auth: the page URL carries a per-start token (`?k=`); API calls echo it in
 * the `x-sm-key` header. `ui.token: 'off'` disables the check on trusted
 * loopback-only setups.
 * @module supermemory/webui
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { buildExport } from './export.ts'
import { scanWorkspace } from './filemap.ts'
import { TITLE_MAX, assessConclusion, deriveTitle, mergeTags, normalizeTags, tagsOfBody } from './retrieval.ts'
import { fillTopicShapeOnCreate, noteTopicSetActivated } from './topic-shape.ts'
import type { Dispatch, Episode, FileMapEntry, Memory, OutboxItem, Requirement, Routing, Signal, ToolMemory, TopicSet } from './schema.ts'
import { createTopicSet, setRouting, touchTopicSet } from './topicsets.ts'
import { newId, workspaceKeyOf, type Store } from './store.ts'
import { listHubSessions } from './hub-sessions.ts'
import { listWorkspaceBranches } from './hub-branches.ts'

/** Route prefix owned by this module (a host web-server named prefix route). */
const PREFIX = '/supermemory'
/** Hard cap for JSON request bodies. */
const MAX_BODY_BYTES = 1024 * 1024
/** Title cap, mirroring `/memory new`. */
const MAX_TITLE = 40

export interface WebuiConfig {
  enabled: boolean
  /** `''` generates a per-start token; `'off'` disables auth; other values pin it. */
  token: string
  /**
   * HTTP carrier. `'own'` (default): our own loopback server on an ephemeral
   * port — a different origin from the GUI, which the sidebar browser tab CAN
   * open (it rejects same-origin URLs: "error.application-origin").
   * `'auto'`: prefer `ctx.webServer` (GUI origin, no extra port) — usable from
   * the system browser, NOT from the embedded browser tab.
   */
  carrier: 'own' | 'auto'
}

export interface WebuiHandle {
  enabled: boolean
  /** Listening port of the host web server (0 when unavailable). */
  readonly port: number
  /** Management URL for a session/workspace; `''` when disabled. */
  url(sessionId?: string, workspaceKey?: string): string
}

let active: WebuiHandle | undefined

/** The live handle, read by the `/memory ui` command and the `memory_ui` tool. */
export function getWebui(): WebuiHandle | undefined {
  return active
}

type Logger = { warn: (msg: string) => void; info: (msg: string) => void }

const DISABLED: WebuiHandle = { enabled: false, port: 0, url: () => '' }

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/**
 * HTTP carrier for the console. Preferred: the host's own web server (the GUI
 * origin, so the page is same-origin). Fallback: our own loopback server, for
 * hosts that serve the GUI from another process or have no web server at all —
 * the sidebar browser tab accepts loopback HTTP(S) targets either way.
 */
type Carrier =
  | { kind: 'host-webServer'; port: () => number; register: (handler: RouteHandler) => () => void }
  | { kind: 'own-http'; port: () => number; register: (handler: RouteHandler) => () => void; close: () => void }

/** Attach the console; returns the effect disposer. */
export function attachWebui(ctx: Context, store: Store | undefined, config: WebuiConfig, logger: Logger): () => void {
  if (!config.enabled || !store) return () => {}
  const theStore = store
  const theCtx = ctx
  const token = config.token === 'off' ? '' : (config.token || randomUUID())

  // Static assets live next to the sources; the bundle is symlinked into the
  // profile, so `import.meta.url` resolves back to the repo checkout.
  const staticDir = resolveStaticDir()

  const router: RouteHandler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname === PREFIX ? '/' : (url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : undefined)
    const head = req.method === 'HEAD'
    // The token is the only gate. A caller proves it with the header (fetch) or
    // with ?k= (the URL /memory ui hands out).
    const authorized = !token || req.headers['x-sm-key'] === token || url.searchParams.get('k') === token
    // CORS preflight first: preflights never carry x-sm-key, so answering
    // before the auth check is both correct and necessary. A sandboxed
    // browser-tab iframe has an opaque origin, so its API calls preflight.
    if (req.method === 'OPTIONS') return sendCors(res)
    try {
      if (sub === undefined) return sendJson(res, 404, { ok: false, error: 'not found' }, head)
      if (sub.startsWith('/api/')) {
        if (!authorized) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized — reopen the console via /memory ui' }, head)
        }
        const route = sub.slice('/api/'.length)
        // Read-only routes answer GET (query params) so the browser can fetch
        // and HEAD them; everything mutating requires POST with a JSON body.
        const readOnly = route === 'workspaces' || route === 'state'
        let body: Json
        if (req.method === 'POST') {
          try {
            body = await readJsonBody(req)
          } catch (bodyError) {
            // A malformed/oversized body is the CALLER's fault: answer 400/413
            // instead of falling through to the generic 500 branch.
            const message = bodyError instanceof Error ? bodyError.message : String(bodyError)
            return sendJson(res, message.includes('too large') ? 413 : 400, { ok: false, error: message }, head)
          }
        } else if (req.method === 'GET' && readOnly) body = Object.fromEntries(url.searchParams.entries())
        else return sendJson(res, 405, { ok: false, error: readOnly ? 'GET or POST required' : 'POST required' }, head)
        return await handleApi(res, route, body, theStore, logger, theCtx)
      }
      if (req.method !== 'GET' && !head) return sendJson(res, 405, { ok: false, error: 'GET required' }, head)
      // SECURITY: the shell used to hand the real token to ANY caller while its
      // response was CORS-open (access-control-allow-origin: *), so a foreign
      // localhost page could read the token and then use the whole API. Only an
      // already-authorized request gets the token stamped in, and static answers
      // are not CORS-readable at all (documents/scripts need no CORS).
      return await serveStatic(res, sub, head, staticDir, authorized ? token : '')
    } catch (error) {
      logger.warn(`supermemory: web console request failed: ${String(error).slice(0, 200)}`)
      return sendJson(res, 500, { ok: false, error: 'internal error' }, head)
    }
  }

  // Optional service: `ctx.get` yields undefined instead of failing the fiber
  // when the host runs without a web server (headless/CLI profiles).
  const webServer = config.carrier === 'auto' ? ctx.get('webServer') : undefined
  let carrier: Carrier | undefined
  if (webServer) {
    carrier = {
      kind: 'host-webServer',
      port: () => webServer.port,
      register: (handler) => webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    }
  } else {
    const server = createServer((req, res) => { void router(req, res).catch(() => {}) })
    // `listen(0)` binds asynchronously: address() is null until 'listening'.
    let ownPort = 0
    const readPort = () => {
      const addr = server.address()
      return addr && typeof addr === 'object' ? addr.port : 0
    }
    server.on('listening', () => { ownPort = readPort() })
    // Without an 'error' listener a bind failure would crash the host process.
    server.on('error', (error) => {
      logger.warn(`supermemory: console server error: ${String(error).slice(0, 160)}`)
    })
    try {
      server.listen(0, '127.0.0.1')
      carrier = {
        kind: 'own-http',
        port: () => ownPort || readPort(),
        register: () => () => {},
        close: () => { server.closeAllConnections?.(); server.close() },
      }
      logger.info(config.carrier === 'auto'
        ? 'supermemory: ctx.webServer unavailable — console served from own loopback server'
        : 'supermemory: console served from own loopback server (carrier=own, sidebar-openable origin)')
    } catch (error) {
      logger.warn(`supermemory: web console disabled — no HTTP carrier: ${String(error).slice(0, 120)}`)
    }
  }
  if (!carrier) return () => {}
  const theCarrier = carrier
  const base = () => `http://127.0.0.1:${theCarrier.port()}${PREFIX}/`
  const handle: WebuiHandle = {
    enabled: true,
    get port() { return theCarrier.port() },
    url: (sessionId, workspaceKey) => {
      const params = new URLSearchParams()
      if (token) params.set('k', token)
      if (sessionId) params.set('session', sessionId)
      if (workspaceKey) params.set('ws', workspaceKey)
      const query = params.toString()
      return query ? `${base()}?${query}` : base()
    },
  }

  return ctx.effect(() => {
    const disposeRoute = theCarrier.register(router)
    active = handle
    logger.info(`supermemory: web console at ${base()} (carrier: ${theCarrier.kind})`)
    return () => {
      disposeRoute()
      if (theCarrier.kind === 'own-http') theCarrier.close()
      if (active === handle) active = undefined
    }
  }, 'supermemory: web-console')
}

/** First existing asset directory: repo checkout, then a bundled `web/`. */
function resolveStaticDir(): string {
  for (const candidate of ['../src/web/', '../web/']) {
    try {
      const dir = fileURLToPath(new URL(candidate, import.meta.url))
      if (statSync(join(dir, 'index.html')).isFile()) return dir
    } catch { /* try the next candidate */ }
  }
  return fileURLToPath(new URL('../src/web/', import.meta.url))
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/** Serve the console shell and its two assets; everything else 404s. */
async function serveStatic(res: ServerResponse, sub: string, head: boolean, staticDir: string, token: string): Promise<void> {
  if (sub === '/' || sub === '/index.html') {
    let html: string
    try {
      html = await readFile(join(staticDir, 'index.html'), 'utf8')
    } catch {
      html = fallbackHtml()
    }
    return sendText(res, 200, injectToken(html, token), MIME['.html'], head, false)
  }
  const name = sub === '/app.js' ? 'app.js' : sub === '/style.css' ? 'style.css' : undefined
  if (!name) return sendJson(res, 404, { ok: false, error: 'not found' }, head)
  const ext = name.slice(name.lastIndexOf('.'))
  try {
    const text = await readFile(join(staticDir, name), 'utf8')
    return sendText(res, 200, text, MIME[ext] ?? 'text/plain; charset=utf-8', head, false)
  } catch {
    return sendJson(res, 404, { ok: false, error: 'asset missing — src/web/ not installed' }, head)
  }
}

/** Stamp the per-start token into the shell so app.js can echo it back. */
function injectToken(html: string, token: string): string {
  const meta = token ? `<meta name="sm-token" content="${token}">` : '<meta name="sm-token" content="">'
  if (/<meta name="sm-token"[^>]*>/.test(html)) return html.replace(/<meta name="sm-token"[^>]*>/, meta)
  return html.replace('<head>', `<head>
    ${meta}`)
}

/** Shown when the bundle ships without `src/web/`. */
function fallbackHtml(): string {
  // DSH dark palette (design-platform.css body[data-ds-dark-theme]) so the
  // degraded shell still matches the host theme.
  return '<!doctype html><html><head><meta charset="utf-8"><title>SuperMemory</title></head>'
    + '<body style="background:#151517;color:#f9fafb;font-family:system-ui;padding:24px">'
    + '<h3>SuperMemory 管理台</h3><p>静态资源缺失：请在插件目录保留 <code>src/web/</code>（index.html / app.js / style.css）。</p></body></html>'
}

// ---------- JSON API ----------

type Json = Record<string, unknown>

/** Every mutating endpoint validates the target row against `ws` first. */
async function handleApi(
  res: ServerResponse,
  route: string,
  body: Json,
  store: Store,
  logger: Logger,
  ctx?: Context,
): Promise<void> {
  const ws = text(body.ws)
  const fail = (error: string) => sendJson(res, 400, { ok: false, error })
  // Every mutating endpoint writes a workspace-scoped row; an empty ws used to
  // create rows that belong to NO workspace (invisible to every filter, and a
  // silent cross-workspace leak once a workspace later matched the empty key).
  if (route !== 'workspaces' && !ws) return fail('ws 不能为空')
  switch (route) {
    case 'workspaces':
      return sendJson(res, 200, { ok: true, workspaces: listWorkspaces(store) })
    case 'state': {
      if (!ws) return fail('ws 不能为空')
      // R18: the 中枢会话 section needs the same rule the panel rail uses. A
      // host without the session-query seam quietly yields an empty list.
      let hubs: unknown[] = []
      if (ctx) {
        try {
          hubs = await listHubSessions(ctx, store, ws)
        } catch { /* the section renders its empty state */ }
      }
      // R19 协同②③: the console shows the same hub→branch relation as the panel
      // (branch rows carry their set + how many hubs share them).
      let hubBranches: unknown[] = []
      try {
        hubBranches = listWorkspaceBranches(store, ws)
      } catch { /* the section renders without branch rows */ }
      return sendJson(res, 200, { ok: true, ...buildState(store, ws), hubs, hubBranches })
    }
    case 'memory/create': {
      const memText = text(body.text)
      if (!memText) return fail('text 不能为空')
      // R19 需求⑧: every write path stores conclusions, not transcripts.
      const verdict = assessConclusion(memText)
      if (!verdict.ok) return fail(verdict.message)
      const id = newId('mem')
      const now = Date.now()
      const record: Memory = {
        workspaceKey: ws,
        title: text(body.title).slice(0, TITLE_MAX) || deriveTitle(memText),
        text: memText,
        // The console's "keywords" field is the tags field (R10); auto keywords
        // fill whatever the operator did not tag, so old flows stay findable.
        keywords: mergeTags(normalizeTags(list(body.keywords)), tagsOfBody(memText)),
        key: text(body.key) || undefined,
        sourceSessionId: text(body.sessionId) || 'webui', sourceSeq: 0,
        status: 'active', createdAt: now, updatedAt: now,
      }
      await store.memories.put(id, record)
      logger.info(`supermemory: webui created memory ${id}`)
      return sendJson(res, 200, { ok: true, id })
    }
    case 'memory/update': {
      const id = text(body.id)
      const existing = store.memories.get(id)
      if (!existing || existing.workspaceKey !== ws) return fail('记忆不存在')
      const memText = text(body.text)
      if (memText) {
        const verdict = assessConclusion(memText)
        if (!verdict.ok) return fail(verdict.message)
      }
      await store.memories.update(id, (r) => ({
        ...r,
        ...(memText ? { text: memText } : {}),
        ...(body.title !== undefined
          ? { title: text(body.title).slice(0, TITLE_MAX) || deriveTitle(memText || r.text) }
          : {}),
        ...(body.keywords !== undefined
          ? { keywords: mergeTags(normalizeTags(list(body.keywords)), tagsOfBody(memText || r.text)) }
          : {}),
        ...(body.key !== undefined ? { key: text(body.key) || undefined } : {}),
        updatedAt: Date.now(),
      }))
      logger.info(`supermemory: webui updated memory ${id}`)
      return sendJson(res, 200, { ok: true })
    }
    case 'memory/status': {
      const id = text(body.id)
      const status = body.status === 'active' || body.status === 'superseded' ? body.status : undefined
      if (!status) return fail('status 必须是 active 或 superseded')
      const existing = store.memories.get(id)
      if (!existing || existing.workspaceKey !== ws) return fail('记忆不存在')
      await store.memories.update(id, (r) => ({ ...r, status, updatedAt: Date.now() }))
      logger.info(`supermemory: webui memory ${id} -> ${status}`)
      return sendJson(res, 200, { ok: true })
    }
    case 'memory/delete': {
      const id = text(body.id)
      const existing = store.memories.get(id)
      if (!existing || existing.workspaceKey !== ws) return fail('记忆不存在')
      await store.memories.delete(id)
      logger.info(`supermemory: webui deleted memory ${id}`)
      return sendJson(res, 200, { ok: true })
    }
    case 'requirement/create': {
      const reqText = text(body.text)
      if (!reqText) return fail('text 不能为空')
      const id = newId('req')
      const now = Date.now()
      const record: Requirement = {
        topicSetId: text(body.topicSetId) || undefined,
        workspaceKey: ws, text: reqText, constraints: list(body.constraints),
        status: 'open', sourceSessionId: text(body.sessionId) || 'webui', sourceSeq: 0,
        createdAt: now,
      }
      await store.requirements.put(id, record)
      logger.info(`supermemory: webui created requirement ${id}`)
      return sendJson(res, 200, { ok: true, id })
    }
    case 'requirement/update': {
      const id = text(body.id)
      const existing = store.requirements.get(id)
      if (!existing || existing.workspaceKey !== ws) return fail('需求不存在')
      const reqText = text(body.text)
      const status = body.status === 'open' || body.status === 'closed' ? body.status : undefined
      await store.requirements.update(id, (r) => ({
        ...r,
        ...(reqText ? { text: reqText } : {}),
        ...(body.constraints !== undefined ? { constraints: list(body.constraints) } : {}),
        ...(body.topicSetId !== undefined ? { topicSetId: text(body.topicSetId) || undefined } : {}),
        ...(status ? { status, closedAt: status === 'closed' ? Date.now() : undefined } : {}),
      }))
      logger.info(`supermemory: webui updated requirement ${id}`)
      return sendJson(res, 200, { ok: true })
    }
    case 'requirement/delete': {
      const id = text(body.id)
      const existing = store.requirements.get(id)
      if (!existing || existing.workspaceKey !== ws) return fail('需求不存在')
      await store.requirements.delete(id)
      logger.info(`supermemory: webui deleted requirement ${id}`)
      return sendJson(res, 200, { ok: true })
    }
    case 'topicset/create': {
      const title = text(body.title)
      if (!title) return fail('title 不能为空')
      const id = await createTopicSet(store, {
        workspaceKey: ws, title: title.slice(0, MAX_TITLE),
        summary: text(body.summary) || undefined,
        keywords: list(body.keywords),
      })
      // R19 需求⑥: the model fills the index when a layer was left empty; a
      // failure keeps exactly what was written above.
      try {
        await fillTopicShapeOnCreate(
          { ctx, store, logger: { warn: (msg) => logger.warn(msg) } },
          id,
          text(body.summary),
          { tags: list(body.keywords).length === 0, summary: !text(body.summary) },
        )
      } catch (error) {
        logger.warn('supermemory: webui topic-set shape generation skipped: ' + String(error).slice(0, 160))
      }
      const stored = store.topicsets.get(id)
      logger.info(`supermemory: webui created topic set ${id}`)
      return sendJson(res, 200, { ok: true, id, title: stored?.title, keywords: stored?.keywords, summary: stored?.summary })
    }
    case 'topicset/update': {
      const id = text(body.id)
      const existing = store.topicsets.get(id)
      if (!existing || existing.workspaceKey !== ws) return fail('话题集不存在')
      const title = text(body.title)
      const status = body.status === 'active' || body.status === 'archived' ? body.status : undefined
      await store.topicsets.update(id, (r) => ({
        ...r,
        ...(title ? { title: title.slice(0, MAX_TITLE) } : {}),
        ...(body.summary !== undefined ? { summary: text(body.summary) } : {}),
        ...(body.keywords !== undefined ? { keywords: list(body.keywords) } : {}),
        ...(status ? { status } : {}),
        updatedAt: Date.now(),
      }))
      logger.info(`supermemory: webui updated topic set ${id}`)
      return sendJson(res, 200, { ok: true })
    }
    case 'topicset/activate': {
      const id = text(body.id)
      const sessionId = text(body.sessionId)
      const existing = store.topicsets.get(id)
      if (!existing || existing.workspaceKey !== ws) return fail('话题集不存在')
      if (!sessionId) return fail('sessionId 不能为空')
      await setRouting(store, sessionId, { activeTopicSetId: id, driftCount: 0 })
      await touchTopicSet(store, id)
      // R19 需求⑥: activation triggers a content-gated, throttled regeneration.
      noteTopicSetActivated({ ctx, store, logger: { warn: (msg) => logger.warn(msg) } }, id)
      logger.info(`supermemory: webui activated ${id} for ${sessionId}`)
      return sendJson(res, 200, { ok: true })
    }
    case 'filemap/scan': {
      const cwd = text(body.cwd)
      if (!cwd) return fail('cwd 不能为空')
      let isDir = false
      try { isDir = statSync(cwd).isDirectory() } catch { /* reported below */ }
      if (!isDir) return fail('cwd 不是有效目录')
      if (workspaceKeyOf(cwd) !== ws) return fail('cwd 与所选工作区不匹配')
      const result = await scanWorkspace(store, cwd)
      const total = countWs(store.filemap.entries(), ws)
      logger.info(`supermemory: webui scanned ${result.scanned} files`)
      return sendJson(res, 200, { ok: true, ...result, total })
    }
    case 'export': {
      const cwd = text(body.cwd)
      if (!cwd) return fail('cwd 不能为空')
      if (workspaceKeyOf(cwd) !== ws) return fail('cwd 与所选工作区不匹配')
      const result = buildExport(store, ws)
      const target = join(cwd, '.supermemory-export.md')
      await writeFile(target, result.text, 'utf8')
      logger.info(`supermemory: webui exported to ${target}`)
      return sendJson(res, 200, { ok: true, path: target, ...result })
    }
    // ---- destructive cleanup: these rows had NO removal path before, which is
    // how verification rounds piled up topicsets/episodes/dispatches forever.
    case 'episode/delete': {
      const id = text(body.id)
      const episode = store.episodes.get(id)
      if (!episode) return fail('梗概不存在')
      // Workspace isolation: an episode joins through its topic set.
      if (episode.topicSetId && !tsIdsOf(store, ws).has(episode.topicSetId)) return fail('梗概不属于当前工作区')
      await store.episodes.delete(id)
      logger.info(`supermemory: webui deleted episode ${id}`)
      return sendJson(res, 200, { ok: true })
    }
    case 'dispatch/delete': {
      const id = text(body.id)
      const dispatch = store.dispatches.get(id)
      if (!dispatch) return fail('派发记录不存在')
      if (dispatch.topicSetId && !tsIdsOf(store, ws).has(dispatch.topicSetId)) return fail('派发记录不属于当前工作区')
      await store.dispatches.delete(id)
      // A relay row for a deleted dispatch is dead weight: drop it too.
      let outbox = 0
      for (const [outboxId, item] of [...store.outbox.entries()]) {
        if (item.dispatchId !== id) continue
        await store.outbox.delete(outboxId)
        outbox++
      }
      logger.info(`supermemory: webui deleted dispatch ${id} (+${outbox} outbox rows)`)
      return sendJson(res, 200, { ok: true, outbox })
    }
    case 'topicset/delete': {
      const id = text(body.id)
      const existing = store.topicsets.get(id)
      if (!existing || existing.workspaceKey !== ws) return fail('话题集不存在')
      // Cascade: a topic set owns its episodes, dispatches, their relay rows and
      // every routing pointer at it.
      let episodes = 0
      for (const [episodeId, episode] of [...store.episodes.entries()]) {
        if (episode.topicSetId !== id) continue
        await store.episodes.delete(episodeId)
        episodes++
      }
      const dispatchIds = new Set<string>()
      const groupIds = new Set<string>()
      for (const [dispatchId, dispatch] of [...store.dispatches.entries()]) {
        if (dispatch.topicSetId !== id) continue
        await store.dispatches.delete(dispatchId)
        dispatchIds.add(dispatchId)
        if (dispatch.groupId) groupIds.add(dispatch.groupId)
      }
      let outbox = 0
      for (const [outboxId, item] of [...store.outbox.entries()]) {
        const hit = (item.dispatchId !== undefined && dispatchIds.has(item.dispatchId))
          || (item.groupId !== undefined && groupIds.has(item.groupId))
        if (!hit) continue
        await store.outbox.delete(outboxId)
        outbox++
      }
      let routing = 0
      for (const [sessionId, record] of [...store.routing.entries()]) {
        if (record.activeTopicSetId !== id) continue
        await store.routing.delete(sessionId)
        routing++
      }
      await store.topicsets.delete(id)
      logger.info(`supermemory: webui deleted topic set ${id} (episodes ${episodes}, dispatches ${dispatchIds.size}, outbox ${outbox}, routing ${routing})`)
      return sendJson(res, 200, { ok: true, episodes, dispatches: dispatchIds.size, outbox, routing })
    }
    default:
      return sendJson(res, 404, { ok: false, error: `unknown api route: ${route}` })
  }
}

/** Workspace inventory for the console's workspace selector. */
function listWorkspaces(store: Store): Array<{ key: string; topicsets: number; memories: number; requirements: number; episodes: number; filemap: number }> {
  const rows = new Map<string, { key: string; topicsets: number; memories: number; requirements: number; episodes: number; filemap: number }>()
  const row = (key: string) => {
    let found = rows.get(key)
    if (!found) { found = { key, topicsets: 0, memories: 0, requirements: 0, episodes: 0, filemap: 0 }; rows.set(key, found) }
    return found
  }
  const topicSetsByWs = new Map<string, Set<string>>()
  for (const [id, t] of store.topicsets.entries()) {
    row(t.workspaceKey).topicsets++
    const ids = topicSetsByWs.get(t.workspaceKey) ?? new Set<string>()
    ids.add(id)
    topicSetsByWs.set(t.workspaceKey, ids)
  }
  for (const [, m] of store.memories.entries()) row(m.workspaceKey).memories++
  for (const [, r] of store.requirements.entries()) row(r.workspaceKey).requirements++
  for (const [, f] of store.filemap.entries()) row(f.workspaceKey).filemap++
  for (const [, e] of store.episodes.entries()) {
    const key = e.topicSetId ? findWsOfTopicSet(topicSetsByWs, e.topicSetId) : undefined
    if (key) row(key).episodes++
  }
  return [...rows.values()].sort((a, b) =>
    (b.topicsets + b.memories + b.requirements + b.filemap) - (a.topicsets + a.memories + a.requirements + a.filemap))
}

function findWsOfTopicSet(map: Map<string, Set<string>>, topicSetId: string): string | undefined {
  for (const [ws, ids] of map) if (ids.has(topicSetId)) return ws
  return undefined
}

/**
 * Full snapshot for one workspace. Workspace-scoped tables are filtered by
 * `workspaceKey`; episodes/dispatches/outbox join through their topic set;
 * routing and workspace-free tool memories stay global (session/global scope).
 */
function buildState(store: Store, ws: string) {
  const topicsets: Array<{ id: string } & TopicSet> = []
  for (const [id, t] of store.topicsets.entries()) {
    if (t.workspaceKey !== ws) continue
    topicsets.push({ id, ...t })
  }
  topicsets.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const tsIds = new Set(topicsets.map((t) => t.id))

  const memories: Array<{ id: string } & Memory> = []
  for (const [id, m] of store.memories.entries()) if (m.workspaceKey === ws) memories.push({ id, ...m })
  memories.sort((a, b) => b.updatedAt - a.updatedAt)

  const requirements: Array<{ id: string } & Requirement> = []
  for (const [id, r] of store.requirements.entries()) if (r.workspaceKey === ws) requirements.push({ id, ...r })
  requirements.sort((a, b) => b.createdAt - a.createdAt)

  const signals: Array<{ id: string } & Signal> = []
  for (const [id, s] of store.signals.entries()) if (s.workspaceKey === ws) signals.push({ id, ...s })
  signals.sort((a, b) => b.lastSeen - a.lastSeen)

  const filemap: Array<{ id: string } & FileMapEntry> = []
  for (const [id, f] of store.filemap.entries()) if (f.workspaceKey === ws) filemap.push({ id, ...f })
  filemap.sort((a, b) => a.path.localeCompare(b.path))

  const episodes: Array<{ id: string } & Episode> = []
  for (const [id, e] of store.episodes.entries()) {
    if (e.topicSetId && !tsIds.has(e.topicSetId)) continue
    episodes.push({ id, ...e })
  }
  episodes.sort((a, b) => b.timeStart - a.timeStart)

  const dispatches: Array<{ id: string } & Dispatch> = []
  for (const [id, d] of store.dispatches.entries()) {
    if (d.topicSetId && !tsIds.has(d.topicSetId)) continue
    dispatches.push({ id, ...d })
  }
  dispatches.sort((a, b) => b.createdAt - a.createdAt)
  const dispatchIds = new Set(dispatches.map((d) => d.id))
  const groupIds = new Set(dispatches.map((d) => d.groupId).filter((g): g is string => !!g))

  const outbox: Array<{ id: string } & OutboxItem> = []
  for (const [id, o] of store.outbox.entries()) {
    if (o.dispatchId && !dispatchIds.has(o.dispatchId)) continue
    if (!o.dispatchId && o.groupId && !groupIds.has(o.groupId)) continue
    if (!o.dispatchId && !o.groupId) continue
    outbox.push({ id, ...o })
  }
  outbox.sort((a, b) => b.enqueuedAt - a.enqueuedAt)

  const toolMemory: Array<{ id: string } & ToolMemory> = []
  for (const [id, t] of store.toolMemory.entries()) {
    if (t.workspaceKey && t.workspaceKey !== ws) continue
    toolMemory.push({ id, ...t })
  }
  toolMemory.sort((a, b) => a.trigger.localeCompare(b.trigger))

  const routing: Array<{ sessionId: string } & Routing> = []
  for (const [sessionId, r] of store.routing.entries()) routing.push({ sessionId, ...r })
  routing.sort((a, b) => b.updatedAt - a.updatedAt)

  return { generatedAt: Date.now(), workspace: ws, topicsets, memories, episodes, requirements, dispatches, outbox, signals, toolMemory, filemap, routing }
}

// ---------- small helpers ----------

/** Topic-set ids of one workspace: episodes/dispatches join through them. */
function tsIdsOf(store: Store, ws: string): Set<string> {
  const ids = new Set<string>()
  for (const [id, topicSet] of store.topicsets.entries()) {
    if (topicSet.workspaceKey === ws) ids.add(id)
  }
  return ids
}

function countWs<V extends { workspaceKey?: string }>(entries: IterableIterator<[string, V]>, ws: string): number {
  let n = 0
  for (const [, v] of entries) if (v.workspaceKey === ws) n++
  return n
}

/** Accept a string (comma separated, EN/CN) or a string array. */
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,，]/).map((v) => v.trim()).filter(Boolean)
  return []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed as Json
}

function sendText(res: ServerResponse, status: number, body: string, type: string, head: boolean, cors = true): void {
  const buf = Buffer.from(body, 'utf8')
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': String(buf.length),
  }
  if (cors) {
    // Only JSON API answers need CORS: the sandboxed sidebar iframe has an
    // opaque origin, so its fetch() preflights. Static documents/scripts do not,
    // and marking them CORS-open would let any web page read the shell.
    headers['access-control-allow-origin'] = '*'
    headers['access-control-allow-methods'] = 'GET, POST, HEAD, OPTIONS'
    headers['access-control-allow-headers'] = 'x-sm-key, content-type'
  }
  res.writeHead(status, headers)
  if (head) res.end()
  else res.end(buf)
}

/** CORS preflight answer (204, no body). */
function sendCors(res: ServerResponse): void {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS',
    'access-control-allow-headers': 'x-sm-key, content-type',
    'access-control-max-age': '600',
    'content-length': '0',
  })
  res.end()
}

function sendJson(res: ServerResponse, status: number, value: unknown, head = false): void {
  sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8', head)
}
