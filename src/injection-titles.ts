/**
 * R56/R57: the ONE registry of context-injection card names.
 *
 * Every card this plugin injects into a model context carries TWO visible names,
 * and both come from the same registry entry:
 *
 *   1. 卡片标题（宿主「上下文注入 <label>」行的 label）= 注入消息的 source.kind
 *      = injectionLabel(kind)（不带方括号）。
 *   2. 内容首行标题 = [label] = injectionTitle(kind)（带方括号）。
 *
 * 宿主证据（DSH 0.2.2，详见 DEV-NOTES §70.2）：
 *   - dsh-client-ui-chat/src/client/conversation-nodes/event-projection.ts:60
 *     `contextProducer(source)` 的 default 分支 label = source.kind（宿主注释
 *     明确「keep an unknown producer visible by its durable kind」）；
 *   - dsh-client-ui-chat/src/client/chat/ContextInjectionRow.tsx:57 折叠行标题是
 *     固定的「上下文注入」（locale `message.contextInjection`，role 'recall' 时
 *     为「跨会话召回」）；
 *   - 同文件 :69 把 producer.label 渲染成标题里的来源段；:70-73 只对
 *     form='notice' 再追加 source.summary。
 * 因此「让每类注入用不同卡片标题」= 让每类注入的 source.kind 不同。
 *
 * ## 命名约定（新增注入卡必须遵守）
 *
 * 1. 所有上下文注入卡名字以 supermemory- 开头。
 * 2. 相关内容类用 supermemory-相关<主题>（话题 / 记忆 / 分支会话 / 能力…）：
 *    同族前缀 + 卡片所讲的主题；话题候选是相关话题族的子卡。
 * 3. 功能性卡用 supermemory-<功能>（小写 kebab，如 hub-role / plugin-prompt /
 *    notice），保持 ASCII——约定测试锁定
 *    ^\[supermemory-(相关.+|[a-z][a-z-]*)\]$ 与同形裸名正则。
 * 4. 禁止在渲染处手写标题字符串：一律 injectionTitle(kind)（枚举用
 *    injectionTitles()）；注入 source 一律 injectionSource(kind, form?)
 *    （src/source.ts）——手写 `kind: 'supermemory'` 作为卡片 label 就是回归，
 *    R57 冒烟会扫描 prestep.ts / route.ts 判失败。
 * 5. 新增注入卡必须「先登记」：本文件加常量与 kind，再渲染、再测试（精确匹配 +
 *    约定正则 + source.kind 断言）、最后写文档——登记 → 渲染 → 测试 → 文档。
 *
 * ## 例外：relay / 消息传输前缀不是注入卡
 *
 * [supermemory-relay <branch>]、[supermemory-group-relay <group>]、
 * [supermemory-dispatch <id>]、[supermemory-resume <id>]、
 * [supermemory-questions]、[supermemory-panel-reply]、[supermemory-topic-set]
 * 是消息头：在会话之间传输，relay 管线会解析它们并携带 id/载荷。它们不经过本
 * 注册表、不改名，改了会破坏回送。见 DEV-NOTES §69.2。
 *
 * relay 消息的 source.kind 也保持 'supermemory'（observe.ts 用
 * source.deliveryId + kind 'supermemory' 确认投递）——那些卡由插件自己的
 * 客户端卡片渲染，不走宿主的「上下文注入 <label>」行。
 * @module supermemory/injection-titles
 */

/** 卡片种类 → 裸名（不带方括号）。新增卡片在这里登记一个 kind。 */
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

/** 已登记的裸名（= 卡片 label = 宿主「上下文注入 <label>」的 label）。 */
export type InjectionLabel = (typeof INJECTION_TITLES)[InjectionKind]

/** 约定：每张注册裸名都必须匹配（R56/R57 测试锁定）。 */
export const INJECTION_LABEL_PATTERN = /^supermemory-(相关.+|[a-z][a-z-]*)$/

/** 约定：每张注册标题都必须匹配（R56 测试锁定）。 */
export const INJECTION_TITLE_PATTERN = /^\[supermemory-(相关.+|[a-z][a-z-]*)\]$/

/**
 * 卡片 label：注入消息的 source.kind，宿主把它渲染成「上下文注入 <label>」行
 * 的来源段。与 {@link injectionTitle} 同一条注册项。
 * @param kind - 已登记的注入卡种类。
 * @returns 不带方括号的裸名，例如 `supermemory-相关记忆`。
 */
export function injectionLabel(kind: InjectionKind): InjectionLabel {
  return INJECTION_TITLES[kind]
}

/** 带方括号的卡片标题（内容首行），例如 [supermemory-相关记忆]。 */
export function injectionTitle(kind: InjectionKind): string {
  return '[' + INJECTION_TITLES[kind] + ']'
}

/** 注册表快照：按声明顺序返回每张卡的 kind、label 与带方括号标题。 */
export function injectionTitles(): Array<{ kind: InjectionKind; label: InjectionLabel; title: string }> {
  return (Object.keys(INJECTION_TITLES) as InjectionKind[])
    .map((kind) => ({ kind, label: injectionLabel(kind), title: injectionTitle(kind) }))
}
