#!/usr/bin/env bash
# 静态扫描 bash 3.2 运行时陷阱：命名变量 $var 后紧跟非 ASCII 可打印字节（如
# 全角标点）时，bash 3.2 会把多字节字节吞进变量名，set -u 下直接 unbound
# variable 崩溃。CI 的静态检查（ubuntu bash5 上的 lint 与 macOS 的 bash -n）
# 都抓不到这类只在 macOS /bin/bash 3.2 运行时暴露的问题，故用字节级 grep 兜底。
# 取舍说明：
#   a) 字符类用 [^ -~]（0x20-0x7E，POSIX 括号表达式，BSD/GNU grep 通用）。
#      不用 [:ascii:]：那是 GNU 扩展，macOS 自带 /usr/bin/grep 直接报
#      invalid character class，会让整个扫描在目标平台静默失效。
#   b) 单引号内的 $var+全角 是合法字面量，会被保守误报——命中时人工确认。
#   c) 只覆盖命名变量；$$/$@/$* 是定长展开无此坑，$1+全角 会被保守标记（安全侧）。
set -u
cd "$(dirname "$0")/.." || exit 1

out="$(LC_ALL=C grep -nE '\$[A-Za-z0-9_]+[^ -~]' \
  bin/*.sh scripts/*.sh bin/dsh-web 2>/dev/null)"
rc=$?
if [ "$rc" -gt 1 ]; then
  echo "✗ 扫描器 grep 执行失败 (exit $rc)，不得静默放行" >&2
  exit 1
fi
if [ -n "$out" ]; then
  echo "✗ 发现 bash 3.2 变量定界陷阱（\$var 紧跟全角字符），改用 \${var}："
  printf '%s\n' "$out"
  exit 1
fi
echo "bash 3.2 pitfall scan ok"
