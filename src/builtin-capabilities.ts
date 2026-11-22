/**
 * 内置能力（builtin capabilities）：随插件源码一起分发的固化能力定义。
 *
 * 背景（2026-11-18）：git-sync 能力原先由中枢在插件重载后经 memory_toolize
 * register 手工录入——清库或全新安装后插件不带这个能力，定义也只存在于
 * store 里、不随代码维护。内置能力把定义收进源码：rebuildComposites 启动
 * 重建时与 store 合并（缺失→播种、旧版→升级、现场更新→保留），能力定义从此
 * 随插件代码一起被维护（改入口/文档/路由描述 = 改这个文件 + version+1）。
 *
 * 合并/升级策略（mergeBuiltinCapabilities，src/composite.ts）：
 * - store 缺失        → 播种（落库 + 注册），版本 = 内置版本；
 * - store 版本 < 内置  → 升级：用内置定义覆盖 entry/doc/scope/routeNote/
 *                       dryRunArg/writeConfirm/runnable/title/description/tags，
 *                       保留 useCount/usage 与 workspaceKey。理由：内置定义随
 *                       插件代码和文档一起发布，旧版本定义本身就是「文档与现状
 *                       不符」的故障形态；唯一有意的本地修改路径是
 *                       memory_toolize register，它会 version+1 超过内置版本，
 *                       因此版本旧于内置的行不可能是认真的本地编辑——覆盖可恢复
 *                       受管行为，且不丢任何使用数据；
 * - store 版本 >= 内置 → 保留现场（本地维护中的版本，或更新版插件已播种）。
 *
 * 维护方式：新增内置能力 = 往 BUILTIN_CAPABILITIES 加一条（version: 1）；
 * 修改现有能力 = 改定义 + version+1 + changelog 追加一行（最新在前）。
 * @module supermemory/builtin-capabilities
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapabilityInput } from './composite.ts'

/**
 * 从插件自身位置推导出**本仓库根目录**。
 *
 * 为什么需要它：内置能力的 scope 原先写成绝对路径（'G:\09 - dsh\SuperMemory'），
 * 换机器/换克隆目录后该目录不存在——能力对当前工作区不生效、健康报告持续报
 * 「适用范围目录不存在」。scope 的正确含义是「入口命令的执行目录」，也就是本插件
 * 所在的源码仓库，它应当随插件位置自动跟随。
 *
 * 推导链（宿主产物是 ESM，见 tsdown.config.ts format:'esm'，所以 import.meta.url
 * 在 lib/supermemory.js 与各 chunk 里都可用；DSH profile 里的
 * node_modules/dsh-supermemory 是指向源码仓库的符号链接，Node 默认解析 realpath）：
 * import.meta.url → lib/<file>.js → 逐级向上找到含 package.json(name=dsh-supermemory)
 * 的目录即仓库根；找不到时退回「模块目录的上一级」（lib/ 的父目录）。
 *
 * 兜底说明：安装成副本（非符号链接）时推导值是副本包根——此时该能力本就不适用
 * （入口脚本与 docs 在副本里，不是 git 仓库），能力描述已要求调用前先确认是本仓库。
 */
export function resolvePluginRepoRoot(moduleUrl: string = import.meta.url): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl))
  let dir = moduleDir
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (pkg?.name === 'dsh-supermemory') return dir
    } catch { /* 不是包根：继续向上 */ }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(moduleDir, '..')
}

/** 本插件源码仓库根目录（scope 的推导来源，模块加载时求值一次）。 */
export const PLUGIN_REPO_ROOT: string = resolvePluginRepoRoot()

/**
 * One built-in capability definition (register input fields + a definition version).
 *
 * Omit<CapabilityInput, 'changelog'>：CapabilityInput.changelog 是 register 同名
 * 更新时的「一行变更说明」（string），而内置定义携带的是整段版本史（string[]）——
 * 两者同名不同型，这里显式避开继承冲突。
 */
export interface BuiltinCapability extends Omit<CapabilityInput, 'changelog'> {
  /** 内置定义版本：store 版本旧于它 → 升级；新于/等于它 → 保留现场。 */
  version: number
  /** 版本变更说明/版本史（最新在前；合并时与现场 changelog 拼接，最多保留 20 条）。 */
  changelog?: string[]
}

/**
 * The built-in capability catalogue (stable order = seed order).
 *
 * scope 由 PLUGIN_REPO_ROOT 运行时推导，跟随插件的安装/克隆位置（v2 起）：
 * 不再需要在换机器后手工 memory_toolize register 修正。合并升级时若某行的
 * 行级归属恰好等于「旧 scope 推导值」（即由内置定义自己播种/继承而来），
 * 该行归属会随之迁移到新 scope 的工作区键；现场显式指定别的工作区的行保持不动
 * （见 mergeBuiltinCapabilities）。
 */
export const BUILTIN_CAPABILITIES: readonly BuiltinCapability[] = Object.freeze([
  {
    name: 'git-sync-supermemory',
    version: 5,
    title: 'git 同步/提交/推送（SuperMemory 仓库）',
    // 描述是模型的路由依据，硬上限 500 字符（composite.ts buildCapabilitySpec）：
    // v4 描述 725 字被该上限静默拒绝 → mergeBuiltinCapabilities 跳过播种
    // （report.seeded=[]）→ capability-smoke C3 / workspace-scope W5 失败。
    // 修改描述后务必重新计数，并把细节（凭据键/恢复流程）留在 docs 里。
    description: 'SuperMemory 仓库 git 同步/提交/推送固化流程。先确认工作区是本仓库（有 scripts/git-sync-push.sh），否则不触发。优先 pnpm git:sync，不要手敲 fetch/rebase/push。凭据走仓库本地 GCM（helper=manager）；GIT_TERMINAL_PROMPT=0，失败找用户，勿改全局 config/remote。推送（2026-11-23 起双远程）：origin push = GitHub（FrogMoo/SuperMemory，首位）+ Gitee（zrynas.7766.org:8418/Zry/SuperMemory），fetch/pull 只走 Gitee；首个 push URL 失败即中止后续推送，故远程排位即韧性。Gitea 2026-11-22 晚曾重置、已恢复（帐号改名 旧帐号名→Zry）。日常=跑入口；预演=加 --dry-run；提交前闸门 pnpm typecheck + pnpm smoke，提交信息写文件后 commit -F。凭据键坑与恢复流程见 docs/git-sync.md。',
    entry: 'pnpm git:sync',
    doc: 'docs/git-sync.md',
    // v2: 自动推导，不再硬编码克隆路径（换机器/换目录自动跟随）。
    scope: PLUGIN_REPO_ROOT,
    runnable: true,
    dryRunArg: '--dry-run',
    writeConfirm: true,
    tags: ['git', '同步', '推送', '流程固化'],
    routeNote: '在本仓库范围内遇到 git 同步/提交/推送类事务时优先用本能力：先默认预演（--dry-run）看计划，确认后 confirm=true 真实执行；不要手敲 git fetch/rebase/push。',
    changelog: [
      'v5: 描述压回 500 字上限内并更新为现状。根因：v4 描述 725 字超过 buildCapabilitySpec 的 500 字上限，mergeBuiltinCapabilities 静默跳过播种（report.seeded=[]），capability-smoke C3 与 workspace-scope W5 因此失败、内置能力计数差 1。内容更新：Gitea 2026-11-22 晚重置后已恢复（帐号改名 旧帐号名→Zry，非重建）、origin push = GitHub（首位）+ Gitee Zry/SuperMemory、fetch/pull 只走 Gitee、凭据走仓库本地 GCM（git http 传输的凭据键 host 带端口，换帐号时该键与 host+port 分开写法都要 approve、旧键要 reject）。',
      'v4: 双远程同时推送（origin push URL = GitHub 优先 + Gitee，fetch 仍只走 Gitee；git 2.55 首个 push URL 失败即中止后续推送，故 GitHub 排首位保障 Gitee 故障期推送不落空）；记录 Gitee 服务器 2026-11-22 重置、旧 旧帐号名 仓 404 的现状与恢复后 URL 更新方法。',
      'v3: 凭据改为走仓库本地 GCM（manager + Windows 凭据存储）；旧 store 方案（~/.git-credentials）已失效（文件不存在，fetch 必报 could not read Username），脚本与 docs 同步更新。',
      'v2: scope 改为从插件位置自动推导（原硬编码 G:\\09 - dsh\\SuperMemory），修复仓库迁移后「适用范围目录不存在」导致能力对当前工作区失效；升级时由旧 scope 继承的行级归属一并迁移。',
      'v1: 能力内置化（原由 memory_toolize register 手工录入）：随插件分发，清库/全新安装后自动播种；附带使用统计（成败分列/连续失败/最近一次结果）与刷新入口 memory_toolize refresh-builtin。',
    ],
  },
])

/** Look up one built-in capability by its logical name (not the tool name). */
export function builtinCapabilityByName(name: string): BuiltinCapability | undefined {
  return BUILTIN_CAPABILITIES.find((c) => c.name === name)
}
