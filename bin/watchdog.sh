#!/usr/bin/env bash
# remote-control · 看门狗（常驻守护进程）
# 监测三类事件并推送飞书：URL 变化 / 组件退出自愈 / 上游不可达与恢复
# 自愈策略：
#   - caddy/auth 退出 → 原地重拉（不动隧道，URL 不变）
#   - cloudflared 退出 → 交棒 selfheal.sh（带退避重试调 up.sh；Quick Tunnel
#     会换新 URL，up.sh 落盘 run/url 并推 remote.started 新卡片）
#   - 看门狗自身被杀 → launchd KeepAlive 重拉（dsh-web autostart 安装）
# 生命周期与握手协议（run/ 下的标志文件）：
#   stopped      人工停止（down.sh / autostart off 先落）：看门狗待命；TERM 仅在
#                存在它时被接受，无标志的 TERM 视为误杀忽略
#   starting     up.sh 启动锁（含 pid，up.sh EXIT 清除）：启动窗口内看门狗只观察，
#                防止把「还没写到 cloudflared.pid」误判成隧道死亡而伪自愈
#   heal-failed  自愈全部失败后的冷却标志：不再自动重试、不再重复告警，
#                dsh-web start 成功后清除
# 同一时刻只有 run/watchdog.pid 的原子认领者（noclobber）是 active，其余 standby
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 公共库：is_proc/alive_as/component_pattern（组件→命令行特征单一事实源）
# shellcheck disable=SC1091  # 仓库内公共库，路径随安装位置变化
. "$REPO_DIR/bin/common.sh"
# shellcheck disable=SC1091  # 运行时环境文件，路径随安装位置变化
[ -f "$RC_HOME/rc.env" ] && . "$RC_HOME/rc.env"
: "${RC_UPSTREAM:=127.0.0.1:3080}"
: "${RC_LISTEN:=127.0.0.1:4080}"
# 原地重拉 caddy 需要 RC_HOME/bin（launchd 环境 PATH 也没有它）
export PATH="$RC_HOME/bin:$PATH"

# 日志轮转：超过 1MB 时轮转，保留最近 5 个（copytruncate 保持 fd）
rotate_logs() {
  for log in "$RC_HOME/logs"/*.log; do
    [ -f "$log" ] || continue
    size=$(stat -f%z "$log" 2>/dev/null || stat -c%s "$log" 2>/dev/null || echo 0)
    if [ "$size" -gt 1048576 ]; then
      # 先轮转旧文件
      for i in 4 3 2 1; do
        [ -f "$log.$i" ] && mv "$log.$i" "$log.$((i+1))"
      done
      # copytruncate: 复制后截断，保持 inode 不变，daemon 继续写入
      cp "$log" "$log.1"
      : > "$log"
      echo "$(date '+%F %T') rotated: $(basename "$log")" >> "$RC_HOME/logs/watchdog.log"
    fi
  done
}

# TERM：人工 stop / autostart off 都会先落 run/stopped → 退出（launchd 场景由
# KeepAlive 重拉出 standby 实例或被 unload 终止）；无标志的 TERM 视为误杀，忽略
trap 'if [ -f "$RC_HOME/run/stopped" ]; then exit 0; fi' TERM

log() { echo "$(date '+%F %T') $*" >> "$RC_HOME/logs/watchdog.log"; }

# 原子认领 active 身份：noclobber 防两实例同时认定自己（读-判-写有 TOCTOU）；
# 已持有 → 直接 active；认领失败且持有者确实活着 → standby；
# 持有者已死/残留 → 清除后重认领一次
claim_active() {
  local w
  w="$(cat "$RC_HOME/run/watchdog.pid" 2>/dev/null || true)"
  [ "$w" = "$$" ] && return 0
  if (set -o noclobber; echo $$ > "$RC_HOME/run/watchdog.pid") 2>/dev/null; then
    return 0
  fi
  w="$(cat "$RC_HOME/run/watchdog.pid" 2>/dev/null || true)"
  if [ -n "$w" ] && [ "$w" != "$$" ] && is_proc "$w" "$(component_pattern watchdog)"; then
    return 1
  fi
  # 只清自己判死的旧锁：内容已被他人更换时跳过，防误删新锁
  [ "$(cat "$RC_HOME/run/watchdog.pid" 2>/dev/null || true)" = "$w" ] || return 1
  rm -f "$RC_HOME/run/watchdog.pid"
  (set -o noclobber; echo $$ > "$RC_HOME/run/watchdog.pid") 2>/dev/null
}

# 原地重拉密码门组件（caddy/auth）：不碰隧道，URL 不变
respawn_gate() {
  local comp pat
  for comp in auth caddy; do
    pat="$(component_pattern "$comp")"
    alive_as "$RC_HOME/run/$comp.pid" "$pat" && continue
    case "$comp" in
      auth)
        nohup python3 "$REPO_DIR/bin/auth-server.py" >>"$RC_HOME/logs/auth.log" 2>&1 &
        echo $! > "$RC_HOME/run/auth.pid"
        log "auth 已原地重拉 (pid $(cat "$RC_HOME/run/auth.pid"))"
        ;;
      caddy)
        # session.secret 缺失/为空时重拉 caddy 可能让密码门失效（fail-open），
        # 宁可不拉并转人工
        if [ ! -s "$RC_HOME/session.secret" ]; then
          if [ "$SECRET_WARNED" = "0" ]; then
            log "session.secret 缺失/为空，放弃重拉 caddy（fail-open 防护）"
            "$REPO_DIR/bin/notify-feishu.sh" "remote.down（session.secret 缺失，无法安全重拉密码门，请执行 dsh-web start 修复）"
            SECRET_WARNED=1
          fi
          continue
        fi
        [ -f "$RC_HOME/Caddyfile" ] || cp "$REPO_DIR/etc/Caddyfile" "$RC_HOME/Caddyfile"
        RC_LOG_DIR="$RC_HOME/logs" RC_UPSTREAM="$RC_UPSTREAM" RC_LISTEN="$RC_LISTEN" \
          RC_TOKEN="$(cat "$RC_HOME/session.secret" 2>/dev/null)" \
          nohup caddy run --config "$RC_HOME/Caddyfile" --adapter caddyfile \
          >>"$RC_HOME/logs/caddy.stdout.log" 2>&1 &
        echo $! > "$RC_HOME/run/caddy.pid"
        log "caddy 已原地重拉 (pid $(cat "$RC_HOME/run/caddy.pid"))"
        ;;
    esac
  done
}

if claim_active; then
  echo "$(date '+%F %T') watchdog started (pid $$, active)" >> "$RC_HOME/logs/watchdog.log"
else
  echo "$(date '+%F %T') watchdog started (pid $$, standby)" >> "$RC_HOME/logs/watchdog.log"
fi
LAST_URL="$(cat "$RC_HOME/run/url" 2>/dev/null || echo '')"
LAST_DOWN=0
GATE_DOWN=0
HEAL_NOTIFIED=0
HEAL_WAS_RUNNING=0
SECRET_WARNED=0

while true; do
  sleep 30

  # 0) 身份协调：认领失败 → standby（不干活、不轮转日志，等接管）
  claim_active || continue

  rotate_logs

  # 0.5) 人工停止期间只待命，不拉起任何组件（dsh-web start 会清除该标志）
  if [ -f "$RC_HOME/run/stopped" ]; then
    WAS_IDLE=1
    continue
  fi
  # 刚从人工停止恢复：以落盘 URL 重置基线，避免把重启后的新地址误报为 changed
  if [ "${WAS_IDLE:-0}" = "1" ]; then
    LAST_URL="$(cat "$RC_HOME/run/url" 2>/dev/null || echo '')"
    WAS_IDLE=0
  fi

  # 0.7) 启动锁残留清理：持有者已死（如 SIGKILL）→ 移除，避免永久只观察
  if [ -f "$RC_HOME/run/starting" ] && ! alive_as "$RC_HOME/run/starting" "$(component_pattern up)"; then
    rm -f "$RC_HOME/run/starting"
  fi

  # 1) 自愈/启动进行中 → 本轮只观察（避免重复拉起/刷屏）；结束后同步基线，
  #    并把门组件告警状态复位（防止把 up.sh 的重建误报成"已重拉恢复"）
  HEALING=0
  if alive_as "$RC_HOME/run/selfheal.pid" "$(component_pattern selfheal)" || [ -f "$RC_HOME/run/starting" ]; then
    HEALING=1
  elif [ "$HEAL_WAS_RUNNING" = "1" ]; then
    # 自愈/启动刚结束：以落盘 URL 为新基线，避免把新地址误报为 changed
    LAST_URL="$(cat "$RC_HOME/run/url" 2>/dev/null || echo '')"
    HEAL_NOTIFIED=0
    GATE_DOWN=0
  fi
  HEAL_WAS_RUNNING="$HEALING"

  # 2) 隧道进程退出（含从未启动，如开机自启场景）→ 交棒 selfheal.sh；
  #    冷却期（heal-failed）不重试、不重复告警，等 dsh-web start 解除
  if [ "$HEALING" = "0" ] && [ ! -f "$RC_HOME/run/heal-failed" ] \
     && ! alive_as "$RC_HOME/run/cloudflared.pid" 'cloudflared'; then
    if [ "$HEAL_NOTIFIED" = "0" ]; then
      log "cloudflared 退出/未运行，触发自动恢复（selfheal）"
      "$REPO_DIR/bin/notify-feishu.sh" "remote.down（隧道进程退出，自动恢复中）"
      HEAL_NOTIFIED=1
    fi
    nohup "$REPO_DIR/bin/selfheal.sh" >>"$RC_HOME/logs/selfheal.log" 2>&1 &
    continue
  fi

  # 3) 隧道还在但密码门组件退出 → 原地重拉（URL 不变），并推送事件
  #    各只报一次，恢复后复位可再报
  if [ "$HEALING" = "0" ]; then
    DEAD=""
    for comp in caddy auth; do
      alive_as "$RC_HOME/run/$comp.pid" "$(component_pattern "$comp")" || DEAD="$DEAD $comp"
    done
    if [ -n "$DEAD" ] && [ "$GATE_DOWN" = "0" ]; then
      # 变量后只能跟 ASCII：bash 3.2 会把紧跟的多字节字符吞进变量名（$DEAD 同理）
      log "gate down:$DEAD - respawn"
      "$REPO_DIR/bin/notify-feishu.sh" "remote.down（密码门组件退出:${DEAD} - 自动重拉中）"
      GATE_DOWN=1
    fi
    respawn_gate
    if [ "$GATE_DOWN" = "1" ] && [ -z "$DEAD" ]; then
      "$REPO_DIR/bin/notify-feishu.sh" "remote.recovered（密码门组件已重拉恢复）"
      GATE_DOWN=0
    fi
  fi

  # 4) Quick Tunnel URL 变化（同一 cloudflared 进程断线重连后换新地址）。
  #    up.sh 启动/自愈窗口已由 HEALING 跳过 + 结束时基线复位覆盖，无需 mtime 判断
  URL="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$RC_HOME/logs/cloudflared.log" 2>/dev/null | tail -1)"
  if [ "$HEALING" = "0" ] && [ -n "$URL" ] && [ "$URL" != "$LAST_URL" ]; then
    echo "$URL" > "$RC_HOME/run/url"
    "$REPO_DIR/bin/notify-feishu.sh" "remote.changed" "$URL"
    LAST_URL="$URL"
  fi

  # 5) 上游不可达 / 恢复（各只推一次；自愈/启动窗口跳过，防止重建 DSH
  #    期间误报一对 down/recovered）
  if [ "$HEALING" = "0" ]; then
    CODE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$RC_UPSTREAM/" 2>/dev/null || true)"
    if [ "$CODE" = "000" ] && [ "$LAST_DOWN" = "0" ]; then
      "$REPO_DIR/bin/notify-feishu.sh" "remote.down（上游 $RC_UPSTREAM 不可达）"
      LAST_DOWN=1
    elif [ "$CODE" != "000" ] && [ "$LAST_DOWN" = "1" ]; then
      "$REPO_DIR/bin/notify-feishu.sh" "remote.recovered（上游已恢复）"
      LAST_DOWN=0
      # 上游恢复通常意味着 DSH 重启过，launch token 已轮换——刷新状态文件
      RC_DSH_TOK=""
      if [ -f "$RC_HOME/logs/dsh-web.log" ]; then
        RC_DSH_TOK="$(grep -oE '[?&]token=[A-Za-z0-9_-]+' "$RC_HOME/logs/dsh-web.log" 2>/dev/null | tail -1 | cut -d= -f2)"
      fi
      if [ -n "$RC_DSH_TOK" ]; then
        printf '%s\n' "$RC_DSH_TOK" > "$RC_HOME/run/dsh-token.tmp" && \
          mv "$RC_HOME/run/dsh-token.tmp" "$RC_HOME/run/dsh-token"
      fi
    fi
  fi
done
