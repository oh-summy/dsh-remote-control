# 贡献指南

[English](CONTRIBUTING.md)

感谢关注 `dsh-remote-control`！

## 架构概览

贡献前建议先了解系统架构：

```
浏览器 ──HTTPS──▶ Cloudflare 边缘（Quick Tunnel）
                        │
                        ▼
                 cloudflared ──▶ Caddy（密码门）
                        │  http://127.0.0.1:3080
                        ▼
                 DSH web profile（只绑 loopback）
```

- `bin/up.sh` — 分阶段启动（凭据 → auth+Caddy → 隧道 → 网关校验）
- `bin/down.sh` — 逐组件停止 + 终态校验
- `bin/watchdog.sh` — 监控 URL 变化 / 隧道退出 / 上游健康
- `bin/auth-server.py` — 仅登录页（限流 + 密码校验 + Cookie）
- `bin/notify-feishu.sh` — 飞书卡片 + 纯文本密码
- `bin/status.sh` — 组件状态 + 健康检查
- `scripts/install.sh` — 下载官方二进制、初始化配置

详细架构见 [docs/architecture.md](docs/architecture.md)。

## 基本规则

1. **CI 必须全绿**：所有 shell 脚本（含 `bin/dsh-web`）过 `shellcheck`，另有 `bash -n` 与
   `python3 -m py_compile`；新增代码不允许带任何告警。
2. **必须兼容 bash 3.2 / POSIX**：macOS 自带的就是 bash 3.2，禁止使用 bash 4+ 特性
   （关联数组、`${var,,}`、`mapfile` 等）。
3. **平台改动要实测证据**：涉及 macOS / Linux 发行版 / Windows 的改动必须来自真实机器，
   注明系统版本、架构与执行步骤。Windows PR 只有附真实测试证据才会被接受（CI 覆盖不到）。
4. **密钥永不进 git**：密码、令牌、`rc.env`、`session.secret`、渲染后的 `Caddyfile`、
   你自己的 `open_id` / 入口 URL，一律不许提交或在 issue 里粘贴。
5. **一个 PR 只做一件事**，保持 diff 可评审。
6. **改动一律通过 PR 评审合入**——`main` 禁止直推（分支保护要求 `lint` 检查与评审通过）。

## 工作流

```bash
git clone https://github.com/oh-summy/dsh-remote-control.git
cd dsh-remote-control
# 建议推送前本地自查
shellcheck bin/*.sh scripts/*.sh bin/dsh-web && python3 -m py_compile bin/auth-server.py
git checkout -b feat/your-feature
# ... 开发 ...
git push -u origin feat/your-feature   # 然后向 main 发起 PR
```

CI 在 `push` 与 `pull_request` 时运行；分支保护要求 `lint` 检查通过。

## 报 bug

附上：系统与架构、`dsh-web status` 输出（不含密钥）、`dsh-web logs <组件>` 的相关片段、
预期行为与实际行为。