// Pre-flight simulation of the wrapped client bundle: executes it through
// a fake __ModuleLoader__ with a stub react, then runs apply() against a mock
// Cordis context and checks every slot registration succeeds.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const registrations = []
const loaded = []
const consoleErrors = []
const consoleWarnings = []

const sandbox = {
  console: {
    error: (...args) => consoleErrors.push(args.map(String).join(' ')),
    log: () => {},
    warn: (...args) => consoleWarnings.push(args.map(String).join(' ')),
  },
  window: {
    __ModuleLoader__: {
      load: (registration) => { loaded.push(registration) },
    },
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

if (loaded.length !== 1) throw new Error('expected exactly one __ModuleLoader__.load registration, got ' + loaded.length)
const registration = loaded[0]
// R59: the loader id is the package name (scoped), not the old unscoped one.
if (registration.id !== '@frogmoo/dsh-supermemory') throw new Error('wrong registration id: ' + registration.id)

// R32 需求③: keep the element shape readable so the chat-card component can be
// rendered headlessly and its dynamic title asserted (not just registered).
const stubReact = {
  createElement: (type, props, ...children) => {
    const element = {
      $$typeof: Symbol.for('react.element'),
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }
    // Render the one function component under test headlessly; everything else
    // keeps the opaque element shape (the panel components are only registered).
    return typeof type === 'function' && type.name === 'SupermemoryCard'
      ? type({ ...(props ?? {}), children: element.props.children })
      : element
  },
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
}
const fakeRequire = (spec) => {
  if (spec === 'react') return stubReact
  throw new Error('unexpected require: ' + spec)
}

const moduleExports = registration.factory(fakeRequire)
if (typeof moduleExports.apply !== 'function') throw new Error('exports.apply missing')
if (typeof moduleExports.name !== 'string') throw new Error('exports.name missing')
if (!Array.isArray(moduleExports.inject)) throw new Error('exports.inject missing')

// mock context
let mountedContribution
const remoteNamespace = new Proxy({}, {
  get: (_target, method) => async () => ({ ok: true, value: { status: 'ok', message: 'mock', id: 'mock-id', topicSets: [], memories: [], counts: {} } }),
})
// R33: the shipped renderers' REAL contracts (host src/chat/MessageItem.tsx and
// TurnTriggerNodeView.tsx): UserMessageNodeView needs `t` + `renderSlotChain`,
// the trigger/context views need `t`. These fakes THROW when a delegated
// message does not receive them, so "delegation keeps the host alive" is a
// behavioural assertion, not a source-string check.
const hostProps = (props, needsChain) => {
  if (typeof props?.t !== 'function') throw new Error('shipped node view requires t (locale)')
  if (needsChain && typeof props?.renderSlotChain !== 'function') {
    throw new Error('shipped user/steering view requires renderSlotChain')
  }
}
const fakeUserNode = (props) => {
  hostProps(props, true)
  return { $$typeof: Symbol.for('react.element'), type: 'shipped-user', props }
}
const fakeTriggerNode = (props) => {
  hostProps(props, false)
  return { $$typeof: Symbol.for('react.element'), type: 'shipped-trigger', props }
}
const fakeSteeringNode = (props) => {
  hostProps(props, true)
  return { $$typeof: Symbol.for('react.element'), type: 'shipped-steering', props }
}
const fakeContextNode = (props) => {
  hostProps(props, false)
  return { $$typeof: Symbol.for('react.element'), type: 'shipped-context', props }
}
const builtinChatNodes = [
  { options: { key: 'user' }, component: fakeUserNode },
  { options: { key: 'steering' }, component: fakeSteeringNode },
  { options: { key: 'turn-trigger' }, component: fakeTriggerNode },
  { options: { key: 'context' }, component: fakeContextNode },
]
const ctx = {
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  locale: {
    register: () => () => {},
    bind: () => (key, params) => key === 'chat.card.from'
      ? '来自 ' + String(params?.session ?? '') + ' 的执行请求'
      : key === 'chat.card.kind.hub' ? '中枢派发'
        : key === 'chat.card.kind.branch' ? '分支回报'
          : key,
  },
  get: (key) => {
    if (key === 'remote') return { $mount: async (contribution) => { mountedContribution = contribution; return () => {} } }
    if (key === 'remote.supermemoryPanel') return remoteNamespace
    if (key === 'uiWorkspace') return { openSession: () => {}, startSession: () => {} }
    return undefined
  },
  slots: {
    inject: (key, callback) => {
      const result = callback()
      if (Array.isArray(result)) for (const entry of result) registrations.push({ slot: key, entry })
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ slot: options.name, entry: { options, component } })
      return () => {}
    },
    // R32 需求③: the shipped node renderers the card must delegate to.
    entries: () => builtinChatNodes,
  },
}

await moduleExports.apply(ctx)

const slots = registrations.map((r) => r.slot + ':' + (r.entry?.options?.id ?? r.entry?.options?.key ?? '?'))
const expected = [
  'sidebar.panellist:supermemory',
  'main:supermemory',
  'shell.overlay:supermemory-new-session',
  // GUI 问题③ / R31 需求②: the session badge on sidebar rows. It moved from
  // `leading` to `trailing` because the host gates the leading cell by
  // `showStatus ? dots : slot` (a running row lost the badge to its status
  // dot); the trailing cell is gated by `!row.blank` only, so the badge stays
  // visible while running and in approval states.
  'sidebar.session.row.trailing:supermemory-branch',
  // R32 需求③: the two shadowing card cells (user + turn-trigger), each with a
  // distinguishable id so the card can find and delegate to the shipped node.
  'conversation.chat.node:supermemory-chat-card-user',
  'conversation.chat.node:supermemory-chat-card-steering',
  'conversation.chat.node:supermemory-chat-card-turn-trigger',
  'conversation.chat.node:supermemory-chat-card-context',
]
for (const want of expected) {
  if (!slots.includes(want)) throw new Error('missing registration: ' + want + ' (got ' + slots.join(', ') + ')')
}
if (consoleErrors.length > 0) throw new Error('console.error during apply: ' + consoleErrors.join(' | '))

// R29 需求① regression guard: clicking the shell's 新建会话 control must CREATE a
// hub session, not merely reveal the panel. The entry therefore has to inject
// the panel api (host createHubSession), a cwd resolver and the panel selector —
// the shipped 2026-11-22 regression injected only selectPanel, so the click
// silently did nothing. Checked on the BUILT bundle's registered inject().
const newSession = registrations.find((row) => row.slot === 'shell.overlay'
  && row.entry?.options?.id === 'supermemory-new-session')
if (!newSession) throw new Error('shell.overlay:supermemory-new-session is not registered')
const injectedNewSession = typeof newSession.entry?.options?.inject === 'function'
  ? newSession.entry.options.inject()
  : undefined
if (typeof injectedNewSession?.api?.createHubSession !== 'function') {
  throw new Error('new-session entry must inject api.createHubSession: the click has to create a hub session')
}
if (typeof injectedNewSession?.cwd !== 'function') {
  throw new Error('new-session entry must inject a cwd resolver: the hub session needs a workspace')
}
if (typeof injectedNewSession?.selectPanel !== 'function') {
  throw new Error('new-session entry must inject selectPanel: the receipt must become visible')
}

// R43 ① regression guard on the BUILT bundle: the capture-phase interceptor
// must skip our own chat card. Its head button's accessible name is
// 「来自 <来源会话> 的执行请求」, which matches the New-session pattern whenever
// the source session is named 「新会话」 — without this guard every card click
// created a hub session and opened the panel (the user's 「点卡片跳到新建」).
// The click path itself cannot be driven headlessly (it lives in a useEffect
// over a document listener), so the guard is asserted on the shipped source.
if (!source.includes('[data-supermemory-card]')) {
  throw new Error('R43: new-session interceptor is missing the [data-supermemory-card] skip guard')
}
if (!source.includes('data-supermemory-card')) {
  throw new Error('R43: the chat card no longer marks its own surface (data-supermemory-card)')
}

// The client half only reaches the browser when the package manifest declares
// it: dsh.client.platform 'web' makes clientModules add the package to
// window.__DSH_BOOT__, and exports["./client"] names the artifact to serve.
// This is the regression guard for the shipped bug of 2026-11-17: the client
// bundle built and passed this very smoke, yet no GUI surface ever appeared
// because the manifest field was missing.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (manifest.exports?.['./client'] === undefined) {
  throw new Error('package.json exports["./client"] missing: the client half cannot be served')
}
if (manifest.dsh?.client?.platform !== 'web') {
  throw new Error('package.json dsh.client.platform must be "web": clientModules would skip the client half')
}

// Theme contract (2026-11-18 round 7): the plugin CSS must ride DSH's REAL
// theme vocabulary (--dsw-alias-*, defined by dsh-client-ui-theme's
// design-platform.css). The old --dsh-color-* names exist nowhere in the host,
// so a regression to them silently renders the hardcoded fallbacks and the
// panel stops following the host light/dark theme. Checked on the BUILT
// bundle (what the browser actually loads) and on the console stylesheet.
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(!clientSource.includes('--dsh-color'), 'the bundle must not use the non-existent --dsh-color-* variables')
const consoleCss = readFileSync(new URL('../src/web/style.css', import.meta.url), 'utf8')
assert.ok(!consoleCss.includes('--dsh-color'), 'the console stylesheet must not use the non-existent --dsh-color-* variables')
for (const name of [
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-border-l2',
  '--dsw-alias-button-primary-fill', '--dsw-alias-label-primary-foreground',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary', '--dsw-alias-link',
]) {
  assert.ok(clientSource.includes(name), 'the bundle must ride the DSH theme variable ' + name)
  assert.ok(consoleCss.includes(name), 'the console stylesheet must define the DSH theme variable ' + name)
}
assert.ok(/prefers-color-scheme:\s*dark/.test(consoleCss), 'the console must follow the system color scheme like the host boot theme')

// Mounted-contract arity (2026-11-18 regression): the shell's client api builds
// each remote method from THIS contribution and rejects a call whose argument
// count exceeds the declared parameters — "client api:
// supermemoryPanel/listTools expected 0 argument(s), got 1" took the whole panel
// down to 「加载失败」 while every source-level check stayed green. Assert on the
// BUILT bundle contract that the panel's call sites fit.
const mountedDescriptors = mountedContribution?.descriptors ?? []
if (mountedDescriptors.length === 0) throw new Error('the client half mounted no panel descriptors')
const contractOf = (method) => {
  const descriptor = mountedDescriptors.find((d) => d.method === method)
  if (!descriptor) throw new Error(`mounted contract is missing supermemoryPanel/${method}`)
  return descriptor.parameters
}
const listToolsParameters = contractOf('listTools')
// panel-page.tsx:716 calls `api.listTools(cwd)` — one argument, always a real cwd
// (guarded by `if (!cwd) return`); the declaration must accept it.
assert.equal(listToolsParameters.length, 1, 'supermemoryPanel/listTools must declare the cwd argument the panel passes')
assert.equal(listToolsParameters[0].name, 'cwd')
assert.equal(listToolsParameters[0].acceptsUndefined, true, 'cwd is optional (old hosts / headless callers omit it)')
for (const descriptor of mountedDescriptors) {
  assert.ok(Array.isArray(descriptor.parameters), `supermemoryPanel/${descriptor.method} must declare its parameters`)
}

// R33 需求①②③⑨: the hub↔branch card must render in BOTH node kinds from the
// host's REAL node shape (`node.data`), with a dynamic title and the original
// fields; a non-card message must delegate to the shipped renderer WITH the
// props that renderer requires (t + renderSlotChain), never crash it.
{
  const collectText = (node) => {
    if (node === null || node === undefined) return []
    if (typeof node === 'string') return [node]
    if (Array.isArray(node)) return node.flatMap(collectText)
    if (typeof node === 'object' && node.props) return collectText(node.props.children)
    return []
  }
  const findCell = (key) => registrations.find((row) => row.slot === 'conversation.chat.node'
    && row.entry?.options?.key === key)
  // Depth-first search for an element whose props satisfy a predicate (used to
  // reach the card's head button inside the rendered tree).
  const findProp = (node, predicate) => {
    if (node === null || node === undefined) return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findProp(child, predicate)
        if (hit) return hit
      }
      return undefined
    }
    if (typeof node === 'object' && node.props) {
      if (predicate(node.props)) return node.props
      return findProp(node.props.children, predicate)
    }
    return undefined
  }
  const cells = ['user', 'steering', 'turn-trigger', 'context']
  for (const key of cells) {
    const cell = findCell(key)
    if (!cell) throw new Error('R33 card cell is not registered: ' + key)
    // Without a locale the host binds `t === undefined` into the shipped view.
    assert.equal(cell.entry.options.locale, 'chat', 'the shadowing cell must declare the host chat locale: ' + key)
    const injected = cell.entry.options.inject()
    assert.equal(typeof injected.smCardEnv?.t, 'function', 'the cell injects its own translator: ' + key)
    if (key === 'user' || key === 'steering') {
      assert.equal(typeof injected.renderSlotChain, 'function',
        'the user/steering cell must provide a renderSlotChain (no-op is allowed): ' + key)
    }
  }
  const userCell = findCell('user')
  const triggerCell = findCell('turn-trigger')
  const contextCell = findCell('context')
  const steeringCell = findCell('steering')
  const userEnv = userCell.entry.options.inject().smCardEnv
  if (userEnv.findOriginal('user', 'supermemory-chat-card-user') !== fakeUserNode) {
    throw new Error('R33 card must find the shipped user renderer for delegation')
  }

  // Negative control: the fake host is strict, so a delegated message that
  // forgot t/renderSlotChain WOULD throw (this is the pre-R33 crash).
  assert.throws(() => fakeUserNode({ node: {} }), /requires t \(locale\)/,
    'the shipped user view must throw without t — proves the fake is real')
  assert.throws(() => fakeUserNode({ node: {}, t: () => '' }), /requires renderSlotChain/,
    'the shipped user view must throw without renderSlotChain')

  const at = Date.parse('2026-11-24T08:15:00+08:00')
  const dispatchRendered = userCell.entry.component({
    node: {
      kind: 'user',
      data: {
        time: at,
        content: [{ type: 'text', text: '派发脚本正文' }],
        source: {
          kind: 'user', form: 'supermemory-dispatch', fromSessionId: 'session-hub1', fromTitle: '中枢甲',
          task: '加测试', topicSetTitle: 'R33 话题集', capability: 'full', dispatchId: 'dsp-2', status: 'dispatched',
        },
      },
    },
    smCardEnv: userEnv,
  })
  if (dispatchRendered?.props?.['data-supermemory-card'] !== 'hub') {
    throw new Error('R33 hub→branch dispatch did not render as a hub card (node.data.source not read?)')
  }
  const dispatchText = collectText(dispatchRendered)
  if (!dispatchText.includes('来自 中枢甲 的执行请求')) {
    throw new Error('R33 card title is not the dynamic source title: ' + JSON.stringify(dispatchText))
  }
  // The header clock comes from node.data.time; the top-level node.time is absent.
  if (!/\d{1,2}:\d{2}/.test(dispatchText.join(' '))) {
    throw new Error('R33 card time was not read from node.data.time: ' + JSON.stringify(dispatchText))
  }

  // Reading `node.source` instead of `node.data.source` must turn the next two
  // assertions red: cardMetaOf(undefined) → delegation, not a card.
  const triggerEnv = triggerCell.entry.options.inject().smCardEnv
  const relayRendered = triggerCell.entry.component({
    node: {
      kind: 'turn-trigger',
      data: {
        time: at,
        content: [{ type: 'text', text: '分支结果' }],
        source: {
          kind: 'supermemory', form: 'relay', fromSessionId: 'branch-abcd1234', fromTitle: '分支甲',
          task: '加测试', topicSetTitle: 'R33 话题集', capability: 'read-write', dispatchId: 'dsp-1', status: 'returned',
        },
      },
    },
    smCardEnv: triggerEnv,
  })
  if (relayRendered?.props?.['data-supermemory-card'] !== 'branch') {
    throw new Error('R33 branch→hub relay did not render as a branch card')
  }
  if (!collectText(relayRendered).includes('来自 分支甲 的执行请求')) {
    throw new Error('R33 relay card title is not the dynamic source title')
  }

  // Title missing → the id's last four characters.
  const fallbackRendered = triggerCell.entry.component({
    node: { kind: 'turn-trigger', data: { content: [{ type: 'text', text: '结果' }], source: { kind: 'supermemory', form: 'relay', fromSessionId: 'branch-abcd1234' } } },
    smCardEnv: triggerEnv,
  })
  if (!collectText(fallbackRendered).includes('来自 1234 的执行请求')) {
    throw new Error('R33 relay card title did not fall back to the source id tail')
  }

  // A normal user message (no marker) is delegated to the shipped renderer and
  // receives t + renderSlotChain (calling the real contract must not throw).
  const normal = userCell.entry.component({
    node: { kind: 'user', data: { content: [{ type: 'text', text: '普通用户消息' }], source: { kind: 'user' } } },
    smCardEnv: userEnv,
  })
  if (normal?.type !== fakeUserNode) {
    throw new Error('R33 card swallowed a normal user message instead of delegating it')
  }
  assert.equal(typeof normal.props.t, 'function', 'delegated user message keeps a translator')
  assert.equal(typeof normal.props.renderSlotChain, 'function', 'delegated user message keeps a renderSlotChain')
  assert.doesNotThrow(() => fakeUserNode(normal.props), 'delegated user message must survive the shipped view')
  assert.equal(fakeUserNode(normal.props).props.node.data.content[0].text, '普通用户消息',
    'the delegated node reaches the shipped view unchanged (node.data.content)')

  // Goal / schedule trigger cards and context injections delegate with `t`.
  // R57: our injection cards now carry one registered label as source.kind
  // (the host renders `上下文注入 <label>`); the plugin's chat card must still
  // delegate those rows to the shipped injection renderer, never swallow them.
  for (const [key, cell, source] of [
    ['turn-trigger', triggerCell, { kind: 'goal' }],
    ['turn-trigger', triggerCell, { kind: 'schedule' }],
    ['context', contextCell, { kind: 'supermemory', form: 'recall' }],
    ['context', contextCell, { kind: 'supermemory-相关记忆', form: 'recall' }],
    ['context', contextCell, { kind: 'supermemory-相关分支会话' }],
    ['context', contextCell, { kind: 'supermemory-相关能力' }],
    ['steering', steeringCell, { kind: 'user' }],
  ]) {
    const env = cell.entry.options.inject().smCardEnv
    const rendered = cell.entry.component({
      node: { kind: key, data: { content: [{ type: 'text', text: '普通内容' }], source } },
      smCardEnv: env,
    })
    if (rendered?.type === undefined) throw new Error('R33 delegated node went blank: ' + key)
    assert.equal(typeof rendered.props.t, 'function', 'delegated node keeps t: ' + key)
    assert.doesNotThrow(() => rendered.type(rendered.props), 'delegated node survives its shipped view: ' + key)
  }

  // R43 ①: the card head must STOP PROPAGATING. A document-level capture
  // interceptor (the plugin's own new-session entry) used to match this
  // button's text — 「来自 新会话 的执行请求」 — as the shell's 新建会话 control
  // and created a hub session on every card click. The interceptor now skips
  // `[data-supermemory-card]`; stopping propagation here additionally keeps any
  // ANCESTOR bubble handler (row click / navigation) from acting on a click
  // that only expands the card.
  const clickCard = userCell.entry.component({
    node: {
      kind: 'user',
      data: {
        time: at,
        content: [{ type: 'text', text: '派发脚本正文' }],
        source: {
          kind: 'user', form: 'supermemory-dispatch', fromSessionId: 'session-hub1', fromTitle: '新会话',
          task: '加测试', topicSetTitle: 'R33 话题集', capability: 'full', dispatchId: 'dsp-2', status: 'dispatched',
        },
      },
    },
    smCardEnv: userEnv,
  })
  const head = findProp(clickCard, (props) => props.className === 'sm-chat-card-head' && typeof props.onClick === 'function')
  if (!head) throw new Error('R43 card head button not found')
  let propagated = true
  head.onClick({ stopPropagation: () => { propagated = false } })
  assert.equal(propagated, false, 'R43: a card click must not propagate to ancestor handlers')
  // The card's own surface is marked, which is what the interceptor skips.
  assert.equal(clickCard?.props?.['data-supermemory-card'], 'hub', 'R43: the card marks its own surface')

  // Without the raw entry view the plugin must NOT shadow any cell (otherwise
  // ordinary messages would be swallowed with no way to delegate).
  const before = registrations.length
  const cellSlotsBefore = registrations.filter((row) => row.slot === 'conversation.chat.node').length
  const entries = ctx.slots.entries
  ctx.slots.entries = undefined
  await moduleExports.apply(ctx)
  const added = registrations.slice(before)
  assert.equal(added.filter((row) => row.slot === 'conversation.chat.node').length, 0,
    'a shell without slots.entries() must not shadow conversation.chat.node')
  assert.equal(registrations.filter((row) => row.slot === 'conversation.chat.node').length, cellSlotsBefore,
    'an already-mounted card set is not duplicated by a second apply')
  assert.ok(consoleWarnings.some((message) => message.includes('entries() unavailable')),
    'the degradation is logged, never silent')
  ctx.slots.entries = entries
}

console.log('SIM SMOKE OK')
console.log('  name:', moduleExports.name)
console.log('  inject:', JSON.stringify(moduleExports.inject))
console.log('  registrations:', slots.join(', '))
