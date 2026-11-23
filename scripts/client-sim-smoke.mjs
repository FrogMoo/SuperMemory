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

const sandbox = {
  console: { error: (...args) => consoleErrors.push(args.map(String).join(' ')), log: () => {}, warn: () => {} },
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
if (registration.id !== 'dsh-supermemory') throw new Error('wrong registration id: ' + registration.id)

const stubReact = {
  createElement: () => ({ $$typeof: Symbol.for('react.element') }),
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
const ctx = {
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
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

console.log('SIM SMOKE OK')
console.log('  name:', moduleExports.name)
console.log('  inject:', JSON.stringify(moduleExports.inject))
console.log('  registrations:', slots.join(', '))
