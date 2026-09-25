#!/usr/bin/env bash
# remote-control · 公共库（各脚本 source，单一事实源）
# 组件→命令行特征映射只在此定义一处：down.sh 停止、status.sh 展示、up.sh 清场
# 计数、watchdog.sh 自愈判断共用；新增组件时只改这里，漏配会被 *) 兜底拦截。
# shellcheck shell=bash

# 裸 pid 身份校验：进程活着且命令行匹配
is_proc() { # <pid> <grep 模式>
  ps -p "$1" -o command= 2>/dev/null | grep -q "$2"
}

# pid 文件身份校验：文件存在、pid 活着且命令行匹配（防 pid 复用误判）
alive_as() { # <pidfile> <grep 模式>
  [ -f "$1" ] || return 1
  local p
  p="$(cat "$1" 2>/dev/null)" || return 1
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  is_proc "$p" "$2"
}

# 组件→命令行特征（grep 模式）。未知组件返回失败，调用方必须处理而非放行。
# 模式与各组件真实 argv 逐一对应：watchdog/selfheal/up 由 nohup 以绝对路径拉起
# （ps 显示 "bash <路径>/bin/<名>.sh"），caddy/cloudflared/auth 见 up.sh 启动段。
component_pattern() { # <组件名>
  case "$1" in
    watchdog)    echo 'bin/watchdog\.sh' ;;
    selfheal)    echo 'bin/selfheal\.sh' ;;
    up)          echo 'bin/up\.sh' ;;
    cloudflared) echo 'cloudflared' ;;
    caddy)       echo 'caddy run --config' ;;
    auth)        echo 'bin/auth-server\.py' ;;
    *) return 1 ;;
  esac
}
