# SuperMemory 安装指南（用户版）

面向 DSH 最终用户：不需要克隆仓库、不需要构建，下载 Release 包 → 一条命令挂载 → 重启 DSH。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH Desktop | `>=0.2.0 <0.3.0`（已初始化过 profile：至少完整打开过一次 DSH Desktop） |
| Node.js | 22+（DSH 自带运行时亦可） |
| pnpm | 随 Node 安装或独立安装（`npm i -g pnpm`） |
| 网络 | 挂载步骤默认**不需要**外网（发布包已内置生产依赖）；仅首次 `pnpm install` 建软链时走本地缓存 |

## 安装步骤

### 1. 下载并解压 Release 包

- GitHub Releases：<https://github.com/FrogMoo/SuperMemory/releases>，下载最新版附件 `dsh-supermemory-<版本>.zip`（如 `dsh-supermemory-1.2.0.zip`）；
- 或仓库内 `release/` 目录同名文件（内网 Gitee 同步提供）。

解压到任意**无空格、无中文**的路径，例如：

- Windows：`C:\Users\<你>\Apps\dsh-supermemory-1.2.0`
- macOS/Linux：`~/Apps/dsh-supermemory-1.2.0`

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
