# @oh-summy/dsh-remote 插件设计

> 代码载体：本仓库 `plugin/`。上游参考：`docs/architecture.md`（v0.3.x 旁路网关）、`docs/tech-notes.md`（踩坑）。
> 原则：**不过度设计**——只做下面列的，实现从简。版本号只在发布时打（`v0.4.0` 发布时、`market-v0.1.0` 注册合入时），开发过程无版本。
> 本稿 = 2026-10-25 按负责人"不过度工程化"要求重写，吸收两轮审查的硬事实（v1.0–v1.2 过程记录见 git 历史）。

## 做什么

在 DSH 网页点开关 → 拿到 Cloudflare 临时链接 + 访问密码，浏览器远程使用本机 DSH；URL 变化可（可选）推飞书。

1. 页面一键启停（终端 CLI 保留为后备）。
2. 临时 URL 自动捕获/展示/复制，变化自动更新。
3. 密码门：自动生成强密码；远程登录一次直达 DSH；5 次失败锁 IP 5 分钟。
4. 敏感值页面默认掩码/presence、手动 reveal；存储走 `dsh-credentials` 凭据缝，不进配置文件。
5. 可选飞书通知：webhook 或 app（app_id + secret + open_id），测试按钮自动验证连通性；URL 变化按档位附带密码（默认 full）。
6. 关掉/卸载即回收子进程；配置编辑不炸隧道。
7. 附一个极简 launchd plist（只负责开机/崩溃后拉起 `dsh web`）+ 一次性安装脚本。

## 不做什么

Named Tunnel / 自定义域名（v2 再说）；SSH、文件传输、多用户；运行时管理 DSH 本体启停（plist 只负责"启动"）；飞书以外的通知渠道；自动下载 cloudflared/caddy（配置路径，缺了就报错）；自动猜收件人（人填、机器测）；跨平台（v1 仅 macOS）。

## 架构

```
远程浏览器 → CF 边缘（随机临时 URL，TLS 到此为止）
           → cloudflared（插件 spawn，仅出站）
           → Caddy 密码门（插件 spawn，127.0.0.1:4080）
           → DSH web（127.0.0.1:3080，宿主本体）
```

一个 cordis 包，跑在宿主进程内：

- **manager**：spawn/回收 cloudflared + caddy；日志 grep 捕 URL（45s 超时）；启动前端口残留探测（独立 run 目录 `~/.remote-control/run-plugin/`，与 v0.3.x 隔离，归属不明就 fail-loud 不抢端口）。
- **登录页**：插件自持 `127.0.0.1:9091`（替代 auth-server.py 独立进程）；密码比对 + 锁 IP + DSH 签名 cookie（HMAC 算法照抄 auth-server.py，移植 JS）。
- **通知**：事件 → 飞书卡片（webhook POST 或 open API），原生 fetch，无新依赖。
- **client**：Plugins 页配置页（开关 / URL / 密码 / 凭据 / 测试按钮 / 事件流），`@Remote` 调宿主。

技术栈：TypeScript + React（宿主契约决定）；cloudflared/caddy 照用现成 Go 二进制。

## 配置与凭据

- `remote.enabled`（volatile）、`remote.binary.*`（volatile）→ 普通 config。
- `password` / `webhookUrl` / `appSecret` → **dsh-credentials record**（轮换即时生效、不经 config、不落盘到 patch）。
- `appId` → 普通字段，页面显示尾 4 位；`openId` → 明文 + 获取引导文案。
- `passwordPolicy: full|mask|off`，**默认 full**——换域后旧 cookie 失效，只有 full 能让远端用户自救（v0.3.x 默认即 full）；选 mask/off 时 UI 明示"未另存完整密码将无法自救"。

## 已知坑与硬事实（两轮审查沉淀，实现时逐条对照）

1. Caddy 站点写 `:4080` 不写 `127.0.0.1:4080`，否则 Host 不匹配绕过认证墙。
2. 不用 `forward_auth`（backlog 溢出随机 502），用 Caddy Cookie 正则门。
3. cloudflared 用 `--protocol http2`（QUIC/Clash TUN 断流）；URL 从日志 grep 捕获。
4. launchd 不 source shell profile，且 `dsh` 的 shebang 依赖 PATH 里的 node——plist 必须注入 PATH 或直接用 node 绝对路径。
5. KeepAlive 只有固定间隔重拉，无退避——接受，不自建退避逻辑。
6. Caddy 必须重写 Host/Origin，否则过不了 DSH 的 browser-trust fence；登录上游要保住 `Cf-Connecting-Ip` 头（锁 IP 依赖）。
7. `engines.dsh: ">=0.2.1-rc.2"` 装不上未来的 `0.2.2-rc.x`（semver 预发布语义）——用 DSH 自带 semver 包实测后定范围，rc 升级时同步放宽。
8. 重置密码必须同时轮换 session.secret（旧 cookie 有 7 天 TTL）。
9. 密码明文不能进 profile patch（config-editor 落盘 + `.bak` 备份扩散）——这就是走凭据缝的原因。
10. 飞书发消息端点是 `im/v1/messages`（v4 是历史版本）。
11. 安全事实：TLS 在 CF 边缘终止，回环明文；128 位密码门是公网到本机 full-access agent 的唯一屏障——密码强度不可妥协。
12. volatile-only 变更原地生效，非 volatile 触发条目重启——所以 `remote.*` 全部声明 volatile；若 M1 证明凭据缝不可用，secret 退回 config-secret 并接受"编辑换址 + changed 通知"。
13. cloudflared quick tunnel 会自己死（边缘 "Connection terminated" 后退出，本机实测 25s 即发生；quick tunnel 官方声明无可用性保证）——这就是 v0.3.x watchdog 的由来；M2 最小自愈 = 子进程 exit → respawn（进程内，一行 backoff 都不用）。
14. 清理 API = `ctx.effect(() => { ...; return disposer })`（注册即执行 setup，fiber 销毁时执行 disposer）；`ctx.on("dispose")` 从不触发，官方插件零使用——子进程/定时器的回收必须走 effect（M1 实测验证：effect disposer 杀进程 + 清状态文件均生效）。
15. HMR 不感知 link: 包内文件变化（bundle patch 翻 enabled 不会自动重载）——开发期用触碰 profile 层 patch 强制重组；运行时开关不受影响（M3 的开关走 settings API 提交，不走文件编辑）。
16. 凭据缝 cookie 链路已实测打通：读 `~/.dsh/.credentials.yaml` 的 browser-session secret → HMAC-SHA256 签 `dsh-auth-*` cookie → 被 3080 接受（200），裸请求被 fence 挡（401）。M2 登录页照此实现。

## 里程碑（怎么算完成）

- **M1** bundle 骨架 + 隧道启停（无 UI）：`dsh plugin --profile web add` 安装成功、HMR 生效、URL 捕获成功、凭据缝可用性验证。
- **M2** 密码门 + 登录页：远程浏览器可达 DSH、锁 IP 生效、SIGKILL 宿主后重启插件能清理残留。
- **M3** 配置页 UI + 通知 + 测试按钮。
- **M4** 注册：tag v0.4.0 → 市场 catalog + pin → PR 合并 → market-v0.1.0 → DSH Discover 冒烟。

## 开放问题（M1 顺手验证）

- DSH 签名 cookie 的 secret：优先找宿主 API，没有就读 `~/.dsh/.credentials.yaml`（auth-server.py 已实证可行）。
- 与 v0.3.x 共存：端口被旧套占着就报错提示先停旧的。
