# SuperMemory 开发运维笔记（Dev Notes）

> 记录实现期间在真实宿主上验证过的加载机制、开发回路与环境事实。
> 设计方案见《可行性分析与实现方案.md》v4.2；本文件是它的执行层补充。

## 1. 加载机制（已源码级 + 运行时验证）

宿主 DSH Desktop 0.2.2-rc.3，profile：`~/.dsh/profiles/desktop`（`patchReload: live`）。

- **路径行加载可行**：profile 的 `cordis.patch.yml` 追加
  `- insert: - id: supermemory, name: 'G:/09 - dsh/SuperMemory/lib/supermemory.js'`。
- **`@deepseek-ai/dsh-*` 不能直连**：必须用 dsh-vscode-mode 实证的
  **loadHostModule 模式**（`createRequire(process.argv[1]).resolve(spec)` 再
  `import(pathToFileURL(resolved).href)`）。`process.argv[1]` 是宿主入口。
- **schemastery 走静态 import**（external，运行时从安装作用域解析）。
  注意：**profile 里的 `@deepseek-ai/schemastery` 曾被掏空**（目录在、内容没），
  导致所有静态 import 它的插件全部 PENDING。用 workspace 同版本包恢复。
  若再现"插件 enabled 但 fiberPhase 为 null"，先查这个包。
- **ctx 服务必须显式 `inject`**。本插件 inject：
  `['sessions','tools','storageDomain','sessionPersistence','commands','systemPrompt','userQuestions','agents','workspaceRegistry']`。
- **存储**：`ctx.storageDomain.open(spec)` → JSON 后端 → `~/.dsh/storages/supermemory.json`。
- **工具定义**：宿主 `defineTool`（loadHostModule 取得），parameters/output.schema 用
  dsh-tools 的 **DSL**（`{ type, required?: true, enum?, properties? }`），执行入口 `execute`。
- **Remote 服务（侧边栏数据通道）**：普通类 + `ctx.provide('supermemoryPanel', service)` +
  `ctx.typert.register({ package, face:'host', schemas:[], model:{...}, invocations })`
  （descriptor 形状见 `src/panel.ts`，参照 dsh-ops 的 runtime-host 模式）。

## 2. 开发回路（live reload 的坑）

1. **ESM 按 URL 缓存**：同 URL 重复 import 返回首次缓存的模块。迭代必须换文件名
   （`scripts/dev-load.sh` 每次复制到 `lib/dev-<时分秒>.js`）。
2. **patch 条目改名只更新树、不重挂 fiber**（fiberPhase "active" 可能是旧 fiber）。
   可靠重载：`plugin_manager set_plugin` 对 `include:supermemory` 禁用→启用。
   完整回路：`bash scripts/dev-load.sh` → 等树更新（查 plugin_manager）→ 禁用→启用。
3. **patch 文件必须原子写**（临时文件 + rename）：原地截断写会让监视器读到半截文件。
4. **稳态入口**：`lib/supermemory.js`（tsdown 产物，entry + 分片 chunks 同在 lib/）。
   重启 DSH 后无缓存问题；开发迭代仍走 dev-load.sh。
5. **重启会杀死插件创建的分支 agent**（fiber 卸载连带 dispose）。对账路径会
   resume 死分支并重新派发，或判失败并投递失败 relay——不会永久卡住。

## 3. 实现要点（P0–P3 全量）

- **P0**：memories 表 + 跨会话 recall 注入（pre-step，form 'recall'）+ 维护循环
  （持久 turn/end → 后台队列 + hotcache 游标）+ `memory_remember`/`memory_recall`。
- **P1**：话题集四级路由（@显式 → 粘性+漂移 → 关键词 → userQuestions 确认）；
  分支/子代理会话不路由（delegationDepth>0 或 topicset 成员即跳过）；
  `memory_dispatch`（单任务 + tasks[] 并行组）；分支获取 live→resume→新建，
  fork 用官方 seed（`inheritedEventCount` = 父日志已完成轮次边界）；
  终态判定读分支日志的 turn/end reason；episode 生成；followup-relay 交付 +
  outbox 幂等确认（deliveryId）；启动对账三路径 + 僵死派发结算；
  分支 workspace attach；模型管理（建集询问/运行时枚举/继承中枢模型）；
  `/memory` 命令族。
- **P2**：dispatchGroup（全员终态后单次 group relay，失败标注，成员不单独投递）；
  需求抽取（规则式，必须/需要/待办/TODO）；filemap 扫描（hash 失效 + 角色规则化，
  跳过 node_modules/.git/_dsh_src/.obsidian/Backup）；`/memory export`。
- **P3**：工具序列信号（每回合 tool/call 序列签名计数）→ 阈值（默认 3）挂起提议 →
  `memory_toolize` 接受 → compileComposite（变化参数提升为工具参数）→
  嵌套分发（`ctx.tools.execute` 保住策略链）→ toolMemory 持久化 → 启动重建注册；
  `tools/pre-execute` 软提示（附加上下文，透传决策）。
- **踩过的坑**：
  - 域写入是异步链：`createTopicSet`/`setRouting` 等即发即忘会导致紧随的同步读
    拿到 undefined——读前必须 await（topicsets.ts 全部改 await）。
  - recall 阈值必须作用于**原始匹配分**，衰减只用于排序（否则 0.999 < 1 漏匹配）。
  - 派发输入以 `agent/inbox/spliced` 落账（不是 user/message），归属逻辑要认它。
  - `tool/call` 事件的 arguments 可能是 JSON 字符串，用前 parse。
  - `matchAll` 只接受 global RegExp；定义式抽取要在句号/引号处截断。
  - 工具返回体不能含 `undefined` 字段（lossless JSON 校验）。

## 4. 侧边栏（P1.5 降级，已按 D7 条款执行）

- **未构建客户端 bundle**：官方 client preset（`packages/client/tsdown.client.ts`）
    不在本 checkout，UMD 工厂封装（`window.__ModuleLoader__.load({id, factory})`）
    无法可靠复刻；client bundle 出错会导致 GUI 无法启动（boot fiber 失败），
    风险不可接受。按方案 D7 降级条款走 P1.5。
- **已实现等价能力**：`/memory topicsets|switch|new|status` 命令族、
  `memory_topicsets`/`memory_new_topicset`/`memory_set_model`/`memory_ui` 工具、host 侧
  `supermemoryPanel` Remote 服务（list/activate/activeTopicSet + typert 描述符）。
- **后续接入**：拿到 client preset 后建 `src/client.ts`（sidebarRightTabs.register +
  `sidebar.right.pane.tab` keyed slot + guide 入口），body 调
  `ctx.remote.supermemoryPanel.listTopicSets(cwd)`；先用最小 slot 验证再接业务。

## 4b. Web 管理台（Plan A，2026-11-17 实现）

可视化管理记忆的落地形态：不碰 client bundle，在宿主 HTTP 载体上挂前缀路由
`/supermemory`，静态页 + JSON API 直连存储域。GUI 启动路径零风险。

- **双载体**（`src/webui.ts`，`ui.carrier` 配置，**默认 `own`**）：
  1. `own`（默认）：自建 `createServer().listen(0, '127.0.0.1')`，随机 loopback
     端口。**必须用它才能住进侧边栏**——见下方「浏览器 tab 同源禁令」。
  2. `auto`：优先 `ctx.webServer`（dsh-host-webserver，GUI 自己的 HTTP 服务器，
     同源、无额外端口），取不到该服务时（无 web server 的 profile / GUI 由别的
     进程服务）自动退到 `own`。端口经 `listening` 事件捕获（`listen(0)` 后
     `address()` 仍为 null，有竞态，已踩过）。
  - **浏览器 tab 同源禁令（2026-11-17 实证，宿主客户端产物 offset≈44273574）**：
    `parseBrowserAddress(input, applicationOrigin)` 明确拒绝
    `url.origin === new URL(applicationOrigin).origin` 的地址
    （locale: `error.application-origin`「不能在嵌入浏览器中打开 DSH 应用自身」）。
    管理台若挂在 GUI 同源端口（如 62816），侧边栏 browser tab 必然打不开
    （用户实测报「页面加载失败；请刷新重试或在系统浏览器中打开」）。
    → 默认载体改为 `own`（不同源），系统浏览器两种载体都能用。
  - **CORS**：沙箱化 iframe 是 opaque origin，带 `x-sm-key` 自定义头的 fetch 会
    触发预检。路由器对 OPTIONS 先于鉴权应答 204，所有响应带
    `access-control-allow-origin: *`（令牌仍是真正的门）。
  - 服务名已实证：宿主产物 app.asar 含 `'webServer'`，与 web-server.zh.md 一致。
  - 端口分布（本机实测）：GUI 62816（未知路径 404，不全局鉴权）、API 62817/62818
    （未知路径 401，全局鉴权）。
- **鉴权**：启动时生成随机 token（`ui.token` 配置：留空=随机、`off`=不校验、
  其他=固定）。页面 URL 带 `?k=`，静态壳由服务端把 token 注入
  `<meta name="sm-token">`，前端以 `x-sm-key` 头回送；只读路由（workspaces/state）
  同时支持 GET(query) 与 POST，写路由只收 POST。
- **静态资源**：`src/web/{index.html,app.js,style.css}`（vanilla JS，无框架无外链，
  暗色）。按请求读盘——改 UI 只需刷新浏览器，不 rebuild 不重载插件。
- **API**：`/api/workspaces`、`/api/state`（全量快照，episodes/dispatches/outbox
  经话题集 join，routing/toolMemory 全局）、memory/requirement/topicset 的
  create/update/status/delete、`topicset/activate`（写 routing）、`filemap/scan`、
  `export`。所有写操作先校验目标行 `workspaceKey === ws`（防跨工作区写）。
- **入口**：`/memory ui` 命令、`memory_ui` 工具（模型可拿当前 URL）、系统提示词
  已加指引。链接粘进侧边栏 browser tab 即可（builtin `browser` 类型接受 loopback）。
- **测试**：`node scripts/webui-smoke.mjs`（`pnpm smoke:webui`）——桩 store +
  真实 HTTP 服务器，20 项检查覆盖两种载体、鉴权、全部端点、跨区写拒绝、404/405/HEAD、
  dispose。无需宿主。
- **UI 迭代回路**：编辑 `src/web/*` → 浏览器刷新（无需任何构建/重载）。
  改宿主逻辑才需要 tsdown + 插件重载。

## 4c. 话题路由强制执行与对话切换（2026-11-17）

应用户要求，把「新消息进新对话」从提示词约束改为插件行为：

- **路由即派发**（`route.ts` `finishRoute`/`autoDispatchMessage`）：pre-step 路由解析出话题集后，
  插件亲自把该消息 `runDispatch(mode:'auto')` 派到话题集分支（有界等待 2.5s；回执的分支会话 id
  写进上下文卡）。仅回合第 1 步触发；斜杠命令与过短消息（< `route.autoDispatchMinChars`，默认 8）不派发。
  中枢不再自行作答，等 relay 回送结果后转述。派发失败时降级为原行为（只挂卡片），不阻塞会话。
- **未命中即新建**：第 4 级路由不再弹确认，直接 `createAndActivate` 新建话题集并进入分支对话
  （`route.confirm` 默认改为 false，仅作 opt-in 保留）。
- **切换即恢复分支**（`dispatch.ts` `ensureBranchLive`）：`/memory switch <名>` 与 panel `activate`
  在写 routing 后恢复该话题集的主分支会话（live handle → registry → resume），后续消息自动进入该分支。
- **去重**：`noteAutoDispatch`/`recentAutoDispatch`（15s 窗口）保证模型对同一任务重复调用
  `memory_dispatch` 时返回原回执，不重复派发。
- **GUI 视图限制（已源码实证）**：Web GUI 的当前对话是客户端本地持久状态
  （`dsh-client-ui-workspace` 的 `UiWorkspaceService.selection`，store 名 `dsh.sessions.current`），
  只有 UI 导航（点击会话行 / New Session）会写它；宿主插件没有 host→client 的切换 API
  （remote 事件仅 api-session/added|removed|status|activity|error，都是列表/状态类）。
  因此插件保证的是「对话确实在分支会话中进行 + 分支会话出现在左侧会话列表」，
  GUI 焦点切换需用户点击会话行（`/memory switch` 输出中有明确指引）。
  待 client bundle（P1.5）落地后可补一键切换（`uiWorkspace.openSession` 是 client 侧入口）。

## 5. 当前状态（2026-11-17）

- 插件运行中（bundle 安装，入口 `lib/supermemory.js`；见 §6）。
- 域数据（2026-11-17 清理后，本工作区 G:\09 - dsh\SuperMemory）：topicsets 10 /
  memories 20 / episodes 9 / requirements 16 / filemap 53 / tool_memory 1（组合工具）/
  signals 26 / dispatches 9 / outbox 9；另有第二工作区 G:\16-task。
  清理动作见 §8.5：删掉 11-16 的失败派发（+交付行）与「派发链路」测试话题集（级联）。
- 已验证：P0 三项验收、P1 全链路（派发→分支→relay→确认）、P2 组 relay/需求/filemap/export、
  P3 阈值提议→固化→重启后仍可用、Plan A 宿主侧 20 项冒烟（两种载体）、
  **Plan A 上线实测（2026-11-17 插件重启后）**：GUI 同源端口 200、
  app.js/style.css 200、无令牌/错令牌 401、workspaces/state 正常、
  记忆 create→state 可见→update→delete 回路通过、跨工作区写 400 拒绝
  （`node scripts/webui-live-check.mjs <baseUrl> <token>`，9 项全过；
  存储域数据零污染，测试记忆已删）。
- 载体实测结论：desktop profile **能**取到 `ctx.webServer`（GUI 端口同源挂载），
  own-http 兜底未被触发，但保留（无 web server 的 profile 需要它）。
- 待用户验证：`/memory status`、`/memory topicsets`、`/memory scan`、`/memory export`、
  `/memory ui`（斜杠命令只能由用户在输入框提交）；管理台页面人工打开确认观感。


## 6. Bundle 安装（2026-11-17，替代 dev-load 热加载）

- **已作为 profile bundle 安装**：desktop profile 的 package.json 增加依赖
  `"dsh-supermemory": "link:G:/09 - dsh/SuperMemory"`（pnpm link 协议，node_modules/dsh-supermemory
  是指向工作区的符号链接）并加入 `dsh.profile.bundles`（末位）。侧边栏「插件」页现在能
  列出/启用/禁用/移除它（该页只列安装的 bundle，patch 路径行插入不显示）。
- **profile 的 cordis.patch.yml 已清理**：删除全部 dev insert 行和历史注释，条目 id `supermemory`
  现由 bundle 自带的 cordis.patch.yml（`name: dsh-supermemory`）提供。备份在 profile 目录：
  `package.json.bak-20261117-bundle-install`、`cordis.patch.yml.bak-20261117-bundle-install`、
  `pnpm-lock.yaml.bak-20261117-bundle-install`。
- **开发回路变化**：工作区经符号链接成为 HMR 监视根，改源码 → tsdown 重建 → 宿主热替换插件
  （不再需要 dev-load.sh 换文件名 + patch 原子写那套；dev-load.sh 留作历史参考）。若热替换
  不生效，重启 DSH 即可（重启会杀分支 agent，启动对账会 resume 死分支）。
- **兼容性**：`engines.dsh` 用 includePrerelease 匹配，0.2.2-rc.3 满足 `>=0.2.0 <0.3.0`，
  无需版本豁免。peerDependencies 未安装（profile pnpm-workspace 设了 autoInstallPeers:false），
  运行时 @deepseek-ai/* 仍经 loadHostModule 锚定 process.argv[1] 解析。
- **卸载/回滚**：插件页移除 dsh-supermemory，或删 profile package.json 的依赖+bundles 条目后
  `pnpm install`；patch 备份可直接还原 dev 加载方式。

## 7. 应用内 SuperMemory 面板 + 新会话选项 + 工具编辑（2026-11-17 第二轮）

应用户 6 项需求落地。宿主侧改 src/{route,index,tools,commands,panel,composite}.ts，
新增客户端半边 src/client/*（P1.5 侧边栏 client bundle 正式落地）。

### 7.1 client bundle 机制（本次实证可行，替代 D7 降级）

- 声明：package.json dsh.client = { platform: 'web' } + exports["./client"] = "./lib/client.js"。
  clientModules 服务扫描 Loader entry 的包 manifest，把 dsh-supermemory 编入
  window.__DSH_BOOT__ 图，经 /plugins/??dsh-supermemory/client.js&rev=... 下发。
- bundle 格式：window.__ModuleLoader__.load({id, factory: require => {CJS body}})。
  构建：tsdown -c tsdown.client.config.ts（format cjs、platform neutral、仅 react external）
  加 scripts/wrap-client.mjs 包外壳。pnpm build 一次产出宿主与客户端两侧。
- 客户端插件形状：普通 Cordis 插件（name/inject/apply），apply 里
  ctx.locale.register -> ctx.get('remote').$mount(PANEL_REMOTE) -> ctx.slots.inject/register。
  远程调用用 dsh-ops 同款模式：host 侧 ctx.typert.register({face:'host', invocations})，
  client 侧挂 {package, descriptors} 后经 ctx.get('remote.supermemoryPanel') 调用。
- 风险控制：client bundle 损坏会导致 GUI 无法启动。防护：scripts/client-sim-smoke.mjs
  （假 __ModuleLoader__ + 桩 react + mock ctx 跑完整 apply，校验三处 slot 注册），
  构建后必须先过此冒烟；apply 内每处注册独立容错，单点失败不拖垮 boot。
- 加载回路：宿主热替换后浏览器经 HMR 收新图；无 dev:web 时需手动刷新页面。
### 7.2 需求落点

- R1 对话连续性（route.ts/index.ts/tools.ts）：路由改为静默——关键词命中只注入
  [SuperMemory 话题提示] 卡片（不询问、不切换、不自动新建）；激活只来自 @显式、
  面板点击、/memory switch。配置 route.confirm 改为 route.hint（默认 true）。
  系统提示词明确：直接对话就在当前上下文继续；实质工作必须 memory_dispatch 开新对话执行。
- R2/R4/R5 面板（src/client/* + panel.ts）：左侧插件/自动化任务下方新增
  超级记忆面板行（sidebar.panellist，id supermemory，order 25）；
  main slot keyed supermemory 渲染面板页——默认中枢会话（当前会话/活跃话题集/话题集列表），
  二级界面为话题集（分支会话点击定位、回复框直送分支、梗概编辑），
  另有记忆页（检索/新增/编辑/删除/停用/点击定位来源会话）与组合工具页。
- R3 新会话选项（src/client/new-session.tsx + panel.ts createTopicSetSession）：
  sidebar.session.action HOC 以 capture 阶段拦截新会话按钮，弹中枢会话/话题集会话选择；
  话题集会话支持多选话题集与当场新建，宿主建会话（ctx.agents.create + 成员登记）后打开。
- R6 工具编辑（composite.ts + panel.ts + commands.ts）：editCompositeTool 应用补丁
  （description/steps/parameters/status）-> 反注册旧工具 -> 重注册 -> 持久化；
  live 注册表 liveComposites/liveCompositeSpecs；面板工具页 + /memory tools 命令族
  （列表/edit JSON/desc/retire）。

### 7.3 重载与验证

- 重载：profile patch 追加 - id: supermemory / disabled: true 后再移除（原子写、LF 行尾），
  或插件页禁用->启用。重载后 webui 探针（loopback 端口 /supermemory/ 200）确认宿主存活。
- 冒烟：pnpm smoke:webui（23 项）、node scripts/client-sim-smoke.mjs（SIM SMOKE OK：
  name/inject/apply + 三处 slot 注册 + 无 console.error）。
- GUI 页面需人工刷新后验证：左侧超级记忆入口、面板数据、新会话选项弹层。

## 8. 全量检查与修复（2026-11-17 第三轮）

对全仓（宿主半边 src/*.ts、客户端半边 src/client/*、管理台 src/web/*、scripts/*）做了一次完整审阅，
修掉下列真实缺陷，并把可回归的部分固化进冒烟脚本。

### 8.1 质量闸门（新增）

- `pnpm typecheck` = `tsc -p tsconfig.json && tsc -p tsconfig.client.json`。
  之前只有宿主半边能过：`tsconfig.json` 的 `src/**/*.ts` 把客户端半边也扫进来，
  在缺 `jsx`、缺 `@deepseek-ai/dsh-client-ui-layout` 等壳层类型时报 48 条错，
  等于 `tsc` 完全没有约束力。现在宿主配置 `exclude: ["src/client"]`；客户端半边单独配置 +
  `src/client/ambient.d.ts`（react / 壳层模块声明）与 `src/client/shell.d.ts`
  （cordis Context 增强——必须是 module 文件，否则会 shadow 掉 cordis 真模块、
  把 `ctx.get`/`ctx.effect` 一起藏掉）。两侧现在都是 0 错。
- `pnpm smoke` = core-smoke（4 项）+ webui-smoke（24 项）+ client-sim-smoke（1 项）。
  `scripts/core-smoke.mjs` 用内存表桩直接跑 data layer，覆盖工作区隔离 / recall 计分 / 规则抽取。

### 8.2 修复的缺陷

- **派发崩溃（两个路径）** `dispatch.ts`：
  - `acquireBranch` 的「live registry agent」分支返回 `handle: undefined`，调用方
    `handle!.agent.followup()` 必然 TypeError。用户只要在 GUI 里点开过该分支会话
    （或话题集会话由面板 `createTopicSetSession` 创建），此后所有派发都会以
    「分支唤醒失败」告败。现在包一层 host-owned handle（no-op dispose）并回写成员 live。
  - `mode:'fork'` 在话题集还没有成员时 `ranked[0].sessionId` 直接 TypeError → 派发失败。
    现在没有父分支时回落到新建分支。
- **startSeq 语义 / 误判失败** `dispatch.ts`：`startSeq` 原先取自 acquire 时刻的
  `ctx.sessions.get().seq`（分支可能还没进 sessions map → 0，或已被别的写入推进），
  导致 `locateOwnership` 认出**上一次**派发的输入（契约：startSeq = 输入落账前的日志位置）。
  现在 followup 后拿到 `seqBefore` 并回写 `startSeq`；另外「300ms 内 seq 没变」不再直接判 failed
  ——忙碌分支的 followup 会排队，旧逻辑会把真正落地的工作永久搁死（observe 只结算 open 状态、
  reconcile 又因已 failed 而跳过）。改由 observe / reconcile 收口。
- **状态写入未 await** `route.ts`（drift 清零）与 `panel.ts` `activate()`：后者是面板点击后
  立刻重拉快照的路径，即发即忘会让面板显示旧的活跃话题集（§3 踩过的坑）。
  `activate` 现在 async 并 await（客户端契约本就是 `Promise<boolean>`）。
- **话题集梗概去抖失效** `maintenance.ts`：`if (count % N !== 0 && users.length === 0) return`
  里 `users.length` 在该路径恒 > 0，所以每轮都重写梗概（并撑到 300 字上限）。
  改为只按轮次判定；同时删掉提取前就清空 buffer 的那行（与「成功后才清」的注释矛盾）。
- **跨工作区泄漏（D4 违背）**：episodes 没有 workspaceKey，只能经话题集 join。
  `memory_recall`（tools.ts）与 `buildExport`（export.ts）之前把**所有工作区**的 episode
  都算进来。新增 `topicsets.topicSetIdsOf()` 统一做 join 过滤（webui `buildState` 早已如此）。
- **管理台写入口缺 ws 校验** `webui.ts`：`memory/create` 等路由不校验 `ws`，可写出
  `workspaceKey:''` 的孤儿行（所有过滤都看不见）。现在除 `workspaces` 外一律要求 ws。
  另：非法/超长 JSON body 由 500 改为 400/413；own-http 服务器补 `error` 监听
  （原先 bind 失败会以未捕获事件崩掉宿主进程）。
- **工作区归属判定** `maintenance.ts`：live 会话存在但 `header.cwd` 缺失时，
  `workspaceKeyOf(undefined)` 会给出字面量 `unknown` 工作区，绕过需要冷读回退的分支。
  现在只在真有 cwd 时才用它。
- **组合工具使用计数** `composite.ts`：`toolMemory.useCount` 从未自增（面板/命令恒显示 0）。
  成功执行后按 spec name 回写 durable 计数（best-effort，不影响工具结果）。
- **@ 提及误匹配** `route.ts`：空/单字标题时 `name.includes(title)` 对**任何** @ 都成立，
  邮箱也会被当成提及。现在要求标题 ≥2 字且 @ 前有边界。
- **管理台 10s 自动刷新吃掉输入** `src/web/app.js`：定时器无条件 `render()` 会整块替换
  `#content`，用户正在编辑的记忆/话题集表单被清空。现在编辑中或焦点在 console 内时跳过。
- **面板 cwd 取错** `src/client/panel-page.tsx`：`workspaces[0].path` 在多工作区场景把
  整个面板（和每一次写）指向错误项目。改为优先取主视图会话自己的 `header.cwd`，
  取不到再回退（selector 仍返回原始值，保持引用稳定）。
- **类型面的真实隐患**：`panel.ts` 两处 `attachBranchToWorkspace` logger 缺 `info`；
  `client/index.ts` 的 `ctx.get('uiWorkspace')` 未做 undefined 保护（点击即抛）；
  `panel-page.tsx` 的 `hub.activeTopicSetId` 空值访问；`icon.tsx` 依赖全局 React 命名空间
  （现由 ambient.d.ts 提供）。

### 8.3 已知限制（未改，属设计取舍）

- `new-session.tsx` 仍用 `workspaces[0].path`：该 slot 只注入 `useWorkspaces`，没有主视图
  会话可用，多工作区时可能建到第一个项目。需要壳层暴露「当前工作区」再修。
- 管理台静态壳仍不校验令牌（它只在请求已带有效 `?k=`/头时才注入令牌，见 §8.4），
  loopback + 随机端口 + 与 GUI 不同源；若将来要更严，可要求 shell 必须带 `?k=`。
- 老数据里 `topicSetId` 缺失的 episode 现在被隔离过滤排除（宁可少召回，不跨区泄漏）。
- `/memory switch` 只写 routing，不再自动恢复/派发分支（§4c 的 autoDispatch 行为已在 §7.2 R1
  按用户要求移除；§4c 保留为历史记录）。
- `client-sim-smoke.mjs` 只验证 `apply()` 的注册路径，不渲染组件（仓库没装 react-dom）：
  new-session 那种**渲染/事件**层面的 bug 它发现不了（本轮是人工审出来的）。要覆盖得引入
  react-dom 或最小渲染器，留作后续。
- 管理台 `filemap/scan` / `export` 的 `cwd` 由请求自证「等于 ws」，未再校验 cwd 属于已知
  工作区；令牌已修（§8.4），威胁模型降为「已授权调用方可扫描本机任意已存在目录」，暂可接受。

### 8.4 第二轮：观察 / 交付契约 + 安全面（2026-11-17，两个只读审查报告的落点）

第一轮改完后另做了宿主「交付与观察」层的深审，发现并修掉三个**直接违背 at-least-once /
「失败绝不伪装」契约**的问题，以及一批健壮性缺陷：

- **pending outbox 被直接改成 relayed（结果静默丢失）** reconcile.ts：重启对账最后一段把
  「pending 且 dispatch 已终态」的行无条件标 relayed —— 而它之所以 pending 正是因为投递时
  hub 不在线。没有任何路径再发 relayed 行，于是分支结果永久丢失。删除该短路，改为
  `observe.flushObserve()`：补发「已完成但无 outbox 行的组」+「hub 已上线的 pending 行」，
  并在 apply() 的 5 分钟巡检里也调用（启动对账不是重试循环）。
- **用未领取的 inbox splice 判定输入归属（把上一轮答案当本轮结果）** observe.ts：host 的
  `followup()` 会立刻 append `agent/inbox/spliced`（即使分支正在跑别的轮次），旧逻辑把它
  当作本 dispatch 的输入，于是那次 turn/end（上一轮）被认领：用**上一轮**的 assistant 文本
  生成 episode 并 relay，而真正的答案因 dispatch 已终态永不再投递。现只认同「被领取后的
  `user/message`」（host agent-loop 在 step 开始时 append），并排除 recall/notice 卡片；
  reconcile path3 的 trace 判断同时收敛到 `startSeq` 之后（旧代码从 0 扫，老 splice 会让
  新 dispatch 永远"已落账"而搁死）。
- **失败通知在 hub 离线时直接丢弃** reconcile.ts：旧代码 hub 不在线就 return，而 dispatch 已置
  failed，重启再也不会扫到 → 用户永远收不到失败事实。现先写 outbox（幂等 id
  `dlv-fail-<branch>`）再由 flushObserve 真正投递。
- **settle 并发去重**：live turn/end 与启动对账可能同时结算同一 dispatch（重复 episode +
  重复 relay）。改为**按分支串行排队**（不是丢弃后来的触发，否则后一轮 turn/end 的 dispatch
  要等下一个事件才结算），并把 relay 的 deliveryId 改成稳定键
  `dlv-<dispatchId>` / `dlv-grp-<groupId>`（文件头声明的幂等键此前是随机 id）。
- **对账忽略用户配置**：重启结算硬编码 `deliver-partial`+`enabled:true`，用户的
  `observe.maxTokensPolicy`/`observe.enabled` 被无视。ReconcileDeps 现带真实配置。
- **管理台令牌自我泄露（安全）** webui.ts：静态页不需要令牌，但会把**真实令牌**注入
  `<meta>`，且所有响应都带 `access-control-allow-origin: *` —— 任何本机网页 fetch 一下
  `/supermemory/` 就能读走令牌并拿到全部读写 API。现在：令牌只注入给**已授权**的请求
  （带 `?k=` 或 `x-sm-key`），静态响应不再回 ACAO（CORS 只保留给 /api/ 与预检，
  沙箱 iframe 的 fetch 需要它）。
- **新会话弹层的按钮被自己吞掉（R3 完全不可用）** new-session.tsx：捕获容器同时包住弹窗，
  捕获阶段对任意 button 执行 `stopPropagation + openDialog()` → 「开始」不触发、「取消」关不掉，
  而且每次点击都把 choice 重置成「中枢会话」。现在弹窗子树（`.sm-ns-backdrop`）直接放行。
- **客户端注册不隔离** client/index.ts：注释承诺「单点失败不拖垮 boot」，但三处 slot 注册
  只有 remote.$mount 包了 try/catch。现在每个 contribution 单独 try/catch + console.error。
- **dispatch 工具会抛异常** tools.ts / dispatch.ts：`memory_dispatch.execute` 无 try/catch，
  且 `addMember`/`dispatches.put` 不在保护内 —— 失败会以「工具异常」而不是约定的
  `{status:'error'}` 上报。工具层现在兜底返回 error 收据；成员登记降级为 best-effort。
- **模型设置假成功** model.ts：`applyModelSelection` 对不存在的 topicSetId 也返回 applied
  （写入被 `.catch` 吞掉）。现在先校验目标（话题集/成员）存在；成员级 overrides 写的是
  `provider/model` 文本，resume 时必须生效 —— acquireBranch 现在优先用成员 overrides
  （否则「已记录，恢复后生效」是空话）。
- **rankMembers 恒 0 分** topicsets.ts：`[...m.title, ...m.summary]` 把字符串展开成单字符，
  `bag.has(wordToken)` 永远 false → 排序退化为 lastActiveAt，auto/fork 选择实际失效。
- **filemap 键碰撞 / 截断误删** filemap.ts：分隔符替换让 `src/a.ts` 与 `src_a.ts` 共用一个 key
  （互相覆盖）；且扫描被 600 文件/深度上限截断时仍按「文件消失」删除未见的条目（每次扫描
  抖动）。现在 key 带路径 hash，截断时跳过删除阶段。
- **维护游标在冷读失败时前进** maintenance.ts：读失败被当成「没有数据」，直接把
  `lastMaintainedSeq` 推到本轮，这一轮的 facts/requirements 永久丢失。现在失败即保留游标与
  buffer 并记 warn。
- **detached 任务未捕获 rejection**：settle 的 `void` 调用、reconcile IIFE 都补了 catch。
- episode 的时间区间改用事件自身 `time`（以前是 `Date.now()-1 → Date.now()` 的 1ms 观测窗，
  而 recall 衰减把这个时刻当作 createdAt）。
- 其他：管理台 `short()` 输出统一转义（id 类字段的纵深防御）；webui-live-check 的单工作区
  假失败修正；组合工具同名重复注册先 dispose 旧句柄。

验证：`pnpm typecheck` 0 错、`pnpm build`、`pnpm smoke`（5 + 26 + 1）全绿。

### 8.5 数据删除能力（2026-11-17，清理需求带出的缺口）

此前控制台只有 memory/requirement 的删除与 topicset 的**归档**，episodes / dispatches / outbox
只增不减 —— 于是每轮验证都留下测试话题集、归档和派发记录，而没有任何入口能删。
新增三个**工作区校验 + 级联**的删除路由（`src/webui.ts`），控制台相应按钮在
`src/web/app.js`（静态文件按请求读盘，改完刷新即生效）：

- `POST /api/episode/delete {ws,id}`：梗概经 topicSetId 归属校验。
- `POST /api/dispatch/delete {ws,id}`：级联删除该派发的交付行（outbox）。
- `POST /api/topicset/delete {ws,id}`：级联删除该集的 episodes、dispatches、它们的
  outbox 行，以及指向它的 routing 行（否则会话会一直指向已删除的话题集）。

冒烟：`webui-smoke` 新增 1 项（工作区校验 400 + 三处级联断言），共 26 项。

清理时的一个判断：**同分支多条 episode 不一定是重复**——每条 dispatch 对应自己 seq 窗口的
一条归档是正确行为（11-16 那两条 seq 4–14 / 16–22 分别属于两次真实派发），不能当重复删。


**插件重载**：本地 tsdown 重建**不会**自动热替换（本轮实测：宿主仍在旧代码，控制台端口未变化）。
请在「设置 → 插件管理」对 dsh-supermemory 禁用→启用（或重启 DSH Desktop），再刷新 GUI 页面。

## 9. 客户端半边从未被加载（根因）+ 新会话接入点修正（2026-11-17 第四轮）

用户报「6 项需求哪些做了哪些没做」。审查结论：**宿主逻辑已全部落地，但整个
客户端半边（面板页 / 左侧入口 / 新会话选项 / 工具编辑页 = R2/R3/R4/R5 的界面）
在 GUI 里根本不存在**——因为下面的根因。

### 9.1 根因：package.json 缺 dsh.client

- 平台扫描客户端插件的契约（对照已发布的 dsh-vscode-mode 0.30.0 实证）：
  exports["./client"] = "./lib/client.js" **且**
  dsh = { bundle: {…}, client: { platform: "web" } }。
- 本文件 §7.1 写着「声明：package.json dsh.client = { platform: 'web' }」，但
  git log -- package.json 显示该字段**从未存在过**（225a5f3 里也没有）。于是
  clientModules 不把 dsh-supermemory 编入 window.__DSH_BOOT__：
  /plugins/dsh-supermemory/client.js 恒 404，三处 slot 注册一次都没执行。
  所有客户端冒烟（client-sim-smoke 直接喂 lib/client.js）都绕过了这一步，
  所以「SIM SMOKE OK」并不能证明 GUI 里看得见。
- 已补该字段；并在 scripts/client-sim-smoke.mjs 加了**清单守卫**：
  exports["./client"] 与 dsh.client.platform === "web" 缺任何一个即失败。

### 9.2 slot 名称实证（本机已装插件反查，不再靠猜）

从 ~/.dsh/profiles/desktop/node_modules 下各插件的 client bundle 中提取到的
**真实** slot 名：sidebar.panellist（dsh-skills-manager 用它挂左侧面板行，
正是 R4 要的位置）、sidebar.session.row.leading、
sidebar.workspaces.session.row.action、sidebar.footer.action、
shell.overlay、main、conversation.view、conversation.composer.dock、
conversation.input.right、conversation.input.model.label、
conversation.session.header.utilities、settings.section、
settings.section.icon、plugins.detail.section、plugins.bundle.config。

→ sidebar.panellist（R4 左侧入口）与 main（R2/R5 面板页）是对的；
**sidebar.session.action 不存在**（§7.2 的 R3 接入点一直是空注册，静默失败，
被 client/index.ts 的 per-contribution try/catch 吞掉了）。

### 9.3 R3 新会话选项的新接法

- 改为挂在 shell.overlay（全局渲染槽，vscode-mode 的同款用法），组件自装
  **捕获阶段 document 监听**，按可访问名（aria-label / title / textContent）
  匹配 shell 的「新建会话 / New session」控件后 preventDefault + stopPropagation
  再弹选择层。
- 失败模式是安全方向：上游改名 → 监听不匹配 → 什么都没拦，shell 原生新建会话照旧；
  不会出现「按钮点不动」。面板页根节点带 data-sm-panel，弹层带 .sm-ns-backdrop，
  两者都排除在拦截之外，避免自我触发。
- 工作区路径不再依赖 slot 注入的 useWorkspaces（overlay 槽没有它），改由
  resolveCwd(ctx) 读 workspaces.list.getSnapshot().items（vscode-mode 同款读取）。

### 9.4 顺手修的

- panel.ts createMemory 把 sourceSessionId 写成字面量 "panel"，面板会据此
  显示「定位会话」按钮并跳一个不存在的会话；改为空串（按钮自然不出现）。

### 9.5 生效方式（重要）

dsh.client 是**宿主启动时**读的，运行中改清单不会重建 boot 图（实测：改完
/plugins/dsh-supermemory/client.js 仍 404）。必须**重启 DSH Desktop**
（或在插件管理页对 dsh-supermemory 禁用→启用，若该操作会重扫清单），然后刷新 GUI 页面。
验证顺序：左侧出现「超级记忆」入口 → 点开是面板页（默认中枢会话）→
点「新建会话」出现 中枢会话/话题集会话 选择层。

## 10. 硬机制：过程内再召回 + 组合工具自动固化（需求 A/B，2026-11-18，已提交 ee58034）

宿主事件面结论（源码级，`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-tools` 0.2.2-rc.3）：

- `agent/pre-step` 是**每一步**的 waterfall；`enter` 决策的 `messages` 是插件唯一可写、会落日志的
  模型可见通道。工具续跑步不 claim 任何 user 消息——旧守卫「只有含 user 批次才注入」因此每个请求
  只注入一次。
- `tools/pre-execute` 的 `PreToolDecision` 只有 allow/deny/cancel/ask，**没有 context 字段**
  （旧 `attachCompositeHint` 往这里塞 additionalContexts 是死代码，已删）；`tools/post-execute`
  接受 additionalContexts 给下一请求；`tools/result` 是隔离 observer。
- 结论：过程内注入 = 每步 pre-step；即时提示/近失 = post-execute。

实现：

- `src/inrequest.ts`：纯逻辑 + tracker（触发：工具调用数 ≥ everySteps，或高信号=报错 / 新路径且
  记忆关键词重合上升；dedupe、卡片/字符上限、查询拼装、独立卡片标题）。
- `src/prestep.ts`：每步注入口（首卡保持原样，过程内卡带「· 过程内补充」标题 + 组合工具目录）。
- `src/activity.ts`：post-execute 观察根调用、记录近失信号（`ws/…/nearmiss/<tool>`）、同请求内
  同窗口重复 ≥ 阈值立即自动固化、可附加一条组合工具提示。
- `src/toolize.ts`：滑动窗口（2–4 步）计数、阈值自动固化（cooldown / maxActive / minSteps /
  minDistinctTools / 重复与未注册拒绝）、启动扫描、零使用回收（默认关）、结构化目录。
- `src/maintenance.ts`：每回合改为滑动窗口 + 短整串计数，跨阈值自动固化（失败留 pending 走人工路径）。
- Config：`recall.repeat.*`、`maintenance.autoToolize / toolizeCooldownMs / toolizeMax /
  toolizeMinSteps / toolizeMinDistinctTools / nearMissHint / recycleIdleToolDays`（中文 description）。

实测（真实 GUI 会话 `branch-mwk8lbxu-5vyivl`，turn 2 内）：出现多条 `form: recall` 的
「过程内补充」卡片；一条 `form: notice` 组合工具提示；目录卡列出已注册组合工具；
「memory_scan → memory_topicsets」在同一请求内重复 3 轮后被**自动固化**并出现在工具表
（`sm_composite_memory_scan_memory_topic`）。

已知限制：① 全同工具的复合（run_code×4）会让前缀匹配对任意 run_code 调用都命中，提示噪声，
建议后续在 catalog/hint 侧要求 ≥2 种不同工具；② 自动固化描述里的「N 次」恒为 1
（`signalOf` 用 count=1），纯文案问题。

## 11. 会话命名（需求 C，2026-11-18）

宿主能力结论：

- 有写入 API：`ctx.sessionTitle.rename(session, title)`（`@deepseek-ai/dsh-session-title`）→ 追加
  log-only `session/title`（`source:{kind:'user'}`，并 pin 住标题，自动生成不再覆盖）；
  `get(session)` 读回。API 网关另有 `SessionService.rename` Remote（仅客户端显式 rename）。
- Session header **没有** title 字段（header 是创建期不可变）；GUI 会话列表读的是 `title` projection
  （`~/.dsh/storages/session_projcache/sessions/<id>.json` 的 `record.rows.title.val`），
  插件创建的分支此前恒为 `null` → 「未命名」。
- 降级：无 sessionTitle 服务时按 rename 的精确事件形状直接 `session.append('session/title', …)`；
  都不可用则仅插件层命名（成员/面板），GUI 仍显示未命名——如实报告，不伪造。

实现：

- `src/title.ts`：`sessionTitleFor`（去 markdown/方括号 → 首行 → 任务 16 字截断 →
  `<话题> · <任务>` → 40 字上限 → 同集重名 `（2）`）；`ensureMemberTitle`（首次命名并持久化，
  复用保持首次命名）；`applySessionTitle`（host rename 优先 → append 回退 → already/none）。
- 接入：`dispatch.ts`（新分支 / resume / continue / fork 统一命名）、`panel.ts`（话题集会话 +
  面板回复新建分支）、`reconcile.ts`（重启恢复 resume 时补命名）。
- `services.ts`：按实际能力扩充 `sessions.append/seq` 与**可选** `sessionTitle` 声明
  （注释标明宿主内部结构、compile-time only、不 shadow 宿主）。

实测（真实 GUI，话题集「命名验证」派发两次）：

- member title：`命名验证 · 只回复 OK。` / `命名验证 · 只回复 OK。（2）`
- 分支日志 `session/title`：`{"title":"命名验证 · 只回复 OK。","messageSeqs":[],"source":{"kind":"user"}}`
- 投影缓存 `title.val`：`命名验证 · 只回复 OK。`（GUI 侧栏读此值，原先为 null）
- 重载证据：`memory_ui` 端口 61327 → 禁用后工具 `unknown tool "memory_ui"` → 启用后端口 61390。

闸门：`npx tsc --noEmit` 0 错；`pnpm smoke` = 5 + 16 + 26 + SIM SMOKE OK；`pnpm build` 成功；
profile patch 原子改后已还原（无 supermemory 条目）。

## 12. 中断兜底（需求 D）+ 端到端实测（2026-11-17 第五轮）

事故背景：分支会话执行「禁用插件」重载的第 1 步时被自身 fiber 卸载连带杀死，turn 没有
turn/end → observe 永不 settle → dispatch 永久 dispatched、relays=0，hub 只看到“已停止”。

机制（commit `918b642`）：

- `schema.ts`：dispatch 状态增加 `interrupted`；新增 `lastActivityAt` 心跳字段。
- `observe.ts`：
  - 心跳：分支任何 `session/event`（30s 节流）刷新在途 dispatch 的 `lastActivityAt`，
    所以“沉默”是可证明的（不是 updatedAt 陈旧误判）。
  - 失败终态 relay 附「已完成部分」摘要（aborted 前的 assistant 文本）。
  - `settleInterruptedDispatches(deps,{timeoutMs,now?,reason?,terminalOnly?})`：
    终态但从未送达 → 补发；open 且心跳超时 → 标 `interrupted` 并只 relay 一次
    （幂等键 `dlv-<dispatchId>`，已有 outbox 行即跳过）；分组只走组汇总。
- `index.ts`：`observe.interruptAfterMs`（默认 900000）；5 分钟巡检调用；插件
  dispose 时 `timeoutMs:0` 立即结算在途派发并 relay；启动对账后 `terminalOnly` 补发历史中断。

E2E 实测（2026-11-17 14:0x，单次对照实验）：

1. 派发长任务 `dsp-mwkajesy-ku55f4`（分支`branch-mwkajetk-c5miky` 跑 `sleep 180`，turn 打开）。
2. 在 GUI 对 dsh-supermemory 执行禁用→启用（正是上次事故动作）。
3. 结果：分支 turn 以 `aborted` 结束 → observe **1 秒内**结算：dispatch `failed` /
   `turnEndReason=aborted`，outbox `relayed` → `confirmed`，回执原文
   “结果：分支未成功完成（分支终态 aborted）。以上为失败事实，未伪装成答案。”
   无「已完成部分」段——该分支只跑了一次 sleep，没有 assistant 文本可摘要。
4. 台账：`OPEN=0`（无滞留）；重载后 `memory_recall`/`memory_dispatch` 均为 function。

同时复验命名（重载后新代码）：派发 `dsp-mwkai4hb-syz2bt` → `branch-mwkai4hy-fly4iw`，
投影 `title.val = "1、现在提出问题，它依旧 · 命名验证：直接回复一行文字「"`，成员 title 同值，
派发 `delivered/completed` 且回执 `命名分支确认` 已 confirmed。

**未实测到的两条路径**（如实记录）：

- 15 分钟超时巡检（分支活着但彻底静默）——需真实等待，仅单测 D1 覆盖。
- dispose 文案路径（`插件重载/卸载导致分支中断`）——本次 turn/end 先到，走了 abort 路径
  （信息更全，属更好结果），仅单测 D3 覆盖。

SOP（写死）：**禁用/重载插件只能在 hub 会话或 GUI 执行，分支会话内绝对禁止**；重载前若有
在途派发，dispose 兜底会补回执，但最好让分支自然结束再重载。

闸门：`npx tsc --noEmit` 0 错；`pnpm smoke` = core 5 + mechanism 19（含 C1–C4/D1–D3）+
webui 26 + client-sim OK；`npx tsdown` 构建成功（lib/supermemory.js 208.93 kB）。




