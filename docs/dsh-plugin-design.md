# @oh-summy/dsh-remote 插件设计（v1 草案）

> 状态：设计稿，未实施。代码载体：本仓库 `plugin/` 目录；本文是其架构设计文档。
> 上游调研：`docs/architecture.md`（旁路网关 v0.3.x）、`docs/tech-notes.md`（踩坑记录）。
> 宿主事实：DSH 0.2.1-rc.2 = cordis 应用；插件 = 可执行 Node ESM（`apply(ctx)`）+ `dsh.bundle.patch`；
> 宿主进程内无沙箱、可 spawn 子进程、可经 `dsh.client` 提供 web UI（serve 于 `/plugins/*`）；
> `patchReload: "live"` 下装/卸/改配置不重启。

## 1. 一句话

在 DSH 网页里点一下开关，拿到一条 Cloudflare 临时链接 + 访问密码，任何浏览器即可远程使用本机 DSH；URL 变化与启停可（可选）推送飞书。

## 2. 目标 / 非目标

### 目标（v1）

- **G1** DSH 页面内一键启停远程访问，无需终端（终端 CLI 保留为后备）。
- **G2** Quick Tunnel 临时 URL 自动捕获、展示、复制；URL 变化自动更新并可选通知。
- **G3** 密码门：自动生成强密码；远程登录一次即可直用 DSH（注入 DSH 签名 cookie）；5 次失败锁 IP 5 分钟。
- **G4** 密码与所有敏感字段：页面默认只显示前 4 字符 + 手动 reveal；存储层走宿主 secret 角色，不明文回显。
- **G5** 可选飞书通知：webhook（群机器人）与开放平台 app（app_id + secret + open_id）双通道；凭据表单 + 连通性测试按钮；事件 = started / changed / down / recovered。
- **G6** 热插拔合规：volatile 配置原地生效、patchReload live、卸载/关闭即回收全部子进程（`ctx.effect` 清理）。

### 非目标（v1 明确不做）

- **N1** Named Tunnel / 自定义域名（v2 可选，需 Cloudflare 账号；Quick Tunnel 的随机临时 URL 正是产品语义）。
- **N2** SSH/终端远程、文件传输、多用户与权限体系。
- **N3** 管理 DSH 本体启停（宿主职责；上游 3080 仅做就绪探测）。
- **N4** 飞书以外的通知渠道（通用 webhook 的格式适配留 v2）。
- **N5** cloudflared/caddy 自动下载（v1 配置二进制路径，默认探测 PATH 与 `~/.remote-control/bin/`；下载属安装器职责）。
- **N6** 自动识别"能发送给谁"：接收者永远由用户填写；"凭据是否有效、通道是否可用"由测试按钮机器自动验证（见 §6）。

## 3. 架构

### 组件与链路

```
远程浏览器 ── Cloudflare 边缘（Quick Tunnel 随机 URL）
           ── cloudflared（插件 spawn，仅出站）
           ── Caddy 密码门（插件 spawn，bind 127.0.0.1:4080，Cookie 令牌 + 5 次锁 IP）
           ── DSH web（127.0.0.1:3080，宿主本体，不归插件管）
```

插件 = 单个 cordis 包，运行在宿主进程内：

| 模块 | 职责 |
|---|---|
| **TunnelManager** | cloudflared/Caddy 子进程生命周期；URL 日志捕获（复用 up.sh 的 grep 语义，45s 超时）；状态机 `idle→starting→up→changed→down→recovered`；日志轮转（>1MB copytruncate，留 5 份） |
| **AuthGate** | 登录页并入插件 web 路由（**取代独立 auth-server.py:9091**）；密码比对（常数时间）、失败锁、DSH 签名 cookie 签发（HMAC-SHA256 算法自 auth-server.py 移植为 JS）；上游就绪探针（302/200） |
| **Notifier** | 事件 → 飞书（webhook POST 或 open API）；交互卡片 payload 构造（复用 v0.3.x 的卡片 JSON）；测试方法 |
| **Client 面** | `lib/client.js`（懒加载工厂 → `window.__ModuleLoader__.load`）；Plugins 页配置页 UI；经 `@Remote` 调宿主方法 |

### 与 v0.3.x 旁路网关的关系

- **原样复用**：Caddyfile 语义（站点 `:4080` + Cookie 正则门 + Host/Origin 重写过 browser-trust fence）；cloudflared argv（`--url http://127.0.0.1:4080 --no-autoupdate --protocol http2`）；URL 捕获与就绪探针；飞书卡片 JSON 与双通道降级；密码/session 生成；DSH cookie HMAC；日志轮转参数。
- **重新设计**：`run/` 文件握手协议（starting/stopped/heal-failed、pid noclobber 选举）→ 进程内状态机；launchd KeepAlive → cordis 生命周期托管（`ctx.effect` 收割）；`rc.env` source → volatile config；lark-cli 外部二进制 → 原生 fetch；脚本式改 profile → bundle 自带 cordis.patch.yml。

### 已知坑的继承（来自 tech-notes.md）

- Caddy 站点地址必须写 `:4080` 而非 `127.0.0.1:4080`（Host 不匹配会绕过认证墙）；
- 不用 `forward_auth` per-request 转发 Python（backlog 溢出致随机 502）——Cookie 正则门是正解；
- `{$VAR}` 是适配期替换，`{env.VAR}` 正则内不替换；
- 协议默认 `http2` 规避 QUIC/Clash TUN 断流。

## 4. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 宿主 service | TypeScript（ESM）、cordis `apply(ctx)`、schemastery 配置、`@Remote` 方法 | 与宿主同生态，client 构建链（tsdown/ModuleLoader）是宿主强制的 |
| client UI | React + `dsh-client-ui-primitives` | 宿主 client 模块表解析 React，第三方同等对待 |
| 外部二进制 | cloudflared、caddy（Go，既有） | 隧道与密码门的成熟实现，不自造 |
| 通知 | 原生 `fetch`（webhook + lark open API） | 零新依赖 |

结论：**不换语言**。DSH 侧必须是 Node（宿主契约）；网关组件是外部 Go 二进制；v0.3.x 的 bash/python 层被收编进 Node 插件进程。

## 5. 配置与凭据（schemastery）

| 字段 | 类型 | 说明 |
|---|---|---|
| `remote.enabled` | boolean, **volatile** | 总开关，原地生效 |
| `remote.binary.cloudflared` / `caddy` | string, volatile | 二进制路径，缺省探测 PATH + `~/.remote-control/bin/` |
| `remote.auth.password` | **secret** | 服务端生成（hex 16），页面只回显 mask（`abcd••••` + reveal） |
| `notify.channel` | `off \| webhook \| app`, volatile | 通知总开关与通道 |
| `notify.webhookUrl` | **secret** | 群机器人 webhook |
| `notify.appId` | string, volatile | 开放平台 App ID（非秘密，但页面按产品要求显示前 4 字符） |
| `notify.appSecret` | **secret** | 开放平台 Secret |
| `notify.targetOpenId` | string, volatile | 接收者，**用户填写，永不自动猜测**（N6） |

- secret 字段走宿主 secret 角色（表单 presence-only，不明文回显）——"前 4 字符 + reveal"由 client 层对 `appId` 实现、对密码由服务端确认后返回掩码串，reveal 时经 `@Remote` 单次取全值。
- 持久化由宿主 config-editor 写回 profile patch；普通字段变更触发插件重载，volatile 原地提交。

## 6. 连通性检测（机器自动验证，用户只填不猜）

| 通道 | 检测 | 通过标准 | 失败呈现 |
|---|---|---|---|
| webhook | POST 测试卡片 | 2xx | HTTP 状态/响应摘录 |
| app | ① `POST /open-apis/auth/v3/tenant_access_token/internal` ② `POST /open-apis/im/v4/messages`（receive_id_type=open_id，发测试文本） | ① 成功 = 凭据有效；② 成功 = 通道可用 | 错误码翻译成人话（如"应用缺 im:message 发消息权限"） |

结果内联显示在测试按钮旁；事件通知使用与测试相同的通道。

## 7. UI（Plugins 页 → 本插件配置页）

1. **状态卡**：总开关 + 当前 URL + 复制/打开按钮 + cloudflared/Caddy 状态点；
2. **密码卡**：生成/重置、mask 显示（默认）+ reveal 切换 + 复制；
3. **通知卡**：通道选择、凭据字段（mask）、接收者、测试按钮 + 内联结果；
4. **事件流**：最近 20 条（时间、事件、详情），started/changed/down/recovered 着色沿用 v0.3.x 语义。

本地化：`locale/zh-CN.json` + `en-US.json`。设计原则：所有敏感值默认 mask、reveal 是显式动作、复制走剪贴板 API 且不落日志。

## 8. 市场注册

- 仓库 = 本仓库；catalog `path = "plugin/"`；manifest = `plugin/package.json`：
  `@oh-summy/dsh-remote`、MIT、`engines.node`、`engines.dsh`（实测范围 `>=0.2.1-rc.2`）、
  keywords 含 `dsh` + `dsh-plugin`、`dsh.bundle.patch: "./cordis.patch.yml"`、`dsh.client: { platform: "web" }`；
- `plugin/cordis.patch.yml`：insert 宿主行 + client 行（模式照抄本机 profile 尾部 directory-picker-browse 条目）；
- 图标 `catalog/icons/`（市场侧）+ bundle `icon`；
- tag **v0.4.0** → 市场 catalog `ref: "v0.4.0"` + `npm run pin` → PR → CI 校验 pin → 合并 = Discover 可见；
- 市场版本纪律按 AGENTS.md §8：注册合入时打 **market-v0.1.0**（release.yml 首跑验证）。

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | bundle 骨架 + 手动启停隧道（CLI 可用、无 UI） | `dsh plugin --profile web add` 安装成功；patchReload 生效；cloudflared 拉起且 URL 捕获成功 |
| M2 | 状态机 + 密码门 + 登录页并入 | 远程浏览器经临时链接 + 密码直达 DSH；锁 IP 生效；DSH 签名 cookie 直用 |
| M3 | client 配置页全套 UI | mask/reveal、复制、开关原地生效、事件流 |
| M4 | 通知双通道 + 测试按钮 | webhook/app 测试通过；URL 变化推送到达 |
| M5 | 端到端 + 注册 | 真机外网访问；tag v0.4.0；市场注册 PR 合入；market-v0.1.0；T5 Discover 冒烟 |

## 10. 开放问题

- **Q1** DSH 签名 cookie 所需 secret 的稳定获取方式：v0.3.x 读 `~/.dsh/.credentials.yaml` + 日志 token 提取——插件进程内是否有宿主 API？（M1 首验；无则维持文件读取 + 容错）
- **Q2** cloudflared/caddy 缺失时的引导：M1 用配置路径 + 明确报错；自动下载延后（N5）。
- **Q3** browser-trust fence 对远程 cookie 的 Host/Origin 重写在 M2 实测（tech-notes 的 `:4080` 坑必须复验）。
- **Q4** `notify.appId` 是否也应走 secret 角色：现按"非秘密但 mask"处理，若宿主 secret 角色可配置 presence 语义则统一。
