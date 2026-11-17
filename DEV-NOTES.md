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
  `memory_topicsets`/`memory_new_topicset`/`memory_set_model` 工具、host 侧
  `supermemoryPanel` Remote 服务（list/activate/activeTopicSet + typert 描述符）。
- **后续接入**：拿到 client preset 后建 `src/client.ts`（sidebarRightTabs.register +
  `sidebar.right.pane.tab` keyed slot + guide 入口），body 调
  `ctx.remote.supermemoryPanel.listTopicSets(cwd)`；先用最小 slot 验证再接业务。

## 5. 当前状态（2026-11-17）

- 插件运行中（entry `include:supermemory`，stable 入口 `lib/supermemory.js`）。
- 域数据：topicsets 5 / memories 8 / episodes 5 / requirements 2 / filemap 50 /
  tool_memory 1（组合工具）/ signals 7 / dispatches 6 / outbox 6 / hotcache 33。
- 已验证：P0 三项验收、P1 全链路（派发→分支→relay→确认）、P2 组 relay/需求/filemap/export、
  P3 阈值提议→固化→重启后仍可用。
- 待用户验证：`/memory status`、`/memory topicsets`、`/memory scan`、`/memory export`
  （斜杠命令只能由用户在输入框提交）。
