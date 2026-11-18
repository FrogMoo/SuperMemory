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
import type { CapabilityInput } from './composite.ts'

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
 * scope 是本仓库的绝对路径：换机器/换克隆目录时该能力的适用范围会失效——
 * 健康报告（capabilityHealthOf）会把「适用范围目录不存在」列为待维护信号，
 * 用 memory_toolize register 同名更新即可修正（version+1 后内置不再覆盖它）。
 */
export const BUILTIN_CAPABILITIES: readonly BuiltinCapability[] = Object.freeze([
  {
    name: 'git-sync-supermemory',
    version: 1,
    title: 'git 同步/提交/推送（SuperMemory 仓库）',
    description: 'SuperMemory 仓库（G:\\09 - dsh\\SuperMemory）的 git 同步/提交/推送固化流程。先判断工作区是否本仓库（git rev-parse --show-toplevel 或存在 scripts/git-sync-push.sh），不是本仓库不要触发。优先执行入口命令 pnpm git:sync（cmd/PowerShell 下也无 bash PATH 问题），不要手敲 git fetch/rebase/push——本机 GCM 接管认证会失败，正确凭据写法 GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper=store。日常同步=直接跑入口；只预演=加 --dry-run；提交前闸门=pnpm typecheck + pnpm smoke 全绿，提交信息写中文文件后 git commit -F。完整流程与坑见 docs/git-sync.md。',
    entry: 'pnpm git:sync',
    doc: 'docs/git-sync.md',
    scope: 'G:\\09 - dsh\\SuperMemory',
    runnable: true,
    dryRunArg: '--dry-run',
    writeConfirm: true,
    tags: ['git', '同步', '推送', '流程固化'],
    routeNote: '在本仓库范围内遇到 git 同步/提交/推送类事务时优先用本能力：先默认预演（--dry-run）看计划，确认后 confirm=true 真实执行；不要手敲 git fetch/rebase/push。',
    changelog: [
      'v1: 能力内置化（原由 memory_toolize register 手工录入）：随插件分发，清库/全新安装后自动播种；附带使用统计（成败分列/连续失败/最近一次结果）与刷新入口 memory_toolize refresh-builtin。',
    ],
  },
])

/** Look up one built-in capability by its logical name (not the tool name). */
export function builtinCapabilityByName(name: string): BuiltinCapability | undefined {
  return BUILTIN_CAPABILITIES.find((c) => c.name === name)
}
