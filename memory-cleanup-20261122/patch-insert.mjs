// Edit the desktop profile patch's supermemory insert block atomically.
//   node patch-insert.mjs remove        — drop the insert block (plugin unloads)
//   node patch-insert.mjs arm <url>     — (re)add the insert block pointing at <url>
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PATCH = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const mode = process.argv[2]
const url = process.argv[3]

const lines = readFileSync(PATCH, 'utf8').split('\n')
const out = []
let i = 0
let removed = 0
while (i < lines.length) {
  const line = lines[i].replace(/\r$/, '')
  if (line === '- insert:' && i + 2 < lines.length && lines[i + 1].includes('supermemory')) {
    // also drop a directly preceding dev-load comment line
    if (out.length > 0 && out[out.length - 1].startsWith('# SuperMemory dev load')) out.pop()
    i += 3
    removed++
    continue
  }
  out.push(lines[i])
  i++
}

if (mode === 'remove') {
  if (removed === 0) { console.log('no supermemory insert found (already removed?)'); process.exit(0) }
  const text = out.join('\n')
  const tmp = PATCH + '.tmp-r29'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, PATCH)
  console.log(`removed ${removed} supermemory insert block(s); patch updated atomically`)
} else if (mode === 'arm') {
  if (!url) { console.error('usage: node patch-insert.mjs arm <module-url>'); process.exit(1) }
  let text = out.join('\n')
  if (!text.endsWith('\n')) text += '\n'
  text += `\n# SuperMemory dev load (unique module URL per build; see scripts/dev-load.sh)\n- insert:\n    - id: supermemory\n      name: '${url}'\n`
  const tmp = PATCH + '.tmp-r29'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, PATCH)
  console.log(`armed supermemory -> ${url} (atomic)`)
} else {
  console.error('usage: node patch-insert.mjs [remove|arm <url>]')
  process.exit(1)
}
