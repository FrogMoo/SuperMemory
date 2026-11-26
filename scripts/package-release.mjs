#!/usr/bin/env node
// package-release.mjs — 制作**本地**安装/离线分发产物（不随 Release 发布）。
//
// 重要（R58 起）：GitHub Release 只保留 GitHub 自动生成的 Source code (zip/tar.gz)；
// 本脚本产出的自建包不再上传到 Release。它们只服务于：
//   - 本机/内网手动安装（zip 解压后跑 scripts/install-into-dsh.mjs）；
//   - 本机/内网 DSH 插件面板安装（.tgz 绝对路径）。
//
// 产物（release/）：
//   1. dsh-supermemory-<version>.zip — 手动安装包（自包含：lib/ + node_modules/
//      + package.json / cordis.patch.yml / scripts/install-into-dsh.mjs + 文档）；
//   2. dsh-supermemory-<version>.tgz — npm-pack 结构（package/ 根），面板可装；
//   3. dsh-supermemory.tgz — 稳定别名（保留给本地脚本/旧流程；不会再上传，
//      因此 /releases/latest/download/dsh-supermemory.tgz 从下一个发布版本起会 404）。
//
// 用法：
//   node scripts/package-release.mjs                    # 两份都做
//   node scripts/package-release.mjs --skip-install     # 跳过依赖安装（复用已有 staging）
//   node scripts/package-release.mjs --tarball-only     # 只做/校验 .tgz，不碰 zip
//   node scripts/package-release.mjs --tarball-only --out <dir>   # 输出到别处
//   node scripts/package-release.mjs --plan             # 只打印计划（不写盘）
// 前置：先 pnpm build 刷新 lib/（本脚本不构建）。
// 退出码：0 成功 / 1 失败。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, symlink, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const bundleName = 'dsh-supermemory-' + version
const outIndex = process.argv.indexOf('--out')
const releaseDir = outIndex >= 0 && process.argv[outIndex + 1] !== undefined
  ? resolve(process.argv[outIndex + 1])
  : join(root, 'release')
const stageDir = join(releaseDir, bundleName)
const zipPath = join(releaseDir, bundleName + '.zip')

const skipInstall = process.argv.includes('--skip-install')
// Only (re)build the panel tarball: no staging, no zip, no dependency install.
// Used to validate an existing build without touching the manual release zip.
const tarballOnly = process.argv.includes('--tarball-only')
// Offline plan: print the three local artifact paths and the "not published"
// notice without writing anything. R58 tests pin the notice text through this.
const planMode = process.argv.includes('--plan')
const log = (...a) => console.log('[package-release]', ...a)
const fail = (...a) => { console.error('[package-release] ERROR:', ...a); process.exit(1) }

if (planMode) {
  log('plan（离线；不写盘）:')
  log('  zip   =', zipPath)
  log('  tgz   =', join(releaseDir, bundleName + '.tgz'))
  log('  alias =', join(releaseDir, 'dsh-supermemory.tgz'))
  localOnlyNotice()
  process.exit(0)
}

// ---------- 1. 前置检查 ----------
for (const f of ['lib/supermemory.js', 'lib/client.js', 'cordis.patch.yml', 'scripts/install-into-dsh.mjs', 'README.md', 'CHANGELOG.md', 'INSTALL.md', 'LICENSE']) {
  if (!existsSync(join(root, f))) fail('缺少文件: ' + f + '（先 pnpm build？）')
}
if (tarballOnly) {
  const panel = packPanelTarball()
  log('仅 tarball 模式完成：', panel.tgzPath)
  log('  体积: ' + (panel.bytes.length / 1024).toFixed(1) + ' kB')
  log('  sha256: ' + panel.sha256)
  log('  稳定别名：', panel.stableTgzPath)
  localOnlyNotice()
  process.exit(0)
}
if (existsSync(join(stageDir, 'node_modules')) && !skipInstall) {
  log('清理旧 staging:', stageDir)
  rmSync(stageDir, { recursive: true, force: true })
}
mkdirSync(stageDir, { recursive: true })

// ---------- 2. 收集文件 ----------
log('staging:', stageDir)
cpSync(join(root, 'package.json'), join(stageDir, 'package.json'))
cpSync(join(root, 'cordis.patch.yml'), join(stageDir, 'cordis.patch.yml'))
cpSync(join(root, 'lib'), join(stageDir, 'lib'), { recursive: true })
mkdirSync(join(stageDir, 'scripts'), { recursive: true })
cpSync(join(root, 'scripts/install-into-dsh.mjs'), join(stageDir, 'scripts/install-into-dsh.mjs'))
for (const doc of ['README.md', 'CHANGELOG.md', 'INSTALL.md', 'LICENSE']) {
  cpSync(join(root, doc), join(stageDir, doc))
}
// staging 专用 .npmrc：hoisted 平铺 + 不自动装 peer（宿主包由 DSH profile 提供，公共 registry 上没有）
writeFileSync(join(stageDir, '.npmrc'), 'node-linker=hoisted\nauto-install-peers=false\n')

// ---------- 3. 安装生产依赖（hoisted 平铺，便于整体打包/跨机拷贝） ----------
if (skipInstall) {
  log('--skip-install：跳过依赖安装')
  if (!existsSync(join(stageDir, 'node_modules'))) fail('staging 无 node_modules 且跳过了安装')
} else {
  log('安装生产依赖（pnpm install --prod，hoisted）…')
  const r = spawnSync('pnpm', ['install', '--prod', '--prefer-offline', '--config.node-linker=hoisted', '--config.auto-install-peers=false'], {
    cwd: stageDir, stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (r.error || r.status !== 0) fail('pnpm install 失败（检查 registry 可达性）')
}

// ---------- 4. 校验依赖可解析 + 去符号链接（zip 不含链接） ----------
const resolveCheck = spawnSync(process.execPath, ['-e', "console.log(require.resolve('@deepseek-ai/schemastery'))"], { cwd: stageDir, encoding: 'utf8' })
if (resolveCheck.status !== 0) fail('schemastery 解析失败:\n' + resolveCheck.stderr)
log('schemastery ->', resolveCheck.stdout.trim())
const nmDir = join(stageDir, 'node_modules')
let dereferenced = 0
;(function deref(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) {
      // 用链接目标内容替换链接本身（保持解压后自包含）
      const tmp = p + '.deref-tmp'
      cpSync(p, tmp, { recursive: true, dereference: true })
      unlinkSync(p)
      cpSync(tmp, p, { recursive: true })
      rmSync(tmp, { recursive: true, force: true })
      dereferenced++
    } else if (st.isDirectory()) {
      deref(p)
    }
  }
})(nmDir)
log('去符号链接:', dereferenced, '个')

// ---------- 5. 打包 zip（PowerShell Compress-Archive，失败回退 tar.gz） ----------
// The zip is for the manual "unzip -> install-into-dsh.mjs" path only. It is
// NOT installable from the DSH plugin panel: the host accepts a git repository
// or a .tgz/.tar.gz tarball, never a .zip release asset.
rmSync(zipPath, { force: true })
let artifact = zipPath
const ps = spawnSync('powershell.exe', [
  '-NoProfile', '-Command',
  "Compress-Archive -Path '" + stageDir + "' -DestinationPath '" + zipPath + "' -Force",
], { encoding: 'utf8' })
if (ps.error || ps.status !== 0) {
  log('Compress-Archive 失败，回退 tar.gz：', (ps.stderr || ps.error || '').toString().slice(0, 300))
  artifact = join(releaseDir, bundleName + '.tar.gz')
  rmSync(artifact, { force: true })
  const tar = spawnSync('tar', ['-czf', artifact, '-C', releaseDir, bundleName], { encoding: 'utf8' })
  if (tar.error || tar.status !== 0) fail('tar 打包也失败：' + (tar.stderr || tar.error))
}
if (!existsSync(artifact)) fail('产物不存在: ' + artifact)

// ---------- 5b. npm 安装包 .tgz（本地/内网插件面板安装用） ----------
// The DSH plugin manager (0.2.2-rc.5) parses an install spec as a registry
// package, a git repository, or a .tgz/.tar.gz URL/path. A GitHub release page
// and a .zip asset are both refused before pnpm runs. R58 stops publishing
// this tarball on Releases, but the npm-pack shape is still what a local panel
// install consumes, so it stays a local artifact.
const panel = packPanelTarball()
const tgzPath = panel.tgzPath
const stableTgzPath = panel.stableTgzPath

// ---------- 6. 摘要 ----------
const buf = readFileSync(artifact)
const sha256 = createHash('sha256').update(buf).digest('hex')
const tgz = panel.bytes
const tgzSha = panel.sha256
const files = countFiles(stageDir)
log('')
log('完成：', artifact)
log('  体积: ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB')
log('  文件数: ' + files)
log('  sha256: ' + sha256)
log('完成：', tgzPath)
log('  体积: ' + (tgz.length / 1024).toFixed(1) + ' kB')
log('  sha256: ' + tgzSha)
log('稳定别名：', stableTgzPath, '（本地保留；不再上传，/releases/latest/download/dsh-supermemory.tgz 从下个版本起 404）')
log('  安装方式（手动）: 解压 zip -> 进入目录 -> node scripts/install-into-dsh.mjs -> 重启 DSH')
log('  安装方式（插件面板）: 填本机 .tgz 绝对路径；Release 页 URL / Source code 归档 / .zip 资产都不被宿主接受')
localOnlyNotice()

/**
 * Build and validate the npm-pack tarball the DSH plugin panel installs.
 * @returns The versioned tarball, its stable alias, bytes and digest.
 */
function packPanelTarball() {
  mkdirSync(releaseDir, { recursive: true })
  const tgzPath = join(releaseDir, bundleName + '.tgz')
  rmSync(tgzPath, { force: true })
  log('生成插件面板安装包（pnpm pack -> npm tarball）…')
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', releaseDir], {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (packed.error || packed.status !== 0) fail('pnpm pack 失败（本地插件面板安装需要 .tgz）')
  if (!existsSync(tgzPath)) fail('pnpm pack 未产出 ' + tgzPath + '（检查 package.json 的 version/files）')
  // cwd + basename avoids GNU tar reading a Windows drive letter as a remote host.
  const listing = spawnSync('tar', ['-tzf', basename(tgzPath)], { cwd: releaseDir, encoding: 'utf8' })
  if (listing.error || listing.status !== 0) {
    fail('无法校验 .tgz 目录结构：' + String(listing.stderr || listing.error).slice(0, 300))
  }
  const entries = new Set(String(listing.stdout).split(/\r?\n/).filter(Boolean))
  for (const required of ['package/package.json', 'package/lib/supermemory.js', 'package/lib/client.js', 'package/cordis.patch.yml']) {
    if (!entries.has(required)) fail('.tgz 缺少 ' + required + '（npm tarball 必须以 package/ 为根）')
  }
  const badEntry = [...entries].find((entry) => entry.includes(String.fromCharCode(92)))
  if (badEntry !== undefined) fail('.tgz 含反斜杠路径（跨平台解压会坏）：' + badEntry)
  // Version-less alias kept for local scripts / legacy instructions. R58 no
  // longer uploads it, so the old /releases/latest/download/dsh-supermemory.tgz
  // URL intentionally stops resolving from the next release onward.
  const stableTgzPath = join(releaseDir, 'dsh-supermemory.tgz')
  cpSync(tgzPath, stableTgzPath)
  const bytes = readFileSync(tgzPath)
  return { tgzPath, stableTgzPath, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** The R58 contract: these artifacts are local-only, never Release assets. */
function localOnlyNotice() {
  log('注意：以上产物仅用于本地/离线安装，不随 Release 发布。')
  log('      Release 只提供 GitHub 自动生成的 Source code (zip/tar.gz)；源码归档不是可安装插件包。')
}

function countFiles(dir) {
  let n = 0
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) n += countFiles(p)
    else n++
  }
  return n
}
