# R20 复核报告：分支问题上交 + 中枢统一提问

- 复核时间：2026-11-18 21:05（Asia/Shanghai）
- 工作区：`F:\10-SuperMemory`
- 代码基线：`HEAD 60f0f02`（R26「工作区隔离 / 能力持续维护 / 分支会话重启保留」）+ 工作树中未提交的 R27/R28 前端与能力收尾改动
- R20 实施提交：`897a023`（rounds-15-20，「分支问题上交」）
- 复核方式：只读阅读实现代码 + 复跑 typecheck / smoke / build + 检查运行中的插件与工具注册表 + 实调 `memory_questions`；**未修改任何代码，未 git commit**。
- 结论：R20 机制在源码与当前运行中的插件里都已生效；本次闸门全绿；上一轮观察到的 relay 截断根因（旧版 400 字 summary）已被后续 R21 的完整 `result` relay 修复。

---

## 0. 结论摘要

| 需求 | 实现 | 复核结论 |
|---|---|---|
| 分支完成实质工作并汇报；分歧按「最合理解释」直接执行 | 分支首条消息由 `buildDispatchScript` 写入约定 | ✅ 已落地 |
| 分支只能把问题结构化上交中枢，不能各自问用户 | `memory_raise_question` + 派发归属 + 分支提示词 | ✅ 已落地（提示词约束，未硬禁 `ask_user_question`，见 §h） |
| 中枢汇总**所有**分支（含仍在工作的）问题，一次 `ask_user_question` | `memory_questions` + `questionsForHub` + hub-role 提示词 | ✅ 已落地；本轮 live 实测可列出跨分支未决问题 |
| 并行组单次汇总、失败/中断标注 | `groupRelayText` + 组内问题合并 | ✅ 已落地；组内 `interrupted` 缺口已在后续轮修正 |
| relay 自动携带问题清单 | 单分支 relay / 组 relay / 启动对账回执三处追加 `[supermemory-questions]` | ✅ 已落地 |
| 旧数据兼容 | 独立 `questions` 表 + 域版本仍 v1 + 读取容错 | ✅ 已落地 |

---

## a) 改动文件清单（R20 相关）

R20 的实现集中在以下文件。`src/client/**` **没有** R20 改动（R20 是宿主侧能力 + 提示词 + 数据表）。

| 文件 | 新增/修改 | 一句话要点 |
|---|---|---|
| `src/questions.ts` | **新增** | questions 表的唯一读写入口：派发归属、raise、按 dispatch/group/branch 查询、中枢可见性、resolve、两种渲染器。 |
| `src/schema.ts` | 修改 | 在存储域 schema 中新增独立 `questions` 表（R20，约 :175-206），不改 `dispatches` 记录形状。 |
| `src/store.ts` | 修改 | domain spec 声明 `questions` 表（:131），`Store` 暴露 `questions` 访问器（:45-46 / :153）；域版本仍 `1`（:121）。 |
| `src/tools.ts` | 修改 | 注册 `memory_raise_question`（:776-829）与 `memory_questions`（:831-930）；`memory_dispatch` 描述补充问题闭环（:516-517）。 |
| `src/script-delegation.ts` | 修改 | `buildDispatchScript` 写入分支「提问约定（必须遵守）」与被派发工作的行为约定（:35-61）。 |
| `src/index.ts` | 修改 | `HUB_ROLE_TEXT`（:267 起）增加中枢汇总问题的规则；`supermemory:hub-role` section（:469，order 901）按真中枢注入。 |
| `src/group.ts` | 修改 | 并行组唯一 relay 在「汇总」行后合并**全部成员**的未决问题（`groupRelayText`，:44-73）；后续轮补上 `interrupted` 终态（:23-41）。 |
| `src/observe.ts` | 修改 | 单分支 relay（`relayText`，:177）在成功/失败/中断三种终态后追加问题块；调用点 :313 / :328 / :541。 |
| `src/reconcile.ts` | 修改 | 启动对账的失败回执携带问题块（:61）；重启恢复的重新派发消息补提问约定（:156）。 |
| `src/panel.ts` | 修改 | 面板「用户回复 → 分支」通道同步「需裁决走上交，不要直接问用户」（:1086）。 |
| `scripts/mechanism-smoke.mjs` | 修改 | 新增 R20-1（分支脚本约定）与 R20-2（结构化问题全链路），:1262-1336。 |
| `DEV-NOTES.md` | 修改 | 第 20 节记录需求、数据层、工具、提示词、relay、闸门与遗留（:1107 起）。 |
| `src/relay-text.ts` | 后续轮新增（非 R20 主体） | R21 的 relay 完整结果修复：`episodeResult` / `clipRelayResult` / `RELAY_RESULT_MAX_CHARS = 65536`，直接解决旧 relay 截断。 |

> 说明：R20 的实现提交之后，R21–R26 还改过 `schema.ts / store.ts / tools.ts / index.ts / observe.ts / reconcile.ts / panel.ts`（新增 `meta` 表、`result` 字段、续跑、工作区隔离等），但 R20 的数据表、两个工具、提示词和 relay 合并逻辑仍保持可用；`src/questions.ts` 与 `src/script-delegation.ts` 自 R20 提交后未再改动。

---

## b) 新增/修改工具名与完整参数 schema

### b.1 `memory_raise_question`（仅分支使用）

**描述文案原文**（`src/tools.ts:777-781`）：

> 【仅分支会话使用】把需要用户裁决的问题结构化上交中枢，由中枢汇总所有分支的问题后统一向用户提问。分支不要直接向用户提问、也不要因为提问而卡住不干活：非阻塞问题（blocking=false，默认）上交后继续按最合理解释推进并完成实质工作，把做出的假设写进最终汇报；只有真正阻断、非用户裁决无法继续时才 blocking=true，并同时给出 progress（已完成进度）与 defaultPlan（默认备选方案）。中枢不要调用本工具——中枢需要用户裁决时直接用 ask_user_question。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `title` | string | 是 | — | 问题标题（≤80 字）：一句可扫读的话 |
| `question` | string | 是 | — | 要用户裁决的具体问题（写清背景与取舍） |
| `options` | string[] | 否 | `[]` | 给用户的候选答案（每个一句） |
| `severity` | `low \| medium \| high` | 否 | `medium` | 严重度 |
| `blocking` | boolean | 否 | `false` | true=非用户裁决无法继续（应同时给 progress 与 defaultPlan） |
| `progress` | string | 否 | `''` | 已完成的进度（阻塞时按约定必填） |
| `defaultPlan` | string | 否 | `''` | 用户不裁决时分支将采用的默认备选方案 |

**输出 schema**：`{ status: 'recorded'|'error' (required), questionId?, dispatchId?, blocking?, message (required) }`；`render` 只输出 `message`。

**行为要点**：

- `active dispatch` 通过 `dispatchOfBranch` 解析（优先未终态、其次最新；无派发=非分支），不从会话 metadata 推断。
- 写入 `dispatchId / groupId / topicSetId / branchSessionId / hubSessionId / branchTask` 与问题字段；`title` 截 80、`question` 截 2000、`options` 最多 8×120、`progress` 截 1500、`defaultPlan` 截 1000。
- `blocking` 默认 false；非阻塞回执明确要求「继续推进并完成实质工作」；阻塞回执要求结束本轮并写清进度/默认备选。
- 没有派发记录（中枢误调）→ 返回 `error`，不落库。
- 存储域未打开/表不可用 → 返回 `error`，提示把问题写进最终汇报。

### b.2 `memory_questions`（仅中枢汇总使用）

**描述文案原文**（`src/tools.ts:832-835`）：

> 【中枢汇总用】列出 / 结清分支通过 memory_raise_question 上交的问题：含来源分支、是否阻塞、已完成进度与默认备选方案。收到 relay 或用户新消息时先调用本工具，把各分支的问题去重、按主题合并成一份清单，再用 ask_user_question 一次向用户提问；非阻塞问题且分支已按最合理解释完成时不必提问，在汇报里列出假设即可。用户答复后用 resolve 传入问题 id 结清（可带 answer），再用 memory_dispatch 把裁决派回对应分支。

**参数 schema**：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `status` | `open \| resolved \| all` | 否 | `open` | 要列出的话题状态 |
| `resolve` | string[] | 否 | `[]` | 已向用户提问/已裁决的问题 id，传入即标记 resolved |
| `answer` | string | 否 | — | 用户答复原文，随 resolve 一起记录 |

**输出 schema**：

```
status: 'listed'|'resolved'|'error' (required)
items: Array<{
  id (required), dispatchId?, topicSetId?, branchSessionId (required),
  branchTask?, title (required), question (required), options?,
  severity?, blocking (required), progress?, defaultPlan?,
  status (required), createdAt?
}> (required)
total: integer (required)
blocking: integer (required)
resolved?: integer
message: string (required)
```

**行为要点**：

- `questionsForHub(store, workspaceKey, hubSessionId, status)` 只返回**本工作区话题集**的问题，另以「本中枢自己派发的」兜底；跨工作区不可见。
- `resolve` 只结清「本中枢当前可见且状态为 open」的 id，防止跨工作区/越权篡改；`answer` 非空才写入。
- 列表行带来源分支、分支任务、阻塞/非阻塞、进度、默认备选、非 medium 的严重度；末尾固定提示「去重合并后一次 `ask_user_question`，答复后派回」。
- 空列表返回「（当前工作区没有待处理的已上交问题）」。

### b.3 `memory_dispatch` 描述补充

`src/tools.ts:516-517` 在原有派发描述末尾追加：

> 分支遇到需要用户裁决的问题会用 memory_raise_question 上交中枢（永不直接问用户）；收到 relay 或用户新消息时用 memory_questions 汇总所有分支的问题，再用 ask_user_question 一次提问。

---

## c) 提示词注入的文件与关键句原文

### c.1 分支侧：`src/script-delegation.ts#buildDispatchScript`

分支首条消息的唯一来源（`dispatch.ts` 的新建/复用/fork 路径都走它），关键原文（`src/script-delegation.ts:35-61`）：

```
你是该话题集的一个工作分支：完成实质工作并汇报结果。
遇到分歧按「最合理解释」直接执行，不要停下来等用户确认；把做出的假设写进最终汇报。

提问约定（必须遵守）：
- 需要用户裁决时，调用 memory_raise_question 把问题结构化上交中枢（title/question 必填，可选 options/severity/blocking/progress/defaultPlan），由中枢汇总所有分支的问题后统一向用户提问。
- 不要在本分支对话里直接向用户提问，也不要因为提问而卡住不干活：非阻塞问题（blocking=false）上交后继续按最合理解释推进并完成实质工作。
- 只有真正阻断、非用户裁决无法继续时才 blocking=true，并同时写清已完成的进度（progress）与默认备选方案（defaultPlan）。
```

同时首条消息仍带「本轮能力边界：…；越界请汇报而不是硬做」，能力档位约定没有因 R20 改变。

### c.2 中枢侧：`src/index.ts` 的 `supermemory:hub-role`

只在**真中枢**注入（`isHubSession` 为真），分支/子代理/普通话题集会话拿到空字符串。section 注册：`src/index.ts:469`（`name: 'supermemory:hub-role'`，`order: 901`）。R20 关键句（`src/index.ts:293-296`）：

```
- 分支不会直接问用户：它们的疑问通过 memory_raise_question 上交到你。收到 relay 或用户新消息时，先调用 memory_questions 查看所有未解决问题（含仍在工作的分支）。
- 汇总问题：去重、按主题合并成一份清单，标注来源分支 / 是否阻塞 / 已完成进度 / 默认备选方案，然后用 ask_user_question **一次**向用户提问；不要逐个转发。
- 用户答复后用 memory_questions 的 resolve 结清（可带 answer），再把裁决用 memory_dispatch 派回对应分支。
- 分支已按最合理解释完成、问题不阻塞时不必提问：在汇报里列出它做的假设即可。
```

R24 之后同一 `HUB_ROLE_TEXT` 还增加了「回执后结束本轮、不要 wait_agent」规则（`src/index.ts:287-290`），与本报告的问题汇总规则并列。

### c.3 其他提示通道

- `src/reconcile.ts:156`：重启恢复的重新派发消息追加「遇到分歧按最合理解释执行；需要用户裁决时用 memory_raise_question 上交中枢，不要直接向用户提问。」
- `src/panel.ts:1086`：面板内「用户回复 → 分支」消息追加同一约定，避免面板通道丢约束。
- 未硬性 deny `ask_user_question`（见 §h）。

---

## d) 并行组如何合并各分支问题；relay 是否携带问题清单

### d.1 合并函数与行为

| 步骤 | 位置 | 行为 |
|---|---|---|
| 组内派发 | `src/dispatch.ts`（`runDispatch` 的 `tasks[]` 分支） | 每个任务独立分支、共享 `groupId`；`raiseQuestion` 把 `dispatch.groupId` 复制到问题行。 |
| 读组内问题 | `src/questions.ts:81` `openQuestionsOfGroup(store, groupId)` | 过滤 `status==='open' && groupId===groupId`，按 `createdAt` 升序。 |
| 生成问题块 | `src/questions.ts:270` `renderQuestionsBlock` | 输出 `[supermemory-questions]` 标题、总数、阻塞/非阻塞数；每条含标题、问题、可选答案、已完成进度、默认备选；末尾提示中枢用 `memory_questions` 汇总并一次 `ask_user_question`。空数组返回 `''`（旧 relay 逐字节不变）。 |
| 组 relay 合并 | `src/group.ts:44` `groupRelayText` | 先输出成员逐行结果（✅ / ❌ / ⏹ 中断）和「汇总：N 成功 / N 失败 / N 中断」；若组内有 open 问题，在末尾追加**一个**问题块（不是每个成员一个 relay）。 |
| 组终态判定 | `src/group.ts:37` `groupComplete` | 每个成员都到达 `delivered / failed / interrupted` 才发唯一组 relay；`interrupted` 是后续轮补上的真实缺陷修复（见 §h）。 |
| 单分支 relay | `src/observe.ts:177` `relayText` | 成功、失败、超时/中断三种终态都追加问题块；失败时还带「已完成部分」与续跑提示。 |
| 启动对账 | `src/reconcile.ts:61` | 失败回执 payload 追加该派发的 open 问题块。 |

### d.2 relay 是否携带问题清单

**是。** 三条 relay 路径都携带：

1. 单分支：`[supermemory-relay <branch>]` 的 `分支结果` / `结果：分支未成功完成…` 之后追加 `[supermemory-questions]` 块；
2. 并行组：唯一 `[supermemory-group-relay <groupId>]` 的「汇总」行后追加全组成员问题块；
3. 启动对账的失败/中断回执：同样追加。

问题块为空时不追加，因此没有问题时 relay 文本与旧版一致。中枢侧的 `memory_questions` 是独立通道，能看到**仍在工作**的分支问题（relay 要等终态才带）。

### d.3 relay 长度/截断（与上一轮观察直接相关）

- 旧版 `buildEpisode` 把 `summary` 截到 400 字，并让 relay 直接使用 `summary`——这解释了此前 relay「只到 1-2 段」的现象（`src/observe.ts:129/157` 仍保留 400 字 summary，供 recall/导出等短卡片使用）。
- 当前 relay 已改为使用 episode 的完整 `result`：`episodeResult` 取 `result`，旧记录回退 `summary`；`clipRelayResult` 只在超过 `RELAY_RESULT_MAX_CHARS=65536` 时截断并明确标注（`src/relay-text.ts:19-34`）；单分支、失败、组 relay 均已改用该 helper（`src/observe.ts:184-196`、`src/group.ts:82-84`）。
- 因此当前实现不会再出现 400 字级截断；R20 的问题块追加在结果之后，也不受 summary 截断影响。

---

## e) 数据表 / 兼容性

### e.1 `questions` 表结构

`src/schema.ts:175-206`：

| 字段 | 类型 | 默认/必填 | 说明 |
|---|---|---|---|
| `dispatchId` | string? | 可选 | 归属派发（从 `dispatchOfBranch` 来） |
| `groupId` | string? | 可选 | 并行组 id（从派发复制） |
| `topicSetId` | string? | 可选 | 话题集（中枢可见性主键之一） |
| `branchSessionId` | string | 必填 | 提问分支 |
| `hubSessionId` | string? | 可选 | 派发中枢（可见性兜底） |
| `branchTask` | string | `''` | 派发任务标签（清单可读，无需 join） |
| `title` | string | 必填 | 问题标题 |
| `question` | string | 必填 | 问题正文 |
| `options` | string[] | `[]` | 候选答案 |
| `severity` | `low\|medium\|high` | `medium` | 严重度 |
| `blocking` | boolean | `false` | 是否阻塞 |
| `progress` | string | `''` | 已完成进度 |
| `defaultPlan` | string | `''` | 默认备选 |
| `status` | `open\|resolved` | `open` | 生命周期 |
| `answer` | string? | 可选 | 用户答复（resolve 时写） |
| `createdAt` / `updatedAt` | integer | 必填 | 时间戳 |

### e.2 兼容策略

1. **独立表**：questions 不挂在 `dispatches` 记录上，派发的状态机/游标逻辑完全不动，一个分支可提多个问题。
2. **域版本仍为 1**（`src/store.ts:121`）：新表随 spec 声明打开；旧 medium 没有该表 = 空表，读时按 `KvTable` 语义得到空映射，不要求迁移或重写旧记录。
3. **读取容错**：`questionsOf()` / `questionsSupported()` 对「没有 questions 表」的旧测试替身或未打开存储返回空/不支持，不抛异常（`src/questions.ts:39-47`）。
4. **字段默认值**：除身份字段（`branchSessionId / title / question / createdAt / updatedAt`）外全部 zod 默认值补齐；旧行不会因新字段缺失而读取失败。
5. **可见性收敛**：`questionsForHub` 以「工作区话题集 + 本中枢兜底」过滤；`resolve` 又只允许结清当前可见的 open 行，避免跨工作区篡改。

---

## f) 自验（2026-11-18 21:0x，当前工作树）

> 当前工作树包含 R27/R28 的未提交前端/能力改动；以下数字是**当前树**实测，不是 R20 提交当时的数字。

### f.1 typecheck

| 命令 | 结果 |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | exit 0，**0 错** |
| `npx tsc -p tsconfig.client.json --noEmit` | exit 0，**0 错** |

### f.2 测试

| 命令 | 结果 |
|---|---|
| `node scripts/core-smoke.mjs` | **9 checks passed** |
| `node scripts/mechanism-smoke.mjs` | **89 checks passed**（含 R20-1、R20-2；R21-1/R21-2 relay 修复；R19/R24/R25/R26 等） |
| `node scripts/webui-smoke.mjs` | **32 checks passed**；log lines 27 |
| `node scripts/client-sim-smoke.mjs` | **SIM SMOKE OK**；4 个注册点（sidebar.panellist / main / shell.overlay / sidebar.session.row.leading） |
| `node scripts/capability-smoke.mjs` | **11 checks passed**（当前树 R27/R28 能力改动） |
| `node scripts/workspace-scope-smoke.mjs` | **6 checks passed**（R26 工作区隔离） |
| `pnpm smoke`（六套全跑） | exit 0，全绿 |

R20 对应断言：

- R20-1：分支脚本包含 `memory_raise_question`、`最合理解释`、`blocking=true`、`不要在本分支对话里直接向用户提问`；
- R20-2：派发归属、blocking 默认 false、非分支拒绝、中枢可见、组 relay 合并、resolve 记录答复（`scripts/mechanism-smoke.mjs:1262-1336`）。

### f.3 build

命令：`pnpm build`（`tsdown` + client `tsdown` + `wrap-client`），exit 0。

| 产物 | 结果 |
|---|---|
| 宿主文件数 | **9 个文件**（`lib/supermemory.js` + 8 个 chunk） |
| 宿主总大小 | **511.77 kB**（entry `lib/supermemory.js` **364.66 kB**，gzip 98.77 kB） |
| client | `lib/client.js` **109.66 kB**（gzip 26.80 kB）；`wrap-client` 后 **107400 字符**；磁盘 UTF-8 **109875 字节** |
| 构建警告 | 3 条 `INEFFECTIVE_DYNAMIC_IMPORT`（toolize/panel/webui），非新增、不影响 exit 0 |
| 入口加载 | `import('./lib/supermemory.js')` 实测成功：`apply` 为 function，`inject` 9 项 |
| 产物关键串 | `memory_raise_question` 12 处、`memory_questions` 8 处（entry/group/store）；`supermemory-questions` 1 处（`lib/group-NnrDGVCL.js`，questions 逻辑并入共享组 chunk） |

构建前后 `lib/supermemory.js` 与 `lib/client.js` 的 SHA-256 **完全一致**（`e1b11b6a…` / `1142003a…`），说明本次构建没有造成新的 chunk 哈希漂移。

---

## g) 插件状态

| 检查项 | 结果 |
|---|---|
| `include:supermemory` 是否启用 | **是**：`enabled: true`、`fiberPhase: active`、`patchId: supermemory`、moduleName `dsh-supermemory` |
| 安装路径 | profile 依赖为 `dsh-supermemory: link:F:/10-SuperMemory`，profile `node_modules/dsh-supermemory` 指向本仓库；运行中的代码就是本工作树 |
| lib 是否包含新工具 | **是**：entry 含 `memory_raise_question` / `memory_questions`，`supermemory-questions` 在组 chunk |
| live 工具注册表 | **是**：`cordis_inspect_query host/Tool/listTools` 返回的可调用工具含 `memory_questions`、`memory_raise_question`（以及 `memory_resume`） |
| live 实调 | **成功**：本轮调用 `memory_questions(status=open)` 返回当前工作区 2 条待处理问题（均非阻塞），说明工具已真正注册并可执行，不只是 schema 可见 |
| 重载（禁用→启用） | 当前实例**已包含 R20 代码**（live 工具表 + 实调可证），说明此前重载已生效。**本轮复核分支没有再次执行禁用→启用**：分支会话内重载会终止自身（并可能触发中断结算），按既有约定交由中枢/GUI 执行；且本次构建前后入口/客户端哈希未变，不存在必须重载的代码漂移 |
| 用户是否需要刷新 | **R20 本身不强制刷新**（全部是宿主侧工具/提示词/数据表，没有客户端 UI 改动）。但当前工作树含 R27/R28 的客户端与管理台未提交改动，且插件已经重载过；若用户希望 GUI 显示这些最新前端修复，刷新一次 `http://127.0.0.1:62590` 即可。管理台 URL 每次重载会变，需要新链接时用 `memory_ui` 令牌 URL |

---

## h) 已知遗留与风险（含前两分支未覆盖的缺口）

1. **relay 截断的根因与现状**
   - 旧实现：`buildEpisode` 把 `summary` 截到 400 字，relay 用 `summary`；这就是此前「relay 只到 1-2 段」的原因，不是传输层截断。
   - 现状：R21 新增 `Episode.result` 保存完整最终文本，`relayText`/`groupRelayText` 改用 `episodeResult` + `clipRelayResult`（上限 65536 字，超限才截断并明确标注）。所以当前机制**不会再 400 字截断**；早期旧 episode 没有 `result`，仍回退到短 `summary`，属可接受的历史数据降级。
   - 对本轮任务的影响：报告落盘 + 极短 relay 仍是正确交付方式，但机制本身已不受旧截断影响。

2. **`blocking=true` 的 progress/defaultPlan 没有硬校验**
   - 工具描述与分支提示词都写「阻塞时应同时给 progress 与 defaultPlan」，但 `raiseQuestion` 只做 trim/clip，没有在 `blocking=true` 时拒绝缺失字段。
   - 影响：极端情况下中枢拿到一条没有进度/备选的阻塞问题，信息不完整；不破坏链路。建议后续在 `raiseQuestion` 里补一行校验（最小修复），本轮未改以保持「只复核」。

3. **未硬性 deny `ask_user_question`**
   - read/read-write/full 的能力档位没有把 `ask_user_question` 加入 deny；约束完全依赖分支提示词 + 中枢提示词。
   - 风险：分支模型无视提示词直接向用户提问时，机制不会在工具层拦截；只能靠中枢提示词纠偏。若要硬约束，需要改档位语义（会改变 `full` 与中枢一致性的约定），属于策略决策，不建议在复核中顺手改。

4. **问题清单未进入面板/管理台列表**
   - 数据已落库、`memory_questions` 可见、relay 携带；但面板派发卡片/管理台没有 questions 计数或独立列表（R20 需求标注为可选低优先，未做）。
   - 影响：用户/中枢只能通过工具或 relay 看到，无法在 UI 里浏览历史问题。

5. **去重/合并是提示词驱动，不是程序自动去重**
   - 多个分支提同一主题时，`memory_questions` 会全部列出；中枢需按提示词「去重、按主题合并」。若中枢忘记 `resolve`，同一问题会在后续 relay/清单中重复出现。
   - 这是有意的软约束（保留语义判断），不是 bug，但需要中枢遵守。

6. **问题可见性按「工作区话题集 + 本中枢」收敛**
   - 跨工作区不可见（安全）；没有 `topicSetId` 的孤儿派发只能靠 `hubSessionId` 兜底（派发总会解析出话题集，属理论兜底）。
   - 一个话题集的多个中枢之间，问题按话题集共享可见；这与「分支归属话题集、可跨中枢共享」的 R19 语义一致。

7. **组内 `interrupted` 缺口已在后续轮修复**
   - R20 复核时曾发现：`groupComplete` 只认 `delivered/failed`，成员 `interrupted` 会让整组 relay 永远不发，组内问题随之只能靠 `memory_questions` 看到。
   - 当前 `src/group.ts:23-41` 已把 `interrupted` 纳入终态，`groupRelayText` 用「⏹ 中断终态」单独标注；这是后续轮补上的真实修复，R20 报告确认其有效。

8. **schema 版本仍为 1，新表依赖 storage-domain 的「按 spec 开表」行为**
   - 旧 medium 打开新插件会得到空 questions 表；已验证读取路径容错。若未来需要真正的数据迁移/回滚，应显式升域版本，不能继续靠隐式空表。
9. **R20 测试是纯函数/替身级，不是宿主端到端**
   - R20-1/R20-2 覆盖脚本文本、派发归属、组 relay 合并、resolve；没有在真实宿主里走一遍「分支调工具 → relay → 中枢调用」。
   - 本次用 live `memory_questions` 实调补了「工具已注册且可执行」的证据；完整端到端仍建议在真实 GUI 里人工抽查一次。
10. **旧 relay 文本的历史截断不可回溯**
    - R21 修复只影响新 episode；此前已落库的旧 relay/摘要仍是 400 字版本，不会自动补全。需要完整历史时只能回读分支会话日志。
11. **`memory_questions` 的中枢判定依赖调用方会话身份**
    - 工具本身不强制「只允许中枢」；分支若误调会列出本工作区问题（只读），`resolve` 也只会结清可见 id。实际约束靠提示词与使用约定，破坏性有限，但不是硬隔离。
12. **与 R20 无关但影响本次数字的并行改动**
    - 当前工作树有 R27/R28 未提交改动（前端、能力执行环境、git-sync 等）。本报告所有测试/构建数字是「HEAD + 未提交改动」的当前树结果；R20 逻辑本身在 `897a023` 已提交，且 `questions.ts`/`script-delegation.ts` 自该提交后未再修改。

---

## 附：关键证据行号

| 主题 | 位置 |
|---|---|
| questions 唯一入口 | `src/questions.ts:55`（dispatchOfBranch）、`:175`（raiseQuestion）、`:233`（resolveQuestions）、`:270`（renderQuestionsBlock）、`:283`（renderQuestionList） |
| questions 表 | `src/schema.ts:175-206`；`src/store.ts:131` / `:153`；域版本 `src/store.ts:121` |
| 分支工具 | `src/tools.ts:776-829` |
| 中枢工具 | `src/tools.ts:831-930` |
| 分支提示词 | `src/script-delegation.ts:35-61` |
| 中枢提示词 | `src/index.ts:267` 起；section `src/index.ts:469`（order 901） |
| 并行组问题合并 | `src/group.ts:44-73`；终态 `:23-41` |
| 单分支 relay | `src/observe.ts:177-196`；调用点 `:313` / `:328` / `:541` |
| relay 完整结果修复 | `src/relay-text.ts:19-34`；`src/observe.ts:184-196` |
| 启动对账 | `src/reconcile.ts:57-64`、`:156` |
| 面板回复约定 | `src/panel.ts:1086` |
| R20 测试 | `scripts/mechanism-smoke.mjs:1262-1336` |
| R21 relay 测试 | `scripts/mechanism-smoke.mjs:1510-1526` |
| R20 开发记录 | `DEV-NOTES.md:1107` 起 |
