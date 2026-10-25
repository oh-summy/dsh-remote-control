// @oh-summy/dsh-remote — M2+M3: quick tunnel + Caddy cookie gate + login page + notify + client page.
// Lean by design: node builtins + two host deps (zod, dsh-credentials). See docs/dsh-plugin-design.md.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

// ---------- constants ----------

const RUN_DIR = join(homedir(), ".remote-control", "run-plugin");
const UPSTREAM_HOST = "127.0.0.1:3080"; // DSH web 的 authority（Host 头必须是裸 host:port，不能带 scheme）
const UPSTREAM = "http://" + UPSTREAM_HOST; // Caddy 的上游
const TUNNEL_ENTRY = "http://127.0.0.1:4080"; // cloudflared 的 --url 指向 Caddy 门（绝不直连 DSH）
const GATE_PORT = 4080;
const LOGIN_PORT = 9091;
const URL_TIMEOUT_MS = 45_000;
const RESPAWN_DELAY_MS = 5_000;
const LOGIN_LOCK_MS = 300_000;
const LOGIN_MAX_FAILS = 5;
const REVEAL_FREQ_MS = 60_000;
const BODY_LIMIT = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
// 登录页/管理 API 的合法 Host（防 DNS rebinding）：本机直连 9091、或经 4080 门进来（Caddy 保留原 Host）。
// 远端经 Caddy 转发的 Host 是隧道域名，走会话校验，不做 Host 检查。
const LOCAL_HOSTS = new Set([
  `127.0.0.1:${LOGIN_PORT}`, `localhost:${LOGIN_PORT}`, `[::1]:${LOGIN_PORT}`,
  `127.0.0.1:${GATE_PORT}`, `localhost:${GATE_PORT}`, `[::1]:${GATE_PORT}`,
]);
// CORS 白名单：只有本机 DSH 页面（3080）需要跨端口访问 4080 的 /rc-api；远端页面同源，不需要 CORS
const CORS_ORIGINS = new Set(["http://127.0.0.1:3080", "http://localhost:3080", "http://[::1]:3080"]);
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
// ("cannot get property 'credentials' without inject"，M2 实测，事实 18)。
export const inject = ["credentials"];

// settings form（Plugins 页自动表单）。Config = zod（官方先例 dsh-plugin-market/dsh-agent-loop）。
// 全部非 volatile（事实 17）：每次配置变更 = 条目重启 = 隧道重建换址，full 密码档随 started 通知自救。
// enabled 亦是：翻转 = 重启 = 开关语义。
export const Config = z.object({
  enabled: z.boolean().default(false).describe("启用远程访问（关闭即回收隧道；开启/改配置会产生新的临时链接）"),
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

async function readBody(req: http.IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("body too large");
  }
  return body;
}

// ---------- events (module-level：跨条目重启保留最近事件) ----------

const events: Array<{ time: string; type: string; detail: string }> = [];

function pushEvent(type: string, detail: string) {
  events.unshift({ time: new Date().toISOString().replace("T", " ").slice(0, 19), type, detail });
  if (events.length > 20) events.pop();
  try { writeFileSync(join(RUN_DIR, "events.json"), JSON.stringify(events, null, 2)); } catch { /* best effort */ }
}

// ---------- module state ----------

let cfg: Config = {};
let currentUrl = "";
let sessionSecret = ""; // 本插件的 Cookie 门令牌：Caddy 正则门 + rc_session 值（登录后发给浏览器）
let dshSessionSecret = ""; // DSH 的 browser-session secret（签 dsh-auth-* cookie，读自凭据缝文件）
let password = "";
let caddyChild: ChildProcess | null = null;
let cloudflaredChild: ChildProcess | null = null;
let loginServer: http.Server | null = null;
let urlTimer: NodeJS.Timeout | null = null;
const failCounts = new Map<string, { count: number; until: number }>();
const revealAt = new Map<string, number>();

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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("webhook HTTP " + res.status);
}

async function sendApp(card: any): Promise<void> {
  const appId = cfg.notifyAppId || "";
  const appSecret = await getSecret(APP_SECRET_REF);
  if (!appId || !appSecret) throw new Error("App ID / App Secret 未配置（客户端页面 → 通知）");
  if (!cfg.notifyOpenId) throw new Error("接收者 open_id 未配置");
  const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const tokenJson = await tokenRes.json() as any;
  if (!tokenJson.tenant_access_token) throw new Error("凭据无效或权限缺失：" + (tokenJson.msg || "unknown"));
  const sendRes = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokenJson.tenant_access_token },
    body: JSON.stringify({ receive_id: cfg.notifyOpenId, msg_type: "interactive", content: JSON.stringify(card) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    else await sendApp(card);
    pushEvent(event, "通知已发送");
  } catch (e) {
    pushEvent(event, "通知失败：" + (e as Error).message);
    say(ctx, "warn", `[dsh-remote] notify failed: ${(e as Error).message}`);
  }
}

// ---------- secrets (dsh-credentials seam, fallback local 0600 file) ----------

function fallbackSecrets(): Record<string, string> {
  try { return JSON.parse(readFileSync(join(RUN_DIR, "secrets.json"), "utf8")); }
  catch { return {}; }
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
  try { chmodSync(join(RUN_DIR, "secrets.json"), 0o600); } catch { /* just created with mode */ }
}

async function ensureSecrets(ctx: AnyCtx): Promise<void> {
  // DSH 的 browser-session secret：签 dsh-auth-* cookie 用（读凭据缝文件，Q1 spike 已验证全链路）
  try {
    const yaml = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
    const m = yaml.match(/client-connection\/browser-session:[\s\S]{0,500}?secret:\s*["']?([A-Za-z0-9_+/=-]+)/);
    if (m) dshSessionSecret = m[1];
    else say(ctx, "warn", "[dsh-remote] 未找到 DSH browser-session secret——远程登录后将只发 rc_session，用户需自行通过 DSH fence");
  } catch {
    say(ctx, "warn", "[dsh-remote] 读取 .credentials.yaml 失败——同上");
  }
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

function classify(req: http.IncomingMessage): { isLocal: boolean; ip: string } {
  const cfIp = String(req.headers["cf-connecting-ip"] || "");
  const xff = String(req.headers["x-forwarded-for"] || "");
  const socketAddr = String(req.socket.remoteAddress || "");
  const loopback = socketAddr.includes("127.0.0.1") || socketAddr.includes("::1");
  // 远端（经隧道）必带 CF 边缘写入的 cf-connecting-ip；本机浏览器直连 4080 没有，
  // 只有 Caddy 自己追加的 x-forwarded-for（值还是 loopback）。
  const isLocal = !cfIp && loopback && (!xff || xff.includes("127.0.0.1") || xff.includes("::1"));
  return { isLocal, ip: cfIp || xff || socketAddr };
}

function startLoginServer(ctx: AnyCtx, isAlive: () => boolean): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const origin = String(req.headers.origin || "");
      const { isLocal, ip } = classify(req);
      // DNS rebinding 防护：本机直连的请求 Host 必须是 9091 的合法形态
      if (isLocal && !LOCAL_HOSTS.has(String(req.headers.host || ""))) { res.writeHead(403); res.end(); return; }
      // CORS 白名单：只允许本机 DSH 页面；带凭据的跨站写一律 403（防 drive-by）
      if (origin) {
        if (CORS_ORIGINS.has(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Credentials", "true");
          res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        } else if (req.method !== "GET") { res.writeHead(403); res.end(); return; }
      }
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/rc-login") {
        const lock = failCounts.get(ip);
        const lockMsg = lock && lock.count >= LOGIN_MAX_FAILS && lock.until > Date.now()
          ? `<p style="color:#c00">失败次数过多，${Math.ceil((lock.until - Date.now()) / 1000)}s 后重试</p>` : "";
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
        const lock = failCounts.get(ip);
        if (lock && lock.count >= LOGIN_MAX_FAILS && lock.until > Date.now()) { res.writeHead(429); res.end("locked"); return; }
        const supplied = String(new URLSearchParams(await readBody(req)).get("password") || "");
        if (timingSafeEq(supplied, password)) {
          failCounts.delete(ip);
          // rc_session 的值就是门令牌（v0.3.x 语义）：Caddy 正则门与会话校验共用它
          const dsh = dshCookieParts(UPSTREAM_HOST);
          const cookies = [`rc_session=${sessionSecret}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`];
          if (dsh) cookies.push(`${dsh.name}=${dsh.value}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
          res.writeHead(302, { Location: "/", "Set-Cookie": cookies });
          res.end();
          return;
        }
        const count = (lock?.count ?? 0) + 1;
        failCounts.set(ip, { count, until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0 });
        pushEvent("auth", "登录失败（" + (count >= LOGIN_MAX_FAILS ? "已锁 5 分钟" : count + "/5") + "）");
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<meta charset='utf-8'>密码错误，<a href='/rc-login'>重试</a>");
        return;
      }

      // /rc-api/* — 本机直连（loopback 且无代理头）或持有门令牌的会话
      if (path.startsWith("/rc-api/")) {
        const cookieValue = /rc_session=([^;]+)/.exec(String(req.headers.cookie || ""))?.[1] ?? "";
        const authed = isLocal || (cookieValue && timingSafeEq(cookieValue, sessionSecret));
        if (!authed) { res.writeHead(401); res.end("unauthorized"); return; }

        if (req.method === "GET" && path === "/rc-api/state") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            running: !!cloudflaredChild?.pid && pidAlive(cloudflaredChild.pid) && isAlive(),
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
          const last = revealAt.get(ip) ?? 0;
          if (Date.now() - last < REVEAL_FREQ_MS) { res.writeHead(429, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "操作过于频繁，60s 一次" })); return; }
          revealAt.set(ip, Date.now());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ password }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/reset") {
          password = hex(16);
          await setSecret(ctx, PASSWORD_REF, password);
          sessionSecret = hex(32);
          await setSecret(ctx, SESSION_REF, sessionSecret);
          restartCaddy(ctx); // 新 sessionSecret = 新门令牌：旧 rc_session 与 Caddy 门会话全部失效
          pushEvent("password", "密码已重置（门会话已全部失效；已登录设备的 DSH 会话按其 7 天 TTL 仍有效）");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/notify-secret") {
          const json = JSON.parse(await readBody(req) || "{}") as any;
          if (json.webhookUrl) await setSecret(ctx, WEBHOOK_REF, String(json.webhookUrl));
          if (json.appSecret) await setSecret(ctx, APP_SECRET_REF, String(json.appSecret));
          pushEvent("notify", "通知凭据已更新");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && path === "/rc-api/test") {
          const channel = cfg.notifyChannel || "off";
          if (channel === "off") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "通知通道未启用（设置表单里选 webhook 或 app）" })); return; }
          res.writeHead(200, { "Content-Type": "application/json" });
          await notify(ctx, "test", currentUrl || null);
          res.end(JSON.stringify({ ok: true }));
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

function waitPortFree(port: number, tries = 10): Promise<boolean> {
  return new Promise((resolve) => {
    const tick = (left: number) => {
      portBusy(port).then((busy) => {
        if (!busy) return resolve(true);
        if (left <= 0) return resolve(false);
        setTimeout(() => tick(left - 1), 300);
      });
    };
    tick(tries);
  });
}

function procName(pid: number): string {
  try {
    const out = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return (out.stdout || "").trim().split("/").pop() || "";
  } catch { return ""; }
}

function readPid(name: string): number {
  try { return Number(readFileSync(join(RUN_DIR, name + ".pid"), "utf8").trim()); } catch { return 0; }
}

async function reapOrphans(ctx: AnyCtx): Promise<void> {
  for (const name of ["caddy", "cloudflared"]) {
    const pid = readPid(name);
    if (pid > 0 && pidAlive(pid)) {
      if (procName(pid) !== name) continue; // PID 复用给了别的程序——绝不误杀
      try { process.kill(pid); say(ctx, "info", `[dsh-remote] reaped orphan ${name} (pid ${pid})`); } catch { /* gone */ }
      rmSync(join(RUN_DIR, name + ".pid"));
    }
  }
  if (!(await waitPortFree(GATE_PORT))) {
    throw new Error(`端口 ${GATE_PORT} 被非本插件进程占用（可能 v0.3.x 网关在跑：先 dsh-web stop）— fail loud，不抢端口`);
  }
  if (await portBusy(LOGIN_PORT)) {
    throw new Error(`端口 ${LOGIN_PORT} 被占用（可能 v0.3.x auth-server 在跑）— fail loud`);
  }
}

function spawnCaddy(ctx: AnyCtx, isAlive: () => boolean): void {
  const caddyfile = join(RUN_DIR, "Caddyfile");
  writeFileSync(caddyfile, renderCaddyfile());
  caddyChild = spawn(findBinary(cfg, "caddy"), ["run", "--config", caddyfile], {
    cwd: RUN_DIR,
    env: { ...process.env, RC_TOKEN: sessionSecret, RC_UPSTREAM: UPSTREAM, RC_LOG_DIR: RUN_DIR },
    stdio: ["ignore", "ignore", "ignore"],
  });
  writeFileSync(join(RUN_DIR, "caddy.pid"), String(caddyChild.pid));
  caddyChild.on("error", (e) => { pushEvent("down", "caddy 启动失败：" + e.message); say(ctx, "error", "[dsh-remote] caddy error: " + e.message); });
  caddyChild.on("exit", () => {
    if (!isAlive()) return;
    pushEvent("down", "caddy 退出，5s 后自动重拉");
    timers.add(setTimeout(() => { if (isAlive()) spawnCaddy(ctx, isAlive); }, RESPAWN_DELAY_MS));
  });
}

function restartCaddy(ctx: AnyCtx): void {
  // 只 kill：已有的 exit 处理器会在 5s 后用模块级最新 sessionSecret 重拉（一次，不双 spawn）
  try { if (caddyChild?.pid) process.kill(caddyChild.pid); } catch { /* gone */ }
}

function spawnCloudflared(ctx: AnyCtx, isAlive: () => boolean): void {
  if (urlTimer) { clearInterval(urlTimer); urlTimer = null; }
  const logFile = join(RUN_DIR, "cloudflared.log");
  writeFileSync(logFile, ""); // fresh log：URL grep 只看本次
  const out = openSync(logFile, "a");
  cloudflaredChild = spawn(findBinary(cfg, "cloudflared"),
    ["tunnel", "--url", TUNNEL_ENTRY, "--no-autoupdate", "--protocol", "http2"],
    { stdio: ["ignore", out, out] });
  writeFileSync(join(RUN_DIR, "cloudflared.pid"), String(cloudflaredChild.pid));
  say(ctx, "info", `[dsh-remote] cloudflared spawning (pid ${cloudflaredChild.pid})`);

  const startedAt = Date.now();
  let announced = currentUrl; // respawn 后 URL 未变则不重复通知
  urlTimer = setInterval(() => {
    const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== announced) {
      const changed = announced !== "";
      announced = m[0]; currentUrl = m[0];
      writeFileSync(join(RUN_DIR, "url"), m[0] + "\n");
      say(ctx, "info", `[dsh-remote] tunnel ${changed ? "changed" : "up"}: ${m[0]}`);
      pushEvent(changed ? "changed" : "started", m[0]);
      void notify(ctx, changed ? "changed" : "started", m[0]);
      // 不 clear：changed 检测需要持续监听（watchdog 语义）；disposer 统一清理
    } else if (!announced && Date.now() - startedAt > URL_TIMEOUT_MS) {
      clearInterval(urlTimer!); urlTimer = null;
      say(ctx, "warn", `[dsh-remote] no URL within 45s — see ${logFile}`);
      pushEvent("down", "45s 内未捕获到 URL");
    }
  }, 2000);

  cloudflaredChild.on("error", (e) => { pushEvent("down", "cloudflared 启动失败：" + e.message); say(ctx, "error", "[dsh-remote] cloudflared error: " + e.message); });
  cloudflaredChild.on("exit", () => {
    closeSync(out);
    if (!isAlive()) return;
    pushEvent("down", "cloudflared 退出，5s 后自动重拉（quick tunnel 会自己死，事实 13）");
    void notify(ctx, "down", currentUrl || null);
    timers.add(setTimeout(() => { if (isAlive()) spawnCloudflared(ctx, isAlive); }, RESPAWN_DELAY_MS));
  });
}

function renderCaddyfile(): string {
  // 语义照抄 v0.3.x etc/Caddyfile（:4080 而非 127.0.0.1:4080；Cookie 正则门；Host/Origin 重写；
  // {$VAR} 适配期替换）。新增：/rc-api/* 直达插件 listener（远端须过门，本机 loopback 直过）。
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
  if (!config.enabled) return; // idle

  mkdirSync(RUN_DIR, { recursive: true });

  // 生命周期整体挂 ctx.effect（事实 14）：setup 现在跑，disposer 在 fiber 销毁时跑。
  // dead/isAlive 是本条 fiber 的生命旗标——所有异步路径（boot 的 await 间隙、respawn 定时器）
  // 都必须检查，否则 fiber 销毁后仍会拉起进程（第 1 轮自审 P1-2 的根因）。
  ctx.effect(() => {
    let dead = false;
    const isAlive = () => !dead;

    const boot = async () => {
      await reapOrphans(ctx);
      if (!isAlive()) return;
      await ensureSecrets(ctx);
      if (!isAlive()) return;
      loginServer = startLoginServer(ctx, isAlive);
      await new Promise<void>((resolve, reject) => {
        loginServer!.once("error", reject);
        loginServer!.listen(LOGIN_PORT, "127.0.0.1", () => resolve());
      });
      if (!isAlive()) { loginServer!.close(); loginServer = null; return; }
      say(ctx, "info", `[dsh-remote] login/api listening on 127.0.0.1:${LOGIN_PORT}`);
      spawnCaddy(ctx, isAlive);
      spawnCloudflared(ctx, isAlive);
    };
    boot().catch((e) => {
      say(ctx, "error", "[dsh-remote] 启动失败：" + (e as Error).message);
      pushEvent("down", "启动失败：" + (e as Error).message);
    });

    return () => { // disposer
      dead = true;
      if (urlTimer) { clearInterval(urlTimer); urlTimer = null; }
      try { if (caddyChild?.pid) process.kill(caddyChild.pid); } catch { /* gone */ }
      try { if (cloudflaredChild?.pid) process.kill(cloudflaredChild.pid); } catch { /* gone */ }
      try { loginServer?.close(); } catch { /* closed */ }
      caddyChild = null; cloudflaredChild = null; loginServer = null; currentUrl = "";
      for (const f of ["caddy.pid", "cloudflared.pid", "url"]) { try { rmSync(join(RUN_DIR, f)); } catch { /* absent */ } }
      say(ctx, "info", "[dsh-remote] tunnel + gate + login server stopped, state cleaned");
    };
  });
}
