#!/usr/bin/env node
// package-release.mjs — 制作面向用户的预构建发布包（自包含 zip）。
//
// 产物：release/dsh-supermemory-<version>.zip
//   内含：lib/（预构建产物）+ node_modules/（hoisted 生产依赖，解压即用、无需外网）
//         + package.json / cordis.patch.yml / scripts/install-into-dsh.mjs
//         + README.md / CHANGELOG.md / INSTALL.md / .npmrc
//
// 用法：
//   node scripts/package-release.mjs            # 按 package.json version 打包
//   node scripts/package-release.mjs --skip-install   # 跳过依赖安装（复用已有 staging）
// 前置：先 pnpm build 刷新 lib/（本脚本不构建）。
// 退出码：0 成功 / 1 失败。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, symlink, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const bundleName = 'dsh-supermemory-' + version
const releaseDir = join(root, 'release')
const stageDir = join(releaseDir, bundleName)
const zipPath = join(releaseDir, bundleName + '.zip')

const skipInstall = process.argv.includes('--skip-install')
const log = (...a) => console.log('[package-release]', ...a)
const fail = (...a) => { console.error('[package-release] ERROR:', ...a); process.exit(1) }

// ---------- 1. 前置检查 ----------
for (const f of ['lib/supermemory.js', 'lib/client.js', 'cordis.patch.yml', 'scripts/install-into-dsh.mjs', 'README.md', 'CHANGELOG.md', 'INSTALL.md']) {
  if (!existsSync(join(root, f))) fail('缺少文件: ' + f + '（先 pnpm build？）')
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
for (const doc of ['README.md', 'CHANGELOG.md', 'INSTALL.md']) {
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

// ---------- 6. 摘要 ----------
const buf = readFileSync(artifact)
const sha256 = createHash('sha256').update(buf).digest('hex')
const files = countFiles(stageDir)
log('')
log('完成：', artifact)
log('  体积: ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB')
log('  文件数: ' + files)
log('  sha256: ' + sha256)
log('  安装方式: 解压 -> 进入目录 -> node scripts/install-into-dsh.mjs -> 重启 DSH')

function countFiles(dir) {
  let n = 0
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) n += countFiles(p)
    else n++
  }
  return n
}
