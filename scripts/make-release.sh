#!/usr/bin/env bash
# remote-control · 打包 GitHub Release 资产（源码包，不含二进制）
# 用法: scripts/make-release.sh [version]   # 默认从最近 tag 读取版本
# 产物: dist/dsh-remote-control-<version>.tar.gz + .sha256
# 说明: install.sh 运行时会自动下载 cloudflared/caddy，故包内不包含二进制
set -eu

cd "$(dirname "$0")/.."
VERSION="${1:-$(git describe --tags --abbrev=0)}"
VERSION="${VERSION#v}"                    # 去掉 v 前缀
OUT_DIR="dist"
NAME="dsh-remote-control-$VERSION"
STAGE="$OUT_DIR/$NAME"

rm -rf "$STAGE"
mkdir -p "$STAGE"

# 复制需要发布的文件（保持结构）
echo "[make-release] 打包 v$VERSION ..."
cp -R bin scripts etc docs "$STAGE/"
cp README.md README.zh-CN.md CONTRIBUTING.md CONTRIBUTING.zh-CN.md LICENSE .gitignore "$STAGE/"
# 保留 SECURITY.md
mkdir -p "$STAGE/.github"
cp .github/SECURITY.md "$STAGE/.github/"

# 移除运行期临时产物（防御性清理）
rm -rf "$STAGE"/bin/__pycache__
rm -f "$STAGE"/etc/rc.env "$STAGE"/etc/Caddyfile   # 渲染后的本地配置不进包

# 确保脚本有执行权限
chmod +x "$STAGE"/bin/*.sh "$STAGE"/bin/dsh-web \
  "$STAGE"/scripts/*.sh

# 打包
tar -czf "$OUT_DIR/$NAME.tar.gz" -C "$OUT_DIR" "$NAME"
rm -rf "$STAGE"

# 生成校验和
( cd "$OUT_DIR" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

echo "[make-release] 完成:"
echo "  $OUT_DIR/$NAME.tar.gz"
echo "  校验和: $(cat "$OUT_DIR/$NAME.tar.gz.sha256")"
echo ""
echo "上传到 GitHub:"
echo "  gh release upload v$VERSION $OUT_DIR/$NAME.tar.gz $OUT_DIR/$NAME.tar.gz.sha256"
