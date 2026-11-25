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

- GitHub Releases：<https://github.com/FrogMoo/SuperMemory/releases>，下载最新版附件 `dsh-supermemory-<版本>.zip`（如 `dsh-supermemory-1.2.1.zip`）；
- 或仓库内 `release/` 目录同名文件（内网 Gitee 同步提供）。

解压到任意**无空格、无中文**的路径，例如：

- Windows：`C:\Users\<你>\Apps\dsh-supermemory-1.2.1`
- macOS/Linux：`~/Apps/dsh-supermemory-1.2.1`

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
3. 侧边栏出现 SuperMemory 面板入口；新会话中模型可见 14 个 `memory_*` 工具。

## 升级

下载新版本 Release 包 → 解压到**新目录** → 重跑 `node scripts/install-into-dsh.mjs`（脚本会把 profile 里的 link 指向更新到新目录）→ 重启 DSH。旧目录确认无人引用后可删除。

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
| 报缺少 `@deepseek-ai/schemastery` | 发布包 `node_modules/` 被解压工具丢弃（部分工具默认跳过点目录/链接）→ 用支持完整解压的工具重新解压，勿删 `node_modules` |
| 换机器/换目录 | 重跑一次 `node scripts/install-into-dsh.mjs` 即可，link 自动跟随新路径 |
| 插件面板报“找不到插件 / invalid spec” | 不要填裸 `FrogMoo/SuperMemory`、release 页面或 zip 资产；按方式 A 填完整 git URL 或 `.tgz` 直链 |
| 插件面板报“无法访问 GitHub / 连接超时” | 安装器对 GitHub 有 5 秒连接检查；网络慢时改用 `.tgz` 直链/本机路径，或走方式 B 手动安装 |
| 插件面板安装 `.tgz` 后没反应 | 完全退出并重启 DSH Desktop；到插件页确认 `dsh-supermemory` 已启用 |
