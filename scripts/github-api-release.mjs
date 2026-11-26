#!/usr/bin/env node
// github-api-release.mjs — GitHub 半边网络阻断（github.com:443 不通、api.github.com 通）
// 时的补推工具：经 GitHub git/refs/releases API 把「本地单个已提交的提交」推到 GitHub，
// 并可创建附注 tag + Release。
//
// 发布资产策略（R58 起）：
//   默认 **source-only**：只快进 main、建附注 tag、创建/复用 Release 元数据，
//   不上传任何自建资产。GitHub 会按 tag 自动生成 Source code (zip) 与
//   Source code (tar.gz) 两个源码归档——这两个包不是 DSH 可安装的插件包。
//   需要旧行为（上传 release/dsh-supermemory-<版本>.zip/.tgz 与稳定别名）时，
//   显式加 --with-assets（内网/离线镜像等逃生口；公开 Release 不要用）。
//
// 适用前提（缺一不可，否则脚本拒绝执行）：
//   1) GitHub 侧 main 恰好等于该提交的父提交（单提交快进；多提交落后时请逐个提交跑，
//      或等 github.com 恢复后走 pnpm git:sync）；
//   2) GCM 里有 github.com 凭据（Windows 凭据存储，用户名 FrogMoo）。
//
// 安全模型：
//   - 只快进（force:false），绝不 force；
//   - blob/tree/commit/tag object 的 SHA 逐级与本地比对，任一不一致即中止，
//     且在校验通过前不写任何 ref——保证 GitHub 与本地仓库永不产生分叉；
//   - 令牌只从 GCM 读，不打印、不落盘；
//   - source-only 模式不删除、不替换 Release 上已有的自建资产。
//
// 用法：
//   node scripts/github-api-release.mjs <commit-ish> [--tag <vX.Y.Z> --notes <file>]
//   node scripts/github-api-release.mjs 4509e3c                                  # 只推提交
//   node scripts/github-api-release.mjs 4509e3c --tag v1.0.0 --notes notes.md    # 提交+tag+Release（默认 source-only）
//   node scripts/github-api-release.mjs 4509e3c --tag v1.0.0 --notes notes.md --with-assets [--asset <path>]...
//                                                                                 # 旧行为：上传 zip/tgz/稳定别名
//   node scripts/github-api-release.mjs --plan --tag v1.3.5                       # 离线打印发布计划（不触网/不读令牌）
//   node scripts/github-api-release.mjs --self-check --tag v1.3.1                 # 离线自检（不触网/不读令牌）
// 说明：发布流程与校验见 docs/release.md；GitHub Release 只保留自动生成的源码归档。
// 退出码：0 成功 / 1 失败（含任一 SHA 校验不符、参数冲突）。
// 背景与实测记录见 docs/git-sync.md §11。
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const REPO = 'FrogMoo/SuperMemory'
const API = 'https://api.github.com'
const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
const NL = String.fromCharCode(10)
const TAB = String.fromCharCode(9)
const NUL = String.fromCharCode(0)

// argv-array git helpers: execFileSync never spawns a shell, so '^' in X^{commit}
// (and '~' in HEAD~2) reaches git literally even under Windows cmd.exe. R51
// recorded the bug this replaces: execSync('git rev-parse ' + tag + '^{commit}')
// ran via cmd.exe, which ate the caret -> rev-parse saw "<tag>{commit}" ->
// "ambiguous argument". Same for user-supplied commit-ish values below.
const gitArgs = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
/** Peel any commit-ish (branch/tag/annotated tag/HEAD~1) to a commit SHA, shell-free. */
const resolveCommit = (ref) => gitArgs(['rev-parse', '--verify', ref + '^{commit}'])

const log = (...a) => console.log('[gh-api]', ...a)
const fail = (...a) => { console.error('[gh-api] FATAL:', ...a); process.exit(1) }

// ---------- 参数 ----------
const argv = process.argv.slice(2)
// Offline self-check mode: proves the tag / commit-ish resolution path works on
// this host without shell quoting (the R51 bug: cmd.exe ate '^' in X^{commit}).
const selfCheckMode = argv.includes('--self-check') || argv.includes('--dry-run')
// Offline plan mode: prints what the real run WOULD do (commit / tag / assets)
// without touching the network or the GCM token. R58 uses its output in
// core-smoke to pin "default = source-only, no asset upload".
const planMode = argv.includes('--plan')
// R58: public Releases are source-only (GitHub generates Source code zip/tar.gz).
// --with-assets is the explicit escape hatch that restores the old three-asset
// upload behavior for an internal/offline mirror.
const withAssets = argv.includes('--with-assets')
const commitish = argv[0]
function argValue(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const tagName = argValue('--tag')
const notesFile = argValue('--notes')
const explicitAssets = []
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i] !== '--asset') continue
  const value = argv[i + 1]
  if (!value || value.startsWith('--')) fail('--asset 需要一个资产路径')
  explicitAssets.push(value)
  i += 1
}

if (planMode) { printPlan(); process.exit(0) }
if (selfCheckMode) { selfCheck(tagName); process.exit(0) }
if (!commitish || commitish.startsWith('--')) fail('用法: node scripts/github-api-release.mjs <commit-ish> [--tag <vX.Y.Z> --notes <file>] [--with-assets [--asset <path>]...]')
if (tagName && !notesFile) fail('--tag 需要同时给 --notes <release 正文文件>')
if (withAssets && !tagName) fail('--with-assets 需要同时给 --tag <vX.Y.Z>（资产只随 Release 上传）')
if (explicitAssets.length > 0 && !withAssets) fail('--asset 需要同时给 --with-assets（默认 source-only，不上传自建资产）')

const releaseAssets = plannedAssetPaths().map((path) => ({ path, file: resolve(ROOT, path), name: basename(path) }))
for (const asset of releaseAssets) {
  if (!existsSync(asset.file)) fail('资产不存在: ' + asset.file + '（先跑 node scripts/package-release.mjs；该脚本产物仅用于本地/离线安装）')
}

// ---------- 令牌（GCM，不打印） ----------
const cred = execSync('git credential fill', {
  input: 'protocol=https' + NL + 'host=github.com' + NL + NL,
  encoding: 'utf8',
})
const token = cred.split(NL).map((l) => l.trim()).filter((l) => l.startsWith('password=')).map((l) => l.slice(9))[0]
if (!token) fail('GCM 无 github.com 凭据')

async function api(method, path, body) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+Json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sm-github-api-release',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* raw */ }
  if (!res.ok) fail(method + ' ' + path + ' -> ' + res.status + ' ' + text.slice(0, 500))
  return json
}

// ---------- 本地元数据（全部来自 git 原生命令，避开 % 日期格式的管线差异） ----------
const git = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' })
/** Bytes of one object, no shell quoting (paths may contain spaces/non-ASCII). */
const gitBuf = (args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
function afterBlank(text) {
  const i = text.indexOf(NL + NL)
  return i < 0 ? text : text.slice(i + 2)
}
function parseIdent(line) {
  const gt = line.lastIndexOf('>')
  const who = line.slice(line.indexOf(' ') + 1, gt + 1)
  const lt = who.indexOf('<')
  const rest = line.slice(gt + 2).trim().split(' ')
  return { name: who.slice(0, lt).trim(), email: who.slice(lt + 1, who.length - 1), epoch: rest[0], tz: rest[1] }
}
function isoFromGitDate(epochSec, tz) {
  const d = new Date(Number(epochSec) * 1000)
  const sign = tz[0] === '-' ? -1 : 1
  const oh = Number(tz.slice(1, 3)), om = Number(tz.slice(3, 5))
  const s = new Date(d.getTime() + sign * (oh * 60 + om) * 60000)
  const p = (n) => String(n).padStart(2, '0')
  const tzColon = tz.slice(0, 3) + ':' + tz.slice(3)
  return s.getUTCFullYear() + '-' + p(s.getUTCMonth() + 1) + '-' + p(s.getUTCDate()) + 'T'
    + p(s.getUTCHours()) + ':' + p(s.getUTCMinutes()) + ':' + p(s.getUTCSeconds()) + tzColon
}
function identWithDate(id) { return { name: id.name, email: id.email, date: isoFromGitDate(id.epoch, id.tz) } }

const commit = resolveCommit(commitish)
const commitRaw = git('git cat-file commit ' + commit)
const local = {
  commit,
  tree: git('git rev-parse ' + commit + ':').trim() || git('git log -1 --format=%T ' + commit).trim(),
  parent: git('git log -1 --format=%P ' + commit).trim(),
  message: afterBlank(commitRaw),
  author: identWithDate(parseIdent(commitRaw.split(NL).find((l) => l.startsWith('author ')))),
  committer: identWithDate(parseIdent(commitRaw.split(NL).find((l) => l.startsWith('committer ')))),
}
if (local.parent.indexOf(' ') >= 0) fail('该提交是合并提交（多父），本工具不支持')
log('本地提交', local.commit, 'tree', local.tree, '父', local.parent)

let tag = null
if (tagName) {
  const tagRaw = git('git cat-file tag ' + tagName)
  const tagger = parseIdent(tagRaw.split(NL).find((l) => l.startsWith('tagger ')))
  tag = {
    name: tagName,
    sha: gitArgs(['rev-parse', '--verify', tagName]),
    message: afterBlank(tagRaw),
    tagger: identWithDate(tagger),
  }
  const tagTarget = resolveCommit(tagName)
  if (tagTarget !== local.commit) fail('tag ' + tagName + ' 指向 ' + tagTarget + '，与要推送的提交 ' + local.commit + ' 不一致')
  log('本地 tag', tag.sha, '->', tagTarget)
}

// ---------- 1. GitHub main 必须恰好是父提交（单提交快进） ----------
const ghMain = await api('GET', '/repos/' + REPO + '/git/refs/heads/main')
log('GitHub main =', ghMain.object.sha)
if (ghMain.object.sha !== local.parent) {
  fail('GitHub main (' + ghMain.object.sha + ') 不是该提交的父提交 (' + local.parent + ')：'
    + '多提交落后时请逐个提交跑本脚本，或等 github.com 恢复后走 pnpm git:sync')
}

// ---------- 2. 变更文件 -> blob（SHA 逐个校验） ----------
const baseTree = (await api('GET', '/repos/' + REPO + '/git/commits/' + local.parent)).tree.sha
// -z: NUL-separated, unquoted paths (a non-ASCII filename used to arrive as a
// quoted octal string and quietly create a junk path upstream). Renames must
// DELETE the old path too — base_tree otherwise keeps it and the tree diverges.
const modeMap = new Map()
for (const entry of execFileSync('git', ['ls-tree', '-r', '-z', local.commit], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split(NUL).filter(Boolean)) {
  const tab = entry.indexOf(TAB)
  if (tab < 0) continue
  modeMap.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[0])
}
const diffRaw = git('git diff --name-status -z -M ' + local.parent + ' ' + local.commit)
const tokens = diffRaw.split(NUL).filter((t) => t.length > 0)
const changes = []
for (let i = 0; i < tokens.length;) {
  const status = tokens[i++]
  if (status.startsWith('R') || status.startsWith('C')) {
    const from = tokens[i++]
    const to = tokens[i++]
    changes.push({ status, from, to })
  } else {
    changes.push({ status, path: tokens[i++] })
  }
}
const tree = []
const addBlob = async (path) => {
  // Read the COMMITTED bytes (never the worktree): a CRLF/checkout difference
  // would otherwise produce a valid blob whose SHA is not the tree's.
  const content = gitBuf(['cat-file', 'blob', local.commit + ':' + path])
  const blob = await api('POST', '/repos/' + REPO + '/git/blobs', { content: content.toString('base64'), encoding: 'base64' })
  const localBlobSha = createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + content.length + NUL, 'utf8'), content])).digest('hex')
  if (blob.sha !== localBlobSha) fail('blob SHA 不一致: ' + path)
  const mode = modeMap.get(path) || '100644'
  tree.push({ path, mode, type: 'blob', sha: blob.sha })
  log('  blob ok', path, blob.sha.slice(0, 10), (content.length / 1024).toFixed(1) + 'kB')
}
for (const change of changes) {
  if (change.status.startsWith('D')) {
    tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
    log('  del', change.path)
    continue
  }
  if (change.status.startsWith('R')) {
    tree.push({ path: change.from, mode: '100644', type: 'blob', sha: null })
    log('  del', change.from, '(renamed)')
    await addBlob(change.to)
    continue
  }
  await addBlob(change.path)
}

// ---------- 3. tree / commit（SHA 与本地一致才继续） ----------
const newTree = await api('POST', '/repos/' + REPO + '/git/trees', { base_tree: baseTree, tree })
log('新 tree =', newTree.sha, newTree.sha === local.tree ? '(与本地一致)' : '(与本地不一致!)')
if (newTree.sha !== local.tree) fail('tree SHA 不一致，中止（未写任何 ref）')
const newCommit = await api('POST', '/repos/' + REPO + '/git/commits', {
  message: local.message, tree: newTree.sha, parents: [local.parent],
  author: local.author, committer: local.committer,
})
log('新 commit =', newCommit.sha, newCommit.sha === local.commit ? '(与本地一致)' : '(与本地不一致!)')
if (newCommit.sha !== local.commit) fail('commit SHA 不一致，中止（未写任何 ref）')

// ---------- 4. 快进 main ----------
await api('PATCH', '/repos/' + REPO + '/git/refs/heads/main', { sha: newCommit.sha, force: false })
log('main 已快进到', newCommit.sha)

// ---------- 5. tag + Release（默认 source-only；--with-assets 才传资产） ----------
if (tag) {
  const tagObj = await api('POST', '/repos/' + REPO + '/git/tags', {
    tag: tag.name, message: tag.message, object: newCommit.sha, type: 'commit', tagger: tag.tagger,
  })
  log('tag 对象 =', tagObj.sha, tagObj.sha === tag.sha ? '(与本地一致)' : '(与本地不一致!)')
  if (tagObj.sha !== tag.sha) fail('tag 对象 SHA 不一致，中止（main 已快进，未建 Release）')
  await api('POST', '/repos/' + REPO + '/git/refs', { ref: 'refs/tags/' + tag.name, sha: tagObj.sha })
  log('refs/tags/' + tag.name + ' 已创建')

  const existing = await api('GET', '/repos/' + REPO + '/releases')
  let release = existing.find((r) => r.tag_name === tag.name)
  if (release) {
    log('Release 已存在，复用（不更新正文/标题）:', release.html_url)
  } else {
    release = await api('POST', '/repos/' + REPO + '/releases', {
      tag_name: tag.name,
      name: tag.name + ' — SuperMemory Release',
      body: readFileSync(notesFile, 'utf8'),
      draft: false,
      prerelease: false,
    })
    log('Release 已创建:', release.html_url)
  }
  const existingAssets = await api('GET', '/repos/' + REPO + '/releases/' + release.id + '/assets')
  if (releaseAssets.length === 0) {
    // Default policy (R58): create/reuse only Release metadata. GitHub serves
    // the auto-generated Source code (zip / tar.gz) archives; nothing here is
    // deleted or replaced, so old releases keep their historical assets.
    if (existingAssets.length > 0) {
      log('source-only：该 Release 已有 ' + existingAssets.length + ' 个自建资产，本模式不删除也不替换')
    }
    log('source-only：未上传自建资产；Release 只保留 GitHub 自动生成的 Source code (zip/tar.gz)')
  } else {
    log('with-assets：显式开启旧上传行为，准备上传 ' + releaseAssets.length + ' 个自建资产')
    const uploading = new Set(releaseAssets.map((asset) => asset.name))
    for (const a of existingAssets) {
      if (uploading.has(a.name)) {
        await api('DELETE', '/repos/' + REPO + '/releases/' + release.id + '/assets/' + a.id)
        log('删除旧资产', a.name)
      }
    }
    for (const asset of releaseAssets) {
      const content = readFileSync(asset.file)
      const contentType = /\.(?:tgz|tar\.gz)$/i.test(asset.name) ? 'application/gzip' : 'application/zip'
      const uploadUrl = release.upload_url.replace('{?name,label}', '?name=' + encodeURIComponent(asset.name))
      const assetRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+Json',
          'Content-Type': contentType,
          'User-Agent': 'sm-github-api-release',
        },
        body: content,
      })
      const assetJson = await assetRes.json()
      if (!assetRes.ok) fail('资产上传失败 ' + asset.name + ' ' + assetRes.status + ' ' + JSON.stringify(assetJson).slice(0, 400))
      log('资产已上传:', assetJson.name, (assetJson.size / 1024 / 1024).toFixed(2) + 'MB state=' + assetJson.state)
    }
  }
  log('完成。Release:', release.html_url)
} else {
  log('完成（仅提交快进，未建 tag/Release）')
}

/**
 * The legacy three-asset list: manual zip, versioned npm tarball, and the
 * version-less alias. Only used when --with-assets is passed explicitly.
 */
function defaultAssetPaths(tag) {
  const base = 'release/dsh-supermemory-' + tag.replace(/^v/, '')
  return [base + '.zip', base + '.tgz', resolve(ROOT, 'release', 'dsh-supermemory.tgz')]
}

/** Assets the real run WOULD upload: none unless --with-assets is explicit. */
function plannedAssetPaths() {
  if (!tagName || !withAssets) return []
  return explicitAssets.length > 0 ? explicitAssets : defaultAssetPaths(tagName)
}

/** Offline plan output (no network, no GCM token); pinned by R58 tests. */
function printPlan() {
  const commitLabel = commitish && !commitish.startsWith('--') ? commitish : '(未指定；真实执行时必需)'
  log('plan（离线；不触网、不读令牌）:')
  log('  commit-ish =', commitLabel)
  log('  tag        =', tagName || '(无：只快进 main)')
  log('  notes      =', notesFile || '(无)')
  if (!tagName) {
    log('  release    = commit-only（不建 tag/Release）')
    log('  assets     = none')
  } else if (!withAssets) {
    log('  release    = source-only（默认；只建/复用 Release 元数据，不上传自建资产）')
    log('  assets     = none')
  } else {
    log('  release    = with-assets（显式逃生口：旧行为，上传自建资产）')
    log('  assets     = ' + plannedAssetPaths().map((path) => basename(path)).join(', '))
  }
  log('  提示       = Release 只保留 GitHub 自动生成的 Source code 源码归档；本地包见 docs/release.md')
}

/**
 * Offline self-check for the release-critical tag/commit resolution path.
 * Runs no network call and never reads the GCM token; exits non-zero on any
 * mismatch so it can guard the final push in a cmd.exe or bash shell alike.
 */
function selfCheck(tag) {
  if (!tag) fail('--self-check 需要 --tag <vX.Y.Z>（离线校验附注 tag 与提交解析）')
  const objectType = gitArgs(['cat-file', '-t', tag])
  if (objectType !== 'tag') fail('--self-check: ' + tag + ' 的对象类型是 ' + objectType + '（需要附注 tag，不是轻量标签）')
  const tagObject = gitArgs(['rev-parse', '--verify', tag])
  const viaPeel = resolveCommit(tag)
  const viaTilde = gitArgs(['rev-parse', '--verify', tag + '~0'])
  if (viaPeel !== viaTilde) fail('--self-check: ^{commit} 与 ~0 解析不一致: ' + viaPeel + ' vs ' + viaTilde)
  const head = gitArgs(['rev-parse', '--verify', 'HEAD'])
  let ancestor = true
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', viaPeel, 'HEAD'], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    ancestor = false
  }
  const commitsAfter = Number(gitArgs(['rev-list', '--count', viaPeel + '..HEAD']))
  const subject = gitArgs(['for-each-ref', '--format=%(subject)', 'refs/tags/' + tag])
  log('self-check tag     :', tag, '(annotated object ' + tagObject.slice(0, 10) + ')')
  log('self-check target  :', viaPeel)
  log('self-check resolve : ^{commit} == ~0 == ' + viaPeel.slice(0, 10) + ' (argv array, no shell)')
  log('self-check head    :', head.slice(0, 10), 'tag-is-ancestor=' + ancestor, 'commits-after-tag=' + commitsAfter)
  log('self-check subject :', subject)
  log('self-check PASS（离线；未触网、未读 GCM 令牌；cmd.exe 的 ^ 转义已由 argv 数组绕过）')
  if (!ancestor) log('注意：tag 目标不是 HEAD 的祖先（校验历史 tag 时属正常）')
}

