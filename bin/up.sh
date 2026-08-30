#!/usr/bin/env bash
# remote-control · 启动全链路：Caddy(认证) → cloudflared(Quick Tunnel) → watchdog
# 用法: bin/up.sh     停止: bin/down.sh     查看: bin/status.sh
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$RC_HOME/rc.env" ] || { echo "[dsh-web] 缺少 $RC_HOME/rc.env（先运行 scripts/install.sh）"; exit 1; }
# shellcheck disable=SC1091  # 运行时环境文件，路径随安装位置变化
. "$RC_HOME/rc.env"
: "${RC_UPSTREAM:=127.0.0.1:3080}"
: "${RC_LISTEN:=127.0.0.1:4080}"

# 优先使用 RC_HOME/bin 下的官方二进制（install.sh 下载），其次系统 PATH
export PATH="$RC_HOME/bin:$PATH"

for cmd in caddy cloudflared; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "[dsh-web] 未安装 $cmd（先运行 scripts/install.sh）"; exit 1; }
done
[ -f "$RC_HOME/password.bcrypt" ] || "$REPO_DIR/scripts/gen-password.sh" >/dev/null

mkdir -p "$RC_HOME/logs" "$RC_HOME/run"
[ -f "$RC_HOME/Caddyfile" ] || cp "$REPO_DIR/etc/Caddyfile" "$RC_HOME/Caddyfile"

# 本机服务与 cloudflared 都不需要代理；环境里的死代理只会坏事
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

# 认证服务密钥（HMAC 会话签名）
[ -f "$RC_HOME/session.secret" ] || {
  openssl rand -hex 32 > "$RC_HOME/session.secret"
  chmod 600 "$RC_HOME/session.secret"
}

if [ -f "$RC_HOME/run/caddy.pid" ] && kill -0 "$(cat "$RC_HOME/run/caddy.pid")" 2>/dev/null; then
  echo "[dsh-web] 已在运行"
echo "[dsh-web]   查看状态: dsh-web status | 重启: dsh-web restart | 停止: dsh-web stop"
  exit 0
fi

# Caddyfile 通过 {env.*} 占位符读取以下变量；RC_TOKEN 即会话 Cookie 令牌
export RC_LOG_DIR="$RC_HOME/logs"
export RC_UPSTREAM RC_LISTEN
RC_TOKEN="$(cat "$RC_HOME/session.secret")"
export RC_TOKEN

nohup python3 "$REPO_DIR/bin/auth-server.py" >>"$RC_HOME/logs/auth.log" 2>&1 &
echo $! > "$RC_HOME/run/auth.pid"

nohup caddy run --config "$RC_HOME/Caddyfile" --adapter caddyfile \
  >>"$RC_HOME/logs/caddy.stdout.log" 2>&1 &
echo $! > "$RC_HOME/run/caddy.pid"

# 清空旧隧道日志，避免 URL 解析抓到上一次连接的旧地址
: > "$RC_HOME/logs/cloudflared.log"

nohup cloudflared tunnel --url "http://$RC_LISTEN" --no-autoupdate \
  >>"$RC_HOME/logs/cloudflared.log" 2>&1 &
echo $! > "$RC_HOME/run/cloudflared.pid"

nohup "$REPO_DIR/bin/watchdog.sh" >>"$RC_HOME/logs/watchdog.log" 2>&1 &
echo $! > "$RC_HOME/run/watchdog.pid"

# 等待 Quick Tunnel 分配 URL（最长 45s）
URL=""
i=0
while [ $i -lt 45 ]; do
  URL="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$RC_HOME/logs/cloudflared.log" 2>/dev/null | tail -1)"
  [ -n "$URL" ] && break
  sleep 1
  i=$((i + 1))
done
if [ -z "$URL" ]; then
  echo "[dsh-web] ✗ 45s 内未获取到隧道 URL，排查: tail -50 $RC_HOME/logs/cloudflared.log"
  exit 1
fi
echo "$URL" > "$RC_HOME/run/url"
"$REPO_DIR/bin/notify-feishu.sh" "remote.started" "$URL" || true

echo "[dsh-web] ✅ 远程入口: $URL"
echo "[dsh-web]    密码: $(cat "$RC_HOME/password" 2>/dev/null || echo '(见 ~/.remote-control/password)')"
echo "[dsh-web]    通知: $([ -n "${RC_FEISHU_OPEN_ID:-}" ] || [ -n "${RC_FEISHU_WEBHOOK:-}" ] && echo 已推送飞书 || echo '未配置（rc.env 里填 RC_FEISHU_OPEN_ID）')"
