#!/usr/bin/env bash
# remote-control · 一键远程安装（无需 git clone）
# 从 GitHub Release 下载官方源码包，校验 SHA256 后调用 install.sh 完成安装。
#
# 用法（管道执行，本脚本只做引导 + 下载校验 + 调用 install.sh）:
#   # 装最新 release
#   curl -fsSL https://raw.githubusercontent.com/oh-summy/dsh-remote-control/main/scripts/install-remote.sh | bash
#   # 装指定版本
#   curl -fsSL https://raw.githubusercontent.com/oh-summy/dsh-remote-control/main/scripts/install-remote.sh | bash -s -- v0.1.0
#
# 直接运行（本机已有仓库）:
#   scripts/install-remote.sh [version]
set -eu

# 版本参数：默认 latest，可传 vX.Y.Z
VERSION="${1:-latest}"
REPO="oh-summy/dsh-remote-control"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 解析真实版本号：latest 通过 GitHub API 解析，指定版本直接使用
if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])' \
    || { echo "[dsh-web] ✗ 无法解析最新版本（检查网络）"; exit 1; })"
fi
TAG="$VERSION"                          # 保留 v 前缀用于 URL
VERSION="${VERSION#v}"                    # 去 v 用于资产文件名
BASE="https://github.com/$REPO/releases/download/$TAG"
PKG_NAME="dsh-remote-control-$VERSION"

echo "[dsh-web] 目标版本: v$VERSION"
echo "[dsh-web] 下载 $REPO v$VERSION ($PKG_NAME.tar.gz) ..."
curl -fSL --retry 3 -m 120 -o "$TMP_DIR/$PKG_NAME.tar.gz" "$BASE/$PKG_NAME.tar.gz"
curl -fSL --retry 3 -m 60  -o "$TMP_DIR/$PKG_NAME.tar.gz.sha256" "$BASE/$PKG_NAME.tar.gz.sha256"

# 校验完整性
echo "[dsh-web] 校验 SHA256 ..."
( cd "$TMP_DIR" && shasum -a 256 -c "$PKG_NAME.tar.gz.sha256" >/dev/null )

# 解压并调用官方安装器
echo "[dsh-web] 解压并安装 ..."
tar -xzf "$TMP_DIR/$PKG_NAME.tar.gz" -C "$TMP_DIR"
exec "$TMP_DIR/$PKG_NAME/scripts/install.sh"
