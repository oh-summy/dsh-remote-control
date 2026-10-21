#!/usr/bin/env bash
# pin-dsh-picker.sh — 固定 DSH web 使用 browse 目录选择器（远程访问必需）
#
# 背景：DSH 的 directory-picker-auto 在 macOS/Windows + 回环绑定 + 非 SSH 启动
# 下会解析为 native——在宿主屏幕上弹原生选目录对话框。远程经 Cloudflare 隧道
# 访问时无人点击，请求挂起约 100s 后被 Cloudflare 以 HTTP 524 掐断（表现为
# 「无法打开文件夹 / directory picker failed」）。官方 seam 的固定方式是
# 停用 auto 行、直接挂载 -browse 后端及其客户端面（浏览器内逐级浏览目录）。
#
# 幂等：已固定则跳过；首次修改前做时间戳备份。可用 RC_DIRECTORY_PICKER=auto
# 在 rc.env 里显式关闭（比如机器旁有人值守、想用原生弹窗时）。
set -eu

RC_HOME="${RC_HOME:-$HOME/.remote-control}"
# shellcheck disable=SC1091  # 运行时环境文件，可选
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"

MODE="${RC_DIRECTORY_PICKER:-browse}"
if [ "$MODE" != "browse" ]; then
  echo "[dsh-web] RC_DIRECTORY_PICKER=${MODE}，跳过目录选择器固定"
  exit 0
fi

# launchd/最小 PATH 下补 npm 全局 bin 与常见安装位（与 bin/common.sh 同款逻辑）
for d in "$HOME/.npm-global/bin" /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin"; do
  [ -d "$d" ] || continue
  case ":$PATH:" in
    *":$d:"*) ;;
    *) PATH="$PATH:$d" ;;
  esac
done

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/web"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

# profile 未初始化（dsh web 从未启动过）时，用 --dump-config 触发 dsh 自行初始化；
# dsh 未安装则无法初始化，给出可操作提示后跳过（不算失败，install.sh 会再兜底）
if [ ! -d "$PROFILE_DIR" ]; then
  if command -v dsh >/dev/null 2>&1; then
    DSH_HOME="$DSH_HOME_DIR" dsh --profile web --dump-config >/dev/null 2>&1 || true
  fi
fi
if [ ! -f "$PATCH_FILE" ]; then
  echo "[dsh-web] ⚠ 未找到 dsh web profile（${PATCH_FILE}），跳过目录选择器固定"
  echo "[dsh-web]   dsh web 首次启动后重跑 install.sh 即可补齐"
  exit 0
fi

# 幂等：我们的固定块带唯一行 id directory-picker-browse
if grep -q 'id: directory-picker-browse' "$PATCH_FILE"; then
  echo "[dsh-web] 目录选择器已固定为 browse（跳过）"
  exit 0
fi

cp "$PATCH_FILE" "$PATCH_FILE.bak-$(date +%Y%m%dT%H%M%S)-picker"

# 全新 profile 的 cordis.patch.yml 是注释 + 一行 []（空数组占位），
# 直接追加会产生「[] 之后又跟数组项」的非法 YAML；先滤掉占位符行再追加。
TMP="$PATCH_FILE.tmp.$$"
trap 'rm -f "$TMP"' EXIT
grep -v '^\[\]$' "$PATCH_FILE" > "$TMP"
printf '\n%s\n' '# ── remote-control：固定 browse 目录选择器 ─────────────────────────────────
# 本服务经 Cloudflare 隧道远程访问。directory-picker-auto 在 darwin/win32 +
# 回环绑定 + 非 SSH 启动下解析为 native：宿主屏幕弹原生对话框，远程无人点击，
# 请求挂起约 100s 后被 Cloudflare 以 HTTP 524 掐断（添加工作区失败）。
# 官方 seam 的固定方式：停用 auto 行，直接挂载 -browse 后端及其客户端面
# （浏览器内逐级浏览/新建目录）。想恢复原生弹窗：改回 auto 并删除本块。
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: "@deepseek-ai/dsh-host-directory-picker-browse"
    - id: ui-directory-picker-browse
      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"' >> "$TMP"
chmod 600 "$TMP" 2>/dev/null || true
mv "$TMP" "$PATCH_FILE"
trap - EXIT
echo "[dsh-web] ✓ 已固定 browse 目录选择器（重启 dsh web 后生效）"
