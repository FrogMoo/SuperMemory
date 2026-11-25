# SuperMemory 安装指南（用户版）

面向 DSH 最终用户：不需要克隆仓库、不需要构建。可以**在 DSH 插件面板直接安装**（方式 A），也可以下载 Release 包手动挂载（方式 B）。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH Desktop | `>=0.2.0 <0.3.0`（已初始化过 profile：至少完整打开过一次 DSH Desktop） |
| Node.js | 22+（DSH 自带运行时亦可） |
| pnpm | 随 Node 安装或独立安装（`npm i -g pnpm`） |
| 网络 | 挂载步骤默认**不需要**外网（发布包已内置生产依赖）；仅首次 `pnpm install` 建软链时走本地缓存 |

## 方式 A：在 DSH 插件面板安装（推荐，需能访问 GitHub）

打开「侧边栏 → 插件 → 安装插件」，在「包名或地址」填以下**之一**：

1. **发布 tarball（最稳，安装器直接消费）**：
   `https://github.com/FrogMoo/SuperMemory/releases/latest/download/dsh-supermemory.tgz`
   （每个新 Release 都会带这个稳定别名；也可填某个版本的具体资产
   `.../releases/download/v<版本>/dsh-supermemory-<版本>.tgz`。）
2. **Git 仓库地址（安装 main 最新源码）**：
   `https://github.com/FrogMoo/SuperMemory`
3. **本机绝对路径**（已下载/解压 tarball 时）：
   例如 `F:\10-SuperMemory\release\dsh-supermemory.tgz`。

安装开始后等它完成；若提示重启，**完全退出并重启 DSH Desktop**。

### 安装器规则（DSH 0.2.2-rc.5，务必按此填写）

DSH 插件面板的安装器**不会**读取 GitHub Releases 的 release 列表，也不接受 zip；它只认四类输入：

| 输入 | 是否接受 | 说明 |
|---|---|---|
| npm 包名（如 `dsh-plugin-xxx`） | ✅ | 本插件未发布 npm，不适用 |
| Git 仓库 URL / `github:owner/repo` | ✅ | 会 clone 默认分支；安装前有 5 秒 GitHub 连接检查，网络慢会超时 |
| `.tgz` / `.tar.gz` 直链或绝对路径 | ✅ | **发布面板安装请用这个** |
| `FrogMoo/SuperMemory`（裸 owner/repo） | ❌ | 会被当成 npm 包名，报 invalid spec |
| `.../releases` 页面 URL | ❌ | 报 “a URL must point at a git repository or a tarball” |
| Release 里的 `.zip` 资产 | ❌ | 同上；zip 只用于下面的手动安装 |

> 自 `v1.2.1` 起，每个 Release 都同时带版本 tgz（`dsh-supermemory-<版本>.tgz`）与稳定别名 `dsh-supermemory.tgz`，上面的稳定 URL 可直接使用。若安装器仍报 404（CDN 尚未刷新），改用 Git 地址，或按方式 B 手动安装。

## 方式 B：手动下载 Release 包（离线/内网）

### 1. 下载并解压 Release 包

- GitHub Releases：<https://github.com/FrogMoo/SuperMemory/releases>，下载最新版附件 `dsh-supermemory-<版本>.zip`（如 `dsh-supermemory-1.3.4.zip`）；
- 或仓库内 `release/` 目录同名文件（内网 Gitee 同步提供）。

解压到任意**无空格、无中文**的路径，例如：

- Windows：`C:\Users\<你>\Apps\dsh-supermemory-1.3.4`
- macOS/Linux：`~/Apps/dsh-supermemory-1.3.4`

解压后目录应包含：`lib/`（预构建产物）、`node_modules/`（内置依赖）、`package.json`、`cordis.patch.yml`、`scripts/install-into-dsh.mjs`、`README.md`、`CHANGELOG.md`、`LICENSE`、本文件。

### 2. 挂载到 DSH profile

进入解压目录执行：

```bash
node scripts/install-into-dsh.mjs
```

脚本会自动完成（有详细日志，共 6 步）：

1. 前置检查（插件入口 `lib/supermemory.js`、客户端入口 `lib/client.js`、bundle patch 齐全）；
2. 备份 DSH profile 的 `package.json` / `cordis.patch.yml`（`.bak-<时间戳>-bundle-install`）；
3. profile `package.json` 增加依赖 `"dsh-supermemory": "link:<解压目录>"` 并激活 `dsh.profile.bundles`；
4. 清理 profile patch 里可能残留的旧式路径 insert（防重复注册）；
5. 在 profile 目录执行 `pnpm install` 建立符号链接；
6. 自检（链接存在、依赖声明、激活态、patch 干净）全部 PASS。

> 自定义 profile：`node scripts/install-into-dsh.mjs --profile <profile 名>`（默认 `desktop`）。
> 先预演不写盘：追加 `--dry-run`。

### 3. 重启 DSH Desktop

1. 完全退出并重启 DSH Desktop（客户端 bundle 图仅在启动时构建，必须重启）；
2. 「侧边栏 → 插件」页应出现 `dsh-supermemory` 且为**启用**态（列表实时读盘，刷新页面即可见）；
3. 侧边栏出现 SuperMemory 面板入口；新会话中模型可见 14 个 `memory_*` 工具与 `sm_cap_doc`（按需读取能力知识面正文；能力知识面不会出现在 `available_skills` 里）。

## 升级

下载新版本 Release 包 → 解压到**新目录** → 重跑 `node scripts/install-into-dsh.mjs`（脚本会把 profile 里的 link 指向更新到新目录）→ 重启 DSH。旧目录确认无人引用后可删除。

### 升级到 1.3.4 后要做什么（R56：注入卡标题统一）

1. **完全退出并重启 DSH Desktop**（不是禁用/启用插件，也不是刷新窗口）。
2. **注入卡标题统一**：四类卡改名——`[SuperMemory 话题集]` → `[supermemory-相关话题]`、`[SuperMemory 相关记忆]` → `[supermemory-相关记忆]`、`[supermemory 关联分支]` → `[supermemory-相关分支会话]`、`[SuperMemory 可用能力]` → `[supermemory-相关能力]`；另有两张同族卡：`[supermemory-相关话题候选]`（候选提示，不切换）与 `[supermemory-相关记忆补充]`（同一请求内后补的记忆）。
3. **功能性卡**：中枢角色提示首行 `[supermemory-hub-role]`、插件记忆使用约定首行 `[supermemory-plugin-prompt]`、中断任务公告 `[supermemory-notice]`。
4. 旧标题（`[SuperMemory 话题集]` / `[SuperMemory 相关记忆]` / `[supermemory 关联分支]` / `[SuperMemory 可用能力]` 等）不再出现；会话间传输的消息头（`[supermemory-relay …]`、`[supermemory-group-relay …]`、`[supermemory-dispatch …]` 等）保持不变，属正常现象。
5. 本版无存储结构变更、无行为变更；回滚只需重装旧版包并重启。此前版本升级说明中出现的旧卡名，以本版为准。

### 升级到 1.3.3 后要做什么（R55：中枢只读检查 + 执行禁令）

1. **完全退出并重启 DSH Desktop**（不是禁用/启用插件，也不是刷新窗口）：启动时会把 `sm_cap_doc` 合并进已存的「中枢权限」白名单行（一次性、幂等；即使不迁移，锁定项也一直按内置规则生效）。
2. **中枢可以读能力知识面**：中枢会话里 `sm_cap_doc({ name })` 正常返回正文并给该能力 `loadCount+1`；普通会话（既不是中枢也不是分支）调用会被明确拒绝（`CAPABILITY_DOC_ROLE_DENIED`），而不是「找不到工具」。
3. **中枢不能执行能力**：中枢调用 `sm_cap_*` 返回 `HUB_CAPABILITY_EXEC_DENIED`，提示「请用 memory_dispatch 派发到分支，任务里写明能力名、是否先预演、写操作需 confirm=true」；`sm_cap_*` 也不再出现在中枢的工具列表里。分支会话照常执行（默认预演，写操作 `confirm=true`）。
4. **面板标注**：SuperMemory 面板「中枢权限」页签把 `sm_cap_doc` 显示为**锁定**的「只读路由，锁定」项（不可取消），`sm_cap_*` 标注「中枢不可执行」；勾选 `sm_cap_*` 不会让中枢获得执行权。
5. 验证：中枢新开一个对话，让模型读一次 `sm_cap_doc`（应成功）、再让它直接执行 `sm_cap_*`（应被 `HUB_CAPABILITY_EXEC_DENIED` 拒绝并提示派发）；派发到分支后执行应正常。

> 本版无存储结构变更（存储域 `supermemory` version 1 不变）；新增的 `hub_policies` 白名单合并在启动时执行一次，回滚只需重装旧版包并重启。

### 升级到 1.3.2 后要做什么（R54：版本/统计/卡片修复）

1. **仍然必须完全退出并重启 DSH Desktop**（不是禁用/启用插件，也不是刷新窗口）：三项修复都在插件启动时的迁移里执行。
2. **知识面版本不再回退**：启动时取 `max(能力记录版本, 当前文件 sm-version, 归档 sm-version)`。如果你曾遇到「面板/文件显示 v6、归档却是 v8」，重启后该能力的知识面会恢复到 `v8` 及以上，并在 changelog 里留下 `v8: R52 迁移到 .dsh/capabilities，保留归档版本（源自归档 …）`；再次重启不会再改写（幂等）。
3. **统计口径一致**：历史遗留的「运行次数 0、却记录 13 次成功 / 9 次失败」会在迁移时折算为 `runCount = success + fail`（历史成功率保留），`lastStatus` 与最近一次结果一致；面板不再出现「0 次运行 / 有成功率」的矛盾读数。
4. **注入卡用人类标题**：`[SuperMemory 可用能力]` 卡的「何时用」优先使用能力标题（如「git 同步/提交/推送（SuperMemory 仓库）」），不再拿机器名当主语；没有标题时才退回描述。
5. 验证：重启后看「固化能力」面板该能力版本 ≥ 8、运行次数 = 成功 + 失败；新会话里注入卡首行应显示标题而不是 `git-sync-supermemory`。

> 本版无存储结构变更（存储域 `supermemory` version 1 不变），不需要清理数据；回滚只需重装旧版包并重启。

### 升级到 1.3.1 后要做什么（R52：能力知识面迁移）

1. **完全退出并重启 DSH Desktop**——不是仅禁用/启用插件，也不是刷新窗口。知识面迁移在插件启动时执行：旧 `<skills 根>/sm-*/SKILL.md` 复制到 `.dsh/capabilities/<name>.md`，旧目录整体移到 `<skills 根>-archive/`（写 manifest，可回滚）。**旧进程还在时迁移不会执行**。
2. 重启后检查两处：项目仓库（或用户级）`.dsh/skills` 下**不再有 `sm-*` 目录**；`.dsh/capabilities/` 下**出现 `<name>.md`**（例如 `git-sync-supermemory.md`）。第三方 skill（`ego-browser`、`office` 等）不受影响。
3. 打开「侧边栏 → SuperMemory 面板 → 固化能力」：模型每调用一次 `sm_cap_doc({ name })`，该能力**加载次数（loadCount）** +1；点开任一能力可编辑正文并保存，事实块 `<!-- sm:facts:start/end -->` 会被保留、版本号 +1。

> 迁移幂等：重复启动不会重复搬移；需要回滚时把 `skills-archive/<name>` 移回 `.dsh/skills/<name>` 并把面板里的能力重新指向该目录即可（归档 manifest 记录原名/来源/时间/原因）。

## 卸载

1. 「侧边栏 → 插件」页禁用 `dsh-supermemory`；
2. 删除 DSH profile 目录下 `node_modules/dsh-supermemory` 符号链接；
3. 从 profile `package.json` 移除 `"dsh-supermemory"` 依赖与 `dsh.profile.bundles` 中的条目；
4. 删除解压的发布包目录。存储数据位于 DSH 存储域 `supermemory`，如需一并清除请在插件页禁用后按 DSH 存储域管理指引处理。

## 故障排查

| 现象 | 处理 |
|---|---|
| 插件页看不到插件 | 确认已跑过 `install-into-dsh.mjs` 且自检全 PASS；刷新插件页（实时读盘）；仍没有 → 重启 DSH |
| 重启后不生效 | 必须**完全重启** DSH Desktop（不是刷新窗口） |
| 中枢调用 `sm_cap_*` 被拒（`HUB_CAPABILITY_EXEC_DENIED`） | 这是设计行为：中枢只做判断与派发。用 `memory_dispatch` 把任务派发到分支，任务里写清能力名、是否先预演、写操作 `confirm=true` |
| 中枢读 `sm_cap_doc` 被拒（`CAPABILITY_DOC_ROLE_DENIED`） | 当前会话既不是中枢也不是分支。请在话题集的中枢/分支会话中读取，或先让中枢派发分支调查 |
| 报缺少 `@deepseek-ai/schemastery` | 发布包 `node_modules/` 被解压工具丢弃（部分工具默认跳过点目录/链接）→ 用支持完整解压的工具重新解压，勿删 `node_modules` |
| 换机器/换目录 | 重跑一次 `node scripts/install-into-dsh.mjs` 即可，link 自动跟随新路径 |
| 插件面板报“找不到插件 / invalid spec” | 不要填裸 `FrogMoo/SuperMemory`、release 页面或 zip 资产；按方式 A 填完整 git URL 或 `.tgz` 直链 |
| 插件面板报“无法访问 GitHub / 连接超时” | 安装器对 GitHub 有 5 秒连接检查；网络慢时改用 `.tgz` 直链/本机路径，或走方式 B 手动安装 |
| 插件面板安装 `.tgz` 后没反应 | 完全退出并重启 DSH Desktop；到插件页确认 `dsh-supermemory` 已启用 |
