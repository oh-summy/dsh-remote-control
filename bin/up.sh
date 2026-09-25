#!/usr/bin/env bash
# remote-control · 启动全链路（分阶段进度输出；URL 就绪后才启动看门狗）
# 阶段: 凭据 → 认证服务+Caddy 密码门 → Cloudflare 隧道(等URL) → 看门狗+通知
set -u
RC_HOME="${RC_HOME:-$HOME/.remote-control}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 公共库：is_proc/alive_as/component_pattern（组件→命令行特征单一事实源）
# shellcheck disable=SC1091  # 仓库内公共库，路径随安装位置变化
. "$REPO_DIR/bin/common.sh"

[ -f "$RC_HOME/rc.env" ] || { echo "[dsh-web] 缺少 $RC_HOME/rc.env（先运行 dsh-web install）"; exit 1; }
# shellcheck disable=SC1091  # 运行时环境文件，路径随安装位置变化
. "$RC_HOME/rc.env"
: "${RC_UPSTREAM:=127.0.0.1:3080}"
: "${RC_LISTEN:=127.0.0.1:4080}"

# 优先使用 RC_HOME/bin 下的官方二进制（install.sh 下载），其次系统 PATH
export PATH="$RC_HOME/bin:$PATH"
# launchd 环境补 npm 全局 bin（自动拉起 dsh 依赖它），与 watchdog/selfheal 通知共用
rc_add_npm_global_path

for cmd in caddy cloudflared python3 curl; do
  # ${cmd} 显式定界：bash 3.2 会把后面紧跟的多字节字符吞进变量名
  command -v "$cmd" >/dev/null 2>&1 || { echo "[dsh-web] ✗ 未安装 ${cmd}（先运行 dsh-web install）"; exit 1; }
done

# dsh is required for auto-start; check early for clear error
if ! command -v dsh >/dev/null 2>&1; then
  echo "[dsh-web] ✗ 未安装 dsh（请先安装 DeepSeek Harness）"
  exit 1
fi

mkdir -p "$RC_HOME/logs" "$RC_HOME/run"
[ -f "$RC_HOME/Caddyfile" ] || cp "$REPO_DIR/etc/Caddyfile" "$RC_HOME/Caddyfile"

# 启动锁（run/starting，noclobber 原子创建）：1) 防两个 up.sh 并发互杀
# （如自愈中的 up.sh 撞上人工 dsh-web start）；2) 常驻看门狗在启动窗口内
# 只观察，不会把「还没写到 cloudflared.pid」误判成隧道死亡而触发伪自愈。
# 锁由 EXIT trap 清除；SIGKILL 残留由看门狗按 pid 校验清理
START_MARKER="$RC_HOME/run/starting"
acquire_start_lock() {
  local tries=0 p
  while [ "$tries" -lt 60 ]; do
    if (set -o noclobber; echo $$ > "$START_MARKER") 2>/dev/null; then
      return 0
    fi
    p="$(cat "$START_MARKER" 2>/dev/null || true)"
    if [ -n "$p" ] && [ "$p" != "$$" ] && kill -0 "$p" 2>/dev/null \
       && is_proc "$p" "$(component_pattern up)"; then
      # 自愈触发的启动不等人：另一次启动在进行，本轮让路（selfheal 处理）
      [ "${RC_SELFHEAL:-0}" = "1" ] && return 75
      # ${p} 必须显式定界：bash 3.2 会把后面紧跟的全角字符吞进变量名，
      # set -u 下直接 unbound variable 崩溃（与下面 ${cmd} 同坑）
      [ "$tries" -eq 0 ] && echo "[dsh-web] 检测到另一次启动正在进行（pid ${p}），等待其完成 ..."
      sleep 2
      tries=$((tries + 1))
      continue
    fi
    # 只清自己判死的旧锁：内容已被他人更换时跳过，防误删新锁
    [ "$(cat "$START_MARKER" 2>/dev/null || true)" = "$p" ] && rm -f "$START_MARKER"
  done
  return 75
}
if ! acquire_start_lock; then
  if [ "${RC_SELFHEAL:-0}" = "1" ]; then
    exit 75 # 让路不算失败，selfheal 会等待后重试
  fi
  echo "[dsh-web] ✗ 等待另一次启动完成超时（120s），放弃本次启动"
  exit 1
fi
trap 'rm -f "$START_MARKER"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 人工 stop 优先于自愈：自愈触发的启动发现停止标志 → 放弃（exit 80 由
# selfheal 识别为「安静放弃」，不算失败）
selfheal_stopped() {
  [ "${RC_SELFHEAL:-0}" = "1" ] && [ -f "$RC_HOME/run/stopped" ]
}
if selfheal_stopped; then
  echo "[dsh-web] 检测到人工停止标志，自愈启动放弃"
  exit 80
fi
# 本次是显式启动：解除人工停止标志，看门狗恢复值守
# （自愈触发的启动不清该标志：人工 stop 优先于自愈）
if [ "${RC_SELFHEAL:-0}" != "1" ]; then
  rm -f "$RC_HOME/run/stopped"
fi
# Auto-start DSH web if enabled and upstream is unreachable
: "${RC_AUTOSTART_DSH:=true}"
if [ "$RC_AUTOSTART_DSH" = "true" ]; then
  CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$RC_UPSTREAM/" 2>/dev/null || true)"
  if [ "$CODE" = "000" ]; then
    echo "[dsh-web] DSH web 未启动，正在自动拉起 ..."
    nohup dsh web >>"$RC_HOME/logs/dsh-web.log" 2>&1 &
    i=0
    while [ $i -lt 30 ]; do
      sleep 1
      CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$RC_UPSTREAM/" 2>/dev/null || true)"
      [ "$CODE" != "000" ] && break
      i=$((i + 1))
      [ $((i % 10)) -eq 0 ] && echo "[dsh-web]   ...等待 DSH web 启动（剩余 $((30 - i))s）"
    done
    if [ "$CODE" = "000" ]; then
      echo "[dsh-web] ✗ DSH web 自动启动失败，请查看 $RC_HOME/logs/dsh-web.log 或手动执行 dsh web 后重试"
      exit 1
    fi
    echo "[dsh-web]     DSH web 已就绪"
  fi
fi

# 提取当前 DSH launch token 到状态文件：auth-server 登录时优先读它。
# 放在状态文件而不是只扫日志，是因为 watchdog 会 copytruncate 轮转日志，
# token 行可能被搬进轮转副本；没找到则清掉旧状态（auth-server 会回退扫日志）
RC_DSH_TOK=""
if [ -f "$RC_HOME/logs/dsh-web.log" ]; then
  RC_DSH_TOK="$(grep -oE '[?&]token=[A-Za-z0-9_-]+' "$RC_HOME/logs/dsh-web.log" 2>/dev/null | tail -1 | cut -d= -f2)"
fi
if [ -n "$RC_DSH_TOK" ]; then
  printf '%s\n' "$RC_DSH_TOK" > "$RC_HOME/run/dsh-token.tmp" && \
    mv "$RC_HOME/run/dsh-token.tmp" "$RC_HOME/run/dsh-token"
else
  rm -f "$RC_HOME/run/dsh-token"
fi

alive=0
for name in watchdog cloudflared caddy auth; do
  pat="$(component_pattern "$name")"
  if alive_as "$RC_HOME/run/$name.pid" "$pat"; then
    alive=$((alive + 1))
  fi
done
if [ "$alive" -eq 4 ]; then
  # 全链路已在运行：本次调用视为成功，解除自愈冷却（若有）
  rm -f "$RC_HOME/run/heal-failed"
  echo "[dsh-web] 已在运行"
  echo "[dsh-web]   查看状态: dsh-web status | 重启: dsh-web restart | 停止: dsh-web stop"
  exit 0
fi
if [ "$alive" -gt 0 ]; then
  # 只判 caddy 会漏掉半死状态（如隧道在、密码门崩），这里任一存活即先清场再启
  # RC_INTERNAL_STOP=1：内部清理不落 run/stopped，避免新看门狗误判人工停止
  echo "[dsh-web] 检测到部分组件仍在运行，先停止残留 ..."
  RC_INTERNAL_STOP=1 "$REPO_DIR/bin/down.sh" || echo "[dsh-web] ⚠ 清理残留失败，继续尝试启动 ..."
fi

# 本机服务与 cloudflared/ 都不需要代理；环境里的死代理只会坏事
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

echo "[dsh-web] 1/4 检查凭据 ..."
[ -f "$RC_HOME/password" ] || "$REPO_DIR/scripts/gen-password.sh"
[ -f "$RC_HOME/session.secret" ] || {
  openssl rand -hex 32 > "$RC_HOME/session.secret"
  chmod 600 "$RC_HOME/session.secret"
}

# Caddyfile 通过 {env.*} 占位符读取以下变量；RC_TOKEN 即会话 Cookie 令牌
export RC_LOG_DIR="$RC_HOME/logs"
export RC_UPSTREAM RC_LISTEN
RC_TOKEN="$(cat "$RC_HOME/session.secret")"
export RC_TOKEN

echo "[dsh-web] 2/4 启动认证服务与 Caddy 密码门 ..."
nohup python3 "$REPO_DIR/bin/auth-server.py" >>"$RC_HOME/logs/auth.log" 2>&1 &
echo $! > "$RC_HOME/run/auth.pid"
nohup caddy run --config "$RC_HOME/Caddyfile" --adapter caddyfile \
  >>"$RC_HOME/logs/caddy.stdout.log" 2>&1 &
echo $! > "$RC_HOME/run/caddy.pid"

# 选择隧道模式：Named Tunnel（固定域名）或 Quick Tunnel（随机 URL）
# 检查配置完整性：只配一个则报错
if [ -n "${RC_TUNNEL_NAME:-}" ] && [ -z "${RC_TUNNEL_HOSTNAME:-}" ]; then
  echo "[dsh-web] ✗ 配置错误: 设置了 RC_TUNNEL_NAME 但缺少 RC_TUNNEL_HOSTNAME"
  exit 1
fi
if [ -z "${RC_TUNNEL_NAME:-}" ] && [ -n "${RC_TUNNEL_HOSTNAME:-}" ]; then
  echo "[dsh-web] ✗ 配置错误: 设置了 RC_TUNNEL_HOSTNAME 但缺少 RC_TUNNEL_NAME"
  exit 1
fi

# 里程碑检查 1：隧道启动前若已人工停止，自愈立即回滚放弃
if selfheal_stopped; then
  echo "[dsh-web] 检测到人工停止标志，自愈启动中止，回滚已启动组件"
  RC_INTERNAL_STOP=1 "$REPO_DIR/bin/down.sh" >/dev/null 2>&1
  exit 80
fi

if [ -n "${RC_TUNNEL_NAME:-}" ] && [ -n "${RC_TUNNEL_HOSTNAME:-}" ]; then
  # 简单 hostname 格式校验
  case "$RC_TUNNEL_HOSTNAME" in
    *[!a-zA-Z0-9.-]*|""|.*|*-)
      echo "[dsh-web] ✗ RC_TUNNEL_HOSTNAME 格式无效: $RC_TUNNEL_HOSTNAME"
      exit 1
      ;;
  esac
  echo "[dsh-web] 3/4 建立 Named Tunnel（固定域名: ${RC_TUNNEL_HOSTNAME}）..."
  : > "$RC_HOME/logs/cloudflared.log"
  : "${RC_TUNNEL_PROTOCOL:=http2}"
  nohup cloudflared tunnel --no-autoupdate --protocol "$RC_TUNNEL_PROTOCOL" \
    run "$RC_TUNNEL_NAME" \
    >>"$RC_HOME/logs/cloudflared.log" 2>&1 &
  CFPID=$!
  echo "$CFPID" > "$RC_HOME/run/cloudflared.pid"
  URL="https://$RC_TUNNEL_HOSTNAME"
  # 等待隧道真正建立（检查 Registered tunnel connection 或错误）
  i=0
  while [ $i -lt 30 ]; do
    # 检查错误
    if grep -q "error\|failed\|unable" "$RC_HOME/logs/cloudflared.log" 2>/dev/null; then
      echo "[dsh-web] ✗ Named Tunnel 启动失败:"
      tail -5 "$RC_HOME/logs/cloudflared.log"
      RC_INTERNAL_STOP=1 "$REPO_DIR/bin/down.sh" >/dev/null 2>&1
      exit 1
    fi
    # 检查成功标记
    if grep -q "Registered tunnel connection" "$RC_HOME/logs/cloudflared.log" 2>/dev/null; then
      break
    fi
    kill -0 "$CFPID" 2>/dev/null || break
    i=$((i + 1))
    [ $((i % 10)) -eq 0 ] && echo "[dsh-web]   ...等待隧道连接（剩余 $((30 - i))s）"
    sleep 1
  done
  # 最终验证进程存活
  kill -0 "$CFPID" 2>/dev/null || {
    echo "[dsh-web] ✗ Named Tunnel 进程退出，回滚已启动的组件"
    RC_INTERNAL_STOP=1 "$REPO_DIR/bin/down.sh" >/dev/null 2>&1
    echo "[dsh-web]   排查: dsh-web logs cloudflared"
    exit 1
  }
else
  echo "[dsh-web] 3/4 建立 Cloudflare 隧道（Quick Tunnel，URL 每次随机）..."
  # 清空旧隧道日志，避免 URL 解析抓到上一次连接的旧地址
  : > "$RC_HOME/logs/cloudflared.log"
  # 默认 http2（TCP）：本机若开着代理 TUN（如 Clash Verge），QUIC/UDP 长连接会随
  # TUN 路由抖动反复 "network is down"，公网侧表现为间歇性 502/530
  : "${RC_TUNNEL_PROTOCOL:=http2}"
  nohup cloudflared tunnel --url "http://$RC_LISTEN" --no-autoupdate \
    --protocol "$RC_TUNNEL_PROTOCOL" \
    >>"$RC_HOME/logs/cloudflared.log" 2>&1 &
  CFPID=$!
  echo "$CFPID" > "$RC_HOME/run/cloudflared.pid"

  # 等待 URL（最长 45s，每 10s 汇报一次剩余时间）
  URL=""
  i=0
  while [ $i -lt 45 ]; do
    URL="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$RC_HOME/logs/cloudflared.log" 2>/dev/null | tail -1)"
    [ -n "$URL" ] && break
    kill -0 "$CFPID" 2>/dev/null || break
    i=$((i + 1))
    [ $((i % 10)) -eq 0 ] && echo "[dsh-web]   ...等待隧道 URL（剩余 $((45 - i))s）"
    sleep 1
  done
  if [ -z "$URL" ]; then
    echo "[dsh-web] ✗ 未获取到隧道 URL，回滚已启动的组件"
    RC_INTERNAL_STOP=1 "$REPO_DIR/bin/down.sh" >/dev/null 2>&1
    echo "[dsh-web]   排查: dsh-web logs cloudflared"
    exit 1
  fi
fi
echo "$URL" > "$RC_HOME/run/url"

# 隧道通了不等于入口可用：Caddy 配置编译失败 / 端口被占 / auth 启动崩溃时，
# 上面的 nohup 都不会报错，必须实测密码门(302)和登录服务(200)才算就绪
echo "[dsh-web] 4/4 校验本地网关 ..."
RC_AUTH_PORT="${RC_AUTH_PORT:-9091}"
GATE_CODE="000"; AUTH_CODE="000"
i=0
while [ $i -lt 15 ]; do
  GATE_CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$RC_LISTEN/" 2>/dev/null)"
  AUTH_CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$RC_AUTH_PORT/rc-login" 2>/dev/null)"
  [ "$GATE_CODE" = "302" ] && [ "$AUTH_CODE" = "200" ] && break
  i=$((i + 1))
  sleep 1
done
if [ "$GATE_CODE" != "302" ] || [ "$AUTH_CODE" != "200" ]; then
  echo "[dsh-web] ✗ 本地网关未就绪（密码门 $GATE_CODE/期望302，登录服务 $AUTH_CODE/期望200），回滚已启动的组件"
  RC_INTERNAL_STOP=1 "$REPO_DIR/bin/down.sh" >/dev/null 2>&1
  echo "[dsh-web]   排查: dsh-web logs auth 或 dsh-web logs caddy"
  exit 1
fi

# 看门狗必须在 URL 落盘后启动：它以 run/url 为基线，若早于 URL 启动会把
# 首个 URL 误判为「地址变化」，导致启动后 30s 重复推送一次通知。
# 已有看门狗（如 launchd KeepAlive 拉起的 standby 实例）则不重复拉起；
# pid 加命令行双重校验，避免 pgrep 子串误匹配（如编辑器打开了该文件）
echo "[dsh-web]    校验通过，启动看门狗并推送飞书通知 ..."
# 里程碑检查 2：通知/接管前若已人工停止，自愈立即回滚放弃
if selfheal_stopped; then
  echo "[dsh-web] 检测到人工停止标志，自愈启动中止，回滚已启动组件"
  RC_INTERNAL_STOP=1 "$REPO_DIR/bin/down.sh" >/dev/null 2>&1
  exit 80
fi
# 走到这说明链路就绪：解除自愈冷却（若有）
rm -f "$RC_HOME/run/heal-failed"
WPID="$(cat "$RC_HOME/run/watchdog.pid" 2>/dev/null || true)"
if [ -n "$WPID" ] && is_proc "$WPID" "$(component_pattern watchdog)"; then
  echo "[dsh-web]    watchdog 已在运行，跳过拉起"
else
  nohup "$REPO_DIR/bin/watchdog.sh" >>"$RC_HOME/logs/watchdog.log" 2>&1 &
  # 不预写 watchdog.pid：由看门狗启动时 noclobber 原子认领，避免认领竞争
fi
"$REPO_DIR/bin/notify-feishu.sh" "remote.started" "$URL" || true

echo ""
echo "[dsh-web] ✅ 远程入口: $URL"
echo "[dsh-web]    密码: $(cat "$RC_HOME/password" 2>/dev/null || echo '(见 ~/.remote-control/password)')"
echo "[dsh-web]    通知: $([ -n "${RC_FEISHU_OPEN_ID:-}" ] || [ -n "${RC_FEISHU_WEBHOOK:-}" ] && echo 已推送飞书 || echo '未配置（rc.env 里填 RC_FEISHU_OPEN_ID）')"