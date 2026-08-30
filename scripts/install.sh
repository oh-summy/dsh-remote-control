#!/usr/bin/env bash
# remote-control 安装：下载官方预编译二进制（不依赖 brew/apt，Mac 与 Linux 同一机制）
# 平台支持：macOS / Linux · x86_64 / arm64（Windows 不在官方支持范围）
set -eu
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RC_HOME="$HOME/.remote-control"
BIN_DIR="$RC_HOME/bin"
mkdir -p "$BIN_DIR" "$RC_HOME/logs" "$RC_HOME/run"
chmod 700 "$RC_HOME"

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in Darwin) os=darwin;; Linux) os=linux;; *) echo "[rc] ✗ 不支持的系统: $OS（Windows 欢迎提 PR）"; exit 1;; esac
case "$ARCH" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo "[rc] ✗ 不支持的架构: $ARCH"; exit 1;; esac
echo "[rc] 平台: $os-$arch"

dl() { curl -fSL --retry 3 -m 300 -o "$2" "$1"; }

# 版本策略：默认跟随上游 latest（安全修复优先，cloudflared 旧版会被
# Cloudflare 逐步淘汰）；需要紧急回滚时用环境变量钉版：
#   RC_CLOUDFLARED_VERSION=2026.8.2   （GitHub release tag，两平台通用）
#   RC_CADDY_VERSION=v2.11.4          （仅 linux 的 GitHub release tag；
#                                      darwin 走官方构建 API 只提供最新版）
CFV="${RC_CLOUDFLARED_VERSION:-latest}"
if [ "$CFV" = latest ]; then
  CF_BASE="https://github.com/cloudflare/cloudflared/releases/latest/download"
else
  CF_BASE="https://github.com/cloudflare/cloudflared/releases/download/$CFV"
fi

# ---- cloudflared ----
if [ -x "$BIN_DIR/cloudflared" ] || command -v cloudflared >/dev/null 2>&1; then
  echo "[rc] cloudflared 已就绪（$([ -x "$BIN_DIR/cloudflared" ] && echo "$BIN_DIR/cloudflared" || echo "系统 PATH")）"
else
  echo "[rc] 下载 cloudflared $CFV ($os-$arch) ..."
  if [ "$os" = darwin ]; then
    dl "$CF_BASE/cloudflared-$os-$arch.tgz" "$BIN_DIR/cf.tgz"
    tar -xzf "$BIN_DIR/cf.tgz" -C "$BIN_DIR" cloudflared
    rm -f "$BIN_DIR/cf.tgz"
  else
    dl "$CF_BASE/cloudflared-$os-$arch" "$BIN_DIR/cloudflared"
  fi
  chmod +x "$BIN_DIR/cloudflared"
fi

# ---- caddy（linux 走 GitHub Release；darwin 走官方构建 API——v2.11 起 Release 不再发布 darwin 资产）----
if [ -x "$BIN_DIR/caddy" ] || command -v caddy >/dev/null 2>&1; then
  echo "[rc] caddy 已就绪"
elif [ "$os" = linux ]; then
  if [ -n "${RC_CADDY_VERSION:-}" ]; then
    TAG="$RC_CADDY_VERSION"
  else
    echo "[rc] 解析 caddy 最新版本 ..."
    TAG="$(curl -fsSL -m 30 https://api.github.com/repos/caddyserver/caddy/releases/latest \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  fi
  VER="${TAG#v}"
  echo "[rc] 下载 caddy $TAG ($os-$arch) ..."
  dl "https://github.com/caddyserver/caddy/releases/download/$TAG/caddy_${VER}_${os}_${arch}.tar.gz" "$BIN_DIR/caddy.tgz"
  tar -xzf "$BIN_DIR/caddy.tgz" -C "$BIN_DIR" caddy
  rm -f "$BIN_DIR/caddy.tgz"
  chmod +x "$BIN_DIR/caddy"
else
  [ -n "${RC_CADDY_VERSION:-}" ] && echo "[rc] ⚠ darwin 走官方构建 API，仅提供最新版，忽略 RC_CADDY_VERSION"
  echo "[rc] 下载 caddy ($os-$arch, 官方构建 API, 裸二进制 ~35MB, 不支持断点) ..."
  i=0
  while [ $i -lt 5 ]; do
    i=$((i+1))
    curl -fSL -m 900 --speed-limit 1024 --speed-time 60 \
      -o "$BIN_DIR/caddy" "https://caddyserver.com/api/download?os=$os&arch=$arch" && break
    echo "[rc] 第 $i 次下载未完成，重试（全新下载）..."
    sleep 2
  done
  [ -x "$BIN_DIR/caddy" ] || { echo "[rc] ✗ caddy 下载失败"; exit 1; }
  chmod +x "$BIN_DIR/caddy"
fi

# ---- 初始化配置与凭据 ----
[ -f "$RC_HOME/rc.env" ] || {
  sed "s#__RC_HOME__#$RC_HOME#" "$REPO_DIR/etc/rc.env.tmpl" > "$RC_HOME/rc.env"
  chmod 600 "$RC_HOME/rc.env"
}
[ -f "$RC_HOME/Caddyfile" ] || cp "$REPO_DIR/etc/Caddyfile" "$RC_HOME/Caddyfile"
[ -f "$RC_HOME/password" ] || "$REPO_DIR/scripts/gen-password.sh"

# ---- dsh-web 命令行链接（start/stop/status/logs/password/install）----
LINK_DIR=""
for d in "$HOME/.npm-global/bin" /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then LINK_DIR="$d"; break; fi
done
if [ -z "$LINK_DIR" ]; then
  LINK_DIR="$HOME/.local/bin"; mkdir -p "$LINK_DIR"
fi
ln -sf "$REPO_DIR/bin/dsh-web" "$LINK_DIR/dsh-web"
case ":$PATH:" in
  *":$LINK_DIR:"*) echo "[rc] 命令已安装: dsh-web（$LINK_DIR）" ;;
  *) echo "[rc] 命令已安装: $LINK_DIR/dsh-web（注意：$LINK_DIR 不在 PATH）" ;;
esac

export PATH="$BIN_DIR:$PATH"
echo "[rc] 版本: cloudflared $(cloudflared --version 2>/dev/null | head -1) · caddy $(caddy version 2>/dev/null | head -1)"
echo ""
echo "[rc] 安装完成。接下来："
echo "[rc]   1) 编辑 $RC_HOME/rc.env，填入 RC_FEISHU_WEBHOOK（飞书群机器人地址）"
echo "[rc]   2) 运行 $REPO_DIR/bin/up.sh 启动远程入口"
echo "[rc]   3) 运行 $REPO_DIR/bin/status.sh 查看状态"
