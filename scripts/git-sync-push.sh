#!/usr/bin/env bash
# git-sync-push.sh — 本仓库（SuperMemory）的一站式 git 同步与推送脚本
#
# 用途:
#   一次跑完「工作区检查 -> fetch -> rebase -> push -> 远端 hash 核对」，
#   并把本机 Git 凭据的坑封装掉：本机全局没有 credential.helper，但
#   Git Credential Manager(manager) 通过 helperselector 接管了
#   zrynas.7766.org:8418 的认证且失败，所以必须「先清空 helper 列表，再只用 store」:
#       GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper=store <子命令>
#   凭据存放于 ~/.git-credentials（host 条目 zrynas.7766.org%3a8418）。
#
# 用法:
#   bash scripts/git-sync-push.sh [-n|--dry-run] [-r|--remote <name>] [-b|--branch <name>]
#   pnpm git:sync                      # 与上一行等价
#   pnpm git:sync -- --dry-run         # 注意：pnpm 下参数必须用 -- 分隔，才会透传给本脚本
#
#   -n, --dry-run  只 fetch + 比对 + 打印计划；不写任何 ref、不改工作区、不 push
#   -r, --remote   远端名，默认 origin
#   -b, --branch   分支名，默认 main
#   -h, --help     打印本帮助
#
# 安全约束:
#   工作区有未提交改动时拒绝执行（退出码 2），不 stash、不自动提交；
#   behind>0 时用 git rebase（绝不 merge）；rebase 失败自动 rebase --abort 并打印冲突文件；
#   push 失败原样报错退出，不重试、不改 git config、不改 remote URL；
#   绝不使用 git reset --hard / git checkout -- / git clean -fd / push --force。
#
# 退出码:
#   0  成功（已同步 / 无需推送 / 已推送 N 个提交）
#   1  fetch、rebase（含冲突）、push 或其它 git 操作失败
#   2  工作区有未提交改动（--dry-run 下仅报告，不退出）
#   3  参数错误
#
set -euo pipefail

usage() {
  cat <<'USAGE'
用法: bash scripts/git-sync-push.sh [-n|--dry-run] [-r|--remote <name>] [-b|--branch <name>]

  -n, --dry-run  只 fetch + 比对 + 打印计划，不做任何写操作（不 rebase、不 push）
  -r, --remote   远端名，默认 origin
  -b, --branch   分支名，默认 main
  -h, --help     打印本帮助

退出码: 0 成功 / 1 git 操作失败或 rebase 冲突 / 2 工作区脏 / 3 参数错误
USAGE
}

REMOTE=origin
BRANCH=main
DRY_RUN=0
PUSHED=0

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    -r|--remote)
      [ $# -ge 2 ] || { echo "ERROR: $1 需要一个远端名" >&2; usage >&2; exit 3; }
      REMOTE="$2"; shift ;;
    -b|--branch)
      [ $# -ge 2 ] || { echo "ERROR: $1 需要一个分支名" >&2; usage >&2; exit 3; }
      BRANCH="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: 未知参数: $1" >&2; usage >&2; exit 3 ;;
  esac
  shift
done

# 所有需要网络的 git 调用统一走这个数组：
# 先用 credential.helper= 清空 helper 列表（避开 GCM/manager），再用 store（读 ~/.git-credentials）。
export GIT_TERMINAL_PROMPT=0
GIT=(git -c credential.helper= -c credential.helper=store)

if ! ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "ERROR: 当前目录不在 git 仓库内。" >&2
  exit 1
fi
cd "$ROOT"
UPSTREAM="$REMOTE/$BRANCH"

echo "=== git-sync-push: remote=$REMOTE branch=$BRANCH dry-run=$DRY_RUN ==="

# ---------- a. 工作区检查 ----------
echo "--- 工作区检查"
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then
  count="$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"
  echo "工作区有未提交改动（$count 条）:"
  printf '%s\n' "$dirty" | sed -n '1,10p' | sed 's/^/    /'
  if [ "$count" -gt 10 ]; then
    echo "    ... 另有 $((count - 10)) 条未显示"
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    echo "ERROR: 工作区不干净，拒绝执行（不自动 stash、不自动提交）。" >&2
    echo "       请先提交或 stash 后重试；只想看计划请加 --dry-run。" >&2
    exit 2
  fi
  echo "(--dry-run: 仅报告，不退出)"
else
  echo "工作区干净"
fi

# ---------- b. fetch ----------
echo "--- fetch $REMOTE"
if ! "${GIT[@]}" fetch "$REMOTE" --prune; then
  echo "ERROR: fetch 失败（凭据或网络问题）。" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "refs/remotes/$UPSTREAM" >/dev/null; then
  echo "ERROR: fetch 后找不到远端跟踪分支 $UPSTREAM。" >&2
  exit 1
fi

# ---------- c. 计算 ahead/behind ----------
read -r BEHIND AHEAD <<<"$(git rev-list --left-right --count "$UPSTREAM...HEAD")"
echo "--- 相对 $UPSTREAM: ahead=$AHEAD behind=$BEHIND"

# ---------- d. rebase ----------
if [ "$BEHIND" -gt 0 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "计划: 需要 git rebase $UPSTREAM（behind=$BEHIND）"
    if [ "$AHEAD" -gt 0 ]; then
      echo "      将重放的本地提交（$AHEAD 个，旧 -> 新）:"
      git log --oneline --reverse "$UPSTREAM..HEAD" | sed 's/^/        /'
    fi
  else
    echo "--- rebase onto $UPSTREAM"
    if ! git rebase "$UPSTREAM"; then
      echo "冲突文件清单:" >&2
      git diff --name-only --diff-filter=U >&2 || true
      git rebase --abort || true
      echo "ERROR: rebase 失败，已 git rebase --abort 回滚到 rebase 前状态。" >&2
      exit 1
    fi
    read -r BEHIND AHEAD <<<"$(git rev-list --left-right --count "$UPSTREAM...HEAD")"
    echo "--- rebase 完成: ahead=$AHEAD behind=$BEHIND"
  fi
else
  echo "behind=0，无需 rebase"
fi

# ---------- e. push ----------
if [ "$AHEAD" -gt 0 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "计划: 需要 git push $REMOTE $BRANCH（ahead=$AHEAD）"
    echo "      将推送的提交:"
    git log --oneline "$UPSTREAM..HEAD" | sed 's/^/        /'
  else
    echo "--- push $REMOTE $BRANCH"
    if ! "${GIT[@]}" push "$REMOTE" "$BRANCH"; then
      echo "ERROR: push 失败（原样报错见上）。未重试、未改 git config、未改 remote URL。" >&2
      exit 1
    fi
    PUSHED="$AHEAD"
  fi
else
  echo "ahead=0，无需 push"
fi

# ---------- f. 用 ls-remote 取远端权威 hash 并输出摘要 ----------
echo "--- 核对远端权威 hash（git ls-remote）"
REMOTE_HASH="$("${GIT[@]}" ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk 'NR==1 {print $1}')"
LOCAL_HASH="$(git rev-parse HEAD)"
if [ -z "${REMOTE_HASH:-}" ]; then
  echo "ERROR: 无法从 $REMOTE 取到 refs/heads/$BRANCH 的 hash。" >&2
  exit 1
fi
read -r BEHIND AHEAD <<<"$(git rev-list --left-right --count "$UPSTREAM...HEAD")"

if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
  CONCLUSION="已同步（本地与远端一致）"
elif [ "$DRY_RUN" -eq 1 ]; then
  CONCLUSION="dry-run: 待处理 ahead=$AHEAD behind=$BEHIND（未执行任何写操作）"
elif [ "$PUSHED" -gt 0 ]; then
  CONCLUSION="已推送 $PUSHED 个提交"
else
  CONCLUSION="无需推送（ahead=0）"
fi

echo
echo "===== 摘要 ====="
printf '本地 HEAD       : %s\n' "$LOCAL_HASH"
printf '远端 %-11s: %s\n' "$UPSTREAM" "$REMOTE_HASH"
printf 'ahead/behind    : %s / %s\n' "$AHEAD" "$BEHIND"
printf '结论            : %s\n' "$CONCLUSION"
