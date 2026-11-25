# CHANGELOG

本仓库采用[语义化版本](https://semver.org/lang/zh-CN/)。首个正式 Release 之前的所有开发轮次（R1–R31，2026-11-16 → 2026-11-23）合并计入 `v1.0.0`。

## [1.3.0] - 2026-11-26

发布轮：R50「单一能力（知识面 SKILL.md + 执行面 sm_cap_<name>）」、R49「关闭组合工具自动入口」与 R51「历史工具序列壳子不再被重新收编」合并发布。自本版起组合工具机制彻底删除，模型可见工具只剩 `sm_cap_*`。全量闸门（typecheck 双工程 + build + 七套冒烟）通过。

### 新增（R51：壳子防护）

- **归档先于迁移**：`migrateCapabilities` 先调用 `archiveShellSkills`（把 `sm-source: sequence`、`sm-flow-*`/`sm-tool-*` 名字、或「当任务需要按…的顺序反复处理同类改动」描述的 SKILL.md 整目录移到 `<skills 根>-archive/<name>` 并写 manifest），再决定任何一行是否成为单元；`cleanupToolize` 在 boot 与 `memory_toolize cleanup` 中同样先归档、再调用 `retireShellUnits`。
- **壳子识别不再只看 `sm-source`**：R50 的迁移会把每个旧行的知识面改写为 `sm-source: capability`，原检测因此失效；R51 以「名字形状 + 工具顺序描述 + 正文模板」共同判定，改写后的壳子仍被识别。
- **已收编壳子幂等退役**：`retireShellUnits()` 把已入行的知识型壳子行置为 `status='retired'`（保留行与归档目录，可回滚）；迁移与重建永不复活 retired 行，`syncCapabilitySkill` 也拒绝为壳子生成知识面。
- **单一记录去重**：知识行与可执行能力指向同一 SKILL.md 时（R50 的行扫描 + 文件扫描双路径产物），知识副本退役，只保留能力记录。
- **单元目录净化**：`memory_toolize` 与面板的能力列表过滤壳子；`memory_toolize cleanup` 新增 `retiredUnits/retiredUnitNames` 计数。
- **回归**：capability-smoke R51-1/R51-2（boot 先归档再迁移、R50 改写后仍识别、人工知识与能力保留、二次启动幂等、迁移自身先归档、无目录壳子可退役）；skill-smoke R51-S1（三种壳子形状、R50 改写面、人工/任务级不误伤、二次归档 0）。

### 变更（行为，R50）

- 单一能力模型：tool_memory 记录 kind: capability | knowledge | proposal。旧 kind='composite' + spec.kind='capability' 惰性迁移为 capability 并改名 sm_composite_<x> → sm_cap_<x>；旧 kind='skill' 行转 knowledge（entry 为空）；旧工具序列行退役（不再注册，仅审计）。迁移幂等，启动时自动执行。
- 执行面契约：每个可执行能力只注册一个工具 sm_cap_<name>，入参只有 dry_run / confirm（固定入口，不接受任意参数透传）；scope 外拒绝；默认预演（dryRunArg）；writeConfirm 必须 confirm=true；超时 120s、输出 8k 截断；执行后累计 runCount/success/fail/consecutiveFailures/lastStatus，连续失败提示更新事实块/文档。
- 知识面事实源：SKILL.md 为正文事实源；自动维护只替换 <!-- sm:facts:start --> … <!-- sm:facts:end --> 事实块（入口、scope、预演参数、验证命令、涉及文件、失败坑），块外人工散文一律保留；无标记手工 skill 首次只追加事实块；bodyHash/factsHash 入库，检测到人工编辑时走 preserved（只刷事实块、升版并在 changelog 记录）。
- 自动提案只产知识：重复任务（≥3 次、≥2 会话、30 天窗口、相似度≥0.85 丢弃）写 kind='proposal' 待接受草稿（pending 上限 20、30 天过期，不占每根 8 个自动上限）；接受时才创建能力并占用额度。高置信入口规则（规范化命令 ≥3 样本、≥2 会话、全部 exit 0、非交互、允许命令家族、无占位符/临时路径、scope=仓库根）只写 entryDraft（verified:false，永不自动执行），人工在面板「启用执行」后才 runnable=true 并注册工具。
- 面板合并：能力列表与 skill 列表合并为单一列表（可执行/仅知识/自动/入口待验证徽标；执行次数、加载次数、转化率、成功率、最后状态；预演执行/启停/启用执行/查看知识面/改描述/删除归档）；提案单独可见可接受/拒绝。
- 统计与转化率：skill 工具加载 sm-* 计 loadCount，执行面计 runCount；面板与 memory_toolize 输出 loadsToRuns 转化率与成功率。
- memory_toolize：accept 只接提案；register 给 entry 产可执行能力、不给则仅知识；enabled 同时启停两个面；cleanup 退役历史序列行/清空 pending/清理宽泛信号/归档壳子 skill；返回保留 capabilities/skills 旧字段并新增统一 units、提案与退役计数。

### 工程（R50）

- 新增 src/capability.ts（迁移、统一记录、执行面、事实块同步、提案、高置信入口、重建/健康度）；删除 src/composite.ts。
- 新增事实块合并与能力知识面生成（src/skill-forge.ts：bodyHash/factsHash、sm-body-hash/sm-facts-hash frontmatter、upsertCapabilitySkill、归档而非删除）。
- 宿主/客户端 descriptor 同步（acceptProposal/declineProposal、runTool 客户端接线）；Web 管理台能力页合并为提案/能力/历史序列三段。
- 冒烟：capability-smoke 重写为 R50-1..9（迁移、sm_cap_ 注册与 dry_run/confirm 闸门、scope 外拒绝、事实块与人工编辑、统计/转化率、内置、提案与 entryDraft、上限/过期、归档删除）；skill-smoke 增补 R50-S12/S14/S15 与 R50-1..3；workspace-scope 重写为 R50 W1–W6；webui/mechanism 断言跟随统一能力。
- 兼容性：存储域 version 1 不变；旧行惰性迁移、可回滚（知识面归档在 <skills 根>-archive，manifest 记录原名/时间/原因）；旧 sm_composite_* 名称只在读取历史记录时映射，绝不回注册。

### 修复（R49：组合工具自动入口）

- **重载后仍自动注册组合工具（根因）**：v1.2.0 的 `maintenance.autoToolize` 默认 true，运行期把 `run_code>run_code` 之类的工具序列攒成了 pending 提议；v1.2.1 虽把自动注册默认关掉，但 `attachProposals` 仍会在每个用户回合的 pre-step 用 `ctx.userQuestions.ask` 询问「要固化为组合工具吗」，而**选项 0 就是「固化为组合工具」**。宿主在本环境瞬时结算该问题（实测 4 ms、会话日志里没有任何 user-question 事件），于是 2026-11-25T16:07:58Z 一条 2706 次的陈旧 pending 被自动接受：注册并持久化 `sm_composite_run_code_run_code`，同时向对话注入「已固化」通知；而 `recordTurnSequences` 每次跨越都把 `proposalStatus` 重写成 `pending`，所以提议每轮又回来（实测 3 条 run_code 序列、2708 次）。`rebuildComposites` 每次启动又会把这类持久行原样注册回来——这才是「重载也还在」的机制。修法：删除 `attachProposals` 的提问/固化路径；阈值跨越、启动扫尾、过程内重复三条自动路径一律只观察、不注册。
- **宽泛工具序列过滤**：新增 `proposalVerdict` / `isBroadSequence`（`src/toolize.ts`）——任一步骤是 `run_code`、`bash`、`read`、`edit`、`write`、`glob`、`grep`、`todo_write`、`skill`、`wait_agent`、`send_message` 等通用工具，或属于 `memory_*` / `sm_composite_*` / `job_*` 等通用族，整条序列不生成候选、不落 signal、不进 pending；显式 accept 同样拒绝。
- **存量清理幂等**：`retireAutoSequenceComposites` 只停用「来源是自动序列形状（`/seq/`）+ 序列宽泛 + 非 capability + 未标 `origin:'manual'`」的行，人工能力（如 `sm_composite_git_sync_supermemory`）与显式 accept 的行不动；`clearSequenceSignals` 一次清空 pending 与全部宽泛序列信号。启动时**先清理再 rebuild**，重载即净化。

### 变更（R49）

- `memory_toolize cleanup` 扩展为一次性清理组合工具壳子 + 无价值 pending + 归档 skill，返回分别计数 `archivedSkills` / `retiredComposites` / `clearedProposals`（以及 `prunedSignals` / `pendingBefore` / `pendingAfter` / `retired`），并保留 R48 的 `archived` / `archivedCount` / `archiveRoots`，向后兼容。
- `maintenance.autoComposite` / `autoToolize` 语义收窄为「是否允许留下待接受提议」，任何取值都不能再注册组合工具（默认 false 时序列管线不写任何东西）；`toolizeCooldownMs` / `toolizeMax` 停用但保留键，避免旧配置报错。

### 工程（R49）

- mechanism 冒烟 B1/B2 改写为 R49 语义（空检测试与启动清理）；skill-smoke 新增 R49-1..R49-6：宽泛过滤、阈值跨越不注册（开关开/关）、显式 accept（origin=manual 幂等）、清理只动自动壳子、三计数与向后兼容字段、pending 清空后不复发。
- 对当前 `~/.dsh/storages/supermemory.json` 快照执行同一清理逻辑（重载时由 boot 路径自动执行）：停用 4 个自动组合工具（`sm_composite_run_code_run_code`、`sm_composite_memory_recall_memory_rec`、`sm_composite_memory_topicsets_memory_`、`sm_composite_sm_composite_git_sync_su`），清空 2 条 pending、清除 526 条宽泛序列信号；二次执行 0/0/0；`sm_composite_git_sync_supermemory` 人工能力保持 active（useCount 19）。

### 兼容性

- 存储域 `supermemory` version 1 不变；`tool_memory.entry` 里的 spec 新增可选 `origin`（旧行缺省按形状判定），无强制迁移。
- 语义变化（有意）：工具序列组合工具不再有任何自动来源；模型可见执行面只有 `sm_cap_*`；历史壳子只归档不删除，可按 manifest 回滚。
- 面板安装：`.tgz` 直链（含稳定别名）或 Git 仓库地址；Release 页面 URL 与 `.zip` 资产仍不被安装器接受。

### 已知限制

- 正在运行的 v1.2.1 实例在重载前仍会继续写 signal（修复只对新实例生效）；重载后 boot 清理会把存量一次清掉。
- 当前进程可能仍残留旧 `sm_composite_*` 工具注册（R49 前注册的），必须完全退出并重启 DSH Desktop（不是仅禁用/启用插件）后才只剩 `sm_cap_*`。
- `recordTurnSequences` 里 `ctx` / `deps` 参数保留仅为签名兼容，自动路径已不再使用注入的宿主注册器。

### 发布（v1.3.0）

- 资产：`dsh-supermemory-1.3.0.zip`（手动安装）、`dsh-supermemory-1.3.0.tgz`（npm-pack 结构，面板安装器可直接消费）、稳定别名 `dsh-supermemory.tgz`（`.../releases/latest/download/dsh-supermemory.tgz`）。
- 三资产同时上传 GitHub Release 与 Gitea Release，附 sha256；安装自检：临时空目录 `pnpm add <tgz>` 后版本 1.3.0、`lib/supermemory.js` 存在。


## [1.2.1] - 2026-11-25

发布轮：R48「任务级 skill 识别 + 旧工具序列壳子清理」与发布资产补齐。自本版起每个 Release 同时提供版本 tgz 与稳定别名 tgz，DSH 插件面板可用固定 URL 直接安装。全量闸门（typecheck + 七套冒烟）通过。

### 新增

- **任务级 skill（R48）**：自动固化不再以「连续用过哪些工具」为主体特征，改以任务签名（`src/task-signature.ts`）识别「做过的事」——动词 + 主对象（如 `fix/skill-forge`、`release/package`），文件/命令证据只作佐证，工具序列完全不参与 key 与命名。名称 `sm-<动词>-<对象>`（保留 `sm-` 命名空间），描述写「何时用 + 真实步骤/坑/验证」，正文六节；frontmatter 新增 `sm-task-key`，同一任务改名/合并可找回原文件。同一任务需跨会话（默认 ≥2 个会话/派发、≥3 次、30 天窗口）才自动生成，每个根上限 8 条。
- **存量壳子清理**：新增 `archiveShellSkills()` 与 `memory_toolize cleanup` / `pnpm skill:cleanup [--dry-run]`；只归档 `sm-source: sequence` 且命名/描述符合工具序列壳子的 skill，目录整体移到 `<skills 根>-archive/<name>` 并写 `manifest.json`，可回滚、幂等，人工/manual skill 不动。插件启动时也会自动扫一次。
- **发布资产**：`release/dsh-supermemory-1.2.1.tgz`（npm-pack 结构，面板安装器可直接消费）与稳定别名 `dsh-supermemory.tgz`，对应固定 URL `.../releases/latest/download/dsh-supermemory.tgz`；版本化 zip 仍供手动安装。

### 变更

- 一次请求内的工具重复不再直接生成 skill（改由回合末维护按任务记录、跨会话计数），避免同一轮双重计数与单会话误生成。
- 新增配置 `maintenance.skillMinSessions`（默认 2）与 `maintenance.skillRecencyDays`（默认 30）；`maintenance.autoSkill` 的说明同步更新。
- `signals` 表新增可选 `sessions` / `dispatches` 字段（旧行读作缺省，存储域 version 仍为 1）。

### 同时包含（v1.2.0 之后合入）

- R44–R47 集成（面板页签结构 / skill 主路径与组合工具降级 / 注入截断修复 / 发布资产脚本与文档），详见 `DEV-NOTES.md` §55–§59；从 v1.2.0 升级即同时获得，本节不重复细节。

### 工程

- 七套冒烟；`scripts/skill-smoke.mjs` 扩充任务签名、合并、壳子不生成、清理幂等断言；新增 `scripts/skill-cleanup.mjs` CLI。
- 发布流程：版本 zip + 版本 tgz + 稳定别名 tgz 三资产；提交与 tag 双推 GitHub/Gitee，Release 上传后核验名称/大小/摘要。

### 兼容性

- 宿主要求 DSH `>=0.2.0 <0.3.0` 不变；存储域 `supermemory` version 1 不变，无强制迁移。
- 面板安装：`.tgz` 直链（含稳定别名）或 Git 仓库地址；Release 页面 URL 与 `.zip` 资产仍不被安装器接受。

### 已知限制

- 任务文本过短或只有泛化指令时宁可不出 skill（自动生成量会下降，有意为之）；同一任务不同措辞可能落到不同 key，靠命名相似度丢弃近似项。
- 分支会话不能重载插件；重载与 GUI 验收由中枢/用户执行。

[1.3.0]: https://github.com/FrogMoo/SuperMemory/releases/tag/v1.3.0
[1.2.1]: https://github.com/FrogMoo/SuperMemory/releases/tag/v1.2.1

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
