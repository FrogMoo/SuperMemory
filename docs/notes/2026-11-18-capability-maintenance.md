# 固化能力（capability）持续维护 · 2026-11-18

> 对应改动：使用计数修复 + 能力内置（随插件分发）+ 持续维护机制（register 同名更新 /
> refresh-builtin / 健康报告 / 路由规则）。分支任务，未提交；并行组集成分支负责最终构建。

## 1. 使用计数不涨的根因（带证据）

**根因不是「执行路径不计数」——三条执行路径都调了 bumpCompositeUse，store 里的计数确实在涨。**
实测证据：执行一次 git 同步能力后，~/.dsh/storages/supermemory.json 中该能力行
（tm-mwlmfjcj-x46lvf）的 useCount 已经是 **1**。用户看到「没有变化」来自两件事：

1. **管理台执行后不刷新状态**：src/web/app.js 的 cap-run / cap-run-do 处理器在
   POST /tool/run 成功后只调用 render()（渲染的是页面加载时的 state.data 快照），
   没有 loadState()。自动刷新默认开（10s 一跳），所以计数最多晚 10s 出现；自动刷新关
   闭 / 标签页隐藏 / 正在输入时，计数就一直不更新。应用内面板同理（执行后不重新拉取）。
2. **计数器本身信息量不足**：旧实现只写一个裸 useCount（fire-and-forget，
   .catch(() => {}) 静默吞掉写库失败），没有时间戳、没有成败分列、没有最近一次结果——
   既无法回答「上次为什么失败」，也没有持续维护需要的数据。

因此本次修复 = 把计数做成**可读的维护信号**（usage 明细 + 健康报告 + 刷新入口），
而不是单纯再加一次 +1。行级 useCount 保持原有语义（面板/控制台/memory_toolize 直读），
所有现有 UI 不需要改就能继续显示总数。

## 2. 改动文件清单与关键改动

| 文件 | 改动 |
|---|---|
| src/builtin-capabilities.ts（新） | 内置能力目录：git-sync 能力定义（entry/doc/scope/路由描述/dryRunArg/writeConfirm/tags + version + changelog） |
| src/composite.ts | ① CompositeSpec 增加 version/updatedAt/changelog/usage；② bumpCompositeUse(store, name, result?) 落 usage 明细（成败分列/连续失败/lastUsedAt/lastStatus/lastDryRun/lastExitCode/lastSummary），行级 useCount 同步 +1，返回 Promise 供测试等待，内部 catch 保持 best-effort；③ mergeCapabilityUsage（纯函数）；④ registerCapability 新注册从 v1 起记、同名更新 version+1 + updatedAt + changelog（自定义或自动生成一行），usage 原样保留；⑤ mergeBuiltinCapabilities（内置合并，幂等）+ BuiltinMergeReport；⑥ rebuildComposites 启动时先合并内置（无需改 src/index.ts）；⑦ capabilityHealthOf 健康报告；⑧ capabilityToolDescription 抽出纯函数，能力工具描述注入路由规则 |
| src/route.ts | 新增 CAPABILITY_ROUTING_RULES（能力路由规则的单一事实来源文案） |
| src/tools.ts | memory_toolize：描述补 register 同名更新语义 + refresh-builtin + 路由规则；新增 refreshBuiltin 动作（播种/升级 + 差异报告 + 健康度）与 changelog 参数；输出 schema 增加 builtin（seeded/upgraded/current/localNewer/health）与 refreshed 状态 |
| package.json | smoke 链登记 node scripts/capability-smoke.mjs（只加这一行） |
| scripts/capability-smoke.mjs（新） | 源级单测 9 项（C1a/C1b/C1c/C2/C3/C4/C5/C6/C7） |
| src/observe.ts | **无改动**：该文件是分支观测/relay 投递，不含能力计数逻辑（任务清单里的「仅能力计数相关」在此文件中没有对应面） |

未改 src/panel.ts / src/webui.ts（属他人文件）：它们的 bumpCompositeUse(store, name)
两参调用继续有效（只计总数、不记成败明细）。若要让面板/控制台执行也记明细，各加一个参数即可：
bumpCompositeUse(store, spec.name, result)——已写进最终报告，交后续分支。

## 3. 内置能力合并/升级策略

mergeBuiltinCapabilities(store)（rebuild 时自动执行，refresh-builtin 时显式执行），按工具名
匹配行（跨工作区，匹配后**不改写 workspaceKey**）：

| 现场状态 | 动作 | 理由 |
|---|---|---|
| 行缺失 | **播种**：落库（version=内置版本，workspaceKey=workspaceKeyOf(scope)）+ 注册 | 清库/全新安装后插件依然自带该能力 |
| 行版本 < 内置版本（含旧行无 version 字段、定义损坏） | **升级：用内置定义覆盖**（entry/doc/scope/routeNote/dryRunArg/writeConfirm/runnable/title/description/tags），**保留** useCount/usage/workspaceKey/status，changelog 拼接（内置说明在前，现场历史在后） | 内置定义随插件代码和文档一起发布，旧版定义本身就是「文档与现状不符」的故障形态；唯一有意的本地修改路径是 memory_toolize register（version+1 超过内置），所以版本旧于内置的行不可能是认真的本地编辑 |
| 行版本 = 内置版本 | 不动（报告 current） | 已最新 |
| 行版本 > 内置版本 | **保留现场**（报告 localNewer） | 本地维护中（register 更新过），内置升级不覆盖 |
| 同名行是序列组合工具 | 跳过（不劫持、不播种） | 名称碰撞的极端保护 |

已接线：rebuildComposites 内部先合并再走原有注册循环，**不需要改 src/index.ts**；
启动合并只写库，注册由原循环统一做（播种行也会被注册）。

## 4. 大模型如何持续维护能力（具体调用方式与示例）

路由规则已写进 memory_toolize 描述和每个能力工具的描述（CAPABILITY_ROUTING_RULES，
单一来源在 src/route.ts）：scope 内高频事务优先固化/更新能力，不要现敲命令；连续失败或
文档与现状不符时必须更新能力，不要绕过。

```text
# 1) 查看内置 vs 现场差异 + 每个能力的健康度（使用/成败/连续失败/文档与 scope 缺失/零使用）
memory_toolize({ refreshBuiltin: true })

# 2) 高频事务没有现成能力 → 固化一个（首次注册 v1）
memory_toolize({
  register: true, name: 'verify-suite', title: '验证链',
  description: '本仓库提交前验证：typecheck + smoke 全绿才算完成。',
  entry: 'pnpm typecheck && pnpm smoke', doc: 'docs/verify.md',
  scope: 'G:\\09 - dsh\\SuperMemory', writeConfirm: false,
  tags: ['验证', 'typecheck', 'smoke'],
})

# 3) 能力连续失败 / 文档与现状不符 → 同名更新（version+1，changelog 记录原因）
memory_toolize({
  register: true, name: 'git-sync-supermemory', entry: 'pnpm git:sync',
  description: '...（更新后的路由描述）...',
  doc: 'docs/git-sync.md', scope: 'G:\\09 - dsh\\SuperMemory',
  dryRunArg: '--dry-run', writeConfirm: true,
  changelog: '入口改为先 fetch 再 rebase；修订凭据写法',
})
```

执行语义不变：能力工具 sm_composite_* 默认预演（dryRunArg 自动附加），
writeConfirm 能力真实执行必须 confirm=true；needs-confirm 不计数。
维护信号来源：capabilityHealthOf 的 notes（连续失败 ≥2 / 从未成功 / 文档缺失 /
scope 不存在 / 零使用 / 未注册 / 版本关系）。

新增/修改内置能力本身 = 改 src/builtin-capabilities.ts（改定义 + version+1 +
changelog 追加一行），随插件代码一起维护。

## 5. 验证结果

- scripts/capability-smoke.mjs：**9/9 通过**（C1a 计数与明细 / C1b 失败与连续失败 / C1c 序列回归 / C2 同名更新 / C3 内置播种+重启拾取+幂等 / C4 内置升级保留数据 / C5 现场保留 / C6 健康报告信号 / C7 路由规则入描述）
- **pnpm typecheck：0 错**（tsc -p tsconfig.json && tsc -p tsconfig.client.json）
- **pnpm smoke 全绿**：core 9 + mechanism 89（含并行分支的 R7 段，修好后同树通过）+ webui 32 + client-sim OK + capability 9
- 未执行 pnpm build 与 pnpm git:sync（并行分支同树作业，按要求禁止；最终构建由集成分支执行）

## 6. 遗留风险与需要后续分支/用户 GUI 配合的操作

1. **管理台执行后计数不即时刷新**（根因①）：需在 src/web/app.js 的 cap-run/cap-run-do/tool-status/tool-del 成功后调用 loadState()（该文件不属本分支所有权）。应用内面板若同样不刷新，需在面板执行后触发一次列表重取。
2. **面板/控制台执行不记成败明细**：src/panel.ts:1151 与 src/webui.ts:593 的 bumpCompositeUse(store, spec.name) 改为传 result 第三参即可（各一行）。
3. **UI 展示使用次数/能力版本**：ToolView（panel.ts）与 buildState（webui.ts）目前只透出行级 useCount；要展示 version/lastUsedAt/成败分列/健康 notes 需要这两个文件各加字段透传（本分支已在 spec.usage 里备好数据）。
4. **内置 scope 是绝对路径**：换机器/换克隆目录后 git-sync 能力的适用范围失效——健康报告会报 scopeMissing，用 memory_toolize register 同名更新即可修正（version+1 后内置不再覆盖）。
5. **存量行升级时机**：当前 store 里的 git-sync 行（无 version）会在下次插件重启时被升级到 v1（定义与内置一致，usage 从行级 useCount=1 结转，成败明细未知计 0）。升级是幂等的，重复重启不会重复写。
6. **全量构建未做**：按任务要求由集成分支执行 pnpm build；本分支只做了 typecheck + smoke。
