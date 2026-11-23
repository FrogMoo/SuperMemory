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
  实例上挂 `typertRemote` 绑定（`{ service, serviceKey, namespace }`，即
  `bindTypertRemote(this,'supermemoryPanel')` 的等价形状）+
  `ctx.get('typert').register({ package, face:'host', schemas:[], model:{...}, invocations })`
  （descriptor 形状见 `src/panel.ts`，参照 dsh-ops 的 runtime-host 模式）。
  **不要写 `ctx.typert.register(...)`**：ctx 是代理，读未 inject 的服务属性会抛
  "cannot get property 'typert' without inject"；`ctx.get()` 不受 inject 限制。
  注册失败必须 console.warn，不许静默 catch——静默正是 2026-11-18 面板 404 的根因（见 §13）。

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

## 6.1 插件页看不到插件：根因与修复（2026-11-17 晚）

用户报「侧边栏插件页里看不到这个插件」。审查结论与修复：

- **根因**：工作区从 `G:\09 - dsh\SuperMemory` 搬到 `F:\10-SuperMemory` 后，§6 的
  link bundle 安装失效，安装方式退化为 profile `cordis.patch.yml` 的**路径行 insert**
  （`name: 'F:/10-SuperMemory/lib/supermemory.js'`）。插件照常加载、功能正常，
  但**插件页只列 profile 依赖 + `dsh.profile.bundles`**（源码级结论：
  `@deepseek-ai/dsh-plugin-manager` 的 `readBundles()` 每次调用实时读
  `profile/package.json`，列目条件是「dependencies 里有这个名字」；patch 路径行
  从来不进依赖表，所以页面上永远看不到——§6 早已记载「patch 路径行插入不显示」，
  这次是退化安装踩中）。
- **修复（已完成）**：重新按 bundle 形态安装——
  profile package.json 增加 `"dsh-supermemory": "link:F:/10-SuperMemory"` 并加入
  `dsh.profile.bundles`（末位）；删除 profile patch 里的路径行 insert 块
  （否则与 bundle 自带 cordis.patch.yml 的 `id: supermemory` 重复注册）；
  profile 目录 `pnpm install` 建好符号链接。备份：
  `package.json.bak-2026-11-1714494-bundle-fix`、`cordis.patch.yml.bak-2026-11-1714494-bundle-fix`。
  静态验证 9/9 通过（模拟 readBundles：installed/enabled/removable=true、
  availability=profile、rows=[{supermemory, dsh-supermemory}]、engines 满足、
  平台无限制、patch 与入口均可达）。
- **生效方式**：列目是实时读盘，**刷新 GUI 插件页立即可见**；loader 真正加载该 bundle
  与客户端 bundle 图（window.__DSH_BOOT__）需**重启 DSH Desktop**（或插件页禁用→启用
  触发 hmr.reconcileProfile）。
- **后续导入的保证**：新增 `scripts/install-into-dsh.mjs`（`pnpm install:dsh`）——
  幂等的规范化安装：前置检查（dsh.bundle.patch/入口/client 入口）→ 备份 →
  写依赖+bundles → 清理路径行 insert → pnpm install → 5 项验证。
  工作区再搬家只需重跑一次。已用合成旧态 profile 端到端测试通过
  （自动把失效 link 改为新路径、自动清路径行）。GUI 插件页导入本地绝对路径同样
  走 bundle 自动激活（reconcileProfilePlugins），但本脚本是唯一保证路径。
- **副作用记录**：pnpm install 重跑 ssh2 的可选原生构建（本机无 VS，与既往一致地
  失败并回退纯 JS，ssh2 require 测试通过）；cpu-features 目录被 pnpm 当可选依赖剪掉，
  不影响功能。

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





## 13. 面板 404 / 话题集列表为空 / 中枢与分支无区分（2026-11-18 第六轮）

用户报三个 GUI 现象：① 超级记忆面板显示但报「加载失败: client api:
supermemoryPanel/listTools failed: transport failure for
/api/supermemoryPanel/listTools: HTTP 404」；② 新建会话→话题集会话→选择话题集时显示
「当前工作区还没有话题集。」（实际有 10 个话题集）；③ 中枢会话与分支会话在 GUI 侧边栏
没有任何区分。

### 13.1 根因：①② 同一个——typert 描述符从未注册成功

**结论（真实宿主源码 + 进程内 cordis 实验双重证实）**：`src/panel.ts` 的 `attachPanel()` 用
`(ctx as ...).typert?.register({...})` 注册 Remote 描述符。cordis 4 的 ctx 是代理：
属性访问 `ctx.typert` 要求插件 inject 声明该服务，否则 getter 抛错
（`ReflectService.handler.get` → "cannot get property 'typert' without inject"，
见 `@deepseek-ai/cordis` lib/index.js）。本插件 `src/index.ts` 的 inject 没有 'typert'，
于是每次注册都抛错，被 `attachPanel` 的 `try { } catch {}` 静默吞掉 → typert local
registry 里从来没有 `supermemoryPanel/*` 描述符 → 宿主 API Gateway 不认领
POST /api/supermemoryPanel/* 路由 → 浏览器调用 404 → 面板所有远程调用失败（①）；
新会话选择层的 `api.loadTopicSets()` 失败后回落 `setTopicSets([])`，
显示「当前工作区还没有话题集。」（②）。

**源码级证据**（app.asar 内 `@deepseek-ai/dsh-api-gateway/src/index.ts`）：

- `TypertGatewayService.claimsEndpoint(endpoint)`：先查
  `this.ctx.typert.local.get(endpoint)` / `hasSeen(endpoint)`，再查 `collectSrcClaims()`
  （后者只认带 `@Remote` 装饰器的方法标记，普通类没有）→ 描述符没注册就 404。
- `validateBinding()` / `readBinding()`：调用前要求服务实例暴露
  `typertRemote` 绑定，且 `binding.service === originalOf(receiver)`、
  `binding.serviceKey === 服务键`、`typeof binding.namespace === 'string'`，
  否则抛 `gateway/binding-invalid`。即
  `@deepseek-ai/dsh-typert-protocol` 的 `bindTypertRemote(this,'supermemoryPanel')`
  产物形状 `{ service, serviceKey, namespace }`。
- `dsh-typert-loader/src/index.ts` 明确写着："Manual `ctx.typert.register()`
  remains available for contributions that do not use a `./typert` artifact
  (hand-written wire schemas...)" —— 手写描述符的插件走手动 register 是官方路径。
- `dsh-typert-registry/src/service.ts` 的 `validateInvocation()`：id 非空、service 为
  segment（无 '#'）、namespace/method 匹配 `/^[A-Za-z0-9_$.-]+$/`、strict codec 必须有
  typeSymbol + create()。

**进程内实验**：插件子 fiber 里 `ctx.provide('supermemoryPanel', service)` 对根 ctx
可见（Gateway 用根 `ctx.get` 能解析到）；`ctx.get('typert')` 不受 inject 限制
（cordis reflect.d.ts 注释 "Read a service from the store without the inject
requirement"）。

### 13.2 修法

- `src/panel.ts` `attachPanel()`：`ctx.get('typert')?.register(...)` 取代
  `ctx.typert?.register(...)`；typert 缺失或 register 抛错都 `console.warn`（不再静默）；
  在 `ctx.provide` 前给实例挂非枚举 `typertRemote` 冻结绑定。
- 新增 `sessionBadge(sessionId)` + 描述符 `dsh-supermemory#supermemoryPanel/sessionBadge`
  （问题③的数据面）。
- `src/client/{remote,index,panel-page,locales}.ts` + 新文件 `src/client/session-badge.tsx`：
  客户端半边补 `sessionBadge` 调用、`sidebar.session.row.leading` 槽的第 4 处注册
  （id `supermemory-branch`，order 30，与宿主 dsh-client-ui-schedule 的 clock mark
  同槽同手法）与「分支」徽标组件；`resolveCwd()` 改为优先取主视图会话自己的
  `cwd`/`header.cwd`（与 panel-page.tsx 同源），再回落 `workspaces[0].path`。
- 徽标门控是上游行为（`dsh-client-ui-workspace` 的 Rows 组件）：
  `!row.archived && !row.blank && (showStatus ? 状态点 : renderSlot('sidebar.session.row.leading',
  { sessionId }))` —— 忙碌/待审批的会话行仍显示状态点，不显示徽标。

### 13.3 回归闸门

- `scripts/mechanism-smoke.mjs` 新增 E1–E3（脚本自行 re-exec 加
  `--experimental-transform-types`，因为 `src/panel.ts` 用了 TS 参数属性，
  strip-only 模式不支持）：假 typert registry + 假 store 直接跑真实 `attachPanel()`，
  断言 register 只调一次、`typertRemote.serviceKey/service` 正确且非枚举、
  每条描述符都过 `validateInvocation` 规则、host 侧 invocations 与 client 侧
  `PANEL_REMOTE.descriptors` 的 id 集合完全一致（合同 parity）、
  `sessionBadge` 的分支/归档/未知判定、以及 typert 缺失/注册抛错都只 warn 不静默。
- `scripts/client-sim-smoke.mjs` 的期望注册表加第 4 条
  `sidebar.session.row.leading:supermemory-branch`。

### 13.4 生效方式（重要）

宿主侧改动（`lib/supermemory.js`）必须插件重载才生效；客户端改动
（`lib/client.js`）在宿主重启后刷新页面即生效（boot 图宿主启动时构建）。
**重载只能在 hub 会话或 GUI 执行：在分支会话内禁用→启用会杀死分支 agent 自己**
（fiber 销毁 → 回执永不送达，见 §12 事故）。

闸门：`pnpm typecheck` 0 错；`pnpm smoke` = core 5 + mechanism 22 + webui 26 +
client-sim OK；`pnpm build` 成功；`lib/supermemory.js` 含 `ctx.get("typert")`/
`typertRemote`/`sessionBadge`，`lib/client.js` 含 `sessionBadge` 与
`sidebar.session.row.leading`。

## 14. 主题对齐 DSH + 中枢页签快速启动 + 组合工具启用/删除（2026-11-18 第七轮）

应用户 3 项 GUI 需求。宿主侧改 src/{panel,composite,model}.ts，客户端改
src/client/{panel-page,new-session,session-badge,remote,index,shell.d.ts,locales}.ts，
管理台改 src/web/style.css + src/webui.ts。

### 14.1 需求①：主题颜色与 DSH 一致（根因：变量名根本不存在）

- **根因**：插件全部 CSS 用 `var(--dsh-color-primary,#3d6fd8)` 这类变量，而 DSH 设计平台
  （`@deepseek-ai/dsh-client-ui-theme` 的 `src/styles/design-platform.css`，app.asar 内
  可读）定义的语义变量是 `--dsw-alias-*` / `--dsw-static-*`，**没有任何 `--dsh-color-*`**。
  即插件一直在渲染自己的硬编码回退色，明暗主题都不跟随（DSH 默认偏好还是 system）。
- **修法（面板/新会话层/徽标，src/client/*.tsx）**：改绑真实词汇表，回退值取 DSH 暗色值：
  - 文本 `--dsw-alias-label-primary`、次要 `--dsw-alias-label-secondary`
  - 背景 `--dsw-alias-bg-base`（#151517）、卡片 `--dsw-alias-bg-layer-1`（#232324）、
    输入/次级面 `--dsw-specific-input-major` / `--dsw-alias-bg-layer-2`（#2c2c2e）
  - 边框 `--dsw-alias-border-l2`（rgba(255,255,255,.12)）、悬停强调 `--dsw-alias-link`（#7aaaff）
  - 主按钮按 DSH 语义对：`--dsw-alias-button-primary-fill` +
    `--dsw-alias-label-primary-foreground`（暗色=白底黑字，与宿主主按钮一致）
  - 错误 `--dsw-alias-state-error-primary`（#f25a5a）、成功 `--dsw-alias-state-success-primary`（#22c55e）
- **管理台（src/web/style.css）**：独立文档（侧边栏 browser tab 是沙箱 iframe，拿不到父文档
  变量），改为自带 DSH 双调色板：`:root` 明色 + `@media (prefers-color-scheme: dark)` 暗色，
  变量名与 `--dsw-alias-*` 对齐（值逐项取自 design-platform.css 的 body 明/暗两块），
  `color-scheme` 同步声明；硬编码的暗色专用值（banner/徽标边框/nav-foot）改为
  currentColor 的 color-mix 派生，明暗自适应。
  **已知限制**：宿主显式 light/dark 偏好无法读入该独立文档（主题 preference 是主题插件
  volatile config，无跨插件读取面），故跟随系统 scheme——与宿主默认偏好 system 一致。
- **实测（ego-browser + CDP setEmulatedMedia，两套 scheme 逐项 getComputedStyle）**：
  面板与徽标在明/暗下全部命中 DSH 设计值（暗：底 #151517、文 #f9fafb、卡 #232324、
  输入 #2c2c2e、主按钮 #f9fafb/#0f1115、危险 #f25a5a、链接 #7aaaff；明：底 #fff、
  文 #0f1115、主按钮 #0f1115/#fff、危险 #ec1313、链接 #4176e6）。

### 14.2 需求②：中枢会话页签 = 快速新建会话（参考新建会话页面）

- **面板（src/client/panel-page.tsx）**：中枢页签顶部新增「快速新建会话」卡片——
  工作区 / Agent 模式 / 模型 / 权限 四个下拉 + 话题集多选（保留原有选择话题集能力，
  含当场新建并自动加入选择）+ 开始按钮。不选话题集→创建普通中枢会话；选中→创建绑定
  这些话题集的话题集会话。创建后自动打开并刷新面板。
  - 工作区下拉走框架标准 hook `useWorkspaces`（state.items），默认指向面板当前工作区；
    切换工作区时，卡片内话题集列表按**所选工作区**重新加载（api.loadTopicSets），
    失效选择自动剔除——不再把别的工作区的话题集建进来。
  - Agent 模式/模型/权限三个目录由宿主只读枚举（见下），下拉均带「跟随默认」项。
- **宿主（src/panel.ts）**：新增 3 个只读目录 + 1 个创建入口，全部走 ctx.get（不新增 inject）：
  - `listAgentPresets()` → `ctx.get('agentPresets').list()`（id/name/description/isDefault）；
  - `listModelCatalog()` → `enumerateModels(ctx)`（`ctx.get('llm').listProviders/listModels`）；
  - `listPermissions()` → `ctx.get('permissionPresets').catalog()`（options/defaultPreset）；
  - `createHubSession(cwd, options)` → `ctx.agents.create({ sessionId, meta:{cwd, agentPreset}, agentOptions:{provider, model, reasoningEffort} })` + 命名 + attachBranchToWorkspace；
  - `createTopicSetSession(cwd, ids, options?)` 扩展同款 options（旧调用不传即旧行为）；
  - 权限预设落地：创建后 `permissionPresets.set(agent.session, preset)`（该服务拥有
    permission/preset 与 knob 事件；agent/created 时宿主已 pin 默认值，显式选择随后覆盖）。
- **顺手修的真 bug（src/model.ts）**：`enumerateModels` 读的是 `ctx.llm` **属性**——cordis
  代理对未 inject 的服务属性访问直接抛 "cannot get property without inject"，`'llm'` 不在
  src/index.ts 的 inject 列表里，于是每次枚举都抛错、被 askDefaultModel 的 try/catch 吞成
  空目录（/memory model 一直走自由输入回退）。改为 `ctx.get('llm')`（无 inject 要求）。
- **合同**：新增 5 个描述符（createHubSession / listAgentPresets / listModelCatalog /
  listPermissions / deleteTool）+ createTopicSetSession 增加 options 参数；
  src/client/remote.ts 同步同 id 集合（mechanism-smoke E1 的 parity 断言把关）。
  shell.d.ts 的 uiWorkspace.startSession 补上可选 workspaceId（与
  dsh-client-ui-workspace 的 navigation 契约一致）。

### 14.3 需求③：组合工具停用后可启用 + 可删除

- **启用**：面板工具页对 status != active 的行显示「启用」主按钮 →
  `editTool(id, { status: 'active' })`（editCompositeTool 的非 retired 分支会反注册旧句柄、
  重新注册并置 active——停用态重新上线）。
- **删除**：新增 `deleteTool(id)`（宿主 `deleteCompositeTool`）：反注册在线工具（若在册）→
  删 tool_memory 行 → **连带删除创建它的 sequence 信号行**（删除不是静默停用：同一流程
  要再跨阈值才可能重新固化）。破坏的 JSON 定义同样可删。面板用两段式内联确认
  （删除→确认删除/取消），不弹原生对话框。
- 管理台（src/web/app.js）的工具表本就是只读展示，本次不改。

### 14.4 回归闸门与实测

- `scripts/mechanism-smoke.mjs` 新增 F1–F4：目录映射与选项透传（含 agentPreset 进 meta、
  model 进 agentOptions、permission 落到 session）、三个目录服务缺失时的降级、
  话题集会话选项透传 + 成员登记 + 空选择拒绝、删除（行+信号+损坏定义+未知 id）。
- 闸门：`pnpm typecheck` 0 错；`pnpm smoke` = core 5 + mechanism 26（+4）+ webui 26 +
  client-sim OK；`pnpm build` 成功（lib/supermemory.js 219.82 kB、lib/client.js 60.48 kB）。
- 主题契约闸门（`scripts/client-sim-smoke.mjs`）：构建产物与管理台 CSS 不得出现
  `--dsh-color-*`（宿主不存在的变量名），必须骑行 11 个 `--dsw-alias-*` 主题变量，且管理台
  必须带 `prefers-color-scheme: dark` 明暗切换——防回归到硬编码回退色。
- 产物标记核验：宿主包含 createHubSession/listAgentPresets/listModelCatalog/
  listPermissions/deleteTool/permissionPresets/agentPresets；客户端包含快速启动键与
  deleteTool，且 `--dsh-color` 归零、`--dsw-alias` 31 处。
- **生效方式（重要）**：插件已按 link bundle 装在 desktop profile
  （~/.dsh/profiles/desktop/package.json 依赖 link:F:/10-SuperMemory）。宿主侧改动需
  **插件重载**（插件页禁用→启用，或重启 DSH Desktop）；客户端改动需**重启后刷新页面**。
  重载只能在 hub 会话或 GUI 执行（§12 事故教训）。
## 15. 面板「strict definition was withdrawn」故障：typert 注册自愈（2026-11-18 第八轮）

### 15.1 现象与根因

- 现象：超级记忆页签加载失败：
  `typert gateway: supermemoryPanel/hubState: its strict definition was withdrawn and SRC fallback is forbidden`；
  记忆工具/派发等其它功能正常。
- 宿主契约（app.asar 内 `@deepseek-ai/dsh-api-gateway/src/index.ts` 的 `resolveDescriptor`）：
  - `ctx.typert.local.get(endpoint)` 命中 → 正常派发；
  - 未命中但 `local.hasSeen(endpoint)` 为真 → 抛 `gateway/definition-unavailable`，**禁止 SRC 回退**；
  - 只有"从未见过"的 endpoint 才尝试 SRC（需 `@Remote` 标记，手工描述符没有）。
- `@deepseek-ai/dsh-typert-registry`：`register()` 是整批事务（package face / endpoint / invocation id
  任一重复即整批拒绝）；撤销只由注册时 `ctx.effect` 的 disposer 触发；`hasSeen` 是 registry 生命周期内的
  历史集合，定义撤销后永久为真。
- 触发链（本次实测：宿主进程 23:13:13 启动，40 秒内面板即失败）：
  1. 插件启动时注册成功（endpoint 进入 hasSeen）；
  2. 启动/重载窗口内组合重建插件 fiber：新实例先 apply 并 `register()`，旧 fiber 仍在（teardown 异步），
     整批被 duplicate 拒绝 → 旧代码只 warn；
  3. 旧 fiber 随后撤销定义 → `get` 为空、`hasSeen` 仍真；
  4. 新实例不会再次注册 → 该 endpoint 在本进程内永久不可用，直到重启 DSH。
  旧 `attachPanel` 注释已预见"duplicate package-face lands here"，但只警告、从不重试。

### 15.2 修法

- `src/panel.ts`：`attachPanel` 只做服务挂载（`ctx.provide` + `typertRemote`），注册拆到
  `attachPanelRegistration(ctx)`：
  - 每个 tick 用 `typert.local.get()` 校验全部端点（true/false/undefined 三态）；
  - 缺失或被撤销 → 重新 `register()`；失败按 250/750/2000/5000/15000ms 退避重试
    （重载竞态的 duplicate 属预期，只首次 warn）；
  - 成功后 1s/4s 复检，之后 30s 看门狗；定时器 `unref` + 返回 disposer 清理，不拖住进程；
  - 成功注册的 disposer 一并纳入清理，插件卸载时撤销自己的注册。
- 兼容：无 `local` 视图的 registry（测试替身/未来宿主）首次仍注册一次，之后视为不可校验的健康态，
  不会盲目重复注册。
- 存储域交接（`src/store.ts` + `src/index.ts`）：重载窗口里新 fiber 的 `storageDomain.open()` 可能撞上旧 fiber
  尚未释放的域名额（`DomainError.code === 'already-open'`），旧代码会直接降级为 `store = undefined`——
  于是面板注册整段被跳过（`attachPanel` 拿不到 store）、记忆工具也退化为空结果。新增
  `openStoreWithRetry` / `retryDomainOpen`：只对 `already-open` 按 100/250/750/2000ms 重试，
  其它失败（version-mismatch/malformed-medium/backend 路由）立即上抛照旧降级。

### 15.3 回归闸门

- `scripts/mechanism-smoke.mjs` 新增 E4：模拟 duplicate face + 旧 fiber 撤销 → 断言退避后自动恢复完整合同、
  首次失败只 warn 一次、dispose 撤销注册。
- 新增 E5：`retryDomainOpen` 对 `already-open` 重试并最终返回 store；`version-mismatch` 不重试、原样上抛。
- 闸门：`npx tsc -p tsconfig.json` / `npx tsc -p tsconfig.client.json` 0 错；
  core 5 + mechanism 28 + webui 26 + client-sim OK；`pnpm build` 产物含 `PANEL_REGISTRATION_RETRY_MS` /
  `retryDomainOpen`。

### 15.3.1 顺带观察（数据面）

- 当前 `~/.dsh/storages/supermemory.json` 的 memories / topicsets / episodes / requirements / tool_memory /
  dispatches / outbox / routing 均为空表（signals / hotcache / filemap 有数据；memory_scan 写入 75 条 filemap 验证存储可写）。
- `.supermemory-export.md`（19:25 导出）仍含 8 条事实记忆 + 3 条归档梗概，可按需用 memory_remember 逐条恢复。

### 15.4 生效与验证

- 宿主侧改动需**插件重载**（插件页 禁用→启用）或重启 DSH；重载后即使再遇到同样的启动竞态，
  也会在 ~250ms 内自愈，面板刷新即可加载。
- 验证方式：重载后打开超级记忆页签，应正常显示（无 加载失败）；失败时再看宿主日志里的
  `supermemory: typert register failed ...; retrying` 是否出现。

## 16. 中枢会话页签 composer 化 + 就地触发中枢对话（2026-11-18 第九轮）

### 16.1 需求

1. 「中枢会话」页签不再是一叠全宽下拉框/复选列表，改为参考 DSH「新建会话」页面的 composer 布局：
   大标题 + 多行输入 + 主按钮，工作区 / Agent 模式 / 模型 / 权限降级为行内次要控件，话题集降级为紧凑 chips。
2. 中枢对话在「超级记忆」页面就地触发：取消「选完选项 → 跳转到新会话页」流程，创建会话后
   首条消息直接送达、回执就地展示；只有用户主动点「打开会话」才跳转。

### 16.2 宿主（src/panel.ts）

- `createHubSession(cwd, options?, firstMessage?)`、`createTopicSetSession(cwd, ids, options?, firstMessage?)`
  新增可选 `firstMessage`；`createSessionWithOptions` 现在把 `ctx.agents.create()` 的 handle 带回，
  由 `deliverFirstMessage(handle, text)` 用 `messageFactory()({content:[{type:'text',text}],
  source:{kind:'supermemory'}})` + `handle.agent.followup(message)` 直接把开场白送进新会话
  （与 dispatch.ts 唤醒分支同一套写法）。
- 发送失败不丢会话：仍返回 `status:'ok'` + 已建 id，message 写明「会话已创建，但首条消息发送失败：…」；
  空文本则跳过发送（`仅创建会话` 路径）。
- wire 契约三处同步：`PANEL_DESCRIPTORS`（新增 `firstMessage` 参数，`acceptsUndefined`）、
  `src/client/remote.ts`、`src/client/index.ts`；mechanism-smoke 的 parity 断言仍然通过。

### 16.3 客户端（src/client/panel-page.tsx）

- `hubView` 头部换成 composer：`sm-composer-title`（中枢会话）/ 说明 / `textarea`（min-height 96px，
  Ctrl/Cmd+Enter 发送）/ 主按钮「开始对话」+ 次要「仅创建会话」+ 提示行。
- 次要控件行 `sm-composer-opts`：四个 pill（`sm-opt` + 内嵌原生 select，透明背景、11px）——
  工作区 / Agent 模式 / 模型 / 权限，默认值逻辑沿用（工作区默认主视图会话 cwd）。
- 话题集 `sm-composer-sets`：每个话题集一个可切换 chip（`data-active`），末尾「＋新话题集」
  展开原有建集输入（`launchCreateSet`）。
- 提交 `startLaunch('chat'|'bare')`：**不再调用 `api.openSession`**；成功后清空输入、生成
  `sm-receipt` 回执（会话类型徽标 + 宿主回执文案 + 会话 id + 「打开会话」/「收起」按钮）并刷新中枢状态。
- 旧的「快速新建会话」卡片与中枢页签里的「新建话题集」表单移除（入口并入 composer）；`newTopicTitle` 状态随之删除。
- 新增 CSS 全部走 `--dsw-alias-*` 变量，随主题明暗自动适配。

### 16.4 locales

- 新增 `composer.title / desc / placeholder / start / createOnly / createOnly.hint / hint / newSet /
  setsEmpty / open / dismiss / receipt.hub / receipt.sets`，zh/en 两字典键集合一致。

### 16.5 回归闸门

- `pnpm typecheck`（host + client 两个 tsconfig）0 错。
- `pnpm smoke`：core 5 + mechanism 28（含 E1–E5）+ webui 26 + client-sim OK。
- `pnpm build`：host 7 chunk + client `lib/client.js`（wrap-client 64986 bytes）成功。

### 16.6 生效与验证

- 已在本机 GUI 会话执行插件「禁用 → 启用」重载；**浏览器刷新 http://127.0.0.1:49988** 后：
  中枢会话页签顶部应显示「中枢会话」大标题 + 多行输入 + 「开始对话」，下方一行紧凑 pill 控件与话题集 chips。
- 输入内容点「开始对话」→ 应停在当前页并出现回执卡（回执文案 + 会话 id + 「打开会话」），
  不再跳转到新会话页面；侧边栏会多出一个「新会话 · xxxx」。

## 17. 话题集页签 / 标题+标签+正文记录形态 / 分支会话全能力（2026-11-18 第十轮，R9–R11）

### 17.1 需求

1. 「超级记忆」页面增加**话题集页签**，并显示每个话题集里有多少会话（R11）。
2. 话题集、记忆、组合工具统一为**标题 + 标签 + 正文**，检索先命中标题/标签索引，不必扫描全部正文（R10）。
3. 派发出的**分支会话要具备中枢会话的全部能力**（文件系统与 shell），不再只有 REA/记忆类工具（R9）。

### 17.2 R9：分支能力继承（根因与修法）

- 根因（读宿主源码确认，不是猜测）：`ctx.agents.create()` 只组装 **Host 插件**（`memory_*`、session 工具等）；
  文件/shell 工具由**会话所选 agent preset** 贡献（profile 里 `include:tool-bash`/`tool-fs` 均为 enabled:false，
  中枢之所以有 bash/read/write，是因为它挂载了 preset）。分支创建时既没写 `meta.agentPreset`、
  也没在 `setup` 里 `agentPresets.mount(...)`，所以只拿到 Host 工具。
- 修法（`src/dispatch.ts`，与宿主 `dsh-api-session-controller`/`dsh-headless` 同一官方写法）：
  - `hubComposition(ctx, hubAgent)` 读取中枢的 preset（`agentPresets.presetForSession(session)`，
    退化到 `session.header.agentPreset`）、沙箱模式（`sandboxPolicy.resolve({session}).mode`）与审批策略
    （`approval.overrideOf(session) ?? approval.config.policy`）。
  - `compositionSetup(ctx, wanted, logger)`：setup 回调里 `await presets.mount(agentCtx, id)`；id 优先取
    **该会话日志里已记录的 preset**（恢复的分支保持同一组合），否则用中枢 preset。
  - create 走 `meta: { cwd, agentPreset }` + `setup`；resume 与 fork 同样传 `setup`，fork 的 meta 也写 preset。
  - 权限随派发复制：`session.append('sandbox/mode', {mode, source:'delegation'})` +
    `session.append('approval/policy', {policy, source:'delegation'})`——无人值守的分支不能卡在审批上。
  - 降级：preset mount 失败只 warn（分支仍拿到 Host 工具与 relay 通道），日志写明原因。
- 实测（重载后真实派发）：分支报告 shell ✅（`node -e "console.log(1+1)"` → `2`，`pwd` → `/f/10-SuperMemory`）、
  `read` ✅（`package.json` name = `dsh-supermemory`）。修复前同一任务只能报告缺能力。

### 17.3 R10：标题 + 标签 + 正文

- **存储**（`src/schema.ts`，域版本仍为 1）：`memories.title` 新增（`.default('')`），
  `tool_memory.title` + `tool_memory.tags` 新增（默认空）。旧记录靠 zod 默认值在读取边界补齐
  （`storage-domain` 的 `loadAll` 用解析结果进内存），因此**无需迁移脚本、无需升版本**。
- **共享规则**（新增 `src/retrieval.ts`）：`deriveTitle`（正文首句派生标题）、`normalizeTags`
  （数组/逗号串→去重标签，≤12 个）、`mergeTags`（有显式标签就**只用**显式标签；没有才回退到正文关键词——
  旧实现把 CJK bigram 混进显式标签里，正是「全都糊在一起」的来源）、`renderRecordLine`（`【标题】正文 ｜标签: a、b`）。
- **召回**（`src/recall.ts`）：标题命中 ×4、标签命中 ×3、正文 ×1（都乘查询权重），
  阈值仍是原始命中数、衰减只排序；卡片按三层渲染。
- **工具**：`memory_remember` 新增可选 `title`/`tags`；`memory_recall` 输出/渲染带 title+tags；
  `memory_topicsets` 增加 `tags` 与 `sessions`（会话数，`branches` 保留兼容）。
- **组合工具**：`CompositeSpec.title/tags`（tags=该流程出现的工具名去重），`persistComposite` 落库，
  `editCompositeTool` 支持改 title/tags（模型看到的 name 不变）。
- **宿主面板**（`src/panel.ts`）：`TopicSetView{tags,sessions,live}`、`MemoryView{title,tags}`、
  `ToolView{title,tags}`；`createMemory/updateMemory(+title,+tags)`、`updateTopicSetSummary(+tags)`、
  `editTool(patch.title/tags)`；`listMemories` 检索按标题/标签/正文加权。wire 三处同步
  （`PANEL_DESCRIPTORS`、`src/client/remote.ts`、`src/client/index.ts`）。
- **独立管理台**（`src/webui.ts` + `src/web/app.js` + `src/web/style.css`）：新建记忆有标题+标签+正文三段；
  记忆行标题加粗、标签 chips、正文折叠；话题集卡片显示「N 个会话」+按标题/标签搜索；工具表新增标题/标签列。
- **导出**（`src/export.ts`）：记忆行与话题集头都带标题/标签，`.supermemory-export.md` 保留三层。
- 向后兼容：老记录 title 为空 → 面板/管理台用正文首句兜底显示；正文仍是权威内容。

### 17.4 R11：话题集页签 + 会话数

- `src/client/panel-page.tsx`：新增 `sets` 视图与页签「话题集」（顺序：中枢会话 / 话题集 / 记忆 / 组合工具），
  搜索框按**标题或标签**过滤（索引无命中才回退正文），卡片显示标题、标签 chips、正文（3 行折叠）、
  「N 个会话」「N 个在线」徽标、模型、激活/进入按钮；详情页补标签编辑（与正文一起保存）。
- locales：`tab.sets`、`sets.search/clear/stats/empty/sessions/live/open/noBody`、
  `memory.title/tags/body/shape.hint` 等 zh/en 对称新增。
- 管理台总览新增「话题集会话」统计卡；话题集页顶部显示「显示 x / y 个话题集 · 共 z 个会话」。

### 17.5 回归闸门

- `npx tsc -p tsconfig.json` / `npx tsc -p tsconfig.client.json` 0 错。
- `node scripts/core-smoke.mjs` **6**（新增：标题命中压过正文命中、导出保留标题层）。
- `node scripts/mechanism-smoke.mjs` **31**（新增 F5/F6 分支能力继承与降级、G1 记录形态三分离）。
- `node scripts/webui-smoke.mjs` **26**（新增：title 落库/更新、state 暴露 title/tags、显式标签不被自动词污染）。
- `node scripts/client-sim-smoke.mjs` OK；`pnpm build` 宿主 8 chunk（新增 `retrieval-*.js`）+ client `lib/client.js`（wrap 74941 bytes）。
- 已用 `plugin_manager` 对 `include:supermemory` 禁用→启用重载；独立管理台用 `memory_ui` 令牌 URL 实测通过
  （话题集「3 个会话」、按标签 `验收` 过滤记忆只剩 1 条、恢复后 3 条）。

### 17.6 生效与验证

- 宿主/客户端均有改动：**刷新 http://127.0.0.1:49988**，打开「超级记忆」→ 应看到「话题集」页签，
  每个话题集卡片显示会话数；记忆/组合工具显示标题 + 标签 + 正文。
- 派发到分支后，分支首条自检应能运行 shell 与读文件（R9）。
- 数据面：旧记录 title 为空属正常（显示时用正文首句兜底），编辑保存后即写入新字段。

## 18. 中枢侧边栏 / 自动三层 / 分支能力脚本 / 徽标持久化 / 前端改版（第 18 轮，R18）

### 18.1 需求

1. 「超级记忆」页面内部左侧栏记录/切换**中枢会话**（当前会话高亮、在线绿点、点击打开、＋新建中枢会话；窄窗折叠为顶部横条）。
2. 创建话题集/记忆/组合工具时由大模型主动填**标题 + 标签 + 正文**，不留空白给用户；面板新建后在原处显示自动生成的标题与标签。
3. 修 bug：分支会话的「分支」标签在 DSH 里**不持久、有时直接消失**（刷新页面才恢复）。
4. 分支会话能力由中枢**派发前设定**（read / read-write / full / minimal），并**固化进派发脚本**（首条消息写明能力边界），而不是靠模型自觉。
5. 中枢只派发 + 汇总，不执行实际操作——用户选择**软约定**（systemPrompt 注入，不摘除中枢工具）。
6. 前端美化：面板两栏 + 统一 8px 栅格/10px 圆角/hover/tab 下划线/空状态插画/按钮分层；独立管理台固定导航 + 卡片列表 + 移动端折叠 + 明暗双主题。

### 18.2 需求①：中枢会话侧栏

- **新增 `src/hub-sessions.ts`**（复用给面板与管理台）：`HubSessionView { sessionId,title,live,updatedAt,createdAt,origin:'hub' }`，
  `listHubSessions(ctx, store, cwd, limit=50)`。
  - 过滤：`header.cwd` 经 `workspaceKeyOf` 与当前工作区一致、`!header.parentSession`、`header.origin !== 'subagent'`、
    **不属于任何话题集 member**（`store.topicsets` 全量成员集合，**含归档话题集**——归档并不释放成员，
    所以归档话题集里的分支不会被误判成中枢）。
  - 标题：`readTitleSnapshots(ids)` **一次批量读**；拿不到 → `未命名会话 ` + id 尾 4 位。
  - 排序/上限：`updatedAt` 降序（标题事件时间优先，否则 createdAt），最多 50 条。
  - 降级：`sessionQuery` 缺失 → `ctx.sessions.list()`（标题只能用兜底名）；再缺 → `[]`。
  - **签名核对（重要）**：运行时的 `sessionQuery.listSessions` 是 `(signal?: AbortSignal)`（从 `app.asar` 的
    `dsh-session-query/src/corpus.ts` 源码确认：首行 `signal?.throwIfAborted()`）。传 `false` 会命中 `false.throwIfAborted`
    抛 TypeError，因此实现改为**无参调用**（等价于列全量语料）。
- **宿主 `SupermemoryPanelService.listHubSessions(cwd)`**（`src/panel.ts`）调用上面的函数；wire 三处同步：
  `PANEL_DESCRIPTORS`（`typeSymbol: dsh-supermemory#HubSessionRows` + `cwd` 参数）、`src/client/remote.ts`、`src/client/index.ts`。
- **客户端 `src/client/panel-page.tsx`**：整页改成 `.sm-shell` 两栏 —— `.sm-side`（左栏）+ `.sm-main`（右主体）。
  - 左栏「中枢会话」标题 + 计数 + 列表：每行标题、（live）`sm-dot` 绿点、（当前会话）`data-current` 高亮；
    点击行 `api.openSession(sessionId)`（`uiWorkspace` 经 `index.ts` 注入的 `PanelApi.openSession`）。
  - 左栏底部「＋ 新中枢会话」→ 切到 hub 视图并清空回执。
  - `refreshHub()` 并行执行 `loadHub` 与 `listHubSessions`（创建/刷新后左栏立即出现新会话）。
  - 纯 CSS 折叠：`@media (max-width:760px)` 下 `.sm-side` 变横向条、列表横向滚动。

### 18.3 需求②：自动三层（标题 + 标签 + 正文）

- **话题集**：`panel.createTopicSet(cwd, title, tags?, summary?)`；`tags` 缺省 = `tagsOfBody(title + summary)` 派生，
  `summary` 落库（≤500）。`memory_new_topicset` 新增可选 `tags` / `summary`，描述明确「必须同时给出 title + tags + summary，
  不要省略」；返回体与 render 都带 tags。
- **话题集会话**：`createTopicSetSession` 的首条消息由新的纯函数 `buildTopicSetOpening(store, ids, text)` 生成，
  以 `[supermemory-topic-set] 话题集：… ｜标签: …` + `话题集梗概：…` + `用户开场：…` 开头（导出该函数供 smoke 断言）。
- **记忆**：`memory_remember` 描述改为「必须同时给出 title + tags + 正文，不要省略」，参数说明同步；
  宿主 `createMemory` 的 `deriveTitle` / `mergeTags(normalizeTags, tagsOfBody)` 兜底保持（R10 已有）。
- **面板新建记忆**：正文 `onBlur` 时若标题或标签为空，调用新远程方法 `suggestMemoryShape(text)`
  （宿主复用 `retrieval.ts`：`deriveTitle` + `mergeTags([], tagsOfBody)`）自动补全并显示「已按正文自动补全…」；
  用户已填的字段不覆盖。
- **面板新建话题集**：创建后回读 rows，把宿主动作实际写入的 `title + tags` 显示在 composer 下方（`sm-set-created`），
  不再停在空白输入框。
- **组合工具**：核对 `persistComposite`（R10 已实现）——`title: spec.title ?? deriveTitle(description,name)`、
  `tags: normalizeTags(spec.tags ?? spec.name)`，创建即三层齐全，无需改动。

### 18.4 需求③：分支徽标不持久（根因 + 修法）

- **根因**（`src/client/session-badge.tsx`）：`badgeCache` 是模块级 `Map`，**任何成功结果都永久缓存**。
  会话先被读成 `{kind:'hub'}`（派发/建成员在几秒后才发生），之后成员加入话题集，徽标读取仍命中这个永久 `hub` 缓存 →
  侧边栏永远不出现「分支」，只有整页刷新（模块重建）才恢复。
- **修法**：缓存条目改为 `{badge, at}`：
  - `branch` 成功结果**永久缓存**（成员关系已经是事实，只有归档会改变，重载/重扫本来就会重读）；
  - `hub` 是**否定观测**，加 **8 秒 TTL**，过期即重新读取；
  - 导出 `invalidateBadge(sessionId?)`：清缓存 + 通知已挂载行重读（模块级 listeners）；
  - 面板侧在 `refreshHub()`（创建会话后）、`startLaunch` 回执后、以及每次成功变更（`run()` 里）调用
    `api.invalidateBadges()`（`src/client/index.ts` 把它接到 `invalidateBadge`）。
- **第二条持久化路径排查（结论：不是成员丢失）**：
  - `dispatch.ts` 命名走 `ensureMemberTitle()`，其 `addMember` / `updateMember` 都是 **await** 落盘；
    失败会在 dispatch 的命名 try/catch 里 warn，派发本身不丢。
  - `observe.ts` 结算只 `updateMember(..., {status:'idle'})`，**不覆盖 title/tags**（`updateMember` 是浅合并 patch）。
  - 宿主 `sessionBadge` 只认 `topicSet.status === 'active'`：话题集归档后徽标变 hub 是**预期行为**，不是成员消失。

### 18.5 需求④：分支能力由中枢设定 + 固化到脚本

- **新增 `src/capabilities.ts`**：`CapabilityProfile = 'read' | 'read-write' | 'full' | 'minimal'`、
  `resolveCapabilities(name)`（未知/省略 → 默认 `read-write`）、四档静态 deny 词表、`applyCapabilities(tools, agent, resolved, logger)`。
  - `read`：deny `write/edit/apply_patch/bash/terminal_*/job_*/memory_dispatch`；
  - `read-write`：deny `bash/apply_patch/terminal_*`；
  - `full`：无 deny（且**不调用** `restrict`）；
  - `minimal`：用 `tools.definitions(agent)` 的可见集合做差集，只留 `read`、`send_message`、`wait_agent` 与 `memory_*`
    （静态 deny 词表同时保留，作为无 registry 时的兜底）。
  - `tools.restrict()` 对未知/scope-local 工具名会**直接抛错**，所以静止 deny 列表先与 `definitions(agent)` 求交；
    若仍被拒绝，解析错误信息里被点名的工具做**一次有界重试**（去掉被拒名字、保留其余限制）；
    重试仍失败或没有可保留项 → 只 `warn`（`failed`）。`agentCtx.tools` 缺失记 `unsupported` 且**不告警**（旧宿主/假上下文属已知降级）。
- **`src/dispatch.ts`**：`compositionSetup(ctx, wanted, logger, capabilities?)` 在 **preset mount 之后**对 `agentCtx.tools` 调
  `restrict({ deny })`。DSH 的 `restrict` 实现是 `scopeOf(this.ctx)`，**必须**在分支 agent scope（`agentCtx`）上调用，
  在全局 ctx 上调会抛「requires a scoped context」——因此能力限制只能放在 setup 回调里，这也正是本实现的位置。
- **新增 `src/script-delegation.ts`**：`buildDispatchScript({ task, capabilities, topicTitle, branchSessionId, dispatchId? })`，
  生成分支首条消息：`[supermemory-dispatch …]` 头 + 话题集 + 任务 + **「本轮能力边界：<档位>（<说明>）；越界请汇报而不是硬做」**
  + 工作分支约定。`dispatchOne` 用它替换原先内联拼的文本——**能力边界写进脚本**，不依赖模型自觉。
- **`memory_dispatch` 新增可选 `capabilities`**（enum 四档，默认 read-write），描述写明四档差别并建议：
  需要改代码/跑命令用 `full`，只审阅用 `read`，纯编辑用 `read-write`，汇总/轻量核对用 `minimal`。

### 18.6 需求⑤：中枢软约定（systemPrompt provider）

- `src/index.ts` 新增 section `supermemory:hub-role`，`order: 901`（紧跟 900 的记忆规则），`text` 是 provider：
  组装时读 `ctx.agents.currentInitiator()`，取不到则回退 `context.scope`（`ScopeKey` 就是 Agent 对象，
  `dsh-scope` 源码 `export type ScopeKey = object`），再由 `isHubSession()` 判定：
  **有 `parentSession` → 否；`origin==='subagent'` → 否；是任一话题集 member（含归档）→ 否**；否则注入中枢角色文本。
- 文本内容：只做判断 / `memory_dispatch` / relay 汇总；不直接读改文件、不跑命令、不长篇推理；派发前先设能力档位。
- **软约定**：没有摘除中枢的任何工具（用户明确选择软约定），只是 prompt 层面的分工；分支一律不注入该段
  （成员/父子判定为 false），否则分支会拒绝干活。`PROMPT_TEXT` 与 `memory_dispatch` / `memory_remember` 描述同步了同样的语气。

### 18.7 需求⑥：前端改版

- **面板（`src/client/panel-page.tsx`）**：整套 CSS 重写——
  - 8px 栅格间距（8/16）、卡片/列表 10px 圆角、hover 提亮边框 + 轻微阴影；
  - 页签改**下划线**样式（`border-bottom: 2px solid`，激活色 `--dsw-alias-link`）；
  - 去掉了满屏大 `h1` + 计数堆叠，头部改为一行紧凑：品牌 + 工作区 key + 计数 pills；
  - 空状态统一 `EmptyState`（内联 SVG 插画 + 标签 + 提示语），覆盖中枢/话题集/记忆/工具/分支列表；
  - 按钮分三层（primary / secondary=默认 / danger），`data-size="sm"` 提供小号；左栏新建按钮用小号；
  - 颜色全部走 `--dsw-alias-*`（新增用到 `--dsw-alias-border-l1`、`--dsw-alias-interactive-bg-hover`、
    `--dsw-alias-state-success-primary` 等，缺的用 `color-mix(... , transparent)` 而不是写死 rgba）。
- **独立管理台（`src/web/style.css` + `src/web/app.js`）**：
  - 左侧固定导航分组：**中枢会话 / 话题集 / 记忆 / 组合工具 / 统计**（`记忆中枢`），下面 `运维明细`
    （需求 / 派发与交付 / 归档梗概 / 文件地图 / 信号）；
  - 新增 `renderHubs`（宿主 `/state` 增加 `hubs` 字段，复用 `listHubSessions`）、`renderTools`（从 signals 拆出）；
  - 派发 / 交付箱 / 文件地图 / 会话路由的表全部改成**卡片列表**（`.card-list` / `.list-card`）；
  - `--radius` 10px、卡片 hover、760px 以下导航折成顶部横条；明暗双主题变量沿用既有 `--dsw-alias-*` 映射。

### 18.8 回归闸门（第 18 轮实测）

- `pnpm typecheck`（`tsc -p tsconfig.json` + `tsc -p tsconfig.client.json`）：**0 错**。
- `pnpm smoke`：core **6** / mechanism **37**（新增 H1–H6：四档能力、派发脚本、restrict 求交与降级、
  setup 挂载限制、中枢会话过滤/批量标题/排序上限/降级、话题集三层+形态建议+首条消息）/
  webui **27**（新增 `/state.hubs` 降级为数组、控制台五段导航/卡片/响应式标记）/ client-sim **OK**。
- `pnpm build`：宿主 **9 个文件**（`lib/supermemory.js` + 8 chunk，新增 `lib/hub-sessions-*.js`）；
  client `lib/client.js` 构建 **88.85 kB**，wrap-client 后 **87298 字符**（磁盘 UTF-8 **89065 bytes**，脚本报的是字符数）。
- 未执行 `git commit`、未回滚任何 R9/R10/R11 改动（工作区继续保持脏状态）。

### 18.9 生效方式与降级项

- **生效**：宿主与客户端都有改动 → 需要**插件重载**（中枢会话/GUI 里禁用→启用，分支内执行会自杀），随后
  **浏览器刷新**（http://127.0.0.1:62590）。不要重启 GUI 服务。
- **降级项**：
  - `ctx.tools.restrict` 在真实宿主可用（源码 `tools.restrict` + `scopeOf(ctx)` 已确认）；
    若某部署的 agent scope 没有 `tools`（旧宿主/测试替身）→ `unsupported`，分支仍能工作、**脚本里已声明能力边界**；
    若 deny 列表与真实注册表没有交集 → 不调用 `restrict`（视为已满足）；
    若 `restrict` 抛错（例如运行时的 scope-local 工具名）→ 去掉被拒名字做一次重试，仍失败才 `warn`，派发不失败。
  - `sessionQuery` 缺失 → 左栏退化为 `ctx.sessions.list()`，再缺则空列表；不会报错。
  - `currentInitiator()` 在任何 initiator 边界之外抛错/返回空 → 回退 `context.scope`；两条都拿不到 → 不注入中枢段。
  - 本分支**未**做插件重载后的真实 GUI 目视验证（分支内禁用→启用会自杀）；由中枢在重载后确认两栏渲染、
    左栏中枢会话列表、徽标恢复与新话题集回执。

---

## 20. 分支问题上交 + 中枢统一提问（第 20 轮，R20）

### 20.1 需求（用户原话要点）

1. 分支会话完成实质工作并汇报；遇到分歧按「最合理解释」直接执行，不停下来等用户确认。
2. 分支可以提问，但问题必须先结构化上交中枢；由中枢汇总**所有**分支的问题后，用一次 `ask_user_question` 统一向用户提问。
   分支不得各自直接向用户抛问题、也不得因提问而卡住不干活。
3. 能力边界（read/read-write/full/minimal）、并行组单次汇总、relay 回送机制保持不变。

### 20.2 数据层：新增 `questions` 表（向后兼容）

- `src/schema.ts`：新增 `questions` 表（独立表，不改 dispatch 记录结构，遵守「不改历史记录形状」的约定）：
  `dispatchId/groupId/topicSetId/branchSessionId/hubSessionId/branchTask/title/question/options[]/severity/blocking/
  progress/defaultPlan/status(open|resolved)/answer?/createdAt/updatedAt`；
  除身份字段外**全部 zod 默认值补齐**（旧 medium 无该表 = 空表，读时按 `KvTable` 语义建空映射）。
- `src/store.ts`：domain 声明 + `Store.questions` 访问器（`supermemory` domain 仍为 version 1；
  storage-domain 的 open 以 spec 声明建表，新增表在旧数据上按空表打开）。
- `src/questions.ts`（新增）：唯一读写入口——
  - `dispatchOfBranch`（优先未终态、其次最新派发；无派发 = 不是分支）；
  - `raiseQuestion` / `openQuestionsOfDispatch` / `openQuestionsOfGroup` / `openQuestionsOfBranch`；
  - `questionsForHub(status)` / `openQuestionsForHub`（按工作区话题集 + 本中枢兜底，**能看到仍在工作的分支**的问题）；
  - `renderQuestionsBlock`（relay 用，标注阻塞/非阻塞、进度、默认备选、下一步让中枢 `memory_questions`）；
  - `renderQuestionList`（中枢清单用，含来源分支/任务/严重度）；
  - `resolveQuestions`（只结清传入 id，可记录用户 `answer`）。

### 20.3 工具：`memory_raise_question`（分支）+ `memory_questions`（中枢）

- `src/tools.ts` 注册两个工具（`defineTool`，与现有工具同风格）：

| 工具 | 使用者 | 关键契约 |
|---|---|---|
| `memory_raise_question` | **仅分支** | 必填 `title/question`；可选 `options/severity/blocking/progress/defaultPlan`；写入该分支当前派发记录归属的 question 行并立即返回回执。`blocking` 默认 **false**（说明「不要等待用户，继续推进」）；`blocking=true` 回执要求写清进度/默认备选并结束本轮。没有派发记录（中枢误调）→ 明确报错，不落库。 |
| `memory_questions` | **仅中枢汇总** | `status=open|resolved|all` 列出；`resolve: string[]` + `answer?` 结清（只允许结清本中枢可见的问题，防跨工作区篡改）；输出含来源分支/任务/阻塞/进度/默认备选，并附「去重按主题合并→一次 ask_user_question」指令。 |

- 工具描述均写明「仅分支使用 / 问题由中枢汇总统一提问」；`memory_dispatch` 描述补充该闭环。
- capability 未新增 deny：`memory_*` 在各档位天然可用，满足「能力边界不变」。

### 20.4 分支侧提示词（写进分支真正看到的注入文本）

- `src/script-delegation.ts#buildDispatchScript`（分支首条消息的唯一来源）改写工作约定：
  - 「完成实质工作并汇报结果；遇到分歧按『最合理解释』直接执行，不要停下来等用户确认；把假设写进汇报」；
  - 「提问约定（必须遵守）」三条：只通过 `memory_raise_question` 上交中枢；不得在本分支直接向用户提问或因提问空转；
    非阻塞上交后继续推进；只有真正阻断才 `blocking=true`，并同时给 `progress` + `defaultPlan`。
- `src/dispatch.ts` 已统一走 `buildDispatchScript`（R18 起），因此**所有**新建/复用/fork 分支都读到该约定；
  并行组成员消息仍追加「组内只做本任务、全部终态后统一汇总」。
- `src/panel.ts` 面板内「用户回复 → 分支」通道同步该约定（不直接问用户，需裁决走上交）。
- `src/reconcile.ts` 重启恢复的重新派发消息追加同一句话，避免 recovery 路径丢失约定。

### 20.5 中枢侧提示词与汇总

- `src/index.ts` `HUB_ROLE_TEXT`（section `supermemory:hub-role`，order 901，只注入真中枢）新增：
  - 分支不会直接问用户，疑问经 `memory_raise_question` 上交；收到 relay 或用户新消息先 `memory_questions` 查全部未解决问题（含在跑分支）；
  - 去重、按主题合并，标注来源分支/是否阻塞/进度/默认备选，**一次** `ask_user_question`；用户答复后 `resolve` 结清并 `memory_dispatch` 派回裁决；
  - 分支已按最合理解释完成且问题非阻塞时不必提问，只在汇报里列假设。
- relay 自动携带问题（中枢无需猜）：
  - 单分支 relay（`src/observe.ts#relayText`）在成功/失败/超时中断三种终态后追加 `[supermemory-questions]` 块（空则不追加，旧文本逐字节兼容）；
  - 并行组唯一 relay（`src/group.ts#groupRelayText`）在「汇总」行后合并**全部成员**的问题块；
  - 启动对账的失败/中断回执（`src/reconcile.ts`）同样携带该分支未结清问题。
- 未做硬性禁用 `ask_user_question`：read/read-write/full 的档位契约要求保持不变，且 `full` 本就与中枢一致；
  由提示词 + 结构化通道保证「分支不各自问用户」，行为边界不变（见 20.7 风险）。

### 20.6 回归闸门（第 20 轮实测）

- `tsc -p tsconfig.json --noEmit` + `tsc -p tsconfig.client.json --noEmit`：**0 错 / 0 错**。
- `node scripts/core-smoke.mjs`：**9**；`mechanism-smoke.mjs`：**44**（新增 R20-1 派发脚本提问约定、R20-2 结构化问题全链路：
  派发归属/阻塞默认 false/非分支拒绝/中枢可见/组 relay 合并/resolve 记录答复）；`webui-smoke.mjs`：**28**；`client-sim-smoke.mjs`：**OK**。
- `pnpm build`：宿主 9 个文件（`lib/supermemory.js` + 8 chunk，合计 368.37 kB，questions 逻辑并入）；
  client `lib/client.js` 107.32 kB，`wrap-client` 后 **105183 字符**。
- 构建产物中确认含 `memory_raise_question` / `memory_questions` / `supermemory-questions`。
- 本次**未**在分支内做插件禁用→启用重载（分支内重载会终止自身会话）：由中枢在 GUI/主会话执行，
  之后用户需刷新 http://127.0.0.1:62590；管理台 URL 每次重载会变，用 `memory_ui` 取新链接。
- 同一工作树中并行存在 R19 / R19-协同 的未提交改动；本节只对 R20 负责，合并后的最终闸门（tsc 0/0、
  core 9 / mechanism 44 / webui 28 / client-sim OK、build 通过）已在本节记录的同一时间点跑绿。

### 20.7 已知遗留与风险

- 问题清单**未**在面板/管理台列表中单独展示（需求标注为可选低优先）：数据已落库，`memory_questions` 可见；
  后续可在派发卡片上追加 `questions` 计数而不动现有 UI。
- 未硬性 deny `ask_user_question`（见 20.5 理由）：若分支模型无视提示词直接问用户，仍需靠中枢提示词纠偏；
  后续若允许改档位语义，可在 read/read-write 的 deny 词表加入该工具。
- 组 relay 现在携带问题块；若中枢在用户答复后忘记 `resolve`，同一问题会在下次 relay/清单中重复出现（提示词要求结清，非自动去重）。
- 问题按「工作区话题集 + 本中枢」可见性收敛；跨工作区/无话题集的孤儿派发问题不会出现在清单（派发总会解析出话题集，属兜底）。

## 21. 中枢-分支协同三项扩展：并行组、关联分支可见、跨中枢共享（第 21 轮，R19 协同①②③）

### 21.1 需求

1. 中枢可对多/复杂需求用 `memory_dispatch` 的 `tasks[]` 并行拉起多个分支协同；核实并解除阻碍并行的限制；hub-role 提示补充指引。
2. 中枢会话能看到它拉起的关联分支（名称/状态/最后活动），面板也能查看。
3. 一个话题集允许多个中枢；这些中枢拉起的**分支归属话题集**，可跨中枢复用/共享，不按中枢各自新建、也不应重复分裂。

### 21.2 需求①：并行组真正并行、且任务不会被合并

核查结论（旧实现的三处真实阻碍）：
- 组任务被强制映射成 `new`（`mode === 'fork' ? 'fork' : 'new'`），`continue/auto` 的复用语义在组内不可用；
- 获取始终取 `ranked[0]`，相似任务会命中间一分支，第二个任务被**合并**进同一会话串行执行；
- 任一任务抛异常会中断循环，后续任务不派发，而 `groupComplete` 只统计已落账成员，汇总因此「静默丢任务」。
修法（`src/dispatch.ts`）：
- 组内为每个任务维护 `claimed` 集合，`dispatchOne` 增加 `excludeBranches`，`acquireBranch` 过滤已占用分支 →
  **每个任务独占一个分支**；`runDispatch` 的组汇总返回 `branches[]`（任务/分支/状态），工具 render 打印出来；
- 组内 `mode=continue` 统一按 `auto` 处理（否则两个并行任务会排队进同一分支），`fork/new` 保留语义；
- 每个任务独立 `try/catch`：失败任务写一条 `status:'failed'` 的派发记录（`recordGroupFailure`），
  组仍等齐所有成员后**只回送一次**汇总，失败成员单独标注；
- 新增纯函数 `branchCandidates()`（测试 seam）与 `busyBranches()`，选择规则可断言、无 DSH 宿主也能验证。
提示词：`HUB_ROLE_TEXT`（order 901）与 `memory_dispatch` 描述新增「需求多/复杂 → tasks[] 拆多个分支并行、任务自包含、
每个任务独占分支、全部终态后单次汇总、失败标注；简单问题不派发」，并写清 `mode` 四档语义。

### 21.3 需求②：中枢 ↔ 分支关联（真实可用）

关联记录**复用既有事实**：`Dispatch.hubSessionId` 早已落库、话题集成员记录分支归属，无需新增表，
避免第二种事实来源（§18.4 徽标 bug 的教训）。新增 `src/hub-branches.ts` 作为唯一读模型：
- `listHubBranches(store, hubSessionId)` / `listTopicSetBranches` / `listWorkspaceBranches` / `hubsByBranch`；
- 行 = 分支标题（成员标题优先）、最新任务、状态（`working`/`idle`/`failed`）、打开派发数、总派发数、所属话题集、
  最后活动、涉及的中枢列表与 `shared`；**状态/共享按该分支的全部派发行计算**（不只当前中枢的行），
  否则共享分支在 B 中枢看来会「空闲」、`shared` 永远 false；
- 展示三处：
  1. **上下文注入**（`src/prestep.ts`）：中枢的用户轮开始处追加 `[supermemory 关联分支]` 通知卡
     （`source.form='notice'`，不会被 observe 误认成派发输入；无分支则完全不注入，不产生每轮噪声）；
  2. **工具输出**：组派发回执的 `branches[]`；单派发回执本就有 `branchSessionId`；
  3. **面板**：左栏每个中枢行显示分支数（进行中为 `N·M`），中枢页签与面板内对话顶部新增「关联分支」卡
     （状态/话题集/共享数/相对时间/点击打开）；`listHubSessions` 行新增 `branches/workingBranches` 计数
     （`src/hub-sessions.ts`），宿主新远程方法 `listHubBranches`（`src/panel.ts` + `src/client/remote.ts` + 客户端 API）；
  4. **独立管理台**：`/state` 新增 `hubBranches`（`src/webui.ts`），「中枢会话」卡片下面直接列分支（含共享徽标）。
`isHubSession` 从 `index.ts` 迁到 `hub-branches.ts`，提示词判定与上下文卡片共用一份规则，避免漂移。

### 21.4 需求③：一个话题集多中枢、分支共享

- 一个话题集本来就可有多个中枢（root 成员/普通顶层会话都可激活同一集），本次未加限制；
- 分支选择**只按话题集作用域**，从不按 `hubSessionId` 过滤：任何中枢都可 `continue` 该集合的空闲分支（共享）；
- `auto` 只复用**空闲**分支（该分支无未结派发）；忙碌分支绝不被隐式合并 —— 显式 `continue` 才排队；
- 删除旧的「auto 命中 fork 成员就再 fork 一次」逻辑：那会把集合已拥有的分支**分裂**成新会话，
  现在 auto 直接续用空闲分支（`fork` 才 fork）；
- 面板话题集成员卡在 `fork` 行显示「与 N 个中枢共享」；管理台分支卡同样带共享徽标；`TopicSetView.branches` 新增 `hubs`。

### 21.5 DSH 模型约束与最小可行替代

- 一个 DSH 会话就是一条对话/一个 agent：两个中枢**不能同时**驱动同一分支（`followup` 会排队）。
  因此「共享」实现为**按话题集归属的顺序复用**：空闲时可被任一中枢续派，忙碌时 `auto` 新建分支、`continue` 排队；
  没有伪造多租户并发。
- 分支被恢复时沿用其日志里记录的 preset/权限事实（R9 `compositionSetup` 语义），
  所以跨中枢共享的分支保持**首次派发时的组合**，不会因换中枢而换模型/权限。
- 未新增「关联表」：`Dispatch.hubSessionId` 是已有事实；派生视图避免双写不一致。若未来需要撤销/转移归属，
  再加显式关联表并把读模型切过去即可（当前投影已集中在一个模块）。

### 21.6 回归闸门（本分支实测）

- `pnpm typecheck`：宿主 **0 错** + 客户端 **0 错**。
- `pnpm smoke`：core **9**（新增 R19-协同1 选择规则、R19-协同2/3 关联投影与中枢判定）、
  mechanism **44**（新增 R19-协同1 真实 `runDispatch` 并行组：独占分支/复用空闲/失败不中止不丢任务；
  R19-协同2/3 面板投影：列表/共享计数/工作区过滤）、webui **28**（`/state.hubBranches` 断言）、client-sim **OK**。
- `pnpm build`：宿主 9 个文件、总 368.37 kB（`lib/supermemory.js` **280.32 kB**，`hub-branches` 并入共享 chunk）；
  client `lib/client.js` **107.32 kB**，`wrap-client` 后 **105183 字符 / 107531 字节**；
  产物含 `listHubBranches`（宿主 6 处 / 客户端 4 处）与「关联分支」文案；`import('./lib/supermemory.js')` 实测可加载
  （`apply` 导出、`inject` 9 项）。
- 未在分支内做禁用→启用重载（分支内重载会终止自身会话）：宿主与客户端均有改动 → 中枢/GUI 重载插件后刷新
  http://127.0.0.1:62590 生效；管理台 URL 每次重载会变，用 `memory_ui` 取新链接。

### 21.7 遗留与风险

- 并行组的派发仍**串行获取**分支（每个任务一次 acquire + 300ms 输入落地探测），分支**执行**是并行的；
  任务很多时工具回执耗时约 N×0.3s，属可接受但可继续优化（并发 acquire 需先做确定性的分支分配）。
- 共享分支的「最后活动」取自派发行 `updatedAt/lastActivityAt` 与成员 `lastActiveAt`，非逐 token 心跳；
  同一分支的错误历史不会自动清除，`failed` 会保留到下一次成功派发。
- 面板/管理台的分支状态来自派发表，`queued/dispatched/observed/summarized` 都算「工作中」；
  若宿主中断导致派发长期未结算，会显示工作中直到中断兜底扫描（R12 已有时限）。
- 分支若被外部（非插件）直接驱动，派发归属不会更新，属于越界使用；读模型只陈述插件自己的派发事实。

---

## 19. R19：八项需求（工作区单一来源 / 中枢徽标 / 面板内对话 / LLM 话题集三层 / 弹窗编辑 / 结论性记忆）

> 实施分支：R19-八项；同一工作树里还并行着 R19-协同（hub-branches/questions 等）的改动，
> 本节的落点只描述这八项。最终闸门在合并后的树上跑（见 §19.5）。

### 19.1 需求①：中枢会话列表按工作区过滤

- **宿主** `src/hub-sessions.ts`：`listHubSessions(ctx, store, cwd)` 一直按
  `workspaceKeyOf(header.cwd) === workspaceKeyOf(cwd)` 过滤；本轮把事实补进行数据：
  `HubSessionView` 新增 `cwd`、`workspaceKey`（`src/hub-sessions.ts:40`），
  每行在 `:256-270` 从 session header 读回 cwd 并计算 canonical key。
- **客户端** `src/client/panel-page.tsx`：左栏 `refreshHub()` 用全局 `cwd`
  调 `api.listHubSessions(cwd)`（`:648-650`），切工作区会重新拉取并清空旧列表
  （`changeWorkspace`，`:620`）。不会把别的 workspace 的会话混进来。
- **管理台** `src/webui.ts` `/state` 同样用 `listHubSessions(ctx, store, ws)`；`src/web`
  的 `#ws-select` 切换即重新 `loadState()`。

### 19.2 需求②：工作区选择器成为全局单一来源

- `src/client/panel-page.tsx` 只保留一个 `workspacePath` 状态（`:548`）：
  `cwd = workspacePath || sessionCwd || workspaces[0].path`（`:596-600`）。
  **旧的 `launchWorkspace` 已删除**——它曾与面板 cwd 各指一处。
- 头部工作区选择器（`:1579`）和 composer 里的工作区下拉（`:933`）绑定同一个值、
  同一个 `changeWorkspace`（`:620`）：切换会同时更新左栏中枢会话、话题集、
  记忆、工具、新建会话的 workspace。
- 选择写入 `localStorage['sm-panel-ws']`；路径不在已打开工作区时回退到主视图会话 cwd，
  不会卡在已关闭的目录（`:602-613`）。
- 宿主侧接口仍以 `cwd` 作为工作区参数（`listHubSessions(cwd)`、`hubState(cwd, …)` 等），
  行数据带 `workspaceKey` 供客户端核对。

### 19.3 需求③：中枢会话也有侧边栏徽标

- `SessionBadge` 新增第三态 `hub-set`（`src/panel.ts:1040` 附近类型、`src/client/panel-page.tsx:105`）：
  一个 **host 会话**（`session-*` 或用户自建 id）作为某活跃话题集的 `root` member 时，
  返回 `{kind:'hub-set', topicSetId, topicSetTitle}`。
- `src/client/session-badge.tsx`：`branch` 与 `hub-set` 都渲染；`hub-set` 用另一枚图标、
  「话题集」文案、tooltip 带话题集名（`:145-181`），并加了 `data-kind` 样式。
- 面板左栏行也显示所属话题集名（`.sm-hub-set`，`panel-page.tsx:1496`）；
  管理台中枢卡片显示「话题集 · 名称」（`src/web/app.js:399` 的 `renderHubs`）。
- 普通 hub（不属于任何集合）仍然不渲染徽标。

### 19.4 需求④：分支徽标串到中枢的根因（真实根因 + 修复）

**根因不是缓存 key 粒度，而是“成员=分支”的语义混淆，且 `member.kind` 也不够：**

1. `createTopicSetSession` 把新建会话作为 `kind:'root'` 加入话题集（`src/panel.ts:762`）。
   R18 的 `sessionBadge` 对**任何** member 都返回 `branch`，于是这个“话题集自己的中枢会话”
   被错标成「分支」；同一判定也被 `listHubSessions` 用来排除全部 member，
   于是它从中枢列表消失；`isHubSession` / `route.isBranchSession` 也把它当成分支，
   导致中枢 role prompt 和自动路由都不生效。
2. 但**不能简单改成 `kind==='root'` 就是 hub**：`dispatch` 新建的 fresh branch 也是
   `kind:'root'`（`src/dispatch.ts:655` 返回 `kind:'root'`），只有 id 前缀是 `branch-*`；
   fork 的 id 前缀是 `fork-*`。只按 kind 修会把新派发分支误升级成 hub。
3. R18 的缓存 bug（早先轮次）是**另一个**独立问题：`hub` 否定观测被永久缓存，
   分支加入集合后徽标不出现。R18 已改为 branch 永久、hub TTL 8s；
   本轮把 `hub-set` 也归入 TTL（非 branch 不永久缓存），并保留 `invalidateBadge`。

**最终规则（三处一致）**：
`isPluginBranchId(id) = id.startsWith('branch-') || id.startsWith('fork-')`
（`src/hub-sessions.ts:82`）。

- 徽标（`src/panel.ts:1076`）：
  - plugin branch id，且属于任一**活跃**集合 → `branch`（无论 member kind）；
  - 否则 host id 的 `root` member → `hub-set`；
  - 否则 `hub`。归档集合永不标记。
- 中枢列表（`src/hub-sessions.ts:194/228`）：排除 `branch-*`/`fork-*` id 与 **fork** member；
  `root` member 保留为 hub，行里带 `topicSetId/topicSetTitle`。
- `isHubSession`（现位于 `src/hub-branches.ts:352`）与 `route.isBranchSession`
  （`src/route.ts:158`）：plugin branch id 或 fork member → 分支；root 集合会话仍按 hub 处理。
- 管理台/面板的话题集成员卡按 id 前缀展示「中枢/分支」（`src/panel.ts:341`），
  不再把 fresh branch 显示成中枢。

**复现（修复前）**：面板新建一个话题集会话 → 该会话作为 root member 属于集合；
侧边栏对它显示「分支」，左栏中枢列表没有它，`sessionBadge(id)` 返回
`{kind:'branch'}` 且 `member.kind==='root'`。修复后返回 `{kind:'hub-set', …}` 且出现在左栏。
**回归防呆**（`scripts/mechanism-smoke.mjs` E2/H5）：新增
`branch-fresh`（kind root + `branch-` 前缀）必须仍是分支、必须被中枢列表排除；
`hub-root`（host id + root）必须是 `hub-set` 且进入中枢列表。

### 19.5 需求⑤：面板内直接接管模型对话

**能力调研（按运行中 0.2.2-rc.3 的源码逐条确认）**：

- 读消息：`ctx.sessionQuery.readSurface(sessionId)` 返回克隆后的当前 model-visible surface
  （`app.asar/dsh/node_modules/@deepseek-ai/dsh-session-query/src/index.ts:322`，
  live-preferred，不修改会话）。这就是模型自己看到的消息折叠，比原始 event log 更适合聊天视图。
- 发消息：`ctx.agents.get(id)` 取 live agent（`dsh-agent/src/index.ts:580`），
  `agent.followup(message)` 是既有的送入入口（`dsh-agent/src/runtime-types.ts:252`）。
  冷会话用 `ctx.agents.resume({resumeSessionId, setup})`
  （`dsh-agent/src/index.ts:429` / `ResumeAgentOptions:127`）；`setup` 复用
  `compositionSetup()` 重新挂载会话记录的 agent preset，避免恢复后没有工具。
- 订阅：宿主没有向 Web 面板公开的 push 通道（sessionQuery 是点读，不是订阅），
  因此面板按 2.5s 轮询 `readSessionMessages`。这是“轮询即可”的显式选择，
  比伪造一个不存在的事件流可靠。

**实现**：
- 宿主 `src/panel.ts`：
  - `readSessionMessages(sessionId, limit=80)`（`:574`）：`sessionQuery.readSurface` +
    `readTitleSnapshots` 批量标题；`projectChatEvents()`（同文件导出）只保留
    `user/message` / `assistant/message` / `tool/result`，跳过 system、developer、reasoning
    和生命周期事件；窗口取最近 N 条并标 `truncated`；无 `sessionQuery` 时返回
    `note:'宿主未提供 sessionQuery…'`，不抛错。
  - `sendSessionMessage(sessionId, text)`（`:625`）：live agent 直接 `followup`；
    冷会话 `resume`（preset setup）后发送；失败返回可操作错误（提示用「打开会话」）。
    恢复后的 handle 有意不 dispose——用户会话应保持 live。注意：`resume` 绑定在插件 fiber 上，
    插件卸载时宿主会按 owner 清理该 agent；重载前请先结束面板内刚恢复的冷会话（热会话不受影响）。
  - 远程契约：`readSessionMessages` / `sendSessionMessage` 描述符（`:1331/:1341`），
    客户端 `src/client/remote.ts:55-56`、`src/client/index.ts` 同步。
- 客户端 `src/client/panel-page.tsx`：
  - 新视图 `{kind:'chat', id}`；左栏行、话题集成员卡的点击改为 `openChat(id)`
    （`:1484`、`:1167`），不再 `openSession` 跳转；「打开会话」保留在聊天头（`:1410`）。
  - 消息流 + 角色标签 + 工具结果弱化样式（`.sm-msg`，`:1404` 起）；
    输入框 + 发送（Ctrl/Cmd+Enter），`sendChat` 发送后立即 `loadChat`，轮询继续
    （`:692`/`:724`）。
  - 无 `sessionQuery` / 读取失败 / 会话冷启动的 note 原样展示；不会静默空白。

**边界/降级**：
- 宿主没有 `sessionQuery` → 消息流为空 + 明确 note（可打开 DSH 查看）。
- 冷会话 `resume` 失败（无持久化/无权限）→ 返回失败原因，不假装已发送。
- 不会替用户创建“平行会话”：发送进入的正是该 session id，DSH 页面看到同一份历史。

### 19.6 需求⑥：话题集 title/tags/summary 由模型生成

- **新模块 `src/topic-shape.ts`**：
  - `buildTopicCorpus`（`:120`）：有界语料 = 集合现有三层 + 最近归档结论/决策 +
    需求 + member 标题 + 最近派发任务（≤4000 字）。
  - `generateTopicShape`（`:231`）：`ctx.llm.stream({provider, model, system, messages,
    maxTokens:600, temperature:0.2, signal})`，提示词强制 JSON
    `{"title","tags","summary"}` 且“只写结论、禁止过程流水账”；20s 超时。
    `parseTopicShapeText`（`:214`）容忍代码围栏，解析失败返回 `undefined`——**保留旧值**。
  - 模型选择：集合 `defaultModel` → 传入会话的 hub 模型 → 运行时候选目录第一项
    （`resolveTopicShapeModel`）。
  - **创建时**：`fillTopicShapeOnCreate`（`:295`）只补“缺失/本地派生”的层：
    面板/管理台显式传 `{tags: 无显式标签, summary: 无正文}`，因此本地派生的标签也会被模型版替换；
    创建者标题保持权威（激活重生成时才可能更新标题，避免“一创建就改名”）。
  - **激活时**：`maybeRefreshTopicShape`（`:341`）+ `noteTopicSetActivated`（`:390`）：
    - 内容指纹 `topicSetFingerprint`（`:87`）覆盖集合三层 + members + episodes +
      requirements + dispatches；指纹相同 → **0 次模型调用**；
    - 指纹变化且距上次尝试 < `TOPIC_SHAPE_MIN_INTERVAL_MS`（3 分钟）→ 跳过（节流）；
    - 同一集合并发激活共享一个 in-flight Promise；
    - 成功才写 `shapeFingerprint/shapeGeneratedAt`（schema `src/schema.ts:55`，v1 加默认字段）；
      失败/畸形 JSON → 不写指纹、旧标题/标签/正文原样保留，下次激活再试。
  - 激活点接线：面板 `activate`（`src/panel.ts:362`）、管理台 `topicset/activate`
    （`src/webui.ts:457`）、`/memory switch` 与 `/memory new`（`src/commands.ts:97/114`）、
    `memory_new_topicset`（`src/tools.ts:470`）、dispatch 自动建/绑集合（`src/dispatch.ts:280`）、
    路由显式 @ 激活（`src/route.ts:99`）。
  - 失败降级：无 `ctx.llm` / 无路由 / 超时 / JSON 不可用 → 保留旧值并只 warn，不阻塞创建或激活。
- 新集合创建时面板回执会带「（已由模型补全索引）」；`createdSet` 回读显示实际写入的标题/标签。

### 19.7 需求⑦：记忆编辑改为弹窗（两处一致）

- **面板（src/client/panel-page.tsx）**：`editingMemory` 不再在列表行内渲染；
  统一由 `memoryModal`（`:1530`）渲染 `.sm-modal-backdrop` + `.sm-modal`：
  标题/标签/正文 + 保存/取消；点遮罩关闭、点对话框不冒泡。
  列表行只保留「编辑」按钮（打开 modal）。
- **管理台（src/web）**：`state.editMem` + `memoryModal()`（`src/web/app.js:272`），
  `mem-save-modal`（`:528`）从对话框读取字段并调用同一 `/memory/update`；
  旧的 inline `mem-save` 代码路径已删除。样式 `.modal-backdrop/.modal`
  （`src/web/style.css` 末尾），窄屏时底部弹出。
- 自动刷新在编辑期间暂停（`typingInConsole` 检查 `editMem`），避免表单被覆盖。

### 19.8 需求⑧：只记结论 + recall 定位话题集

- **写入侧**：
  - `memory_remember` 描述重写为“结论性事实/决策/约定，禁止过程流水账”；
    `title`/`tags` 改为 `required`；`assessConclusion()`（`src/retrieval.ts:39`）在写入前
    拦截 >1500 字、≥3 条编号步骤、≥25 行、长代码块，返回可操作提示而不是污染检索。
  - 面板/管理台/工具三条写入路径都过这层校验（`src/webui.ts:311`、工具 `:103`）。
  - `supermemory:hub-role` 与 `PROMPT_TEXT` 增加“只写结论、不写过程”的规则
    （`src/index.ts:281-288`），`memory_recall` 描述也声明记忆是结论。
- **召回侧**：
  - 新 `matchTopicSets()`（`src/recall.ts:153`）：按标题×3/标签×2/正文×1 对
    当前工作区活跃话题集打分，归档不参与；纯规则、无 LLM。
  - `memory_recall` 输出新增 `topicSets`（`src/tools.ts:204`），render 末尾附
    「相关话题集：…」；`prestep` 的开场 recall 卡也带同一提示（`src/prestep.ts:125`），
    用户需求命中记忆时可直接回答/激活/派发到该集，不必二次检索。
  - `renderRecallCard` 增加“记忆只存结论性事实/决策”的提示行。

### 19.9 回归闸门（R19 实测）

```
$ pnpm typecheck
tsc -p tsconfig.json && tsc -p tsconfig.client.json   # 0 errors

$ pnpm smoke
core      9 checks passed
mechanism 44 checks passed
webui     28 checks passed; log lines: 21
client-sim SIM SMOKE OK
```

新增/更新的断言：
- core：`assessConclusion`（结论/步骤/超长）、`matchTopicSets`（标题优先/归档不命中）、
  `parseTopicShapeText`（围栏 JSON/垃圾输入）、`topicSetFingerprint`（新增 member 改变指纹）。
- mechanism：E2/H5 的 `hub-set` / root member / fresh branch（`branch-` + kind root）；
  H8 `projectChatEvents` 投影 + `readSessionMessages`（标题、live、无 sessionQuery 降级）；
  H9 话题集自动三层（创建补全、指纹去重、3 分钟节流、失败保留旧值）。
- webui：管理台包含 `memoryModal` / `modal-backdrop` / `mem-save-modal` /
  `aria-modal`，且旧 inline `mem-save` 已移除。

```
$ pnpm build
lib/supermemory.js  280.32 kB (gzip 76.55 kB)
9 files, total 368.37 kB
lib/client.js       107.32 kB (gzip 26.21 kB)
wrap-client: 105183 chars
```

客户端体积对比（R18 → R19）：**88.85 kB → 107.32 kB（+18.47 kB，+20.8%）**；
wrap 后字符数 **87298 → 105183（+17885）**；磁盘 UTF-8 **89065 → 107531 bytes（+18466）**。
增量主要来自：panel-page 的聊天/工作区/弹窗、hub-set 徽标、新 locale 文案与 CSS。

### 19.10 生效方式与已知边界

- 宿主 + 客户端都改了 → **插件重载**（只能在中枢/GUI 会话里禁用→启用，分支内会自杀），
  然后**刷新** Web GUI（http://127.0.0.1:62590）。不要重启 GUI 服务。
- 分支内**未**做插件重载后的真实 GUI 目视验证（会中断本会话）；由中枢重载后确认：
  左栏只显示当前工作区、切换工作区三处同步、侧边栏 hub-set 徽标、面板内发消息并看到回复、
  新建话题集回执带模型索引、两处记忆编辑弹窗。
- 未执行 `git commit`。
- 并行分支 R19-协同（hub-branches/questions 等）的改动在同一工作树中；本报告只对八项负责，
  合并后的闸门已跑绿。
## 20. 组合工具 → 能力（capability）管理台（2026-11-18 第十轮）

### 20.1 需求与选型

组合工具从「重复工具序列自动编译」扩展为「固化能力（capability）」管理台：能力 = 入口命令
+ 文档 + 适用范围 + 路由描述 + 可一键执行，全部由插件管理（tool_memory 持久化 + 组合工具
页签 + memory_toolize 注册），**不落 DSH 共用技能目录**；git-sync 固化为首个能力。

- 持久化选型：**仍走 tool_memory，kind='composite' + spec.kind='capability'**（不新增 kind
  枚举值 → 域 schema 不变、旧记录零迁移）；rebuildComposites 重启重建时按 spec.kind 分派注册。
- 删除上个尝试：`~/.dsh/skills/git-sync-supermemory/` 整个目录已删（能力改由插件管理，路由由
  工具描述承担）；`docs/git-sync.md` 保留，作为能力的 doc 字段被引用。

### 20.2 数据模型与执行（src/composite.ts）

- `CompositeSpec` 增加 `kind?: 'sequence' | 'capability'`（缺省 sequence，旧记录兼容）与能力字段
  `entry / doc / scope / runnable / dryRunArg / writeConfirm / routeNote`；
  `CapabilitySpec = CompositeSpec & { kind: 'capability'; entry: string }`。
- `runCapability(spec, { dryRun?, confirm? })`：`spawnSync(command, { shell: true, cwd: scope,
  env: process.env, timeout: 120s, maxBuffer: 16MB })`，返回 `{ status: completed|failed|
  needs-confirm, exitCode, stdout, stderr, durationMs, dryRun, command, summary }`（输出截断 8000 字符）。
- 安全闸：① `runnable=false` 拒绝；② 定义 dryRunArg 且调用方未显式 dryRun/confirm 时**默认预演**；
  ③ writeConfirm 能力的真实执行必须 `confirm=true`——confirm=true 的语义就是「确认真实执行」，
  自动脱离预演缺省（否则管理台「确认执行」会悄悄变成又一次预演）；④ writeConfirm 但未定义
  dryRunArg 时预演直接拒绝（不能把真实命令当预演跑掉）。
- `registerCapability(ctx, store, input, workspaceKey?, deps?)`：校验 → 持久记录同名查找
  （自己注册过的走**原地更新**，不算冲突）→ 宿主工具冲突检查（仅新名字）→ 注册活工具 → 落库
  （trigger `capability/<toolName>`，workspaceKey 按适用范围落工作区）。无宿主注册器
  （测试/headless）时只落库，重启后 rebuildComposites 补齐。
- `rebuildComposites(ctx, store, deps?)` 增加注册缝；`capabilityRecordsOf(store)` 供列表；
  `bumpCompositeUse` 导出（实际执行过才计数，needs-confirm 不计）。

### 20.3 工具 / 面板 / 管理台三入口

- `memory_toolize`（src/tools.ts）新增 `register` 动作与能力参数（name/title/description/
  entry/doc/scope/runnable/dryRunArg/writeConfirm/tags）；无 accept/decline/register 时的 list
  同时返回待处理提议与已注册能力；accept/decline 旧行为不变。
- `src/panel.ts`：`ToolView` 增加 kind/entry/doc/scope/runnable/dryRunArg/writeConfirm；新增
  `runTool(id, { dryRun?, confirm? })` + descriptor `runTool`；`src/client/remote.ts` 同步
  （mechanism-smoke 的 host/client parity 断言仍通过）。
- `src/webui.ts` 新增路由（x-sm-key 鉴权 + ws 工作区隔离）：`tool/run`（body { id, dryRun?, confirm? }，
  needs-confirm 也返回 200 便于前端弹确认框）、`tool/register`、`tool/status`（active/retired）、
  `tool/delete`。
- `src/web/app.js`：组合工具页拆成「能力（可一键执行）」+「序列组合工具（自动固化）」两类卡片；
  能力卡片显示入口命令（可复制）/适用范围/文档/预演参数/写操作徽标，操作 = 运行（预演）/
  确认执行（writeConfirm 能力，二次确认弹窗）/停用/启用/删除；页内带「注册新能力」表单；
  执行结果弹窗展示 stdout/stderr/退出码/耗时。空态文案改为同时说明两类来源。

### 20.4 回归闸门（本机实测）

- `pnpm typecheck` 0 错。
- `pnpm smoke`：core 9 + mechanism 53 + webui 32 + client-sim OK。
  - mechanism 新增 K1–K5：能力数据模型 / 执行与预演缺省 / 写操作闸门（无 confirm 拒绝且不执行、
    confirm 才跑、无预演参数拒绝预演、未开放执行拒绝）/ 注册→持久化→重启重建拾取→同名原地
    更新→宿主冲突拒绝→列表 / 面板 runTool（计数、needs-confirm 不计数、序列工具拒绝一键执行）。
  - webui 新增 R22-1..4：tool/run 预演（HTTP 捕获 stdout/退出码并计数）、写操作闸门、
    tool/register 落库与 400、tool/status + tool/delete + 未知 id + 序列工具不可一键执行。
- `pnpm build` 全管线（tsdown + client + wrap-client）通过。
- 行尾：CRLF 原生的文件保持整文件 CRLF（CR 数 = 行数），LF 原生的（mechanism-smoke /
  docs/git-sync.md）保持 0 CR；无 BOM。本仓库无 .gitattributes、行尾混合，未做整文件 EOL 转换。

### 20.5 生效方式与已知边界

- 宿主 + 客户端都改了 → 插件重载后生效；**首条 git-sync 能力由中枢重载后通过
  memory_toolize register 录入**（seed：name `git-sync-supermemory` → 工具名
  `sm_composite_git_sync_supermemory`，entry `pnpm git:sync`，doc `docs/git-sync.md`，
  scope `G:\09 - dsh\SuperMemory`，dryRunArg `--dry-run`，writeConfirm true，
  tags [git, 同步, 推送, 流程固化]）；重载后 rebuildComposites 自动拾取。
- 已知边界：① memory_toolize register 的 live 注册路径与 editCompositeTool 的「重新启用」需要
  宿主 `@deepseek-ai/dsh-tools`，host-free 冒烟只覆盖到落库与停用/删除；② pnpm 12 下
  `pnpm git:sync --dry-run` 不能加 `--`（会 exit 3），已写入 docs/git-sync.md；③ 未执行
  git commit/push。

## 22. 中断保留分支会话 + 恢复后用户决定续跑（需求 E，2026-11-18）

### 22.1 宿主事实核查（只读参考 app.asar 内 dsh-agent / dsh-agent-loop 源码）

- `ctx.agents.create()/resume()` 返回的 `AgentHandle.dispose()` 语义：停 loop、等退出、
  注销 agent、**关闭会话写句柄**、拆 scope——不删持久日志（DSH 重启后 reconcile 一直
  能 resume 死分支即为反证）。dsh-agent 编译产物里 `ownerCtx = this.ctx`（agents 服务
  所在 ctx），但 loop 把生命周期 effect 挂在 ownerCtx 上，宿主侧「禁用/重载插件」会
  连带打到分支 agent 的在途 turn（§12 实测 aborted）——**插件无法在宿主层面阻止**，
  能做的是：插件自己的代码绝不 kill/abort/delete，并把台账/回执/续跑路径做稳。
- 宿主支持重启后重连被保留会话：`ctx.agents.get(id)`（存活）+ `ctx.agents.resume({resumeSessionId})`
  （重载持久会话，acquireBranch/reconcile/面板 sendSessionMessage 三处已在用）。

### 22.2 改动

- `src/schema.ts`：dispatches 增加两个**可选**字段 `resumeOf`/`resumedBy`（续跑双向关联），
  存储域保持 v1 兼容（旧记录读作 undefined，同 D 的 interrupted/lastActivityAt 先例）。
- `src/dispatch.ts`：新增 `detachIdleBranches()`——空闲分支**只摘除插件侧 handle**，
  绝不调用 `handle.dispose()`（原 release sweep 会停掉分支 agent；会话与可恢复性保留，
  acquireBranch 的 live→resume 路径随时续接）。判定沿用 `releasableBranches`（D5 不变）。
- `src/observe.ts`：① `deliver()` 增加 `deliveryId` 覆写缝并导出 `deliverRelay()`；
  ② `settleInterruptedDispatches()` 加固——投递抛错（如 dispose 期间宿主服务不可用）
  也照样标记 `interrupted`（outbox 行已先行落账，flushObserve 自愈重投），修掉
  「deliver 失败 → 派发永久 open → 回执永不送达」的尾部风险；③ 失败 relay 文案追加
  续跑入口提示（memory_resume / /memory resume）。
- `src/resume.ts`（新）：`listInterruptedDispatches()`（收录 interrupted + failed 且
  终态原因是打断签名 aborted/branch-died/…；排除已交付、自主失败、已被续跑接续的行）、
  `renderInterruptedList()`、`resumeDispatch()`（live handle → agents.get → agents.resume
  续接原会话并续投「原始任务 + 已完成部分」；三条路都失败才带同样上下文 `mode=new`
  重派发新分支；新派发 resumeOf=原、原派发 resumedBy=新）、`notifyInterruptedDispatches()`
  （启动/巡检经 deliverRelay 把清单推给各 hub，幂等键 `dlv-resume-<hub>`，签名去重）。
- `src/index.ts`：release sweep 改调 `detachIdleBranches`；巡检里追加中断清单通知；
  启动对账后约 10s 出首份清单（等 reconcile 三路径跑完），插件卸载时定时器被 effect 清掉。
- `src/tools.ts`：新增 `memory_resume` 工具（无参=清单；dispatchIds 可多个=续跑；
  capabilities 可选，默认 read-write）。
- `src/commands.ts`：`/memory resume`（别名 `/memory-resume`）行为一致，进 SUBCOMMANDS/HELP。

### 22.3 冒烟（mechanism 新增 R1–R6，59 项全绿）

- R1 空闲释放只摘除 handle，测试替身断言 **0 次 dispose 调用**、台账不动；
- R2 重启扫描清单：interrupted + cut-off-failed 收录，已交付/在途/已续跑/自主失败排除，
  已完成部分从回执摘出，工作区过滤；
- R3 live 分支续接（不 resume）、followup 消息带原始任务+已完成部分、台账双向关联、
  relay 目标=调用方 hub；R4 分支已死 → agents.resume 重连后续投并重登记 handle；
- R5 会话无法恢复 → 带上下文重派发（断言任务文本含续跑上下文）并关联原 dispatchId，
  重派发失败如实报错；R6 守卫：已交付/在途/不存在/已有续跑在进行 均拒绝。

### 22.4 闸门与未验证项

- `npx tsc --noEmit` 0 错；`npx tsdown` 通过（lib/supermemory.js 含 memory_resume/dlv-resume-/detached）；
  core 9 + mechanism 59 + webui + client-sim 全绿；污染特征串（autoDispatch/ensureBranchLive/
  finishRoute）src/lib 全无。
- **未实时端到端验证**（SOP：禁用→启用只能在 hub/GUI 侧执行，分支会话内禁止）：建议人工
  步骤 = ① hub 派发一个长任务；② 在 GUI 插件页禁用→启用（或重启 DSH Desktop）；
  ③ 约 10s 后 hub 应收到「检测到 N 个被中断任务」清单（不在线则下次打开 hub 时补投）；
  ④ `/memory resume` 查看清单，`/memory resume <dispatchId>` 续跑，观察分支在原会话
  （或新分支）继续且结果回到 hub。
- webui 管理台未加「被中断任务 + 继续按钮」（本次跳过，工具/命令/启动通知已覆盖需求）。

## 24. 派发回执后立即结束本轮（R24，2026-11-18）

### 24.1 需求
中枢拿到 `memory_dispatch` / `memory_resume` 回执后必须**立即结束本轮回复**，不要 `wait_agent`
等分支、不要轮询分支状态、不要边等边做无关工作把回合挂住；分支完成后 relay 作为新消息自动
送达并开启新一轮，届时再 `memory_questions` 汇总、转述给用户。

### 24.2 写作前的技术事实（核实结论，文案据此）
- **relay 通道**：`src/observe.ts` 的 `deliver()` 用中枢会话句柄 `followup(createUserMessage(...))`
  发回执。宿主对**空闲**会话收到 followup 会新开一个 turn；只有会话正忙时才进 inbox 队列
  （`nextTurn` 在当前 turn 结束后才被 claim）。所以中枢在本轮里等分支 = 把 relay 锁在队列里，
  回合被自己挂住——这正是用户在 GUI 里看到的"卡住"。
- **分支不是中枢 subagent 树成员**：派发用 `ctx.agents.create` / `resume` 创建**顶层会话**
  （`meta.cwd`），与 `ctx.subagent` 树无关；`wait_agent` 只能等 subagent 树成员，永远等不到分支。
- **结论**：收口只能靠"模型立刻结束本轮"。宿主没有"回合收口"钩子，故本轮把规则写进三处可见面
  （中枢角色提示、工具描述、路由卡），并由**回执字段 `nextAction`** 在工具结果本身里重复——
  那是模型读完回执必定看到的最后一屏。

### 24.3 改动（文件 + 行号，行号以本轮结束时为准）
- 新增 `src/round-end.ts`：`DISPATCH_NEXT_ACTION` / `RESUME_NEXT_ACTION`（收口文案唯一来源，
  回执、schema 渲染与冒烟断言都引用它，避免三处漂移）。
- `src/dispatch.ts`：`DispatchResult.nextAction`（:58-59）；单条成功回执（:623）与并行组回执（:429）
  都带 `nextAction`；`DispatchDeps.createMessage` 测试缝（:42，仅注入用，默认仍走 host 锚）。
- `src/tools.ts`：`memory_dispatch` 描述追加「R24 收口」（:517）；输出 schema 增 `nextAction`（:562）；
  `render` 把 `nextAction` 作为最后一行输出（:600-601）；`memory_resume` 描述（:647）、
  输出 schema（:706）、续跑成功回执（:762，只查清单时不带）。
- `src/index.ts`：`HUB_ROLE_TEXT` 新增 4 条（:275-283 附近，R24 注释写明动机）：回执后立即结束本轮 /
  原因（非 subagent 树成员 + relay 排队）/ relay 会开启新一轮、届时汇总 / 同一轮可连续派发后一次性收口；
  `PROMPT_TEXT` 的「实质工作必须开新对话执行」块补一句同义规则。
- `src/route.ts`：`renderCard` 的中枢提示补「派发回执后立即结束本轮回复，分支完成后 relay 会自动
  开启新一轮对话」（:181-183）。
- `scripts/mechanism-smoke.mjs`：R24-1（两条常量文案）、R24-2（用测试缝驱动**真实** `runDispatch`
  的成功回执，断言 `nextAction` 透传）、R24-3（index/route/tools 源码级断言四处文案同源）。

### 24.4 闸门（本分支实测）
- `pnpm typecheck`（tsc 双配置）0 错。
- `pnpm smoke` 全绿：core 9 + mechanism **75**（含 R24-1..3）+ webui 32 + client-sim。
- `pnpm build` 全管线通过；`lib/supermemory.js` 含「立即结束本轮回复」「R24 收口」与 `nextAction`。
- 编号说明：并行分支的话题集匹配在 `src/topicset-match.ts` 里同样标注 R23，本需求按其后顺延为 **R24**。

### 24.5 生效方式与边界
- 需在 hub/GUI 的插件页 **禁用→启用**（或重启 DSH Desktop）重载；分支会话内禁止自己重载。
- 收口是**软契约**（提示词 + 回执字段），宿主不强制：模型仍可能选择等待。若将来宿主提供
  "turn 收口/回合结束"钩子，可升级为硬拦截；当前 DSH 无此 API，故明确降级为提示词 + 回执字段。

## 25. 重新激活的分支在会话列表置顶（R25，2026-11-18）

### 25.1 根因（已由中枢实证，本分支复核）
- GUI 会话列表按 `updatedAt = max(header.createdAt, lastPromptAt)` 降序（宿主
  `dsh-api-session-controller/lib/types/list.js`）；`lastPromptAt` **只在提交 user/message 且
  `event.data.source.kind === 'user'` 时刷新**，其他 kind 一律不刷新。
- 本插件所有「人发起」的投递都用私有 kind `supermemory`（派发 / 续跑 / 面板发消息 / 面板回复 /
  新会话首消息），因此复用或续跑一条**已存在**的分支时，recency 键不前进 → 侧栏位置不动。
- workspace.json 的 sessionIds 只是归属顺序、不影响侧栏；宿主零处消费 `supermemory` kind；
  kind `user` 的其余消费点（continuation admitted、inbox steering 标注）对分支中性/正向。

### 25.2 改动（文件 + 行号，行号以本次结束时为准）
- `src/dispatch.ts:594-597`：派发唤醒消息 `source: { kind: 'supermemory' }` → `{ kind: 'user' }`
  （含并行组：同一处）。**R25 起派发/续跑以人类提示形态落账**，归属仍由 observe 的首个匹配扫描保证。
- `src/resume.ts:363-367`：续跑投递同样改为 `{ kind: 'user' }`，删除 `form: 'instructions'`
  并改写注释（原 form 的归属 rationale 失效）。
- `src/panel.ts:677-678`（sendSessionMessage）、`:844-847`（deliverFirstMessage）、`:1035-1036`
  （面板回复分支）：统一 `kind: 'user'`——面板操作即用户行为。
- `src/reconcile.ts:115-120`：splice 追溯同时接受 `supermemory` 与 `user` 两种 kind（旧在途记录
  未结算时仍旧 kind）；`:158-161`：重启重投也改为 `{ kind: 'user' }`（`:158-160`）——否则 `isDispatchInput`
  认领不到，重启恢复的 dispatch 会永久悬空（漏改点，按同一规则处理）。
- `src/observe.ts:85-100`：`isDispatchInput` 改为 `message.source?.kind !== 'user'` 才 false，
  继续排除 form `recall` / `notice` / `relay`；注释写明 R25 动机与已知边界（人类在分支里手打的
  消息也是 kind 'user'，首匹配扫描可能归属——可接受：插件在落账 dispatch 后同步追加输入，窗口内首条是它）。
- `src/index.ts:22`（导入）+ `:196-199`：`attachProposals` 增加 `isPluginBranchId` 守卫——派发输入现在是 kind
  'user'，分支也会通过「有用户消息」门槛；工具化提议是中枢↔用户交互，分支不得直接问用户（R20）。
- `scripts/mechanism-smoke.mjs`：R3 断言改为 `source.kind === 'user'` 且无 form；新增
  R25-1（`isDispatchInput` 语义 + 源级断言：relay 仍为 supermemory、派发为 user、面板无残留）、
  R25-2（用测试缝驱动**真实** `runDispatch`，断言交给分支的消息 `source.kind === 'user'`）。

### 25.3 闸门（本分支实测）
- `pnpm typecheck` 双配置 0 错。
- `pnpm smoke` 全绿：core 9 + mechanism **81**（含 R25-1/2、R24-1..3、R23 的 M0–M7）+ webui 32 + client-sim。
- `pnpm build` 全管线通过；`lib/supermemory.js` 实测含 `isDispatchInput` 新判定
  （`kind !== "user"` + 排除 recall/notice/relay）与 6 处 `source: { kind: "user" }`
  （dispatch / resume / panel×3 / reconcile 重投），且已无 `form: "instructions"`。

### 25.4 生效方式与预期行为
- 需在 GUI 插件页对 dsh-supermemory **禁用→启用**（或重启 DSH Desktop）重载；分支会话内禁止自己重载。
- 重载后：**复用/续跑**的分支在投递后立即出现在会话列表顶部（lastPromptAt 前进）；**新建**分支
  不变（本来靠 createdAt 置顶）；recall/notice/relay 卡仍是 kind `supermemory`，不刷新 recency、
  行为不变。

### 25.5 已知边界与副作用
- 人类在分支里手打的 user/message 也可能被首匹配扫描归属为一个派发输入（窗口内首条是插件输入，
  实践中不冲突；若将来出现 human-in-branch 场景，可给派发输入加可识别标记并在此处收紧）。
- `maintenance.ts` 的事实/需求抽取只认 kind 'user'：派发任务的文本现在也会进入分支会话的
  抽取管线（任务里的「必须/需要」可能落成 requirement 行）。判定为可接受：任务文本本就走中枢的
  user 语义；本次不扩大改动，如需去重留给后续轮次。
- 编号：并行分支的话题集匹配是 R23（无独立 DEV-NOTES 小节），本需求按当前最大编号顺延为 **R25**。

## 26. 工作区隔离 + 能力维护 UI 收尾（第 26 轮，2026-11-18）

### 26.1 根因
- 话题集/会话侧本就按 workspaceKey 过滤；真正漏的是：① 能力完全不隔离（面板 listTools 无 cwd、
  memory_toolize list 全量、rebuildComposites 把各工作区能力都注册成模型可见工具、
  capabilityHealthOf 全量）；② 面板 hubState 的 episodes/dispatches/tools 计数跨工作区累计；
  ③ 面板 cwd 解析 workspacePath（localStorage）优先于主视图会话 cwd，shell 切工作区后面板不跟随，
  且 changeWorkspace 不清空 tools 状态。
- 「使用次数不刷新」根因（承接上轮）：管理台执行后只 render 不 loadState，渲染的是旧快照。

### 26.2 改动（文件 + 要点）
- `src/composite.ts`：新增 `capabilityAppliesToWorkspace`（行级归属优先 → scope 推导 → 全局）与
  `callerWorkspaceKey`；`capabilityToolDef(store, spec, workspaceKey?)` execute 增加跨工作区门禁
  （拒绝执行、不计数、summary 说明归属）；`registerComposite(..., workspaceKey?)`；
  rebuildComposites / editCompositeTool / mergeBuiltinCapabilities 传行级归属；
  `capabilityRecordsOf(store, workspaceKey?)` / `capabilityHealthOf(store, workspaceKey?)` 过滤；
  registerCapability 同名查找按工作区分流（别的工作区的行不被误更新）；
  `BuiltinMergeReport.changed` 改为带 workspaceKey 的条目。
- `src/panel.ts`：`listTools(cwd?)` 按工作区过滤并透出 version/usage；`hubState` 三个计数按工作区
  隔离（新增私有 `toolApplies`）；listTools RPC 描述符加 cwd；`runTool` 的 bump 传 result。
- `src/tools.ts`：memory_toolize list 按会话工作区过滤 + 透出 version/lastStatus；refreshBuiltin
  按工作区过滤并报告 otherWorkspace；输出 schema 同步补齐。
- `src/client/panel-page.tsx` + `src/client/index.ts`：`listTools(cwd)`；refreshTools 依赖 cwd；
  changeWorkspace 清空 tools；跟随 shell 工作区切换（useState 记录上次主视图 cwd）；
  ToolView/branches 补 task/version/usage 与渲染。
- `src/webui.ts`：`/tool/run` 的 bump 传 result（成败明细）。
- `src/web/app.js`：cap-run/cap-run-do/tool-status/tool-del 成功后 `loadState()`；分支卡片渲染
  task；能力卡片渲染 version 徽标与「最近执行」行（连续失败 warn）。
- `scripts/workspace-scope-smoke.mjs`（新，6 项）+ package.json smoke 链登记；
  `docs/notes/2026-11-18-workspace-isolation.md`（完整说明）。

### 26.3 闸门（本分支实测）
- `pnpm typecheck`（host + client）0 错。
- `pnpm smoke` 全绿：core 9 / mechanism 89 / webui 32 / client-sim / capability 9 / workspace-scope 6。
- `pnpm build` 全管线成功（前两分支按并发禁令均未构建，本分支首次构建即过）。

### 26.4 生效方式与预期行为
- 需 GUI 插件页禁用→启用重载（或重启 DSH Desktop）。
- 重载后：面板/管理台/命令/工具输出只展示当前工作区的话题集/会话/能力；切工作区即刷新；
  跨工作区调用能力被明确拒绝；能力卡片显示版本与最近执行状态；管理台执行后计数即时刷新；
  分支卡片带任务摘要。

### 26.5 已知边界
- 能力工具名在宿主注册表全局唯一：跨工作区同名注册会被「已被占用」拒绝（换逻辑名或先停用另一工作区的同名能力）。
- 无 workspaceKey 且无 scope 的旧能力行仍是全局（兼容取舍）。
- 面板 runTool/editTool/deleteTool 的 RPC 未带 cwd（列表已过滤，界面点不到跨工作区行；如需校验给描述符加 cwd）。
- 内置 git-sync 的 scope 是绝对路径：换机器/克隆目录后失效，健康报告报 scopeMissing。


## 27. 前端按钮与交互全量验证 + 前端修复（第 27 轮，R27）

**范围**：只用真实浏览器点击，逐个验证「超级记忆」面板（`src/client/panel-page.tsx` + `new-session.tsx`）与管理台（`src/web/app.js`）的可交互元素，发现即修（仅改前端）。宿主后端与测试文件未动。

**验证方式（重要约束）**：DSH Web GUI 使用「每次启动随机生成、只打印一次」的 launch token 换 cookie（`dsh web` 外壳，`/connect?token=`），第三方浏览器拿不到；因此面板用**本仓库真实产物**在本地验证台里跑：
- 管理台：`memory_ui` 的令牌 URL 直接用 ego-browser 真点真输入（真实宿主数据）。逐项覆盖 10 个导航分区、话题集 CRUD/激活/归档、记忆 CRUD/软删恢复/弹窗编辑/搜索/过滤、能力卡（复制/预演执行/确认弹窗/启停/注册/删除）、需求 CRUD、导出、扫描、刷新、自动刷新开关、760px 与暗色主题。
- 面板：`lib/client.js`（真实构建产物）经 `__ModuleLoader__` shim + 真实 React 渲染，`PanelApi` 用真实宿主 state 生成的 fixtures（18 中枢 / 8 话题集 / 17 记忆 / 3 能力 / 14 分支），点击走真实 DOM。覆盖侧栏（在线点/当前高亮/＋新中枢会话/行点击进对话）、四页签、composer（空消息禁用、Ctrl+Enter、选项透传、话题集 chip、＋新话题集、回执打开/收起）、记忆（onBlur 自动补全、增改/停启/删、搜索、弹窗保存/取消/点遮罩）、话题集（搜索/清空/激活/进入）、话题集详情（回复、梗概保存、成员进对话、返回中枢）、固化能力（编辑保存/取消/停启/删除两段确认）、新会话覆盖层（中枢会话 vs 话题集会话、新建标题、空选择报错、Esc/取消/遮罩关闭）、空状态、错误态、760/700/600px、明暗主题变量。

**修复（全部前端）**
1. **管理台弹窗里的按钮全是死的**（`src/web/app.js`）：三个弹窗都用内联 `onclick="event.stopPropagation()"` 阻止冒泡，连 document 上的委托监听一起挡掉 → 记忆弹窗「保存/取消」、能力结果弹窗「关闭」、确认执行弹窗「确认执行/取消」点了没反应。改为删掉内联 onclick，并让 `modal-close` 守卫只在「点击落在遮罩、且目标在 .modal 内」时忽略，弹窗内显式关闭按钮照常生效。
2. **会话 id 全渲染成 `session-`**（`src/web/app.js`）：`short()` 只截前 8 字符，DSH 会话 id 都是 `session-<uuid>` → 话题集卡片的下拉里 8 个选项长得一模一样。改为短 id 原样、长 id「头 8 + … + 尾 6」。
3. **搜索框要失焦才筛选**（`src/web/app.js`）：`#mem-q/#ts-q` 只听 `change`。新增 `input` 监听（140ms 去抖 + 输入法合成期不重绘 + 重绘后还原焦点与光标）。
4. **中枢卡片重复显示话题集徽标**（`src/web/app.js`）：`renderHubs` 里同一标题渲染了两次（「话题集 · X」再一个「X」），删掉多余那个。
5. **「注册新能力」表单一点开就折叠**（`src/web/app.js`）：`render()` 重建 `#content` 丢掉 `<details open>`，注册完/自动刷新一过表单就消失。记住展开状态（`state.capOpen` + `toggle` 捕获监听）。
6. **面板二级视图没有页签高亮**（`src/client/panel-page.tsx`）：进对话/话题集详情后四个页签都不高亮，看不出层级。`tabActive()`：chat → 中枢会话，topic → 话题集。
7. **面板删除记忆没有确认**（`src/client/panel-page.tsx` + `locales.ts`）：不可恢复的永久删除一点就执行，与固化能力的「删除→确认删除/取消」不一致。改为内联两段确认，新增 `memory.deleteConfirm` 词条（中/英）。

**闸门**：`pnpm typecheck` 0 错；`pnpm build` exit 0（宿主 9 文件 / client 109.66 kB → wrap 107400 bytes）；`pnpm smoke` 全绿（core、mechanism 全项、webui 32、client-sim OK、capability 10、workspace-scope 6）。

**复验**：修复项在真实浏览器（管理台，重载后）与验证台（面板，重建产物）逐条复测通过；管理台 10 分区零 console 错误、零 4xx/5xx。

**遗留**
- 面板与管理台的 760px 折叠、明暗主题都靠宿主 `--dsw-alias-*` 变量；验证台里用变量注入模拟，真实宿主切换主题时仍需人工看一眼对比度。
- 管理台「注册新能力」表单值仍是 DOM 状态（自动刷新在失焦后可能清空已填内容）；展开状态已保留，值持久化留待需要时再做。
- 管理台能力「运行（预演）」实测 exit 127：`pnpm` 不在能力执行环境的 PATH 里（`pnpm git:sync --dry-run` 找不到命令）——属后端执行环境问题，本轮未改（前端已正确显示 exit/成败/最近执行）。
- 面板与管理台接线仍依赖宿主 remote（客户端走 `remote.supermemoryPanel`）；真实宿主内的端到端点击需刷新 GUI 后人工确认（https 令牌每进程不同，无法在外部浏览器复现）。

## 28. 能力「运行（预演）」exit 127 的真实根因与修复 + 执行环境 PATH 兜底（R27 集成收尾）

**症状**：固化能力「git 同步/提交/推送」的「运行（预演）」返回 `exit 127`，stderr 只有
`/bin/bash: F:/10-SuperMemory/scripts/git-sync-push.sh: No such file or directory`。

**根因（与最初猜测不同）**：不是 PATH 缺 node/pnpm。实测宿主执行环境的 PATH **同时包含**
`C:\Program Files\nodejs` 与 `C:\Users\admin\AppData\Roaming\npm`，`where pnpm` 与
`pnpm --version` 在能力子进程里都正常（用临时探针能力打印 `set PATH` 验证）。真正的坑是
`scripts/git-sync-push.mjs` 的 bash 候选顺序把**裸 `bash`** 排在最前，Windows 上解析到
`C:\Windows\System32\bash.exe` —— 那是 **WSL 启动器**，它把 `F:/...` 盘符路径原样交给 WSL 的
`/bin/bash`，于是 127。pnpm 再把 127 透传出来。

**修复**
1. `scripts/git-sync-push.mjs`（唯一影响面，无需重载宿主）：候选改为 `$SM_BASH` → 由
   `where git` 推导的 `<git 根>/bin/bash.exe` → `%ProgramFiles%`/`%ProgramFiles(x86)%`/
   `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` → 非 Windows 的 `sh`/`bash` → `where bash`
   命中（**排除 `<SystemRoot>\System32\bash.exe`**）；每个候选都做**双探针**
   （`bash -c "exit 0"` + `bash -c "test -f <脚本绝对路径>"`），单选「真的看得见本脚本」的那个。
   纯函数导出（`isWslBash`/`bashCandidates`/`usableBash`/`findBash`），主流程用
   `import.meta.url === argv[1]` 守卫，供 smoke import。
2. `src/composite.ts`：新增 `capabilityExecEnv()`，`runCapability` 用它替换裸 `process.env`——
   把 `dirname(process.execPath)`、`PNPM_HOME`、`%APPDATA%\npm`、`%ProgramFiles%\nodejs`、
   `%LOCALAPPDATA%\pnpm` 等**确实存在**的目录追加进 PATH（不硬编码盘符；原顺序保留、大小写
   不敏感去重；`Path`/`PATH` 大小写变体只留一个）。**这一项需要插件重载才生效**；第 1 项立即生效。
3. `scripts/capability-smoke.mjs` 新增 **C8**（capability 由 10 → 11 项）：stripped PATH 下
   `capabilityExecEnv` 注回宿主 node 目录且 `node --version` 仍可解析、注入幂等、PATH 无重复；
   `isWslBash(System32\bash.exe) === true`、候选不含 WSL、`findBash()` 选中的 bash 能
   `test -f` 看见脚本；`runCapability` 子进程实际收到的 PATH 含宿主 node 目录。

**结果**：`pnpm git:sync --dry-run` 真的跑起来（工作区检查 → fetch）；能力「运行（预演）」
`exit 127` → `exit 1`，stderr 变成真实原因 `fatal: could not read Username for
'http://zrynas.7766.org:8418': terminal prompts disabled / ERROR: fetch 失败（凭据或网络问题）`。
**遗留**：`~/.git-credentials` 在本机不存在（`git config` 现在只有 GCM helper），所以 dry-run 仍在
fetch 阶段因无凭据失败——属外部凭据配置，不是插件缺陷；`tests`/docs 已更新 §4.2b。

## 29. 记忆集合 + 条目两级模型（R22 需求④⑤）

**目标**：记忆的存储与检索改成「记忆集合（collection）+ 多条独立条目（entry）」，语义对齐话题集；有相关集合时优先追加条目而不是新开集合；检索先匹配集合再精选条目，提升精确度，同时旧扁平记忆与既有读路径不破。

**数据模型（domain 仍 v1，加表 + 加可选字段）**
- 新表 `memory_collections`：`{ workspaceKey, title, keywords(标签), summary, status: active|archived, createdAt, updatedAt }`，语义/形态与 `topicsets` 一致（`src/schema.ts`、`src/store.ts:memoryCollections`）。加表不升版本：旧介质没有该表即空表（同 R20 `questions` 的做法）。
- 条目仍是原 `memories` 表：新增**可选**字段 `collectionId`（`src/schema.ts`）。可选是刻意的——面板、管理台、fact 抽取等既有写路径不设置它也能通过 schema，旧记录读出为 `undefined`，所有旧字段语义不变。
- 索引实现：`src/memory-collections.ts`（新，唯一判定处）——相似度、三档、集合匹配、迁移、两级检索、同 key 判定都在这里，tools.ts 只做接线。

**remember（需求⑤）**
1. 先做惰性迁移（把无归属旧条目按标签/标题聚类归入集合）；
2. 同 key / 重复判定（原语义不变：同 key 同文本 duplicate、不同文本 conflict，且回执带所属集合）；
3. 集合决策：高相似（分值 ≥4）或中等相似（≥1.75）→ **复用**该集合追加条目，回执写明「归入记忆集合「X」（高/中等相似复用）」；低相似/无匹配 → 新建集合，标题=条目标题、标签=条目标签、正文=条目正文（截断）；
4. 显式参数：`collection`（标题，同名或相似则复用，否则以该标题新建）/ `collectionId`（必须已存在，否则报错并列候选）；
5. 输出新增 `collectionId/collectionTitle/collectionTier(high|medium|low|explicit)/collectionCreated`。
- 相似度 = 标题×4 + 标签×3 + 正文×1 的**加权重合率**（各项有界 0–1），所以阈值可解释、与标题长短无关。

**recall（需求④）**
- 两级：第一级 `matchCollections`（同一套 4/3/1 权重作用在集合三字段）给出命中集合与档位；第二级在「直接命中阈值 ∪ 命中集合内条目」中精选。
- 排序分 = 直接分（标题×4/标签×3/正文×1）+ 0.5×集合分（封顶 12），再乘时间衰减；只被集合上下文带出的条目要求集合本身 ≥ 高相似阈值，避免「集合一命中就把整集倒出来」。
- 返回：条目带 `collectionId/collectionTitle/collectionTags`，并新增 `collections` 数组（id/title/tags/score/tier）；`limit`、`topicSets` 与既有字段全部保留（旧调用/旧渲染不变）。
- 渲染（模型可见文本）：条目行尾追加「｜集合: X」，并附「相关记忆集合：…」提示。

**导出**：`memory_export` 按集合分节（`### 记忆集合：标题（标签：…）` + 集合梗概 + 条目），没有归属的条目落 `### 未归集`，条目总数不变（`ExportResult.collections` 报告集合数）。

**旧数据兼容**：`migrateFlatMemories` 只做加法——补 `collectionId` + 可能新建集合，绝不改正文/标题/标签；按标签 Jaccard / 标题 token 重合聚类；软删（superseded）条目不参与；已有同名集合则并入；**幂等**（第二次 0/0）。在 remember/recall/export 之前惰性触发。

**不动的边界**：`src/client/**`、`src/panel.ts`、`src/hub-sessions.ts`、`src/dispatch.ts`、`src/round-end.ts`、`src/prompt*`、`src/script-delegation.ts` 未改；`src/index.ts` 无需改动（工具注册路径不变）。

**测试**：`scripts/memory-collections-smoke.mjs`（新，6 项）由 core-smoke 调用并入其计数；mechanism-smoke 新增 2 项（工具契约 + 连续写入复用回归）。闸门：`pnpm typecheck` 0/0，`pnpm smoke` 全绿（core 15 / mechanism 93 / webui 33 / client-sim / capability 11 / workspace-scope 6）。

**遗留 / 集成轮接线**
- 面板与管理台仍以扁平列表展示记忆（不显示集合层级）——本轮按范围未改客户端；集合归属已在 API（panel listMemories 的条目带 `collectionId`，`/api/state` 的 memories 同样带）与 `memory_recall` 输出里可用，集成轮可加「按集合分组」展示。
- 面板/管理台创建的记忆不带 `collectionId`（写路径在 panel.ts/webui.ts，本轮禁改），它们会在下一次 remember/recall 时被惰性迁移归类。
- 迁移聚类是 O(n²)（n=当前工作区未归属条目数），当前量级（<100）无问题；条目量级很大时可在维护轮分批。

## 30. R22 集成收尾：三路合并 + 必要接线 + 全量闸门（2026-11-19）

三路并行分支（A 记忆集合 / B 面板 UI / C 会话生命周期）合入同一工作树后，本轮的集成工作：

**1. 审查结论（无互相覆盖）**
- 行尾：全部改动文件的 CRLF/LF 与 HEAD 一致（此前 A 轮曾把 `tools.ts`/`store.ts` 整文件转成 LF，已还原；本轮新增/改动均按文件原有行尾写入）。
- 无冲突标记、无重复函数定义；`git diff --numstat` 与各分支自报的改动规模一致。
- `pnpm typecheck` 双端 0 错（B 的 `ToolView` 扩展 ↔ 客户端 `ToolView` 字段、C 的 `HubSessionView.online` ↔ 宿主/管理台投影均已对齐）。

**2. 必要接线（本轮新增）**
- `src/web/app.js`（管理台中枢会话徽标）：`live` → 「运行中」，`online` → 「在线」，其余 → 「离线」（C 的 `online` 字段落地；避免 attached-idle 显示「离线」的矛盾）。
- `src/panel.ts`、`src/webui.ts`、`src/maintenance.ts` 的记忆写入路径调用 `resolveCollectionForEntry` 写 `collectionId`：面板/管理台新建记忆、自动抽取的事实记忆都会**立即复用相关集合**（需求⑤的完整闭环），旧条目仍由 recall/remember 的惰性迁移兜底。写路径在集合表缺失时降级为「不归属」，不阻断写入（显式指定集合时才报错）。
- `scripts/webui-smoke.mjs`：stub store 补 `memoryCollections` 表，并断言管理台新建记忆立即落集合（集合由条目标题派生）。
- 无需改 `src/index.ts`（工具注册路径不变；hub-role 提示里的「回执即结束本轮」已与 round-end 文案一致）。

**3. 闸门（顺序：typecheck → build → smoke，client-sim 校验新产物）**
`pnpm typecheck` 0/0；`pnpm build` 宿主 10 文件 / 539.73 kB + client 114.75 kB → wrap 112256 bytes；`pnpm smoke` 全绿：core 15 / mechanism 93 / webui 33 / client-sim OK / capability 11 / workspace-scope 6。
产物抽查：`memory_collections`（store/memory-collections chunk）、`collectionId`、`collectionTitle`、`resolveCollectionForEntry`、`online`（composite chunk）、`已派发，结束本轮`/`已续跑，结束本轮`（宿主）、`sm-dispatch`（4）、`sm-detail`（2）、`返回话题集页签`、`tool.detail.toggle`（client）。

**4. 遗留**
- 面板侧栏只有「运行中」绿点（无「在线」文案）：`HubSessionView.online` 已在宿主与管理台可用；面板若要显示「在线」徽标，是 `src/client/panel-page.tsx` 的一处字段映射（本轮未改客户端 UI）。
- 注入卡（prestep）仍用旧的 `recallMemories`（不带集合上下文）；要求只在 `memory_recall` 工具输出上，若要注入卡也带集合，需要把 `recallEntriesWithCollections` 接进 `prestep.ts`。
- 需中枢执行 `pnpm build` 后的插件重载 + 用户刷新 GUI；工作树未 commit/push。

## 31. R23 记忆整理：按「集合 + 条目」重新排布存量记忆（2026-11-19）

**问题**：R22 只把集合表与惰性迁移接通，存量集合是历史写入顺序/标签聚类自动长出来的：6 个集合、22 条记忆里有一个 12 条的大杂烩（`supermemory 记忆`）、`r8 记忆`/`写入 记忆` 这类轮次或占位名，以及 6 条自动抽取误抓的包装文本（「写结论性记忆」×2、并行组「本任务是…的一员」×2、续跑「本消息是被中断任务的续跑」×2）。

**方案**：数据计划 + 启动时一次性迁移（`src/memory-organize.ts`），不靠启发式重聚类。计划是显式表：5 个主题集合、12 条保留条目的最终标题/标签/正文、10 条删除/吸收（6 占位 + 4 近重复）与理由。合并条目保留双方事实（R18 完成+验收、git 凭据+仓库同步、集合匹配两条近重复）。

**为什么在 apply() 里做，而不是离线改 JSON**：storage-json 的 `single` 布局**内存权威**，每次写入整单元原子重写；宿主运行期间直接改 `~/.dsh/storages/supermemory.json` 会被下一次写覆盖（甚至更糟）。因此整理通过运行中的 storage domain 写，在插件加载（`src/index.ts` 的 `applyMemoryOrganize(store, workspaceKeyOf(PLUGIN_REPO_ROOT))`）时执行一次。

**安全守卫**：
- 标记：`meta` 行 `organize-<sha256(workspaceKey).slice(0,16)>`（key 也兼容 per-record 布局），版本号挡住第二次执行；
- 正文哈希：计划里每个会改写/删除的条目都带 `expectTextSha256`，正文被手动改过 → 保留原样并进冲突清单，绝不覆盖/删除；合并只有在 keeper 确实带上合并正文后才删被合并条目；
- 备份：首次写前把该工作区的 memories/memory_collections 全量快照写到 `DSH_HOME/storages/supermemory-backups/organize-v1-<ISO>.json`，写失败则整个 pass 中止；
- 兜底：计划外的新记忆按「中/高相似才归集，否则落到『其他结论（待归类）』」处理；扫描所有条目（含 superseded）补有效 `collectionId`，再删除旧集合，保证无孤儿；
- 改名保护：旧集合标题与计划不符（被人工改名）时保留该集合、不迁走其条目；
- 工作区限定：只整理插件仓库自身工作区，其他工作区/其他克隆不受影响（计划 id 不存在时 `nothing-to-do`，不建空集合）。

**结果（真实存储只读预演验证）**：22 条 / 6 集合 → **12 条 / 5 集合**（3/3/2/2/2），未归集 0、空集合 0；6 条占位包装文本删除，4 条近重复合并吸收（独有信息并入 keeper 正文）。

**工具**：`scripts/memory-organize.mjs` 对停止的宿主做只读预演（默认）或 `--apply --force` 离线写（先整文件备份，原子替换）；`--verify` 校验无孤儿/无旧集合。`/memory-organize [preview|apply]` 提供整理后报告与手动重跑；启动自动执行受标记保护。

**测试**：`scripts/memory-organize-smoke.mjs`（8 项，并入 core-smoke 计数）：计划形态、只读预演、完整执行、正文哈希冲突、幂等、合并安全、内容幂等、可重入。闸门：`pnpm typecheck` 0/0；`pnpm build` 宿主 10 文件 / 574.11 kB + client 112256 bytes；`pnpm smoke` 全绿（core 23 / mechanism 93 / webui 33 / client-sim OK / capability 11 / workspace-scope 6）。

**生效条件**：宿主改动 → 需中枢在 GUI/hub 对 `include:supermemory` 禁用→启用重载（分支内重载会自杀）；重载时整理自动执行，日志 Info 会打印备份路径与条目数。用户刷新 `http://127.0.0.1:62590` 后，面板里标题/标签已清理、条目数 12；集合层级在 `/memory-organize`、`memory_recall` 输出与 `memory_export` 分节中可见（面板仍为扁平列表，集合分组展示是 R22 遗留的可选后续）。

**回滚**：把备份 JSON 里的 `memories` / `memoryCollections` 两表写回（或 `--apply` 前整文件备份 `supermemory.backup-organize-*.json`）。工作树未 commit/push。

## 32. R28：派发改回卡片 / 能力时间戳与隔离（检索侧）/ 记忆集合写入与展示（2026-11-22）

用户四项需求：① 分支任务派发方式从「执行请求的卡片」被改成对话框，改回卡片；② 「固化能力」页签显示能力的增加时间与最后使用时间；③ 固化能力按工作区隔离——其他工作区的能力不被当前工作区检索和使用；④ 「记忆」页签改为记忆集合（集合=标题+标签+多条记忆；一条记忆只存一条内容，逐条内容以标签+详细内容结构存储；新记忆由大模型判断归入哪个集合还是新建集合）。

**并行三分支（同树、文件范围互斥）**：A=宿主能力（composite/schema/builtin-capabilities）、B=客户端（src/client/**）、C=宿主记忆（panel/tools/memory-collections/extract/maintenance/webui）。集成轮（本机）统一 typecheck → build → smoke，并用 scripts/dev-load.sh 武装新模块 URL 触发 HMR 重载生效。

### 32.1 需求①：派发改回卡片（B）

面板「中枢会话」页签的派发区本来就是卡片（composerView：任务文本/工作区/模式/模型/权限/话题集 chips/＋新话题集/开始对话/仅创建会话/Ctrl+Enter/就地回执）；残留的「对话框」是 shell 侧栏「新建会话」被 src/client/new-session.tsx 拦截后弹出的 sm-ns 选择层。本轮删掉该对话框：拦截命中后经 selectSuperPanel(ctx)（ctx.get('layout')?.selectPanel('supermemory')）打开面板，再经新增 src/client/open-dispatch.ts 的模块级广播信号让已挂载面板 setView({kind:'hub'})+setReceipt(undefined) 显示派发卡片。降级：拿不到 layout 服务/无 selectPanel 时**不** preventDefault——shell 默认新建会话继续，绝无死按钮；selectPanel  promise 拒绝回退 uiWorkspace.startSession()。仅对话框使用的 newSession.* locale 键已删（保留面板在用的 newSession.create）。

### 32.2 需求②：能力增加时间/最后使用时间（A 落库 + B 展示）

tool_memory 增加可选 createdAt（schema.ts，域版本仍 v1）：persistComposite/registerCapability 新建行 stamp，更新/升级经 ...r 展开保留原值，mergeBuiltinCapabilities 升级行缺值时按 spec.updatedAt ?? now 自愈；启动回填 backfillToolMemoryAttribution（rebuildComposites 内、先于合并注册）给旧行补 createdAt 与归属，幂等。最后使用时间本就在 entry JSON 的 spec.usage.lastUsedAt（bumpCompositeUse 持久化）。宿主 panel.ts 的 ToolView 增 createdAt，listTools 填 record.createdAt；客户端 capabilityDetail 与 capmeta 两处显示「增加时间/最后使用」（fmtTime：本地 YYYY-MM-DD HH:mm，缺字段 —）。

### 32.3 需求③：能力工作区隔离（检索侧补强，A）

R26 已有「列表过滤 + execute 门禁」，但宿主工具注册表进程全局——别的工作区的能力/序列对当前工作区的会话仍**可见**（检索得到）。本轮补检索侧门禁：宿主 ToolsService.register(definition, { when })（app.asar dsh-tools 0.2.2-rc.3 已核实：按 step 对每个可见工具调用 when(context)，false 不进 admitted set；抛错升级 ToolActivationError，故必须永不抛）。composite.ts 新增 compositeWhenGate(spec, rowWorkspaceKey)：从 context.agent.session.header.cwd 取调用方工作区，取不到/形状坏/抛错一律放行（与 execute 门禁同语义），取到走 capabilityAppliesToWorkspace；registerComposite 的 capability 与 sequence 两条注册路径都传。归属永不缺失：persistComposite 未显式传 workspaceKey 时从 signalKey 前缀 ws/<workspaceKey>/seq/ 推导（workspaceKeyFromSignalKey）。回填：无 workspaceKey 的行从 trigger 前缀推导写回（实测 tm-mwmbpmgo 回填为 F:\10-SuperMemory），无 createdAt 按 spec.updatedAt ?? now 补；均幂等、try/catch 不阻塞启动。

### 32.4 需求④：记忆集合（C 写入 + B 展示）

- **LLM 判定集合归属**：memory-collections.ts 新增 decideCollectionWithLlm——候选=本工作区 active 集合按相似度预排序（含 0 分行，上限 12、梗概截 200 字）+ 条目标题/标签/正文（截 400/48 字）；模型只返回 JSON {collectionId|createNew,title,tags,reason}，校验 id 必须在候选内、createNew 时 title 非空；任一不满足/解析失败/超时(20s)/无 llm/无 ctx → 静默降级到原启发式（行为与过去逐字一致）。resolveCollectionForEntry 增可选 deps；remember/createMemory/管理台创建/自动抽取四条写路径有 ctx 就传。回执 tier='llm' 时注明「模型判定」。
- **逐条原子存储**：新增 src/memory-split.ts（mayHoldMultipleFacts 零成本预判：<100 字或单行且子句<3 不调用模型；splitMemoryEntries 上限 5、组内去重、过 assessConclusion、标签回退）。memory_remember 与 panel.createMemory：N>1 时逐条走同 key 判重/冲突 + 各自集合归属，全部写入，回执「已拆分为 N 条…」+ entries[]；拆分后不沿用调用方 key。工具入参 schema 未变。
- **面板分组**：MemoryView 增 collectionId/collectionTitle/collectionTags（listMemories/hubState 投影，有归属才设）；记忆页签按集合分组（组头=标题+标签 chips+条目数；组序按组内最新 updatedAt 倒序；无归属进「未归集」组；无任何集合数据时退回原平铺）。搜索仍走宿主全量过滤，空组不渲染。
- **抽取净化**：extract.ts 的 CJK 双字滑窗改功能字切段取词（段 2–4 字、前 120 字内、最多 8 个；拉丁词最多 12 个）；DEFINITION_PATTERNS 主语需 ≥2 汉字或 ≥3 拉丁字符；跳过派发/续跑包装文本（「本任务是并行组」「原派发 dsp-」「branch-」）与纯命令行；requirements.ts 疑问句不再进需求表。存量垃圾记忆未清（防垃圾再生，不回清存量）。

### 32.5 数据契约（跨分支，字段名一字不差）

ToolView.createdAt?: number（listTools 填 record.createdAt）；MemoryView.collectionId?/collectionTitle?/collectionTags?（listMemories/hubState 填）。B 按契约编码并对缺字段兜底（—/平铺）。

### 32.6 闸门（集成轮实测）

pnpm typecheck 双端 0 错；pnpm build 宿主 10 文件 603.45 kB + client 110.67 kB（wrap 108146 bytes）；pnpm smoke 全绿：core 25 / mechanism 93 / webui 35 / client-sim OK / capability 12（+C9 when 门）/ workspace-scope 9（+W7a/b/c）。新增 scripts/__fixtures__/stub-node-modules（NODE_PATH 供 smoke 进程解析 @deepseek-ai/dsh-tools 桩，宿主运行时不经过它，勿删）。

### 32.7 生效方式与遗留

生效：pnpm build 后跑 scripts/dev-load.sh（lib/dev-<stamp>.js 新 URL + profile patch 原子武装，HMR 监视器重载；同 URL 重建对运行宿主不可见——ESM 按 URL 缓存）。重载实证：tool_memory 两行回填出 workspaceKey/createdAt。**用户需刷新 GUI 页面**拿新客户端产物（lib/client.js）。
遗留：① profile patch 里的 dev 插入在下次源码变更后需重跑 dev-load.sh，或跑 scripts/install-into-dsh.mjs 清回 bundle 形态并重启 DSH；② 管理台（src/web/**）本轮未加时间戳/集合分组（只做面板）；webui.ts 仅接了写入 deps；③ memory_toolize list 输出未透 createdAt（如需由集成轮补一行）；④ 存量垃圾记忆（R18 大杂烩、派发包装、命令行、疑问句）仍在，需 /memory organize 或手动清理；⑤ when 门禁依赖宿主 register 的 options.when——若将来宿主换旧签名会退化为只有 execute 门禁；⑥ 拆分写入最坏 1+5 次模型调用，慢模型下面板保存可能等秒级。

## 33. R29：「新会话」点击必须立即产出中枢会话（2026-11-23）

### 根因（两个入口都不创建会话，且都「无可见效果」）

R28（`b7a88d5`）把 shell「新建会话」拦截后弹出的选择对话框删掉，改成「打开 SuperMemory 面板 + 广播 `open-dispatch` 信号切到中枢页签」——**点击不再创建任何会话**：

- shell 侧入口：`src/client/new-session.tsx` 的 capture 监听 → `selectPanel()` → `broadcastOpenDispatch()`；面板本来停在中枢页签时，点击的唯一效果是「切回中枢页签」，视觉上是零变化。
- 面板侧入口：`src/client/panel-page.tsx` 左栏「＋ 新中枢会话」按钮的 onClick 只有 `setView({kind:'hub'}); setReceipt(undefined)`——同样不创建会话。

即：两个「新会话」入口在 R28 后都退化成「切页签」，用户看到的「点击无效」是这个回归的直接表现（不是按钮没绑定事件）。

### 修法：点击即创建（默认值直接落库），回执就地展示

- `src/client/new-session.tsx`（重写）：capture 命中 shell 的全局「新建会话」控件后 —— 先解析当前工作区，再 `preventDefault + stopPropagation`，`selectPanel()` 打开面板，然后立刻调用宿主 `api.createHubSession(workspace, {}, '')`；成功则把回执 `{id, message, kind:'hub'}` 交给面板（`publishHubReceipt`），面板未打开时直接 `openSession(id)` 兜底；失败则发一条只有文案的回执（`id:''`，面板不渲染「打开会话」）并在面板打不开时 `startSession()` 兜底。
  - 命中条件：aria-label / title / textContent 匹配「新建会话 / 新会话 / 新对话 / New session…」；**排除**工作区行自己的「在“X”中新建会话」动作（overlay 看不到那一行的 X，拦截会把会话建到当前主视图工作区，语义错误，保留 shell 原行为）。
  - 无 api / 无工作区 / 标签被上游改名：**不拦截**，shell 自己的新建会话流程照常（永不出现死按钮）。
- `src/client/open-dispatch.ts`（重写）：`subscribeOpenDispatch/broadcastOpenDispatch` 换成回执通道 `publishHubReceipt / subscribeHubReceipt / takePendingHubReceipt`。面板常常在宿主调用返回后才挂载（`selectPanel` 是异步生效），所以没有监听者时回执进入 `pending`，下一次挂载**恰好消费一次**——这个 pending 槽就是「修复点击无效果」的关键，避免回执丢失。
- `src/client/panel-page.tsx`：
  - 订阅回执（并立即 drain 一次 pending，闭合「挂载/发布」竞态）：收到即切中枢页签 + 就地回执卡（文案 + 会话 id + 「打开会话」）+ 刷新左栏。
  - 左栏「＋ 新中枢会话」按钮改为调用新的 `createHubNow()`：直接 `createHubSession(launchCwd, {}, '')`，成功即回执，失败写错误条；按钮在创建中 disabled（防连点）。
  - 回执卡：`id` 为空（失败回执）时不渲染「打开会话」。
- `src/client/index.ts`：恢复 `resolveCwd`（主视图会话 cwd → 第一个工作区），新会话入口 inject 从 `{selectPanel}` 扩为 `{api, cwd, selectPanel}`；`selectSuperPanel` 优先读 `ctx.layout`（shell 自身插件的写法），回退 `ctx.get('layout')`。

### 默认值取舍（需求②：不再提供选项）

| 维度 | 默认 | 理由 |
|---|---|---|
| 工作区 | 当前主视图会话的 cwd，回退第一个打开的工作区 | 与面板/派发卡的工作区单一来源一致；解析不到就不拦截，交给 shell 的工作区选择页 |
| Agent 模式 / 模型 / 权限 | 不传 options → 宿主默认（default preset / 默认路由 / 默认权限） | 「默认」= shell 的默认，不臆造 |
| 话题集 | 不绑定（纯中枢会话） | 中枢会话按定义不属于任何话题集；派发时派发卡仍按 sticky/自动匹配选集 |
| 首条消息 | 空 | 「新会话」= 先建会话；打字在会话里进行，不在弹窗里先填 |

中间选择步骤：R3–R27 的「中枢会话 / 话题集会话」对话框在 R28 已删除，本轮不再恢复；`NewSessionChoice` 只做拦截、渲染 null。

### 闸门与测试

- `pnpm typecheck` 双端 0 错；`pnpm build` 宿主 10 文件 603.45 kB、`lib/client.js` 115.14 kB → wrap **112508 bytes**；`pnpm smoke` 全绿：core 25 / mechanism **94** / webui 35 / client-sim OK / capability 12 / workspace-scope 9。
- 新增回归：`scripts/client-sim-smoke.mjs` 对**构建产物**断言新会话入口必须 inject `api.createHubSession` + `cwd` + `selectPanel`（R28 只注入 selectPanel 正是本 bug）；`scripts/mechanism-smoke.mjs` 新增 R29-1 断言回执通道「无监听者留待下次挂载 / 只消费一次 / 退订后回到 pending」。

### 生效步骤（需中枢执行）

1. 中枢重载插件（`include:supermemory` 禁用→启用，或 `scripts/dev-load.sh` 武装新模块 URL + HMR）；分支内重载会自杀，本轮未做。
2. 用户刷新 GUI（当前 http://127.0.0.1:51913）。
3. 验证：点侧栏「新建会话」→ 面板打开并出现回执「已创建中枢会话。」+ 会话 id + 「打开会话」，左栏/侧栏列表立即多一条「新会话 · xxxx」；面板左栏「＋ 新中枢会话」同样立即建会话。

---

## 34. R29 收尾：记忆清理 + 重载机制修正（2026-11-23）

### 34.1 记忆清理（用户需求③）

- 范围：仅 `workspaceKey = F:\10-SuperMemory`；存储 `~/.dsh/storages/supermemory.json`（单文件 JSON，顶层 `{unit,global,tables}`，无校验和）。
- 删除：requirements 40 条（全是任务提示词碎片/已完成残留/元指令片段）、memories 1 条（派发任务抽取碎片 `mem-mws0s74i`）、topicsets 2 个（`ts-mwl4q67c`/`ts-mwm1r5xl`，`F:\10-Su` 截断路径残根）；清 2 条旧 routing 的 `activeTopicSetId` 悬空引用。
- 保留：12 条正式记忆、5 个集合、6 个话题集、episodes/signals/dispatches/questions 等历史表；其他工作区（07-WeChatTool/08-ERP/ProductManage/ceshi）未触碰。
- 备份：`~/.dsh/storages/supermemory-backups/manual-cleanup-r29-2026-11-22T16-05-38-718Z.json`。
- 脚本与报告：`memory-cleanup-20261122/`（decisions.json / apply-cleanup.mjs dry-run+写入 / patch-insert.mjs / REPORT.md）。
- 已知来源：`src/maintenance.ts` 的 `extractRequirements` 会把分支任务提示词里的「必须/需要/待办」抽成需求——未来派发仍会产生同类碎片（规则保守、无 LLM 判定，属设计取舍）。

### 34.2 重载机制修正（重要，推翻历来笔记的说法）

- `cordis.patch.yml` 里 dev-load.sh 写的 `- insert: id: supermemory` 会**遮蔽**基础条目 `- id: supermemory / name: dsh-supermemory`（profile 的 node_modules/dsh-supermemory 是指向源码仓库的符号链接）。
- insert 存在时 `include:supermemory` 报 `unaddressable`，**plugin_manager 禁用/启用会失败**（历来「plugin_manager 禁用→启用重载」的说法只在 insert 被移除后成立）。
- 原子移除 insert 后：watcher 实时用基础条目重新激活（加载仓库当前构建），条目变为可管理（出现 patchId），此时 plugin_manager `set_plugin include:supermemory enabled=false/true` 才是可靠重载。
- ESM 按 URL 缓存：同 URL 重建不生效；要加载新构建要么武装新 URL（`scripts/dev-load.sh` 的 `lib/dev-<stamp>.js`），要么让基础包入口重新导入（本次即走这条）。

---

## 35. GitHub 同步与双远程同时推送配置（2026-11-23）

### 需求与结果

- 新增远程 `github = https://github.com/FrogMoo/SuperMemory.git`；`git push github main` 成功（exit 0）。GitHub 原为空仓库（`git ls-remote` exit 0 且无任何 ref，无历史冲突、**未使用 force**），推送后 `refs/heads/main` = ea28c78（R29 提交）。
- `origin` 保持 Gitee 为唯一 fetch URL（pull / rebase / 跟踪分支不变），新增两个 push URL：**GitHub（首位）+ Gitee**。`pnpm git:sync` 里的 `git push origin main` 一条命令自动双推，**scripts/ 零改动**（.sh 用 `git push "$REMOTE" "$BRANCH"`，不硬编码推送目标；.mjs 只是 bash 启动器）。
- 顺序取舍（git 2.55.0 实测）：多 push URL 时**首个失败即中止、不尝试后续 URL**。若 Gitee 排首位，「Gitee 故障 → GitHub 也收不到提交」；故 GitHub 排首位——Gitee 故障期 push 仍落 GitHub（整体 exit 非 0、Gitee 报错可见）。

### 环境突变（需用户后续处理，已上交中枢）

- 内网 Gitee 服务器 2026-11-22 晚被重置：主机可达（curl 根路径 HTTP 200），但旧账号 `旧帐号名` 与仓库 `旧帐号名/SuperMemory` 均不存在（仓库 URL 404；`git ls-remote origin` 报 `remote: user does not exist`）。GCM 中同邮箱（112***@qq.com）账号已由用户重新注册为 **旧帐号名 B**（API `/api/v1/user` 实测 id 8、created 2026-11-22T19:18），仓库搜索 `SuperMemory` 返回空。
- 影响：Gitee 重建前 `git fetch/push origin`、`pnpm git:sync` 全部失败（脚本第 2 步 fetch 即 exit 1）；GitHub 侧不受影响。
- 处置：按任务约束保留 origin 主远程与 URL 不变、**未在 Gitee 侧自动建仓**（外部服务变更，交用户裁决）；恢复方法与完整命令写进 docs/git-sync.md §4.6。

### 同步改动

- docs/git-sync.md：新增 §4.6（双远程配置形态、顺序即韧性、Gitee 现状与恢复命令、实测记录表）；头部推送说明、§3 步骤 6、§7.6 同步补充。
- src/builtin-capabilities.ts：git-sync 能力 v3→v4（description 增加双远程推送目标与 Gitee 现状；changelog 记录原因），随后 memory_toolize refresh-builtin 应用。
- 前置提交：工作区遗留的 R29 改动（9 文件，+931/−550）按 conventional 风格提交为 ea28c78（未跟踪目录 memory-cleanup-20261122/ 为一次性清理脚本，未入仓库）。
- **离线改存储的安全流程**：patch 移除 insert（或 plugin_manager 禁用）→ 插件卸载、存储域关闭 → 编辑 `supermemory.json` → 重新启用/武装 → 自动重读。R29 记忆清理即按此流程执行并验证（memory_topicsets 残根消失、memory_recall 正常）。

---

## 36. R30-B：中枢-分支协同（会话管理 / 标题标签 / 检索路由 / 回送）（2026-11-23）

### 36.1 需求③：中枢会话不属任何话题集、管理全部话题集、查看全部分支会话

- **③.1 验证（防回归，无代码改动需要）**：`createHubSession`（panel.ts）与 shell「新建会话」（client/new-session.tsx → 同一 api）只建裸会话 + 命名 + 挂工作区，**不写任何话题集成员**（mechanism-smoke 新增 R30-B4 断言 + 临时脚本实测 store.topicsets 成员数不变）；`listHubSessions`/`isHubSession` 恒排除 `branch-*`/`fork-*`（前缀是静态事实，成员行缺失时也能判），root 成员仍是中枢（R19 设计，hub-set 徽章不变）。
  - **假设（写入汇报）**：「hub-role 会话不出现在任何话题集成员列表中」按「**普通中枢会话不会被任何写路径自动加入话题集**」实现与验证；R19 的 root 成员模型（话题集自己的会话 = 中枢，带「话题集」徽章）是有意设计且被 R19 冒烟锁定，未改。
- **③.2 全部话题集**：panel 新增 `listAllTopicSets(cwd)`（活跃 + 归档，`TopicSetView.status` 透出生命周期，活跃在前 + lastActiveAt 排序）；面板中枢页签新增「全部话题集」卡（标题/标签/会话数/在线数/模型/归档徽章 + 行内创建入口 + 点击进详情，标签编辑在既有详情页）。`listTopicSets`（话题集页签）保持只看活跃。管理台话题集页早已含归档与增删改，无需改。
- **③.3 全部分支会话**：panel 新增 `listAllBranches(cwd, topicSetId?, limit?)`（跨话题集，读 `listWorkspaceBranches` 持久台账投影，可按集筛选）；面板中枢页签新增「全部分支会话」卡（筛选下拉 + 标题/标签/状态/共享/组/所属话题集/最后活动/派发次数）；管理台「中枢会话」页新增同一把话题集筛选（`state.branchFilter`，本地过滤）。

### 36.2 需求④：分支会话标题/标签明确化

- **DSH 事实（dsh-doc skill + 源码核实）**：会话**原生支持标题**（`ctx.sessionTitle.rename` → log-only `session/title` 事件，title.ts 已用）；**原生不支持标签**——dsh-session / dsh-session-title 源码无 tags/label/category 字段，会话 header 是不可变创建头。标签因此落在**派发记录**上：`schema.ts` 的 `dispatches` 新增 `title`（默认 ''）与 `tags`（默认 []），v1 介质兼容（R30 前的行读作空）。
- **新模块 `src/branch-meta.ts`**：`branchTitleFor`（任务首行、去标记、48 字 … 截断）、`branchTagsFor`（话题集标签 + 轮次令牌 `R30`/`R30-B` + 任务性质 `验证` + 能力档位，去重、≤8、每项 ≤24 字）、`roundTokensOf`、`latestBranchMeta`（branchSessionId → 最新派发的标题/标签）。
- **写入点**：`dispatch.ts` dispatchOne 落 title/tags（含 `kind` 透传）；`recordGroupFailure` 同样落（失败成员也保持同一身份词表）；`resume.ts` 续跑把原行标题/标签带前进（原行没有则按任务重算）。
- **读模型**：`hub-branches.ts` 的 `HubBranchView` 新增 `tags`；标题取「最新**非空**显式标题 → 成员标题 → 任务摘要」（标题为空的旧行不会擦掉已有标题）；`renderHubBranchesCard` 行内带 `标签 a / b`。三个表面统一：中枢注入卡、面板分支行（hub 卡 / 全部分支卡 / 话题集详情成员行）、管理台（中枢会话分支行 + 话题集成员表新「标签」列）。
- 宿主会话标题规则不变（`<话题集> · <任务首行>`，title.ts）——GUI 侧栏无回归。

### 36.3 需求⑤：每次对话的检索路由

- **⑤.1** `index.ts` HUB_ROLE_TEXT 增加四步路由：① recall 卡的相关记忆 → ② 列出/匹配话题集 → ③ 按话题集检索其下分支（标题/标签/状态/最后活动，注入卡已带出）→ ④ 才决定复用（continue/auto）或新建（new）；命中话题集时派到该集，不重新检索、不另起炉灶。
- **⑤.2** `prestep.ts`：注入卡在原有「本会话拉起的分支」之后，追加本轮 recall **命中话题集**的分支段（≤2 个集、每集 ≤4 行，读 store 既有台账，无额外宿主调用）；卡文案改为「标题/标签/状态/话题集/共享」。

### 36.4 需求⑥：分支记录唤醒其中枢会话并完成后回送

- **链路核实（无需改）**：`observe.deliver` 的投递目标是**派发记录里的 `hubSessionId`**（不是「当前中枢」）；组 relay 取 `members[0].hubSessionId`（一个组由一个中枢的一次派发产生，成员同源）；`flushObserve` / `settleInterruptedDispatches` / `reconcile` path2 / resume 通知全部从台账解析 hubSessionId；`resumeDispatch` 用 `exec.agent.id ?? record.hubSessionId`（续跑由中枢发起，回送调用方，缺省回落到记录）。hubSessionId 随派发记录持久化，分支重启后由台账恢复（branch-restore 只 attach 不 dispose），interrupted 成员的组收敛 R19 已处理（本轮未动，防回归）。
- **补齐点**：`script-delegation.ts` 的派发首条消息新增 `中枢会话：<id>（派发记录与 relay 回送目标都是这个 id…）`（dry-run 不带 id，R18 契约为 `!includes('分支会话：')` 保持）；`resume.ts` 的续跑消息同样点名中枢会话。

### 36.5 闸门与并发

- `pnpm typecheck`（宿主 + 客户端）双 0 错；另跑 `node scripts/mechanism-smoke.mjs`（98 项全绿，含新增 R30-B1/B2/B3/B4）与 `node scripts/webui-smoke.mjs`（35 项全绿）。**未跑** `pnpm build` / `pnpm smoke` / 未重载插件（分支内禁自杀）。
- 并发：R30-A 同时改 schema.ts 记忆表、panel.ts 记忆方法、panel-page.tsx 记忆页签、store.ts/tools.ts/memory-organize.ts/webui.ts（记忆版本化）；本次只碰派发/会话相关表与 hub/branch/话题集列表方法，双方区域不重叠（typecheck 双 0 即共存证据）。

---

## 37. R30-A：记忆版本控制 + 面板记忆两级页（2026-11-23）

对应六项需求中的 ①记忆版本控制、②面板记忆页签只展示记忆集 + 下钻条目页。与 R30-B（§36）并发：本次只改记忆相关表/方法/页签区域，R30-B 只改派发/会话/话题集列表，双方区域不重叠（`pnpm typecheck` 双 0 错即共存证据）。

### 37.1 需求①：记忆版本控制（就地更新 + 升版 + 历史归档）

- **数据模型（schema.ts）**：`memories` 新增 `version`（默认 1，旧介质读时补齐，域保持 v1）；新表 `memory_versions`（`workspaceKey / memoryId / version / title / text / tags / collectionId? / updatedAt / changeType(create|update|migrate)`）。store.ts 注册 `memory_versions` 域表并暴露 `memoryVersions` 访问器。字段命名假设：历史行标签用 `tags`（任务书字段名）、工作区键用 `workspaceKey`（全仓库 D4 约定，非任务书字面的 `workspaceId`）。
- **新模块 `src/memory-versions.ts`（唯一读写入口，模式参照 questions.ts）**：
  - `createMemoryVersioned`：新建 v1 并归档一条 v1 历史（changeType `create`）；
  - `updateMemoryVersioned`：就地更新 title/text/tags/集合，`version+1`，并把新版本整体归档（changeType `update`）；内容（正文/标题/标签/集合/key）完全相同 → 幂等 `unchanged`，不升版不写历史；记忆不存在/跨工作区返回 undefined；
  - `memoryHistoryOf`：一条记忆的全部版本（按版本号升序，最后一条即当前版本）；
  - `findMemoryByKey`：同工作区 active 且 key 相同的行（同 key 更新判定）；
  - `migrateMemoryVersions`：惰性迁移——给「没有任何历史行」的旧记忆补一条 v1 历史（changeType `migrate`），不改写正文/标题/标签/集合，按 memoryId 判重所以幂等，可像 `migrateFlatMemories` 一样在 recall/remember 前调用；
  - 兼容：历史表缺失（旧介质/测试替身）时写路径退化为「只改 memories 行」、读路径返回空历史，与 questions.ts 的容错同一套；`memoryVersionsSupported` 供 UI 说明降级原因。
- **写路径全部收口到版本化入口（不允许绕过）**：tools.ts `memory_remember`、panel.ts `createMemory`/`updateMemory`、webui.ts `memory/create`+`memory/update`、maintenance.ts 自动抽取 `rememberFact`、memory-organize.ts 整理引擎（条目改写 + 集合迁移两处）。
- **memory_remember 行为变化**：同 key 且内容不同 → 就地更新 + 升版，回执 `status:'updated'` + `version` + 文案「已更新到 vN（旧版本已归档，可用 memory_history 溯源）」；同 key 同内容 → `duplicate` 幂等（不升版）；无 key → 新建 v1（`version:1` 透出）。**取消**旧的「同 key 不同内容返回 conflict 交用户裁决」。集合归属仍按 R22 相似度/R27 模型判定，集合变更记入历史版本。
- **新工具 `memory_history`**：入参 `key` 或 `memoryId`（二选一）+ 可选 `limit`（默认 20），返回 `memoryId / title / currentVersion / versions[{version,updatedAt,title,tags,text,changeType,collectionId?}] / total` + 人读文案；旧记忆首次查询会先惰性补迁移再读。
- **memory_recall**：只返回当前版本，输出 items 增补 `version` 字段（仅 memory 类条目），描述里说明历史用 memory_history 溯源。
- **迁移策略**：不写一次性迁移脚本——`migrateMemoryVersions` 在 recall/remember/memory_history 读取前惰性执行（幂等、按 memoryId 判重），旧数据零丢失（正文/标题/标签/集合原样，只补历史行）。

### 37.2 需求②：面板记忆页签两级页

- **panel.ts 新远程方法（+ PANEL_DESCRIPTORS，client/remote.ts 同步声明，mechanism-smoke 的 id/参数契约 parity 保持）**：
  - `listMemoryCollections(cwd)`：集合卡片统计（id/title/tags/summary/count/latestUpdatedAt/status/时间戳）；未归集是 id 为 `''` 的虚拟卡片（旧数据不丢），按最近更新倒序；
  - `listMemoriesByCollection(cwd, collectionId, query?, limit?)`：一个集合内的全部条目（标题×4/标签×3/正文×1 打分过滤），`MemoryView` 增补 `version`；
  - `getMemoryDetail(cwd, id)`：`{ view, versions[] }`（当前字段 + 历史版本，无历史表时只有当前版本）。
- **panel-page.tsx**：View  union 新增 `memory-collection` / `memory-detail`；「记忆」页签（第一级）只展示记忆集卡片（标题/标签 chips/条目数/最近更新 + 按标题/标签搜索）与既有的新建记忆表单；点击卡片 → 第二级（面包屑 + 返回 + 集合内条目，行带 `vN` 徽标，点击行进详情）；点击条目 → 第三级详情（完整正文、当前版本徽标、key/来源/集合元信息、编辑/停用/删除、历史版本列表可逐条展开）。tabActive 把两个下钻视图归到「记忆」页签；工作区切换清空两级数据。
- **locales.ts**：新增 `memory.collection.*` / `memory.detail.open` / `memory.back` / `memory.updated` / `memory.history.*`（zh + en 两套）。
- **管理台（webui.ts + src/web）**：`buildState` 增补 `memoryCollections`；新路由 `POST /memory/history`（ws + id → versions）；app.js 记忆区改两级导航（集合卡片 → 集合内条目 → 详情），条目行带 `vN` 徽标，详情页可展开历史版本（`state.memHistory` 缓存，编辑保存后作废）；编辑保存 toast 带新版本号。
- **面板/管理台编辑均走版本化更新**：保存后回执「已更新到 vN」；内容无变化时明确「未升版」。

### 37.3 闸门与并发

- `pnpm typecheck`（宿主 + 客户端）双 0 错。
- 另跑（不写 dist 的单测脚本）：`core-smoke` 25 项、`mechanism-smoke` 98 项、`webui-smoke` 35 项全绿（webui 日志可见 `webui updated memory … -> v2`）；`memory-collections-smoke` 的 conflict 纯函数断言未动（`findMemoryConflict` 保留原语义，只是 remember 不再走 conflict 分支）。
- **已知既有失败（非本轮引入，需中枢安排修复）**：`capability-smoke` C3 与 `workspace-scope-smoke` W5 失败——`src/builtin-capabilities.ts` 的 git-sync 能力 v4 `description` 超过 `buildCapabilitySpec` 的 500 字上限，`mergeBuiltinCapabilities` 播种静默跳过（`report.seeded=[]`），导致「内置能力播种/rebuild 注册」计数差 1。该文件本轮未改（R29 遗留）。
- 未跑 `pnpm build` / `pnpm smoke` / 未重载插件（分支内禁自杀；集成轮统一跑）。

---

## 38. Gitee 恢复：帐号/仓库重建与双远程推送复原（2026-11-23）

用户裁决：由分支代劳重建内网 Gitee 仓库，用新帐号恢复「两方仓库同时提交」。凭据只进 Windows GCM（stdin approve）与一次性临时 curl 配置文件（/tmp，用完即删），不落仓库、不进汇报/记忆。

### 38.1 服务器真相（与上轮判断不同，需修正既有笔记）

- 该内网服务实例是 **Gitea**（`/api/v1/...`；`/api/v5/user` 返回 Not found），不是 Gitee。
- **帐号是「改名」不是「重建」**：旧 `旧帐号名` 已更名为 **`Zry`**（`GET /api/v1/user`：id 1、is_admin、邮箱 437***@qq.com）；上轮看到的 `旧帐号名 B`（id 8）是服务器切换中间态的短暂帐号，已不复现。
- **仓库 `Zry/SuperMemory` 已存在且非空**（id 17、`private:true`、默认分支 main；恢复时 `refs/heads/main` = `19032bb`，即 R28 之前的历史快照）——因此**没有建仓**（API 建仓跳过），推送是快进。旧路径 `旧帐号名/SuperMemory` 对 `/info/refs` 返回 307 跳转到新路径（Gitea 改名重定向）。
- 上轮「仓库 404 / user does not exist」的结论作废：那是切换中间态。

### 38.2 凭据的坑（本轮最有价值的发现）

本机 git 2.55.0.windows.3 的 http 传输向凭据助手发送 **`host=zrynas.7766.org:8418`**（端口嵌在 host 字段、无单独 `port=` 行），而 `git credential approve/fill` 常用 `host=<主机>`+`port=<端口>`——**两者是不同的键**。只按后者写入时 `git credential fill` 显示新帐号，真实 http 请求仍命中旧键的旧帐号（`remote: Repository not found` / `Authentication failed`）。
修复：嵌入端口键与 host+port 键**各 approve 一次**新凭据，并 reject 掉嵌入键上的旧条目（该键上还清出一个 GCM 占位 `OAUTH_USER`）。排查手法：`GIT_CONFIG_NOSYSTEM=1 HOME=<临时目录> git -c 'credential.helper=!<记录脚本>' ls-remote <url>`（绕开系统级 GCM helper 抢先返回），助手输入输出落临时文件、口令脱敏、用完即删。已写进 docs/git-sync.md §4.4/§4.6。

### 38.3 remote 与推送（实测）

- `origin` fetch URL → `http://zrynas.7766.org:8418/Zry/SuperMemory.git`；push URL 两项：GitHub（首位）+ 新 Gitee URL（旧 `旧帐号名` push URL 已删）。`github` 远程不动。
- `git push origin main`：GitHub `Everything up-to-date` + Gitee `19032bb..2c4b898 main -> main`，整体 exit 0——**双远程推送恢复**。
- 三方一致：本地 HEAD = `origin/main` = `github main` = `2c4b898`；`git push --dry-run origin main` 双路 Everything up-to-date。

### 38.4 闸门与未决

- `pnpm git:sync` **未端到端实跑**：工作区有 R30-A/R30-B 的未提交代码改动（归各自轮次，分支不代提交），脚本第 1 步即 exit 2（设计行为：不 stash 不自动提交）。已用 `--dry-run` 与手工 fetch/push/ls-remote 完成等价验证；代码提交后即可正常跑。
- 另注意：`scripts/git-sync-push.sh` **本身没有 typecheck/smoke 闸门**（只做 工作区检查→fetch→rebase→push→ls-remote 核对），派发单里「会触发 typecheck/smoke 闸门」的说法与实际脚本不符，以脚本为准。
- **待中枢处理的后续**：`src/builtin-capabilities.ts` 的 git-sync 能力 v4 description 仍写着「Gitee 重建前全部失败」（已过时），且超过 500 字上限导致内置能力播种被静默跳过（capability-smoke C3 / workspace-scope W5 失败的根因）。建议后续一轮：description 改短并更新为「Gitee 已恢复（Zry/SuperMemory）」升 v5 → 中枢 `pnpm build` + 插件重载 + `memory_toolize refresh-builtin`。分支内不重载（禁自杀）。
- 本轮提交只含文档（`docs/git-sync.md` + 本小节）；DEV-NOTES.md 同时带入 R30-A/R30-B 的文档小节（§36/§37，代码改动仍未提交，归各自轮次）。

---

## 39. R30 集成轮：全量闸门 + git-sync 能力 v5 修复 + 一次性提交（2026-11-23）

### 需求与结果

- R30-A（§37 记忆版本控制 + 面板记忆两级页）与 R30-B（§36 中枢-分支协同③-⑥）终态后，本轮把全部改动合并收口：一次提交（含 `lib/` 重建产物——插件经 profile 符号链接从仓库加载，宿主入口 `lib/supermemory.js` URL 稳定、按内容哈希重新导入新 chunk，重载后生效），**未推送、未重载**（中枢负责）。
- `memory-cleanup-20261122/`（R29 遗留本地清理报告）按约定留作未跟踪，未入库。

### 既有失败根因修复：git-sync 内置能力 v4→v5（§38.4 待办的兑现）

- 根因：v4 描述 **725 字**超过 `buildCapabilitySpec`（src/composite.ts）的 **500 字**上限 → `mergeBuiltinCapabilities` 静默跳过播种（`report.seeded=[]`）→ capability-smoke **C3** 与 workspace-scope **W5** 失败、内置能力计数差 1。该文件 R30 两分支都未改（R29 遗留）。
- 修法：version 4→5；描述压回 **499 字**并更新为现状——双远程推送（origin push = GitHub 首位 + Gitee `Zry/SuperMemory`，fetch/pull 只走 Gitee）、凭据走仓库本地 GCM（helper=manager）、`GIT_TERMINAL_PROMPT=0`、Gitea 2026-11-22 晚重置后已恢复（帐号改名 `旧帐号名→Zry`，非重建）、凭据键坑与恢复流程指向 `docs/git-sync.md`；changelog 记录 v5 原因（超限被静默跳过 → 压缩 + 更新现状）。
- 修复前后实测：C3 `AssertionError: actual [] expected ['sm_composite_git_sync_supermemory']` → `ok - C3 内置播种：空库播种+落工作区+重启重建拾取+幂等`；W5 `rebuild 注册全部活跃行（含播种的内置能力）: 3` → `ok - W5 重启重建带行级归属；内置播种落 scope 工作区且幂等`。

### 闸门（全绿，按序）

- `pnpm typecheck`：宿主 + 客户端双 0 错。
- `pnpm build`：宿主 10 文件 642.91 kB（含新 `lib/memory-versions-*.js` chunk）+ client 134.12 kB（wrapped 130818 bytes）；`INEFFECTIVE_DYNAMIC_IMPORT` 为既有提示非错误。
- `pnpm smoke` 六套件：core 25 / mechanism 98（含 R30-B1–B4）/ webui 35 / client-sim `SIM SMOKE OK` / capability 12（C3 转绿）/ workspace-scope 9（W5 转绿）。
- 提交后待中枢：`pnpm build` 已生成新 `lib/`，重载插件 + `memory_toolize refresh-builtin` 后 store 里的能力行才升到 v5（分支内禁重载）。

---

## 40. R31：中枢会话具体标题 + 分支/中枢徽标常显（2026-11-23）

对应用户三项 GUI 需求（①中枢会话名称 ②③徽标常显 + 中枢徽标），与 R30 同批文件串行做完。

### 40.1 需求①：中枢会话名称从「新会话」变成具体标题

- **生成路径**：`src/panel.ts` `createHubSession` 的标题由 `'新会话 · ' + id4` 改为 **`'SuperMemory 中枢 · ' + id4`**（后缀保留：多个中枢会话在侧栏要靠它区分）。标题生成函数 `hubSessionTitle(sessionId)` 与新前缀常量 `HUB_TITLE_PREFIX` 落在 `src/hub-sessions.ts`（与 `HUB_ID_PREFIX`/`isPluginBranchId` 同处，生成与迁移共用一份）。
- **一次性迁移**（新模块 `src/hub-title-migration.ts`，模式参照 title-migration.ts）：
  - 枚举走宿主 `sessionQuery.listSessions()`（缺失时退 `ctx.sessions.list()`；两者都没有 → `no-host` 且**不写标记**，下次启动重试）；
  - 候选 = 无 `parentSession`、`origin !== 'subagent'`、非插件 `branch-*`/`fork-*` id（分支永远不当中枢改名）；
  - 标题先批量读（`readTitleSnapshots`，退逐条 `currentSessionTitle`），只对**仍匹配 `^新会话 · `** 的落计划；apply 前再用 `currentSessionTitle` 复核一遍——**用户手动改过的一律不覆盖**；
  - 改名走 `applySessionTitle(..., { force: true })`（与生成路径同一宿主写入）；
  - 标记：`meta` 行 `hub-titles`（schema 的 meta 增 `hubTitlesMigrationVersion`/`hubTitlesMigratedAt`——meta schema 会剥掉未声明键）。**有 pending（会话尚未 attach，outcome `none`）时不写标记**，下次启动自愈续跑，不做成一锤子丢失。
- `index.ts` 启动处在 `migrateTruncatedTitles` 之后调用（best-effort，失败只 warn）。
- 未动 `title.ts` 的 `TITLE_FALLBACK`（话题集成员命名回退）与 `hub-sessions.ts` 的 `fallbackTitle`（面板降级回退）——前者是无后缀的裸「新会话」，与旧中枢标题的 ` · id4` 不撞。

### 40.2 需求②③：徽标常显 + 中枢徽标

- **根因（宿主 app.asar 源码核实）**：徽标原挂 `sidebar.session.row.leading`，宿主 Rows.tsx 对该 cell 的门控是 `!row.archived && !row.blank && (showStatus ? <SessionStatusDots/> : renderSlot(...))`，`showStatus = 主状态非 idle`——会话一运行徽标就被状态点挤掉（用户说的「运行中隐藏」）。
- **改法（纯插件侧）**：`src/client/index.ts` 的 slot 从 `leading` 改为 **`sidebar.session.row.trailing`**（order 30 不变）。trailing cell 只受 `!row.blank` 门控（时间戳 + slot + pin 指示都在 `{!row.blank && …}` 里），运行/审批态都渲染；asar 内无其他包注册该 slot。
- **kind 规则**（`src/panel.ts` `sessionBadge()`）：成员（fork 或 branch-* id）→ `branch`；root 成员 → `hub-set`；**非成员按 id 形状**——插件 `branch-*`/`fork-*` → `none`（刚从 mint 出来还没入集的分支不徽标，避免误徽成中枢）；宿主 `session-*` → `hub`（新增渲染）；其余 → `none`（新增 kind，显式「无徽标」而非旧的兜底 hub）。
- **组件侧**（`src/client/session-badge.tsx`）：`hub` 用辐射状小图标（中心点 + 8 射线，与分支「一线两圆」/话题集「储物袋」区分）+ 文案「中枢」；`none` 渲染 null；配色用主题 `--dsw-alias-state-done-primary`（亮 violet-600 / 暗 violet-400，与 hub-set 的 link 蓝区分，双主题可读）；负向缓存 TTL 从仅 `hub` 扩到 **`hub` + `none`**（都是「尚未入集」的观测，8s 过期，避免 R18 同类 race）；模块头注释重写为 trailing/!row.blank 的事实与理由。
- **locales**：`badge.hub`（zh「中枢」/en 'Hub'）、`badge.hub.tip`（zh「SuperMemory 中枢会话」/en 'SuperMemory hub session'）。
- **已知限制（非回归）**：blank 行（还没有首条消息）leading/trailing 都不渲染，全新空中枢会话在有消息前不显徽标——与改前同门控。

### 40.3 闸门与验收

- `pnpm typecheck` 双 0 错；`pnpm build` exit 0（宿主 10 文件 + client 136.32 kB）；`pnpm smoke` 六套件全绿：core 25 / **mechanism 99**（新增 R31-1 中枢标题迁移用例 + E2 按新 kind 规则改写）/ webui 35 / client-sim（slot 断言改 trailing）/ capability 12 / workspace-scope 9。
- **实时数据验收**：用 `~/.dsh/storages/supermemory.json`（只读）驱动真实 `SupermemoryPanelService`，7/7 通过——R30 话题集的 branch-* root 成员→`branch`、session-* root 成员→`hub-set`、派发记录里的两个真实中枢会话→`hub`、派发过但未入集的真实 branch-*→`none`、合成未入集分支与未知 id→`none`。
- 管理台 HTTP 验收未做：控制台令牌只经 `/memory ui` 下发（本分支无该工具），页面 token 已被剥离，API 401；改以「实时存储 + 真实服务」等价验证。
