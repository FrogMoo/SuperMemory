# git 同步 / 提交 / 推送流程（SuperMemory 仓库 · 流程固化样板）

> **⚠️ 遇到本仓库的 git 同步、提交、推送类问题，优先使用 `scripts/git-sync-push`，不要手敲 `git fetch` / `git rebase` / `git push`。**
> 凭据说明（2026-11-19 现状）：网络 git 调用直接用仓库本地配置的 Git Credential Manager（GCM / manager，见 §4.1），凭据由 Windows 凭据存储托管。先 `--dry-run` 看计划，确认后再真跑。
> 推送说明（2026-11-23 起）：`origin` 配双 push URL——GitHub（`github.com/FrogMoo/SuperMemory.git`，排首位）+ 内网 Gitee；fetch/pull 仍只走 Gitee。Gitee 侧 2026-11-23 已恢复：帐号/仓库重建为 `Zry/SuperMemory`（旧 `旧帐号名` 路径 307 跳转到新路径），双远程推送实测恢复（见 §4.6）。

- 适用范围：本仓库（固化能力的 `scope` 由插件位置自动推导，不再硬编码克隆路径；换机器/换目录自动跟随）
- 远端（2026-11-23 Gitee 恢复后，详见 §4.6）：
  - `origin` 的 fetch URL（主远程；pull / rebase / 跟踪分支只走它）= 内网 Gitee `http://zrynas.7766.org:8418/Zry/SuperMemory.git`
  - `origin` 的 push URL（两个，按序尝试）= ① GitHub `https://github.com/FrogMoo/SuperMemory.git`（排首位）② 上述 Gitee
  - 独立远程 `github` = `https://github.com/FrogMoo/SuperMemory.git`（fetch/push 同 URL，用于单推 GitHub）
  - 默认分支 `main`
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
| bash 定位 | 要求调用方环境里 bash 可用（PATH） | 自动探测，顺序：`$SM_BASH` → 由 `where git` 推导 `<git 根>/bin/bash.exe` → `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\Git\bin\bash.exe` → `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` → 非 Windows 的 `sh`/`bash` → `where bash` 结果（**排除 WSL 启动器** `<SystemRoot>\System32\bash.exe`）；每个候选都用 `bash -c "exit 0"` **和** `bash -c "test -f <脚本绝对路径>"` 双实测，确保它真的看得见本脚本（R27，见 §4.2b） |
| 独有失败模式 | 无 | ① 找不到 bash → exit 1；② 找不到 `.sh` → exit 1；③ bash 被信号终止 → exit 1 |
| cwd 要求 | 仓库内任意目录（自身 `cd` 到 toplevel） | 任意目录（按自身文件位置定位 `.sh`） |

结论：二者行为一致（`.mjs` 就是 `.sh` 的外壳），差异只在 bash 定位与三个启动器独有失败模式。

## 3. 流程步骤（`.sh` 内部顺序）

1. **工作区检查**：`git status --porcelain`。有未提交改动时：非 dry-run → 打印前 10 条并 exit 2；dry-run → 仅报告，继续。
2. **fetch**：`GIT_TERMINAL_PROMPT=0 git fetch <remote> --prune`（凭据由仓库本地 GCM 提供）。失败 → exit 1。
3. **校验远端跟踪分支**：fetch 后 `refs/remotes/<remote>/<branch>` 必须存在，否则 exit 1。
4. **计算 ahead/behind**：`git rev-list --left-right --count <remote>/<branch>...HEAD`。
5. **rebase（仅 behind>0，绝不 merge）**：`git rebase <remote>/<branch>`；冲突 → 打印冲突文件清单（`git diff --name-only --diff-filter=U`）+ 自动 `git rebase --abort` + exit 1，仓库回到 rebase 前状态。
6. **push（仅 ahead>0）**：`git push <remote> <branch>`；失败原样报错 exit 1，不重试。`origin` 配双 push URL 时这一条命令自动覆盖 GitHub + Gitee 两个仓库（顺序与失败语义见 §4.6）。
7. **ls-remote 核对**：`git ls-remote <remote> refs/heads/<branch>` 取远端权威 hash 与本地 `HEAD` 比对，打印摘要（本地 HEAD / 远端 hash / ahead/behind / 结论）。

**dry-run 的边界**：dry-run 仍会发起网络请求（fetch + ls-remote，需要凭据可用），它保证的是「不写任何 ref、不改工作区、不 rebase、不 push」，并会打印计划（将要 rebase / push 的提交列表）。

## 4. 坑与规避（全部实测）

### 4.1 凭据：仓库本地 GCM（2026-11-19 起）

- 仓库本地 `git config` 已配 Git Credential Manager：

  ```
  credential.helper=!"C:/Users/admin/AppData/Local/Programs/Git/mingw64/bin/git-credential-manager.exe"
  ```

  凭据由 Windows 凭据存储托管，网络 git 调用（fetch/push/ls-remote）**直接使用仓库配置**即可，不再额外传 `-c credential.helper=...`。
- `GIT_TERMINAL_PROMPT=0` 保留：凭据缺失时立即失败并打印真实错误，而不是卡在用户名/密码提示。
- **旧方案已失效**（2026-11-19 实测）：历史上曾用「先清空 helper 列表、再用 store 读 `~/.git-credentials`」——
  `git -c credential.helper= -c credential.helper=store fetch` 现在会报
  `fatal: could not read Username for 'http://zrynas.7766.org:8418': terminal prompts disabled`（exit 1），
  因为本机 `~/.git-credentials` 不存在。脚本已改为直接用 git，不再清空 helper。
- 脚本对应实现：`export GIT_TERMINAL_PROMPT=0` + `GIT=(git)`；**不要手敲 git push 绕过脚本**。
- GCM 也取不到凭据时：**停下来找用户要凭据或确认登录状态**；不要改全局 git config、不要改 remote URL、不要去找其他凭据方案。

### 4.2b PATH 里的 `bash` 是 WSL 启动器 → exit 127（R27 修复）

- 现象：固化能力「运行（预演）」（入口 `pnpm git:sync`）返回 `exit 127`，stderr 只有
  `/bin/bash: F:/10-SuperMemory/scripts/git-sync-push.sh: No such file or directory`
  和 `[ELIFECYCLE] Command failed with exit code 127.`。
- 根因：Windows PATH 含 `C:\Windows\System32`，那里的 `bash.exe` 是 **WSL 启动器**，
  不是 Git for Windows 的 bash。旧版 `.mjs` 候选顺序里把裸 `bash` 排在最前，命中 WSL；
  WSL 的 `/bin/bash` 看不懂 `F:/...` 盘符路径 → 127。**与 node/pnpm 是否在 PATH 无关**
  （实测宿主 PATH 同时含 `C:\Program Files
odejs` 与 `%APPDATA%
pm`，`where pnpm`
  与 `pnpm --version` 都正常）。
- 修复：`.mjs` 先按绝对路径找 Git for Windows 的 bash（由 `where git` /
  `ProgramFiles` / `LOCALAPPDATA` 推导，不硬编码盘符），排除 `<SystemRoot>\System32ash.exe`，
  并对每个候选实测「能否 `test -f` 看见本脚本」；都不行才报 exit 1 的明确错误。
- 现在 `pnpm git:sync --dry-run` 会真的跑起来（工作区检查 → fetch …），127 不再出现。
- 额外兜底（能力执行侧）：`runCapability` 用 `capabilityExecEnv()` 注入 PATH——把
  `dirname(process.execPath)`、`PNPM_HOME`、`%APPDATA%
pm`、`%ProgramFiles%
odejs`
  等**确实存在**的目录追加进 PATH（原顺序保留、去重），避免宿主启动方式差异导致子进程
  找不到 node/pnpm。

### 4.2 bash 不在 PATH（Windows cmd / PowerShell）

- 本机 PATH 只有 `C:\Program Files\Git\cmd`，`bash.exe` 在 `C:\Program Files\Git\bin`。
- cmd 下直跑报「`'bash' 不是内部或外部命令`」；PowerShell 下报「术语 'bash' 不会被识别为 cmdlet、函数、脚本文件或可执行程序的名称」（2026-11-18 实测）。
- 规避（三选一）：① 用 `pnpm git:sync`（node 版自动定位 bash，推荐）；② 全路径 `"C:\Program Files\Git\bin\bash.exe" scripts/git-sync-push.sh ...`；③ 在 Git Bash 里跑。

### 4.3 pnpm 参数透传

见 §1.1：本机 pnpm 12.3.4 下用 `pnpm git:sync --dry-run`，**不要**加 `--`（加了会 exit 3）。

### 4.4 凭据存放位置

由仓库本地 GCM（manager）托管在 **Windows 凭据存储**（控制面板 → 凭据管理器 → Windows 凭据，目标含 `zrynas.7766.org:8418`）。
本机 `~/.git-credentials` **不存在**（旧的 store 方案已失效，见 §4.1）。**不要**改全局 git config、**不要**改 remote URL 来解决认证问题。
**键的坑（2026-11-23 实测）**：Windows 凭据存储里同一个 Gitee 主机可能有**两个键**——`host=zrynas.7766.org`（配 `port=8418`）与 `host=zrynas.7766.org:8418`（端口嵌在 host 里，git http 传输实际用的就是这个）。换帐号/换口令时**两个键都要更新**，否则会出现「`git credential fill` 是新帐号、真实推送却用旧帐号」的怪现象，详见 §4.6。

### 4.5 行尾（写 .md / 文本文件时）

本仓库无 `.gitattributes`、`core.autocrlf` 未设，行尾混合。新增或修改 `.md` 时保持 **LF、无 BOM、无 CRLF**；写完用 `git diff --stat` 或 `grep -c $'\r' <file>` 自查（应为 0）。

### 4.6 双远程同时推送：GitHub + Gitee（2026-11-23 配置，2026-11-23 Gitee 恢复）

**配置形态**（`git remote -v` 实测，Gitee 恢复后）：

```text
github  https://github.com/FrogMoo/SuperMemory.git (fetch)
github  https://github.com/FrogMoo/SuperMemory.git (push)
origin  http://zrynas.7766.org:8418/Zry/SuperMemory.git (fetch)
origin  https://github.com/FrogMoo/SuperMemory.git (push)
origin  http://zrynas.7766.org:8418/Zry/SuperMemory.git (push)
```

- `origin` 仍是主远程：fetch URL 只有 Gitee，pull / rebase / `refs/remotes/origin/main` 跟踪分支全部只走 Gitee；
- `origin` 的 push URL 有两个，`pnpm git:sync` 里的 `git push origin main` **一条命令同时推两个仓库**，脚本零改动（`.sh` 不硬编码推送目标，`.mjs` 只是 bash 启动器）；
- 独立远程 `github` 用于单推 GitHub：`git push github main`。

**顺序即韧性（git 2.55.0 实测）**：git 按 push URL 顺序逐个推送，**首个 URL 失败即中止、不再尝试后续 URL**。因此把可用的 GitHub 排在第一位：Gitee 故障期间 `git push origin main` 仍能把提交推上 GitHub（打印 Gitee 报错后整体 exit 非 0），不会出现「Gitee 挂了 → 两个仓库都收不到提交」。Gitee 恢复后顺序无实际影响。

**Gitee 服务器事件时间线（2026-11-22 → 2026-11-23）**：

- **2026-11-22 晚（重置期）**：主机可达（`curl` 根路径 HTTP 200），但旧账号 `旧帐号名` 与仓库 `旧帐号名/SuperMemory` 均不存在（仓库 URL 404；`git ls-remote origin` 报 `remote: user does not exist`，exit 128）。同期在 API 侧还曾短暂出现过帐号 `旧帐号名 B`（id 8）——服务器处于切换/重建的中间态。
- **2026-11-23（恢复态，本轮实测）**：服务器已重建完成，形态是**帐号改名 + 仓库保留**：
  - 帐号：旧 `旧帐号名` 已更名为 **`Zry`**（`GET /api/v1/user`：id 1、is_admin、邮箱 437***@qq.com）；旧路径 `旧帐号名/SuperMemory` 对 `/info/refs` 返回 **307 跳转**到 `Zry/SuperMemory`（Gitea 的改名重定向）。
  - 仓库：`Zry/SuperMemory` **已存在且非空**（id 17、`private:true`、默认分支 `main`、恢复时 `refs/heads/main` = `19032bb`，即 R28 之前的历史快照）——因此**无需建仓**，推送是快进。
  - 该内网服务实例是 **Gitea**（API 为 `/api/v1/...`，响应带 `full_name`/`clone_url`/`empty` 等 Gitea 字段；`/api/v5/user` 返回 Not found）。

**Gitee 凭据的一个坑（本轮实测，重要）**：本机 git（2.55.0.windows.3）的 http 传输向凭据助手发送的是 **`host=zrynas.7766.org:8418`（端口嵌在 host 字段里，没有单独的 `port=` 行）**，而 `git credential approve/fill` 手工常用 `host=<主机>` + `port=<端口>` 的写法——两者是**不同的键**。只按后者写入新凭据时，`git credential fill` 显示新帐号，但真实 http 请求仍命中旧键上的旧帐号（表现为 `remote: Repository not found` / `Authentication failed`）。**修复**：按 http 实际使用的键各做一次 approve（并 reject 掉该键上的旧条目）：

```bash
# 1) 嵌入端口键（git http 实际使用的键）
printf 'protocol=http\nhost=zrynas.7766.org:8418\nusername=<邮箱>\npassword=<口令>\n\n' | git credential approve
printf 'protocol=http\nhost=zrynas.7766.org:8418\n\n' | git credential reject   # 清掉该键上的全部旧条目
# 2) host+port 分开的键（git credential fill 的常用写法，保持两者一致）
printf 'protocol=http\nhost=zrynas.7766.org\nport=8418\nusername=<邮箱>\npassword=<口令>\n\n' | git credential approve
```

排查手法：`git -c 'credential.helper=!<记录脚本>' ls-remote <url>` 配 `GIT_CONFIG_NOSYSTEM=1 HOME=<临时目录>`（让系统级 GCM helper 不抢先返回），即可看到助手真实收到的输入行。口令严禁落盘/进日志（记录时脱敏）。

**Gitee 恢复后的处理（本轮实做）**：仓库建在了新帐号路径下，更新两处 URL 并保持 GitHub push URL 在前：

```bash
git remote set-url origin http://zrynas.7766.org:8418/Zry/SuperMemory.git                      # fetch URL
git remote set-url --delete --push origin http://zrynas.7766.org:8418/旧帐号名/SuperMemory.git   # 删旧 Gitee push URL（同名全删）
git remote set-url --add --push origin http://zrynas.7766.org:8418/Zry/SuperMemory.git         # 加新 Gitee push URL（排在 GitHub 后）
```

注意 `set-url --delete --push` 删除**全部**同名匹配项；`set-url --add --push` 是追加，重复添加会出现重复推送（无害但不整洁）。

**实测记录（2026-11-23，Gitee 恢复轮）**：

| 操作 | 结果 |
|---|---|
| `GET /api/v1/user`（Basic 认证） | 200，`login=Zry`、id 1、is_admin、邮箱 437***@qq.com |
| `GET /api/v1/repos/Zry/SuperMemory` | 200，`private:true`、`empty:false`、默认分支 `main` |
| `git ls-remote origin`（修好凭据键后） | `2c4b898… refs/heads/main`（修复前是 `remote: Repository not found`，exit 128） |
| `git fetch origin` | exit 0，`refs/remotes/origin/main` = `19032bb`（本地 ahead 3，纯快进） |
| `git push origin main` | exit 0：GitHub `Everything up-to-date`，Gitee `19032bb..2c4b898 main -> main` |
| 三方核对 | 本地 HEAD = `origin/main` = `github main` = `2c4b898` |
| `git push --dry-run origin main` | 双路均 `Everything up-to-date`，exit 0 |

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

不要改 git config / remote URL；检查仓库本地 `credential.helper` 是否仍指向 GCM（`git config --get credential.helper`），以及 Windows 凭据存储里 `zrynas.7766.org:8418` 的条目是否是新帐号（§4.1 / §4.4——注意同一主机有两个键，见 §4.4 的「键的坑」）。脚本直接用仓库本地 GCM，不再使用 `~/.git-credentials`。GitHub 侧凭据同样由 GCM 托管（Windows 凭据存储中的 `github.com` 条目，实测用户名 FrogMoo），两个远程的凭据相互独立。若报错是 `remote: user does not exist` 或仓库 404（Gitee 侧 2026-11-22 曾被重置，2026-11-23 已恢复为 `Zry/SuperMemory`），服务器/路径问题见 §4.6 时间线。

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
