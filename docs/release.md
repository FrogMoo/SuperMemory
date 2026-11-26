# Release 发布流程（SuperMemory）

> 适用范围：本仓库的版本发布。npm 包名是 `@frogmoo/dsh-supermemory`（scoped 名自 1.4.0 起，npm 首发 1.4.1，
> 可发布到公共 registry），GitHub 仓库名仍是 `FrogMoo/SuperMemory`，本地自建资产名仍是
> `dsh-supermemory-<版本>.zip/.tgz` —— 三者刻意保持不同，别互相替换。
>
> **自 R58 起：GitHub Release 只保留 GitHub 按 tag 自动生成的
> `Source code (zip)` 与 `Source code (tar.gz)`，不再上传任何自建
> `dsh-supermemory*.zip/.tgz` 资产。** 本文替代 README/INSTALL 里旧的
> `.../releases/latest/download/dsh-supermemory.tgz` 安装指引。
> git 提交/双推细节见 [git-sync.md](git-sync.md)；用户安装见 [INSTALL.md](../INSTALL.md)。

## 1. 策略与边界

### 1.1 发布只发布「源码归档」

GitHub 对每个已发布 Release 自动提供两个源码归档（由 tag 指向的 commit 即时生成，**不是资产**）：

- `https://github.com/FrogMoo/SuperMemory/archive/refs/tags/<tag>.zip`
- `https://github.com/FrogMoo/SuperMemory/archive/refs/tags/<tag>.tar.gz`

它们也是 Release 页面上的 `Source code (zip)` / `Source code (tar.gz)` 两个链接。
**这两个归档不是可安装的 DSH 插件包**：不含生产依赖 `node_modules/`，不能直接丢给 DSH
插件面板，也不能替代 `release/dsh-supermemory-<版本>.tgz`。

### 1.2 不再上传自建资产

- 默认发布路径**不调用资产上传接口**：创建/复用 Release 元数据后即结束。
- 自建 zip/tgz 只用于**本地/内网手动安装**（见 §5），不随 Release 发布。
- 需要保留旧的三资产上传行为时，只能显式使用脚本逃生口
  `node scripts/github-api-release.mjs ... --with-assets`（内网镜像/离线分发等特殊场景；
  公开 Release 不要用）。
- **v1.3.5 及以前**的 Release 资产保持原样，不删除、不替换。

### 1.3 不再保证的旧入口

- `https://github.com/FrogMoo/SuperMemory/releases/latest/download/dsh-supermemory.tgz`
  从下一个发布版本起会 **404**（因为没有同名资产了）。
- 面板安装改用 Git 仓库地址，或本地 `pnpm package-release` 产出的 `.tgz` 绝对路径；
  源码归档不是插件包，不能作为安装输入。

## 2. 发布前检查（代码 / 版本 / 闸门）

1. 功能、测试、文档完成；工作区里没有无关改动。
2. 版本号：`package.json` 的 `version` 升到 `X.Y.Z`（附注 tag 用 `vX.Y.Z`）。
3. `CHANGELOG.md` 增加对应 `[X.Y.Z]` 小节；`README.md` / `INSTALL.md` 的版本说明同步。
4. 全量闸门（缺一不可）：

   ```bash
   pnpm typecheck   # 宿主 + client 双工程 0 错
   pnpm build       # 宿主 + 客户端产物落 lib/
   pnpm smoke       # 七套冒烟全绿
   ```

5. 确认 v1.3.5 及以前的 tag / Release / 资产没有被改动。

## 3. 单条提交 + 附注 tag + 双推

发布提交保持**单条**（源码 + 测试 + 版本号 + 文档 + `lib/` 构建产物；
`release/` 二进制按 `.gitignore` 不入库）：

```bash
git add -A
git commit -F <提交信息文件>          # 中文提交信息写文件，-F 传入
git tag -a vX.Y.Z -F <tag信息文件>    # 必须是附注 tag（annotated），不要轻量 tag
```

推送 main（按 [git-sync.md](git-sync.md) 的双远程约定）：

```bash
pnpm git:sync          # origin push URL：GitHub 首位 + Gitee
git push origin vX.Y.Z # tag 单独推；同样走两个 push URL
```

核验三方一致（本地 / GitHub / Gitee）：`main` commit、附注 tag 对象 SHA、tag 指向的 commit。
GitHub git 面被阻断时，才改用 §4.2 的 API 补推/建 Release。

> 创建 Release 前，tag 必须已经存在（本地附注 tag 已推送，或 GitHub 上已有同名 tag）。
> 不要让 GitHub 的「Publish release」自动创建轻量 tag——那会和本地附注 tag 冲突。

## 4. 创建 Release（source-only）

### 4.1 正常路径：GitHub 页面 / gh

1. 打开 <https://github.com/FrogMoo/SuperMemory/releases/new>；
2. 选择**已存在**的 tag `vX.Y.Z`；
3. 填标题与 Release notes（可从 `CHANGELOG.md` 复制）；
4. **不要上传任何资产**（`Choose files` 留空）；
5. Publish release。

或用 GitHub CLI（不传任何 asset 参数）：

```bash
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z — SuperMemory Release" --notes-file <notes文件>
```

GitHub 会自动生成 §1.1 的两个源码归档。

### 4.2 API 补推路径：github-api-release.mjs

仅当 GitHub 的 git 传输不通、但 `api.github.com` 可达时使用。脚本会先做单提交快进校验
（GitHub main 必须正好是该提交的父提交），再推 tag、建 Release；**默认 source-only**。

先离线看计划（不触网、不读令牌）：

```bash
node scripts/github-api-release.mjs --plan --tag vX.Y.Z
# 预期包含：
#   release = source-only（默认；只建/复用 Release 元数据，不上传自建资产）
#   assets  = none
```

真实执行：

```bash
node scripts/github-api-release.mjs <commit-ish> --tag vX.Y.Z --notes <notes文件>
```

- 输出应出现 `source-only：未上传自建资产`；
- 如果复用已有 Release，脚本只读它的资产清单做提示，**不删除、不替换**；
- 只有显式加 `--with-assets` 才会回到旧的三资产上传行为（内网/离线逃生口）：

  ```bash
  node scripts/github-api-release.mjs <commit-ish> --tag vX.Y.Z --notes <notes文件> \
    --with-assets [--asset <path>]...
  ```

> `--with-assets` 生成的公开 Release 会重新出现自建 zip/tgz 与旧稳定 URL；
> 除非明确要做镜像，否则不要使用。

## 5. 校验发布结果

### 5.1 Release 元数据与资产清单

```bash
curl -s https://api.github.com/repos/FrogMoo/SuperMemory/releases/latest
```

核对：

- `tag_name` = `vX.Y.Z`，`draft=false`，`prerelease=false`；
- **`assets` 为空数组**（source-only 的核心断言）；若不为空，说明误用了
  `--with-assets` 或页面上传了文件，需人工删除该 Release 的自建资产；
- `html_url` 指向新 Release。

GitHub 前端被阻断时，同样可用上面这个 API；它和 `github.com` 是两个网络面
（见 [git-sync.md §12](git-sync.md)）。

### 5.2 两个源码归档可下载、字节合理

```bash
curl -L -o /tmp/sm-src.zip      https://github.com/FrogMoo/SuperMemory/archive/refs/tags/vX.Y.Z.zip
curl -L -o /tmp/sm-src.tar.gz   https://github.com/FrogMoo/SuperMemory/archive/refs/tags/vX.Y.Z.tar.gz
ls -l /tmp/sm-src.zip /tmp/sm-src.tar.gz
unzip -l /tmp/sm-src.zip | head
tar -tzf /tmp/sm-src.tar.gz | head
```

判定标准：

- HTTP 200 且文件非空（刚发布时若 404，先确认 tag 已存在，等 CDN 刷新后重试）；
- 归档根为 `SuperMemory-<tag>/`（或等价目录），顶层含 `package.json`、`README.md`、
  `lib/`、`src/`；
- **`node_modules/` 不在归档里**——再次确认它是源码归档，不是可安装插件包；
- 记录两个文件的字节数与耗时，写入发布汇报。

API 替代下载（GitHub 前端不可达时）：

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -sL -H "Authorization: Bearer $TOKEN" -o /tmp/sm-src.zip \
  https://api.github.com/repos/FrogMoo/SuperMemory/zipball/vX.Y.Z
curl -sL -H "Authorization: Bearer $TOKEN" -o /tmp/sm-src.tar.gz \
  https://api.github.com/repos/FrogMoo/SuperMemory/tarball/vX.Y.Z
```

### 5.3 tag 指向

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/FrogMoo/SuperMemory/git/refs/tags/vX.Y.Z
# object.sha = 附注 tag 对象；再取 /git/tags/<object.sha>，其 object.sha = 目标 commit
```

## 6. 本地安装包（不随 Release 发布）

发布前/后都可以为本地或内网制作安装包：

```bash
pnpm build
pnpm package-release          # 等价于 node scripts/package-release.mjs
```

产出（全部只留在 `release/`，**不要上传到 Release**）：

| 产物 | 用途 |
|---|---|
| `release/dsh-supermemory-<版本>.zip` | 手动安装：解压后 `node scripts/install-into-dsh.mjs` |
| `release/dsh-supermemory-<版本>.tgz` | 本机 DSH 插件面板填绝对路径 |
| `release/dsh-supermemory.tgz` | 版本无关别名（本地脚本/旧流程兼容） |

脚本结束时会打印：

```text
注意：以上产物仅用于本地/离线安装，不随 Release 发布。
      Release 只提供 GitHub 自动生成的 Source code (zip/tar.gz)；源码归档不是可安装插件包。
```

只查看计划、不落盘：

```bash
pnpm package-release --plan
```

## 6.5 npm 发布（可选，发布到公共 registry）

> 只在确实要把插件挂到 npm 时执行；它和 GitHub Release 是**两条独立通道**，
> 互不替代（npm 包让插件页出现「版本 / 检查更新」，Git 地址不提供）。

- **包名**：`@frogmoo/dsh-supermemory`（scoped，public）。`package.json` 已带
  `publishConfig: { "access": "public", "registry": "https://registry.npmjs.org/" }`，
  所以发布目标**不受本机全局 registry 镜像影响**，也无需在仓库里放会污染安装的 `.npmrc`。
- **前置**：npm 账号对 `@frogmoo` scope 有发布权；已登录（`npm login`）或提供
  `NODE_AUTH_TOKEN`（CI 用 granular/automation token）；账号开了 2FA 时按提示输入 OTP。
- **干跑**：`npm pack --dry-run` 看内容与体积；`npm publish --dry-run` 看 registry 目标与文件清单
  （不会写入 registry）。
- **正式发布**：`pnpm publish:npm`（= `npm publish --access public`）。该命令会触发
  `prepublishOnly: pnpm run build`，所以**先 `pnpm build` 再发布就会跑两次构建**；CI 里要避免重复，
  用 `npm publish --ignore-scripts` 并自行保证 `lib/` 是最新的。
- **发布后校验**：`npm view @frogmoo/dsh-supermemory version dist-tags`；再在一台干净机器上
  用 DSH 面板按包名安装，确认插件页出现「版本 / 重新检查 / 可更新到 x」。
- **不要改的东西**：Release 自建资产名保持 `dsh-supermemory-<版本>.zip/.tgz`（见 §1.2/§5）；
  npm 归一化 tarball 名是 `frogmoo-dsh-supermemory-<版本>.tgz`，`scripts/package-release.mjs`
  会在本地把它改名回旧约定，别把资产名改成 scoped 形式。

## 7. 旧版本、旧 URL 与用户告知

- v1.3.5 及以前的 Release 资产**保持原样**；不要为了统一而删除历史资产。
- `releases/latest/download/dsh-supermemory.tgz` 从下一个发布版本起失效（404）。
  插件面板安装改用：
  - Git 仓库地址：`https://github.com/FrogMoo/SuperMemory`（安装器接受 `kind=git`）；
  - 本地 `.tgz` 绝对路径（`pnpm package-release` 的产物）。
- 源码归档（Source code zip/tar.gz）**不是可安装插件包**，必须向用户说明。
- 旧版本仍可下载历史资产，但不要把旧稳定 URL 写进新文档。

## 8. 异常处理

| 现象 | 处理 |
|---|---|
| `/releases/latest` 的 `assets` 非空 | 说明误用了 `--with-assets` 或页面上传；在该 Release 页面删除自建资产，再复核 |
| 源码归档 URL 404 | 先确认 tag 与 Release 已发布；可能是 CDN 延迟，等待后重试；仍失败则检查 Release 是否为 draft |
| Release 指向错误 tag | 不要 force push / 移动 tag；删除该 Release，修正 tag 后重新创建 |
| API 补推报「GitHub main 不是父提交」 | 说明 GitHub 已有更新提交；不要强推，等 git 传输恢复后走 `pnpm git:sync`，或按 §4.2 的前提逐个提交补推 |
| 误传了自建资产 | 只删除本 Release 的误传资产；v1.3.5 及以前的历史资产不动 |

## 9. 相关文档

- [git-sync.md](git-sync.md) —— 双远程、凭据、API 补推、GitHub 前端阻断时的核验；
- [INSTALL.md](../INSTALL.md) —— 用户安装/升级/卸载；
- [README.md](../README.md) —— 项目概览与安装入口；
- [CHANGELOG.md](../CHANGELOG.md) —— 版本变更记录。
