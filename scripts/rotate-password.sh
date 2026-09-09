#!/usr/bin/env bash
# remote-control · 轮换访问密码（生成新密码并重启服务使生效）
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[dsh-web] 轮换访问密码 ..."

# 生成新密码（128-bit 随机）
NEW_PW="$(openssl rand -hex 16)"
echo "$NEW_PW" > "$RC_HOME/password"
chmod 600 "$RC_HOME/password"

echo "[dsh-web]   新密码已生成: $NEW_PW"

# 如果服务在运行，重启使新密码生效
if [ -f "$RC_HOME/run/auth.pid" ] && kill -0 "$(cat "$RC_HOME/run/auth.pid")" 2>/dev/null; then
  echo "[dsh-web]   重启服务使新密码生效 ..."
  "$REPO_DIR/bin/down.sh"
  sleep 1
  "$REPO_DIR/bin/up.sh"
else
  echo "[dsh-web]   服务未运行，新密码将在下次启动时生效"
fi

echo "[dsh-web] ✓ 密码轮换完成"
