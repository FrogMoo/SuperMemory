/**
 * R56: the ONE registry of context-injection card titles.
 *
 * Every card this plugin injects into a model context starts with the same
 * bracketed header, and every header comes from this file:
 *
 *   [supermemory-相关话题]        相关话题集（激活话题集上下文卡）
 *   [supermemory-相关话题候选]    候选话题集（只提示、不切换）
 *   [supermemory-相关记忆]        相关记忆（开场召回卡）
 *   [supermemory-相关记忆补充]    同一请求内后补的相关记忆
 *   [supermemory-相关分支会话]    中枢在本话题集拉起的关联分支（含命中话题集的分支）
 *   [supermemory-相关能力]        固化能力精简索引（正文按需读取）
 *   [supermemory-hub-role]        中枢角色提示（功能性卡）
 *   [supermemory-plugin-prompt]   插件记忆使用约定（功能性卡）
 *   [supermemory-notice]          中断任务公告（功能性卡）
 *
 * ## 命名约定（新增注入卡必须遵守）
 *
 * 1. 所有上下文注入卡标题以 supermemory- 开头。
 * 2. 相关内容类用 supermemory-相关<主题>（话题 / 记忆 / 分支会话 / 能力…）：
 *    同族前缀 + 卡片所讲的主题；话题候选是相关话题族的子卡。
 * 3. 功能性卡用 supermemory-<功能>（小写 kebab，如 hub-role / plugin-prompt /
 *    notice），保持 ASCII——约定测试锁定
 *    ^\[supermemory-(相关.+|[a-z][a-z-]*)\]$。
 * 4. 禁止在渲染处手写标题字符串：一律 injectionTitle(kind)（枚举用
 *    injectionTitles()）。渲染文件里出现手写「[supermemory-…]」字面量就是回归，
 *    R56-4 冒烟会扫描 src/ 判失败。
 * 5. 新增注入卡必须「先登记」：本文件加常量与 kind，再渲染、再测试（精确匹配 +
 *    约定正则）、最后写文档——登记 → 渲染 → 测试 → 文档。
 *
 * ## 例外：relay / 消息传输前缀不是注入卡
 *
 * [supermemory-relay <branch>]、[supermemory-group-relay <group>]、
 * [supermemory-dispatch <id>]、[supermemory-resume <id>]、
 * [supermemory-questions]、[supermemory-panel-reply]、[supermemory-topic-set]
 * 是消息头：在会话之间传输，relay 管线会解析它们并携带 id/载荷。它们不经过本
 * 注册表、不改名，改了会破坏回送。见 DEV-NOTES §69.2。
 * @module supermemory/injection-titles
 */

/** 卡片种类 → 不带方括号的标题。新增卡片在这里登记一个 kind。 */
export const INJECTION_TITLES = {
  /** 相关话题集（激活话题集的上下文卡）。 */
  topic: 'supermemory-相关话题',
  /** 候选话题集——只提示、从不切换（相关话题族的子卡）。 */
  topicCandidate: 'supermemory-相关话题候选',
  /** 相关记忆（开场召回卡）。 */
  memory: 'supermemory-相关记忆',
  /** 同一请求内后补的相关记忆（过程内补充卡）。 */
  memoryRepeat: 'supermemory-相关记忆补充',
  /** 关联分支会话：中枢的分支 + 命中话题集的分支清单。 */
  branch: 'supermemory-相关分支会话',
  /** 固化能力精简索引（正文用 sm_cap_doc 按需读取）。 */
  capability: 'supermemory-相关能力',
  /** 中枢角色提示（功能性卡）。 */
  hubRole: 'supermemory-hub-role',
  /** 插件记忆使用约定（功能性卡）。 */
  pluginPrompt: 'supermemory-plugin-prompt',
  /** 中断任务公告（功能性卡）。 */
  notice: 'supermemory-notice',
} as const

/** 已登记的注入卡种类。 */
export type InjectionKind = keyof typeof INJECTION_TITLES

/** 约定：每张注册标题都必须匹配（R56 测试锁定）。 */
export const INJECTION_TITLE_PATTERN = /^\[supermemory-(相关.+|[a-z][a-z-]*)\]$/

/** 带方括号的卡片标题，例如 [supermemory-相关记忆]。 */
export function injectionTitle(kind: InjectionKind): string {
  return '[' + INJECTION_TITLES[kind] + ']'
}

/** 注册表快照：按声明顺序返回每张卡的 kind 与带方括号标题。 */
export function injectionTitles(): Array<{ kind: InjectionKind; title: string }> {
  return (Object.keys(INJECTION_TITLES) as InjectionKind[])
    .map((kind) => ({ kind, title: injectionTitle(kind) }))
}
