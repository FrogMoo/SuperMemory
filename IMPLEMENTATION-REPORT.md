# SuperMemory 需求 A/B/C 实现报告（2026-11-18）

分支会话：`branch-mwk8lbxu-5vyivl`；工作区：`G:/09 - dsh/SuperMemory`。
提交现状：A/B 在 `ee58034`（wip 检查点）；需求 C（连同并行的「分支中断兜底结算」D）由恢复分支
提交在 `918b642`；本分支随后以 `8448cf5` 恢复被 host-only tsdown 删掉的 `lib/client.js` 并纳入本报告。
另有并发会话在同一工作区写入了 D 改动——本报告只对 A/B/C 负责。

## 1. 结论

- 需求 A（过程内再召回）：已实现为**每步 pre-step 注入**的硬机制，同一请求内可注入多张卡片，
  带去重/条数/字符上限，默认保守（3 次工具调用一张，最多 4 张 / 6000 字符）。
- 需求 B（组合工具硬优先）：已实现为 ①② 两个自动固化触发源 + ③ 结构化工具目录 + ④ 近失提示；
  人工确认路径在 autoToolize=false 时完整保留。
- 需求 C（新会话命名）：宿主**确实有**标题写入 API（`ctx.sessionTitle.rename`），已实测生效：
  派发产生的分支会话在会话列表投影里从 `null` 变为可读标题。

## 2. 变更文件与行号

### 2.1 需求 A（过程内再召回）

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `src/inrequest.ts` | 152 | `observe()` 记录工具结果并判定高信号 |
| `src/inrequest.ts` | 182 | `triggerOf()` 触发条件（tools / hot） |
| `src/inrequest.ts` | 192 | `canInjectCard()` 卡片数/字符预算 |
| `src/inrequest.ts` | 211 / 217 | `freshItems()` 去重 / `commitCard()` 记账 |
| `src/inrequest.ts` | 244 | `renderRepeatCard()` 「过程内补充」卡 + 目录 |
| `src/inrequest.ts` | 266 | `createTracker()` 按会话请求状态（LRU 128） |
| `src/prestep.ts` | 63 | `attachPreStep()` 每步注入口（首卡 + 重复卡） |
| `src/activity.ts` | 82 | `attachToolActivity()` post-execute 观察/近失/提示 |
| `src/index.ts` | 123 | `recall.repeat.*` Config schema（中文 description） |
| `src/index.ts` | 304 / 317 | pre-step 与 tool-activity 接线 |

### 2.2 需求 B（组合工具硬机制）

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `src/toolize.ts` | 193 | `planAutoToolize()` 纯决策（创建/重复/冷却/上限/非法/关闭） |
| `src/toolize.ts` | 237 | `autoToolizeFromSequence()` 编译+注册+持久化 |
| `src/toolize.ts` | 321 | `recordTurnSequences()` 滑动窗口计数 + 阈值固化 |
| `src/toolize.ts` | 383 / 418 | 启动扫描固化 / 零使用回收（默认关） |
| `src/toolize.ts` | 121 / 145 / 164 | 前缀匹配 / 目录 / 目录渲染（只列 live 工具） |
| `src/toolize.ts` | 449 | `repeatedWindow()` 同请求内重复窗口即硬信号 |
| `src/activity.ts` | 127 / 129 | 同请求重复 → 立即自动固化 |
| `src/maintenance.ts` | 341 | 回合序列喂 `recordTurnSequences` |
| `src/index.ts` | 101 / 154-159 | `toolizeConfig()` 与 maintenance schema |
| `src/composite.ts` | 末尾 | 删除无效的 pre-execute 提示（PreToolDecision 无 context 字段） |

### 2.3 需求 C（新会话命名，工作区未提交）

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `src/title.ts` | 66 / 87 / 110 | 截断 / 去标记 / `sessionTitleFor()` 命名规则 |
| `src/title.ts` | 156 | `ensureMemberTitle()` 成员首次命名并持久化 |
| `src/title.ts` | 189 | `applySessionTitle()` host rename → append 回退 |
| `src/dispatch.ts` | 210-211 | 新分支/resume/continue/fork 统一命名 + 日志 |
| `src/panel.ts` | 304 / 310 | 话题集会话命名（取代写死的「话题集会话：…」） |
| `src/panel.ts` | 365-366 | 面板回复新建分支命名（取代写死的「面板回复」） |
| `src/reconcile.ts` | 133-134 | 重启恢复 resume 时补命名 |
| `src/services.ts` | 31-38 / 47 | 扩充 sessions.append/seq 与可选 `sessionTitle` 声明 |
| `scripts/mechanism-smoke.mjs` | 文末 | C1–C4 单测（命名规则/去重/dispatch 成员/宿主回退） |

## 3. 设计取舍

1. **为什么注入点选 `agent/pre-step`**：它是每步 waterfall，`enter` 决策的 messages 是插件唯一
   可写且会落日志的模型可见通道；`agent/request` 已废弃且禁止改 messages；systemPrompt 在
   pre-step 之前组装、不能做 recall I/O；runtimeContext 只读。
2. **为什么删掉 pre-execute 提示**：`PreToolDecision` 只有 allow/deny/cancel/ask，没有 context
   字段——旧代码写 additionalContexts 是**无效能力**，属"伪造"；改走 post-execute 的
   `additionalContexts`（真实可见）+ 下一轮 pre-step 目录卡。
3. **为什么自动固化有两条触发**：回合结束的持久序列（跨轮）覆盖"重复流程"；同请求内同窗口
   重复 ≥ 阈值（`activity.ts`）覆盖"一个长回合里反复做同一套动作"——后者让自动固化真正
   摆脱用户确认。两者共用 `planAutoToolize` 的冷却/上限/合法性闸门。
4. **命名 API 取舍**：用 host service `ctx.sessionTitle.rename`（官方、带规范化、pin 住标题），
   而不是直接 `session.append`（作为无服务时的精确形状回退）；不用客户端 `SessionService.rename`
   Remote（插件在 host 侧，不该绕 GUI API）。`ctx.get('sessionTitle')` 可选访问，避免加进 inject
   把 fiber 变成硬依赖。
5. **命名规则**：可读 + 稳定 + 有界：`<话题集标题> · <任务首行去标记后 16 字>`，总长 40，
   同集重名 `（2）`；复用已有成员/已有标题时保持首次命名（不覆盖人工改名）。

## 4. 实测证据

### 4.1 需求 A（真实 GUI 会话日志 `branch-mwk8lbxu-5vyivl`，turn 2）

同一请求内出现多条 `source.kind=supermemory, form=recall` 消息，内容以
「[SuperMemory 相关记忆 · 过程内补充]」开头（seq 1564 / 1594 / 1636 / 1652 …），
以及一条 `form=notice`（seq 1582）组合工具提示；后续卡片含
「[SuperMemory 可用组合工具]」结构化目录。旧实现每个请求只有开头 1 张卡（seq 8）。

### 4.2 需求 B（真实 GUI + 单测）

- 自动固化实测：派发任务「先 memory_scan、再 memory_topicsets，重复 3 轮」到话题集
  「命名验证」；请求结束后 `~/.dsh/storages/supermemory.json` 的 `tables.tool_memory`
  新增一条 `组合工具：memory_scan → memory_topicsets`，且之后模型工具表出现
  `sm_composite_memory_scan_memory_topic`（本会话 SDK 清单可证）。
- 近失/目录实测：同会话出现 `[SuperMemory 提示] 刚执行的 run_code → run_code 与组合工具 …
  的前 N 步一致` 提示与目录卡。
- 单测：`scripts/mechanism-smoke.mjs` B1–B6（自动固化、冷却、上限/重复/非法、前缀匹配与目录、
  同请求重复窗口、启动扫描）全部通过。

### 4.3 需求 C（真实 GUI）

话题集「命名验证」派发两次，任务「只回复 OK。」：

- 成员标题（store）：`命名验证 · 只回复 OK。`、第二次 `命名验证 · 只回复 OK。（2）`
- 分支日志：`session/title` 事件
  `{"title":"命名验证 · 只回复 OK。","messageSeqs":[],"source":{"kind":"user"}}`
- 会话列表投影（GUI 侧栏数据源）：
  `~/.dsh/storages/session_projcache/sessions/branch-mwka8rgg-6038cy.json` →
  `record.rows.title = {"ver":1,"seq":15,"val":"命名验证 · 只回复 OK。"}`；
  修复前分支该值恒为 `null`（对照 `branch-mwjk5c2r-gjjv24` 等旧分支仍为 null）。
- 重载：`memory_ui` 端口 61327 →（禁用后 `unknown tool "memory_ui"`）→ 启用后 61390，
  证明插件已重新 apply、新代码在跑。

### 4.4 闸门输出

```
TSC_OK                       # npx tsc --noEmit
5 checks passed              # core-smoke
19 checks passed             # mechanism-smoke（本分支 A1-A6 / B1-B6 / C1-C4 + D 的补充用例）
26 checks passed; …          # webui-smoke
SIM SMOKE OK                 # client-sim-smoke
✔ Build complete in 26ms / wrap-client: lib/client.js wrapped (43150 bytes)
```

## 5. 未完成项与风险

1. **GUI 侧栏截图未提供**：本分支没有浏览器/截图工具，无法取证像素级 UI；已用 GUI 侧栏读取的
   同一数据源（`session_projcache` 的 title projection）+ 分支日志 `session/title` 事件代替，
   二者一致即可证明侧栏会显示该名称。
2. **零使用回收默认关闭**（`recycleIdleToolDays=0`）：只做审计日志与 TODO，不自动退役，
   避免误删仍在用的组合工具。
3. **全同工具复合的提示噪声**：`run_code×4` 这类复合会让任意 run_code 调用都命中山前缀，
   提示意义低；建议后续在 catalog/hint 侧要求 ≥2 种不同工具。
4. **自动固化描述文案**：「由重复流程 N 次后固化」的 N 恒为 1（`signalOf` count=1），
   属文案缺陷，不影响注册/调用。
5. **禁用/重载只能在 hub 或 GUI 做**：历史事故表明在分支会话内禁用插件会 dispose 分支 agent，
   可能让 dispatch 卡在 dispatched；本次禁用/启用均在分支内完成且未卡死（新实例端口已变），
   但 SOP 仍应改为 hub/GUI 执行。
6. **B 的人工路径**：autoToolize=false 时仍走 pending 提议 + `memory_toolize` 确认；该路径
   未在真实 GUI 中回归（仅代码保留 + 单测覆盖决策）。
7. **并发写工作区**：恢复分支（D）与本次 C 在同一工作树并行修改，`ee58034` 之后出现
   `918b642`；host-only `tsdown` 曾把 `lib/client.js` 清掉（客户端半边会 404），已由
   `8448cf5` 恢复。后续请在提交前确认 `lib/client.js` 存在（`pnpm smoke` 里的 client-sim 只在
   该文件存在时才有效）。
