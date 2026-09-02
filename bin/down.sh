#!/usr/bin/env bash
# remote-control · 停止全链路（逐组件报告 + 终态校验）
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091  # 运行时环境文件
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"
: "${RC_LISTEN:=127.0.0.1:4080}"

echo "[dsh-web] 停止 remote control 链路 ..."
for name in watchdog cloudflared caddy auth; do
  f="$RC_HOME/run/$name.pid"
  if [ -f "$f" ]; then
    pid="$(cat "$f")"
    if kill "$pid" 2>/dev/null; then
      echo "[dsh-web]   $name  已停止 (pid $pid)"
    else
      echo "[dsh-web]   $name  进程已不在 (pid $pid)"
    fi
    rm -f "$f"
  else
    echo "[dsh-web]   $name  未在运行"
  fi
done

# 兜底：精确匹配命令行清理残留（仅本用户的隧道/反代进程）
if pkill -f "cloudflared tunnel --url http://$RC_LISTEN --no-autoupdate" 2>/dev/null; then
  echo "[dsh-web]   清理残留 cloudflared"
fi

sleep 1
# 终态校验：端口已释放且无残留进程才算真停。
# auth 用完整路径匹配，避免编辑器/日志里出现 "auth-server.py" 字样时误报
check_leftover() {
  pgrep -f "caddy run --config $RC_HOME/Caddyfile" 2>/dev/null
  pgrep -f "cloudflared tunnel --url http://$RC_LISTEN" 2>/dev/null
  pgrep -f "$REPO_DIR/bin/auth-server.py" 2>/dev/null
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
