// Pre-flight simulation of the wrapped client bundle: executes it through
// a fake __ModuleLoader__ with a stub react, then runs apply() against a mock
// Cordis context and checks every slot registration succeeds.
import { readFileSync } from 'node:fs'
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
    if (key === 'remote') return { $mount: async () => () => {} }
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
  'sidebar.session.action:supermemory-new-session',
]
for (const want of expected) {
  if (!slots.includes(want)) throw new Error('missing registration: ' + want + ' (got ' + slots.join(', ') + ')')
}
if (consoleErrors.length > 0) throw new Error('console.error during apply: ' + consoleErrors.join(' | '))

console.log('SIM SMOKE OK')
console.log('  name:', moduleExports.name)
console.log('  inject:', JSON.stringify(moduleExports.inject))
console.log('  registrations:', slots.join(', '))
