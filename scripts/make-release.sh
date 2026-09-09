#!/usr/bin/env bash
# remote-control · 打包 GitHub Release 资产（源码包，不含二进制）
# 用法: scripts/make-release.sh [tag]    # 默认从最近 tag 读取版本
# 产物: dist/dsh-remote-control-<version>.tar.gz + .sha256
# 说明: install.sh 运行时会自动下载 cloudflared/caddy，故包内不包含二进制。
#       使用 git archive 从 commit 打包，保证可复现且不含本地未跟踪文件。
set -eu

cd "$(dirname "$0")/.."

# 版本参数：显式传 tag（如 v0.2.0），或取最近 tag
if [ -n "${1:-}" ]; then
  TAG="$1"
else
  TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo HEAD)"
fi
VERSION="${TAG#v}"
OUT_DIR="dist"
NAME="dsh-remote-control-$VERSION"

mkdir -p "$OUT_DIR"
# 清理旧产物：含上次中断可能残留的 staging 目录（git archive | tar 会合并进旧目录）
# SC2115: ${var:?} 防止变量为空时扩张成 rm -rf /（NAME/OUT_DIR 为空立即 fatal）
rm -rf "${OUT_DIR:?}/${NAME:?}"
rm -f "$OUT_DIR/$NAME.tar.gz" "$OUT_DIR/$NAME.tar.gz.sha256"

echo "[make-release] 打包 $TAG ..."
# git archive 白名单：只打 tracked 文件（etc/Caddyfile 是源文件，必须包含）
git archive --format=tar --prefix="$NAME/" "$TAG" \
  bin scripts etc docs \
  README.md README.zh-CN.md CONTRIBUTING.md CONTRIBUTING.zh-CN.md \
  LICENSE .gitignore .github/SECURITY.md \
  | tar -xf - -C "$OUT_DIR"

# 打包
tar -czf "$OUT_DIR/$NAME.tar.gz" -C "$OUT_DIR" "$NAME"
# SC2115: ${var:?} 防止变量为空时扩张成 rm -rf /（NAME/OUT_DIR 为空立即 fatal）
rm -rf "${OUT_DIR:?}/${NAME:?}"

# 生成校验和
( cd "$OUT_DIR" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

# ---- 包内容断言（防回归）----
echo "[make-release] 校验包内容 ..."
PKG="$OUT_DIR/$NAME.tar.gz"
# -Fx：整行精确匹配，避免子串误匹配（如 rc.env.tmpl）
tar -tzf "$PKG" | grep -Fxq "$NAME/etc/Caddyfile" || { echo "✗ 包内缺少 etc/Caddyfile"; exit 1; }
tar -tzf "$PKG" | grep -Fxq "$NAME/etc/rc.env" && { echo "✗ 包内不应包含 etc/rc.env"; exit 1; }
tar -tzf "$PKG" | grep -Fxq "$NAME/scripts/install.sh" || { echo "✗ 包内缺少 scripts/install.sh"; exit 1; }
for f in bin/up.sh bin/down.sh bin/dsh-web bin/auth-server.py; do
  tar -tzf "$PKG" | grep -Fxq "$NAME/$f" || { echo "✗ 包内缺少 $f"; exit 1; }
done
echo "[make-release] 包内容校验通过"

echo "[make-release] 完成:"
echo "  $OUT_DIR/$NAME.tar.gz"
echo "  校验和: $(cat "$OUT_DIR/$NAME.tar.gz.sha256")"
echo ""
echo "上传到 GitHub:"
echo "  gh release upload $TAG $OUT_DIR/$NAME.tar.gz $OUT_DIR/$NAME.tar.gz.sha256 --clobber"
