#!/usr/bin/env bash
# remote-control · 停止全链路
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
# shellcheck disable=SC1091  # 运行时环境文件
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"
: "${RC_LISTEN:=127.0.0.1:4080}"

for name in watchdog cloudflared caddy auth; do
  f="$RC_HOME/run/$name.pid"
  if [ -f "$f" ]; then
    pid="$(cat "$f")"
    if kill "$pid" 2>/dev/null; then
      echo "[dsh-web] stopped $name (pid $pid)"
    else
      echo "[dsh-web] $name 未在运行"
    fi
    rm -f "$f"
  fi
done

# 兜底：精确匹配命令行清理残留（仅本用户的隧道/反代进程）
if pkill -f "cloudflared tunnel --url http://$RC_LISTEN" 2>/dev/null; then
  echo "[dsh-web] 清理残留 cloudflared"
fi
exit 0
