# @oh-summy/dsh-remote 插件设计（v1.2 复审修订版）

> 状态：设计稿，未实施。代码载体：本仓库 `plugin/` 目录；本文是其架构设计文档。
> 上游调研：`docs/architecture.md`（旁路网关 v0.3.x）、`docs/tech-notes.md`（踩坑记录）。
> 宿主事实（本机实证）：DSH 0.2.1-rc.2 = cordis 应用；插件 = 可执行 Node ESM（`apply(ctx)`）+ `dsh.bundle.patch`；
> 宿主进程内无沙箱、可 spawn 子进程、可经 `dsh.client` 提供 web UI（serve 于 `/plugins/*`）；
> 配置经 schemastery 声明，volatile-only 变更原地提交，非 volatile 变更触发条目重启；
> secret 走 `dsh-credentials` 凭据缝（轮换即时生效、不经 config、不重启）；
> 热插拔 = **HMR live recomposition**（不存在字面配置键 `patchReload`）。
>
> **修订记录**：v1.1 = 吸收首审（1 P0 + 4 P1 + 9 P2）。
> v1.2 = 吸收增量复审（2 新 P1 + 6 新 P2；原 14 项中 11 项干净闭环的 3 项缺口一并补齐）：
> P1-A launchd 部署物环境细节、P1-B 密码档位默认 full、P2-1 KeepAlive 语义改述、
> P2-2 run 目录与 v0.3.x 隔离、P2-3 插件 listener 端口成文、P2-4/5 §3.2 策略重排与回退补全、
> P2-6 交叉引用与联动修正。
> P0-1 处置沿用修法①（极简 launchd 引导 plist），系负责人未即时拍板时 agent 依推荐代为采纳，
> §3.1 显式标注，可无损切换修法②。

## 1. 一句话

在 DSH 网页里点一下开关，拿到一条 Cloudflare 临时链接 + 访问密码，任何浏览器即可远程使用本机 DSH；URL 变化与启停可（可选）推送飞书。

## 2. 目标 / 非目标

### 目标（v1）

- **G1** DSH 页面内一键启停远程访问，无需终端（终端 CLI 保留为后备）。
- **G2** Quick Tunnel 临时 URL 自动捕获、展示、复制；URL 变化自动更新并可选通知。
- **G3** 密码门：自动生成强密码；远程登录一次即可直用 DSH（注入 DSH 签名 cookie）；5 次失败锁 IP 5 分钟。
- **G4** 密码与所有敏感字段：页面默认只显示掩码（密码类，支持手动 reveal）或 presence 标记（其他凭据类，无可显示值）；存储层走 `dsh-credentials` 凭据缝，**不明文写入任何配置文件**（§5）。
- **G5** 可选飞书通知：webhook（群机器人）与开放平台 app（app_id + secret + open_id）双通道；凭据表单 + 连通性测试按钮；事件 = started / changed / down / recovered；**URL 变化通知按档位附带密码（默认 full）**——换域后旧 cookie 失效、密码在门后取不到，full 档是唯一真正解锁该死锁的档位（§5）。
- **G6** 热插拔合规：volatile 配置原地生效、HMR live recomposition、卸载/关闭即回收全部子进程（`ctx.effect` 清理）；**配置编辑不炸隧道**（§3.2）。
- **G7** 无人值守恢复（P0-1 处置）：机器重启或宿主崩溃后，OS 引导层负责把 DSH 拉起来（§3.1），远程救援场景闭环。

### 非目标（v1 明确不做）

- **N1** Named Tunnel / 自定义域名（v2 可选，需 Cloudflare 账号；Quick Tunnel 的随机临时 URL 正是产品语义）。
- **N2** SSH/终端远程、文件传输、多用户与权限体系。
- **N3** 插件**运行时**管理 DSH 本体启停（上游 3080 仅做就绪探测）。宿主的**启动**由一次性部署的 OS 引导层负责（§3.1）——"启动宿主"是部署物职责，不是插件运行时功能，故与本条不冲突。
- **N4** 飞书以外的通知渠道（通用 webhook 的格式适配留 v2）。
- **N5** cloudflared/caddy 自动下载（v1 配置二进制路径，默认探测 PATH 与 `~/.remote-control/bin/`；下载属安装器职责）。
- **N6** 自动识别"能发送给谁"：接收者永远由用户填写；"凭据是否有效、通道是否可用"由测试按钮机器自动验证（§6）。**UI 提供获取 open_id 的引导文案**（文档链接 + 步骤说明），弥补无终端场景。
- **N7** 平台范围：**v1 目标平台 darwin（macOS）**——launchd 引导、TCC 警告等均 darwin 语境；跨平台（Linux systemd）后续版本再议。

## 3. 架构

### 3.0 组件与链路

```
远程浏览器 ── Cloudflare 边缘（Quick Tunnel 随机 URL，TLS 在边缘终止）
           ── cloudflared（插件 spawn，仅出站）
           ── Caddy 密码门（插件 spawn，bind 127.0.0.1:4080，Cookie 令牌 + 5 次锁 IP）
           ── DSH web（127.0.0.1:3080，宿主本体，运行时启停不归插件管）
```

插件 = 单个 cordis 包，运行在宿主进程内：

| 模块 | 职责 |
|---|---|
| **TunnelManager** | cloudflared/Caddy 子进程生命周期；**启动前残留探测与收割（§3.3）**；URL 日志捕获（复用 up.sh 的 grep 语义，45s 超时）；状态机 `idle→starting→up→down→recovered`（**changed 是事件不是状态**——URL 变更后仍处于 up）；日志轮转（>1MB copytruncate，留 5 份） |
| **AuthGate** | 登录页，**插件自持 listener 固定 127.0.0.1:9091（等价替换 v0.3.x 的 auth-server.py 独立进程；Caddyfile 登录路径上游改指它）**；密码比对（常数时间）、失败锁（**依赖 Caddy 透传 `Cf-Connecting-Ip` 头，重写登录上游时必须保住该头**）、DSH 签名 cookie 签发（HMAC-SHA256 算法自 auth-server.py 移植为 JS）；上游就绪探针（302/200） |
| **Notifier** | 事件 → 飞书（webhook POST 或 open API）；交互卡片 payload 构造（复用 v0.3.x 的卡片 JSON）；**密码档位随事件附带**；测试方法 |
| **Client 面** | `lib/client.js`（懒加载工厂 → `window.__ModuleLoader__.load`）；Plugins 页配置页 UI；经 `@Remote` 调宿主方法 |

### 3.1 宿主生命周期（P0-1 处置：修法①，待负责人最终确认）

**问题**：插件活在宿主进程内，宿主崩溃或机器重启后没有任何东西拉起 DSH——v0.3.x 的 `launchd（RunAtLoad+KeepAlive）→ watchdog → selfheal → up.sh 自动拉起 dsh web` 恢复链在插件模型里没有对应物，而无人值守时刻恰是远程访问最被需要的时刻。

**处置（修法①）**：插件仓库附带**极简 launchd 引导部署物** `etc/com.dsh-web.plist`（RunAtLoad + KeepAlive，只执行 `dsh web` 拉起，不含任何插件逻辑）+ 一次性安装脚本。

**launchd 环境细节（P1-A，吸收 v0.3.x 先例）**：
- launchd 不 source 用户 shell profile（默认 PATH 仅 `/usr/bin:/bin:/usr/sbin:/sbin`），且 `dsh` 的 npm bin shebang 是 `#!/usr/bin/env node`——**裸命令与绝对路径调用都会因找不到 node 而失败**。plist 必须二选一：
  - `EnvironmentVariables.PATH` 同时注入 node 所在目录与 `~/.npm-global/bin`（v0.3.x plist:23-27 的既有先例；up.sh:19-20 的 `rc_add_npm_global_path` 注释即为此坑）；或
  - `ProgramArguments` 直接用 **node 绝对路径 + dsh 入口 js 绝对路径**（安装脚本解析 `which node` 与 `npm root -g` 后模板化生成 plist）；
- `WorkingDirectory` 设为用户 home；`--profile web` 参数写死在 ProgramArguments；
- 安装脚本负责解析路径并渲染 plist 模板（部署时一次搞定，不做运行时探测）。

**与 v0.3.x 自愈能力的差集（如实声明）**：重拉由 KeepAlive 的**固定间隔（ThrottleInterval，v0.3.x 用 10s）**承接；**退避（30/60/120/300/600s）与 healing 冷却不再提供**——启动即崩会变成固定间隔的无限循环，v1 接受该行为（自愈退避可由 v2 的守门脚本补回；这是 P0-1 修复的已知退化点，非静默删除）。

**负责人可无损切换修法②**（明确降级承诺：宿主不运行 = 远程不可用，开机自启写进部署文档自配）：切换只影响部署物与文档，插件代码零改动；**若切换，§9 M5 的"机器重启后自动恢复"验收项同步移除**。

### 3.2 配置变更 × 子进程存续（P1-2；P2-4/5 修订）

**主场景（凭据缝路径，本设计的主路径）**：password/webhookUrl/appSecret 全部存于 dsh-credentials record（§5），**根本不经过 config**——凭据轮换"applies to the next request without a restart or configuration edit"（dsh-credentials README），P1-2 的原始触发条件（secret 编辑 → config 变更 → fiber 重启）在主路径下**不存在**。

**回退场景（仅当 M1 验证凭据缝不可用时启用）**——策略按序尝试：

1. **全字段 `.volatile()`**（含 config-secret 字段）：volatile 与 role 正交（schemastery types 实证：`volatile()` 与 `role('secret')') 是独立包装器）——仅适用于回退到 config-secret 的场景，主路径不涉及；
2. **子进程挂 `ctx.root`**（cordis "The root context of the application"，`@experimental`）：fiber 重启只重建控制面、不杀数据面。**清厘责任（P2-5）**：挂 root 的 effect 不随插件 dispose 自动清理——插件必须自持登记表并在 disable/卸载钩子中显式收割，否则违反 G6；
3. **最坏情况（落纸，P2-5）**：1、2 均不可行 → **接受"secret 编辑导致隧道重建换址"**，配合 G5 的 changed 事件通知（默认 full 档密码随机附带，用户在远端可自救），并把该限制在 UI 通知卡明示。

**验收（并入 M1/M2，见 §9）**：改 volatile 字段 → 子进程不重启；disable/卸载 → 子进程全部回收；改 secret 字段 → 行为符合本节明文策略。

### 3.3 残留探测与收割（P1-3；P2-2 修订）

**问题**：宿主被 SIGKILL 后 ctx.effect 不会执行，caddy 仍占 127.0.0.1:4080，下次启动同端口编译失败 → 全链路起不来。

**策略**：TunnelManager 启动（及每次 up）前：① 探测 127.0.0.1:4080/9091 端口占用与进程身份（读取 pid 文件 + 命令行核对，`is_proc` 语义）；② 归属确认为本插件历史实例 → SIGTERM 收割后重试；③ 归属不明 → fail-loud 并在 UI 状态卡给出原因，**绝不静默抢端口**。

**与 v0.3.x 的共存隔离（P2-2）**：本插件使用**独立 run 目录 `~/.remote-control/run-plugin/`**（pid/url/状态文件），与 v0.3.x 的 `run/` 物理隔离——两套 caddy/cloudflared 命令行特征相同，同路径 pid 文件无法区分归属；共存期若端口已被 v0.3.x 实例占用，按"归属不明"fail-loud，提示先 `dsh-web stop` 停掉旧套（绝不误收割旧套进程）。

### 3.4 与 v0.3.x 的复用 / 重设计清单

- **语义复用**（实现允许改动）：Caddyfile 站点/Cookie 门/Host-Origin 重写语义（**登录上游地址必改**）；cloudflared argv；URL 捕获与就绪探针；密码/session 生成；DSH cookie HMAC；日志轮转参数；飞书卡片 JSON；**launchd 环境的 PATH 注入先例**（§3.1）。
- **重新设计**（v0.3.x 无对应物或形态改变）：run/ 文件握手 → 进程内状态机 + 独立 run 目录（§3.3）；launchd KeepAlive → OS 引导（§3.1）+ cordis 生命周期（§3.2）；**双通道降级（lark-cli 可用性驱动的每次回退）→ 显式单选 off|webhook|app**；rc.env → volatile config + dsh-credentials；lark-cli → 原生 fetch；独立 auth-server 进程 → 插件 listener（127.0.0.1:9091）；脚本式改 profile → bundle 自带 patch。

### 3.5 已知坑的继承（来自 tech-notes.md，逐条复验于 M1/M2）

- Caddy 站点地址必须写 `:4080` 而非 `127.0.0.1:4080`（Host 不匹配会绕过认证墙）；
- 不用 `forward_auth` per-request 转发 Python（backlog 溢出致随机 502）——Cookie 正则门是正解；
- `{$VAR}` 是适配期替换，`{env.VAR}` 正则内不替换；
- 协议默认 `http2` 规避 QUIC/Clash TUN 断流；
- `Cf-Connecting-Ip` 头透传是 IP 锁的前提（登录上游重写时保住）。

## 4. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 宿主 service | TypeScript（ESM）、cordis `apply(ctx)`、schemastery 配置、`@Remote` 方法 | 与宿主同生态，client 构建链（tsdown/ModuleLoader）是宿主强制的 |
| client UI | React + `dsh-client-ui-primitives` | 宿主 client 模块表解析 React，第三方同等对待 |
| 外部二进制 | cloudflared、caddy（Go，既有） | 隧道与密码门的成熟实现，不自造 |
| 通知 | 原生 `fetch`（webhook + lark open API） | 零新依赖 |

结论：**不换语言**。DSH 侧必须是 Node（宿主契约）；网关组件是外部 Go 二进制；v0.3.x 的 bash/python 层被收编进 Node 插件进程。

## 5. 配置与凭据（一律走 dsh-credentials 凭据缝）

**为什么不用 config-editor 写回**：config-editor 把覆写写进 active profile patch（`~/.dsh/profiles/web/cordis.patch.yml`），secret 角色只管 UI 投影脱敏、**不管静态存储**——明文会落盘且随 patch `.bak` 备份扩散。`dsh-credentials`（"keeps secret values out of configuration… durable per-plugin credential records… A configuration UI can show whether a key or record is set — never the value itself"）默认组合已装载（`~/.dsh/.credentials.yaml` 即其存储，v0.3.x auth-server.py 已在读）。

| 字段 | 存储 | UI 呈现 |
|---|---|---|
| `remote.enabled` | volatile config (boolean) | 总开关 |
| `remote.binary.cloudflared` / `caddy` | volatile config (string) | 明文（非秘密） |
| `remote.auth.password` | **dsh-credentials record** | **mask（默认）+ reveal 单次取全值**；生成/重置由服务端执行，重置即轮换 session.secret |
| `notify.channel` | volatile config (`off\|webhook\|app`) | 单选 |
| `notify.webhookUrl` | **dsh-credentials record** | **presence**（URL 前 4 位恒为 `http`，前 4 字符 mask 无信息量） |
| `notify.appId` | volatile config (string) | **尾 4 位**（`cli_` 前缀恒定，尾 4 位是唯一区分位） |
| `notify.appSecret` | **dsh-credentials record** | presence |
| `notify.targetOpenId` | volatile config (string) | 明文 + 获取引导文案（N6） |
| `notify.passwordPolicy` | volatile config (`full\|mask\|off`，**默认 full**) | URL 变化/started 事件附带密码的档位 |

**默认 full 的理由（P1-B）**：换域死锁场景（URL 变化 + 旧 host-only cookie 失效 + 完整密码只存在于门后）中，**只有 full 档真正解锁**——v0.3.x 默认即 full（rc.env.tmpl:12），且其 mask 档文案（"完整密码见本机 ~/.remote-control/password"）对远端用户是死路。mask/off 作为安全偏好保留，但 UI 必须明示："此档位下换域后若未另存完整密码将无法自救"。full 档密码经飞书 TLS 传输，不经 Cloudflare 边缘（§8 无矛盾）。

**回退（若 M1 验证凭据缝不可用）**：secret 字段退回 config-secret（volatile），呈现规则不变；该回退仅限存储层，§3.2 回退场景 1 同步生效。

## 6. 连通性检测（机器自动验证，用户只填不猜）

| 通道 | 检测 | 通过标准 | 失败呈现 |
|---|---|---|---|
| webhook | POST 测试卡片 | 2xx | HTTP 状态/响应摘录 |
| app | ① `POST /open-apis/auth/v3/tenant_access_token/internal` ② `POST /open-apis/im/v1/messages`（receive_id_type=open_id，发测试文本；**v1 端点，im/v4 是历史版本**） | ① 成功 = 凭据有效；② 成功 = 通道可用 | 错误码翻译成人话（如"应用缺 im:message 发消息权限"） |

结果内联显示在测试按钮旁；事件通知使用与测试相同的通道。

**reveal 与日志纪律**：reveal 经 `@Remote` 单次取全值，仅限本地已认证会话；`@Remote` 参数与错误路径**一律脱敏**（异常序列化时滤掉凭据字段），取全值接口加简单频控（60s/次）；"不落日志"原则覆盖 tunnel/caddy/cloudflared 子进程日志。

## 7. UI（Plugins 页 → 本插件配置页）

1. **状态卡**：总开关 + 当前 URL + 复制/打开按钮 + cloudflared/Caddy 状态点 + 残留清理/端口冲突的 fail-loud 提示（§3.3）；
2. **密码卡**：生成/重置、mask 显示（默认）+ reveal 切换 + 复制；**重置密码 = 同时轮换 session.secret**（旧 rc_session cookie 立即失效，杜绝 7 天 TTL 内旧会话存活）；
3. **通知卡**：通道选择、凭据字段（§5 呈现规则）、接收者（含 open_id 获取引导，N6）、**密码档位（默认 full；选择 mask/off 时 UI 明示自救限制，P1-B）**、测试按钮 + 内联结果；
4. **事件流**：最近 20 条（时间、事件、详情），started/changed/down/recovered 着色沿用 v0.3.x 语义。

本地化：`locale/zh-CN.json` + `en-US.json`。设计原则：所有敏感值默认 mask/presence、reveal 是显式动作且有频控、复制走剪贴板 API 且不落日志。

## 8. 威胁模型

- **信任边界**：Quick Tunnel 的 TLS 在 Cloudflare 边缘终止；cloudflared → 源站（Caddy）是本机回环明文 http。**Cloudflare 全程可见隧道流量（登录 POST 与 DSH 内容）**——Quick Tunnel 语义的固有代价，接受之；full 档密码走飞书通道不经此边界；Named Tunnel + 自有证书是 v2 的强化路径（N1）。
- **门后是什么**：DSH 宿主跑着本机 agent（本机 profile patch 含 danger-full-access 预设）——**这道 128-bit 密码门是公网到本机代码执行的唯一屏障**。缓解层：Cookie 令牌门（非 basic auth）、5 次失败锁 IP 5 分钟、常数时间比较、HttpOnly/SameSite cookie、密码重置即会话轮换（§7）、出站-only 隧道（无入站端口）。
- **残余风险**：密码强度 = 唯一变量（hex 16 = 128 bit，不可暴力）；CF 侧可见性 = 信任 Cloudflare 的组织性风险，技术层不可缓解。

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | bundle 骨架 + 手动启停隧道 + **Q1 spike（5 分钟：进程内读 .credentials.yaml 签 cookie 被 3080 接受；优先探查 dsh-credentials/dsh-client-connection 可注入服务）** + **volatile×secret/credentials 组合验证** | ① `dsh plugin --profile web add` 安装成功；② **HMR recomposition 生效**（装/卸/改配置不重启宿主）；③ URL 捕获成功；④ **volatile 字段变更 → 子进程不重启**；⑤ disable/卸载 → 子进程全部回收；⑥ engines.dsh 范围语义实测（**方法：用 DSH 安装内自带的 semver 包对本插件声明范围跑 satisfies 断言**，覆盖 0.2.1-rc.2 / 0.2.2-rc.1 / 正式版三个样本） |
| M2 | 状态机 + 密码门 + 登录页并入 + 残留清理 | 远程浏览器经临时链接 + 密码直达 DSH；锁 IP 生效；DSH 签名 cookie 直用；**SIGKILL 宿主后重启插件 → 4080 残留被识别并收割（含 v0.3.x 共存期的归属隔离，§3.3）**；**改 secret 字段 → 隧道不重建换址** |
| M3 | client 配置页全套 UI | mask/presence/reveal（含频控）、复制、开关原地生效、事件流、open_id 引导、密码档位 UI（含 mask/off 的自救警示） |
| M4 | 通知双通道 + 测试按钮 + 密码档位 | webhook/app 测试通过；URL 变化推送到达且按档位附带密码（full 档实测解锁换域场景） |
| M5 | 端到端 + 注册 | 真机外网访问；**机器重启后 OS 引导拉起宿主并自动恢复（§3.1 验收；负责人切换修法②则本项同步移除）**；tag v0.4.0；市场注册 PR 合入；market-v0.1.0；T5 Discover 冒烟 |

## 10. 市场注册与版本纪律

- 仓库 = 本仓库；catalog `path = "plugin/"`；manifest = `plugin/package.json`：
  `@oh-summy/dsh-remote`、MIT、`engines.node`、`engines.dsh`（**预发布范围语义风险**：node-semver 下 `>=0.2.1-rc.2` 不匹配其他 tuple 的 prerelease（0.2.2-rc.x 不满足），而 DSH 安装与启动均强校验——M1⑥ 按上述方法实测，且约定 **DSH rc 升级时同步放宽范围**），
  keywords 含 `dsh` + `dsh-plugin`、`dsh.bundle.patch: "./cordis.patch.yml"`、`dsh.client: { platform: "web" }`；
- GitHub topics：仓库已含 `dsh-plugin`（house 模板项，✅）；
- `plugin/cordis.patch.yml`：insert 宿主行 + client 行（模式照抄本机 profile 尾部 directory-picker-browse 条目）；
- 图标 `catalog/icons/`（市场侧）+ bundle `icon`；
- tag **v0.4.0** → 市场 catalog `ref: "v0.4.0"` + `npm run pin` → PR → CI 校验 pin → 合并 = Discover 可见；
- 市场版本纪律按 AGENTS.md §8：注册合入时打 **market-v0.1.0**（release.yml 首跑验证）。

**版本原则（负责人 2026-10-25 重申，写死）**：**只有发布才铸造版本号**——开发里程碑（M1-M5）、设计修订、中间 PR 一律无版本号；`tag v0.4.0` 在 M5 发布时打，`market-v0.1.0` 在市场注册合入时打，此外不产生任何版本。

## 11. 实施顺序（防呆）

每个里程碑 = 一个 PR（一个 PR 一件事）；M1 ⑥ 的 engines.dsh 实测结果回写 §10 的范围声明；M2 的两条新验收（SIGKILL 收割、secret 编辑不炸隧道）不得跳过；修法②若被采纳，§9 M5 对应验收项同步移除。

## 12. 开放问题（收敛后）

- **Q1** DSH 签名 cookie 的 secret 获取：优先查 `dsh-credentials` / `dsh-client-connection` 是否有可注入服务；无则维持文件读取 + 容错（auth-server.py 已实证可行）。**M1 spike 覆盖**。
- **Q2** cloudflared/caddy 缺失时的引导：M1 用配置路径 + fail-loud 报错；自动下载延后（N5）。
- **Q3** browser-trust fence 对远程 cookie 的 Host/Origin 重写细节在 M2 实测（`:4080` 坑必须复验）。

（原 Q4 已被 §5 的 dsh-credentials 方案吸收；两轮审查的 P0/P1/P2 已全部转为 §3/§5/§7/§9/§10 的设计内容。）
