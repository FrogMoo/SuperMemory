# 工作区隔离 + UI 收尾 + 集成验证 · 2026-11-18

> 集成分支（前两个分支：重启保留分支会话、固化能力持续维护，均已交付）。
> 三门闸全绿：pnpm typecheck 0 错；pnpm smoke 全链（core 9 / mechanism 89 / webui 32 /
> client-sim / capability 9 / workspace-scope 6）；pnpm build 全管线成功。未提交 git。

## A. 工作区隔离（用户诉求③）

### A1 根因（审计结论）

话题集/会话侧的列举路径本来就按 workspaceKey 过滤（panel listTopicSets/hubState、
webui buildState、hub-sessions listHubSessions、hub-branches listWorkspaceBranches、
/memory 命令族、memory_topicsets）。真正漏的是三处：

1. **能力完全不隔离**：面板 Tools tab（panel.listTools() 无 cwd 参数）、memory_toolize
   list（capabilityRecordsOf(store) 全量）、rebuildComposites（把所有工作区的能力都注册
   成模型可见工具）、capabilityHealthOf（全量）——没有任何工作区判定。
2. **面板计数串味**：hubState 的 episodes（store.episodes.size 全量）、dispatches、tools
   三个计数跨工作区累计，概览数字对不上本工作区。
3. **切换工作区后视图不跟随**：面板 cwd 解析是 workspacePath（localStorage 记忆）优先于
   主视图会话 cwd——用户在 shell 里切换到另一工作区的会话，面板仍停留在旧工作区数据；
   且 changeWorkspace 不清空 tools 状态，工具列表停留在旧工作区。

### A2 能力隔离设计（为什么这样做）

插件进程同时服务多个工作区（shell 可同时打开不同工作区的会话），宿主工具注册表是进程
全局的——启动时静态「只注册当前工作区」没有意义（没有单一当前工作区）。因此采用
「列表过滤 + 运行门禁」：

- **判定单一来源** composite.capabilityAppliesToWorkspace(spec, callerWorkspace, rowWorkspaceKey)：
  行级归属（tool_memory.workspaceKey）优先；无行级归属用 spec.scope 推导；两者都没有=
  全局能力（旧数据/无 scope 注册），任何工作区适用。
- **列表全部按调用方工作区过滤**：面板 listTools(cwd)、memory_toolize list/refreshBuiltin、
  capabilityHealthOf(store, ws)、面板 hubState 的 tools 计数；管理台 buildState 原本就按 ws
  过滤（保持不变）。跨工作区能力不显示；refresh-builtin  additionally 报告「另有 N 个能力
  属于其他工作区，本工作区不暴露」。
- **执行门禁**：能力工具 execute 时按调用方会话 cwd 判定，跨工作区调用直接返回 failed
  （summary 说明适用于哪个工作区），不执行、不计数；取不到调用方 cwd（测试/headless）放行。
- **rebuild 带行级归属**：rebuildComposites 把 record.workspaceKey 传给 registerComposite →
  capabilityToolDef，重启后门禁依然生效；editCompositeTool/mergeBuiltinCapabilities 的
  重注册同样带归属。
- **register 同名分流**：传入 workspaceKey 时，同名行的原地更新只匹配本工作区的行；别的
  工作区的同名能力各占一行、互不覆盖（工具名在宿主注册表仍全局唯一，跨工作区同名注册会
  被「已被占用」拒绝——已知边界，见遗留风险）。
- **切换跟随**：面板新增「主视图会话换到另一个工作区时跟随切换」（用户显式选择过的优先，
  直到再次发生切换）；changeWorkspace 清空 tools，refreshTools 依赖 cwd，切工作区即重拉。

### A3 改动文件（A 部分）

| 文件 | 改动 |
|---|---|
| src/composite.ts | capabilityAppliesToWorkspace（单一判定）+ callerWorkspaceKey；capabilityToolDef(store, spec, workspaceKey?) execute 门禁；registerComposite(..., workspaceKey?)；rebuildComposites/editCompositeTool/mergeBuiltinCapabilities 传行级归属；capabilityRecordsOf/capabilityHealthOf 加可选工作区过滤；registerCapability 同名查找按工作区分流；BuiltinMergeReport.changed 带 workspaceKey |
| src/panel.ts | listTools(cwd?) 按工作区过滤 + 透出 version/usage；hubState 的 episodes/dispatches/tools 计数按工作区隔离；toolApplies 私有判定；listTools RPC 描述符加 cwd 参数；runTool 的 bump 传 result |
| src/tools.ts | memory_toolize list 按会话工作区过滤并透出 version/lastStatus；refreshBuiltin 按工作区过滤 + otherWorkspace 计数；输出 schema 补 version/lastStatus/otherWorkspace |
| src/client/panel-page.tsx | PanelApi.listTools(cwd)；refreshTools 依赖 cwd；changeWorkspace 清空 tools；跟随 shell 工作区切换；ToolView/branches 补 task/version/usage 字段与渲染 |
| src/client/index.ts | listTools 透传 cwd |

## B. UI 收尾（两个已交付分支留下的小改动）

1. **bump 第三参 result**：src/panel.ts runTool、src/webui.ts /tool/run 现在传 result，
   面板/管理台执行能力也记成败明细/最近一次结果（此前只有模型直调才记）。
2. **执行后刷新**：src/web/app.js 的 cap-run / cap-run-do / tool-status / tool-del 成功后
   调 loadState()——修掉「执行后使用次数不刷新」（根因：只 render 不重拉，渲染的是页面
   加载时的 state.data 快照）。
3. **分支任务摘要**：面板话题集成员卡片与管理台 hub 分支卡片渲染 branches[].task
   （panel.ts view() 早已备好数据，客户端此前不显示）。
4. **能力版本与使用明细**：ToolView 透出 spec.version/spec.usage；面板能力卡片显示
   「版本 vN · 最近执行 成功/失败（预演）· 成功 X/失败 Y · 连续失败 N」；管理台能力卡片
   显示 vN 徽标与「最近执行」行（连续失败 ≥2 出 warn 徽标）。

## C. 集成验证（集成分支执行）

- pnpm typecheck（host + client 双 tsconfig）：**0 错**。
- pnpm smoke 全链：core 9 / mechanism 89 / webui 32 / client-sim OK / capability 9 /
  **workspace-scope 6（新增）**。
- pnpm build 全管线（tsdown host + client + wrap-client）：**成功**（前两分支按并发禁令
  均未构建；本分支首次构建即通过，无需修复）。
- 新增 scripts/workspace-scope-smoke.mjs 并登记进 package.json 的 smoke 链，覆盖：
  W1 话题集/分支/计数按工作区过滤；W2 跨工作区能力不暴露（recordsOf/面板 listTools/health）；
  W3 执行门禁（跨工作区拒绝且不计数/本工作区正常/无上下文放行）；W4 register 同名按工作区
  分流；W5 rebuild 带行级归属 + 内置播种落 scope 工作区且幂等；W6 适用性判定纯函数语义。

## D. 遗留风险

1. **跨工作区同名能力的注册冲突**：能力工具名在宿主注册表全局唯一——B 工作区注册一个 A
   已 live 的同名能力会被「已被占用」拒绝（应换个逻辑名，或先在 A 停用/删除）。
2. **全局能力**：无 workspaceKey 且无 scope 的旧能力行仍是全局可见/可执行（兼容取舍，
   健康报告的零使用/文档缺失信号会促使补上 scope）。
3. **面板 runTool/editTool/deleteTool 的 RPC 未带 cwd**：面板工具列表已按工作区过滤，
   界面上点不到别的工作区的行；若要对直接 RPC 也做校验，需给这三个描述符加 cwd 参数
   （与管理台 tool/run|status|delete 的 ws 校验对齐）。
4. **内置 scope 是绝对路径**：换机器/克隆目录后 git-sync 能力失效（健康报告报 scopeMissing）。
5. **面板工作区跟随策略**：主视图会话切换到别的工作区时面板跟随；用户显式选择过的
   workspace 在再次发生切换前保持优先（切换一次后回到原工作区会话不会自动跳回）。

## E. 生效说明（需要用户操作）

以上改动都在插件源码里，**需在 GUI 插件页禁用→启用重载插件（或重启 DSH Desktop）后生效**。
重载后分别应看到：

1. 面板话题集/中枢会话/记忆只属于当前工作区；切到另一工作区（shell 主视图切换或面板
   选择器）后列表随之更新，不再停留旧工作区数据；
2. 面板「工具」页签与管理台「固化能力」只列当前工作区适用的能力，版本号与最近执行状态
   （成功/失败/预演/连续失败）可见；
3. 模型在 A 工作区调用 B 工作区的能力会被明确拒绝（提示适用于哪个工作区），不再误跑；
4. memory_toolize list 只列本工作区能力；refresh-builtin 额外报告「另有 N 个能力属于
   其他工作区」；
5. 管理台执行能力（预演/确认执行/停用/删除）后，使用次数与状态即时刷新；
6. 分支卡片带最新一次派发的任务摘要。
