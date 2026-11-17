#!/usr/bin/env node
// git-sync-push.mjs — 跨 shell 定位 bash，并把参数 / 退出码透传给 scripts/git-sync-push.sh
// 用途: 让 pnpm git:sync 在 Windows cmd / PowerShell 下也能跑（本机 PATH 只有 Git\cmd，没有 bash）。
// 用法: node scripts/git-sync-push.mjs [-n|--dry-run] [-r|--remote <name>] [-b|--branch <name>]
//       pnpm git:sync -- --dry-run    (pnpm 下参数必须用 -- 分隔)
// 退出码: 透传 bash 脚本（0 成功 / 1 失败 / 2 工作区脏 / 3 参数错误）；找不到 bash 时为 1。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isWin = process.platform === 'win32'
const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const scriptPath = path.join(repoRoot, 'scripts', 'git-sync-push.sh')
const toPosix = (p) => p.replace(/\\/g, '/')

function runnable(cmd) {
  if (!cmd) return null
  const probe = spawnSync(cmd, ['-c', 'exit 0'], { stdio: 'ignore' })
  return !probe.error && probe.status === 0 ? cmd : null
}

function fromWhere(bin) {
  const r = spawnSync('where', [bin], { encoding: 'utf8' })
  if (r.error || r.status !== 0 || !r.stdout) return []
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

const candidates = []
if (process.env.SM_BASH) candidates.push(process.env.SM_BASH)
candidates.push('bash')
if (!isWin) candidates.push('sh')
if (isWin) {
  candidates.push(...fromWhere('bash'))
  for (const gitExe of fromWhere('git')) {
    candidates.push(path.join(path.dirname(path.dirname(gitExe)), 'bin', 'bash.exe'))
  }
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA
  candidates.push(
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
  )
  if (local) candidates.push(path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'))
}

let bash = null
for (const c of candidates) {
  bash = runnable(c)
  if (bash) break
}

if (!bash) {
  console.error('ERROR: 找不到 bash，无法运行 scripts/git-sync-push.sh。')
  console.error('       请安装 Git for Windows（自带 bash），或把 bash.exe 所在目录加入 PATH，')
  console.error('       或设置环境变量 SM_BASH 指向 bash.exe 的绝对路径。')
  process.exit(1)
}

if (!existsSync(scriptPath)) {
  console.error('ERROR: 找不到脚本 ' + toPosix(scriptPath))
  process.exit(1)
}

const res = spawnSync(bash, [toPosix(scriptPath), ...process.argv.slice(2)], { stdio: 'inherit' })

if (res.error) {
  console.error('ERROR: 启动 bash 失败: ' + res.error.message)
  process.exit(1)
}
if (res.signal) {
  console.error('ERROR: bash 被信号 ' + res.signal + ' 终止')
  process.exit(1)
}
process.exit(res.status === null ? 1 : res.status)
