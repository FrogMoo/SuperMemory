# R29 记忆清理报告（2026-11-22 23:45–2026-11-23 00:10）

## 一、执行方式与背景

用户第 3 项需求：「整理所有的记忆，清理哪些明显没用的测试性的记忆」。
原计划派给分支执行，但分支会话实际没有 shell/文件工具（只完成只读导出），
经分支问题上交后由**中枢会话亲自执行**（有完整文件与命令能力）。

## 二、存储定位

- 文件：`C:\Users\admin\.dsh\storages\supermemory.json`（DSH storage domain 单文件 JSON，3.1 MB）
- 顶层结构：`{ unit, global, tables }`，**无校验和、无计数**，可安全离线编辑
- 多工作区混合：本仓库 `F:\10-SuperMemory` 之外还有 `F:\07-WeChatTool`、`F:\08-ERP`、`F:\ProductManage`、`F:\ceshi` 的数据——**全部未触碰**
- 插件运行中会整文件重写（mtime 23:58 仍在动），因此必须先让插件卸载再离线编辑

## 三、删除清单（严格限定 workspaceKey = F:\10-SuperMemory）

| 表 | 数量 | 内容 | 理由 |
|---|---|---|---|
| requirements | 40 → 0 | 全部 | 任务提示词碎片（"遵守）："、"完成）："、"修改：src/client/**…"）、已完成轮次残留（"整理现有记忆…重新排布"、"提交并同步到 git"）、元指令片段（"用户裁决时用 memory_raise_question…"）——无一条是真实待办 |
| memories | 13 → 12 | 1 条 | `mem-mws0s74i`：今天派发任务文本被自动抽取成的碎片（"/ memory_scan 等会写记忆存储的工具…"） |
| topicsets | 8 → 6 | 2 个 | `ts-mwl4q67c`「仓库 F:\10-Su 话题集索引（暂无正文）」、`ts-mwm1r5xl`「仓库 F:\10-Su 话题集：尚无结论记录」——路径截断残根、正文自述为空、成员为 11-17 旧分支 |
| routing | — | 2 条 | 清掉上述 2 个旧会话的 `activeTopicSetId` 悬空引用 |

保留：12 条正式记忆（R8–R22 等）、5 个记忆集合、6 个正常话题集、episodes/signals/dispatches/questions 等历史表。
需求碎片的主要来源已确认：`src/maintenance.ts` 的 `extractRequirements` 会把分支任务提示词里的
「必须/需要/待办」抽成需求——**未来派发仍会产生同类碎片**，属已知设计取舍（规则保守、无 LLM 判定）。

## 四、执行路径（可复现）

1. 备份：`~/.dsh/storages/supermemory-backups/manual-cleanup-r29-2026-11-22T16-05-38-718Z.json`（3,130,208 字节，删除前完整快照）
2. 卸载插件：原子编辑 `~/.dsh/profiles/desktop/cordis.patch.yml` 移除 supermemory insert 块
   （脚本 `patch-insert.mjs remove`；watcher 随即用基础条目 `- id: supermemory / name: dsh-supermemory` 重新激活——node_modules 符号链接指向本仓库，加载的是 23:55 新构建）
3. 离线删除：`node apply-cleanup.mjs --write`（先 dry-run 校验 45 项操作全部命中且工作区正确；备份→删除→JSON 往返校验→原子写入）
4. 重载：`plugin_manager` 对 `include:supermemory` 禁用→启用（insert 移除后该条目带 patchId 变得可管理）
5. 验证：`memory_topicsets` 仅剩 6 个正常话题集（残根消失）；`memory_recall` 正常命中 R18/R21/R22，被删碎片不再出现

## 五、产物

- `decisions.json` — 删除清单（含每条理由）
- `inspect-store.mjs` / `dump-ws.mjs` — 只读侦查脚本
- `apply-cleanup.mjs` — dry-run/写入执行器（含校验与原子写）
- `patch-insert.mjs` — profile patch insert 移除/武装工具

## 六、遗留

- 其他工作区（WeChatTool/ERP/ProductManage/ceshi）的 requirements 里也有同类碎片，本次按用户范围未处理；需要时可用同一套脚本换 workspaceKey 再跑。
- 仓库工作树有未提交改动（R28 前端 + R29 新会话修复 + 本目录脚本），未 commit/push（用户未要求）。
