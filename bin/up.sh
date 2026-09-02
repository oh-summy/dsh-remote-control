#!/usr/bin/env bash
# remote-control · 启动全链路（分阶段进度输出；URL 就绪后才启动看门狗）
# 阶段: 凭据 → 认证服务+Caddy 密码门 → Cloudflare 隧道(等URL) → 看门狗+通知
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$RC_HOME/rc.env" ] || { echo "[dsh-web] 缺少 $RC_HOME/rc.env（先运行 dsh-web install）"; exit 1; }
# shellcheck disable=SC1091  # 运行时环境文件，路径随安装位置变化
. "$RC_HOME/rc.env"
: "${RC_UPSTREAM:=127.0.0.1:3080}"
: "${RC_LISTEN:=127.0.0.1:4080}"

# 优先使用 RC_HOME/bin 下的官方二进制（install.sh 下载），其次系统 PATH
export PATH="$RC_HOME/bin:$PATH"

for cmd in caddy cloudflared python3; do
  # ${cmd} 显式定界：bash 3.2 会把后面紧跟的多字节字符吞进变量名
  command -v "$cmd" >/dev/null 2>&1 || { echo "[dsh-web] ✗ 未安装 ${cmd}（先运行 dsh-web install）"; exit 1; }
done

alive=0
for name in watchdog cloudflared caddy auth; do
  f="$RC_HOME/run/$name.pid"
  if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
    alive=$((alive + 1))
  fi
done
if [ "$alive" -eq 4 ]; then
  echo "[dsh-web] 已在运行"
  echo "[dsh-web]   查看状态: dsh-web status | 重启: dsh-web restart | 停止: dsh-web stop"
  exit 0
fi
if [ "$alive" -gt 0 ]; then
  # 只判 caddy 会漏掉半死状态（如隧道在、密码门崩），这里任一存活即先清场再启
  echo "[dsh-web] 检测到部分组件仍在运行，先停止残留 ..."
  "$REPO_DIR/bin/down.sh" || echo "[dsh-web] ⚠ 清理残留失败，继续尝试启动 ..."
fi

mkdir -p "$RC_HOME/logs" "$RC_HOME/run"
[ -f "$RC_HOME/Caddyfile" ] || cp "$REPO_DIR/etc/Caddyfile" "$RC_HOME/Caddyfile"

# 本机服务与 cloudflared 都不需要代理；环境里的死代理只会坏事
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

echo "[dsh-web] 1/4 检查凭据 ..."
[ -f "$RC_HOME/password" ] || "$REPO_DIR/scripts/gen-password.sh"
[ -f "$RC_HOME/session.secret" ] || {
  openssl rand -hex 32 > "$RC_HOME/session.secret"
  chmod 600 "$RC_HOME/session.secret"
}

# Caddyfile 通过 {env.*} 占位符读取以下变量；RC_TOKEN 即会话 Cookie 令牌
export RC_LOG_DIR="$RC_HOME/logs"
export RC_UPSTREAM RC_LISTEN
RC_TOKEN="$(cat "$RC_HOME/session.secret")"
export RC_TOKEN

echo "[dsh-web] 2/4 启动认证服务与 Caddy 密码门 ..."
nohup python3 "$REPO_DIR/bin/auth-server.py" >>"$RC_HOME/logs/auth.log" 2>&1 &
echo $! > "$RC_HOME/run/auth.pid"
nohup caddy run --config "$RC_HOME/Caddyfile" --adapter caddyfile \
  >>"$RC_HOME/logs/caddy.stdout.log" 2>&1 &
echo $! > "$RC_HOME/run/caddy.pid"

echo "[dsh-web] 3/4 建立 Cloudflare 隧道（Quick Tunnel，URL 每次随机）..."
# 清空旧隧道日志，避免 URL 解析抓到上一次连接的旧地址
: > "$RC_HOME/logs/cloudflared.log"
nohup cloudflared tunnel --url "http://$RC_LISTEN" --no-autoupdate \
  >>"$RC_HOME/logs/cloudflared.log" 2>&1 &
CFPID=$!
echo "$CFPID" > "$RC_HOME/run/cloudflared.pid"

# 等待 URL（最长 45s，每 10s 汇报一次剩余时间）
URL=""
i=0
while [ $i -lt 45 ]; do
  URL="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$RC_HOME/logs/cloudflared.log" 2>/dev/null | tail -1)"
  [ -n "$URL" ] && break
  kill -0 "$CFPID" 2>/dev/null || break
  i=$((i + 1))
  [ $((i % 10)) -eq 0 ] && echo "[dsh-web]   ...等待隧道 URL（剩余 $((45 - i))s）"
  sleep 1
done
if [ -z "$URL" ]; then
  echo "[dsh-web] ✗ 未获取到隧道 URL，回滚已启动的组件"
  "$REPO_DIR/bin/down.sh" >/dev/null 2>&1
  echo "[dsh-web]   排查: dsh-web logs cloudflared"
  exit 1
fi
echo "$URL" > "$RC_HOME/run/url"

# 隧道通了不等于入口可用：Caddy 配置编译失败 / 端口被占 / auth 启动崩溃时，
# 上面的 nohup 都不会报错，必须实测密码门(302)和登录服务(200)才算就绪
echo "[dsh-web] 4/4 校验本地网关 ..."
RC_AUTH_PORT="${RC_AUTH_PORT:-9091}"
GATE_CODE="000"; AUTH_CODE="000"
i=0
while [ $i -lt 15 ]; do
  GATE_CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$RC_LISTEN/" 2>/dev/null)"
  AUTH_CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$RC_AUTH_PORT/rc-login" 2>/dev/null)"
  [ "$GATE_CODE" = "302" ] && [ "$AUTH_CODE" = "200" ] && break
  i=$((i + 1))
  sleep 1
done
if [ "$GATE_CODE" != "302" ] || [ "$AUTH_CODE" != "200" ]; then
  echo "[dsh-web] ✗ 本地网关未就绪（密码门 $GATE_CODE/期望302，登录服务 $AUTH_CODE/期望200），回滚已启动的组件"
  "$REPO_DIR/bin/down.sh" >/dev/null 2>&1
  echo "[dsh-web]   排查: dsh-web logs auth 或 dsh-web logs caddy"
  exit 1
fi

# 看门狗必须在 URL 落盘后启动：它以 run/url 为基线，若早于 URL 启动会把
# 首个 URL 误判为「地址变化」，导致启动后 30s 重复推送一次通知
echo "[dsh-web]    校验通过，启动看门狗并推送飞书通知 ..."
nohup "$REPO_DIR/bin/watchdog.sh" >>"$RC_HOME/logs/watchdog.log" 2>&1 &
echo $! > "$RC_HOME/run/watchdog.pid"
"$REPO_DIR/bin/notify-feishu.sh" "remote.started" "$URL" || true

echo ""
echo "[dsh-web] ✅ 远程入口: $URL"
echo "[dsh-web]    密码: $(cat "$RC_HOME/password")"
echo "[dsh-web]    通知: $([ -n "${RC_FEISHU_OPEN_ID:-}" ] || [ -n "${RC_FEISHU_WEBHOOK:-}" ] && echo 已推送飞书 || echo '未配置（rc.env 里填 RC_FEISHU_OPEN_ID）')"
