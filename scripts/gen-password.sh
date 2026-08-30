#!/usr/bin/env bash
# 生成 128bit 密码 + bcrypt 哈希 → ~/.remote-control/{password,password.bcrypt}
# 明文仅首次展示一次，之后从 ~/.remote-control/password 查看（权限 600）
set -eu
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
export PATH="$RC_HOME/bin:$PATH"
mkdir -p "$RC_HOME"
chmod 700 "$RC_HOME"
command -v caddy >/dev/null 2>&1 || { echo "[rc] 未安装 caddy（先运行 scripts/install.sh）"; exit 1; }

PW="$(openssl rand -hex 16)"
HASH="$(caddy hash-password --plaintext "$PW")"
printf '%s\n' "$PW" > "$RC_HOME/password"
printf '%s\n' "$HASH" > "$RC_HOME/password.bcrypt"
chmod 600 "$RC_HOME/password" "$RC_HOME/password.bcrypt"

echo "[rc] 密码已生成并存入 $RC_HOME/password（明文仅此一次展示）"
echo "     $PW"
