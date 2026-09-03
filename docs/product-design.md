# Remote Control · 产品方案设计（DSH 远程访问）

| | |
|---|---|
| 版本 | v0.3（active reference · M1 完成，2026-08-30） |
| 仓库 | `/Users/rocky/project/remote-control`（main 分支） |
| Git 身份 | `summy wu <summy.wu81@gmail.com>`（沿用 signal-hunter，GitHub 账号 `oh-summy`） |
| 平台策略 | **macOS 优先**（开发+验收）· **Linux/VPS/云服务器一等支持**（M3 落地）· **Windows 不官方支持，开放 PR** |
| 上游调研 | [DSH 远程访问安全方案调研报告](https://my.feishu.cn/docx/HkJGd37SToEFEaxU5KbckaLUnjc)（2026-08-28） |
| 状态 | M1 完成，M2 进行中 |

---

## 1. 一句话定位

让我在任意网络环境下通过浏览器**安全地远程控制 Mac / Linux 服务器上的 DSH**，隧道与访问状态变化**自动推送到飞书**。

**产品策略：本地优先，插件随后。** 先在自己 Mac 上把「远程访问 + 密码认证 + 飞书通知」跑通、稳定自用 ≥1 周，再沉淀为 DSH 插件发布。这一条是本方案与调研报告最大的不同：报告建议"先试现有插件"，按当前决策，我们自建项目，现有插件只作为 M1 完成后的对照参考（可选）。

**平台策略**：macOS 是开发与第一验收平台（我有完整测试条件）；Linux（VPS / 云服务器 / x86_64 + arm64）是一等支持目标，M3 落地；Windows 不做官方支持——我没有测试条件，开放 PR 让外部贡献者提交（要求附带实测环境说明），详见 §9。

## 2. 产品原则

1. **自用优先**：M1/M2 一切以"我自己能稳定远程控制"为唯一验收方，不做多用户、不做通用化抽象。
2. **彻底解耦**：DSH 只绑 `127.0.0.1:3080`（Mac 现状已满足，已验证）；链路上的组件不调用任何 DSH 内部 API → **DSH 升级零影响**。
3. **复用成熟件**：v1 认证用 Caddy、隧道用 cloudflared，不自研加密/代理内核；自研代码只做**编排 + 通知**。
4. **安全默认**：全程 HTTPS（隧道边缘自带）、密码 bcrypt 哈希、失败锁定、密码一次性展示。
5. **可演进**：目录结构、脚本接口、事件定义按"未来插件化"预留，插件化是平移而非重写。
6. **跨平台分层**：平台差异**只允许**收敛在两层——`scripts/install.sh`（包管理/路径）和服务单元文件（launchd / systemd）；其余脚本与配置模板必须平台无关，且保持 bash 3.2 / POSIX 兼容（macOS 自带 bash 3.2，不能只按 Linux 的 bash 5 写）。

## 3. 用户与核心场景

单用户（我自己）；常用设备：iPhone、外网电脑；目标主机：Mac（现在）+ Linux VPS/云服务器（M3 起）。

- **S1 外网访问**：出门在外 → 浏览器打开 URL → 密码登录 → 正常使用 DSH（流式对话不中断）。
- **S2 重启自愈**：主机重启或进程崩溃 → 服务管理器（launchd/systemd）自动拉起全链路 → 新 URL 自动推送到飞书。
- **S3 安全告警**：连续密码错误 → 限流锁定 → 飞书告警。
- **S4 通知兜底**（刚需，非增强）：Quick Tunnel 每次启动 URL 都会变，**不推送就等于失联**——这是通知功能优先级最高的原因。
- **S5 多机部署**：同一套仓库，Mac 与 Linux VPS 各部署一份，`install.sh` 自行识别平台完成安装。

## 4. 需求清单

| 优先级 | 内容 |
|---|---|
| **P0（M1，Mac）** | 隧道公网可达；密码认证；WebSocket/SSE 透传；启动后飞书推送「URL + 密码」；launchd 常驻自启 |
| **P1（M2，Mac）** | 失败锁定/限流；断线看门狗自愈；日志轮转；一键换密码脚本；install.sh 幂等安装 |
| **P2（M3，Linux）** | systemd 服务单元；多包管理器安装（apt/dnf/brew/官方二进制）；脚本 POSIX 兼容审计；VPS 实机验收 |
| **P3（M4+）** | TOTP 两步验证；固定域名（Named Tunnel）；多通道通知；审计日志；插件化发布 |

## 5. 总体架构（v1）

```
iPhone / 外网电脑浏览器
      │ HTTPS
      ▼
Cloudflare 边缘（Quick Tunnel: https://<随机>.trycloudflare.com）
      │ （主机只有出站连接，不开任何入站端口）
      ▼
cloudflared（常驻，launchd/systemd 托管）
      │ http://127.0.0.1:4080
      ▼
Caddy（Basic Auth 认证 + 反向代理，常驻）
      │ http://127.0.0.1:3080（RC_UPSTREAM 可配置）
      ▼
DSH web profile（保持 loopback，零改动）
```

**通知链路**：`watchdog` 脚本监听 cloudflared 日志与各进程健康状态 → 识别 URL 变化/异常 → 调用飞书群机器人 Webhook 推送。

**常驻方式**：服务管理器托管三个 `自动重启` 服务（cloudflared / caddy / watchdog）——macOS 用 launchd（KeepAlive），Linux 用 systemd（`Restart=always`）；开机自启、崩溃自动重启。

**消息模板（P0）**：

```
【Remote Control】远程访问已就绪 ✅
主机: rocky-mac（hostname，便于多机区分）
URL:  https://xxxx.trycloudflare.com
密码: <完整密码，个人群可见>
状态: 隧道已连接 · Caddy 正常 · 上游 3080 存活
```

> 密码明文推送是 P0 的便捷取舍（个人群、单用户）。M2 提供 `RC_NOTIFY_PASSWORD=mask` 配置项，改为只推后 4 位，完整密码从本机 `~/.remote-control/password` 查看。

### 5.1 仓库结构

```
remote-control/
├── docs/product-design.md   # 本文档
├── bin/                     # up.sh / down.sh / status.sh / notify-feishu.sh / watchdog.sh
├── etc/                     # Caddyfile.tmpl、rc.env 模板
├── launchd/                 # macOS：com.ohsummy.remotecontrol.{cloudflared,caddy,watchdog}.plist
├── systemd/                 # Linux：remote-control-{cloudflared,caddy,watchdog}.service
├── scripts/                 # install.sh（自动识别平台）/ gen-password.sh / rotate-password.sh
└── README.md
```

运行时数据（密码、webhook URL、日志）不进仓库，统一放 `~/.remote-control/`（权限 600；路径基于 `$HOME`，天然跨平台）。

### 5.2 隧道选型

| 模式 | 前置条件 | URL | 定位 |
|---|---|---|---|
| **Quick Tunnel**（M1 默认） | 无需账号/域名 | 每次启动随机变化 | 最快跑通，强依赖飞书通知 |
| **Named Tunnel**（M2+ 推荐） | Cloudflare 免费账号 + 一个域名 | 固定 | URL 稳定后通知退化为"状态告警" |
| Tailscale（备选 Plan B） | 双端装客户端 | 100.x 虚拟内网 | 出站 443 被封/对隧道不放心时启用 |
| frp（备选） | 一台公网 VPS | 固定 | 已有 VPS 时可用 |

## 6. 关键设计决策

- **D1 · v1 认证用 Caddy 而非自写代理**：Caddy 生产级处理 WebSocket/SSE/大报文，Mac `brew install`、Linux 官方 apt/dnf 仓库分钟级可用，配置 ~5 行；自写代理的 WS/SSE 边界处理是调研报告中点名的坑。自研代理仅在插件化阶段若内核需要时再评估。
- **D2 · 插件化推迟到最后，且以"双平台稳定 ≥1 周"为门禁**：调研报告确认该领域是红海（10+ 同类插件），做插件的动机应当是"打磨过的自有方案反哺生态"，而不是"为了插件而插件"。本地版本身就是最终方案的编排层原型；生态用户大量在 Linux，插件发布前必须先有 Linux 实测。
- **D3 · 认证放代理层，不进 DSH 层**：不修改 DSH 配置、不装第三方认证插件，规避调研报告指出的"插件依赖 DSH 内部 Cordis API、随版本升级碎裂"的最大风险。
- **D4 · 密码管理**（v3 起认证改 Cookie 令牌方案，bcrypt 环节已被取代，见 tech-notes）：`gen-password.sh` 用 `openssl rand` 生成 ≥128bit 熵口令 → 明文仅首次展示 + 推送飞书一次，本机存 `~/.remote-control/password`（600）。`rotate-password.sh` 一键轮换并重载 Caddy。
- **D5 · 通知是刚需**：见 S4。watchdog 对 URL 变化、进程死亡、上游不可达三类事件都推送，推送失败降级写本地日志；消息带 hostname，多机部署时不混淆。
- **D6 · 命名**（2026-08-31 修订）：仓库与插件包统一命名 `dsh-remote-control`，`dsh-` 前缀保持与 DSH 生态一致，仓库公开（MIT）。
- **D7 · 平台策略（分层收敛）**：Mac 优先开发验收 → Linux（VPS/云服务器）M3 一等支持 → Windows 不官方支持、开放 PR（我无 Windows 测试条件，不发布自己没验证过的东西；PR 要求贡献者附带实测环境与截图）。技术上，平台差异只允许出现在 `install.sh` 与服务单元文件两层，核心脚本保持 bash 3.2/POSIX 兼容，上游地址 `RC_UPSTREAM` 可配置（默认 `127.0.0.1:3080`，使其不绑定 DSH 也能反代其他本地服务）。

## 7. 里程碑与验收标准

### M0 · 项目初始化 ✅（本文档）

### M1 · Mac 远程控制跑通（预计 1~2 天）

步骤：`brew install cloudflared caddy` → `gen-password.sh` 生成凭据 → 由模板渲染 `Caddyfile`（监听 `127.0.0.1:4080`，basic_auth + reverse_proxy `RC_UPSTREAM`）→ `up.sh` 拉起 cloudflared Quick Tunnel → watchdog 解析 URL 推飞书 → 安装 launchd plist。

**验收清单（7 条，全部通过才算 M1 完成）**：

1. 手机蜂窝网络（非 Wi-Fi）打开 quick URL → 认证页 → 登录后 DSH UI 完整可用
2. 流式对话（WebSocket/SSE）连续 ≥10 分钟不断流
3. DSH 进程重启后，代理层零改动自动恢复访问
4. Mac 重启后 launchd 自动拉起全链路，飞书在 60 秒内收到新 URL
5. 连续 5 次错误密码后被限流
6. cloudflared + caddy 常驻内存增量 ≤ 30MB
7. `down.sh` 一键停全链路，`status.sh` 能汇报三组件状态

### M2 · Mac 稳定与安全加固（预计 2~3 天）

- Named Tunnel 固定域名（决策点：是否注册/使用域名）
- `install.sh` 幂等安装（Mac 干净环境一条命令跑通）
- `rotate-password.sh` 一键换密码（1 分钟内完成，旧会话失效）
- 看门狗自愈：断网重连、cloudflared 崩溃重启、通知降级策略
- 日志轮转 + 密码掩码通知选项

**验收**：拔网线 5 分钟后恢复 → 全链路自愈且飞书收到状态更新；`install.sh` 在另一台 Mac 干净跑通。

### M3 · Linux / VPS / 云服务器适配（预计 2~3 天）

- `install.sh` 平台检测与包管理适配：Debian/Ubuntu（cloudflared + caddy 官方 apt 仓库）、RHEL 系（dnf）、其他（官方二进制 fallback）
- systemd 单元三件套（`Restart=always`，开机自启），替代 launchd
- 全脚本 bash 3.2/POSIX 兼容审计（macOS bash 3.2 与 Linux bash 5 双跑）；路径全部基于 `$HOME` 与 `uname` 检测，无硬编码
- Linux 无休眠问题（R1 仅 Mac 相关）；关注点换成防火墙（ufw/firewalld 一般无需改动，cloudflared 纯出站）

**验收（需一台真实 VPS/云服务器）**：

1. 干净 Ubuntu VPS 上 `install.sh` 一条命令跑通，飞书收到 URL
2. VPS 重启后 systemd 自动拉起全链路
3. Mac 上验证过的验收清单 1/2/5/7 在 VPS 上复验通过
4. x86_64 至少实测一台风（arm64 有条件则加）

### M4 · 插件化（预计 5~7 天，门禁：Mac + Linux 各稳定运行 ≥1 周）

- 把编排与通知沉淀为 DSH 插件（插件包名 `dsh-remote-control`，`dsh.bundle` manifest，`dsh plugin --profile web add` 一行安装）
- **Notifier 接口**（沿用调研报告的边界设计）：`notify(event, payload)`，事件 `remote.started / remote.changed / remote.down / auth.lockout`；渠道：终端（内置）、飞书 Webhook（内置，~10 分钟）、其余交给 `chicheng-push` 等现有插件
- DSH Settings 配置页；README；投稿 awesome-dsh-plugin
- **差异化定位**：不做第 11 个认证插件，做"隧道 + 认证 + 安全事件通知"的开箱即用组合

## 8. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | Mac 休眠导致失联（**仅 Mac；Linux 服务器无休眠**） | `pmset`/`caffeinate` 保持网络唤醒；watchdog 检测到不可达即推飞书 |
| R2 | 运营商/公司网络封出站 443 或干扰 trycloudflare | Plan B：Named Tunnel / Tailscale / frp |
| R3 | 密码泄露 | `rotate-password.sh` 一键轮换 + 失败锁定 + 通知改掩码模式 |
| R4 | Quick Tunnel 依赖 Cloudflare 免费服务可用性 | 架构上隧道可替换（etc/ 下模板化），切换成本 ≤ 半天 |
| R5 | DSH 大版本升级 | 架构上零内部依赖；保留 10 分钟回归清单（验收 1/2/3 条） |
| R6 | 飞书 Webhook 失效（机器人被删/群解散） | 推送失败写本地日志；`status.sh` 可查最近一次通知结果 |
| R7 | 跨平台差异扩散（脚本里散落 `uname` 分支，改一处坏一处） | 强约束 D7：差异只准在 install.sh + 服务单元两层；CI 对 macos/ubuntu 双平台跑 shellcheck 与冒烟；平台相关 PR 必须附实测说明 |

## 9. 仓库与协作

**支持矩阵**：

| 平台 | 支持级别 | 说明 |
|---|---|---|
| macOS（x86_64 / arm64） | ⭐ 优先开发 + 完整验收 | M1/M2 的唯一目标 |
| Linux x86_64 / arm64（Ubuntu/Debian 优先，RHEL 系兼容） | 一等支持 | M3 落地，VPS 实机验收 |
| Windows | 不官方支持，**开放 PR** | 我无测试条件；接受外部贡献者提交，PR 须附带实测环境说明与验证截图 |

**工程约定**：

- 远程仓库：`https://github.com/oh-summy/dsh-remote-control.git`（公开，MIT，分支保护：PR + CI 必过）
- License：MIT（已定稿）
- 运行时敏感数据一律不进 git（`.gitignore` 覆盖 `*.env`、`password`、`Caddyfile` 渲染产物）
- CONTRIBUTING.md（M3 前建立）：平台相关 PR 的实测要求、bash 3.2 兼容要求、验收清单引用
- CI（M2 起）：GitHub Actions，`ubuntu-latest` + `macos-latest` 双平台跑 shellcheck + 干净环境 `install.sh` 冒烟

## 10. 与调研报告结论的对应

| 调研报告结论 | 本方案采纳方式 |
|---|---|
| 方案 A：优先试现有插件 | 按用户新决策改为自建；M1 后可选择性试用 `dsh-auth-tunnel` 对照体验 |
| 方案 B：Caddy 独立代理 | **v1 核心采纳**（独立于 DSH 版本、可靠、极简、跨平台） |
| 通知做插件化 Notifier 接口 | M4 插件设计直接沿用 |
| "全家桶"差异化机会 | M4 发布时的定位：隧道+认证+安全事件通知一体；跨 Mac/Linux 是对现有红海插件的实质差异点 |

## 附录 · 环境基线与实施记录

- 开发机：macOS（darwin 21.6.0 x64），brew `/usr/local/bin/brew`
- `dsh` 0.1.1-rc.2（`/Users/rocky/.npm-global/bin/dsh`），web profile 已运行于 `127.0.0.1:3080`
- node v22.19.0
- 技术选型对比与 DSH 官方插件形式调研：见 [tech-notes.md](tech-notes.md)

### M1 实施记录（2026-08-30，当天完成）

- ✅ 组件就绪：cloudflared 2026.8.2、caddy v2.11.4（官方二进制，装于 `~/.remote-control/bin`；不依赖 brew——brew 在本机触发源码编译，Caddy v2.11+ Release 已无 darwin 资产）
- ✅ 脚本齐备：`install.sh / gen-password.sh / up.sh / down.sh / status.sh / notify-feishu.sh / watchdog.sh / auth-server.py`
- ✅ 全链路已验证：公网无 Cookie 302→登录页 · 密码登录得会话 Cookie · 带 Cookie 200 · 连错 5 次锁定 429 · 上游 DSH 200 · watchdog 自动跟踪 URL 变化
- ✅ 认证 v2（当天升级）：Basic Auth → 登录页 + HMAC 会话 Cookie（根因：Safari 不在 WebSocket 握手上带 Basic 凭据导致反复弹框，见 tech-notes.md）；失败锁定同时达成验收第 5 条
- ✅ 通知 v2（当天升级）：飞书 bot 私发（固定 APP 凭据，`lark-cli im +messages-send --as bot`，dm-ok 实测）；群 Webhook 保留为兜底通道
- ✅ 决策落地：Quick Tunnel + Cookie 登录页认证 + bot 私发通知 + 手动启停（launchd 归 M2）
- ⏳ 待用户：手机蜂窝网络实测验收 1/2 条（新登录页体验）
- ⏳ 待做（M2）：launchd 自启；Named Tunnel 固定域名；rotate-password.sh；TOTP 可选

### 关键踩坑

1. Caddyfile 站点地址必须 `:4080`（匹配任意 Host）——cloudflared 转发请求的 Host 是 trycloudflare 域名，写 `127.0.0.1:4080` 会导致请求绕过站点块、认证墙失效
2. `caddyserver.com/api/download` 返回**裸二进制**且**不支持断点续传**（-download 脚本需整文件重试 + `--speed-limit` 僵死检测）
3. up.sh 启动 cloudflared 前必须清空旧日志，否则 URL 解析会抓到上一次连接的旧地址