#!/usr/bin/env bash
# remote-control · 状态查看：三组件进程 / 认证墙 / 上游 / 当前 URL / 最近通知
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 公共库：is_proc/alive_as/component_pattern（组件→命令行特征单一事实源）
# shellcheck disable=SC1091  # 仓库内公共库，路径随安装位置变化
. "$REPO_DIR/bin/common.sh"
# shellcheck disable=SC1091  # 运行时环境文件，路径随安装位置变化
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"
: "${RC_UPSTREAM:=127.0.0.1:3080}"
: "${RC_LISTEN:=127.0.0.1:4080}"
export PATH="$RC_HOME/bin:$PATH"

echo "=== remote control ==="
for name in caddy cloudflared watchdog selfheal auth; do
  f="$RC_HOME/run/$name.pid"
  pat="$(component_pattern "$name")"
  pid="$(cat "$f" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && is_proc "$pid" "$pat"; then
    printf '  %-11s %s\n' "$name" "running (pid $pid)"
  else
    printf '  %-11s %s\n' "$name" "stopped"
  fi
done
# 运行态标志（与 watchdog/up.sh/selfheal 的握手协议对应）
[ -f "$RC_HOME/run/starting" ] && \
  echo "  note        启动进行中 (up.sh pid $(cat "$RC_HOME/run/starting" 2>/dev/null || echo '?'))"
[ -f "$RC_HOME/run/heal-failed" ] && \
  echo "  note        自愈冷却中（自动恢复失败，请人工执行 dsh-web start）"
[ -f "$RC_HOME/run/stopped" ] && \
  echo "  note        人工停止标志存在（watchdog 待命）"

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

# 认证墙：未带 Cookie 应 302 到登录页
CODE_GATE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$RC_LISTEN/" 2>/dev/null || true)"
echo "  local-gate  http://$RC_LISTEN -> HTTP $CODE_GATE (302 = wall on)"
if [ "$CODE_GATE" = "302" ] && [ -f "$RC_HOME/password" ]; then
  PW="$(cat "$RC_HOME/password")"
  JAR="$(mktemp)"
  curl -s -m 5 -c "$JAR" -o /dev/null --data-urlencode "pw=$PW" --data "next=/" "http://$RC_LISTEN/rc-login"
  CODE_OK="$(curl -s -b "$JAR" -o /dev/null -m 5 -w '%{http_code}' "http://$RC_LISTEN/" 2>/dev/null || true)"
  rm -f "$JAR"
  echo "  login+gate  -> HTTP $CODE_OK (2xx/3xx = upstream ok)"
fi
CODE_UP="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$RC_UPSTREAM/" 2>/dev/null || true)"
echo "  upstream    http://$RC_UPSTREAM -> HTTP $CODE_UP"

URL="$(cat "$RC_HOME/run/url" 2>/dev/null || echo '')"
echo "  public-url  ${URL:-<not running>}"

if [ -f "$RC_HOME/logs/notify.log" ]; then
  echo "  notify-log  $(tail -2 "$RC_HOME/logs/notify.log" | tr '\n' '|')"
fi
