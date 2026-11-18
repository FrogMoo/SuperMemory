# git 同步 / 提交 / 推送流程（SuperMemory 仓库 · 流程固化样板）

> **⚠️ 遇到本仓库的 git 同步、提交、推送类问题，优先使用 `scripts/git-sync-push`，不要手敲 `git fetch` / `git rebase` / `git push`。**
> 手敲极易踩本机凭据坑（见 §4.1）：本机 Git Credential Manager 接管了远端认证且失败，直接 push 会认证失败或卡在用户名提示。脚本已把坑全部封装——先 `--dry-run` 看计划，确认后再真跑。

- 适用范围：本仓库 `G:\09 - dsh\SuperMemory`
- 远端：`origin = http://zrynas.7766.org:8418/旧帐号名/SuperMemory.git`，默认分支 `main`
- 命令均在仓库根目录执行；脚本自身会 `cd` 到仓库根（`git rev-parse --show-toplevel`），在子目录下调用也可以

## 1. 一键入口

| 场景 | 命令 |
|---|---|
| 日常同步（推荐） | `pnpm git:sync` |
| 只预演（不写任何 ref、不改工作区、不 push） | `pnpm git:sync --dry-run` |
| bash 直跑（Git Bash / bash 在 PATH 的 shell） | `bash scripts/git-sync-push.sh` |
| bash 直跑预演 | `bash scripts/git-sync-push.sh --dry-run` |
| cmd / PowerShell 下 bash 不在 PATH（全路径写法） | `"C:\Program Files\Git\bin\bash.exe" scripts/git-sync-push.sh --dry-run` |
| 指定远端 / 分支 | `pnpm git:sync --dry-run -r origin -b main` |
| 看帮助 | `bash scripts/git-sync-push.sh -h`（或 `node scripts/git-sync-push.mjs -h`） |

### 1.1 pnpm 参数透传（实测，与脚本旧注释不同）

- 本机 pnpm 12.3.4 实测：**`pnpm git:sync --dry-run`（不带 `--`）正常**，参数原样透传给 node 启动器。
- **`pnpm git:sync -- --dry-run` 会失败（退出码 3）**：pnpm 12 把分隔符 `--` 也当普通参数透传，脚本遇到未知参数 `--` 报「ERROR: 未知参数: --」退出。
- 注意：`scripts/git-sync-push.sh` 头部注释仍写着「pnpm 下参数必须用 `--` 分隔」，那是旧版 pnpm 行为/笔误，**以本文实测为准**（本次任务不改脚本本体）。

## 2. 两个脚本的关系（先读懂再动手）

- `scripts/git-sync-push.sh`（bash，185 行）= **唯一实现**。流程、参数、退出码、安全约束全部定义在这里。
- `scripts/git-sync-push.mjs`（node，76 行）= **启动器 / 包装器**，不是第二套实现：它在 Windows 上定位 `bash.exe`，找到后以 `stdio: 'inherit'` 转交 `.sh`，参数（`process.argv.slice(2)`）与退出码（`res.status`）原样透传。
- `package.json` 第 43 行：`"git:sync": "node scripts/git-sync-push.mjs"`，所以 `pnpm git:sync` 走 node 版，**没有 bash PATH 问题**——这是 `pnpm git:sync` 优于 `bash scripts/...` 直跑的原因。

### 2.1 行为差异（如实记录）

| 维度 | `.sh`（唯一实现） | `.mjs`（启动器） |
|---|---|---|
| 参数 / 退出码 / 安全约束 | 唯一定义处 | 原样透传，不自定义任何语义 |
| bash 定位 | 要求调用方环境里 bash 可用（PATH） | 自动探测，顺序：`$SM_BASH` → `bash` → `sh`（非 Windows）→ `where bash` 结果 → 由 `where git` 推导 `<git 根>/bin/bash.exe` → `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\Git\bin\bash.exe` → `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`；每个候选都用 `bash -c "exit 0"` 实测可用性 |
| 独有失败模式 | 无 | ① 找不到 bash → exit 1；② 找不到 `.sh` → exit 1；③ bash 被信号终止 → exit 1 |
| cwd 要求 | 仓库内任意目录（自身 `cd` 到 toplevel） | 任意目录（按自身文件位置定位 `.sh`） |

结论：二者行为一致（`.mjs` 就是 `.sh` 的外壳），差异只在 bash 定位与三个启动器独有失败模式。

## 3. 流程步骤（`.sh` 内部顺序）

1. **工作区检查**：`git status --porcelain`。有未提交改动时：非 dry-run → 打印前 10 条并 exit 2；dry-run → 仅报告，继续。
2. **fetch**：`GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper=store fetch <remote> --prune`。失败 → exit 1。
3. **校验远端跟踪分支**：fetch 后 `refs/remotes/<remote>/<branch>` 必须存在，否则 exit 1。
4. **计算 ahead/behind**：`git rev-list --left-right --count <remote>/<branch>...HEAD`。
5. **rebase（仅 behind>0，绝不 merge）**：`git rebase <remote>/<branch>`；冲突 → 打印冲突文件清单（`git diff --name-only --diff-filter=U`）+ 自动 `git rebase --abort` + exit 1，仓库回到 rebase 前状态。
6. **push（仅 ahead>0）**：`git push <remote> <branch>`；失败原样报错 exit 1，不重试。
7. **ls-remote 核对**：`git ls-remote <remote> refs/heads/<branch>` 取远端权威 hash 与本地 `HEAD` 比对，打印摘要（本地 HEAD / 远端 hash / ahead/behind / 结论）。

**dry-run 的边界**：dry-run 仍会发起网络请求（fetch + ls-remote，需要凭据可用），它保证的是「不写任何 ref、不改工作区、不 rebase、不 push」，并会打印计划（将要 rebase / push 的提交列表）。

## 4. 坑与规避（全部实测）

### 4.1 凭据 helper 混用（最容易卡死的一坑）

- 本机 `C:/Users/Administrator/.gitconfig` **没有** `credential.helper`，但有：
  - `credential.helperselector.selected=manager`
  - `credential.http://zrynas.7766.org:8418.provider=generic`

  即 Git Credential Manager（GCM）接管了 `zrynas.7766.org:8418` 的认证，且对该主机认证失败。
- **只加 `-c credential.helper=store` 不够**，必须先清空 helper 列表再显式指定：

  ```bash
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper=store <fetch|push|ls-remote> origin main
  ```

- 凭据存放于 `~/.git-credentials`（即 `C:/Users/Administrator/.git-credentials`），host 条目为 `zrynas.7766.org%3a8418`。
- 脚本已封装该写法（`export GIT_TERMINAL_PROMPT=0` + `GIT=(git -c credential.helper= -c credential.helper=store)`），**不要手敲 git push 绕过脚本**。

### 4.2 bash 不在 PATH（Windows cmd / PowerShell）

- 本机 PATH 只有 `C:\Program Files\Git\cmd`，`bash.exe` 在 `C:\Program Files\Git\bin`。
- cmd 下直跑报「`'bash' 不是内部或外部命令`」；PowerShell 下报「术语 'bash' 不会被识别为 cmdlet、函数、脚本文件或可执行程序的名称」（2026-11-18 实测）。
- 规避（三选一）：① 用 `pnpm git:sync`（node 版自动定位 bash，推荐）；② 全路径 `"C:\Program Files\Git\bin\bash.exe" scripts/git-sync-push.sh ...`；③ 在 Git Bash 里跑。

### 4.3 pnpm 参数透传

见 §1.1：本机 pnpm 12.3.4 下用 `pnpm git:sync --dry-run`，**不要**加 `--`（加了会 exit 3）。

### 4.4 凭据存放位置

`~/.git-credentials`（`C:/Users/Administrator/.git-credentials`），host 条目 `zrynas.7766.org%3a8418`。**不要**改全局 git config、**不要**改 remote URL 来解决认证问题。

### 4.5 行尾（写 .md / 文本文件时）

本仓库无 `.gitattributes`、`core.autocrlf` 未设，行尾混合。新增或修改 `.md` 时保持 **LF、无 BOM、无 CRLF**；写完用 `git diff --stat` 或 `grep -c $'\r' <file>` 自查（应为 0）。

## 5. 安全约束与退出码

### 5.1 安全约束（脚本硬规则）

- 工作区有未提交改动 → 拒绝执行（exit 2），**不 stash、不自动提交**；
- behind>0 → `git rebase`，**绝不 merge**；
- rebase 冲突 → 自动 `git rebase --abort` 并列出冲突文件，exit 1，不留半 rebase 状态；
- push 失败 → 原样报错退出，**不重试、不改 git config、不改 remote URL**；
- **绝不执行** `git reset --hard` / `git checkout --` / `git clean -fd` / `push --force`。

### 5.2 退出码表

| 退出码 | 含义 | 触发细节 |
|---|---|---|
| 0 | 成功 | 已同步 / 无需推送 / 已推送 N 个提交 |
| 1 | git 操作失败或 rebase 冲突 | 不在 git 仓库；fetch 失败（凭据/网络）；fetch 后远端跟踪分支缺失；rebase 冲突（已自动 abort）；push 失败；ls-remote 取不到 hash；**node 启动器另有**：找不到 bash、找不到 `.sh`、bash 被信号终止 |
| 2 | 工作区脏 | 仅非 dry-run；dry-run 下只报告不退出 |
| 3 | 参数错误 | 未知参数（含误传的 `--`）、`-r`/`-b` 缺值 |

## 6. 提交前闸门（提交 / 推送前必须全绿）

1. `pnpm typecheck` —— 0 错；
2. `pnpm smoke` —— core-smoke / mechanism-smoke / webui-smoke / client-sim-smoke 全绿（`pnpm smoke` 一次跑这四个；也可分别 `pnpm smoke:core` 等）；
3. 提交信息用**中文**写进文件，再 `git commit -F <文件>`（不要用 `-m` 传长消息，避免引号/换行问题）；
4. 全部通过后，再跑 `pnpm git:sync` 推送。

## 7. 常用场景示例

### 7.1 日常同步（先看计划再执行）

```bash
pnpm git:sync --dry-run   # 看 ahead/behind 与计划
pnpm git:sync             # 确认后真正同步 + 推送
```

### 7.2 只预演，不写任何东西

```bash
pnpm git:sync --dry-run
# 或 bash scripts/git-sync-push.sh --dry-run
# 或 "C:\Program Files\Git\bin\bash.exe" scripts/git-sync-push.sh --dry-run
```

### 7.3 指定远端 / 分支

```bash
pnpm git:sync --dry-run -r origin -b main
bash scripts/git-sync-push.sh --dry-run -r origin -b main
```

### 7.4 工作区脏时

脚本拒绝执行（exit 2）：先提交或 stash；只想看计划就加 `--dry-run`。

### 7.5 rebase 冲突时

脚本自动 abort 并列出冲突文件，仓库回到 rebase 前状态；手工解决冲突后重跑 `pnpm git:sync`。

### 7.6 push 认证失败时

不要改 git config / remote URL；检查 `~/.git-credentials` 是否有 `zrynas.7766.org%3a8418` 条目。脚本用的就是「先清空 helper 再 store」写法（§4.1）。

## 8. 实测记录（2026-11-18）

环境：Windows，pnpm 12.3.4，node v22.18.0，HEAD `897a023`（`feat(rounds-15-20): 面板注册自愈 / 中枢 composer 与侧栏 / 记忆记录形态 / 分支问题上交`），工作区有 22 条既有未提交改动（lib/ src/，本文档未触碰）。

| 入口 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| node 版预演 | `pnpm git:sync --dry-run` | 0 | ahead=0 behind=0，结论「已同步（本地与远端一致）」 |
| node 直跑 | `node scripts/git-sync-push.mjs --dry-run` | 0 | 同上 |
| bash 全路径 | `"C:\Program Files\Git\bin\bash.exe" scripts/git-sync-push.sh --dry-run` | 0 | 同上 |
| bash 带参 | `bash scripts/git-sync-push.sh --dry-run -r origin -b main` | 0 | 同上 |
| pnpm 带参 | `pnpm git:sync --dry-run -r origin -b main` | 0 | 同上 |
| pnpm 误加 `--` | `pnpm git:sync -- --dry-run` | **3** | 「ERROR: 未知参数: --」（pnpm 12 透传了分隔符，见 §1.1） |
| PowerShell 直跑 bash | `bash scripts/git-sync-push.sh --dry-run` | 命令不存在 | 「术语 'bash' 不会被识别为…」，见 §4.2 |

以上 dry-run 本地 HEAD 与远端 `origin/main` 均为 `897a02357b85a4a1a1813af56d7287c43192c405`。

dry-run 输出样例（节选）：

```text
=== git-sync-push: remote=origin branch=main dry-run=1 ===
--- 工作区检查
工作区有未提交改动（22 条）:
     M lib/client.js
    ... 另有 12 条未显示
(--dry-run: 仅报告，不退出)
--- fetch origin
--- 相对 origin/main: ahead=0 behind=0
behind=0，无需 rebase
ahead=0，无需 push
--- 核对远端权威 hash（git ls-remote）

===== 摘要 =====
本地 HEAD       : 897a02357b85a4a1a1813af56d7287c43192c405
远端 origin/main: 897a02357b85a4a1a1813af56d7287c43192c405
ahead/behind    : 0 / 0
结论            : 已同步（本地与远端一致）
```

## 9. 相关 skill

本流程已固化为本地 skill `git-sync-supermemory`（路由指令：命中「同步 git / 提交推送 / git sync / 检查未提交文件并推送」类请求时，引导走本脚本 + 本文档）。
