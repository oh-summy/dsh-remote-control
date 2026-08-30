#!/usr/bin/env bash
# remote-control · 飞书通知（v4：卡片 + 独立纯文本密码消息）
# 用法: notify-feishu.sh <event> [url]
# 事件: remote.started / remote.changed / remote.down / remote.recovered
# 卡片：标题 + URL（纯文本、前后空行）+ 打开按钮；密码不进卡片，
#       另发一条纯文本消息，内容只有密码本身（长按整条复制）。
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
# shellcheck disable=SC1091  # 运行时环境文件
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"
LOG="$RC_HOME/logs/notify.log"
mkdir -p "$RC_HOME/logs"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

EVENT="${1:-event}"
URL="${2:-}"
RHOST="$(hostname -s)"
NOW="$(date '+%F %T')"

case "$EVENT" in
  remote.started)   COLOR=green; TITLE="远程访问已就绪" ;;
  remote.changed)   COLOR=blue;  TITLE="入口地址已更新" ;;
  remote.down)      COLOR=red;   TITLE="远程访问中断" ;;
  remote.recovered) COLOR=green; TITLE="远程访问已恢复" ;;
  remote.status)    COLOR=grey;  TITLE="状态确认（通道测试）" ;;
  *)                COLOR=grey;  TITLE="$EVENT" ;;
esac

# 卡片 JSON（URL 纯文本、前后空行，无代码块）
CARD="$(python3 - "$TITLE" "$COLOR" "$URL" "$RHOST" "$NOW" "$EVENT" << 'PYEOF'
import json, sys
title, color, url, host, now, event = sys.argv[1:7]

elements = []
if url:
    elements.append({"tag": "div", "text": {"tag": "lark_md", "content": "**访问地址**"}})
    elements.append({"tag": "div", "text": {"tag": "lark_md", "content": "\n\n" + url + "\n\n"}})
    elements.append({"tag": "action", "actions": [
        {"tag": "button", "text": {"tag": "plain_text", "content": "打开 DSH"},
         "type": "primary", "url": url}]})
if event.startswith("remote.down"):
    elements.append({"tag": "div", "text": {"tag": "lark_md",
        "content": "看门狗检测到异常，正在自动恢复；恢复后会再推送。密码见上一条纯文本消息。"}})
elements.append({"tag": "hr"})
elements.append({"tag": "note", "elements": [
    {"tag": "plain_text", "content": f"Remote Control · {host} · {now} · 事件 {event}"}]})

card = {"config": {"wide_screen_mode": True},
        "header": {"template": color,
                   "title": {"tag": "plain_text", "content": title}},
        "elements": elements}
print(json.dumps(card, ensure_ascii=False))
PYEOF
)"

send() { echo "$(date '+%F %T') $EVENT $1" >> "$LOG"; }

# 通道 1（主）：lark-cli bot 私发（固定 APP 凭据，不过期）
if [ -n "${RC_FEISHU_OPEN_ID:-}" ] && command -v lark-cli >/dev/null 2>&1; then
  RESP="$(lark-cli im +messages-send --as bot --user-id "$RC_FEISHU_OPEN_ID" \
    --msg-type interactive --content "$CARD" --json 2>&1)"
  if printf '%s' "$RESP" | grep -q '"ok": true'; then
    send "dm-card-ok"
  else
    send "dm-fail resp=$(printf '%s' "$RESP" | head -c 200)"
  fi

  # 密码：单独一条纯文本消息，内容只有密码本身（仅 started/changed，且 full 模式）
  if [ "${RC_NOTIFY_PASSWORD:-full}" = "full" ] && [ -f "$RC_HOME/password" ] \
     && { [ "$EVENT" = "remote.started" ] || [ "$EVENT" = "remote.changed" ]; }; then
    PW="$(cat "$RC_HOME/password")"
    RESP2="$(lark-cli im +messages-send --as bot --user-id "$RC_FEISHU_OPEN_ID" \
      --text "$PW" --json 2>&1)"
    if printf '%s' "$RESP2" | grep -q '"ok": true'; then
      send "dm-pw-ok"
    else
      send "dm-pw-fail resp=$(printf '%s' "$RESP2" | head -c 120)"
    fi
  fi
  exit 0
fi

# 通道 2（兜底）：群自定义机器人 Webhook（密码行并入卡片降级文本）
if [ -n "${RC_FEISHU_WEBHOOK:-}" ]; then
  RESP="$(curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"msg_type\":\"interactive\",\"card\":$CARD}" "$RC_FEISHU_WEBHOOK" 2>&1)" || true
  send "webhook resp=${RESP:-<empty>}"
  exit 0
fi

send "skip(no-channel)"
exit 0
