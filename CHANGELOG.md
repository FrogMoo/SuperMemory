# CHANGELOG

本仓库采用[语义化版本](https://semver.org/lang/zh-CN/)。首个正式 Release 之前的所有开发轮次（R1–R31，2026-11-16 → 2026-11-23）合并计入 `v1.0.0`。

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

[1.0.0]: https://github.com/FrogMoo/SuperMemory/releases/tag/v1.0.0
