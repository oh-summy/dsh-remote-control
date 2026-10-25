// @oh-summy/dsh-remote — M2+M3: quick tunnel + Caddy cookie gate + login page + notify + client page.
// Lean by design: node builtins + two host deps (schemastery, dsh-credentials). See docs/dsh-plugin-design.md.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

// ---------- constants ----------

const RUN_DIR = join(homedir(), ".remote-control", "run-plugin");
const UPSTREAM_HOST = "127.0.0.1:3080"; // DSH web 的 authority（Host 头必须是裸 host:port，不能带 scheme）
const UPSTREAM = "http://" + UPSTREAM_HOST; // Caddy 的上游
const TUNNEL_ENTRY = "http://127.0.0.1:4080"; // cloudflared 的 --url 指向 Caddy 门（绝不直连 DSH）
const GATE_PORT = 4080; // Caddy 密码门（唯一对内监听）
const LOGIN_PORT = 9091; // 插件登录页/管理 API（替代 v0.3.x auth-server.py）
const URL_TIMEOUT_MS = 45_000;
const RESPAWN_DELAY_MS = 5_000;
const LOGIN_LOCK_MS = 300_000;
const LOGIN_MAX_FAILS = 5;
const REVEAL_FREQ_MS = 60_000;
const PASSWORD_REF = credentialRef("DSH_REMOTE_PASSWORD");
const SESSION_REF = credentialRef("DSH_REMOTE_SESSION_SECRET");
const WEBHOOK_REF = credentialRef("DSH_REMOTE_WEBHOOK_URL");
const APP_SECRET_REF = credentialRef("DSH_REMOTE_APP_SECRET");

export interface Config {
  enabled?: boolean;
  cloudflaredPath?: string;
  caddyPath?: string;
  notifyChannel?: "off" | "webhook" | "app";
  notifyAppId?: string;
  notifyOpenId?: string;
  passwordPolicy?: "full" | "mask" | "off";
}

// cordis 服务注入声明：凭据缝必须显式声明，否则 ctx.credentials 访问被拒
// ("cannot get property 'credentials' without inject"，M2 实测)。
export const inject = ["credentials"];

// settings form（Plugins 页自动表单）。Config = zod（官方插件先例：dsh-plugin-market / dsh-agent-loop；
// DSH 的配置管线吃 zod schema，volatile 字段原地生效）。enabled 非 volatile：翻转 = 条目重启 = 开关语义；
// 其余字段 volatile：原地生效，不炸隧道（设计稿事实 12）。
export const Config = z.object({
  enabled: z.boolean().default(false).describe("启用远程访问（关闭即回收隧道；开启会产生新的临时链接）"),
  cloudflaredPath: z.string().default("").describe("cloudflared 路径（留空自动探测）"),
  caddyPath: z.string().default("").describe("caddy 路径（留空自动探测）"),
  notifyChannel: z.enum(["off", "webhook", "app"]).default("off").describe("飞书通知通道"),
  notifyAppId: z.string().default("").describe("飞书 App ID（app 通道）"),
  notifyOpenId: z.string().default("").describe("通知接收者 open_id（客户端页面有获取引导）"),
  passwordPolicy: z.enum(["full", "mask", "off"]).default("full").describe("URL 变化通知附带密码的档位（full 才能在换域后自救）"),
});

// ---------- small utils ----------

type AnyCtx = any;

function say(ctx: AnyCtx, method: "info" | "warn" | "error", msg: string) {
  const logger = ctx.logger;
  if (logger && typeof logger[method] === "function") logger[method](msg);
  else if (method === "info") console.log(msg);
  else console.error(msg);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findBinary(config: Config, name: "cloudflared" | "caddy"): string {
  const custom = name === "cloudflared" ? config.cloudflaredPath : config.caddyPath;
  const candidates = [custom, join(homedir(), ".remote-control", "bin", name)];
  for (const p of candidates) if (p && existsSync(p)) return p;
  return name;
}

function hex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------- module state (per fiber) ----------

const events: Array<{ time: string; type: string; detail: string }> = [];
let disposed = false;
let caddyChild: ChildProcess | null = null;
let cloudflaredChild: ChildProcess | null = null;
let loginServer: http.Server | null = null;
let currentUrl = "";
let sessionSecret = ""; // 本插件自己的 Cookie 门令牌（Caddy 正则门用）
let dshSessionSecret = ""; // DSH 的 browser-session secret（签 dsh-auth-* cookie，读自凭据缝文件）
let password = "";
let lastRevealAt = 0;
const failCounts = new Map<string, { count: number; until: number }>();
const timers = new Set<NodeJS.Timeout>();
let cfg: Config = {};

function pushEvent(type: string, detail: string) {
  events.unshift({ time: new Date().toISOString().replace("T", " ").slice(0, 19), type, detail });
  if (events.length > 20) events.pop();
  try { writeFileSync(join(RUN_DIR, "events.json"), JSON.stringify(events, null, 2)); } catch { /* best effort */ }
}

function notifyText(policy: string): string | null {
  if (policy === "full") return password;
  if (policy === "mask") return password.slice(0, 4) + "••••••••（完整密码见 DSH 页面密码卡）";
  return null;
}

// ---------- notify ----------

function cardFor(title: string, color: string, bodyMd: string, url: string | null, note: string) {
  const elements: any[] = [{ tag: "div", text: { tag: "lark_md", content: bodyMd } }];
  if (url) elements.push({
    tag: "action",
    actions: [{ tag: "button", text: { tag: "plain_text", content: "打开 DSH" }, url, type: "primary" }],
  });
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: note }] });
  return { header: { title: { tag: "plain_text", content: title }, template: color }, elements };
}

async function sendWebhook(card: any): Promise<void> {
  const hook = await getSecret(WEBHOOK_REF);
  if (!hook) throw new Error("webhook URL 未配置（客户端页面 → 通知）");
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
  });
  if (!res.ok) throw new Error("webhook HTTP " + res.status);
}

async function sendApp(card: any, ctx: AnyCtx): Promise<void> {
  const appId = cfg.notifyAppId || "";
  const appSecret = await getSecret(APP_SECRET_REF);
  if (!appId || !appSecret) throw new Error("App ID / App Secret 未配置（客户端页面 → 通知）");
  if (!cfg.notifyOpenId) throw new Error("接收者 open_id 未配置");
  const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenJson = await tokenRes.json() as any;
  if (!tokenJson.tenant_access_token) throw new Error("凭据无效或权限缺失：" + (tokenJson.msg || "unknown"));
  const sendRes = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokenJson.tenant_access_token },
    body: JSON.stringify({ receive_id: cfg.notifyOpenId, msg_type: "interactive", content: JSON.stringify(card) }),
  });
  const sendJson = await sendRes.json() as any;
  if (sendJson.code !== 0) throw new Error("发送失败 code " + sendJson.code + "：" + (sendJson.msg || "unknown") + "（常见原因：应用缺 im:message 发消息权限）");
}

async function notify(ctx: AnyCtx, event: string, url: string | null) {
  const channel = cfg.notifyChannel || "off";
  if (channel === "off") return;
  const meta: Record<string, [string, string]> = {
    started: ["远程访问已开启", "green"], changed: ["访问地址已变化", "blue"],
    down: ["远程访问已断开", "red"], recovered: ["远程访问已恢复", "green"], test: ["测试通知", "grey"],
  };
  const [title, color] = meta[event] ?? ["远程访问", "grey"];
  const tier = notifyText(cfg.passwordPolicy || "full");
  let bodyMd = event === "down" || event === "recovered"
    ? (url ? "地址：" + url : "隧道进程已退出，正在自动恢复。")
    : "**访问地址**\n" + url;
  if (event === "started" || event === "changed" || event === "test") {
    if (tier === null) bodyMd += "\n密码：略（passwordPolicy=off）";
    else if (event !== "test") bodyMd += "\n**访问密码**：" + tier;
  }
  const card = cardFor(title, color, bodyMd, url, "dsh-remote · " + new Date().toLocaleString("zh-CN"));
  try {
    if (channel === "webhook") await sendWebhook(card);
    else await sendApp(card, ctx);
    pushEvent(event, "通知已发送");
  } catch (e) {
    pushEvent(event, "通知失败：" + (e as Error).message);
    say(ctx, "warn", `[dsh-remote] notify failed: ${(e as Error).message}`);
  }
}

// ---------- secrets (dsh-credentials seam, fallback local 0600 file) ----------

function fallbackSecrets(): Record<string, string> {
  try { return JSON.parse(readFileSync(join(RUN_DIR, "secrets.json"), "utf8")); } catch { return {}; }
}

async function getSecret(ref: string): Promise<string | null> {
  const ctx = (globalThis as any).__dshRemoteCtx;
  if (ctx?.credentials) {
    const hit = await ctx.credentials.resolve(ref);
    return hit?.value ?? null;
  }
  return fallbackSecrets()[ref] ?? null;
}

async function setSecret(ctx: AnyCtx, ref: string, value: string): Promise<void> {
  if (ctx.credentials) { await ctx.credentials.set(ref, value); return; }
  const all = fallbackSecrets();
  all[ref] = value;
  writeFileSync(join(RUN_DIR, "secrets.json"), JSON.stringify(all, null, 2), { mode: 0o600 });
}

async function ensureSecrets(ctx: AnyCtx): Promise<void> {
  // DSH 的 browser-session secret：签 dsh-auth-* cookie 用（读凭据缝文件，Q1 spike 已验证全链路）
  try {
    const yaml = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
    const m = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/);
    if (m) dshSessionSecret = m[1];
  } catch { /* 没有 DSH secret：登录后只发 rc_session，fence 需用户自行过 */ }
  password = (await getSecret(PASSWORD_REF)) ?? "";
  if (!password) { password = hex(16); await setSecret(ctx, PASSWORD_REF, password); pushEvent("init", "访问密码已生成"); }
  sessionSecret = (await getSecret(SESSION_REF)) ?? "";
  if (!sessionSecret) { sessionSecret = hex(32); await setSecret(ctx, SESSION_REF, sessionSecret); }
}

// ---------- DSH signed cookie (port of auth-server.py, fact 16) ----------

function dshCookieParts(authority: string): { name: string; value: string } | null {
  if (!dshSessionSecret) return null; // 无 DSH secret 时只发 rc_session（fence 需用户另行通过）
  const b64url = (buf: Buffer) => buf.toString("base64url");
  const name = "dsh-auth-" + b64url(crypto.createHash("sha256").update(authority).digest());
  const secretBytes = Buffer.from(dshSessionSecret, "base64url");
  const now = Date.now();
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 7 * 86400 * 1000 })));
  const sig = b64url(crypto.createHmac("sha256", secretBytes).update(body).digest());
  return { name, value: "v1." + body + "." + sig };
}

// ---------- login page + management API (127.0.0.1:9091) ----------

function startLoginServer(ctx: AnyCtx): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const origin = String(req.headers.origin || "");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname;
      const remoteIp = String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "");

      if (req.method === "GET" && path === "/rc-login") {
        const locked = failCounts.get(remoteIp);
        const lockMsg = locked && locked.until > Date.now() ? `<p style="color:#c00">失败次数过多，${Math.ceil((locked.until - Date.now()) / 1000)}s 后重试</p>` : "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>DSH 远程访问</title></head>
<body style="font-family:system-ui;max-width:380px;margin:12vh auto;padding:0 16px">
<h2>DSH 远程访问</h2>${lockMsg}
<form method="post" action="/rc-login"><input type="password" name="password" placeholder="访问密码" autofocus
 style="width:100%;padding:10px;font-size:16px;box-sizing:border-box" required>
<button style="width:100%;padding:10px;margin-top:12px;font-size:16px" type="submit">进入</button></form>
<p style="color:#888;font-size:13px">密码由本机 DSH 的「远程访问」插件生成（配置页可重置）。</p></body></html>`);
        return;
      }

      if (req.method === "POST" && path === "/rc-login") {
        const lock = failCounts.get(remoteIp);
        if (lock && lock.count >= LOGIN_MAX_FAILS && lock.until > Date.now()) { res.writeHead(429); res.end("locked"); return; }
        let body = "";
        for await (const chunk of req) body += chunk;
        const supplied = String(new URLSearchParams(body).get("password") || "");
        if (timingSafeEq(supplied, password)) {
          failCounts.delete(remoteIp);
          const dsh = dshCookieParts("127.0.0.1:3080");
          const cookies = [`rc_session=${hex(32)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`];
          if (dsh) cookies.push(`${dsh.name}=${dsh.value}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
          res.writeHead(302, { Location: "/", "Set-Cookie": cookies });
          res.end();
          return;
        }
        const count = (lock?.count ?? 0) + 1;
        const rec = { count, until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0 };
        failCounts.set(remoteIp, rec);
        pushEvent("auth", "登录失败（" + (rec.count >= LOGIN_MAX_FAILS ? "已锁 5 分钟" : rec.count + "/5") + "）");
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<meta charset='utf-8'>密码错误，<a href='/rc-login'>重试</a>");
        return;
      }

      // /rc-api/* — 本机（loopback）或已登录会话（rc_session cookie）
      if (path.startsWith("/rc-api/")) {
        const cookies = String(req.headers.cookie || "");
        const local = remoteIp.includes("127.0.0.1") || remoteIp.includes("::1");
        const authed = local || /rc_session=/.test(cookies);
        if (!authed) { res.writeHead(401); res.end("unauthorized"); return; }

        if (req.method === "GET" && path === "/rc-api/state") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            running: !!cloudflaredChild && !disposed,
            url: currentUrl,
            passwordMask: password.slice(0, 4) + "••••••••",
            policy: cfg.passwordPolicy || "full",
            channel: cfg.notifyChannel || "off",
            hasWebhook: !!(await getSecret(WEBHOOK_REF)),
            hasAppSecret: !!(await getSecret(APP_SECRET_REF)),
            openId: cfg.notifyOpenId || "",
            appId: cfg.notifyAppId || "",
            events,
          }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/reveal") {
          if (Date.now() - lastRevealAt < REVEAL_FREQ_MS) { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "操作过于频繁，60s 一次" })); return; }
          lastRevealAt = Date.now();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ password }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/reset") {
          password = hex(16);
          await setSecret(ctx, PASSWORD_REF, password);
          sessionSecret = hex(32);
          await setSecret(ctx, SESSION_REF, sessionSecret);
          restartCaddy(ctx); // 新 session.secret = 新 Cookie 令牌；旧 rc_session 全部失效
          pushEvent("password", "密码已重置（会话已全部失效）");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/notify-secret") {
          let body = "";
          for await (const chunk of req) body += chunk;
          const json = JSON.parse(body || "{}") as any;
          if (json.webhookUrl) await setSecret(ctx, WEBHOOK_REF, String(json.webhookUrl));
          if (json.appSecret) await setSecret(ctx, APP_SECRET_REF, String(json.appSecret));
          pushEvent("notify", "通知凭据已更新");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/test") {
          res.writeHead(200, { "Content-Type": "application/json" });
          await notify(ctx, "test", currentUrl || null);
          res.end(JSON.stringify({ ok: true, events: events.slice(0, 3) }));
          return;
        }
      }

      res.writeHead(404); res.end();
    } catch (e) {
      say(ctx, "error", "[dsh-remote] api error: " + (e as Error).message);
      try { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: (e as Error).message })); } catch { /* headed */ }
    }
  });
  return server;
}

// ---------- process management ----------

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
  });
}

function readPid(name: string): number {
  try { return Number(readFileSync(join(RUN_DIR, name + ".pid"), "utf8").trim()); } catch { return 0; }
}

async function reapOrphans(ctx: AnyCtx): Promise<void> {
  for (const name of ["caddy", "cloudflared"]) {
    const pid = readPid(name);
    if (pid > 0 && pidAlive(pid)) {
      try { process.kill(pid); say(ctx, "info", `[dsh-remote] reaped orphan ${name} (pid ${pid})`); } catch { /* gone */ }
      rmSync(join(RUN_DIR, name + ".pid"));
    }
  }
  if (await portBusy(GATE_PORT)) throw new Error(`端口 ${GATE_PORT} 被非本插件进程占用（可能 v0.3.x 网关在跑：先 dsh-web stop）— fail loud，不抢端口`);
}

function spawnCaddy(ctx: AnyCtx): void {
  const caddyfile = join(RUN_DIR, "Caddyfile");
  writeFileSync(caddyfile, renderCaddyfile());
  caddyChild = spawn(findBinary(cfg, "caddy"), ["run", "--config", caddyfile], {
    cwd: RUN_DIR,
    env: { ...process.env, RC_TOKEN: sessionSecret, RC_UPSTREAM: UPSTREAM, RC_LOG_DIR: RUN_DIR },
    stdio: ["ignore", "ignore", "ignore"],
  });
  writeFileSync(join(RUN_DIR, "caddy.pid"), String(caddyChild.pid));
  caddyChild.on("exit", () => {
    if (!disposed) { pushEvent("down", "caddy 退出，5s 后自动重拉"); timers.add(setTimeout(() => { if (!disposed) spawnCaddy(ctx); }, RESPAWN_DELAY_MS)); }
  });
}

function restartCaddy(ctx: AnyCtx): void {
  try { if (caddyChild?.pid) process.kill(caddyChild.pid); } catch { /* gone */ }
  // exit handler will respawn with the fresh env on next tick — but spawnCaddy reads
  // sessionSecret at spawn time, so kill + immediate manual respawn is deterministic:
  try { if (caddyChild) caddyChild.once("exit", () => { if (!disposed) spawnCaddy(ctx); }); } catch { /* noop */ }
}

function spawnCloudflared(ctx: AnyCtx): void {
  const logFile = join(RUN_DIR, "cloudflared.log");
  writeFileSync(logFile, ""); // fresh log：URL grep 只看本次
  const out = openSync(logFile, "a");
  cloudflaredChild = spawn(findBinary(cfg, "cloudflared"),
    ["tunnel", "--url", TUNNEL_ENTRY, "--no-autoupdate", "--protocol", "http2"],
    { stdio: ["ignore", out, out] });
  writeFileSync(join(RUN_DIR, "cloudflared.pid"), String(cloudflaredChild.pid));
  say(ctx, "info", `[dsh-remote] cloudflared spawning (pid ${cloudflaredChild.pid})`);

  const startedAt = Date.now();
  let announced = "";
  const timer = setInterval(() => {
    const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== announced) {
      const changed = announced !== "";
      announced = m[0]; currentUrl = m[0];
      writeFileSync(join(RUN_DIR, "url"), m[0] + "\n");
      say(ctx, "info", `[dsh-remote] tunnel ${changed ? "changed" : "up"}: ${m[0]}`);
      pushEvent(changed ? "changed" : "started", m[0]);
      void notify(ctx, changed ? "changed" : "started", m[0]);
      // 不 clearInterval：changed 检测需要持续监听（watchdog 语义）；disposer 统一清理
    } else if (!announced && Date.now() - startedAt > URL_TIMEOUT_MS) {
      clearInterval(timer);
      say(ctx, "warn", `[dsh-remote] no URL within 45s — see ${logFile}`);
      pushEvent("down", "45s 内未捕获到 URL");
    }
  }, 2000);
  timers.add(timer);

  cloudflaredChild.on("exit", () => {
    if (disposed) return;
    pushEvent("down", "cloudflared 退出，5s 后自动重拉（quick tunnel 会自己死，事实 13）");
    void notify(ctx, "down", currentUrl || null);
    timers.add(setTimeout(() => { if (!disposed) spawnCloudflared(ctx); }, RESPAWN_DELAY_MS));
  });
}

function renderCaddyfile(): string {
  // 语义照抄 v0.3.x etc/Caddyfile（:4080 而非 127.0.0.1:4080；Cookie 正则门；Host/Origin 重写；
  // {$VAR} 适配期替换）。新增：/rc-api/* 直达插件 listener（远端走门，本机 loopback 直过）。
  return `{
	admin off
	auto_https off
	log {
		output file ${JSON.stringify(join(RUN_DIR, "caddy.log"))}
		level WARN
	}
}

:4080 {
	bind 127.0.0.1
	@authed header_regexp Cookie .*{$RC_TOKEN}.*
	@authed-dsh header_regexp Cookie dsh-auth-.*
	@login path /rc-login
	@api path /rc-api/*
	@localapi remote_ip 127.0.0.1

	handle @login {
		reverse_proxy 127.0.0.1:${LOGIN_PORT}
	}

	handle @api {
		handle @localapi {
			reverse_proxy 127.0.0.1:${LOGIN_PORT}
		}
		handle @authed {
			reverse_proxy 127.0.0.1:${LOGIN_PORT}
		}
		handle @authed-dsh {
			reverse_proxy 127.0.0.1:${LOGIN_PORT}
		}
		handle {
			header Location /rc-login
			respond 302
		}
	}

	handle @authed {
		reverse_proxy ${UPSTREAM} {
			header_up Host ${UPSTREAM_HOST}
			header_up Origin http://${UPSTREAM_HOST}
		}
	}

	handle @authed-dsh {
		reverse_proxy ${UPSTREAM} {
			header_up Host ${UPSTREAM_HOST}
			header_up Origin http://${UPSTREAM_HOST}
		}
	}

	handle {
		header Location /rc-login
		respond 302
	}
}
`;
}

// ---------- apply ----------

export function apply(ctx: AnyCtx, config: Config = {}) {
  (globalThis as any).__dshRemoteCtx = ctx; // secrets helpers need ctx without threading it everywhere
  cfg = config;
  disposed = false;
  if (!config.enabled) return; // idle

  mkdirSync(RUN_DIR, { recursive: true });

  // 生命周期整体挂 ctx.effect（事实 14）：setup 现在跑，disposer 在 fiber 销毁时跑。
  ctx.effect(() => {
    let stopped = false;
    const boot = async () => {
      await reapOrphans(ctx);
      await ensureSecrets(ctx);
      loginServer = startLoginServer(ctx);
      await new Promise<void>((resolve, reject) => {
        loginServer!.once("error", reject);
        loginServer!.listen(LOGIN_PORT, "127.0.0.1", () => resolve());
      });
      say(ctx, "info", `[dsh-remote] login/api listening on 127.0.0.1:${LOGIN_PORT}`);
      spawnCaddy(ctx);
      spawnCloudflared(ctx);
    };
    boot().catch((e) => {
      say(ctx, "error", "[dsh-remote] 启动失败：" + (e as Error).message);
      pushEvent("down", "启动失败：" + (e as Error).message);
    });

    return () => { // disposer
      stopped = true; disposed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      try { if (caddyChild?.pid) process.kill(caddyChild.pid); } catch { /* gone */ }
      try { if (cloudflaredChild?.pid) process.kill(cloudflaredChild.pid); } catch { /* gone */ }
      try { loginServer?.close(); } catch { /* closed */ }
      for (const f of ["caddy.pid", "cloudflared.pid", "url"]) { try { rmSync(join(RUN_DIR, f)); } catch { /* absent */ } }
      say(ctx, "info", "[dsh-remote] tunnel + gate + login server stopped, state cleaned");
    };
  });
}
