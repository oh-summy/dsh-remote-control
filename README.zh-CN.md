# dsh-remote-control

[English](README.md) | [中文](README.zh-CN.md)

为跑在你自己 Mac / Linux 服务器上的 **DeepSeek Harness（DSH）** 提供安全的远程访问：
**Cloudflare 隧道 → 密码门 → DSH**，入口地址或服务状态一有变化，**飞书卡片通知**立刻推到你手机。

```
浏览器 ──HTTPS──▶ Cloudflare 边缘（Quick Tunnel: https://<随机>.trycloudflare.com）
                        │  只有出站连接，不开任何入站端口
                        ▼
                 cloudflared ──▶ Caddy（密码门 + 会话 Cookie）
                        │  http://127.0.0.1:3080
                        ▼
                 DSH web profile（只绑 loopback，零改动）
```

## 为什么做这个

- **不开任何入站端口**——主机只通过隧道发起出站连接。
- **DSH 前面有密码门**——登录页 + 签名会话 Cookie（7 天有效），连续错 5 次锁定来源 IP。
  DSH 本体零改动。
- **飞书通知是刚需，不是锦上添花**——Quick Tunnel 每次启动都分配*新的随机 URL*，没有推送
  通道就等于失联。每次 `start` / URL 变化 / 故障 / 恢复都会推送卡片，并单独发一条可直接
  复制的密码纯文本消息。
- **DSH 升级免疫**——链路只与 `127.0.0.1:3080` 说 HTTP，不碰任何 DSH 内部 API；代理层自动
  重写 `Host`/`Origin`，隧道域名每次变化后 DSH 的 browser-trust 防线依旧放行。

## 快速开始

环境要求：macOS（x86_64 / arm64）或 Linux（x86_64 / arm64）、`curl`、`python3`。
Windows 不在官方支持范围——欢迎附实测证据提 PR。

```bash
git clone https://github.com/oh-summy/dsh-remote-control.git
cd dsh-remote-control
scripts/install.sh     # 下载官方 cloudflared/caddy 二进制，生成密码
```

前置条件：DSH web profile 已在 `127.0.0.1:3080` 运行（用 `dsh web` 自行启动）——
`dsh-web` 只管理网关，不负责 DSH 的启停。

然后编辑 `~/.remote-control/rc.env`：

- **主通知通道（bot 私发）**：填 `RC_FEISHU_OPEN_ID`（你的 open id，`ou_` 开头）。需要安装并
  配置 [`lark-cli`](https://github.com/larksuite/cli)（`lark-cli config init` 配置你的飞书应用），
  应用机器人需有发消息权限且能给你发私信。
- **兜底通道**：填 `RC_FEISHU_WEBHOOK`（群自定义机器人 Webhook），无需 lark-cli。
  两者都填时优先私发，失败才走 Webhook。

启动：

```bash
dsh-web start
```

`start` 会在终端打印 URL 和密码后返回命令行，同时推送卡片 + 密码到你的飞书私聊。打开 URL，
输一次密码即可，Cookie 7 天内免登录。

## 安装方式与版本策略

**没有任何人需要源码编译。** `install.sh` 按优先级选择：

1. **系统已有**（`caddy` / `cloudflared` 已在 `PATH`，比如 brew 或官方 apt 仓库装的）→
   直接使用，零下载。
2. **官方预编译静态二进制** → 从 cloudflared 的 GitHub Releases 与 caddyserver.com 官方构建
   API 下载（Caddy v2.11 起 GitHub Release 不再提供 darwin 资产），放入
   `~/.remote-control/bin/`。全程不碰编译器。

**版本默认跟随上游 latest**——这是刻意设计：隧道客户端持续获得安全修复，且 Cloudflare 会
逐步淘汰旧版 cloudflared；本项目依赖面极小（几个 CLI flag + 基础 Caddyfile 语法），上游
变动风险很低。需要紧急回滚时可钉版：

```bash
RC_CLOUDFLARED_VERSION=2026.8.2 scripts/install.sh   # GitHub release tag，两平台通用
RC_CADDY_VERSION=v2.11.4 scripts/install.sh          # 仅 linux；darwin 构建 API 只有最新版
```

作为 DSH 插件（M4）：安装方式将变成生态标准的
`dsh plugin --profile web add dsh-remote-control`（纯 npm 包，同样无需源码编译），
二进制获取逻辑并入插件首次启动。

## 命令

| 命令 | 用途 |
|---|---|
| `dsh-web start` | 启动全链路，终端打印 URL + 密码（飞书同步通知） |
| `dsh-web stop` | 停止全链路 |
| `dsh-web restart` | 重启（URL 会变，自动推新卡片） |
| `dsh-web status` | 组件状态 + 认证墙/上游健康度 |
| `dsh-web logs [caddy\|cloudflared\|auth\|watchdog\|notify\|all]` | 查看日志 |
| `dsh-web password` | 打印访问密码 |
| `dsh-web url` | 打印当前入口 URL |
| `dsh-web install` | 安装/修复（二进制、配置、凭据、命令链接） |

## 配置——`~/.remote-control/rc.env`

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RC_UPSTREAM` | `127.0.0.1:3080` | 要保护的本地服务（任何本地 HTTP 服务，不限 DSH） |
| `RC_LISTEN` | `127.0.0.1:4080` | Caddy 监听地址（只绑回环） |
| `RC_FEISHU_OPEN_ID` | — | 飞书私聊通知的 open id（主通道） |
| `RC_FEISHU_WEBHOOK` | — | 群自定义机器人 Webhook（兜底通道） |
| `RC_NOTIFY_PASSWORD` | `full` | `full` = 密码单独成条推送；`mask` = 只推后 4 位 |

运行时数据（密码、令牌、日志）都在 `~/.remote-control/`，权限 600，永不进 git。

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS x86_64 / arm64 | ✅ 开发与验收平台 |
| Linux x86_64 / arm64（Ubuntu/Debian 优先） | ✅ 同一安装器，systemd 单元规划中（M3） |
| Windows | ❌ 不官方支持；欢迎附实测证据提 PR |

## 安全说明

- DSH 始终只绑 `127.0.0.1`；唯一公网暴露面是密码门之后的 Cloudflare 边缘。
- 密码：128 位随机生成，本地保存（权限 600）；连续失败 5 次锁定来源 IP 5 分钟（HTTP 429）。
- 会话 Cookie 为 `HttpOnly` + `SameSite=Lax`，7 天有效。轮换方式：重新生成密码
  （`scripts/gen-password.sh`）和/或修改 `~/.remote-control/session.secret`，然后 `dsh-web restart`。
- 严禁提交 `rc.env`、`password`、`session.secret` 和渲染后的 `Caddyfile`——`.gitignore` 已
  覆盖，CI 与评审双重把关。

## 路线图

- [x] M1 —— macOS：隧道 + 密码门 + 飞书卡片通知，端到端验证
- [ ] M2 —— launchd 自启、固定域名（Named Tunnel）、一键换密码
- [ ] M3 —— Linux/VPS：systemd 单元、apt/dnf 安装路径、POSIX 兼容审计、VPS 实机验收
- [ ] M4 —— 封装为 DSH 插件（`dsh plugin --profile web add`），Notifier 事件接口

设计决策与踩坑记录（中文）：[docs/product-design.md](docs/product-design.md)、
[docs/tech-notes.md](docs/tech-notes.md)。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md) · [English](CONTRIBUTING.zh-CN.md)。简言之：CI 必须通过（`shellcheck` + 语法检查）、脚本
保持 bash 3.2 / POSIX 兼容、平台相关改动必须附真实测试证据。

## 许可证

[MIT](LICENSE) © 2026 Summy Wu (oh-summy)
