#!/usr/bin/env bash
# 生成 128bit 访问密码 → ~/.remote-control/password（权限 600）
# 认证 v3（Cookie 令牌鉴权）不再使用 bcrypt 文件；旧安装残留一并清理
set -eu
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
mkdir -p "$RC_HOME"
chmod 700 "$RC_HOME"

PW="$(openssl rand -hex 16)"
printf '%s\n' "$PW" > "$RC_HOME/password"
rm -f "$RC_HOME/password.bcrypt"
chmod 600 "$RC_HOME/password"

echo "[rc] 密码已生成并存入 $RC_HOME/password（明文仅此一次展示）"
echo "     $PW"
