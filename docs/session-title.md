# 会话命名服务（R59）

> 适用版本：R59（2026-11-27）。实现位置 `src/session-title/`；宿主 DSH Desktop 0.2.2-rc.3。
> 本文覆盖：根因、权威模型、状态机、80 UTF-8 bytes、事件内延迟写、迁移、手动改名/恢复/修复、domain v2 兼容、架构边界、验收与排障、A–J 矩阵。

## 1. 背景与根因

R43 引入了「中枢名字恒为 新会话」的回归。当时 `src/hub-title-migration.ts` 的
`attachHubTitleFromFirstMessage` 在 `session/event` 监听器里**同步**调用
`applySessionTitle` → 宿主 `sessionTitle.rename`。宿主在发布事件期间
`entry.appending = true`，任何 append/rename 都会抛：

```text
session append cannot reenter while another append is being published
```

该调用包在 `try/catch` 里，而 logger 是 `{ warn: () => {} }`（空实现），错误被吞掉；
但紧随其后的 `recordHubSession` 把「主题」写进了 `hub_sessions.title`。
结果是：**镜像有主题、宿主标题仍是「新会话」**，GUI 永远显示旧名。

R59 的修法不是再加一个 try/catch，而是把命名拆成四件事：
**一个状态表**（`session_titles`）、**一个写入口**（gate）、**一个延迟调度器**（defer）、
**一个观察者**（observe）。所有宿主写必须出栈，所有失败必须可诊断。

## 2. 权威模型

| 位置 | 角色 | 谁写 |
|---|---|---|
| 宿主 `session/title`（`sessionTitle.rename`） | **唯一权威**；GUI 侧栏/会话头显示它 | 只有 `session-title/host.ts`（经 gate） |
| `hub_sessions.title` | 宿主标题的**同串镜像**；冷会话/卡片回落 | gate 成功写后 `mirrorHubTitle` |
| `dispatches.title` | 分支的持久标签（列表/卡片投影最新行） | dispatch 创建 + `syncDurableTitles` |
| `topicsets.members[].title` | 分支/ root 成员的持久标签 | `ensureMemberTitle` + `syncDurableTitles` |
| `session_titles` | 插件意图（desired/auto/lastWritten/state/lock/pending） | `state.ts`（唯一状态入口） |

- 宿主标题是唯一权威：插件**不**从镜像反推宿主名（除明确的 repair/reset）。
- 所有标题最终都经过 `policy.ts` 的同一组合与裁剪；宿主、镜像、durable 写同一串。
- 展示统一走 `resolveTitle`（`resolveSessionTitle`）：宿主（非中性）→ `hub_sessions` 镜像 →
  `desiredTitle`/`lastWrittenTitle` → ''（由调用方兜底）；`sessionTitleOf` 额外为卡片补
  topic-set member 标题。**展示路径只读，不写宿主。**

## 3. 状态机

```text
provisional ──首条消息/主题──▶ named
     │                          │
     │ 宿主中性重置               │ 外部非中性改名
     ▼                          ▼
  (重写同一 desired)        user-locked ──reset──▶ named/provisional
     │
     └──写失败/冷会话──▶ deferred ──首次 live 事件──▶ named/provisional
```

| state | 含义 | 自动事件 | reset |
|---|---|---|---|
| `provisional` | 没有主题（`<工作区> · 新会话`） | 首条 user/message 可 final 一次 | 可回 provisional |
| `named` | 已有最终主题 | **no-op**（首个 final 生效，第二条消息不重命名） | 可重写同一 auto |
| `user-locked` | 人类拥有名字 | **no-op**，不覆盖 | 用 `autoTitle` 解锁恢复 |
| `deferred` | 意图已存、宿主未写（冷/失败） | 首次活动重试一次；成功后移出 pending | 同 named |

字段语义：

- `desiredTitle`：插件想要的**最终串**（已 ≤80 bytes）。手动改名后仍保留自动意图（不是人工名）。
- `autoTitle`：手动/外部 lock 时保存的自动标题；reset 的第一来源。旧行没有该字段时，
  reset 依次回落 `desiredTitle`（仅当它≠人工 `lastWrittenTitle`）→ 镜像 → member → `topic` 重算。
- `lastWrittenTitle`：宿主最后一次接受的串；用于区分「我们的写」与「外部改名」。
- `lockedReason`：`manual`（面板）、`external-rename`（宿主 GUI）。
- 外部非中性且 ≠ `lastWrittenTitle` → `user-locked`；宿主中性重置 → 可用**同一** desired 重写。
- 人工改名成功后：host=人工名、hub 镜像=人工名、state=user-locked、lastWritten=人工名、
  `autoTitle` 保留自动标题、`desiredTitle` 保持自动意图（恢复用）。

## 4. 80 UTF-8 bytes 策略

宿主硬上限 `maxTitleBytes = 80`，超长时**静默截断且不加省略号**，所以插件必须自己按字节裁剪：

- 组合规则：hub = `<工作区 label> · <主题>`；空主题 = `<工作区> · 新会话`；
  branch = 任务首行；topic-set root = `<集> · <任务>`（无任务则集名）。
- `clipTitleBytes(text, 80)`：按 **code point** 逐个累加 UTF-8 字节，保留工作区前缀，
  优先截主题；超出时去掉悬挂分隔符并追加 `…`（省略号也算在 80 内），绝不劈多字节字符。
- 手动输入用 `validateManualTitle`：空/超 80 bytes 明确报错，**不静默截断**；面板实时显示
  `{bytes} / 80` 并在超限时禁用保存。
- 宿主、`hub_sessions`、`dispatches.title`、`members[].title` 写**同一最终串**；
  迁移的 durable 清理也走同一裁剪。
- 旧的 60 **字符**预算（R43）已删除：它可能产出 180 bytes 的 durable 串，而宿主截成 80，
  两份就对不上。

## 5. 事件内零写入与 defer

- `defer.ts`：`deferTitleTask(task)` 先 `queueMicrotask`，让宿主发布栈先退栈；
  若仍命中重入错误，`retryReentrant` 用 `setTimeout(0)` 重试，最多 3 次。
- 所有来自 `session/event` 的写（observe、pending 重试、`finishPendingHubTitle`）都必须
  `defer: true`；gate 在真正写前登记 **pendingWrites claim**（title+时间）。
- observer 收到 `session/title` 时用 claim 判断「这是我们的写」还是「外部改名」；
  外部非中性 → `user-locked`，**不覆盖**人工名。
- gate 按 session 串行；失败写记 `attempts/lastError` 并返回 deferred，不假装成功。
- 架构测试（R59-9）扫描 `src/`：`sessionTitle.rename` / `session/title` append 只允许出现在
  `src/session-title/host.ts`；其余模块一律走 gate。

## 6. 迁移：`session-titles` marker v1

- 新 marker key `session-titles`（**不复用**已收敛的 R42 `hub-titles` v3）；字段：
  `sessionTitlesMigrationVersion/…At/Migrated/Adopted/Deferred/Skipped/Cleaned` +
  `ProcessedIds[]/PendingIds[]`（各 cap 500）。
- 首跑全量扫描 `hub_sessions`（≤300）；之后只扫 `pendingIds`。processed 不再重扫。
- 规则（逐 hub）：
  1. `user-locked` → 不动；
  2. 宿主非中性且非旧格式 → **收养**（desired/lastWritten/mirror = 宿主），不写宿主；
  3. 宿主中性/旧格式 + 镜像有主题 → policy 规范化（前缀一次、≤80 bytes），live 延迟 rename、
     cold 存 `deferred` + pending；
  4. 宿主中性 + 镜像无主题 → provisional `<工作区> · 新会话`；live 写、cold pending；
  5. 宿主标题不可读 → 跳过（不猜、不覆盖）；
  6. **绝不 resume 冷会话**。
- 收敛：marker 在 pending 非空时也写；仅当 version 达到且 pending 为空时 `already-done`。
  成功写后 `settleSessionTitlePendingId` 把 id 移出 pending；首次 `session/event` 也会重试
  `deferred` 行。
- 旧 R42 pending 钩子（`attachPendingHubTitleRename`）已**退役**（插件不再挂载），避免与新服务
  在同一冷会话首事件上双写；旧 `hub-titles` marker 只作为历史诊断保留。
- durable 清理：dispatch/member 旧标题去前缀、去描述并在首跑按 80 bytes 规范化。

## 7. 手动改名 / 恢复自动命名 / 修复

| 操作 | 入口 | 行为 |
|---|---|---|
| 重命名 | 面板左栏「⋯」、中枢页签当前卡、分支行 | 校验 ≤80 bytes；host+镜像（hub）+dispatch/member（分支）同串；state=user-locked；保留 autoTitle |
| 恢复自动命名 | user-locked 行 | 用 autoTitle（旧行回落镜像/member/topic）重写 host+镜像+durable；state=named；无 auto 明确报错不写 |
| 修复标题 | 中枢页签当前卡（中性宿主/deferred） | live → reconcile/gate 修复；cold → `needsOpen`，不 resume、不写 |

- `needsOpen` 是 remote `MutationResult` 的可选字段；cold 的重命名/reset 同样返回
  `session-not-live` 提示，不假成功。
- 分支重命名会重写该分支**全部** dispatch 行的 `title`（不改 `task`）与 member 标题；
  reset 同步恢复三处。
- continue/resume 不自动改名：`ensureMemberTitle` 保持成员首个稳定标题；dispatch 在继续
  派发时把新行的 `title` 对齐到该稳定串（`syncDispatchTitle`），避免最新行覆盖显示名。

## 8. 面板与 remote 契约

host `src/panel.ts` 声明、client `src/client/remote.ts`/`index.ts` 同步（E1 参数 parity 测试）：

| 方法 | 参数 | 结果 |
|---|---|---|
| `renameSessionTitle` | `cwd, sessionId, title` | `MutationResult`；超 80/空 → error；cold → needsOpen |
| `resetSessionTitle` | `cwd, sessionId` | 恢复 auto；`no-auto-title`/cold 明确报错 |
| `repairSessionTitle` | `cwd, sessionId` | live 修复；cold → `{status:'ok', needsOpen:true}` |

视图字段：`HubSessionView.titleState / autoTitleAvailable / titleRepairable`；
`HubBranchView.titleState / autoTitleAvailable`（host/client 同构）。
UI：重命名弹窗显示当前标题、UTF-8 计数、超长红色错误并禁用保存；reset 二次确认；
locales zh/en 的 `title.*`。

## 9. domain v2 与回滚

- R59 给存储域新增表 `session_titles`，domain version 1 → **2**，`compatibleVersions: [1]`。
  宿主 `dsh-storage-json` 实测按该字段接受旧介质；v1 介质打开后写首条记录时 stamp v2。
- `autoTitle` 是**同一 v2 内**新增字段（zod default ''），未再升版本：线上正在运行的实例仍是
  旧代码，新表尚未在线上创建；若存在未发布的 v2 行，读入后字段为空，reset 走镜像/主题回落。
- **回滚警告**：降级到 pre-R59 版本（只接受 version 1）会因介质已是 v2 而 `version-mismatch`，
  插件打不开存储。回滚前必须先备份/迁移介质，或保留 v2 兼容读取的版本。

## 10. 架构边界与测试防线

- 宿主 asar 只读：不改 dsh-session/dsh-session-title 源码；能力缺口（冷会话无法直接 rename）
  以 `needsOpen` + 首次 live 事件体现，不伪造。
- **不引入第二写入口**：任何新功能只能调用 `applySessionTitle` / `renameSession` /
  `resetAutoTitle`；host.ts 之外不得出现 `sessionTitle.rename` 或 `session/title` append。
- 迁移/对账/观察者都通过 gate，不允许各自调宿主。
- 机制测试 R59-1..22 覆盖状态机、defer、80 bytes、迁移、对账、展示、分支 durable、面板 remote、
  重载/continue、autoTitle；R59-9 是架构扫描；R59-13 校验左栏与管理台同源。

## 11. 验收与排障

### 11.1 重载后怎么确认

1. 重载插件（只能在中枢/GUI 侧做，分支会话内 reload 会自杀）。
2. 刷新 GUI；新建一个**不发言**的中枢会话：应显示「<工作区> · 新会话」。
3. 在同一会话发首条消息：应升级为「<工作区> · <主题>」，且只变一次。
4. 在面板/左栏看同一会话：名字一致；管理台（memory_ui 链接）同源。
5. 面板重命名 → 宿主侧栏同步；自动事件/重载不再覆盖；「恢复自动命名」写回 auto。

### 11.2 当前 3 个中枢（Phase 0 报告为 2 个；1b-1 快照实测 3 个）

只读副本（不写 `~/.dsh`）迁移 dry-run 结果：

| 会话 | 宿主 | 镜像（截断） | desired | bytes | 动作 |
|---|---|---|---|---|---|
| `session-mwuqyqdd-wfvw5w` | 新会话 | 10-SuperMemory · 宿主内置 / 未归属的 session_… | 10-SuperMemory · 宿主内置 / 未归属的session_的功能是做什么的… | 80 | 冷 → deferred+pending；live → rename |
| `session-mwuqyr57-pf6x14`（本次中枢） | 新会话 | 10-SuperMemory · 现在中枢会话又开始变成… | 10-SuperMemory · 现在中枢会话又开始变成“新会话”，而不… | 78 | live → rename；冷 → pending |
| `session-mwuqysn0-48ykb4` | 新会话 | 10-SuperMemory · 这个项目，我在插件-添加插件… | 10-SuperMemory · 这个项目，我在插件-添加插件上进行添加时… | 79 | 冷 → deferred+pending；live → rename |

live/cold 以运行期 `ctx.sessions.get` 为准；离线副本无法判断 attach 状态，按 cold 保守模拟。
若实际 live，启动迁移直接改名；否则 pending，在首次活动/下次启动/面板「修复标题」时完成。

### 11.3 常见问题

- **重载后仍是「新会话」**：确认插件版本含 R59、迁移 marker 是否已写（`meta['session-titles']`）、
  会话是否 live；冷会话请打开一次或点「修复标题」。
- **名字被人工改回**：`state=user-locked` 是预期；自动事件不覆盖。用「恢复自动命名」显式解锁。
- **面板按钮报「没有可恢复的自动标题」**：旧行既无 autoTitle 也无镜像/member/topic；
  直接重命名即可（服务不会凭空造名）。
- **超过 80 bytes**：宿主会静默截断；插件在输入/组合阶段已拦截，若绕过面板请用 gate/policy 校验。
- **回滚失败 version-mismatch**：见 §9，不要直接降级。

## 12. 文件地图

| 文件 | 职责 |
|---|---|
| `src/session-title/types.ts` | kind/state/intent/outcome/日志类型 |
| `policy.ts` | 唯一组合器 + 80 bytes + 中性/旧格式判定 + 人工校验 |
| `state.ts` | `session_titles` 唯一读写 + hub 镜像 + member 查询 |
| `host.ts` | 唯一宿主 rename/append/read；重入错误分类 |
| `defer.ts` | 出栈调度 + 重入重试 |
| `gate.ts` | 唯一写入口、状态机、claim、autoTitle 恢复 |
| `observe.ts` | session/event：首条消息 final、外部改名 lock、deferred 首次重试、面板首条消息 helper |
| `migrate.ts` | `session-titles` v1 迁移、pending 收敛、durable 清理 |
| `reconcile.ts` | 启动/首次活动对账 |
| `resolve.ts` | 展示回落（host→镜像→intent→member） |
| `member.ts` | durable member 标题（80 bytes） |
| `durable.ts` | dispatch/member 同步、continue 稳定标题 |
| `panel.ts` / `client/*` | remote 方法 + 重命名/恢复/修复 UI + locales |

## 附录 A. A–J 验收矩阵

> 自动化证据均为 `node scripts/mechanism-smoke.mjs`（141 checks）中的用例号；
> “人工”表示需要真实宿主 reload/重启或 GUI 操作，标注预期步骤。

| # | 场景 | 步骤 | 预期 | 自动化证据 | 需人工 |
|---|---|---|---|---|---|
| A | 新建中枢不发言 | 面板/侧栏新建空中枢 | 「<工作区> · 新会话」；host=镜像；state=provisional | R59-1、R59-10 | 是（GUI 新建） |
| B | shell 首条消息 | 空中枢在 shell 发首条 user 消息 | 发布栈内不写；出栈后升级为「<工作区> · <主题>」一次 | R59-2、R59-7 | 是（真实 shell 事件） |
| C | 面板首条消息 | 在面板聊天发首条消息 | 同一 gate 延迟写；首个主题生效，第二次 no-op | R59-20（finalize helper） | 是（真实面板发送） |
| D | 带 firstMessage 创建 | 面板 createHubSession 带首条消息 | 创建即 final；host=镜像；state=named | R59-10 | 是（GUI 创建带内容） |
| E | 重载 | 重载插件后 startup 对账 | named/deferred 对齐；locked 不动；不重复改名 | R59-21、R59-11/12 | 是（真实 reload） |
| F | 宿主重启/resume | 冷会话重启后首次活动 | deferred 行出栈重试；成功移出 pending；外部改名 lock | R59-15、R59-11 | 是（真实重启/打开会话） |
| G | 分支派发+continue | 派发新分支；再次 continue | host=dispatch=member 同串 ≤80B；continue 保持稳定标题不自动改名 | R59-14、R59-22、R59-18 | 是（真实派发） |
| H | 手动改名+恢复 | 面板/宿主 GUI 改名；再恢复 | locked；autoTitle 保留；reset 恢复 host+镜像+durable；>80 报错 | R59-16、R59-17、R59-18、R59-19 | 是（GUI 操作） |
| I | 旧标题迁移 | 旧「新会话/品牌前缀」pre-R59 中枢 | 收养非中性；中性+镜像→规范化；cold pending；marker 幂等 | R59-11 + 只读副本验证 | 是（reload 后核验） |
| J | 冷会话修复 | 对 cold 行点「修复标题」/首次活动 | 不 resume、不写，返回 needsOpen；打开后自动修复 | R59-18、R59-19、R59-15 | 是（打开冷会话） |

人工验收最小集：reload 后按 A→B/H→G→J 各做一次，并核对左栏/管理台/宿主侧栏三处名称一致。
