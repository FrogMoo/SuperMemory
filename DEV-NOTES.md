# SuperMemory 开发运维笔记（Dev Notes）

> 记录 P0 实现期间在真实宿主上验证过的加载机制、开发回路与环境事实。
> 设计方案见《可行性分析与实现方案.md》v4.2；本文件是它的执行层补充。

## 1. 加载机制（已源码级 + 运行时验证）

宿主 DSH Desktop 0.2.2-rc.3，profile：`~/.dsh/profiles/desktop`（`patchReload: live`）。

- **路径行加载可行**：profile 的 `cordis.patch.yml` 追加
  `- insert: - id: supermemory, name: 'G:/09 - dsh/SuperMemory/lib/index.js'`，
  live reload 后插件正常 apply。
- **`@deepseek-ai/dsh-*` 不能直连**：从插件位置解析不到（profile node_modules 只有
  cosmokit/schemastery 等非 dsh 包）。必须用 dsh-vscode-mode 实证的
  **loadHostModule 模式**：`createRequire(process.argv[1]).resolve(spec)` 再
  `import(pathToFileURL(resolved).href)`。`process.argv[1]` 是宿主入口
  （`.../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`）。
  探针实测：dsh-tools / dsh-agent / dsh-storage-domain / dsh-user-questions /
  dsh-workspace / dsh-llm / zod 全部 host-ok；直连全部 fail。
- **schemastery 走静态 import**（external，运行时从安装作用域解析），与
  dsh-vscode-mode 一致。注意：**profile 里的 `@deepseek-ai/schemastery` 曾被掏空**
  （目录在、内容没），导致所有静态 import 它的插件（dsh-vscode-mode、
  dsh-connect-workbuddy、本插件）全部 PENDING。用 workspace 里同版本包
  `cp -r` 恢复后一切正常。若日后再现"插件 enabled 但 fiberPhase 为 null"，先查这个包。
- **ctx 服务必须显式 `inject`**（数组形式），否则 `cannot get property X without
  inject`。本插件 inject：
  `['sessions', 'tools', 'storageDomain', 'sessionPersistence', 'commands', 'systemPrompt']`。
  注意服务名是 `sessions`/`sessionPersistence`（不是 session）；`workspace` 键为
  undefined（P1 的 attach 用 `workspaceRegistry`，见 dsh-vscode-mode 的 inject）。
- **存储**：`ctx.storageDomain.open(spec)` → JSON 后端 → `~/.dsh/storages/supermemory.json`
  （single 布局，首次 put 才落盘）。领域版本 1，11 张表全部带 workspaceKey（D4）。

## 2. 开发回路（live reload 的坑）

1. **ESM 按 URL 缓存**：同一文件路径重复 import 返回首次缓存的模块，改文件不重载。
   开发迭代必须换模块 URL（`scripts/dev-load.sh` 每次复制到 `lib/dev-<时分秒>.js`）。
2. **patch 文件必须原子写**：`open('w')` 截断-写入有窗口期，监视器读到半截文件会把
   条目摘掉且不恢复。dev-load.sh 用临时文件 + `os.replace`。
3. **文件监视器有分钟级延迟且会漏**。可靠的重载是用 loader 原生路径：
   `plugin_manager set_plugin target=include:<entry-id> enabled=false` 再 `true`
   （25ms 完成 remount）。build 后走这个两步循环。
4. **最终稳态**：patch 条目指向稳定的 `lib/index.js`（DSH 重启后无缓存问题）。

## 3. 实现要点（P0）

- 插件形态：`{ name, inject, Config, apply }`；Config 用 schemastery object schema。
- 工具用宿主 `defineTool`（loadHostModule 取得），parameters/output.schema 用
  dsh-tools 的 **DSL**（`{ type, required?: true, enum?, properties? }`），不是
  JSON Schema 数组式 required；执行入口是 `execute(args, exec)`（不是 resolve）。
- 事件监听：`ctx.on('session/event', ...)` 在插件 ctx 上能收到**所有会话**的事件
  （scope 过滤只影响 agent 作用域监听器）；`agent/pre-step` 是 waterfall，必须
  `await next()` 并透传完整 decision（含 startsRequestSeries），只追加 messages。
- 守卫：只对含 `source.kind === 'user'` 的批次注入 recall；supermemory/relay 与
  工具 continuation 原样放行。
- 维护循环（D2）：`turn/end`（持久事件）→ 内存队列 → 后台串行处理；游标
  `hotcache.lastMaintainedSeq` 持久化，重启后按游标冷读对账（§2.4 路径 1）。
- 教训：`String.matchAll` 只接受 global RegExp；正则前的 `(?:^|\s)` 前缀在真实
  消息里（引号包裹）会漏匹配——抽取模式已放宽。

## 4. 已知边界（P0 范围外）

- `/memory status` 命令已注册但需在 GUI 输入验证（工具/注入/维护均已自动化验证）。
- topicset 路由、dispatch/relay、侧边栏、filemap、工具化在 P1–P3。
- 生产安装（bundle 自挂载 + `dsh plugin add`）未走通；当前是 profile patch 路径行，
  适合开发。发布时按 dsh-vscode-mode 结构：package 进 profile node_modules +
  package.json `dsh.profile.bundles` 列表 + cordis.patch.yml 自挂载行。
