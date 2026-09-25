#!/usr/bin/env bash
# remote-control · 停止全链路（逐组件报告 + 终态校验）
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 公共库：is_proc/alive_as/component_pattern（组件→命令行特征单一事实源）
# shellcheck disable=SC1091  # 仓库内公共库，路径随安装位置变化
. "$REPO_DIR/bin/common.sh"
# shellcheck disable=SC1091  # 运行时环境文件
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"
: "${RC_LISTEN:=127.0.0.1:4080}"

echo "[dsh-web] 停止 remote control 链路 ..."
# 先落人工停止标志：常驻看门狗收到 TERM 时据此退出（而不是忽略信号继续守护）；
# up.sh 内部清理走 RC_INTERNAL_STOP=1，不落标志、也不触碰看门狗
if [ "${RC_INTERNAL_STOP:-0}" != "1" ]; then
  mkdir -p "$RC_HOME/run"
  touch "$RC_HOME/run/stopped"
fi

# selfheal 必须先杀其子 up.sh 再杀自身：bash 对前台子进程的信号是延迟的，
# 只 TERM selfheal 的话孤儿 up.sh 会在 stop 后继续拉起组件（撤销人工停止）。
# pid 文件先做身份校验（防 pid 复用把 TERM 打给无辜进程），且只杀命令行
# 匹配 up 组件特征的子进程——selfheal 的其他子进程（如退避 sleep）不碰
SPID="$(cat "$RC_HOME/run/selfheal.pid" 2>/dev/null || true)"
if [ -n "$SPID" ] && kill -0 "$SPID" 2>/dev/null && is_proc "$SPID" "$(component_pattern selfheal)"; then
  for cpid in $(pgrep -P "$SPID" 2>/dev/null); do
    [ "$cpid" = "$$" ] && continue
    is_proc "$cpid" "$(component_pattern up)" || continue
    kill "$cpid" 2>/dev/null || true
  done
  kill "$SPID" 2>/dev/null || true
  wi=0
  while [ "$wi" -lt 5 ] && kill -0 "$SPID" 2>/dev/null; do
    sleep 1
    wi=$((wi + 1))
  done
  # selfheal 处于退避 sleep（最长 600s）时 TERM 会延迟到 sleep 结束才生效，
  # 5s 等不到就升级 SIGKILL（selfheal 的 pid 文件由其 trap/下方循环清理）
  if kill -0 "$SPID" 2>/dev/null; then
    echo "[dsh-web] ⚠ selfheal (pid $SPID) 未在 5s 内退出，升级 SIGKILL"
    kill -9 "$SPID" 2>/dev/null || true
  else
    echo "[dsh-web]   selfheal  已停止 (pid $SPID)"
  fi
fi

for name in watchdog selfheal cloudflared caddy auth; do
  if [ "$name" = "watchdog" ] && [ "${RC_INTERNAL_STOP:-0}" = "1" ]; then
    # 内部清理不触碰常驻看门狗：它会对无 stopped 标志的 TERM 免疫，
    # 保留它正好接管清理后重建的链路（如实报告，不谎称已停止）
    echo "[dsh-web]   watchdog  保留（内部清理不触碰常驻看门狗）"
    continue
  fi
  f="$RC_HOME/run/$name.pid"
  pat="$(component_pattern "$name")" || { echo "[dsh-web]   $name  未知组件，跳过"; continue; }
  if [ -f "$f" ]; then
    pid="$(cat "$f")"
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[dsh-web]   $name  进程已不在 (pid $pid)"
    elif ! is_proc "$pid" "$pat"; then
      echo "[dsh-web]   $name  pid $pid 已被其他进程复用，跳过"
    elif kill "$pid" 2>/dev/null; then
      echo "[dsh-web]   $name  已停止 (pid $pid)"
    else
      echo "[dsh-web]   $name  进程已不在 (pid $pid)"
    fi
    rm -f "$f"
  else
    echo "[dsh-web]   $name  未在运行"
  fi
done

# 兜底：精确匹配命令行清理残留（仅本用户的隧道/反代进程）。
# run 参数用空白+结尾锚定，避免隧道名子串误伤（t1 命中 run t12）
# Quick Tunnel: cloudflared tunnel --url ...
# Named Tunnel: cloudflared tunnel --no-autoupdate [--protocol http2] run <name>
if pkill -f "cloudflared tunnel --url http://$RC_LISTEN --no-autoupdate" 2>/dev/null; then
  echo "[dsh-web]   清理残留 cloudflared (Quick Tunnel)"
fi
if [ -n "${RC_TUNNEL_NAME:-}" ]; then
  if pkill -f "cloudflared tunnel --no-autoupdate.*[[:space:]]run ${RC_TUNNEL_NAME}([[:space:]]|\$)" 2>/dev/null; then
    echo "[dsh-web]   清理残留 cloudflared (Named Tunnel: $RC_TUNNEL_NAME)"
  fi
fi

sleep 1
# 终态校验：端口已释放且无残留进程才算真停。
# auth 用完整路径匹配，避免编辑器/日志里出现 "auth-server.py" 字样时误报
check_leftover() {
  pgrep -f "caddy run --config $RC_HOME/Caddyfile" 2>/dev/null
  pgrep -f "cloudflared tunnel --url http://$RC_LISTEN" 2>/dev/null
  # Named Tunnel 残留检查
  if [ -n "${RC_TUNNEL_NAME:-}" ]; then
    pgrep -f "cloudflared tunnel --no-autoupdate.*[[:space:]]run ${RC_TUNNEL_NAME}([[:space:]]|\$)" 2>/dev/null
  fi
  pgrep -f "python3.*$REPO_DIR/bin/auth-server.py" 2>/dev/null
}
leftover="$(check_leftover)"
if [ -n "$leftover" ]; then
  echo "[dsh-web]   残留进程未响应 TERM，升级为 SIGKILL ..."
  while IFS= read -r pid; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  done <<EOF
$leftover
EOF
  sleep 1
  leftover="$(check_leftover)"
fi
if [ -n "$leftover" ] || lsof -nP -iTCP:"${RC_LISTEN##*:}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[dsh-web] ⚠ 校验未通过：仍有组件存活（pid: $(echo "$leftover" | tr '\n' ' ')）"
  echo "[dsh-web]   可再次执行 dsh-web stop，或 dsh-web logs all 排查"
  exit 1
fi
echo "[dsh-web] ✓ 已全部停止（端口 ${RC_LISTEN##*:} 已释放，校验通过）"
