# CHANGELOG

本仓库采用[语义化版本](https://semver.org/lang/zh-CN/)。首个正式 Release 之前的所有开发轮次（R1–R31，2026-11-16 → 2026-11-23）合并计入 `v1.0.0`。

## [1.4.1] - 2026-11-26

发布轮（R59b）：**许可证改为 MIT**（此前是自定义专有「保留所有权利」声明），并把版本抬到 **1.4.1** 作为 **npm 首发版本**。

### 变更（许可与首发版本）

- `LICENSE`：整篇替换为标准 **MIT 全文**，署名沿用原文 `Copyright (c) 2026 Zry (GitHub: FrogMoo)`（未丢署名）。
- `package.json`：`license` 由 `UNLICENSED` 改为 **`MIT`**；`version` 1.4.0 → **1.4.1**；其余字段（`name` / `publishConfig` / `files` / `scripts` / `dsh` / `engines`）一律不变。
- **版本策略**：v1.4.0 的提交、附注 tag 与 GitHub Release 已经推到远端且指向「专有许可」的那次提交，按约定**不移动、不删除、不重建**；许可变更与 npm 首发改由 1.4.1 承载。npm registry 上此前没有任何版本（v1.4.0 的 publish 曾被 2FA 403 拦下），因此 **1.4.1 就是 npm 上的首个版本**。
- 文档：README / INSTALL / `docs/release.md` 里「1.4.0 起可用 npm」的说明补注「npm 首发 1.4.1」；CHANGELOG 历史条目保持原样（当时确实是专有许可）。
- 未改动：包名、文件清单、发布资产名约定（`dsh-supermemory-<版本>.zip/.tgz`）、存储域 `supermemory`、工具/远程协议。

### 测试（R59b 新增断言）

- core-smoke：`pkg.license === 'MIT'`，且 `LICENSE` 文本以 `MIT License` 开头。

### 闸门（本轮实测）

- `pnpm build` **exit 0**（lib 产物与 1.4.0 逐字节相同：包名未变，wrapper id 仍为 `@frogmoo/dsh-supermemory`）。
- `pnpm typecheck` **exit 0**（宿主 + client 双工程，0 错）。
- `pnpm smoke` **exit 0**：core **43** / mechanism **120** / webui **35** / client-sim **OK** / capability **20 组** / workspace-scope **6 组** / skill **27 组断言**。
- `npm pack --dry-run`：版本 **1.4.1**、license **MIT**、**20 条目**（`lib/` 14 文件 + package.json / cordis.patch.yml / README / LICENSE / CHANGELOG / INSTALL），**不含** `src/`、`scripts/`、`node_modules/`、`release/`。

### 发布方式

- GitHub：提交 + 附注 tag `v1.4.1` + **source-only** Release（不上传自建资产，仅 GitHub 自动生成的源码归档）。
- npm：由仓库维护者在自己的终端执行 `npm publish --access public`（需 2FA OTP）；本仓库不代为发布。

## [1.4.0] - 2026-11-26

发布轮（R59）：**包身份迁移到可发布的 scoped 名 `@frogmoo/dsh-supermemory`（1.4.0）**，为发布到公共 npm registry 做准备——只有 registry 来源在 DSH 插件页才会出现「版本 → 重新检查 / 可更新到 x」。功能、工具协议、存储域（`supermemory` v1）均未变。

### 变更（包身份与发布面）

- `package.json`：name `dsh-supermemory` → `@frogmoo/dsh-supermemory`；去掉 `private`；新增 `publishConfig`（`access: public` + `registry: https://registry.npmjs.org/`，只影响发布、不改安装源）；version 1.3.5 → 1.4.0。
  - 版本策略：破坏面仅是「安装来源标识」——profile 依赖键、`dsh.profile.bundles` 选择项、客户端模块 id 都随包名变化；用户可见功能 / 存储 / 工具协议不变，故按 **minor** 而不是 major 升。
- `cordis.patch.yml`：`insert.name` 改为 scoped 包名（loader 行 id 仍是短 slug `supermemory`）。DSH 的 bundle 选择按**包名**记录，安装器会把它写进 `dsh.profile.bundles`。
- `scripts/wrap-client.mjs`：客户端 bundle 的 `__ModuleLoader__.load({id})` 改为**从 package.json 读取包名**（宿主 clientModules 以清单名生成 `window.__DSH_BOOT__` 与 `/plugins/<id>/client.js`，写死会随改名失效；已装 scoped 插件 `@michengai/dsh-skills-manager` 即此形态）。
- `src/builtin-capabilities.ts`：仓库根推导同时接受新旧两个包名；`src/task-signature.ts` 的上下文词表补 scoped 名。
- `scripts/install-into-dsh.mjs`：使用新的依赖键与 bundles 项，并**自动迁移**旧草稿名（`dsh-supermemory`）的依赖项与激活项（避免同一插件挂两次 / 旧行解析不到新 patch）。
- `scripts/package-release.mjs`：npm 会把 scoped 名归一成 `frogmoo-dsh-supermemory-<v>.tgz`，脚本在本地改名回既有资产约定 `dsh-supermemory-<v>.tgz`（**Release 资产名保持不变**）。
- 公开发布包脱敏：内置能力描述与整理计划文本里的内网 Gitee 主机名改为占位；内置能力 `git-sync-supermemory` v6 → v7，让已装实例升版时把知识面里的主机名一并替换。
- `files` 收敛为 `lib` / `cordis.patch.yml` / `CHANGELOG.md` / `INSTALL.md`：**npm 包不再分发 `src/`**（运行时只需 `lib/`；LICENSE、README 由 npm 自动包含）。
- 清理悬挂条目：仓库没有 `locale/` 目录（语言包在 `src/client/locales.ts` 内随客户端 bundle 发布），因此从 `files` 删掉 `locale`、从 `exports` 删掉 `./locale/*.json` —— 这两处自始就解析不到文件，留着只会误导发布面。（若无 `locale` 目录，`exports` 子路径在安装后也必然 404。）
- 新增脚本：`prepublishOnly: pnpm run build`（仅 `npm publish` 触发，`pnpm pack` 不触发）与 `publish:npm: npm publish --access public`。
- 文档：README §5、INSTALL 方式 A、`docs/release.md` §6.5 写清 **npm 包名 `@frogmoo/dsh-supermemory` 与 GitHub 仓库名 `FrogMoo/SuperMemory` 是两回事**，并给出发布前置（登录 / 2FA / token）、干跑与发布后校验。

### 测试（R59 新增断言）

- core-smoke R58 段：包名 = `@frogmoo/dsh-supermemory`、无 `private`、`publishConfig` 精确、`cordis.patch.yml` 的 `insert.name` = 包名、行 id 仍为 `supermemory`。
- client-sim：客户端 bundle 的 registration id = `@frogmoo/dsh-supermemory`。

### 闸门（本轮实测）

- `pnpm build` exit 0（宿主 13 文件 931.55 kB；client 181.81 kB；wrapper id = scoped）。
- `pnpm typecheck` exit 0（宿主 + client 双工程，0 错）。
- `pnpm smoke` exit 0：core **43** / mechanism **120** / webui **35** / client-sim **OK** / capability **20 组** / workspace-scope **6 组** / skill **27 组**。
- `pnpm pack`（DSH 自带 pnpm 11.28.5）exit 0：**20 条目 / ≈349 kB**（首次打包 346,729 B；写入本节后 348,887 B），含 `package.json`、`cordis.patch.yml`、README、LICENSE、CHANGELOG、INSTALL 与 `lib/` 14 个文件；**不含** `node_modules/`、`src/`、`scripts/`、`release/`、`.dsh/`、`.git`。
- 敏感串扫描（解包后全量 grep）：内网主机名 0、内网 IPv4 0、凭据赋值 0、token 前缀 0、私钥 0、用户主目录路径 0；回环地址 4 处（webui 服务器代码）与 1 处 GitHub noreply 邮箱（CHANGELOG 提交身份）为可公开内容。
- 临时目录安装：`pnpm add <tgz>`（pnpm 11.28.5，`nodeLinker=hoisted`、`autoInstallPeers=false`）exit 0，3.8 s，装出 `@frogmoo/dsh-supermemory@1.4.0`；`import.meta.resolve` 解析 `.` 与 `./client` 成功，`cordis.patch.yml` 可读；保存形态 `file:<tgz 绝对路径>`。

### 升级说明（重要）

- 仍以旧草稿名安装（`link:` 或 `github:`）的机器：**先 `pnpm install:dsh` 再重启 DSH**——它会迁移依赖键与 bundles 项；直接重启会让 scoped 行名在旧 profile 里解析不到，插件整包不加载。
- 想获得插件页的「检查更新」：改用 npm 包名 `@frogmoo/dsh-supermemory` 安装（Git / 本地目录 / tgz 来源在 DSH 0.2.2 都没有版本检查入口）。

## [1.3.5] - 2026-11-26

发布轮（R57）：**上下文注入卡的折叠标题（宿主「上下文注入 <label>」的 label）按内容区分**。R56 改的是卡片内容首行；宿主的 label 仍取消息 `source.kind`（一律 `supermemory`），所以 GUI 里所有注入卡的折叠标题只有「上下文注入 supermemory」一种（分支卡再叠加旧 summary「SuperMemory 中枢分支概览」）。本轮让每类注入用**自己的注册 label 作 `source.kind`**：卡片标题即 `上下文注入 supermemory-相关记忆 / 相关话题 / 相关分支会话 / 相关能力 …`，与内容首行同一注册项（同 kind 同源）。全量闸门（typecheck 双工程 + build + 七套冒烟）通过。

### 变更（R57：卡片标题按内容区分）

- **根因（宿主行为，已用 DSH 0.2.2 产物核实）**：`dsh-client-ui-chat/src/client/conversation-nodes/event-projection.ts:60` 的 `contextProducer(source)` 在 default 分支把 `label` 直接取为 `source.kind`（宿主注释：「keep an unknown producer visible by its durable kind」）；`src/client/chat/ContextInjectionRow.tsx:57` 的标题前缀是固定文案「上下文注入」（locale `message.contextInjection`；role `recall` 时为「跨会话召回」），`:69` 渲染 `producer.label`，`:70-73` 只在 `form='notice'` 时追加 `source.summary`。宿主产物里 `supermemory` 字面量为 **0**——没有特判，卡片标题能否区分完全取决于 `source.kind`，**不需要改 DSH asar**。
- **注册表新增 label 访问函数**：`src/injection-titles.ts` 增 `injectionLabel(kind)`、`INJECTION_LABEL_PATTERN`，`injectionTitles()` 每行带 `label`；`injectionTitle(kind)` 保持 `'[' + label + ']'`。模块注释写清「卡片标题（label）/ 内容首行」两层命名与宿主证据。
- **新增 `injectionSource(kind, form?)`**（`src/source.ts`）：注入 source 的 `kind` 一律取 `injectionLabel(kind)`；九个 label 同时合并进 `MessageSourceMap` 类型（宿主「未知 producer 按 durable kind 显示」的合并扩展点，类型与运行时一致）。
- **接线**：`src/prestep.ts`（相关记忆 `memory`、过程内补充 `memoryRepeat`、分支卡 `branch`、能力索引 `capability`）与 `src/route.ts`（相关话题 `topic`、相关话题候选 `topicCandidate`）全部改走 `injectionSource`；两个文件不再出现 `kind: 'supermemory'` 作为卡片 label。
- **分支卡去掉旧 summary**：原 `form: 'notice'` + `summary: 'SuperMemory 中枢分支概览'` 会在标题后再追加一段；label 已命名卡片，改为纯 label source（GUI 标题即「上下文注入 supermemory-相关分支会话」）。能力索引卡同理。
- **不动的部分**：relay/派发/续跑等消息传输头，以及 relay/派发消息的 `source.kind`（`observe.ts` 用 kind `supermemory` + `deliveryId` 确认投递；这些卡由插件自己的客户端卡片渲染，不走宿主注入行）；中枢角色提示与插件提示是 systemPrompt（没有卡片行），中断公告是 relay 卡——三者仍由注册表统一持有名字。
- **历史消息不回写**：升级前写入的 `source.kind='supermemory'` 保持原样显示「上下文注入 supermemory」。

### 测试（R57 新增断言）

- **R57-1** 九类注入的卡片 label 精确匹配注册表裸名、彼此唯一、无方括号；内容首行 = `[label]`（同一注册项）。
- **R57-2** `injectionSource(kind).kind === injectionLabel(kind)`；分支卡 source 只带 label（无 form/summary，宿主不会再追加 summary 段）；label 卡不会被 `isDispatchInput` 认成派发输入。
- **R57-3** 注入**调用参数**断言：`prestep.ts` 传 memory/memoryRepeat/branch/capability、`route.ts` 传 topic/topicCandidate；两文件不得手写 `kind: 'supermemory'` 且都经 `injectionSource` 构造；prestep 不再声明 notice form。
- **R57-4** 旧卡片标题段 `SuperMemory 中枢分支概览` 在 `src/` 与 `lib/` 为 0；构建产物携带新 label。
- 既有断言更新：R56-4 的构建产物断言改查 **label** 字面量（方括号标题在运行时拼接，bundle 里的持久字面量是 label）；client-sim 增加 label-kind context 行仍委托宿主渲染的用例。

### 变更（版本）

- 版本 1.3.4 → 1.3.5（patch：卡片标题/呈现变化，无行为变更与存储结构变更；存储域 `supermemory` version 1 不变）。
- 升级后需**完全退出并重启 DSH Desktop**（不是禁用/启用插件、也不是刷新窗口）才能看到新卡片标题。

## [1.3.4] - 2026-11-26

发布轮（R56）：统一**上下文注入卡标题**命名并固化成约定。四类注入卡改名，全部标题改由注册表 `src/injection-titles.ts` 产出——渲染处不再手写标题字符串，新增注入卡必须「登记 → 渲染 → 测试 → 文档」。全量闸门（typecheck 双工程 + build + 七套冒烟）通过。

### 变更（R56：注入卡标题统一）

- **四张卡改名**（用户要求）：话题集注入 `[SuperMemory 话题集]` → `[supermemory-相关话题]`；相关记忆注入 `[SuperMemory 相关记忆]` → `[supermemory-相关记忆]`；关联分支注入 `[supermemory 关联分支]` → `[supermemory-相关分支会话]`；可用能力注入 `[SuperMemory 可用能力]` → `[supermemory-相关能力]`。
- **同族/同规则卡一并收口**：话题候选 `[SuperMemory 话题提示]` → `[supermemory-相关话题候选]`（相关话题族子卡）；过程内补充 `[SuperMemory 相关记忆 · 过程内补充]` → `[supermemory-相关记忆补充]`；中枢角色提示 `[SuperMemory 中枢会话]` → `[supermemory-hub-role]`；插件记忆使用约定 `[SuperMemory 记忆]` → `[supermemory-plugin-prompt]`；中断任务公告 `[SuperMemory] 检测到…` → `[supermemory-notice] 检测到…`。
- **注册表**（新增 `src/injection-titles.ts`）：`INJECTION_TITLES`（9 个 kind 的裸名）、`injectionTitle(kind)`（带方括号标题）、`injectionTitles()`（注册表快照）、`INJECTION_TITLE_PATTERN`（约定正则）。约定写进模块注释：① 所有注入卡以 `supermemory-` 开头；② 相关内容类用 `supermemory-相关<主题>`；③ 功能性卡用 `supermemory-<功能>`（小写 kebab、ASCII）；④ 禁止在渲染处手写标题字符串；⑤ 新增卡必须先登记，再渲染、测试、写文档。
- **relay 前缀例外（明确不改）**：`[supermemory-relay <branch>]`、`[supermemory-group-relay <group>]`、`[supermemory-dispatch <id>]`、`[supermemory-resume <id>]`、`[supermemory-questions]`、`[supermemory-panel-reply]`、`[supermemory-topic-set]` 是会话间**消息头**（携带 id，relay/派发管线解析），不属于上下文注入卡；改名会破坏回送，保持原样。
- **接线（全部改走注册表）**：`src/route.ts`（相关话题 / 相关话题候选）、`src/recall.ts`（相关记忆）、`src/inrequest.ts`（相关记忆补充）、`src/hub-branches.ts`（相关分支会话）、`src/capability.ts`（相关能力）、`src/hub-role-text.ts`（中枢角色提示 + 卡名引用）、`src/index.ts`（插件提示 + 卡名引用）、`src/resume.ts`（中断公告）。

### 测试（R56 新增断言）

- **R56-1** 四张注入卡标题精确匹配（含方括号）+ 话题候选归入相关话题族。
- **R56-2** 注册表内所有标题匹配 `^\[supermemory-(相关.+|[a-z][a-z-]*)\]$`、互不重复、裸名不带方括号。
- **R56-3** 渲染路径断言：六类卡（相关话题 / 相关记忆 / 相关记忆补充 / 相关分支会话 / 相关能力 / 相关话题候选）+ 中枢角色提示 + 中断公告的首行都是注册标题；极小预算降级态仍保留注册标题且不破预算。
- **R56-4** 旧标题归零：递归扫描 `src/`（ts/tsx）无旧标题字面量；渲染处禁止手写 `[supermemory-` 卡片标题（仅允许 relay 等 7 类传输前缀白名单）；八个渲染文件必须 import 注册表并使用 `injectionTitle`；构建产物 `lib/*.js` 同样无旧标题且带新标题。
- 既有断言更新：`core-smoke` 关联分支卡头、`mechanism-smoke` 话题提示卡头与过程内补充卡可区分性；R47 注入预算/裁剪断言全部仍绿。

### 变更（版本）

- 版本 1.3.3 → 1.3.4（patch：标题/文案变更，无行为变更与存储结构变更；存储域 `supermemory` version 1 不变）。
- 升级后需**完全退出并重启 DSH Desktop**（不是禁用/启用插件、也不是刷新窗口）才能看到新标题。

## [1.3.3] - 2026-11-26

发布轮（R55）：把「中枢 = 判断与派发、分支 = 执行」从软提示升级为**结构性边界**。中枢现在可以**只读**检查固化能力的知识面（`sm_cap_doc`，默认允许且锁定），但**不能执行** `sm_cap_*`：中枢调用返回专用错误码 `HUB_CAPABILITY_EXEC_DENIED` 并提示派发分支，执行面同时从中枢可见工具列表中隐藏。全量闸门（typecheck 双工程 + build + 七套冒烟）通过。

### 新增（R55：中枢只读检查）

- **`sm_cap_doc` 纳入中枢默认允许 + 锁定**：加入 `LOCKED_HUB_TOOLS` 与 `DEFAULT_HUB_TOOLS`，与 `memory_dispatch`/`memory_recall` 同级——即使工作区已存的白名单行没有该项，守卫也按内置锁定项放行（`isHubAllowedTool` 先判锁定项），面板不可取消。
- **一次性合并迁移**：`mergeLockedHubPolicies` 在启动时把锁定项合并进每个 `hub_policies` 存储行（写回 `updatedAt`），meta 行 `hub-policy-locked` 记录版本/行数；已经有标记时二次启动零写入，`ignoreMarker` 可强制重扫，重扫同样幂等。合并只改「存储行是否如实」，不是权限变更（守卫本来就放行锁定项）。
- **角色限制**：`sm_cap_doc` 仅中枢/分支可读；普通会话（非中枢/非分支）调用返回 `CAPABILITY_DOC_ROLE_DENIED`（工具仍在注册面上，错误是明确解释，不是 `UNKNOWN_TOOL`）。

### 收紧（R55：中枢执行禁令）

- **专用错误码 `HUB_CAPABILITY_EXEC_DENIED`**：中枢调用 `sm_cap_*`（含历史 `sm_composite_*` 前缀）被拒绝，提示「中枢不能执行固化能力；请用 memory_dispatch 派发到分支，任务里写明能力名、是否先预演、写操作需 confirm=true」。该判定在角色守卫里**先于**泛化白名单拒绝，模型得到的是可纠正的指令，而不是「去面板勾选」的错误暗示。
- **工具面收敛**：能力执行工具的注册 `when` 条件叠加 `capabilityVisibleToCaller`——中枢的 step 工具列表里**不再出现** `sm_cap_*`（宿主 `ToolRegistrationOptions.when` 会同时排除声明与分发）；分支/普通会话、以及无 agent 的宿主侧调用不受影响。`sm_cap_doc` 始终注册，保证中枢的只读检查可用。调用期守卫仍然保留为第二层（隐藏失败时照样拒绝）。
- **分支执行不变**：scope/工作区闸门、默认预演、`writeConfirm` 需 `confirm=true`、超时/输出裁剪、统计口径全部沿用 R50，无行为变更。

### 路由与文案

- `HUB_ROLE_TEXT` 抽出为独立模块 `src/hub-role-text.ts`（可测试），新增「能力检查（R55）」步骤：先用 `memory_toolize` 看 units（名称/徽标/何时用/入口是否待验证），需要细节时用 `sm_cap_doc` 读正文判断适用性；确认执行时不要自己调 `sm_cap_*`，用 `memory_dispatch` 派发到分支并在任务文本里带能力名 + 是否先预演 + `confirm=true`，分支回报后中枢汇总。
- `CAPABILITY_ROUTING_RULES` 增加 ⑤ 职责边界；能力索引卡 footer 增加「中枢只读，执行需派发分支」；`sm_cap_doc` 工具描述写清错误码与角色限制。
- 面板「中枢权限」页签：`sm_cap_doc` 显示「锁定」+「只读路由，锁定」徽标，`sm_cap_*` 显示「中枢不可执行」徽标（含提示：勾选也不会让中枢获得执行权）；目录项新增 `noteKey: capabilityDoc | capabilityExecDenied`（动态目录与内置回退目录一致）。

### 测试（R55 新增断言）

- R55-1：hub 调 `sm_cap_doc` 通过、普通 shell 会话 `CAPABILITY_DOC_ROLE_DENIED`、hub 调 `sm_cap_*`/`sm_composite_*` 返回 `HUB_CAPABILITY_EXEC_DENIED`（含派发/confirm 文案）、branch 读取与执行均通过；`sm_cap_doc` 读取链路 `loadCount+1`（连续两次 1→2）。
- R55-2：能力注册的 `when` 闸门对 hub 返回 false、branch/无 agent 返回 true；branch 执行默认预演成功；`sm_cap_doc` 仍注册且不带执行面闸门（源码接线断言）。
- R55-3：`HUB_ROLE_TEXT` 含「能力检查」与派发/预演/confirm 指令；索引卡含「中枢只读，执行需派发分支」；面板源码渲染两个徽标、locale 含中文文案。
- R55-4（mechanism）：旧存储行一次性合并 + meta 标记 + 二次幂等 + 强制重扫零改动；面板服务把 `sm_cap_doc` 标为 locked/capabilityDoc/enabled，把 `sm_cap_*` 标为 capabilityExecDenied/默认未启用；保存与清理都不能移除锁定项；内置回退目录同样锁定。

### 变更

- 版本 1.3.2 → 1.3.3（patch：R55 行为/界面变更；存储域 `supermemory` version 1 不变，无破坏性存储变更）。
- 角色守卫版本 3 → 4（`role-guard` meta 标记会随之刷新）。

### 已知限制

- 工具面隐藏依赖宿主的 `ToolRegistrationOptions.when`（DSH 0.2.x 支持）；不支持条件注册的旧宿主上，能力工具仍会出现在列表里，但**调用期守卫同样返回 `HUB_CAPABILITY_EXEC_DENIED`**，边界不丢失。
- 中枢通过 PTC `run_code` 直接调用宿主/Node API 不受工具白名单约束（既有已知限制，见 DEV-NOTES §42/§43）；R55 只约束 `sm_cap_*` 工具面。
- 升级后仍需**完全退出并重启 DSH Desktop**（不是禁用/启用插件、也不是刷新窗口），一次性合并与守卫版本才生效。

## [1.3.2] - 2026-11-26

修复轮（R54）：修掉 R52 只读验收发现的 3 个 P2（版本元数据回退、健康统计口径矛盾、注入卡提示语用机器名），并为每一项补上回归断言。全量闸门（typecheck 双工程 + build + 七套冒烟）通过。

### 修复（R54：R52 验收 P2）

- **P2-1 知识面版本回退（按 P1 处理）**。根因：R52 的迁移是「先归档、后生成」，当旧 `sm-<name>/SKILL.md` 在更早的启动里已被归档、而 `.dsh/capabilities/<name>.md` 尚不存在时，重渲染只看能力记录的 `version`（6），生成的 live 文件就是 `sm-version: 6`、changelog 只剩 `v6`，而归档文件仍是 `v8` —— 同一能力出现两份版本账本且回退 2 版。修法：新增版本对账 `reconcileCapabilityVersions`，在启动迁移里取 `max(记录版本, live 文件 sm-version, 归档文件 sm-version)`；需要恢复时按该版本重写 live 文件（正文/事实块逐字节保留）并把 `v8: R52 迁移到 .dsh/capabilities，保留归档版本（源自归档 …）` 写入文件 changelog 与记录 changelog，然后写回记录与文件；`upsertCapabilitySkill` 的版本规则改为「不低于文件与记录二者」，`syncCapabilitySkill` 把文件版本回写记录，从而保证后续单调。重复启动 versionsReconciled=0、文件与记录不变（幂等）。
- **P2-2 健康统计口径矛盾**。根因：旧版把 `successCount/failCount/consecutiveFailures/lastStatus` 放在 `usage` 对象里，迁到统一记录时只保留了分子，没有补齐 `runCount` 分母，于是面板出现「runCount=0 / loadsToRuns=0，但 successCount=13、failCount=9、consecutiveFailures=2、lastStatus=failed」。修法（选择**保留历史**而不是清空）：迁移时把旧成功率折算进分母 —— `runCount = max(runCount, success + fail)`，连续性失败不超过 `failCount`，`lastStatus` 强制与最近一次结果一致（失败 streak > 0 → failed；streak 归零且成功过 → completed），并写回记录；`capabilityHealthOf` 的读投影同样先对账，因此面板在迁移落盘前也不会自相矛盾。面板会新增一条中性说明「历史统计已校正（R54）」。
- **P2-3 注入卡提示语用机器名**。根因：`renderCapabilityIndex` 直接照抄调用方给的 `whenToUse`，当该句以机器名 `git-sync-supermemory` 作主语时，卡片与面板里的人类标题（「git 同步/提交/推送（SuperMemory 仓库）」）相互矛盾。修法：新增 `capabilityIndexHint`，卡片「何时用」**优先用 title** 重建句子（保留 scope 前缀）；调用方给的句子只有在已经包含该 title 时才沿用；没有 title 时退回 `description`/老 `whenToUse`（与原行为一致）。prestep 同时把 `scope` 传给渲染器。

### 测试（R54 新增断言）

- R54-1：live v6 + 归档 v8 → 结果 8、文件 changelog 追加迁移行、归档 v7 历史保留、记录版本写回；`record=6 / file=8` → 结果 8 且 changelog 追加；二次对账 `changed=false`。
- R54-2：legacy 统计（0 运行 / 13 成功 / 9 失败 / streak 2 / failed）→ `runCount=22`、`loadsToRuns=5.5`、`successRate=13/22`、`lastStatus=failed`；streak 归零后 lastStatus=completed；迁移写回且二次迁移 0 改动。
- R54-3：卡片含人类标题、不含「机器名」主语；无 title 退 description；prestep 传 scope 的接线断言。

### 变更

- 版本 1.3.1 → 1.3.2（patch：仅修复与测试，存储域 `supermemory` version 1 不变，无破坏性迁移）。
- 版本账本的语义明确为「记录与知识面共用的单调账本」：内置定义的版本另行记录在 `builtinVersion`，因此 `memory_toolize refresh-builtin` 的升级判断不会被恢复出来的知识面版本（如 v8 > 内置 v6）挡住。

### 已知限制

- 三项修复都在插件启动迁移里执行：**升级后仍需完全退出并重启 DSH Desktop**（不是禁用/启用插件、也不是刷新窗口）。
- 恢复只读取两类归档：`.dsh/capabilities-archive/<name>.md` 与 `.dsh/skills-archive/sm-<name>/SKILL.md`；更早的手工备份不在扫描范围内，需要人工放回。

## [1.3.1] - 2026-11-26

发布轮（R53）：发布 R52「能力知识面移出公用 skill 目录 + 按需读取 + 索引注入 + 面板正文编辑器」，并修掉 R51 遗留的发布脚本 Windows `cmd.exe` 转义缺陷。全量闸门（typecheck 双工程 + build + 七套冒烟）通过。

### 新增（R52：能力知识面独立存放）

- **知识面路径迁移**：固化能力正文从 `<skills 根>/sm-<name>/SKILL.md` 迁到 `<仓库根>/.dsh/capabilities/<name>.md`（无 git 根时 `<DSH_HOME>/capabilities/<workspace-token>/<name>.md`）。`.dsh/capabilities` 不在任何宿主 skill provider 的扫描根内，文件名也不是 `SKILL.md`，因此**公用 `available_skills` 不再出现任何 `sm-*` 能力**；第三方便携 skill（ego-browser/office 等）原样保留。
- **幂等迁移 + 可回滚**：启动时 `migrateCapabilityDocs()` 只处理 frontmatter 带 `sm-source: capability` 的旧文件：先复制到新路径，再把旧目录整体移到 `<skills 根>-archive/sm-<name>` 并写 manifest（原名/来源/时间/原因，可回滚）；二次启动 moved=0、archived=0。人工/第三方/task skill 字节不动。
- **`sm_cap_doc` 按需读取**：入参 `name`（逻辑名 / `sm_cap_*` / `sm-*` 均可）与可选 `section`（只取某个二级小节）；返回正文、事实块、`entry/scope/dryRunArg/writeConfirm/whenToUse`、二级标题与 `loadCount`。只返回 enabled 且未退役的能力（可执行能力还要求 `runnable=true`）；不存在/停用/文件缺失/解析失败都是结构化错误，不返回半截正文。每次成功加载 `loadCount+1`，接入转化率统计。
- **中枢/分支注入「可用能力」索引**：pre-step 只对 hub/branch 会话注入（普通 shell 会话不注入），每行 `- <name> [可执行|仅知识|入口待验证]：<何时用>`，默认最多 8 条、1600 字符，超预算按行降级并写「… 省略 N 条」；`recall.capabilityIndex.enabled` / `maxItems`（硬上限 8）/ `maxChars` 可配置，关闭后不注入。
- **固化能力面板正文编辑器**：列表行可展开编辑知识面正文（`editTool(id,{body})` → `updateCapabilitySkillBody`），保存时按事实块规则保留 `<!-- sm:facts:start --> … <!-- sm:facts:end -->`、版本 +1，路径展示指向 `.dsh/capabilities/<name>.md`。
- **提示与文案**：`HUB_ROLE_TEXT`、`CAPABILITY_ROUTING_RULES`、README、INSTALL 与 locales 中「用宿主 skill 工具加载能力」的说法统一改为 `sm_cap_doc`。

### 修复（R53：发布脚本）

- `scripts/github-api-release.mjs`：`git rev-parse <tag>^{commit}` 在 Windows 下经 `execSync` 走 `cmd.exe` 时，`^` 被当成 cmd 转义符吃掉（命令变成 `rev-parse <tag>{commit}`，报 ambiguous argument）。改为 `execFileSync('git', [...参数数组])`（不经过 shell），commit-ish 与 tag 目标统一用 `^{commit}` 解析；新增 `--self-check --tag <vX.Y.Z>` 离线自检（tag 对象类型、`^{commit}` 与 `~0` 两式结果一致、tag 目标与当前 HEAD 的关系、祖先关系），不触网、不读令牌。
- `docs/git-sync.md` 新增 §12：GitHub 前端（github.com）被阻断、`HEAD/GET /releases/latest/download/...` 不可用时的替代核验流程——改用 `api.github.com` 的 `releases/latest` 与 `releases/assets/<id>`（`Accept: application/octet-stream`）取资产 digest/大小，下载后本地 sha256 复核。

### 变更

- 版本 1.3.0 → 1.3.1（patch：R52 行为/界面变更 + 发布脚本修复；存储域 `supermemory` version 1 不变，无破坏性迁移）。

### 已知限制

- 迁移只在插件启动时执行：升级后必须**完全退出并重启 DSH Desktop**（不是禁用/启用插件、也不是刷新窗口）。
- 历史上手工改过 frontmatter、不再是 `sm-source: capability` 的旧 `sm-*` 知识面会被迁移跳过，仍留在 `.dsh/skills`；需要人工在面板保存正文或手动迁移。
- 索引卡只给名称与「何时用」，模型要多一次 `sm_cap_doc` 调用才看到正文。

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
