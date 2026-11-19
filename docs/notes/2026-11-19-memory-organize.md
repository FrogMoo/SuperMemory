# R23 记忆整理报告（2026-11-19）

由 `src/memory-organize.ts` 的只读预演生成；计划与删除理由以代码内嵌的 `ORGANIZE_PLAN` 为准。整理在插件重载时自动执行一次（正文哈希 + 标记守卫），本文件只是整理前后的审计快照。

## Before：6 个集合 / 22 条记忆

| # | id | 原标题（空=未命名） | 旧集合 | 标签数 | 创建日期 |
|---|---|---|---|---|---|
| 1 | mem-mwkuup1h-rfvc6d |  | supermemory 记忆 | 24 | 2026-11-17 |
| 2 | mem-mwkv5n2p-vwum3n |  | r8 记忆 | 24 | 2026-11-17 |
| 3 | mem-mwkvpvt2-o0krs2 | SuperMemory R9–R11：分支全能力、标题+标签+正文、话题集页签 | supermemory 记忆 | 6 | 2026-11-17 |
| 4 | mem-mwkwzlw2-wszibc | SuperMemory R18：中枢侧栏/自动三层/分支能力脚本/徽标修复/前端改版 已完成 | supermemory 记忆 | 6 | 2026-11-17 |
| 5 | mem-mwkx49qw-dbeb4j | R18 最终验收：六项需求全部生效（含两处修复：branch 过滤、topicset 工具参数） | supermemory 记忆 | 6 | 2026-11-17 |
| 6 | mem-mwkysqcq-jbbgqm | SuperMemory R19 已完成：三条需求（并行多分支/关联分支展示/分支共享）落地 | supermemory 记忆 | 6 | 2026-11-17 |
| 7 | mem-mwkytofa-m9t57p | R20：分支先干活、问题上交中枢、中枢一次提问 | supermemory 记忆 | 4 | 2026-11-17 |
| 8 | mem-mwl4tso5-mlaney | SuperMemory 仓库同步：sync 脚本凭据方案失效，改用 GCM 默认路径推送 | supermemory 记忆 | 4 | 2026-11-17 |
| 9 | mem-mwl4v8sy-jbnr4d | SuperMemory 仓库已同步云端：origin 为内网 Gitee，main↔origin | supermemory 记忆 | 5 | 2026-11-17 |
| 10 | mem-mwm2i0r9-63205r | SuperMemory 仓库已同步：HEAD=60f0f02(round-26)，与 origi | supermemory 记忆 | 4 | 2026-11-18 |
| 11 | mem-mwm3gz5g-1f715w | 面板「加载失败」根因：listTools 客户端声明 0 参数而调用传 1 个 | supermemory 记忆 | 8 | 2026-11-18 |
| 12 | mem-mwm3hbj6-0vrci3 | 写入结论性记忆（标题+标签+正文：根因、修复位置、验证结果、生效条件） | 写入 记忆 | 12 | 2026-11-18 |
| 13 | mem-mwm3msyt-1unad2 | 内置 git-sync 能力 scope 改为从插件位置推导（v2） | supermemory 记忆 | 6 | 2026-11-18 |
| 14 | mem-mwm3nb8q-7fi9ub | 写结论性记忆 | 写入 记忆 | 5 | 2026-11-18 |
| 15 | mem-mwm3sim8-2b610a | 本任务是并行组 grp-mwm3q5gw-df0g7d 的一员：只负责这一个任务 | grp-mwm3q5gw-df0g7d 记忆 | 12 | 2026-11-18 |
| 16 | mem-mwm4s24n-bly8s9 | R21 全量测试轮：后端 0 失败、修 7 处前端 bug、能力 exit 127 根治 | supermemory 记忆 | 5 | 2026-11-18 |
| 17 | mem-mwm4wh5d-w3fk69 | 本消息是被中断任务的续跑（原派发 dsp-mwkyjskq-92lsyb，原分支 branch… | dsp-mwkyjskq-92lsyb 记忆 | 12 | 2026-11-18 |
| 18 | mem-mwmbx5th-pzz88r | 本任务是并行组 grp-mwmbphig-uy8ihi 的一员：只负责这一个任务 | grp-mwm3q5gw-df0g7d 记忆 | 12 | 2026-11-18 |
| 19 | mem-mwmc68di-ybrsaz | 先做集合匹配（标题/标签/正文相似度，分高/中/低三档），高相似直接复用该集合新增条目，回执注… | key 记忆 | 12 | 2026-11-18 |
| 20 | mem-mwmceuq0-a8f89d | 先做集合匹配（标题/标签/正文相似度分高/中/低三档），高相似直接复用该集合新增条目并在回执注… | key 记忆 | 12 | 2026-11-18 |
| 21 | mem-mwmcnex9-ucr9fc | R22：八项修复完成并重载（记忆集合/派发卡/绿点/面板） | r8 记忆 | 6 | 2026-11-18 |
| 22 | mem-mwmcpcf1-i5qgso | 本消息是被中断任务的续跑（原派发 dsp-mwmbphig-ks97ye，原分支 branch… | dsp-mwkyjskq-92lsyb 记忆 | 12 | 2026-11-18 |

旧集合：
- supermemory 记忆（mc-mwmcnchi-ri6xeg，12 条，标签 12 个）
- r8 记忆（mc-mwmcnely-8v9uoe，2 条，标签 12 个）
- 写入 记忆（mc-mwmcner7-xo93br，2 条，标签 12 个）
- grp-mwm3q5gw-df0g7d 记忆（mc-mwmcnet9-mf0vgb，2 条，标签 12 个）
- dsp-mwkyjskq-92lsyb 记忆（mc-mwmcneuy-z7ladr，2 条，标签 12 个）
- key 记忆（mc-mwmcnevu-dbwfyz，2 条，标签 12 个）

## After：5 个集合 / 12 条记忆（预演投影）

- 记忆系统：集合、检索与写入：3 条
- 面板、管理台与前端交互：3 条
- 分支派发与协作机制：2 条
- 构建、测试与重载闸门：2 条
- 环境、路径与仓库同步：2 条

## 迁移映射（12 条保留条目的最终归属）

| id | 最终标题 | 旧集合 → 新集合 | 变更 |
|---|---|---|---|
| mem-mwmcnex9-ucr9fc | R22：八项修复完成并重载（记忆集合/派发卡/绿点/面板） | r8 记忆 → 记忆系统：集合、检索与写入 | — |
| mem-mwmceuq0-a8f89d | 记忆写入先做集合匹配（高/中相似复用、低相似新建） | key 记忆 → 记忆系统：集合、检索与写入 | 标题、标签 |
| mem-mwkvpvt2-o0krs2 | R9–R11：分支能力继承、标题/标签/正文检索、话题集页签 | supermemory 记忆 → 记忆系统：集合、检索与写入 | 标题 |
| mem-mwkuup1h-rfvc6d | R14 需求：中枢会话改 composer 布局并就地触发对话 | supermemory 记忆 → 面板、管理台与前端交互 | 标题、标签 |
| mem-mwkv5n2p-vwum3n | R8：中枢会话 composer 布局与首条消息直送 | r8 记忆 → 面板、管理台与前端交互 | 标题、标签、正文合并/补注 |
| mem-mwkwzlw2-wszibc | R18：中枢侧栏/自动三层/分支能力/徽标修复/前端改版（含验收） | supermemory 记忆 → 面板、管理台与前端交互 | 标题、标签、正文合并/补注 |
| mem-mwkysqcq-jbbgqm | R19：并行多分支、关联分支展示与一话题集多中枢 | supermemory 记忆 → 分支派发与协作机制 | 标题 |
| mem-mwkytofa-m9t57p | R20：分支先干活、问题上交中枢、中枢一次提问 | supermemory 记忆 → 分支派发与协作机制 | 标签 |
| mem-mwm4s24n-bly8s9 | R21：全量测试轮、7 处前端 bug 与能力 exit 127 根治 | supermemory 记忆 → 构建、测试与重载闸门 | 标题、标签 |
| mem-mwm3gz5g-1f715w | 面板「加载失败」根因：客户端 listTools 声明缺 cwd | supermemory 记忆 → 构建、测试与重载闸门 | 标题、标签 |
| mem-mwm2i0r9-63205r | git 同步：origin/HEAD 状态、提交历史与 GCM 推送凭据 | supermemory 记忆 → 环境、路径与仓库同步 | 标题、标签、正文合并/补注 |
| mem-mwm3msyt-1unad2 | 内置 git-sync 能力 scope 从插件位置推导（v2） | supermemory 记忆 → 环境、路径与仓库同步 | 标题、标签 |

## 删除 / 吸收清单（10 条）

| id | 原标题 | 处理 | 理由 |
|---|---|---|---|
| mem-mwm3hbj6-0vrci3 | 写入结论性记忆（标题+标签+正文：根因、修复位置、验证结果、生效条件） | 删除 | 占位：复述写入规则、无任何结论内容 |
| mem-mwm3nb8q-7fi9ub | 写结论性记忆 | 删除 | 占位：正文仅 7 字「写结论性记忆」，无结论内容 |
| mem-mwm3sim8-2b610a | 本任务是并行组 grp-mwm3q5gw-df0g7d 的一员：只负责这一个任务 | 删除 | 派发包装文本（并行组说明），是过程消息不是结论 |
| mem-mwmbx5th-pzz88r | 本任务是并行组 grp-mwmbphig-uy8ihi 的一员：只负责这一个任务 | 删除 | 派发包装文本（并行组说明），是过程消息不是结论 |
| mem-mwm4wh5d-w3fk69 | 本消息是被中断任务的续跑（原派发 dsp-mwkyjskq-92lsyb，原分支 branch… | 删除 | 续跑包装文本（被中断任务说明），是过程消息不是结论 |
| mem-mwmcpcf1-i5qgso | 本消息是被中断任务的续跑（原派发 dsp-mwmbphig-ks97ye，原分支 branch… | 删除 | 续跑包装文本（被中断任务说明），是过程消息不是结论 |
| mem-mwmc68di-ybrsaz | 先做集合匹配（标题/标签/正文相似度，分高/中/低三档），高相似直接复用该集合新增条目，回执注… | 并入 mem-mwmceuq0-a8f89d | 与 mem-mwmceuq0 近重复；后者表述更完整（「并在回执注明」），本条无独有信息 |
| mem-mwl4tso5-mlaney | SuperMemory 仓库同步：sync 脚本凭据方案失效，改用 GCM 默认路径推送 | 并入 mem-mwm2i0r9-63205r | 已并入 git 同步条目：凭据失效原因、GCM 路径、退出码 1 事实全部保留 |
| mem-mwl4v8sy-jbnr4d | SuperMemory 仓库已同步云端：origin 为内网 Gitee，main↔origin | 并入 mem-mwm2i0r9-63205r | 已并入 git 同步条目：897a02 提交（49 文件/+12235/−1324）与推送事实全部保留 |
| mem-mwkx49qw-dbeb4j | R18 最终验收：六项需求全部生效（含两处修复：branch 过滤、topicset 工具参数） | 并入 mem-mwkwzlw2-wszibc | 已并入 R18 完成条目：BRANCH_ID_PREFIX 修复、/api/state 复测、参数补齐根因全部保留 |

## 合并后的正文（保留条目）

### R8：中枢会话 composer 布局与首条消息直送

```text
R8 已完成（2026-11-18）：SuperMemory 面板「中枢会话」页签改为 composer 布局（大标题+多行输入+「开始对话」，工作区/Agent 模式/模型/权限为行内 pill，话题集为 chips）；宿主 createHubSession/createTopicSetSession 新增可选 firstMessage（messageFactory + handle.agent.followup 直送首条消息），客户端不再 openSession 跳转，改为就地回执卡 + 「打开会话」。改动：src/panel.ts、src/client/{panel-page.tsx,remote.ts,index.ts,locales.ts}、DEV-NOTES.md §16；typecheck/smoke/build 全绿；已用 plugin_manager 对 include:supermemory 禁用→启用重载，刷新 http://127.0.0.1:49988 生效。另：分支会话没有文件/shell 工具（只有 REA 逆向工具），派发改码任务到分支会失败，需在主 GUI 会话直接做。

（后续更正：R9 起分支会话已继承中枢的文件/shell 能力，本条「分支会话没有文件/shell 工具」的限制已解除，见「R9–R11」条目。）
```

### R18：中枢侧栏/自动三层/分支能力/徽标修复/前端改版（含验收）

```text
R18 完成并验收（2026-11-18，用户六项需求）：①中枢会话侧栏——新增 src/hub-sessions.ts（listHubSessions：过滤 parentSession/subagent/话题集成员含归档，批量读标题，50 条上限，sessionQuery 缺失降级 ctx.sessions.list），并新增 BRANCH_ID_PREFIX='branch-' 恒排除、HUB_ID_PREFIX='session-' 保留；宿主 panel.listHubSessions + wire 三处同步，客户端 panel-page.tsx 改 sm-shell 两栏（760px 折叠），左栏「中枢会话」列表+在线绿点+当前高亮+点击打开+「＋新中枢会话」；真实 /api/state 复测 hubs 11 条、branch- 前缀 0 条、live 1。②自动三层：createTopicSet(cwd,title,tags?,summary?)、memory_new_topicset 参数补齐 tags/summary（原 execute 读但参数未声明，中枢派分支修复）、memory_remember 描述强制 title+tags、面板新建记忆 onBlur 调 suggestMemoryShape 自动补全、新建话题集回读显示 title+tags、createTopicSetSession 首条消息 buildTopicSetOpening 带三层。③徽标 bug 根因：session-badge.tsx 的 badgeCache 永久缓存 {kind:'hub'}，分支后来入集也不显示；修法 branch 永久缓存、hub 8s TTL、导出 invalidateBadge + api.invalidateBadges()。④分支能力：src/capabilities.ts 四档（read/read-write/full/minimal）→ agentCtx.tools.restrict({deny})（必须 agent scope 调，全局 ctx 调会抛 requires a scoped context），src/script-delegation.ts buildDispatchScript 把「本轮能力边界」写进分支首条消息，memory_dispatch 新增 capabilities 参数（默认 read-write）。⑤中枢软约定：supermemory:hub-role systemPrompt（order 901，currentInitiator/scope 判定，分支不注入；已在会话 prompt 生效可见），不摘工具。⑥前端改版：面板 8px 栅格/10px 圆角/tab 下划线/空状态插画/按钮分层；管理台左侧固定五段导航+卡片列表+760px 折叠+明暗双主题。闸门（中枢复跑）：tsc 双 0 错、core 6 / mechanism 38（修复后）/ webui 27 / client-sim OK、build 宿主 9 文件（含 hub-sessions chunk）+ client 87298 字符（89065 bytes）。已 plugin_manager 对 include:supermemory 禁用→启用重载，需刷新 http://127.0.0.1:62590；管理台端口每次重载会变，用 memory_ui 取新令牌 URL。
```

### git 同步：origin/HEAD 状态、提交历史与 GCM 推送凭据

```text
仓库 F:\10-SuperMemory 的 git 同步状态与推送路径（2026-11-18 核实）：远程 origin = http://zrynas.7766.org:8418/旧帐号名/SuperMemory.git（内网 Gitee，主机可达 HTTP 200），本地 main 跟踪 origin/main。R15–R20 的改动已打包为提交 897a02357b85a4a1a1813af56d7287c43192c405（49 文件，+12235/−1324，信息 feat(rounds-15-20): 面板注册自愈 / 中枢 composer 与侧栏 / 记忆记录形态 / 分支问题上交）并已推送，origin/main 与该提交一致。此后 HEAD 更新为 60f0f02「feat(round-26): 工作区隔离 / 能力持续维护 / 分支会话重启保留」，与 origin/main 完全一致，工作区干净、无未跟踪文件。后续同步流程：git fetch origin → 若 origin/main 领先则 pull --rebase；有本地源码改动则 add/commit 后 GIT_TERMINAL_PROMPT=0 git push origin main。凭据：scripts/git-sync-push.sh 的 store 凭据方案已失效（~/.git-credentials 不存在，脚本必报 could not read Username for 'http://zrynas.7766.org:8418'，退出码 1）；当前可用默认 GCM（helper=manager，Windows 凭据存储），若 GCM 也失效再找用户要凭据。仓库内另有 scripts/git-sync-push.mjs / .sh 同步脚本。
```

## 生效与回滚

- 生效：宿主改动需中枢对 `include:supermemory` 禁用→启用重载；重载时自动执行并写备份，日志含备份路径。
- 备份：`DSH_HOME/storages/supermemory-backups/organize-v1-<ISO>.json`（首次写前快照 memories + memory_collections）。
- 回滚：把备份里的两张表写回；离线工具 `scripts/memory-organize.mjs --apply --force` 会先整文件备份，仅供宿主停止时使用。
- 注意：存储 JSON 为 `single` 布局、内存权威，宿主运行中直接改文件会被下一次写覆盖。
