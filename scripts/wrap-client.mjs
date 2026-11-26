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

// The loader id is the package name (scoped or not): DSH's clientModules keys
// `window.__DSH_BOOT__` and the /plugins/<id>/client.js URL by the manifest name,
// so a hard-coded id would break the moment package.json is renamed.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const moduleId = String(manifest.name)
const head = 'window.__ModuleLoader__.load({id:' + JSON.stringify(moduleId) + ',factory:require=>{'
const prologue = 'var module={exports:{}};var exports=module.exports;'
  + 'Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});\n'

if (raw.includes('__ModuleLoader__.load')) {
  if (raw.startsWith(head)) {
    console.log('wrap-client: already wrapped for ' + moduleId + ', skipping')
    process.exit(0)
  }
  console.log('wrap-client: re-wrapping (existing wrapper was not for ' + moduleId + ')')
}

const body = raw.replace(/\s*\/\/# sourceMappingURL=[^\n]*\s*$/, '')
const wrapped = head + prologue + body + '\nreturn module.exports}});\n'

writeFileSync(target, wrapped)
console.log('wrap-client: lib/client.js wrapped for ' + moduleId + ' (' + wrapped.length + ' bytes)')
