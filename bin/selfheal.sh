#!/usr/bin/env bash
# remote-control · 自愈执行器（由看门狗拉起，带退避重试调 up.sh）
# 每次尝试跑完整的 up.sh（含半死状态清理、DSH 自动拉起、隧道重建、
# 就绪校验）；成功后 up.sh 自己落盘新 URL 并推 remote.started 卡片。
# 全部尝试失败 → 写 run/heal-failed 进入冷却（看门狗停止自动重试、不再
# 重复告警），推 remote.down 转人工；dsh-web start 成功后自动解除冷却。
# 人工停止（run/stopped）优先于自愈：尝试前检查，up.sh 内部里程碑也会
# 检查（RC_SELFHEAL=1 语义，见 up.sh）；人工 dsh-web start 持有启动锁时让路。
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 公共库：is_proc/alive_as/component_pattern（组件→命令行特征单一事实源）
# shellcheck disable=SC1091  # 仓库内公共库，路径随安装位置变化
. "$REPO_DIR/bin/common.sh"
# shellcheck disable=SC1091  # 运行时环境文件，路径随安装位置变化
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"

LOG="$RC_HOME/logs/selfheal.log"
mkdir -p "$RC_HOME/logs" "$RC_HOME/run"
log() { echo "$(date '+%F %T') selfheal: $*" >> "$LOG"; }

# 原子认领（noclobber）：防看门狗误双拉 / 双自愈并发；残留 pid（持有者已死）清除后重认领
claim() {
  if (set -o noclobber; echo $$ > "$RC_HOME/run/selfheal.pid") 2>/dev/null; then
    return 0
  fi
  local p
  p="$(cat "$RC_HOME/run/selfheal.pid" 2>/dev/null || true)"
  if [ -n "$p" ] && [ "$p" != "$$" ] && kill -0 "$p" 2>/dev/null \
     && is_proc "$p" "$(component_pattern selfheal)"; then
    return 1
  fi
  # 只清自己判死的旧锁：内容已被他人更换时跳过，防误删新锁
  [ "$(cat "$RC_HOME/run/selfheal.pid" 2>/dev/null || true)" = "$p" ] || return 1
  rm -f "$RC_HOME/run/selfheal.pid"
  (set -o noclobber; echo $$ > "$RC_HOME/run/selfheal.pid") 2>/dev/null
}
if ! claim; then
  log "已有自愈在运行 (pid $(cat "$RC_HOME/run/selfheal.pid" 2>/dev/null || echo '?'))，本实例退出"
  exit 0
fi
trap 'rm -f "$RC_HOME/run/selfheal.pid"' EXIT
trap 'exit 0' TERM INT

give_up_if_stopped() {
  if [ -f "$RC_HOME/run/stopped" ]; then
    log "检测到人工停止标志，放弃自愈"
    exit 0
  fi
}

log "开始自动恢复 (pid $$)"

# 退避间隔：30s → 60s → 120s → 300s → 600s → 600s（6 次尝试，sleep 合计约 18.5 分钟，
# 另加每次 up.sh 耗时）
DELAYS=(30 60 120 300 600 600)
i=0
skips=0
while [ "$i" -lt 6 ]; do
  give_up_if_stopped
  # 人工 dsh-web start 进行中（持有启动锁）→ 让路等待，不计入失败次数
  if [ -f "$RC_HOME/run/starting" ]; then
    p="$(cat "$RC_HOME/run/starting" 2>/dev/null || true)"
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null \
       && is_proc "$p" "$(component_pattern up)"; then
      skips=$((skips + 1))
      if [ "$skips" -ge 60 ]; then
        log "启动锁被长期占用，本次自愈放弃"
        exit 1
      fi
      sleep 10
      continue
    fi
    # 只清自己判死的旧锁：内容已被他人更换时跳过，防误删新锁
    [ "$(cat "$RC_HOME/run/starting" 2>/dev/null || true)" = "$p" ] && rm -f "$RC_HOME/run/starting"
  fi
  log "第 $((i+1))/6 次尝试 up.sh ..."
  skips=0 # 让路计数按次复位：上限只约束单次锁占用内的连续等待
  RC_SELFHEAL=1 "$REPO_DIR/bin/up.sh" >>"$LOG" 2>&1
  rc=$?
  case "$rc" in
    0)
      log "恢复成功（第 $((i+1)) 次尝试）"
      rm -f "$RC_HOME/run/heal-failed"
      exit 0
      ;;
    80)
      # up.sh 检测到人工停止标志而中止：不算失败，安静退出
      log "up.sh 报告人工停止，放弃自愈"
      exit 0
      ;;
    75)
      # 预检与调用之间锁被新的启动占走：让路等待，不计失败
      skips=$((skips + 1))
      if [ "$skips" -ge 60 ]; then
        log "启动锁被长期占用，本次自愈放弃"
        exit 1
      fi
      log "启动锁被占用，10s 后重新尝试"
      sleep 10
      continue
      ;;
  esac
  log "第 $((i+1)) 次尝试失败 (exit $rc)"
  [ "$i" -lt 5 ] && sleep "${DELAYS[$i]}"
  i=$((i+1))
done

log "6 次尝试全部失败，写 run/heal-failed 进入冷却，转人工"
touch "$RC_HOME/run/heal-failed"
"$REPO_DIR/bin/notify-feishu.sh" "remote.down（自动恢复失败，请人工执行 dsh-web start）"
exit 1
