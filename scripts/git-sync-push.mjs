#!/usr/bin/env node
// git-sync-push.mjs — 跨 shell 定位 bash，并把参数 / 退出码透传给 scripts/git-sync-push.sh
// 用途: 让 pnpm git:sync 在 Windows cmd / PowerShell 下也能跑（本机 PATH 只有 Git\cmd，没有 bash）。
// 用法: node scripts/git-sync-push.mjs [-n|--dry-run] [-r|--remote <name>] [-b|--branch <name>]
//       pnpm git:sync -- --dry-run    (pnpm 下参数必须用 -- 分隔)
// 退出码: 透传 bash 脚本（0 成功 / 1 失败 / 2 工作区脏 / 3 参数错误）；找不到 bash 时为 1。
//
// R27 修复（exit 127 的真实根因）: Windows 上 PATH 里的裸 `bash` 往往先命中
// C:\Windows\System32\bash.exe —— 那是 **WSL 启动器**，不是 Git for Windows 的 bash。
// 它看不懂 `F:/10-SuperMemory/...` 这种 Windows 路径，于是把脚本路径原样交给 WSL 的
// /bin/bash，得到
//     /bin/bash: F:/10-SuperMemory/scripts/git-sync-push.sh: No such file or directory
// pnpm 再把 127 透传出来（能力「运行（预演）」因此永远失败，与 node/pnpm 是否在
// PATH 里无关——宿主 PATH 其实同时含有 nodejs 与 %APPDATA%\npm）。
// 现在的选法: 先自带绝对路径的 Git for Windows bash（由 where git / ProgramFiles /
// LOCALAPPDATA 推导，不硬编码盘符），并用「这个 bash 能不能看见脚本文件」实际验证；
// 明确排除 WSL 启动器；只有非 Windows 才用裸 `bash` / `sh`。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const isWin = process.platform === 'win32'
const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const scriptPath = path.join(repoRoot, 'scripts', 'git-sync-push.sh')
const toPosix = (p) => p.replace(/\\/g, '/')

/**
 * WSL 的 bash.exe（`%SystemRoot%\System32\bash.exe`）只是 WSL 启动器：它理解的是
 * Linux 路径，拿到 Windows 盘符路径会报 "No such file or directory"（127）。
 * 判断按「目录等于 <SystemRoot>\System32」而不是写死 C:\Windows。
 */
export function isWslBash(candidate, env = process.env) {
  if (!isWin || !candidate) return false
  const value = String(candidate).trim()
  if (!value) return false
  const base = path.basename(value).toLowerCase()
  if (base !== 'bash.exe' && base !== 'bash') return false
  // 裸命令（PATH 解析出来的）交给 resolveBashPath 处理；这里只判定绝对路径。
  if (!path.isAbsolute(value)) return false
  const sysRoot = String(env.SystemRoot || env.SYSTEMROOT || 'C:\\WINDOWS').replace(/[\\/]+$/, '')
  return path.dirname(path.resolve(value)).toLowerCase() === path.join(sysRoot, 'system32').toLowerCase()
}

/** `where <bin>` 的全部命中（Windows），失败返回空数组。 */
export function whereAll(bin, env = process.env) {
  const r = spawnSync('where', [bin], { encoding: 'utf8', env, windowsHide: true })
  if (r.error || r.status !== 0 || !r.stdout) return []
  return String(r.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

/**
 * bash 候选列表（按优先级）:
 *   1. SM_BASH（显式指定，若指向 WSL 启动器也保留在首位——用户显式要求优先）
 *   2. Git for Windows 自带的 bash（由 where git / ProgramFiles / LOCALAPPDATA 推导）
 *   3. 非 Windows: sh / bash
 *   4. Windows 最后兜底: where bash 的命中，**排除 WSL 启动器**
 */
export function bashCandidates(env = process.env) {
  const list = []
  const push = (value) => {
    if (!value) return
    const v = String(value)
    if (!list.some((entry) => entry.toLowerCase() === v.toLowerCase())) list.push(v)
  }
  if (env.SM_BASH) push(env.SM_BASH)
  if (isWin) {
    const programFiles = env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    for (const gitExe of whereAll('git', env)) {
      // C:\...\Git\cmd\git.exe -> C:\...\Git\bin\bash.exe
      push(path.join(path.dirname(path.dirname(gitExe)), 'bin', 'bash.exe'))
    }
    push(path.join(programFiles, 'Git', 'bin', 'bash.exe'))
    push(path.join(programFilesX86, 'Git', 'bin', 'bash.exe'))
    if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
    for (const hit of whereAll('bash', env)) {
      if (!isWslBash(hit, env)) push(hit)
    }
  } else {
    push('sh')
    push('bash')
  }
  return list
}

/** 这个 bash 是否可用：能跑 `-c 'exit 0'`，并且**确实看得见**目标脚本文件。 */
export function usableBash(candidate, target = scriptPath, env = process.env) {
  if (!candidate) return false
  const probe = spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore', env, windowsHide: true })
  if (probe.error || probe.status !== 0) return false
  const visible = spawnSync(
    candidate,
    ['-c', `test -f '${toPosix(target).replace(/'/g, "'\\''")}'`],
    { stdio: 'ignore', env, windowsHide: true },
  )
  return !visible.error && visible.status === 0
}

/** 选出第一个可用的 bash；找不到返回 null。 */
export function findBash(env = process.env, target = scriptPath) {
  for (const candidate of bashCandidates(env)) {
    if (usableBash(candidate, target, env)) return candidate
  }
  return null
}

function main() {
  const bash = findBash()

  if (!bash) {
    console.error('ERROR: 找不到可用的 bash（能看见 ' + toPosix(scriptPath) + ' 的那种）。')
    console.error('       注意 %SystemRoot%\\System32\\bash.exe 是 WSL 启动器，看不懂 Windows 路径，已被排除。')
    console.error('       请安装 Git for Windows（自带 bash），或把 Git 的 bin 目录加入 PATH，')
    console.error('       或设置环境变量 SM_BASH 指向 Git for Windows 的 bash.exe 绝对路径。')
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
}

// 只有被直接执行时才跑主流程：capability-smoke 会 import 上面的纯函数做断言。
const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
})()
if (invokedDirectly) main()
