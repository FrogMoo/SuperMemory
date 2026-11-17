#!/usr/bin/env node
// install-into-dsh.mjs — 把本插件规范化安装为 DSH desktop profile 的 bundle。
//
// 为什么需要这个脚本：
//   DSH 侧边栏「插件」页只列【profile 依赖 + dsh.profile.bundles 激活态】
//   （@deepseek-ai/dsh-plugin-manager 的 readBundles 实时读 profile/package.json）。
//   早期用过的「cordis.patch.yml 路径行 insert」加载方式插件页【不显示】——
//   插件在跑但页面上看不到，无法启用/禁用/移除。本脚本把安装改成官方 bundle 形态：
//     1) profile package.json 增加依赖 "dsh-supermemory": "link:<本工作区>"
//     2) dsh.profile.bundles 追加 "dsh-supermemory"（激活）
//     3) 清理 profile cordis.patch.yml 里指向本插件入口的路径行 insert（防止重复注册）
//     4) pnpm install 建立符号链接（工作区成为 HMR 监视根，改源码→tsdown→热替换）
//   之后无论工作区搬到哪里，重跑一次本脚本即可保证插件页一定能看到它。
//
// 用法:
//   node scripts/install-into-dsh.mjs [--profile <name>] [--dry-run]
//   pnpm install:dsh
// 环境变量: DSH_HOME（默认 ~/.dsh）、DSH_PROFILE（默认 desktop，--profile 优先）
// 退出码: 0 成功 / 1 失败
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isWin = process.platform === 'win32'
const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const pluginRoot = repoRoot.replace(/[\\/]+$/, '')
const pluginRootPosix = pluginRoot.replace(/\\/g, '/')
const pkgName = 'dsh-supermemory'
const entryId = 'supermemory'

const args = process.argv.slice(2)
let profile = process.env.DSH_PROFILE || 'desktop'
let dryRun = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile' && args[i + 1]) profile = args[++i]
  else if (args[i] === '--dry-run') dryRun = true
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 21).join('\n'))
    process.exit(0)
  } else {
    console.error('ERROR: 未知参数 ' + args[i] + '（支持 --profile <name> / --dry-run）')
    process.exit(1)
  }
}

const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)
const profilePkg = path.join(profileDir, 'package.json')
const profilePatch = path.join(profileDir, 'cordis.patch.yml')

const log = (...a) => console.log(...a)
const fail = (...a) => { console.error('ERROR:', ...a); process.exit(1) }

// ---------- 1. 前置检查 ----------
log('[1/6] 前置检查')
log('      插件根目录: ' + pluginRoot)
log('      profile:   ' + profileDir)
const pluginPkgPath = path.join(pluginRoot, 'package.json')
if (!existsSync(pluginPkgPath)) fail('找不到插件 package.json（脚本应位于插件仓库的 scripts/ 下）')
const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, 'utf8'))
if (pluginPkg.name !== pkgName) fail('package.json name 应为 ' + pkgName + '，实际为 ' + pluginPkg.name)
if (!pluginPkg.dsh || !pluginPkg.dsh.bundle || !pluginPkg.dsh.bundle.patch) fail('package.json 缺少 dsh.bundle.patch —— 插件页不会把它当 bundle 列目')
if (!existsSync(path.join(pluginRoot, pluginPkg.dsh.bundle.patch))) fail('bundle patch 文件不存在: ' + pluginPkg.dsh.bundle.patch)
if (!pluginPkg.main || !existsSync(path.join(pluginRoot, pluginPkg.main))) fail('入口不存在: ' + pluginPkg.main + '（先 pnpm build）')
if (pluginPkg.exports && pluginPkg.exports['./client'] && !existsSync(path.join(pluginRoot, pluginPkg.exports['./client'].replace(/^\.\//, '')))) {
  fail('客户端入口不存在: ' + pluginPkg.exports['./client'] + '（先 pnpm build:client）')
}
if (!pluginPkg.engines || !pluginPkg.engines.dsh) log('      WARN: package.json 未声明 engines.dsh，建议补上（如 ">=0.2.0 <0.3.0"）')
if (!existsSync(profilePkg)) fail('profile 未初始化: ' + profilePkg + '\n      请先打开一次 DSH Desktop 完成初始化，再重跑本脚本')

// ---------- 2. 备份 ----------
log('[2/6] 备份 profile 文件')
const stamp = new Date().toISOString().replace(/[:T]/g, '').slice(0, 15)
if (dryRun) {
  log('      --dry-run：跳过备份与写入')
} else {
  copyFileSync(profilePkg, profilePkg + '.bak-' + stamp + '-bundle-install')
  if (existsSync(profilePatch)) copyFileSync(profilePatch, profilePatch + '.bak-' + stamp + '-bundle-install')
  log('      已备份: package.json.bak-' + stamp + '-bundle-install')
}

// ---------- 3. profile package.json：依赖 + bundles ----------
log('[3/6] 写入 profile package.json（依赖 + bundles 激活）')
const manifest = JSON.parse(readFileSync(profilePkg, 'utf8'))
manifest.dependencies = manifest.dependencies || {}
const linkSpec = 'link:' + pluginRootPosix
const prevSpec = manifest.dependencies[pkgName]
if (prevSpec !== linkSpec) {
  log('      依赖: ' + pkgName + ' ' + (prevSpec ? prevSpec + ' -> ' + linkSpec : '(新增) ' + linkSpec))
  if (!dryRun) manifest.dependencies[pkgName] = linkSpec
} else {
  log('      依赖: ' + pkgName + ' = ' + linkSpec + '（已是最新，跳过）')
}
const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
if (!bundles.includes(pkgName)) {
  log('      bundles: 追加 ' + pkgName + '（激活态）')
  if (!dryRun) {
    manifest.dsh = manifest.dsh || {}
    manifest.dsh.profile = manifest.dsh.profile || {}
    manifest.dsh.profile.bundles = bundles.concat([pkgName])
  }
} else {
  log('      bundles: 已包含 ' + pkgName + '（跳过）')
}
if (!dryRun) writeFileSync(profilePkg, JSON.stringify(manifest, null, 2) + '\n')

// ---------- 4. profile cordis.patch.yml：清理路径行 insert ----------
log('[4/6] 清理 profile cordis.patch.yml 的路径行 insert（防重复注册）')
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const entryFileRe = new RegExp('name:\\s*[\'"]?' + escapeRegExp(pluginRootPosix) + '/lib/' + path.basename(pluginPkg.main) + '[\'"]?\\s*$')
const entryIdRe = new RegExp('id:\\s*[\'"]?' + escapeRegExp(entryId) + '[\'"]?\\s*$')
function stripPluginInsert(text) {
  const src = text.split('\n')
  const out = []
  let removed = 0
  let i = 0
  while (i < src.length) {
    if (/^- insert:\s*$/.test(src[i])) {
      let j = i + 1
      while (j < src.length && !/^- /.test(src[j])) j++
      const block = src.slice(i, j)
      const isPluginRow = block.some((l) => entryFileRe.test(l.trim()) || entryIdRe.test(l.trim()))
      if (isPluginRow) {
        while (out.length && /^\s*#/.test(out[out.length - 1])) out.pop()
        while (out.length && out[out.length - 1].trim() === '') out.pop()
        removed++
        i = j
        continue
      }
    }
    out.push(src[i])
    i++
  }
  return { text: out.join('\n').replace(/\n+$/, '\n'), removed: removed }
}
if (existsSync(profilePatch)) {
  const before = readFileSync(profilePatch, 'utf8')
  const res = stripPluginInsert(before)
  if (res.removed > 0) {
    log('      移除 ' + res.removed + ' 个指向本插件入口的 insert 行块')
    if (!dryRun) writeFileSync(profilePatch, res.text)
  } else {
    log('      未发现路径行 insert（无需清理）')
  }
} else {
  log('      profile 无 cordis.patch.yml（跳过）')
}

// ---------- 5. pnpm install ----------
log('[5/6] pnpm install（建立 link 符号链接）')
if (dryRun) {
  log('      --dry-run：跳过 pnpm install')
} else {
  // 优先用 node 直接跑 pnpm 的 JS 入口（避开 Windows 上 .cmd 必须 shell:true 的弃用告警）；
  // 找不到入口时退回 shell 调用 PATH 上的 pnpm。
  const npmGlobal = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm') : null
  const directCandidates = []
  if (npmGlobal && existsSync(path.join(npmGlobal, 'pnpm.exe'))) directCandidates.push({ cmd: path.join(npmGlobal, 'pnpm.exe'), pre: [] })
  if (npmGlobal && existsSync(path.join(npmGlobal, 'bin', 'pnpm.mjs'))) directCandidates.push({ cmd: process.execPath, pre: [path.join(npmGlobal, 'bin', 'pnpm.mjs')] })
  let done = false
  for (const c of directCandidates) {
    const r = spawnSync(c.cmd, c.pre.concat(['install', '--prefer-offline']), { cwd: profileDir, stdio: 'inherit' })
    if (!r.error && r.status === 0) { done = true; break }
  }
  if (!done) {
    const r = spawnSync(isWin ? 'pnpm.cmd' : 'pnpm', ['install', '--prefer-offline'], { cwd: profileDir, stdio: 'inherit', shell: true })
    done = !r.error && r.status === 0
  }
  if (!done) fail('pnpm install 失败；请确认 pnpm 在 PATH 中，或手动在 profile 目录执行 pnpm install')
}

// ---------- 6. 验证 ----------
log('[6/6] 验证')
const checks = []
const linkDir = path.join(profileDir, 'node_modules', pkgName)
checks.push(['node_modules 符号链接/目录存在', existsSync(linkDir)])
let installedOk = false
try {
  const j = JSON.parse(readFileSync(path.join(linkDir, 'package.json'), 'utf8'))
  installedOk = j.name === pkgName && !!j.dsh && !!j.dsh.bundle && !!j.dsh.bundle.patch && existsSync(path.join(linkDir, j.dsh.bundle.patch))
} catch (e) { /* 保持 false */ }
checks.push(['链接目标可读且声明 dsh.bundle.patch', installedOk])
const finalManifest = JSON.parse(readFileSync(profilePkg, 'utf8'))
checks.push(['profile 依赖含 ' + pkgName, finalManifest.dependencies && finalManifest.dependencies[pkgName] === linkSpec])
checks.push(['bundles 激活含 ' + pkgName, !!(finalManifest.dsh && finalManifest.dsh.profile && finalManifest.dsh.profile.bundles && finalManifest.dsh.profile.bundles.includes(pkgName))])
let patchClean = true
if (existsSync(profilePatch)) {
  const t = readFileSync(profilePatch, 'utf8')
  patchClean = !entryFileRe.test(t) && !new RegExp('id:\\s*[\'"]?' + escapeRegExp(entryId) + '[\'"]?').test(t)
}
checks.push(['profile patch 无残留路径行', patchClean])
let allOk = true
for (const c of checks) {
  log('      ' + (c[1] ? 'PASS' : 'FAIL') + '  ' + c[0])
  if (!c[1]) allOk = false
}
if (!allOk) fail('验证未通过（详见上方 FAIL 项）')

log('')
log('完成。插件页生效方式：')
log('  1. 刷新 DSH GUI，「侧边栏 → 插件」页应出现 ' + pkgName + '（列目为实时读盘，无需重启即可见）。')
log('  2. 重启 DSH Desktop 后 loader 才真正加载该 bundle（客户端 bundle 图也仅在启动时构建）。')
log('  3. 开发回路：改 src → pnpm build → 宿主热替换；不生效时在插件页禁用→启用，或重启。')
