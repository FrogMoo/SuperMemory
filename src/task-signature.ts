/**
 * Task-level signature (R48).
 *
 * R45 的自动 skill 曾经以「连续出现了哪些工具」为主体特征，于是目录里堆满
 * `sm-flow-bash-bash-bash-…`：没有对象、没有参数、没有坑，只有一条工具序列。
 * R48 把识别的主体换成「做过的事」：
 *
 * 1. 任务文本（用户请求 / 派发任务）里的动词 + 对象；
 * 2. 真实工作碰过的文件族 / 目录族；
 * 3. 命令家族与关键参数（`pnpm git:sync`、`pnpm typecheck`、`git push`…）；
 * 4. 话题集 / 项目（由调用方作为上下文附加，不参与 key 的泛化）。
 *
 * 纯工具序列、只有 bash/pnpm 泛化命令、或没有任何可命名对象的样本一律返回
 * undefined —— 宁可不生成，也不生成壳子。本模块是 host-free 的纯函数，smoke
 * 可直接在 Node 类型剥离下运行。
 * @module supermemory/task-signature
 */

/** One observed task occurrence, recorded at turn end from the durable log. */
export interface TaskSample {
  tools: string[]
  args: Array<Record<string, unknown>>
  /** User request / dispatch task text (primary feature, never the tool list). */
  task?: string
  sessionId?: string
  dispatchId?: string
  topicSetId?: string
  at?: number
  /**
   * R50: true when every tool call in this sample completed without isError.
   * Only fully successful samples can justify an automatic entry draft (the
   * high-confidence rule requires exit 0 evidence).
   */
  ok?: boolean
}

/** Stable, human-readable description of one repeated TASK (not a flow). */
export interface TaskSignature {
  /** Stable aggregation key, e.g. `fix/skill-forge` (no tools involved). */
  key: string
  /** English verb slug (fix/add/refactor/...) used in the skill name. */
  verb: string
  /** Chinese verb used in the title/description. */
  verbZh: string
  /** Primary object slug, e.g. `skill-forge`, `gitee`. */
  object: string
  /** Up to three object slugs (primary first) that are worth routing on. */
  objects: string[]
  /** `fix-skill-forge` / `sync-gitee-github` — the kebab body of the name. */
  nameBase: string
  /** Human title, e.g. `修复 skill-forge`. */
  title: string
  files: string[]
  dirs: string[]
  /** Command families, e.g. `pnpm typecheck`, `git push`. */
  commands: string[]
  keywords: string[]
  hasTaskText: boolean
  /** 0..1; below TASK_SIGNATURE_MIN_CONFIDENCE the draft is dropped. */
  confidence: number
}

/** Minimum confidence for an auto-generated task skill. */
export const TASK_SIGNATURE_MIN_CONFIDENCE = 0.5

const MAX_FILES = 10
const MAX_COMMANDS = 8
const MAX_OBJECTS = 3

const TOOL_NAMES = new Set([
  'bash', 'read', 'write', 'edit', 'grep', 'glob', 'run_code', 'run-code', 'run',
  'tool', 'tools', 'todo_write', 'todo', 'skill', 'present', 'web_search', 'web_fetch',
  'memory_recall', 'memory_remember', 'memory_dispatch', 'memory_relay', 'memory_toolize',
  'memory_ui', 'memory_scan', 'memory_topicsets', 'memoryset', 'plugin_manager',
])

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'when', 'then', 'than', 'into',
  'over', 'under', 'about', 'after', 'before', 'while', 'where', 'which', 'what', 'who',
  'how', 'why', 'all', 'any', 'each', 'every', 'some', 'not', 'but', 'but', 'can', 'could',
  'should', 'would', 'will', 'must', 'need', 'needs', 'needed', 'use', 'used', 'using',
  'make', 'makes', 'made', 'get', 'gets', 'got', 'set', 'sets', 'run', 'runs', 'ran',
  'task', 'tasks', 'work', 'works', 'thing', 'things', 'case', 'cases', 'way', 'ways',
  'file', 'files', 'path', 'paths', 'line', 'lines', 'code', 'true', 'false', 'null',
  'http', 'https', 'json', 'stdio', 'stdout', 'stderr', 'exit', 'note', 'notes',
  'bash', 'shell', 'command', 'commands', 'cmd', 'pnpm', 'npm', 'yarn', 'node', 'git',
  'cd', 'ls', 'cat', 'sed', 'grep', 'awk', 'find', 'echo', 'head', 'tail', 'wc', 'mkdir',
  'src', 'lib', 'dist', 'build', 'docs', 'scripts', 'test', 'tests', 'index', 'main',
])

/** Names that can never be an object of a readable task skill. */
const GENERIC_OBJECTS = new Set([
  'bash', 'shell', 'command', 'commands', 'cmd', 'tool', 'tools', 'flow', 'seq', 'sequence',
  'run', 'code', 'run-code', 'read', 'write', 'edit', 'grep', 'glob', 'task', 'work',
  'file', 'files', 'path', 'paths', 'src', 'lib', 'dist', 'build', 'docs', 'scripts',
  'test', 'tests', 'index', 'main', 'package-json', 'tsconfig', 'readme',
  'changelog', 'license', 'install', 'dev', 'start', 'tmp', 'temp', 'output', 'assets',
])

/**
 * Action words are NOT objects: a task named 「修复 X」 must not become
 * `fix-fix-x`. These tokens are dropped from text-object candidates.
 */
const VERB_TOKENS = new Set([
  'fix', 'fixing', 'repair', 'debug', 'add', 'adding', 'implement', 'create', 'build',
  'refactor', 'restructure', 'rework', 'rewrite', 'migrate', 'cleanup', 'clean', 'archive',
  'remove', 'delete', 'release', 'publish', 'packageing', 'ship', 'sync', 'push',
  'pull', 'commit', 'rebase', 'verify', 'test', 'validate', 'smoke', 'check', 'review',
  'audit', 'inspect', 'merge', 'integrate', 'configure', 'config', 'enable', 'disable',
  'update', 'refresh', 'upgrade', 'bump', 'investigate', 'analyze', 'analyse', 'compare',
  'diff', 'diagnose', 'run', 'runs', 'build', 'built', 'use', 'using', 'make', 'change',
])

/**
 * Context/architecture words: useful for retrieval, but never the task's
 * object when a concrete domain noun exists (repo name, client/server half).
 */
const CONTEXT_OBJECT_NAMES = new Set(['supermemory', 'dsh-supermemory', '@frogmoo/dsh-supermemory', 'dsh', 'client', 'server', 'frontend', 'backend'])

const GENERIC_FILE_NAMES = new Set([
  'index', 'main', 'package', 'package-lock', 'pnpm-lock', 'tsconfig', 'readme', 'changelog',
  'license', 'vite', 'tsdown', 'vitest', 'eslint', 'prettier', 'config', 'types', 'type',
  'utils', 'util', 'helper', 'helpers', 'common', 'constants', 'consts', 'env', 'gitignore',
  'node_modules', 'dist', 'lib', 'src', 'scripts', 'test', 'tests', 'docs', 'build', 'out',
  'tmp', 'temp', 'output', 'assets', 'public', 'coverage', 'skill', 'skills', 'session',
])

/**
 * Chinese NOUNS → stable English object slugs (longest phrase wins).
 * Action words belong to VERB_RULES; keeping them out of this table is what
 * stops names like `release-release-pack`.
 */
const OBJECT_LEXICON: Array<[string, string]> = [
  ['发布资产', 'release-assets'],
  ['版本控制', 'version-control'],
  ['组合工具', 'composite'],
  ['固化能力', 'capability'],
  ['话题集', 'topicset'],
  ['工作区', 'workspace'],
  ['管理台', 'webui'],
  ['页签', 'tab'],
  ['标签', 'tag'],
  ['面板', 'panel'],
  ['记忆', 'memory'],
  ['版本', 'version'],
  ['分支', 'branch'],
  ['会话', 'session'],
  ['中枢', 'hub'],
  ['派发', 'dispatch'],
  ['技能', 'skill'],
  ['固化', 'toolize'],
  ['能力', 'capability'],
  ['检索', 'recall'],
  ['召回', 'recall'],
  ['注入', 'inject'],
  ['路由', 'route'],
  ['仓库', 'repo'],
  ['文档', 'docs'],
  ['脚本', 'script'],
  ['依赖', 'deps'],
  ['闸门', 'gate'],
  ['回归', 'regression'],
  ['设置', 'settings'],
  ['压缩包', 'package'],
  ['安装包', 'package'],
  ['包体', 'package'],
  ['双远端', 'dual-remote'],
]

/** Verb rules: first matching rule wins (specific before broad). */
const VERB_RULES: Array<{ re: RegExp; verb: string; zh: string }> = [
  { re: /重构|改造|重排|调整|迁移|切换|替换|改成|改为|改名|改/, verb: 'refactor', zh: '改造' },
  { re: /清理|归档|删除|移除|清掉|清空|干掉/, verb: 'cleanup', zh: '清理' },
  { re: /发布|发版|打包|出包|上传|发包/, verb: 'release', zh: '发布' },
  { re: /同步|推送|提交|双推|拉取|合并远端/, verb: 'sync', zh: '同步' },
  { re: /验证|测试|回归|闸门|跑闸门|自测/, verb: 'verify', zh: '验证' },
  { re: /审查|评审|审阅|检查|核对|复核/, verb: 'review', zh: '审查' },
  { re: /合并|整合|归并|汇总/, verb: 'merge', zh: '合并' },
  { re: /实现|新增|增加|添加|加入|加上|编写|开发|补上|补齐/, verb: 'add', zh: '实现' },
  { re: /修复|修正|修改|修|排查|诊断|定位|解决|处理|修掉|搞掉|搞定/, verb: 'fix', zh: '修复' },
  { re: /配置|设置|开启|关闭|打开|启用|停用/, verb: 'config', zh: '配置' },
  { re: /更新|刷新|升级|升版/, verb: 'update', zh: '更新' },
  { re: /说明|文档|记录|写文档/, verb: 'docs', zh: '说明' },
  { re: /调研|分析|确认|评估|比较|对比/, verb: 'investigate', zh: '调研' },
]

const ENGLISH_VERBS: Array<[RegExp, string, string]> = [
  [/\b(refactor|restructure|rework|rewrite|reorgani[sz]e|migrate|switch)\b/i, 'refactor', '改造'],
  [/\b(cleanup|clean-up|archive|remove|delete|prune|purge)\b/i, 'cleanup', '清理'],
  [/\b(release|publish|package|bundle|ship)\b/i, 'release', '发布'],
  [/\b(sync|push|pull|commit|rebase|merge-remote)\b/i, 'sync', '同步'],
  [/\b(verify|test|validate|smoke|check|gate)\b/i, 'verify', '验证'],
  [/\b(review|audit|inspect)\b/i, 'review', '审查'],
  [/\b(merge|integrate|consolidate)\b/i, 'merge', '合并'],
  [/\b(add|implement|create|build|introduce|support)\b/i, 'add', '实现'],
  [/\b(fix|repair|debug|diagnose|resolve|patch|correct)\b/i, 'fix', '修复'],
  [/\b(configure|config|setting|enable|disable|toggle)\b/i, 'config', '配置'],
  [/\b(update|refresh|upgrade|bump)\b/i, 'update', '更新'],
  [/\b(docs?|document|documentation|readme)\b/i, 'docs', '说明'],
  [/\b(investigate|analyze|analyse|compare|diff|diagnose)\b/i, 'investigate', '调研'],
]

const VERB_ZH: Record<string, string> = {
  fix: '修复', add: '实现', refactor: '改造', cleanup: '清理', release: '发布',
  sync: '同步', verify: '验证', review: '审查', merge: '合并', config: '配置',
  update: '更新', docs: '说明', investigate: '调研', build: '构建', work: '处理',
}

const WRAPPER_COMMANDS = new Set(['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh', 'wsl'])
const INSPECT_COMMANDS = new Set([
  'cd', 'ls', 'dir', 'cat', 'sed', 'awk', 'grep', 'rg', 'find', 'head', 'tail', 'wc',
  'which', 'where', 'pwd', 'echo', 'printf', 'env', 'export', 'set', 'test', 'true', 'false',
  'sleep', 'date', 'touch', 'stat', 'file', 'du', 'df', 'tree', 'type', 'more', 'less',
])
const GENERIC_SCRIPTS = new Set([
  'typecheck', 'build', 'smoke', 'test', 'tests', 'lint', 'format', 'install', 'dev',
  'start', 'clean', 'check', 'tsdown', 'tsc', 'vitest', 'prepare', 'prepublish', 'release:dry',
  'pack', 'release', 'publish', 'bundle', 'ship',
])

const WINDOWS_PATH_RE = /(?:[A-Za-z]:[\\/])[^\s'"`,;:)\]}]+/g
const FILE_PATH_RE = /(?:[\w.@+-]+[\\/])*[\w@.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh|ps1|html|css|scss|toml|lock|py|go|rs|java|kt|tgz|zip|svg|png|jpg)\b/gi
const POSIX_PATH_RE = /(?:^|[\s'"`(=])((?:\.{0,2}\/)[\w.@%+-]+(?:\/[\w.@%+-]+)+|[\w.@%+-]+\/[\w.@%+-]+(?:\/[\w.@%+-]+)*)/g
const ASCII_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*(?:[-_.:][A-Za-z0-9]+)*/g

/** Position of a needle in a text (9999 = not mentioned). */
function positionIn(text: string, needle: string): number {
  if (!text || !needle) return 9999
  const pos = text.toLowerCase().indexOf(needle.toLowerCase())
  return pos < 0 ? 9999 : pos
}

/** Trim and collapse whitespace. */
function clean(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Clip a label without splitting a surrogate pair (defensive). */
export function clipLabel(text: string, max = 100): string {
  const flat = clean(text)
  return flat.length <= max ? flat : flat.slice(0, Math.max(1, max - 1)) + '…'
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /(?:^|[^\w])(?:https?|ftp):\/\//i.test(value)
}

/** Normalize a path-looking string (posix separators, no quotes, no drive tail). */
export function normalizePathText(value: string): string {
  let out = clean(value).replace(/^['"`]+|['"`]+$/g, '')
  if (looksLikeUrl(out)) return ''
  out = out.replace(/\\/g, '/')
  out = out.replace(/#L\d+(-L?\d+)?$/i, '')
  out = out.replace(/^file:\/\//i, '')
  out = out.replace(/[),.;]+$/g, '')
  return out.trim()
}

function basenameOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function stemOf(file: string): string {
  return file.replace(/\.[a-z0-9]+$/i, '')
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('/')
}

function isGenericName(name: string): boolean {
  return GENERIC_FILE_NAMES.has(name.toLowerCase()) || name.length < 3
}

function slugify(text: string, max = 32): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
}

interface ScoredObject {
  slug: string
  score: number
  source: 'text' | 'file' | 'dir' | 'command'
  display: string
  /** Earliest occurrence in the task text (tie-break: the task's main topic). */
  pos: number
}

/** Every path-looking token in one text (task, command or argument). */
export function extractPathTokens(text: string): string[] {
  const raw = String(text ?? '')
  if (!raw) return []
  const out = new Set<string>()
  for (const match of raw.matchAll(WINDOWS_PATH_RE)) {
    const path = normalizePathText(match[0])
    if (path) out.add(path)
  }
  for (const match of raw.matchAll(FILE_PATH_RE)) {
    const path = normalizePathText(match[0])
    if (path && !looksLikeUrl(path)) out.add(path)
  }
  for (const match of raw.matchAll(POSIX_PATH_RE)) {
    const path = normalizePathText(match[1] ?? '')
    if (path && !looksLikeUrl(path) && path.includes('/')) out.add(path)
  }
  return [...out].slice(0, 40)
}

/** Command families observed in bash-like arguments. */
export function extractCommandFamilies(samples: TaskSample[]): { commands: string[]; objects: ScoredObject[] } {
  const commands = new Set<string>()
  const objects = new Map<string, ScoredObject>()
  const addObject = (slug: string, display: string, source: ScoredObject['source'], score: number): void => {
    const key = slug.toLowerCase()
    if (!key || GENERIC_OBJECTS.has(key) || VERB_TOKENS.has(key)) return
    const existing = objects.get(key)
    if (!existing || existing.score < score) objects.set(key, { slug: key, score, source, display, pos: 9999 })
  }
  for (const sample of samples) {
    sample.tools.forEach((tool, index) => {
      if (tool !== 'bash' && tool !== 'terminal' && tool !== 'shell') return
      const args = sample.args[index] ?? {}
      const command = typeof args.command === 'string' ? args.command : ''
      if (!command) return
      for (const family of commandFamiliesOf(command)) commands.add(family.family)
      for (const object of commandObjectsOf(command)) addObject(object.slug, object.display, 'command', object.score)
    })
  }
  return { commands: [...commands].slice(0, MAX_COMMANDS), objects: [...objects.values()] }
}

function stripCommandPrefix(segment: string): string {
  let out = segment.trim()
  out = out.replace(/^(?:sudo|time|env\s+[\w-]+=\S*)\s+/gi, '')
  out = out.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
  return out.trim()
}

/** Split one shell command into (normalized) simple command segments. */
function commandSegments(command: string): string[] {
  return String(command ?? '')
    .split(/&&|\|\||;|\n|\|/)
    .map((part) => stripCommandPrefix(part))
    .filter(Boolean)
}

interface CommandFamily {
  family: string
  object?: { slug: string; display: string; score: number }
}

function commandFamilyOf(segment: string): CommandFamily | undefined {
  const words = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^["']|["']$/g, '')) ?? []
  if (words.length === 0) return undefined
  const executable = basenameOf(words[0].replace(/\\\\/g, '/')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
  if (!executable) return undefined
  if (WRAPPER_COMMANDS.has(executable) || INSPECT_COMMANDS.has(executable)) return undefined
  if (executable === 'pnpm' || executable === 'npm' || executable === 'yarn' || executable === 'bun') {
    let script = words[1] ?? ''
    if (script === 'run' || script === 'exec' || script === 'dlx') script = words[2] ?? ''
    if (!script) return { family: executable }
    const slug = slugify(script.replace(/^:/, ''), 28)
    const generic = GENERIC_SCRIPTS.has(slug) || script.startsWith('-')
    return {
      family: executable + ' ' + script,
      ...(slug && !generic ? { object: { slug, display: script, score: 2 } } : {}),
    }
  }
  if (executable === 'node' || executable === 'tsx' || executable === 'ts-node') {
    const script = words.slice(1).find((word) => !word.startsWith('-')) ?? ''
    if (!script) return { family: executable }
    const file = basenameOf(script.replace(/\\\\/g, '/'))
    const name = stemOf(file)
    return {
      family: executable + ' ' + file,
      ...(name && !isGenericName(name) ? { object: { slug: slugify(name, 32), display: name, score: 2 } } : {}),
    }
  }
  if (executable === 'git') {
    const sub = words.slice(1).find((word) => !word.startsWith('-')) ?? ''
    if (!sub) return { family: 'git' }
    return { family: 'git ' + sub }
  }
  if (executable === 'gh') {
    const sub = words.slice(1).filter((word) => !word.startsWith('-')).slice(0, 2).join(' ')
    return { family: sub ? 'gh ' + sub : 'gh' }
  }
  return { family: executable }
}

function commandFamiliesOf(command: string): CommandFamily[] {
  return commandSegments(command).map((segment) => commandFamilyOf(segment)).filter((value): value is CommandFamily => Boolean(value))
}

function commandObjectsOf(command: string): ScoredObject[] {
  const out: ScoredObject[] = []
  for (const family of commandFamiliesOf(command)) {
    if (family.object) out.push({ slug: family.object.slug, score: family.object.score, source: 'command', display: family.object.display, pos: 9999 })
  }
  return out
}

/** Files/directories + object candidates from every recorded argument/command. */
export function extractFileFacts(samples: TaskSample[]): { files: string[]; dirs: string[]; objects: ScoredObject[] } {
  const files = new Set<string>()
  const dirs = new Set<string>()
  const objects = new Map<string, ScoredObject>()
  const addObject = (slug: string, display: string, source: ScoredObject['source'], score: number, pos = 9999): void => {
    const key = slug.toLowerCase()
    if (!key || GENERIC_OBJECTS.has(key) || VERB_TOKENS.has(key)) return
    const existing = objects.get(key)
    if (!existing || existing.score < score || (existing.score === score && pos < existing.pos)) {
      objects.set(key, { slug: key, score, source, display, pos: Math.min(existing?.pos ?? 9999, pos) })
    }
  }
  const considerPath = (raw: string, taskText = ''): void => {
    const path = normalizePathText(raw)
    if (!path || looksLikeUrl(path) || path.length > 240) return
    const absolute = isAbsolutePath(path)
    // Keep paths compact in the body: absolute workspace paths often add noise.
    const display = absolute ? basenameOf(path) : path
    if (/\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh|ps1|html|css|scss|toml|lock|py|go|rs|tgz|zip)$/i.test(path)) {
      files.add(display)
      const base = basenameOf(path)
      const name = stemOf(base).toLowerCase()
      const isArchive = /\.(?:tgz|zip|tar|gz|7z)$/i.test(path)
      // A build artifact like `package.tgz` names the packaged deliverable,
      // not the generic `package.json` config file.
      if (isArchive) addObject('package', stemOf(base), 'file', 3, positionIn(taskText, base))
      else if (!isGenericName(name)) addObject(slugify(name, 32), stemOf(base), 'file', 3, positionIn(taskText, base))
    }
    const parts = path.split('/').filter(Boolean)
    const dirParts = parts.filter((part) => !/^[A-Za-z]:$/.test(part)).slice(0, -1)
    for (const dir of dirParts.slice(-3)) {
      const lowered = dir.toLowerCase()
      if (isGenericName(lowered) || lowered.startsWith('.')) continue
      dirs.add(dir)
      addObject(slugify(dir, 28), dir, 'dir', 2, positionIn(taskText, dir))
    }
  }
  for (const sample of samples) {
    const taskText = sample.task ?? ''
    sample.tools.forEach((tool, index) => {
      const args = sample.args[index] ?? {}
      for (const key of ['file_path', 'path', 'cwd', 'directory', 'pattern', 'glob', 'description']) {
        const value = args[key]
        if (typeof value === 'string' && value.length > 0) {
          for (const token of extractPathTokens(value)) considerPath(token, taskText)
        }
      }
      if (typeof args.command === 'string') {
        for (const token of extractPathTokens(args.command)) considerPath(token, taskText)
      }
    })
    if (sample.task) {
      for (const token of extractPathTokens(sample.task)) considerPath(token, sample.task)
    }
  }
  return { files: [...files].slice(0, MAX_FILES), dirs: [...dirs].slice(0, 6), objects: [...objects.values()] }
}

/** Domain-noun objects from the task text (Chinese lexicon + ASCII identifiers). */
export function extractTextObjects(text: string): { objects: ScoredObject[]; keywords: string[] } {
  const raw = String(text ?? '')
  const objects = new Map<string, ScoredObject>()
  const keywords = new Set<string>()
  const add = (slug: string, display: string, score: number, pos: number): void => {
    const key = slug.toLowerCase()
    if (!key || GENERIC_OBJECTS.has(key) || STOP_WORDS.has(key) || VERB_TOKENS.has(key)) return
    const weight = CONTEXT_OBJECT_NAMES.has(key) ? Math.min(score, 1) : score
    const existing = objects.get(key)
    if (!existing || existing.score < weight || (existing.score === weight && pos < existing.pos)) {
      objects.set(key, { slug: key, score: weight, source: 'text', display, pos })
    }
    if (keywords.size < 12) keywords.add(display)
  }
  for (const [term, slug] of OBJECT_LEXICON) {
    const pos = raw.indexOf(term)
    // Domain nouns are a weaker signal than a concrete file/command object;
    // long compound nouns (发布资产) beat short ones on ties.
    if (pos >= 0) add(slug, slug, term.length >= 4 ? 3 : 2, pos)
  }
  for (const match of raw.matchAll(ASCII_TOKEN_RE)) {
    // `skill-forge.ts` names the object `skill-forge`, not `skill-forge-ts`.
    const token = match[0].replace(/\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh|ps1|html|css|scss|toml)$/i, '')
    if (token.length < 3 || token.length > 40) continue
    if (/^[rv]?\d+(?:\.\d+)*$/i.test(token)) continue
    const lowered = token.toLowerCase()
    if (STOP_WORDS.has(lowered) || TOOL_NAMES.has(lowered) || VERB_TOKENS.has(lowered)) continue
    const identifier = /[-_.:]/.test(token)
    const slug = slugify(token, 36)
    if (!slug) continue
    // Plain words score 2; identifier-shaped tokens (skill-forge) score 3.
    // Proper-noun capitalization is deliberately NOT boosted: repo/product
    // names otherwise outrank the actual task topic in long dispatch texts.
    add(slug, token, identifier ? 3 : 2, match.index ?? 9999)
  }
  return { objects: [...objects.values()], keywords: [...keywords] }
}

/**
 * Pick the verb from the EARLIEST match in the task text (ties go to the more
 * specific rule), then fall back to command/tool evidence. Earliest-match
 * matters: 「修X，改为Y」 is a fix task, not a refactor task.
 */
export function detectTaskVerb(text: string, tools: string[], commands: string[]): { verb: string; verbZh: string; fromText: boolean } | undefined {
  const raw = String(text ?? '')
  let best: { index: number; verb: string; zh: string; rank: number } | undefined
  VERB_RULES.forEach((rule, rank) => {
    const match = rule.re.exec(raw)
    if (!match || match.index < 0) return
    if (!best || match.index < best.index || (match.index === best.index && rank < best.rank)) {
      best = { index: match.index, verb: rule.verb, zh: rule.zh, rank }
    }
  })
  ENGLISH_VERBS.forEach(([re, verb, zh], rank) => {
    const match = re.exec(raw)
    if (!match || match.index < 0) return
    if (!best || match.index < best.index || (match.index === best.index && rank < best.rank)) {
      best = { index: match.index, verb, zh, rank }
    }
  })
  if (best !== undefined) return { verb: best.verb, verbZh: best.zh, fromText: true }
  const joined = commands.join(' ')
  if (/\bgit\s+(?:push|commit|rebase|fetch|pull)\b/.test(joined) || /git:sync/.test(joined)) return { verb: 'sync', verbZh: '同步', fromText: false }
  if (/\bpnpm\s+(?:build|tsdown)\b|\btsdown\b/.test(joined)) return { verb: 'build', verbZh: '构建', fromText: false }
  if (/\bpnpm\s+(?:typecheck|smoke|test|lint)\b|\btsc\b/.test(joined)) return { verb: 'verify', verbZh: '验证', fromText: false }
  if (/\b(?:tar|zip|7z|gzip)\b|\bgh release\b/.test(joined)) return { verb: 'release', verbZh: '发布', fromText: false }
  if (tools.some((tool) => tool === 'edit' || tool === 'write')) return { verb: 'fix', verbZh: '修复', fromText: false }
  if (tools.some((tool) => tool === 'read' || tool === 'grep' || tool === 'glob')) return { verb: 'review', verbZh: '审查', fromText: false }
  return undefined
}

function sortObjects(objects: ScoredObject[]): ScoredObject[] {
  // Score first, then the task's mention order (the main topic usually comes
  // first), then specificity/length.
  const byScore = [...objects].sort((left, right) =>
    right.score - left.score
    || left.pos - right.pos
    || right.slug.length - left.slug.length
    || left.slug.localeCompare(right.slug))
  const out: ScoredObject[] = []
  for (const candidate of byScore) {
    // Drop an object that is only a token-subset of a stronger one
    // (skill ⊂ skill-forge) so names do not repeat themselves.
    const covered = out.some((existing) =>
      existing.slug === candidate.slug
      || existing.slug.split('-').includes(candidate.slug)
      || candidate.slug.split('-').includes(existing.slug))
    if (!covered) out.push(candidate)
  }
  return out
}

/** Extract a stable task signature; undefined means "not worth a skill". */
/** First non-empty line, clipped: a dispatch/user request states its topic there. */
export function taskHeadline(task: string): string {
  const firstLine = String(task ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  return firstLine.slice(0, 180).trim()
}

export function extractTaskSignature(input: TaskSample): TaskSignature | undefined {
  const rawTask = String(input.task ?? '')
  const task = clean(rawTask)
  const tools = (input.tools ?? []).filter((tool) => typeof tool === 'string' && tool.length > 0)
  if (tools.length < 2) return undefined
  // Task text is the PRIMARY feature. Without it we cannot tell "做过的事"
  // apart, and falling back to the tool list is exactly the R45 regression.
  if (task.length < 6) return undefined
  const samples: TaskSample[] = [{ ...input, tools, args: input.args ?? [] }]
  // The headline must come from the RAW text: the first `clean()` collapses
  // newlines, which would turn a whole dispatch prompt into one "headline".
  const headline = taskHeadline(rawTask)
  const headlineText = extractTextObjects(headline)
  const fullText = extractTextObjects(task)
  // The headline anchors the task; a long dispatch prompt is mostly constraints
  // and must not let a file mentioned in passing become the skill's object.
  // If the headline only names context words (score 1), fall back to the full
  // text so a concrete object mentioned later still counts.
  const headlineSpecific = headlineText.objects.some((object) => object.score >= 2)
  const text = headlineSpecific ? headlineText : fullText
  const fileFacts = extractFileFacts(samples)
  const commandFacts = extractCommandFamilies(samples)
  let verb = detectTaskVerb(headline, tools, commandFacts.commands) ?? detectTaskVerb(task, tools, commandFacts.commands)
  if (!verb) return undefined
  const artifactFile = fileFacts.files.find((file) => /\.(?:tgz|zip|7z|tar\.gz)$/i.test(file))
  if (artifactFile && /release|发布|发版|打包|发包/i.test(task)) {
    verb = { verb: 'release', verbZh: '发布', fromText: true }
  }
  // The TASK TEXT anchors the signature. Files/commands are corroborating
  // evidence (and fallback only when the text names no object): otherwise a
  // turn that happens to touch another file would split one task into two
  // skills. This is the core of R48's "task-level, not tool-sequence" rule.
  const textObjects = sortObjects(text.objects).filter((object) => object.score >= 2)
  const evidenceObjects = sortObjects([...fileFacts.objects, ...commandFacts.objects]).filter((object) => object.score >= 2)
  const chosen = textObjects.length > 0 ? textObjects : evidenceObjects
  if (chosen.length === 0) return undefined
  let objects = chosen.slice(0, MAX_OBJECTS)
  // A release task names its DELIVERABLE: when a build artifact (package.tgz)
  // is present, the archive/format is the object, not an incidental noun.
  if (verb.verb === 'release' && artifactFile) {
    const ext = artifactFile.toLowerCase().endsWith('.tar.gz') ? 'tar-gz' : (artifactFile.toLowerCase().split('.').pop() ?? '')
    const artifactObjects: ScoredObject[] = [
      { slug: 'package', score: 3, source: 'file', display: 'package', pos: 9999 },
      ...(ext && /^[a-z0-9]{2,8}$/.test(ext) ? [{ slug: ext, score: 2, source: 'file' as const, display: ext, pos: 9999 }] : []),
    ]
    const artifactSlugs = new Set(artifactObjects.map((object) => object.slug))
    objects = [...artifactObjects, ...objects.filter((object) => !artifactSlugs.has(object.slug))].slice(0, MAX_OBJECTS)
  }
  const primary = objects[0]
  const dimensions = new Set<ScoredObject['source']>(objects.map((object) => object.source))
  // Corroboration from the recorded work (not just the wording) adds confidence.
  if (evidenceObjects.some((object) => object.slug.includes(primary.slug) || primary.slug.includes(object.slug))) dimensions.add('file')
  if (commandFacts.commands.length > 0) dimensions.add('command')
  let score = 0
  if (task.length >= 8) score += 2
  if (verb.fromText) score += 2
  score += Math.min(3, primary.score + (primary.score >= 3 ? 1 : 0))
  if (dimensions.size >= 2) score += 2
  if (commandFacts.commands.some(isVerificationCommand)) score += 1
  if (objects.length >= 2) score += 1
  const confidence = Math.min(1, score / 11)
  if (confidence < TASK_SIGNATURE_MIN_CONFIDENCE) return undefined
  const key = verb.verb + '/' + primary.slug
  const nameBase = [verb.verb, ...objects.slice(0, 2).map((object) => object.slug)].join('-')
  const title = verb.verbZh + ' ' + objects.slice(0, 2).map((object) => object.display).join(' / ')
  const keywords = [...new Set([...objects.map((object) => object.display), ...text.keywords])].slice(0, 8)
  return {
    key,
    verb: verb.verb,
    verbZh: verb.verbZh,
    object: primary.slug,
    objects: objects.map((object) => object.slug),
    nameBase,
    title,
    files: fileFacts.files,
    dirs: fileFacts.dirs,
    commands: commandFacts.commands,
    keywords,
    hasTaskText: true,
    confidence,
  }
}

/** Verification-flavoured command families (used by the body + confidence). */
export function isVerificationCommand(family: string): boolean {
  return /\b(?:pnpm|npm|yarn)\s+(?:typecheck|build|smoke|test|lint|check)\b|\btsc\b|\bvitest\b|\bnode\s+scripts\/[\w.-]*smoke/i.test(family)
}

/** Human title for one signature (kept for the panel/tests). */
export function taskTitle(signature: TaskSignature): string {
  return signature.title
}

/** True when the name only talks about a tool flow (defensive check). */
export function looksLikeToolFlowName(name: string): boolean {
  const lowered = String(name ?? '').toLowerCase()
  if (/^(?:sm-)?(?:ws[a-z0-9]{5}-)?flow(?:-|$)/.test(lowered)) return true
  return /(?:^|-)(?:bash|read|write|edit|grep|glob|run-code|run_code|tool)(?:-|$)/.test(lowered)
}

/** Token similarity of two skill names (0..1); used to drop near duplicates. */
export function taskNameSimilarity(left: string, right: string): number {
  const tokens = (name: string): Set<string> => {
    const parts = String(name ?? '').toLowerCase().split('-').filter(Boolean)
    const out = new Set<string>()
    for (const part of parts) {
      if (part === 'sm' || /^ws[a-z0-9]{5}$/.test(part)) continue
      out.add(part)
    }
    return out
  }
  const a = tokens(left)
  const b = tokens(right)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter += 1
  return inter / Math.max(a.size, b.size)
}
