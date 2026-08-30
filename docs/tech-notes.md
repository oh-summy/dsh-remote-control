# 技术笔记：选型对比 & DSH 官方插件形式

> 2026-08-30 · M1 实施时沉淀

## 一、技术选型对比（决策记录）

### 1. 隧道（远程入口）→ **选定：Cloudflare Quick Tunnel（M1）**

| 方案 | 前置 | URL 稳定性 | 优势 | 劣势 |
|---|---|---|---|---|
| **Quick Tunnel** ✅ | 无账号无域名 | 每次启动随机 | 零配置 5 分钟跑通；入站零端口 | URL 变化 → 依赖飞书通知 |
| Named Tunnel | CF 账号+域名 | 固定域名 | URL 可书签；更稳定 | 需域名托管到 CF，配置 ~30 分钟 |
| Tailscale | 双端装客户端 | 100.x 内网 | 点对点加密，不暴露公网 | 每台设备都要装；受限网络可能连不上 |
| frp | 公网 VPS | 固定 | 完全自主 | 需维护 VPS 与 frps 服务端 |

升级路径：M2 迁移 Named Tunnel 只需 `cloudflared tunnel login` + 配置文件，Caddy 层零改动。

### 2. 认证层 → **选定：Caddy Basic Auth（v1）**

| 方案 | 实现成本 | 安全性 | 体验 | 备注 |
|---|---|---|---|---|
| **Caddy Basic Auth** ✅ | ~5 行配置 | bcrypt 哈希、生产级 | 浏览器原生弹窗 | M1 最快落地 |
| Caddy forward_auth 登录页 | 多一个小认证组件 | 同上 + 会话 Cookie | 自绘登录页更好看 | M2+ 可升级（hxy91819/dsh-auth 同思路） |
| Cloudflare Access | 零本地资源 | 企业级 + MFA/OTP | CF 登录页 | 绑定 CF 生态，需域名 |
| 自写认证代理 | 1~2 天 | 取决于自己 | 可定制 | WS/SSE 边界是坑，不推荐 |

踩坑记录：站点地址必须写 `:4080`（任意 Host）而非 `127.0.0.1:4080`——cloudflared 转发的请求 Host 是 trycloudflare 域名，按 IP 写站点会导致请求绕过站点块、认证墙失效（`bind 127.0.0.1` 保证只监听回环）。

**M1 后期升级 2：鉴权移出请求热路径（Caddy 原生匹配）**。Cookie 登录页版仍有瓶颈：Caddy `forward_auth` 让每个请求（含浏览器并发拉取的 30+ 个插件脚本）都先过一遍 Python 鉴权服务，ThreadingHTTPServer backlog 溢出 → 随机插件 502（"Failed to load plugins"）。最终架构：Cookie 值即令牌（`session.secret`），Caddy 用 `header_regexp Cookie {$RC_TOKEN}` 原生鉴权，静态资源零外部依赖；Python 只服务登录页（限流 + 校验 + 发 Cookie）。附带教训：
- Caddyfile `{$VAR}` 是适配期替换（可用在正则里）；`{env.VAR}` 是请求期占位符，正则编译时**不会**替换
- `redir <to> [<code>]` 的 `<to>` 以 `/` 开头会被当 matcher（`redir /rc-login 302` = 只有 /rc-login 路径会跳到"302"），无 matcher 重定向用 `header Location` + `respond 302` 最稳
- `handle` 的路径参数一次只能一个 matcher，多路径用命名 matcher `@x path /a /b`
- Caddyfile 语法错误 = caddy 直接退出，公网表现为 cloudflared 回 502（不是 000）

**M1 后期升级 3：/api 403（host.pickDirectory）与 browser-trust fence**。DSH 的 `/api` 请求有 CSRF 型 fence（`dsh-client-connection` 的 `isTrustedApiRequest`）：① Host 必须是 loopback 或在 `trustedHosts`（精确 authority，**不支持通配符**，无端口条目匹配任意端口）；② `Sec-Fetch-Site: cross-site` 拒绝；③ Origin 的 host 必须与 Host 一致。Quick Tunnel 域名随机且每次变化，静态配置无法枚举 → 服务器版（sami）被迫"每次重启 DSH 加 `--trusted-host <新域名>`"。本地方案：Caddy 代理层把 `Host`/`Origin` 重写为上游本机地址（`header_up Host {env.RC_UPSTREAM}` + `header_up Origin http://{env.RC_UPSTREAM}`），DSH 视角永远是本地请求，fence 自然通过；DSH 零改动、URL 随便变。跨站防护由本项目 Cookie 令牌墙承担（DSH fence 的原始目的——防局域网 drive-by——已由隧道+认证架构覆盖）。若未来 Named Tunnel 固定域名，可改用官方 `--trusted-host` 静态配置。

### 3. 通知 → **选定：飞书群自定义机器人 Webhook**

| 方案 | 可靠性 | 依赖 | 结论 |
|---|---|---|---|
| **群机器人 Webhook** ✅ | 高（无人值守） | 一个 Webhook URL | 适合自愈告警场景 |
| lark-cli 用户身份 | 依赖登录态（30 天不用会断） | 本机 CLI | 不适合无人值守 |
| 双通道 | 最高 | 两者都维护 | +20 行，M2 可选 |

### 4. 常驻 → **M1 手动启停（用户决策），M2 launchd**

### 5. 安装方式（跨平台关键决策）→ **官方预编译二进制，不依赖 brew/apt**

- brew 在 macOS Monterey x86_64 上触发 go 源码编译（无 bottle），不可接受
- Caddy **v2.11 起 GitHub Release 不再发布 darwin 资产**，macOS 官方渠道是 `caddyserver.com/api/download`（返回裸 Mach-O/ELF 二进制，~35MB，**不支持断点续传**）
- install.sh 最终逻辑：darwin → caddy 官网 API（整文件重试）；linux → GitHub Release tar.gz；cloudflared 两平台都走 GitHub Release
- 二进制统一放 `~/.remote-control/bin/`，脚本 `export PATH="$RC_HOME/bin:$PATH"` 优先使用
- 国内网络下 GitHub 大文件可能限速/超时：脚本用 `--speed-limit 1024 --speed-time 60` 检测僵死连接并自动重试

## 二、DSH 官方插件开发形式（解剖 @deepseek-ai/dsh 0.1.1-rc.2 实测）

M4 插件化必须遵守的官方约定，来源：本地官方包 `@deepseek-ai/dsh` 及其 bundle 实物。

**核心概念**：dsh = DeepSeek Harness 的 profile 启动器。一个 profile = 有序的插件组合包（bundle）patch 层叠放，用户覆盖层在最后。仓库：`github.com/deepseek-ai/deepseek-harness`。

**Bundle 的最小结构**（以官方 `@deepseek-ai/dsh-base` 为证）：

```
my-dsh-plugin/
├── package.json          # 声明 dsh.bundle manifest
└── cordis.patch.yml      # patch：往配置树插入/覆盖插件行
```

`package.json` 的 manifest 字段（dsh-base 实物）：

```json
{
  "name": "@deepseek-ai/dsh-base",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

**cordis.patch.yml 格式**（官方实物节选）：

```yaml
- insert:
    - id: timer                      # 行 id，后续层按 id 覆盖（last write wins）
      name: '@deepseek-ai/cordis-plugin-timer'
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      config:
        root: ['.']
```

**关键规则**（官方 README 原文要点）：

1. 安装方式：`dsh plugin --profile web add <package>`，实为在 profile 目录转发给 pnpm，树外插件装进 profile 的 `node_modules`
2. bundle 解析顺序：先 dsh 安装目录（`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless`），再 profile 自身 `node_modules`
3. 配置叠加顺序：各 bundle patch（按 `dsh.profile.bundles` 声明序）→ profile 的 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` 临时覆盖
4. **patch 是整行替换，不做深合并**——覆盖某行 config 必须完整重述所有字段
5. 行顺序无加载语义（激活由服务可用性驱动）；行按读者可读性分组
6. 平台门控在 patch 里用表达式：`disabled: !!js process.platform === 'win32'`
7. profile 结构：`~/.dsh/profiles/<name>/{package.json, cordis.patch.yml, pnpm-workspace.yaml}`；用户 DSH_HOME 实测在 `~/.dsh`
8. 内省工具：`dsh --dump-config` / `--dump-default-config` 可在不启动的情况下查看合成后的配置树

**对 M4 的含义**：`dsh-remote-control` 插件 = 一个 npm 包（`dsh.bundle.patch` 指向 cordis.patch.yml）+ 一个 Node 服务插件（注册到 cordis 容器，起 cloudflared/caddy/watchdog 或内嵌代理），配置走 patch 行的 config 段；通知按调研报告边界做成 Notifier 接口。本轮先做本地版，M4 时再按此形式平移。
