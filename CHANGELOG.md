# CHANGELOG

本仓库采用[语义化版本](https://semver.org/lang/zh-CN/)。首个正式 Release 之前的所有开发轮次（R1–R31，2026-11-16 → 2026-11-23）合并计入 `v1.0.0`。

## [1.2.0] - 2026-11-25

v1.1.0 之后的能力轮次（R43）：分支卡片点击不再误跳「新建会话」、中枢/分支会话名称说清主题。全量闸门（typecheck + 六套冒烟）通过。

### 新增

- **中枢会话名称默认就有意义**：`hubSessionTitle` 改为「<工作区名> · <主题/首条消息摘要>」（60 字预算；无主题 → 「<工作区名> · 新会话」；无 cwd 时退化为主题直述）；shell 路径新增 `attachHubTitleFromFirstMessage`（监听 user 消息给插件中枢补名——只认 user 消息、只升中性名、每会话每进程一次、人名不覆盖）；存量迁移候选扩展到中性名，冷会话带 live header.cwd 工作区回退；面板/管理台列表对中性宿主名展示记录主题。
- **分支任务标题预算 48 → 60 字**（`TITLE_BRANCH_TASK_CHARS`，宿主标题/成员标题/面板行三处同值；话题集 root 会话仍走「<话题集标题> · <任务>」）。

### 修复

- **分支卡片点击不再跳「新建」**：根因是 shell「新建会话」入口的 document 级 capture 监听按可及名匹配，而中枢会话名常年是裸「新会话」、聊天卡片头部文本「来自 <来源会话> 的执行请求」命中拦截正则。修法两处（纯插件侧）：capture 里跳过 `[data-supermemory-card]`（卡片自带标记）；卡片头部 onClick 先 stopPropagation 再切换展开（挡住祖先气泡处理器）。

### 工程

- 六套冒烟规模：core 34 / mechanism 113（新增 R43-1 命名形状/中性名判定/截断差异/shell 补名断言，client-sim 增可驱动与构建产物护栏）/ webui 35 / client-sim OK / capability 12 / workspace-scope 9。

### 兼容性

- 宿主要求 DSH `>=0.2.0 <0.3.0`（`engines.dsh` 不变）。
- 存储域 `supermemory` version 1 不变；无新表新字段，无需迁移。

### 已知限制

- 「新建会话」拦截按可及名匹配：会话区内若出现其它文本含「新建会话」等词的按钮/链接（如用户消息里的链接），理论上仍可能被误拦（本次报告的卡片案例已修）。
- 分支会话无法重载插件（BRANCH_RELOAD_DENIED）；重载与 GUI 验收由中枢/用户执行。

[1.2.0]: https://github.com/FrogMoo/SuperMemory/releases/tag/v1.2.0
## [1.1.0] - 2026-11-24

v1.0.1 之后的能力轮次合集（R32–R42）：中枢-分支协同规则硬化进插件运行时、中枢权限白名单与设置页收敛、默认模型持久化、会话名称直述体系、中断 relay 重复投递修复。全量闸门（typecheck + 六套冒烟）通过。

### 新增

- **中枢-分支协同规则硬化**（R32/R33/R35）：三条规则从提示词落进运行时——分支内调用插件重载入口被拒（BRANCH_RELOAD_DENIED）；分支→中枢 relay 与中枢→分支派发/续跑的卡片双向通路（来源标题/任务/话题集/能力字段补全）；角色判定收敛至唯一权威 `src/role.ts` `resolveRole`（branch 优先 → hub 正标记 → other），guard 改全量捕获 + 失败显式告警与 meta 标记。
- **中枢权限白名单**（R36/R37/R39）：默认拒绝；面板原「中枢权限」页签为动态目录（按工具来源分组、搜索/折叠、白名单勾选、6 项锁定、失效条目一键清理、宿主合成项）。
- **工具合成项**（R40）：会话级/宿主保留工具进入目录，修掉「已失效」误判。
- **设置页 = 权限 + 默认模型单一入口**（R41）：原「中枢权限」页签并入「设置」；新增默认模型卡片（中枢/分支两个下拉，按工作区持久化，新表 `model_defaults`；「恢复默认」回到跟随链路）。新建中枢会话无显式模型时读中枢默认；新派发分支模型解析顺序为 话题集默认 > 分支会话默认 > 中枢当前模型 > 宿主默认（既有 per-member / per-topic-set 覆盖优先级不变）。
- **会话名称直述体系**（R41/R42）：去掉前置描述/品牌前缀/令牌前缀，直接描述工作内容——中枢标题取首条用户消息描述（不再生成「SuperMemory 中枢 · id4」）；分支标题为任务本身（不再拼「<话题集> · <任务>」）；一次性迁移存量标题（hub-title-migration v2/v3：人工改名不覆盖、durable 记录 dispatches.title 与 member 标题三面同步清理、冷会话面板兜底）；配套工具 `scripts/cleanup-legacy-titles.mjs`（默认 dry-run、--apply 才写、走域层正规写路径）。
- **GitHub API 补推增强**：`scripts/github-api-release.mjs` 支持文件重命名与非 ASCII 路径，提交内容改取 blob。

### 修复

- **中断 relay 重复投递**（用户实测「中断任务被多次送回中枢」，R42）：`observe.deliver()` 新增持久守卫（relayed/confirmed 行不再重投、不再抹确认态）；同批巡检「同分支+同任务」只投一份回执（twin 行落 ledger 带 `suppressedOf`，永不重投）；reconcile 失败回执键统一为 `dlv-<dispatchId>`（分支已死的派发只投一次、同分支多派发不再互吞）；中断公告改持久增量（`dispatches.interruptNoticedAt`，每条最多公告一次，重载/清单刷新只补新增）。
- **侧栏单选唯一高亮**（R41）：纯函数 `isRailCurrent`（src/rail-selection.ts）——聊天视图只认 view.id、其它视图只认 sessionId，任何状态最多命中一行。
- **前缀剥离规则补强**（R42）：轮次令牌（R32/r7/R41-B/第 3 轮/Round 3）分隔符或单空格均剥；描述标签（项目：/背景：/仓库：等）仍须分隔符，«需求分析：…» 不误伤。

### 工程

- 提交作者身份统一为 FogFrost <88362780+FrogMoo@users.noreply.github.com>（GitHub noreply 格式，提交在 GitHub 侧关联 FrogMoo 账号）。
- 六套冒烟规模：core 34 / mechanism 112 / webui 35 / client-sim OK / capability 12 / workspace-scope 9。

### 兼容性

- 宿主要求 DSH `>=0.2.0 <0.3.0`（`engines.dsh` 不变）。
- 存储域 `supermemory` version 1 不变；新表 `model_defaults` 无行即空表；`dispatches.interruptNoticedAt` 与 `outbox.suppressedOf` 为可选字段，旧介质读作缺省，自动兼容无需迁移。

### 已知限制

- 分支会话无法重载插件（BRANCH_RELOAD_DENIED）；重载与 GUI 验收由中枢/用户执行。
- DSH shell 输入框直接发首条消息不触发面板侧中枢标题升级（仅面板发消息会）。
- 会话标题句首「R31 的需求」这类文本会被剥成「的需求」（Rnn+空格规则的既定取舍）。

[1.1.0]: https://github.com/FrogMoo/SuperMemory/releases/tag/v1.1.0
## [1.0.1] - 2026-11-23

补全发布元数据的维护版：新增专有 LICENSE 文件、登记 v1.0.0 发布轮记录，重新打包发布。无功能与行为变更，v1.0.0 用户可按 INSTALL.md「升级」一节平滑升级（亦可停留在 v1.0.0，两者功能等价）。

### 新增

- **LICENSE 文件**：专有许可（All Rights Reserved，`package.json` 增 `license: "UNLICENSED"`）——允许个人自用、阅读源码与提 issue/PR，不允许再分发或基于本软件提供商业服务。了结 v1.0.0「已知限制：仓库暂无 LICENSE 文件」。

### 工程

- `DEV-NOTES.md` §41：v1.0.0 发布轮实测记录（三端一致性、双远程各自账号推送、GitHub API 补推路径）归档。
- 发布包重新打包：`release/dsh-supermemory-1.0.1.zip`（预构建产物 + 生产依赖，随仓库跟踪）。

### 兼容性

- 与 v1.0.0 完全兼容：宿主要求 DSH `>=0.2.0 <0.3.0`；存储域 `supermemory` version 1 不变，无需迁移。

### 已知限制

- 全新空中枢会话在产生首条消息前不显示徽标（宿主 blank 行门控，与既有行为一致）。

## [1.0.0] - 2026-11-23

首个正式 Release：DSH 跨会话记忆插件「话题集记忆 + 派发归档 + 过程内再召回 + 组合工具自动固化」能力集齐，全量闸门（typecheck + 6 套冒烟）通过。

### 新增

- **结论性记忆**：三层结构（标题 + 标签 + 正文）；`memory_remember` / `memory_recall` / `memory_history` 三个模型工具；两级检索（先记忆集合、再精选条目）；按工作区隔离（`workspaceKey`）。
- **记忆版本控制**：同一 key 内容变化时就地更新并升版，旧版本整体归档（只增不减）；`memory_history` 按 key/id 溯源全部版本；旧介质惰性迁移补 v1，不丢数据。
- **记忆集合两级模型**：集合（标题/标签/梗概）→ 条目；归属按相似度分档（高/中复用、低新建），有模型时由模型判定；面板、管理台、自动抽取三条写路径同一套判定。
- **话题集**：中枢/分支会话分组（标题/梗概/标签/成员/默认模型）；recall 命中记忆时一并给出相关话题集；`memory_topicsets` / `memory_new_topicset` / `memory_set_model`。
- **中枢/分支协同**：`memory_dispatch` 异步派发（单发/并行组），结果经 relay 按 `hubSessionId` 回送；分支问题上交（`memory_raise_question`）+ 中枢统一提问（`memory_questions`）；`memory_resume` 续跑中断任务；中断保留分支会话，恢复后由用户决定续跑。
- **过程内再召回**：pre-step 注入卡片，同一请求内可注入多张（去重 + 条数/字符预算），避免模型「失忆」。
- **固化能力（组合工具）**：`memory_toolize` 注册/维护能力；重复流程自动固化为组合工具；内置 `git-sync` 能力（v5）；使用计数与健康度（成败分列、连续失败）；执行门禁与 PATH 兜底。
- **可视化管理**：DSH 内面板（话题集/记忆两级页/固化能力/中枢会话/派发卡）+ 独立 Web 管理台（`/memory ui`，令牌链接）。
- **模型工具面**：共 14 个 `memory_*` 工具；`/memory` 命令族 16 个子命令。
- **会话标识**：中枢会话固定标题前缀「SuperMemory 中枢 · 」；分支/中枢徽标常显（侧边栏 trailing 槽位）；分支会话标题/标签自动生成。
- **维护循环**：回合末自动抽取事实与需求、toolize 记录与回收、记忆整理（正文哈希 + 标记守卫、默认 dry-run）、标题补正、一次性标题迁移（用户手改不覆盖）。

### 工程

- 宿主半边 `lib/supermemory.js` + 浏览器半边 `lib/client.js`（ESM/CJS，产物随仓库跟踪）。
- 6 套冒烟：core / mechanism / webui / client-sim / capability / workspace-scope。
- 一键安装为 DSH profile bundle：`pnpm install:dsh`（官方 bundle 形态，插件页可见可禁用）。
- 发布包 `release/dsh-supermemory-<版本>.zip`：预构建产物 + 生产依赖，解压后一条命令挂载，无需构建、无需外网。
- Git 双远程推送（GitHub + 内网 Gitee），`pnpm git:sync` 一键同步。

### 兼容性

- 宿主要求 DSH `>=0.2.0 <0.3.0`（`engines.dsh`）。
- 存储域 `supermemory` version 1；旧介质自动惰性迁移（记忆版本、扁平记忆、标题补正）。

### 已知限制

- 仓库暂无 LICENSE 文件。
- 全新空中枢会话在产生首条消息前不显示徽标（宿主 blank 行门控，与既有行为一致）。

[1.0.1]: https://github.com/FrogMoo/SuperMemory/releases/tag/v1.0.1
[1.0.0]: https://github.com/FrogMoo/SuperMemory/releases/tag/v1.0.0
