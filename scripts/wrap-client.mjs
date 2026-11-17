// Wrap the built CJS client bundle into the web boot protocol form:
//   window.__ModuleLoader__.load({ id, factory: require => { ...CJS body... } })
// The factory receives the module-table require (platform seeds + plugin
// factories), exactly like the shipped client bundles.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'lib', 'client.js')
const raw = readFileSync(target, 'utf8')

if (raw.includes('__ModuleLoader__.load')) {
  console.log('wrap-client: already wrapped, skipping')
  process.exit(0)
}

const body = raw.replace(/\s*\/\/# sourceMappingURL=[^\n]*\s*$/, '')
const head = 'window.__ModuleLoader__.load({id:"dsh-supermemory",factory:require=>{'
  + 'var module={exports:{}};var exports=module.exports;'
  + 'Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});\n'
const wrapped = head + body + '\nreturn module.exports}});\n'

writeFileSync(target, wrapped)
console.log('wrap-client: lib/client.js wrapped (' + wrapped.length + ' bytes)')
