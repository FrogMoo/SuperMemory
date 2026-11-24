#!/usr/bin/env node
// github-api-release.mjs — GitHub 半边网络阻断（github.com:443 不通、api.github.com 通）
// 时的补推工具：经 GitHub git/refs/releases API 把「本地单个已提交的提交」推到 GitHub，
// 并可顺手创建 tag + Release + 上传发布包资产。
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
//   - 令牌只从 GCM 读，不打印、不落盘。
//
// 用法：
//   node scripts/github-api-release.mjs <commit-ish> [--tag <vX.Y.Z> --notes <file> [--asset <path>]]
//   node scripts/github-api-release.mjs 4509e3c                                  # 只推提交
//   node scripts/github-api-release.mjs 4509e3c --tag v1.0.0 --notes notes.md    # 提交+tag+Release
//                                                                                 # 资产默认 release/dsh-supermemory-<版本>.zip
// 退出码：0 成功 / 1 失败（含任一 SHA 校验不符）。
// 背景与实测记录见 docs/git-sync.md §11。
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const REPO = 'FrogMoo/SuperMemory'
const API = 'https://api.github.com'
const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
const NL = String.fromCharCode(10)
const TAB = String.fromCharCode(9)
const NUL = String.fromCharCode(0)

const log = (...a) => console.log('[gh-api]', ...a)
const fail = (...a) => { console.error('[gh-api] FATAL:', ...a); process.exit(1) }

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const commitish = argv[0]
if (!commitish || commitish.startsWith('--')) fail('用法: node scripts/github-api-release.mjs <commit-ish> [--tag <vX.Y.Z> --notes <file> [--asset <path>]]')
function argValue(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const tagName = argValue('--tag')
const notesFile = argValue('--notes')
let assetPath = argValue('--asset')
if (tagName && !notesFile) fail('--tag 需要同时给 --notes <release 正文文件>')
if (tagName && !assetPath) {
  assetPath = 'release/dsh-supermemory-' + tagName.replace(/^v/, '') + '.zip'
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

const commit = git('git rev-parse ' + commitish).trim()
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
    sha: git('git rev-parse ' + tagName).trim(),
    message: afterBlank(tagRaw),
    tagger: identWithDate(tagger),
  }
  const tagTarget = git('git rev-parse ' + tagName + '^{commit}').trim()
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

// ---------- 5. tag + Release + 资产（可选） ----------
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
    log('Release 已存在，复用:', release.html_url)
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
  const assets = await api('GET', '/repos/' + REPO + '/releases/' + release.id + '/assets')
  for (const a of assets) {
    if (a.name === assetPath.split('/').pop()) {
      await api('DELETE', '/repos/' + REPO + '/releases/' + release.id + '/assets/' + a.id)
      log('删除旧资产', a.name)
    }
  }
  const zip = readFileSync(ROOT + '/' + assetPath)
  const uploadUrl = release.upload_url.replace('{?name,label}', '?name=' + assetPath.split('/').pop())
  const assetRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+Json',
      'Content-Type': 'application/zip',
      'User-Agent': 'sm-github-api-release',
    },
    body: zip,
  })
  const assetJson = await assetRes.json()
  if (!assetRes.ok) fail('资产上传失败 ' + assetRes.status + ' ' + JSON.stringify(assetJson).slice(0, 400))
  log('资产已上传:', assetJson.name, (assetJson.size / 1024 / 1024).toFixed(2) + 'MB state=' + assetJson.state)
  log('完成。Release:', release.html_url)
} else {
  log('完成（仅提交快进，未建 tag/Release）')
}
