# 2026-11-18 修复：插件重启后分支会话保留并在 GUI 可见

工作区：G:/09 - dsh/SuperMemory（DSH 插件 SuperMemory 源码仓库）
基线：HEAD = 8858ef6（工作树干净起步；本分支改动未提交）

## 1. 问题

用户在 GUI 插件页对 SuperMemory「禁用 → 启用」（或重启 DSH Desktop）之后，
**所有分支会话从 GUI 会话列表消失**。需求：重启后保留这些分支会话，并能在 GUI
中显示出来（标题、状态、所属话题集、任务摘要），可继续/续接。

## 2. 根因（带证据）

### 2.1 插件侧：分支注册表是进程内 Map，启动没有任何路径重建它

- `src/dispatch.ts:81`（改动前行号，下同）：
  `export const branchHandles = new Map<string, BranchHandle>()` —— 插件持有的
  live 分支注册表，纯进程内状态，不持久、不重建。
- 启动路径（`src/index.ts` `apply()`）只做：
  - `runReconciliation`（`src/reconcile.ts`）：路径 1 只 settle **queued/dispatched**
    的派发；路径 3 只 resume「queued/dispatched 且分支日志里没有执行痕迹」的分支。
    已交付 / 已中断 / 空闲的分支——台账里的绝大多数——没有任何代码重新 attach。
  - `detachIdleBranches`（需求 E）：只从 `branchHandles` 摘除 handle，不重建。
- 因此重启后 `branchHandles` 恒为空：插件不持有任何分支 handle。

### 2.2 宿主持有的会话不会被销毁，但插件不重新点亮它们

只读核查宿主源码（`D:/01 - software/DSH Desktop/resources/app.asar/dsh/`，
经 Electron asar 文件系统读取，未做任何改动）：

- `@deepseek-ai/dsh-agent` `AgentRegistry.create/resume`（src/index.ts:404/428）：
  `ownerCtx = this.ctx`（agents 服务自身上下文），生命周期效果挂在宿主侧；
  `AgentHandle.dispose()` 的语义是「停 loop、注销 agent、关闭写句柄」——
  **不删会话日志**。
- `@deepseek-ai/dsh-session-persistence`（jsonl）：分支会话日志持久化在
  `~/.dsh/sessions/<项目>/<sessionId>/session.v4.jsonl.zstd`（实测存在 28 个
  `branch-*` 目录）。
- `@deepseek-ai/dsh-workspace` `attachSession` 的 workspace→session 绑定持久化在
  `~/.dsh/storages/workspace.json`（实测 SuperMemory 工作区记录含 28 个分支）。
- GUI 会话列表（`@deepseek-ai/dsh-api-session-controller` `list()`）经
  `sessionQuery.listSessions()` 合并「持久化 + live」语料，冷会话也列出。

也就是说：宿主持有的分支会话与 workspace 绑定都不会因插件重启而丢失。丢失的是
**插件侧的点亮**：DEV-NOTES §2.5 记录「重启会杀死插件创建的分支 agent（fiber 卸载
连带 dispose）」——插件 fiber 卸载时分支 agent 被 dispose，GUI 客户端随
`agent/disposed` / `session/disposed` 把分支会话从列表移除；而新 fiber 启动后
没有任何路径 `agents.resume` 这些分支，于是列表里再也不出现（直到整页刷新以冷行
形式短暂回来，且标题/ live 状态全无）。

### 2.3 标题恢复依赖 live 会话

`src/title.ts` `applySessionTitle()` 第一件事就是 `ctx.sessions?.get(sessionId)`，
拿不到 live 会话直接返回 `'none'`。所以不重新 attach，标题永远无法在 GUI 恢复。

### 2.4 面板/管理台数据源

- `src/panel.ts` `hubState()/listTopicSets()/view()` 与 `listHubBranches()` 读的是
  持久台账（topicsets.members + dispatches），重启后仍能枚举分支——但成员
  `status` 是上一个进程留下的陈旧 handle 事实（`live` 计数失真）；
- `src/webui.ts` `state` 端点已带 `hubBranches`（`listWorkspaceBranches`，
  跨中枢工作区视图，`src/web/app.js` 渲染）；
- 话题集分支行缺少「任务摘要」字段，仅凭台账难以认出分支。

## 3. 修复

### 3.1 新模块 `src/branch-restore.ts`（新建）

- `collectBranchRestoreTargets(store, {limit})`（纯函数）：从
  `topicsets.members`（kind `fork` 或插件铸造的 `branch-`/`fork-` 前缀 id）与
  `dispatches.branchSessionId`（限插件前缀 id）汇总所有分支会话，带去重、
  成员事实优先、所属话题集、成员标题、最近任务、最近活动时间，按活动倒序，
  默认上限 200。**话题集 root 成员（`session-` 中枢会话） deliberately 不在恢复范围**。
- `restoreBranchSessions(deps, {concurrency})`：对每个目标——
  - 已 live（`branchHandles` 或 `ctx.agents.get`）→ 直接采用；
  - 否则 `ctx.agents.resume({ resumeSessionId, setup: compositionSetup(...) })`
    重新 attach（宿主官方重接入口，同一会话同一段日志），handle 登记回
    `branchHandles`；成员 `model` 覆盖优先（`parseMemberModel`）；
  - 随后 best-effort：成员状态刷新 `live`、`ensureMemberTitle` +
    `applySessionTitle` 恢复标题（`already` 守卫不覆盖人工改名）、
    `attachBranchToWorkspace` 幂等重绑 workspace 可见性；
  - 失败：记 `failed`、成员标 `idle`（live 计数如实）、**台账原样保留**
    （memory_resume / 面板后续仍可续接）；若失败时会话已因并发变 live
    （reconcile 路径 3 抢先 resume）则不标 idle。
- 语义边界（不回归需求 E）：**只 attach，绝不 dispose；不投递任何消息**
  （resume 只点亮会话，loop 处于 maintenance，不消耗 token）；全程 best-effort，
  插件启动永不因此失败；无 `agents` 缝隙（minimal profile）时全部 skipped。
- 并发默认 3；`markMemberStatus` 幂等（状态未变不写库，避免重复刷新
  `lastActiveAt`）。

### 3.2 `src/index.ts` 启动接线

`apply()` 内（store 存在分支）新增两个一次性定时器（均登记 dispose 清理）：

- `+5s` `runBranchRestore('启动恢复')`：错开 reconcile 路径 3 的 resume；
- `+35s` `runBranchRestore('启动补恢复')`：接住启动竞态（旧实例刚释放
  persistence 句柄，参照 `store.ts` 的 `already-open` 重试窗口）下的失败；
  重跑幂等（已 live 的只读不写）。

日志经 `renderBranchRestoreSummary()` 汇总（resumed / live / failed / skipped）。

### 3.3 `src/panel.ts` 分支行补任务摘要

- `TopicSetView.branches[]` 新增可选 `task` 字段（最新一次派发的摘要，
  `taskExcerpt(..., BRANCH_CARD_EXCERPT_CHARS)`）；
- 数据来自新导出的 `latestTaskByBranch(store)`（`src/hub-branches.ts`，纯台账读，
  不需要 live handle）——重启后仅凭持久台账也能认出每个分支
  （标题 + 所属话题集 + 任务摘要）。
- 继续/续接入口保持不变且重启后可用：分支卡片点击 →
  `readSessionMessages`（`sessionQuery` 冷读）+ `sendSessionMessage`
  （idle 会话经 `agents.resume` 点亮后以 `source {kind:'user'}` 投递，R25）；
  中断任务经 `memory_resume` / `/memory resume` 续跑（恢复后分支已 live，
  走 continued 路径而非重派发）。

### 3.4 `src/dispatch.ts`

- `parseMemberModel` 改为导出（恢复路径需要成员模型覆盖优先），行为不变。

## 4. 验证（本机实测）

| 闸门 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（本人的文件） | `pnpm typecheck` | 本人文件 **0 错**；仅存 3 个错误，全部位于并行分支在改的 `src/builtin-capabilities.ts`(1) 与 `src/composite.ts`(2)（不在本人所有权内，未触碰） |
| 机制冒烟 | `node scripts/mechanism-smoke.mjs` | **89 checks passed**（新增 R7-1..R7-4 四条：收集器口径 / live 采用+resume 重连+不 dispose 不投递 / 失败不丢台账 / 无 agents 缝隙跳过） |
| 核心冒烟 | `node scripts/core-smoke.mjs` | 9 checks passed |
| 管理台冒烟 | `node scripts/webui-smoke.mjs` | 32 checks passed |
| 客户端仿真 | `node scripts/client-sim-smoke.mjs` | SIM SMOKE OK |

未运行 `pnpm build`（任务禁令：并行分支共用 `lib/` 与 client 产物，全量构建交由
后续集成分支）；未跑 `pnpm git:sync`；未做任何 git 写操作。

## 5. 不回归核对

- `detachIdleBranches` / `releasableBranches` 未改（smoke R1 断言原样通过）；
- R25 `source {kind:'user'}` 六处投递未动（smoke R25-1/R25-2 通过）；
- `src/title.ts` 未改（`clipEllipsis` / 80 字符预算不变）；
- `memory_resume`（`src/resume.ts`）未改；恢复后的分支反而让 continued 路径更易命中；
- 面板新增字段为可选增量，client-sim 结构断言不受影响。

## 6. 遗留风险与后续建议

1. **恢复是全量点亮**：默认上限 200、并发 3。超大台账（数百分支）首次启动会
   批量 resume（每会话读日志 + 起 loop）。如未来感到启动压力，可按
   `lastActiveAt` 加时间窗（如仅恢复 N 天内活跃的分支，其余保持冷行可见）。
2. **35s 补恢复只跑一次**：之后某个分支若因宿主原因掉线，不会自动重连；
   但面板 `sendSessionMessage` / `memory_resume` / 派发 `acquireBranch`
   的 live→resume 路径都能按需重连。
3. **`src/web/app.js` 未渲染任务摘要**：管理台 `state` 端点的 `hubBranches`
   行已带 `task`（`HubBranchView`），但静态页渲染未展示——`src/web/` 不在
   本轮所有权内，建议后续分支补一行渲染。
4. **客户端未渲染面板分支行的 `task`**：数据已在宿主侧就绪，
   `src/client/panel-page.tsx` 渲染留给后续（同样不在本轮所有权内）。
5. **实时端到端未验证**：插件重载只能由用户在 GUI 插件页执行（分支会话内禁止），
   本轮无法自行触发；请按下节操作验证。

## 7. 需要用户在 GUI 侧配合的操作

1. 「设置 → 插件管理」对 **dsh-supermemory** 禁用 → 启用（或重启 DSH Desktop），
   等约 35s 让启动恢复两轮跑完；
2. 打开任意工作区会话：左侧会话列表应重新出现历史 `branch-*` 会话
   （live、带标题）；「超级记忆」面板的话题集卡片显示分支（标题/状态/话题集/
   任务摘要）；Web 管理台 `/supermemory` 的「中枢会话」卡片显示其分支；
3. 若仍有分支缺失：在插件日志检索 `supermemory: branch restore` 行
   （resumed/live/failed/skipped 计数与逐会话 warn），把失败分支 id 反馈给下一轮。
