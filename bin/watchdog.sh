#!/usr/bin/env bash
# remote-control · 看门狗（由 up.sh 拉起，随 cloudflared 退出而退出）
# 监测三类事件并推送飞书：URL 变化 / 隧道进程退出 / 上游不可达与恢复
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091  # 运行时环境文件，路径随安装位置变化
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"
: "${RC_UPSTREAM:=127.0.0.1:3080}"

LAST_URL="$(cat "$RC_HOME/run/url" 2>/dev/null || echo '')"
LAST_DOWN=0
GATE_DOWN=0

echo "$(date '+%F %T') watchdog started" >> "$RC_HOME/logs/watchdog.log"
while true; do
  sleep 30

  # 1) 隧道进程退出 → 通知后自身退出（下次 up.sh 重新拉起）
  if [ -f "$RC_HOME/run/cloudflared.pid" ] && ! kill -0 "$(cat "$RC_HOME/run/cloudflared.pid")" 2>/dev/null; then
    echo "$(date '+%F %T') cloudflared 进程退出" >> "$RC_HOME/logs/watchdog.log"
    "$REPO_DIR/bin/notify-feishu.sh" "remote.down（隧道进程退出）"
    exit 0
  fi

  # 1.5) 密码门组件（caddy/auth）退出 → 隧道仍在、公网全 502，必须单独报；
  #      各只报一次，恢复（dsh-web start 自愈或人工拉起）后复位可再报
  DEAD=""
  for comp in caddy auth; do
    f="$RC_HOME/run/$comp.pid"
    if [ -f "$f" ] && ! kill -0 "$(cat "$f")" 2>/dev/null; then
      DEAD="$DEAD $comp"
    fi
  done
  if [ -n "$DEAD" ] && [ "$GATE_DOWN" = "0" ]; then
    echo "$(date '+%F %T') 密码门组件退出:$DEAD" >> "$RC_HOME/logs/watchdog.log"
    # ${DEAD} 显式定界：bash 3.2 会把后面紧跟的多字节字符吞进变量名
    "$REPO_DIR/bin/notify-feishu.sh" "remote.down（密码门组件退出:${DEAD}）"
    GATE_DOWN=1
  elif [ -z "$DEAD" ] && [ "$GATE_DOWN" = "1" ]; then
    GATE_DOWN=0
  fi

  # 2) Quick Tunnel URL 变化（断线重连后可能换新地址）
  URL="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$RC_HOME/logs/cloudflared.log" 2>/dev/null | tail -1)"
  if [ -n "$URL" ] && [ "$URL" != "$LAST_URL" ]; then
    echo "$URL" > "$RC_HOME/run/url"
    "$REPO_DIR/bin/notify-feishu.sh" "remote.changed" "$URL"
    LAST_URL="$URL"
  fi

  # 3) 上游不可达 / 恢复（各只推一次，避免刷屏）
  CODE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$RC_UPSTREAM/" 2>/dev/null || echo 000)"
  if [ "$CODE" = "000" ] && [ "$LAST_DOWN" = "0" ]; then
    "$REPO_DIR/bin/notify-feishu.sh" "remote.down（上游 $RC_UPSTREAM 不可达）"
    LAST_DOWN=1
  elif [ "$CODE" != "000" ] && [ "$LAST_DOWN" = "1" ]; then
    "$REPO_DIR/bin/notify-feishu.sh" "remote.recovered（上游已恢复）"
    LAST_DOWN=0
  fi
done
