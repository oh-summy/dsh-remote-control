# Contributing · 贡献指南

Thanks for your interest in `dsh-remote-control`! / 感谢关注 `dsh-remote-control`！

## English

### Ground rules

1. **CI must pass.** Every PR runs `shellcheck` (all shell scripts, `bin/dsh-web` included),
   `bash -n`, and `python3 -m py_compile`. No warnings tolerated on new code.
2. **bash 3.2 / POSIX compatibility is mandatory.** macOS still ships bash 3.2; do not use
   bash-4+ features (associative arrays, `${var,,}`, `mapfile`, …). Test mentally against
   `/bin/bash` on macOS.
3. **Platform evidence.** Changes touching platform-specific behavior (macOS, Linux distros,
   or Windows) must come from a real machine — include OS version, architecture, and what you
   ran. Windows PRs are accepted only with real test evidence since CI cannot cover it.
4. **Secrets never enter git.** Do not commit (or paste in issues) passwords, tokens,
   `rc.env`, `session.secret`, rendered `Caddyfile`, or your own `open_id` / URLs.
5. **One PR, one concern.** Keep diffs reviewable; squashed commits are welcome.

### Workflow

```bash
git clone https://github.com/oh-summy/dsh-remote-control.git
cd dsh-remote-control
# optional but recommended: local shellcheck
shellcheck bin/*.sh scripts/*.sh bin/dsh-web && python3 -m py_compile bin/auth-server.py
git checkout -b feat/your-feature
# ... develop ...
git push -u origin feat/your-feature   # then open a PR against main
```

CI runs on `push` and `pull_request`; the `lint` check is required by branch protection.

### Reporting bugs

Include: OS + arch, `dsh-web status` output (it contains no secrets), the relevant file from
`dsh-web logs <component>`, and what you expected vs. what happened.

## 中文

### 基本规则

1. **CI 必须全绿**：所有 shell 脚本（含 `bin/dsh-web`）过 `shellcheck`，另有 `bash -n` 与
   `python3 -m py_compile`；新增代码不允许带任何告警。
2. **必须兼容 bash 3.2 / POSIX**：macOS 自带的就是 bash 3.2，禁止使用 bash 4+ 特性
   （关联数组、`${var,,}`、`mapfile` 等）。
3. **平台改动要实测证据**：涉及 macOS / Linux 发行版 / Windows 的改动必须来自真实机器，
   注明系统版本、架构与执行步骤。Windows PR 只有附真实测试证据才会被接受（CI 覆盖不到）。
4. **密钥永不进 git**：密码、令牌、`rc.env`、`session.secret`、渲染后的 `Caddyfile`、
   你自己的 `open_id` / 入口 URL，一律不许提交或在 issue 里粘贴。
5. **一个 PR 只做一件事**，保持 diff 可评审。

### 报 bug

附上：系统与架构、`dsh-web status` 输出（不含密钥）、`dsh-web logs <组件>` 的相关片段、
预期行为与实际行为。
