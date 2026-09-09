#!/usr/bin/env bash
# remote-control · 轮换访问密码（生成新密码并重启服务使生效）
set -eu
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCK_FILE="$RC_HOME/run/.rotate.lock"

# 防止并发执行
exec 200>"$LOCK_FILE"
flock -n 200 || { echo "[dsh-web] ✗ 另一个轮换操作正在进行"; exit 1; }

echo "[dsh-web] 轮换访问密码 ..."

# 原子写入新密码（先写临时文件，再 mv）
TMP_PW="$RC_HOME/.password.tmp.$$"
umask 077
openssl rand -hex 16 > "$TMP_PW"
mv "$TMP_PW" "$RC_HOME/password"
NEW_PW="$(cat "$RC_HOME/password")"

echo "[dsh-web]   新密码已生成: $NEW_PW"

# 如果服务在运行，重启使新密码生效
if [ -f "$RC_HOME/run/auth.pid" ] && kill -0 "$(cat "$RC_HOME/run/auth.pid")" 2>/dev/null; then
  echo "[dsh-web]   重启服务使新密码生效 ..."
  "$REPO_DIR/bin/down.sh"
  sleep 1
  if "$REPO_DIR/bin/up.sh"; then
    echo "[dsh-web] ✓ 密码轮换完成，服务已重启"
  else
    echo "[dsh-web] ✗ 密码已更换，但服务重启失败，请手动执行: dsh-web start"
    exit 1
  fi
else
  echo "[dsh-web]   服务未运行，新密码将在下次启动时生效"
  echo "[dsh-web] ✓ 密码轮换完成"
fi
