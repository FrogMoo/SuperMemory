# SuperMemory（dsh-supermemory）

DeepSeek Harness（DSH）的跨会话记忆插件：把「结论性事实、话题集、派发归档、固化能力」持久化到存储域，让中枢/分支会话协同工作跨会话可续、可追溯、可召回。

- **包名**：`dsh-supermemory`　**版本**：`1.3.0`（最新 Release，tag `v1.3.0`；首个正式版为 `v1.0.0`）　**许可**：专有许可 All Rights Reserved（见 [LICENSE](LICENSE)）
- **宿主要求**：DSH `>=0.2.0 <0.3.0`（见 `package.json` 的 `engines.dsh`）
- **产物形态**：ESM。宿主半边 `lib/supermemory.js`，浏览器半边 `lib/client.js`（DSH 侧边栏/主区面板）
- **存储**：DSH `storageDomain` 域 `supermemory`（version 1），表定义集中在 `src/schema.ts`；所有业务表按工作区隔离（`workspaceKey`，决策 D4）

## 1. 解决什么问题

DSH 会话默认是「一次性」的：上一次对话得出的结论、派发出去的分支任务结果、约定好的构建命令，换一个会话就丢了。SuperMemory 把这些变成**可检索、可追溯、按工作区隔离**的持久资产：

- 模型用 `memory_remember` 写结论、`memory_recall` 跨会话检索（回答"之前说过什么/做过什么"前先检索）；
- 中枢用 `memory_dispatch` 把任务异步派发到分支会话，完成后结果经 relay 自动回送；
- 分支不直接问用户——`memory_raise_question` 上交中枢，由中枢 `memory_questions` 汇总后一次提问；
- 重复出现的**任务**只产生待接受的知识提案；接受后才创建「单一能力」——知识面 `SKILL.md`（何时用/决策/坑/验证）+ 执行面 `sm_cap_<name>`（固定入口，默认预演、写操作 `confirm=true`），R50 起组合工具机制已删除；
- 记忆带版本（同 key 就地更新升版、旧版本归档），结论的演变过程可溯源。

## 2. 功能特性

| 领域 | 能力 |
|---|---|
| 记忆 | 结论性事实记忆（标题 + 标签 + 正文三层结构）；`memory_recall` 两级检索（先匹配记忆集合、再精选条目）；工作区隔离；R30 起支持**版本控制**（见下） |
| 记忆版本控制 | `memories.version` + `memory_versions` 历史表；同一 key 内容变化时**就地更新并升版**，旧版本整体归档（只增不减）；`memory_history` 按 key/id 溯源全部版本；旧介质惰性迁移补 v1，不丢数据 |
| 记忆集合 + 条目 | 两级模型：集合（标题/标签/梗概）→ 条目；归属按标题/标签/正文相似度分档（高/中复用、低新建），有模型时由模型判定；面板、管理台、自动抽取三条写路径同一套判定 |
| 话题集 | 中枢/分支会话的分组：标题/梗概/标签/分支成员/默认模型；recall 命中记忆时一并给出相关话题集，便于把结论关联回会话上下文 |
| 中枢/分支协同 | `memory_dispatch` 异步派发（单发/并行组）；分支问题上交 + 中枢统一提问；`memory_resume` 续跑中断任务；relay 按派发记录的 `hubSessionId` 回送；分支会话标题/标签（任务首行 + 话题集标签 + 轮次令牌） |
| 过程内再召回 | pre-step 注入卡片：同一请求内可注入多张（去重 + 条数/字符预算），避免模型"失忆" |
| 统一能力 | 一条记录、两个面：知识面 `SKILL.md`（正文事实源，自动维护只刷新 `<!-- sm:facts:start/end -->` 事实块）+ 执行面 `sm_cap_<name>`（固定入口，默认预演，`writeConfirm` 必须 `confirm=true`）；自动路径只产待接受知识提案（同任务≥3 次、≥2 会话、30 天；每根自动上限 8，接受才占额；pending 上限 20、30 天过期）；高置信入口只进 `entryDraft`（未验证，人工「启用执行」才 runnable）；`memory_toolize` 注册/接受/启停/刷新/清理；内置 `git-sync` 能力；统计分执行 `runCount`、加载 `loadCount`、转化率、成功率、连续失败；历史工具序列壳子（含被 R50 改写过知识面的）一律先归档/退役，不进入能力目录（R51） |
| 可视化管理 | DSH 内面板（话题集/记忆两级页/固化能力/中枢会话/派发卡）+ 独立 Web 管理台（`/memory ui`，带令牌链接） |
| 维护循环 | 自动抽取事实与需求、任务提案与能力事实块刷新、记忆整理（正文哈希 + 标记守卫、默认 dry-run）、标题补正 |

### 2.1 模型可见工具（`src/tools.ts`，共 14 个）

`memory_remember`（写入，同 key 升版）· `memory_recall`（两级检索，输出版本号）· `memory_history`（版本溯源）· `memory_topicsets` / `memory_new_topicset` / `memory_set_model`（话题集）· `memory_dispatch` / `memory_resume`（派发与续跑）· `memory_raise_question` / `memory_questions`（分支问题上交与中枢汇总）· `memory_scan`（文件地图）· `memory_export`（导出 Markdown）· `memory_ui`（管理台链接）· `memory_toolize`（能力维护）。

### 2.2 `/memory` 命令族（`src/commands.ts`）

`/memory` 带子命令，每个子命令也可直接输 `/memory-<名>`：`ui`（管理台）· `status`（状态总览）· `topicsets` · `switch` · `new` · `model` · `tools`（能力：知识面 + 执行面）· `reqs`（未完成需求）· `resume`（续跑）· `wrap`（话题集梗概）· `scan` · `export` · `titles`（标题补正）· `merge`（话题集合并治理）· `organize`（记忆集合整理）· `help`。

## 3. 目录结构

```text
.
├── src/                        # 插件源码（宿主半边 + 浏览器半边）
│   ├── index.ts                # 插件入口：Config schema、各子系统装配（tools/panel/webui/maintenance/observe…）
│   ├── schema.ts               # 存储域 v1 全部表定义（zod）：topicsets/memories/memory_collections/
│   │                           #   memory_versions/episodes/requirements/filemap/tool_memory/signals/
│   │                           #   dispatches/questions/outbox/routing/hotcache/meta
│   ├── store.ts                # 存储域打开 + 类型化表访问器 + 工作区键解析（D4）
│   ├── tools.ts                # 14 个 memory_* 工具定义与实现
│   ├── commands.ts             # /memory 命令族（16 个子命令）
│   ├── panel.ts                # 宿主面板远程服务（typert 描述符 + 全部面板方法）
│   ├── webui.ts                # 独立 Web 管理台（HTTP 载体 + JSON API + 静态资源）
│   ├── recall.ts / retrieval.ts# 检评分（标题×4/标签×3/正文×1 + 时间衰减）与记录形态推导
│   ├── memory-collections.ts   # 记忆集合两级模型：相似度分档 / 模型判定 / 惰性迁移
│   ├── memory-versions.ts      # 记忆版本化读写唯一入口（create/update/history/migrate）
│   ├── memory-organize.ts      # 记忆整理引擎（计划内嵌 + 哈希守卫 + 备份 + 标记幂等）
│   ├── memory-split.ts         # 一条写入整形为多条原子记忆（有模型才拆）
│   ├── dispatch.ts / observe.ts / resume.ts / group.ts / questions.ts / round-end.ts
│   │                           # 派发、观测结算、续跑、并行组、分支问题上交、轮次收尾
│   ├── prestep.ts / inrequest.ts / activity.ts   # 过程内再召回（注入卡片/预算/近失提示）
│   ├── toolize.ts / composite.ts / builtin-capabilities.ts / capabilities.ts / route.ts
│   │                           # 任务提案、统一能力（知识面+执行面）、事实块、注册与健康度、内置能力、路由规则
│   ├── topicsets.ts / topicset-match.ts / topicset-merge.ts / topic-shape.ts
│   │                           # 话题集增删改查、匹配、合并治理、LLM 形状
│   ├── hub-sessions.ts / hub-branches.ts / branch-meta.ts / branch-restore.ts
│   │                           # 中枢/分支会话枚举、分支标题标签、重启恢复
│   ├── title.ts / title-migration.ts             # 会话标题与一次性补正迁移
│   ├── maintenance.ts          # 维护循环（回合末：事实/需求抽取、toolize 记录与回收）
│   ├── export.ts / filemap.ts / requirements.ts / model.ts / workspace.ts / llm-json.ts / extract.ts
│   ├── client/                 # 浏览器半边：panel-page.tsx（面板 UI）、remote.ts（wire 契约）、
│   │                           #   index.ts（apply 装配）、locales.ts（中英文）、new-session.tsx、
│   │                           #   open-dispatch.ts（回执通道）、session-badge.tsx、icon.tsx
│   └── web/                    # 管理台静态资源：app.js（vanilla JS）、style.css、index.html
├── docs/
│   ├── git-sync.md             # git 同步/提交/推送流程（双远程、凭据、坑与退出码）
│   └── notes/                  # 历史轮次设计/复盘笔记（4 篇）
├── scripts/
│   ├── *-smoke.mjs             # 7 套冒烟：core / mechanism / webui / client-sim / capability / workspace-scope / skill
│   ├── git-sync-push.sh        # git 同步唯一实现（.mjs 只是 bash 启动器）
│   ├── install-into-dsh.mjs    # 安装为 DSH profile bundle
│   ├── dev-load.sh             # 开发期武装带时间戳入口（规避 ESM 同 URL 缓存）
│   ├── memory-organize.mjs / tool-schema-probe.mjs / webui-live-check.mjs / wrap-client.mjs
│   └── __fixtures__/           # 冒烟 fixtures
├── lib/                        # 构建产物（已跟踪）：宿主 supermemory.js + 客户端 client.js + chunk
├── _dsh_src/                   # 宿主依赖包快照（cordis 等 .tgz/展开目录，供 tsconfig paths 离线解析）
├── DEV-NOTES.md                # 轮次开发记录（R1–R30，含每轮结论/闸门/并发约定）
├── IMPLEMENTATION-REPORT.md / R20-REPORT.md / 可行性分析与实现方案.md
├── .supermemory-export.md      # 导出格式样例（/memory export 的产物形态）
├── cordis.patch.yml            # bundle patch（插入本插件）
├── tsdown.config.ts / tsdown.client.config.ts / tsconfig.json / tsconfig.client.json
└── package.json / pnpm-lock.yaml / pnpm-workspace.yaml
```

## 4. 开发与构建

环境：Node 22+（产物 target `node22`）、pnpm；运行侧需要 DSH `>=0.2.0 <0.3.0`。

```bash
pnpm install        # 安装依赖
pnpm typecheck      # tsc 双配置：宿主（tsconfig.json）+ 客户端（tsconfig.client.json），目标 0 错
pnpm build          # tsdown 宿主 + tsdown 客户端 + wrap-client（产物落 lib/）
pnpm smoke          # 7 套冒烟一次跑完（见下）
```

冒烟可单独跑：`pnpm smoke:core`（宿主纯逻辑）、`pnpm smoke:webui`（管理台宿主侧集成）、`pnpm smoke:skill`（技能固化）。其余四套（`mechanism` / `client-sim` / `capability` / `workspace-scope`）用 `node scripts/<名>-smoke.mjs` 直接跑。

| 套件 | 覆盖 |
|---|---|
| `core` | 宿主纯逻辑：导出隔离、检索阈值、记录形态、记忆原子拆分 |
| `mechanism` | 过程内召回、R49 宽泛序列过滤/启动清理、面板 wire 契约（host/client 描述符 parity）、话题集匹配/合并 |
| `webui` | 管理台：认证、路由、记忆/需求/话题集 CRUD、能力执行 |
| `client-sim` | 对**构建产物**跑客户端 apply()，校验每个 slot 注册成功 |
| `capability` | 统一能力：迁移/注册、知识面事实块、`sm_cap_*` 执行门禁、统计与转化率、内置播种 |
| `skill` | 技能固化（R45）：草稿/落盘/frontmatter/幂等升版/人工编辑保护/启停/面板/运行时接线 |
| `workspace-scope` | 工作区隔离：话题集/分支/能力按工作区过滤与门禁 |

## 5. 在 DSH 中安装与重载

### 5.1 用户安装（DSH 插件面板 / Release，推荐）

普通用户**不需要克隆仓库、不需要构建**，两种方式任选：

- **DSH 插件面板（需能访问 GitHub）**：在「插件 → 安装插件」填 `https://github.com/FrogMoo/SuperMemory/releases/latest/download/dsh-supermemory.tgz`（稳定 tgz 别名），或填 Git 仓库地址 `https://github.com/FrogMoo/SuperMemory`。**不要填** release 页面 URL 或 `.zip` 资产——DSH 安装器只接受 git 仓库或 `.tgz/.tar.gz` 直链。
- **手动 Release 包（离线/内网）**：到 [GitHub Releases](https://github.com/FrogMoo/SuperMemory/releases)（或仓库 `release/` 目录）下载 `dsh-supermemory-<版本>.zip`，解压后进入目录执行 `node scripts/install-into-dsh.mjs`，重启 DSH Desktop。发布包内置 `lib/` 与生产依赖 `node_modules/`，安装无需外网。

完整规则、升级与卸载见 [INSTALL.md](INSTALL.md)。

### 5.2 开发期安装（源码工作区）

```bash
pnpm install:dsh        # 等价于 node scripts/install-into-dsh.mjs
```

该脚本把插件安装为 DSH desktop profile 的**官方 bundle 形态**：profile `package.json` 增加 `"dsh-supermemory": "link:<本工作区>"` 依赖、`dsh.profile.bundles` 追加激活、清理 `cordis.patch.yml` 里指向本插件入口的路径行 insert（防止重复注册）、`pnpm install` 建立符号链接——此后**本工作区成为 HMR 监视根**，改源码 → tsdown 重建 → 热替换。

重载的两种方式：

- 常规：插件页（plugin_manager）禁用 → 启用；
- 开发期：`scripts/dev-load.sh` 武装带时间戳的 `lib/dev-<stamp>.js`——ESM 按 URL 缓存，同 URL 重建不生效，必须换 URL 或让基础包入口重新导入。

## 6. Git 同步流程概要

仓库配了**双远程推送**（详见 [docs/git-sync.md](docs/git-sync.md)）：

- `origin` 的 **fetch URL 只有 Gitee**（`http://zrynas.7766.org:8418/Zry/SuperMemory.git`）——pull / rebase / 跟踪分支只走它；
- `origin` 的 **push URL 两项**：① GitHub（`https://github.com/FrogMoo/SuperMemory.git`，**排首位**）② 上述 Gitee——`git push origin main` 一条命令推两个仓库；
- 独立远程 `github` 用于单推 GitHub；默认分支 `main`。

日常同步用一键入口（**先看计划再执行**）：

```bash
pnpm git:sync --dry-run   # 只 fetch + 比对 + 打印计划，不写任何 ref
pnpm git:sync             # 工作区检查 → fetch → rebase（behind>0 时）→ push → ls-remote 核对
```

约定：

- **提交前闸门**：`pnpm typecheck` + `pnpm smoke` 全绿后才提交；
- **提交信息**：中文写进临时文件，`git commit -F <文件>`（不用 `-m` 传长消息）；
- **凭据**：走仓库本地 Git Credential Manager（Windows 凭据存储），脚本不读写 `~/.git-credentials`；Gitee 侧帐号/口令变更见 §4.4「键的坑」（同一主机有两个凭据键，都要更新）；
- **安全约束**：工作区脏拒绝执行（不 stash 不自动提交）、rebase 冲突自动 abort、push 失败原样退出不重试、**绝不 force push**。

## 7. 文档索引

**docs/ 目录**：

- [docs/git-sync.md](docs/git-sync.md) —— git 同步/提交/推送全流程：一键入口、脚本关系、坑与规避（含凭据双键、Gitee 恢复时间线）、安全约束与退出码、提交前闸门、实测记录；
- [docs/notes/2026-11-18-branch-session-persistence.md](docs/notes/2026-11-18-branch-session-persistence.md) —— 分支会话重启保留；
- [docs/notes/2026-11-18-capability-maintenance.md](docs/notes/2026-11-18-capability-maintenance.md) —— 固化能力持续维护；
- [docs/notes/2026-11-18-workspace-isolation.md](docs/notes/2026-11-18-workspace-isolation.md) —— 工作区隔离；
- [docs/notes/2026-11-19-memory-organize.md](docs/notes/2026-11-19-memory-organize.md) —— 记忆整理审计快照。

**仓库根目录其他文档**：[DEV-NOTES.md](DEV-NOTES.md)（轮次开发记录，R1–R30，每轮结论/闸门/并发约定）、[IMPLEMENTATION-REPORT.md](IMPLEMENTATION-REPORT.md)（需求 A/B/C 实现报告）、[R20-REPORT.md](R20-REPORT.md)（分支问题上交复核报告）、[可行性分析与实现方案.md](可行性分析与实现方案.md)（设计方案 v4.2，D1–D8 定稿）。
