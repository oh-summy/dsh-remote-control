#!/usr/bin/env bash
# remote-control · 一键远程安装（无需 git clone）
# 从 GitHub Release 下载官方源码包，校验 SHA256 后调用 install.sh 完成安装。
#
# 安全说明（重要）: SHA256 校验解决的是「传输完整性」——确保下载的包与 GitHub
# Release 上的资产逐字节一致，防止传输损坏/CDN 意外污染。它不是「真实性」证明：
# 校验和与包同源（同一 Release），若攻击者能篡改 Release 资产，也能同时替换校验和。
# 个人工具 + 单一维护者 + GitHub HTTPS 分发场景下此威胁模型可接受；如未来受众扩大，
# 应引入 GPG 签名或在独立信道公布哈希。
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

# 解析真实版本号：latest 通过 HTTP redirect 解析（免 API quota），
# github.com/<repo>/releases/latest 会 302 到 .../releases/tag/vX.Y.Z
if [ "$VERSION" = "latest" ]; then
  FINAL_URL="$(curl -sIL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  VERSION="${FINAL_URL##*/}"
  [ "$VERSION" != "$FINAL_URL" ] && [ -n "$VERSION" ] || { echo "[dsh-web] ✗ 无法解析最新版本（检查网络）"; exit 1; }
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
# 注意：不要用 exec——需要让 EXIT trap 清理 TMP_DIR（exec 会替换进程，trap 失效）
echo "[dsh-web] 解压并安装 ..."
tar -xzf "$TMP_DIR/$PKG_NAME.tar.gz" -C "$TMP_DIR"
"$TMP_DIR/$PKG_NAME/scripts/install.sh"
