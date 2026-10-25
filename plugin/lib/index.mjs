import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
// src/index.ts
const RUN_DIR = join(homedir(), ".remote-control", "run-plugin");
const UPSTREAM_HOST = "127.0.0.1:3080";
const UPSTREAM = "http://127.0.0.1:3080";
const TUNNEL_ENTRY = "http://127.0.0.1:4080";
const GATE_PORT = 4080;
const LOGIN_PORT = 9091;
const URL_TIMEOUT_MS = 45e3;
const RESPAWN_DELAY_MS = 5e3;
const LOGIN_LOCK_MS = 3e5;
const LOGIN_MAX_FAILS = 5;
const REVEAL_FREQ_MS = 6e4;
const BODY_LIMIT = 65536;
const FETCH_TIMEOUT_MS = 1e4;
const LOCAL_HOSTS = /* @__PURE__ */ new Set([
	`127.0.0.1:${LOGIN_PORT}`,
	`localhost:${LOGIN_PORT}`,
	`[::1]:${LOGIN_PORT}`,
	`127.0.0.1:${GATE_PORT}`,
	`localhost:${GATE_PORT}`,
	`[::1]:${GATE_PORT}`
]);
const CORS_ORIGINS = /* @__PURE__ */ new Set([
	"http://127.0.0.1:3080",
	"http://localhost:3080",
	"http://[::1]:3080"
]);
const PASSWORD_REF = credentialRef("DSH_REMOTE_PASSWORD");
const SESSION_REF = credentialRef("DSH_REMOTE_SESSION_SECRET");
const WEBHOOK_REF = credentialRef("DSH_REMOTE_WEBHOOK_URL");
const APP_SECRET_REF = credentialRef("DSH_REMOTE_APP_SECRET");
const inject = ["credentials"];
const Config = z.object({
	enabled: z.boolean().default(false).describe("启用远程访问（关闭即回收隧道；开启产生新的临时链接）"),
	cloudflaredPath: z.string().default("").describe("cloudflared 路径（留空自动探测）"),
	caddyPath: z.string().default("").describe("caddy 路径（留空自动探测）"),
	notifyChannel: z.preprocess((v) => v === "webhook" || v === "app" ? "group" : v, z.enum([
		"off",
		"group",
		"dm"
	]).default("off")).describe("飞书通知：群聊或私聊"),
	notifyAppId: z.string().default("").describe("飞书 App ID（app 通道）"),
	notifyOpenId: z.string().default("").describe("私聊通知接收者 open_id（群通知不需要，页面可拉群列表自动选）"),
	notifyChatId: z.string().default("").describe("群通知 chat_id（页面「拉取群列表」自动填）"),
	notifyChatName: z.string().default("").describe("群通知显示名（随 chat_id 保存）"),
	autoRestart: z.boolean().default(true).describe("隧道进程意外退出时自动重拉（默认开）"),
	sessionDays: z.number().int().min(1).max(30).default(7).describe("远程会话有效天数（1-30，不可永久）")
});
function say(ctx, method, msg) {
	const logger = ctx.logger;
	if (logger && typeof logger[method] === "function") logger[method](msg);
	else if (method === "info") console.log(msg);
	else console.error(msg);
}
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function findBinary(config, name) {
	const candidates = [name === "cloudflared" ? config.cloudflaredPath : config.caddyPath, join(homedir(), ".remote-control", "bin", name)];
	for (const p of candidates) if (p && existsSync(p)) return p;
	return name;
}
function hex(bytes) {
	return crypto.randomBytes(bytes).toString("hex");
}
function timingSafeEq(a, b) {
	const ab = Buffer.from(a), bb = Buffer.from(b);
	return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function htmlEsc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function readBody(req, limit = BODY_LIMIT) {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > limit) throw new Error("body too large");
	}
	return body;
}
const events = [];
function pushEvent(type, detail) {
	events.unshift({
		time: (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19),
		type,
		detail
	});
	if (events.length > 20) events.pop();
	try {
		writeFileSync(join(RUN_DIR, "events.json"), JSON.stringify(events, null, 2));
	} catch {}
}
let cfg = {};
let currentUrl = "";
let sessionSecret = "";
let dshSessionSecret = "";
let password = "";
let caddyChild = null;
let cloudflaredChild = null;
let loginServer = null;
let urlTimer = null;
let stopping = false;
let fiberAlive = null;
const timers = /* @__PURE__ */ new Set();
const failCounts = /* @__PURE__ */ new Map();
const revealAt = /* @__PURE__ */ new Map();
function notifyText() {
	return password;
}
const MARKET_URL = "https://github.com/oh-summy/dsh-nano-market";
function cardFor(title, color, lines, url, note) {
	const elements = [];
	for (const line of lines) if (line === "---") elements.push({ tag: "hr" });
	else elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: line
		}
	});
	elements.push({
		tag: "action",
		actions: [{
			tag: "button",
			text: {
				tag: "plain_text",
				content: "dsh-nano-market"
			},
			url: MARKET_URL,
			type: "default"
		}]
	});
	elements.push({
		tag: "note",
		elements: [{
			tag: "plain_text",
			content: note
		}]
	});
	return {
		header: {
			title: {
				tag: "plain_text",
				content: title
			},
			template: color
		},
		elements
	};
}
async function sendWebhook(card) {
	const hook = await getSecret(WEBHOOK_REF);
	if (!hook) throw new Error("还没有填 webhook 地址——在下方通知设置里粘贴");
	const res = await fetch(hook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			msg_type: "interactive",
			card
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error("webhook HTTP " + res.status);
}
async function getTenantToken() {
	const appId = cfg.notifyAppId || "";
	const appSecret = await getSecret(APP_SECRET_REF);
	if (!appId || !appSecret) throw new Error("App ID / App Secret 未配置（先在通知设置里填好）");
	const tokenJson = await (await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			app_id: appId,
			app_secret: appSecret
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	})).json();
	if (!tokenJson.tenant_access_token) throw new Error("凭据无效或权限缺失：" + (tokenJson.msg || "unknown"));
	return tokenJson.tenant_access_token;
}
async function sendApp(card) {
	const receiveId = cfg.notifyChatId || cfg.notifyOpenId;
	if (!receiveId) throw new Error("接收者未配置：点「拉取群列表」选群，或填私聊 open_id / union_id");
	const receiveIdType = cfg.notifyChatId ? "chat_id" : String(receiveId).startsWith("on_") ? "union_id" : "open_id";
	const token = await getTenantToken();
	const sendJson = await (await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer " + token
		},
		body: JSON.stringify({
			receive_id: receiveId,
			msg_type: "interactive",
			content: JSON.stringify(card)
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	})).json();
	if (sendJson.code !== 0) throw new Error("发送失败 code " + sendJson.code + "：" + (sendJson.msg || "unknown") + "（常见原因：应用缺 im:message 发消息权限）");
}
async function sendNotify(ctx, event, url) {
	const channel = cfg.notifyChannel || "off";
	if (channel === "off") return {
		ok: false,
		error: "通知未开启"
	};
	const [title, color] = {
		started: ["远程访问已开启", "green"],
		changed: ["访问地址已变化", "blue"],
		down: ["远程访问已断开", "red"],
		recovered: ["远程访问已恢复", "green"],
		test: ["测试通知", "grey"],
		enabled: ["通知已开启", "green"]
	}[event] ?? ["远程访问", "grey"];
	const tier = notifyText();
	let lines;
	if (event === "down" || event === "recovered") lines = url ? ["**最新地址**", url] : ["隧道进程已退出，正在自动恢复。"];
	else lines = url ? [
		"**访问地址**",
		url,
		"---",
		"**访问密码**",
		tier
	] : [
		"（隧道未运行，暂无访问地址）",
		"**访问密码**",
		tier
	];
	const card = cardFor(title, color, lines, url, "dsh-remote By oh-summy · " + (/* @__PURE__ */ new Date()).toLocaleString("zh-CN"));
	try {
		if (channel === "group") {
			const hook = await getSecret(WEBHOOK_REF);
			if (cfg.notifyChatId) await sendApp(card);
			else if (hook) await sendWebhook(card);
			else throw new Error("群聊未配置：点「拉取群列表」选群（走应用），或填群机器人 webhook 地址");
		} else {
			if (!cfg.notifyOpenId) throw new Error("私聊需要 open_id（开放平台消息日志里可查）");
			await sendApp(card);
		}
		pushEvent(event, "通知已发送");
		return { ok: true };
	} catch (e) {
		const m = e.message;
		pushEvent(event, "通知失败：" + m);
		say(ctx, "warn", `[dsh-remote] notify failed: ${m}`);
		return {
			ok: false,
			error: m
		};
	}
}
function fallbackSecrets() {
	try {
		return JSON.parse(readFileSync(join(RUN_DIR, "secrets.json"), "utf8"));
	} catch {
		return {};
	}
}
async function getSecret(ref) {
	const ctx = globalThis.__dshRemoteCtx;
	if (ctx?.credentials) return (await ctx.credentials.resolve(ref))?.value ?? null;
	return fallbackSecrets()[ref] ?? null;
}
async function setSecret(ctx, ref, value) {
	if (ctx.credentials) {
		await ctx.credentials.set(ref, value);
		return;
	}
	const all = fallbackSecrets();
	all[ref] = value;
	writeFileSync(join(RUN_DIR, "secrets.json"), JSON.stringify(all, null, 2), { mode: 384 });
	try {
		chmodSync(join(RUN_DIR, "secrets.json"), 384);
	} catch {}
}
async function ensureSecrets(ctx) {
	try {
		const m = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8").match(/client-connection\/browser-session:[\s\S]{0,500}?secret:\s*["']?([A-Za-z0-9_+/=-]+)/);
		if (m) dshSessionSecret = m[1];
		else say(ctx, "warn", "[dsh-remote] 未找到 DSH browser-session secret——远程登录后将只发 rc_session，用户需自行通过 DSH fence");
	} catch {
		say(ctx, "warn", "[dsh-remote] 读取 .credentials.yaml 失败——同上");
	}
	password = await getSecret(PASSWORD_REF) ?? "";
	if (!password) {
		password = hex(16);
		await setSecret(ctx, PASSWORD_REF, password);
		pushEvent("init", "访问密码已生成");
	}
	sessionSecret = await getSecret(SESSION_REF) ?? "";
	if (!sessionSecret) {
		sessionSecret = hex(32);
		await setSecret(ctx, SESSION_REF, sessionSecret);
	}
}
function dshCookieParts(authority) {
	if (!dshSessionSecret) return null;
	const b64url = (buf) => buf.toString("base64url");
	const name = "dsh-auth-" + b64url(crypto.createHash("sha256").update(authority).digest());
	const secretBytes = Buffer.from(dshSessionSecret, "base64url");
	const now = Date.now();
	const days = Math.min(Math.max(Number(cfg.sessionDays) || 7, 1), 30);
	const body = b64url(Buffer.from(JSON.stringify({
		version: 1,
		authority,
		issuedAt: now,
		expiresAt: now + days * 86400 * 1e3
	})));
	const sig = b64url(crypto.createHmac("sha256", secretBytes).update(body).digest());
	return {
		name,
		value: "v1." + body + "." + sig
	};
}
function classify(req) {
	const cfIp = String(req.headers["cf-connecting-ip"] || "");
	const xff = String(req.headers["x-forwarded-for"] || "");
	const socketAddr = String(req.socket.remoteAddress || "");
	const loopback = socketAddr.includes("127.0.0.1") || socketAddr.includes("::1");
	return {
		isLocal: !cfIp && loopback && (!xff || xff.includes("127.0.0.1") || xff.includes("::1")),
		ip: cfIp || xff || socketAddr
	};
}
function startLoginServer(ctx) {
	return http.createServer(async (req, res) => {
		try {
			const origin = String(req.headers.origin || "");
			const { isLocal, ip } = classify(req);
			if (isLocal && !LOCAL_HOSTS.has(String(req.headers.host || ""))) {
				res.writeHead(403);
				res.end();
				return;
			}
			const host0 = String(req.headers.host || "");
			const selfOrigin = origin === "https://" + host0 || origin === "http://" + host0;
			if (origin && !selfOrigin) {
				if (CORS_ORIGINS.has(origin)) {
					res.setHeader("Access-Control-Allow-Origin", origin);
					res.setHeader("Access-Control-Allow-Credentials", "true");
					res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
					res.setHeader("Access-Control-Allow-Headers", "Content-Type");
				} else if (req.method !== "GET") {
					res.writeHead(403);
					res.end();
					return;
				}
			}
			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}
			const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
			if (req.method === "GET" && path === "/rc-login") {
				const lock = failCounts.get(ip);
				const lockLeft = lock && lock.count >= LOGIN_MAX_FAILS ? Math.ceil((lock.until - Date.now()) / 1e3) : 0;
				const tunnelHost = String(req.headers.host || "").replace(/:\d+$/, "");
				const lockMsg = lockLeft > 0 ? `<div class="chip err">尝试次数过多，${lockLeft}s 后可重试</div>` : "";
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 远程访问</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(165deg, #0b1220 0%, #16233b 55%, #1b2c49 100%); color: #e6edf7;
    font-family: system-ui,-apple-system,sans-serif; padding: 24px; }
  .card { width: 100%; max-width: 380px; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.09);
    border-radius: 16px; padding: 30px 28px 24px; backdrop-filter: blur(8px); }
  .mark { font-size: 12px; letter-spacing: .14em; color: #8aa0bf; text-transform: uppercase; }
  h1 { font-size: 21px; margin: 10px 0 4px; font-weight: 650; }
  .sub { color: #8aa0bf; font-size: 13px; margin: 0 0 20px; line-height: 1.6; }
  .host { display: inline-block; font-family: ui-monospace,monospace; font-size: 11.5px; color: #9fd0a8;
    background: rgba(157,208,168,.09); border: 1px solid rgba(157,208,168,.25); border-radius: 999px;
    padding: 3px 10px; margin-bottom: 18px; word-break: break-all; }
  .tunnel { display: flex; align-items: center; gap: 8px; margin: 0 0 20px; color: #5b7292; font-size: 11px; }
  .tunnel .line { flex: 1; height: 1px; background: linear-gradient(90deg, rgba(143,163,191,.55), rgba(143,163,191,.15)); position: relative; }
  .tunnel .line i { position: absolute; top: -2.5px; width: 6px; height: 6px; border-radius: 99px; background: #4f8cff; }
  .tunnel .line i.a { left: 0; } .tunnel .line i.b { right: 0; animation: pulse 2.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
  @media (prefers-reduced-motion: reduce) { .tunnel .line i.b { animation: none } }
  input[type=password] { width: 100%; padding: 13px 14px; font-size: 16px; background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.14); border-radius: 10px; color: #e6edf7; outline: none; }
  input[type=password]:focus { border-color: #4f8cff; box-shadow: 0 0 0 3px rgba(79,140,255,.22); }
  button { width: 100%; padding: 13px; margin-top: 14px; font-size: 15px; font-weight: 600; cursor: pointer;
    background: #4f8cff; border: none; border-radius: 10px; color: #fff; }
  button:focus-visible, input:focus-visible { outline: 2px solid #9cc2ff; outline-offset: 2px; }
  .chip { border-radius: 10px; padding: 10px 12px; font-size: 13px; margin: 0 0 14px; line-height: 1.5; }
  .chip.err { background: rgba(220,38,38,.12); border: 1px solid rgba(220,38,38,.35); color: #fca5a5; }
  .foot { color: #5b7292; font-size: 12px; margin: 18px 0 0; line-height: 1.6; }
</style></head>
<body><div class="card">
  <div class="mark">deepseek harness · 远程访问</div>
  <h1>本机 DSH 的安全门</h1>
  <p class="sub">输入访问密码即可使用这台机器上的 DSH。会话 7 天内有效。</p>
  <span class="host">${htmlEsc(tunnelHost)}</span>
  <div class="tunnel"><span>你</span><span class="line"><i class="a"></i><i class="b"></i></span><span>Cloudflare</span><span class="line"><i class="a"></i><i class="b"></i></span><span>本机 DSH</span></div>
  ${lockMsg}
  <form method="post" action="/rc-login">
    <input type="password" name="password" placeholder="访问密码" autofocus autocomplete="current-password" required>
    <button type="submit">进入 DSH</button>
  </form>
  <p class="foot">密码由本机 DSH 的「远程访问」插件生成，可在插件页面查看或重置。连续失败 5 次将锁定 5 分钟。</p>
</div></body></html>`);
				return;
			}
			if (req.method === "POST" && path === "/rc-login") {
				const lock = failCounts.get(ip);
				if (lock && lock.count >= LOGIN_MAX_FAILS && lock.until > Date.now()) {
					res.writeHead(429);
					res.end("locked");
					return;
				}
				if (timingSafeEq(String(new URLSearchParams(await readBody(req)).get("password") || ""), password)) {
					failCounts.delete(ip);
					const dsh = dshCookieParts(UPSTREAM_HOST);
					const days = Math.min(Math.max(Number(cfg.sessionDays) || 7, 1), 30);
					const cookies = [`rc_session=${sessionSecret}; HttpOnly; Path=/; Max-Age=${days * 86400}; SameSite=Lax`];
					if (dsh) cookies.push(`${dsh.name}=${dsh.value}; HttpOnly; Path=/; Max-Age=${days * 86400}; SameSite=Lax`);
					res.writeHead(302, {
						Location: "/",
						"Set-Cookie": cookies
					});
					res.end();
					return;
				}
				const count = (lock?.count ?? 0) + 1;
				failCounts.set(ip, {
					count,
					until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0
				});
				if (failCounts.size > 200) {
					for (const [k, v] of failCounts) if (v.until < Date.now()) failCounts.delete(k);
				}
				pushEvent("auth", "登录失败（" + (count >= LOGIN_MAX_FAILS ? "已锁 5 分钟" : count + "/5") + "）");
				res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
				res.end("<meta charset='utf-8'>密码错误，<a href='/rc-login'>重试</a>");
				return;
			}
			if (path.startsWith("/rc-api/")) {
				const cookieValue = /rc_session=([^;]+)/.exec(String(req.headers.cookie || ""))?.[1] ?? "";
				if (!(isLocal || cookieValue && timingSafeEq(cookieValue, sessionSecret))) {
					res.writeHead(401);
					res.end("unauthorized");
					return;
				}
				if (req.method === "GET" && path === "/rc-api/state") {
					const appSecret = await getSecret(APP_SECRET_REF);
					const mask = (v, n) => v ? String(v).slice(0, n) + "••••••" : "";
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						running: !!cloudflaredChild?.pid && pidAlive(cloudflaredChild.pid),
						url: currentUrl,
						passwordMask: password.slice(0, 4) + "••••••••",
						autoRestart: cfg.autoRestart !== false,
						sessionDays: Number(cfg.sessionDays) || 7,
						channel: cfg.notifyChannel || "off",
						hasWebhook: !!await getSecret(WEBHOOK_REF),
						hasAppSecret: !!appSecret,
						appIdMask: mask(cfg.notifyAppId, 6),
						openIdMask: mask(cfg.notifyOpenId, 6),
						appSecretMask: mask(appSecret, 4),
						chatId: cfg.notifyChatId || "",
						chatName: cfg.notifyChatName || "",
						events
					}));
					return;
				}
				if (req.method === "GET" && path === "/rc-api/appcheck") {
					const out = {
						token: false,
						imMessage: null,
						imChat: null,
						error: ""
					};
					try {
						const token = await getTenantToken();
						out.token = true;
						try {
							out.imChat = (await (await fetch("https://open.feishu.cn/open-apis/im/v1/chats?page_size=1", {
								headers: { Authorization: "Bearer " + token },
								signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
							})).json()).code === 0;
						} catch {}
						try {
							const j = await (await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									Authorization: "Bearer " + token
								},
								body: JSON.stringify({
									receive_id: "ou_0000000000000000000000000000",
									msg_type: "text",
									content: "{\"text\":\"x\"}"
								}),
								signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
							})).json();
							out.imMessage = !(j.code === 99991672 || j.code === 99991661 || /scope|权限/.test(String(j.msg || "")));
						} catch {}
					} catch (e) {
						out.error = e.message;
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(out));
					return;
				}
				if (req.method === "POST" && path === "/rc-api/reveal") {
					const last = revealAt.get(ip) ?? 0;
					if (!isLocal && Date.now() - last < REVEAL_FREQ_MS) {
						res.writeHead(429, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "操作过于频繁，60s 一次" }));
						return;
					}
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
					restartCaddy(ctx);
					pushEvent("password", "密码已重置（门会话已全部失效；已登录设备的 DSH 会话按其 7 天 TTL 仍有效）");
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					return;
				}
				if (req.method === "POST" && path === "/rc-api/notify-secret") {
					const json = JSON.parse(await readBody(req) || "{}");
					if (json.webhookUrl) await setSecret(ctx, WEBHOOK_REF, String(json.webhookUrl));
					if (json.appSecret) await setSecret(ctx, APP_SECRET_REF, String(json.appSecret));
					pushEvent("notify", "通知凭据已更新");
					if (currentUrl) {
						const ch = cfg.notifyChannel || "off";
						if (ch === "dm" ? !!cfg.notifyOpenId : ch === "group" ? !!cfg.notifyChatId || !!await getSecret(WEBHOOK_REF) : false) sendNotify(ctx, "enabled", currentUrl);
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					return;
				}
				if (req.method === "POST" && path === "/rc-api/toggle") {
					const target = !cfg.enabled;
					try {
						if (target) await startTunnel(ctx);
						else stopTunnel(ctx);
						cfg = {
							...cfg,
							enabled: target
						};
						saveSettings();
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							ok: true,
							enabled: target
						}));
					} catch (e) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: e.message }));
					}
					return;
				}
				if (req.method === "GET" && path === "/rc-api/chats") {
					try {
						const token = await getTenantToken();
						const chatsJson = await (await fetch("https://open.feishu.cn/open-apis/im/v1/chats?page_size=50", {
							headers: { Authorization: "Bearer " + token },
							signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
						})).json();
						if (chatsJson.code !== 0) throw new Error("拉取失败 code " + chatsJson.code + "：" + (chatsJson.msg || "") + "（应用需要 im:chat 群组权限，且机器人要已被拉进群）");
						const chats = (chatsJson.data?.items || []).map((c) => ({
							chatId: c.chat_id,
							name: c.name
						}));
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ chats }));
					} catch (e) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: e.message }));
					}
					return;
				}
				if (req.method === "POST" && path === "/rc-api/config") {
					const json = JSON.parse(await readBody(req) || "{}");
					const fields = {};
					if (json.notifyChannel !== void 0) {
						const ch = String(json.notifyChannel);
						if (![
							"off",
							"group",
							"dm"
						].includes(ch)) {
							res.writeHead(400, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ error: "通道取值非法" }));
							return;
						}
						fields.notifyChannel = ch;
					}
					if (json.notifyAppId !== void 0) fields.notifyAppId = String(json.notifyAppId);
					if (json.notifyOpenId !== void 0) fields.notifyOpenId = String(json.notifyOpenId);
					if (json.notifyChatId !== void 0) fields.notifyChatId = String(json.notifyChatId);
					if (json.notifyChatName !== void 0) fields.notifyChatName = String(json.notifyChatName);
					if (json.autoRestart !== void 0) fields.autoRestart = !!json.autoRestart;
					if (json.sessionDays !== void 0) fields.sessionDays = Math.min(Math.max(parseInt(String(json.sessionDays), 10) || 7, 1), 30);
					cfg = {
						...cfg,
						...fields
					};
					saveSettings();
					pushEvent("config", "设置已保存（立即生效）");
					if ((fields.notifyChannel && fields.notifyChannel !== "off" || fields.notifyChatId || fields.notifyOpenId) && (cfg.notifyChannel || "off") !== "off" && currentUrl) sendNotify(ctx, "enabled", currentUrl);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					return;
				}
				if (req.method === "GET" && path === "/rc-api/envcheck") {
					const out = {};
					for (const name of ["cloudflared", "caddy"]) {
						const p = findBinary(cfg, name);
						let found = p !== name && existsSync(p);
						let version = "";
						if (found) version = (spawnSync(p, ["--version"], {
							encoding: "utf8",
							timeout: 4e3
						}).stdout || "").split("\n")[0].slice(0, 60);
						else found = spawnSync("which", [name], { encoding: "utf8" }).status === 0;
						out[name] = {
							found,
							path: p,
							version
						};
					}
					out.dshSecret = !!dshSessionSecret;
					out.cfAccount = true;
					if (currentUrl) try {
						const r = await fetch(currentUrl, {
							redirect: "manual",
							signal: AbortSignal.timeout(8e3)
						});
						out.tunnelLink = {
							ok: r.status > 0 && r.status < 500,
							status: r.status
						};
					} catch (e) {
						out.tunnelLink = {
							ok: false,
							status: String(e.message).slice(0, 60)
						};
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(out));
					return;
				}
				if (req.method === "POST" && path === "/rc-api/test") {
					if ((cfg.notifyChannel || "off") === "off") {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "通知未开启" }));
						return;
					}
					const r = await sendNotify(ctx, "test", currentUrl || null);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(r && r.ok ? {
						ok: true,
						detail: "测试消息已发送，请看飞书"
					} : {
						ok: false,
						error: r && r.error
					}));
					return;
				}
			}
			res.writeHead(404);
			res.end();
		} catch (e) {
			say(ctx, "error", "[dsh-remote] api error: " + e.message);
			try {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: e.message }));
			} catch {}
		}
	});
}
function portBusy(port) {
	return new Promise((resolve) => {
		const s = net.createConnection({
			port,
			host: "127.0.0.1"
		});
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => {
			s.destroy();
			resolve(false);
		});
	});
}
function waitPortFree(port, tries = 10) {
	return new Promise((resolve) => {
		const tick = (left) => {
			portBusy(port).then((busy) => {
				if (!busy) return resolve(true);
				if (left <= 0) return resolve(false);
				setTimeout(() => tick(left - 1), 300);
			});
		};
		tick(tries);
	});
}
function procName(pid) {
	try {
		return (spawnSync("ps", [
			"-p",
			String(pid),
			"-o",
			"comm="
		], { encoding: "utf8" }).stdout || "").trim().split("/").pop() || "";
	} catch {
		return "";
	}
}
function readPid(name) {
	try {
		return Number(readFileSync(join(RUN_DIR, name + ".pid"), "utf8").trim());
	} catch {
		return 0;
	}
}
const PROFILE_PATCH = join(homedir(), ".dsh", "profiles", "web", "cordis.patch.yml");
const SETTINGS_FILE = join(RUN_DIR, "settings.json");
function readUserBlock() {
	try {
		const lines = readFileSync(PROFILE_PATCH, "utf8").split("\n");
		let start = -1;
		for (let i = 0; i < lines.length; i++) if (lines[i].trim() === "- id: dsh-remote") {
			start = i;
			break;
		}
		if (start < 0) return null;
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) if (/^- /.test(lines[i])) {
			end = i;
			break;
		}
		return {
			lines,
			start,
			end,
			text: lines.slice(start, end).join("\n")
		};
	} catch {
		return null;
	}
}
function blockValue(blockText, key) {
	const m = new RegExp("^\\s+" + key + ":\\s*(.+)$", "m").exec(blockText);
	return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}
function loadSettings() {
	const migrateChannel = (c) => {
		if (c === "webhook") return "group";
		if (c === "app") return "group";
		if (c === "dm" || c === "group" || c === "off") return c;
		return "off";
	};
	const s = (() => {
		try {
			return JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		} catch {
			const cur = readUserBlock();
			const s = {};
			if (cur) for (const k of [
				"enabled",
				"autoRestart",
				"notifyChannel",
				"notifyAppId",
				"notifyOpenId",
				"sessionDays"
			]) {
				const v = blockValue(cur.text, k);
				if (v !== null) s[k] = v === "true" ? true : v === "false" ? false : k === "sessionDays" ? Number(v) : v;
			}
			return s;
		}
	})();
	s.notifyChannel = migrateChannel(s.notifyChannel);
	if (!s.notifyChatId && s.notifyChannel === "group" && s.notifyOpenId) s.notifyChannel = "dm";
	return s;
}
function saveSettings() {
	const s = {
		enabled: cfg.enabled === true,
		autoRestart: cfg.autoRestart !== false,
		notifyChannel: cfg.notifyChannel || "off",
		notifyAppId: cfg.notifyAppId || "",
		notifyOpenId: cfg.notifyOpenId || "",
		notifyChatId: cfg.notifyChatId || "",
		notifyChatName: cfg.notifyChatName || "",
		sessionDays: Number(cfg.sessionDays) || 7
	};
	try {
		writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
	} catch {}
}
async function reapOrphans(ctx) {
	for (const name of ["caddy", "cloudflared"]) {
		const pid = readPid(name);
		if (pid > 0 && pidAlive(pid)) {
			if (procName(pid) !== name) continue;
			try {
				process.kill(pid);
				say(ctx, "info", `[dsh-remote] reaped orphan ${name} (pid ${pid})`);
			} catch {}
			rmSync(join(RUN_DIR, name + ".pid"));
		}
	}
	if (!await waitPortFree(GATE_PORT)) throw new Error(`端口 ${GATE_PORT} 被非本插件进程占用（可能 v0.3.x 网关在跑：先 dsh-web stop）— fail loud，不抢端口`);
	await waitPortFree(LOGIN_PORT);
}
function spawnCaddy(ctx) {
	const alive = () => fiberAlive?.() ?? false;
	const caddyfile = join(RUN_DIR, "Caddyfile");
	writeFileSync(caddyfile, renderCaddyfile());
	caddyChild = spawn(findBinary(cfg, "caddy"), [
		"run",
		"--config",
		caddyfile
	], {
		cwd: RUN_DIR,
		env: {
			...process.env,
			RC_TOKEN: sessionSecret,
			RC_UPSTREAM: UPSTREAM,
			RC_LOG_DIR: RUN_DIR
		},
		stdio: [
			"ignore",
			"ignore",
			"ignore"
		]
	});
	writeFileSync(join(RUN_DIR, "caddy.pid"), String(caddyChild.pid));
	caddyChild.on("error", (e) => {
		pushEvent("down", "caddy 启动失败：" + e.message);
		say(ctx, "error", "[dsh-remote] caddy error: " + e.message);
	});
	caddyChild.on("exit", () => {
		if (stopping) return;
		if (!alive()) return;
		pushEvent("down", "caddy 退出，5s 后自动重拉");
		timers.add(setTimeout(() => {
			if (alive() && cfg.autoRestart !== false) spawnCaddy(ctx);
		}, RESPAWN_DELAY_MS));
	});
}
function restartCaddy(ctx) {
	try {
		if (caddyChild?.pid) process.kill(caddyChild.pid);
	} catch {}
}
function spawnCloudflared(ctx) {
	const alive = () => fiberAlive?.() ?? false;
	if (urlTimer) {
		clearInterval(urlTimer);
		urlTimer = null;
	}
	const logFile = join(RUN_DIR, "cloudflared.log");
	writeFileSync(logFile, "");
	const out = openSync(logFile, "a");
	cloudflaredChild = spawn(findBinary(cfg, "cloudflared"), [
		"tunnel",
		"--url",
		TUNNEL_ENTRY,
		"--no-autoupdate",
		"--protocol",
		"http2"
	], { stdio: [
		"ignore",
		out,
		out
	] });
	writeFileSync(join(RUN_DIR, "cloudflared.pid"), String(cloudflaredChild.pid));
	say(ctx, "info", `[dsh-remote] cloudflared spawning (pid ${cloudflaredChild.pid})`);
	const startedAt = Date.now();
	let announced = currentUrl;
	urlTimer = setInterval(() => {
		const m = (existsSync(logFile) ? readFileSync(logFile, "utf8") : "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
		if (m && m[0] !== announced) {
			const changed = announced !== "";
			announced = m[0];
			currentUrl = m[0];
			writeFileSync(join(RUN_DIR, "url"), m[0] + "\n");
			say(ctx, "info", `[dsh-remote] tunnel ${changed ? "changed" : "up"}: ${m[0]}`);
			pushEvent(changed ? "changed" : "started", m[0]);
			sendNotify(ctx, changed ? "changed" : "started", m[0]);
		} else if (!announced && Date.now() - startedAt > URL_TIMEOUT_MS) {
			clearInterval(urlTimer);
			urlTimer = null;
			say(ctx, "warn", `[dsh-remote] no URL within 45s — see ${logFile}`);
			pushEvent("down", "45s 内未捕获到 URL");
		}
	}, 2e3);
	cloudflaredChild.on("error", (e) => {
		pushEvent("down", "cloudflared 启动失败：" + e.message);
		say(ctx, "error", "[dsh-remote] cloudflared error: " + e.message);
	});
	cloudflaredChild.on("exit", () => {
		closeSync(out);
		if (stopping) return;
		if (!alive()) return;
		if (cfg.autoRestart === false) {
			pushEvent("down", "cloudflared 退出（自动重启已关闭）");
			say(ctx, "warn", "[dsh-remote] cloudflared exited, auto-restart off");
			return;
		}
		pushEvent("down", "cloudflared 退出，5s 后自动重拉（quick tunnel 会自己死，事实 13）");
		sendNotify(ctx, "down", currentUrl || null);
		timers.add(setTimeout(() => {
			if (alive() && cfg.autoRestart !== false) spawnCloudflared(ctx);
		}, RESPAWN_DELAY_MS));
	});
}
async function startTunnel(ctx) {
	if (cloudflaredChild?.pid && pidAlive(cloudflaredChild.pid)) return;
	stopping = false;
	await reapOrphans(ctx);
	spawnCaddy(ctx);
	spawnCloudflared(ctx);
}
function stopTunnel(ctx) {
	if (!cloudflaredChild && !caddyChild) {
		currentUrl = "";
		return;
	}
	stopping = true;
	if (urlTimer) {
		clearInterval(urlTimer);
		urlTimer = null;
	}
	for (const t of timers) clearTimeout(t);
	timers.clear();
	try {
		if (caddyChild?.pid) process.kill(caddyChild.pid);
	} catch {}
	try {
		if (cloudflaredChild?.pid) process.kill(cloudflaredChild.pid);
	} catch {}
	caddyChild = null;
	cloudflaredChild = null;
	currentUrl = "";
	for (const f of [
		"caddy.pid",
		"cloudflared.pid",
		"url"
	]) try {
		rmSync(join(RUN_DIR, f));
	} catch {}
	pushEvent("down", "远程访问已停止（链接已失效）");
	say(ctx, "info", "[dsh-remote] tunnel + gate stopped by owner");
}
function renderCaddyfile() {
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
	# 访问日志：定位"远程 403"到底有没有到我们的门（没到 = 网络路径被拦）
	log {
		output file ${JSON.stringify(join(RUN_DIR, "access.log"))} {
			roll_size 1MiB
			roll_keep 2
		}
		level INFO
	}
	@authed header_regexp Cookie .*{$RC_TOKEN}.*
	@authed-dsh header_regexp Cookie dsh-auth-.*
	@login path /rc-login
	@api path /rc-api/*
	@localapi remote_ip 127.0.0.1

	handle @login {
		reverse_proxy 127.0.0.1:${LOGIN_PORT}
	}

	handle @api {
		# 远端 /rc-api 的授权在插件侧 classify（cf-connecting-ip 存在=远端 → rc_session 校验）；
		# cloudflared→Caddy 的 remote_ip 恒为 127.0.0.1，@localapi 恒先命中——内层不再分支。
		handle @localapi {
			reverse_proxy 127.0.0.1:${LOGIN_PORT}
		}
		handle {
			header Location /rc-login
			respond 302
		}
	}

	handle @authed {
		reverse_proxy ${UPSTREAM} {
			# 过期/无效的 dsh-auth cookie：DSH 回 401/403 → 送回登录页（杜绝死路 403）
			@fence status 401 403
			handle_response @fence {
				error 401 "fence"
			}
			header_up Host ${UPSTREAM_HOST}
			header_up Origin http://${UPSTREAM_HOST}
		}
	}

	handle @authed-dsh {
		reverse_proxy ${UPSTREAM} {
			@fence status 401 403
			handle_response @fence {
				error 401 "fence"
			}
			header_up Host ${UPSTREAM_HOST}
			header_up Origin http://${UPSTREAM_HOST}
		}
	}

	handle {
		header Location /rc-login
		respond 302
	}

	handle_errors {
		handle {
			header Location /rc-login
			respond 302
		}
	}
}
`;
}
function apply(ctx, config = {}) {
	globalThis.__dshRemoteCtx = ctx;
	cfg = {
		...config,
		...loadSettings()
	};
	mkdirSync(RUN_DIR, { recursive: true });
	ctx.effect(() => {
		let dead = false;
		const isAlive = () => !dead;
		fiberAlive = isAlive;
		const boot = async () => {
			await ensureSecrets(ctx);
			if (!isAlive()) return;
			loginServer = startLoginServer(ctx);
			for (let attempt = 0;; attempt++) try {
				await new Promise((resolve, reject) => {
					loginServer.once("error", reject);
					loginServer.listen(LOGIN_PORT, "127.0.0.1", () => resolve());
				});
				break;
			} catch (e) {
				if (attempt >= 5 || !isAlive() || String(e.message).indexOf("EADDRINUSE") < 0) throw e;
				say(ctx, "warn", "[dsh-remote] 9091 暂被上一代 fiber 占用，500ms 后重试");
				await new Promise((r) => setTimeout(r, 500));
			}
			if (!isAlive()) {
				try {
					loginServer.close();
				} catch {}
				loginServer = null;
				return;
			}
			say(ctx, "info", `[dsh-remote] login/api listening on 127.0.0.1:${LOGIN_PORT}`);
			if (!cfg.enabled) return;
			await reapOrphans(ctx);
			if (!isAlive()) return;
			spawnCaddy(ctx);
			spawnCloudflared(ctx);
		};
		boot().catch((e) => {
			say(ctx, "error", "[dsh-remote] 启动失败：" + e.message);
			pushEvent("down", "启动失败：" + e.message);
		});
		return () => {
			dead = true;
			fiberAlive = null;
			if (urlTimer) {
				clearInterval(urlTimer);
				urlTimer = null;
			}
			for (const t of timers) clearTimeout(t);
			timers.clear();
			try {
				if (caddyChild?.pid) process.kill(caddyChild.pid);
			} catch {}
			try {
				if (cloudflaredChild?.pid) process.kill(cloudflaredChild.pid);
			} catch {}
			try {
				loginServer?.close();
			} catch {}
			caddyChild = null;
			cloudflaredChild = null;
			loginServer = null;
			currentUrl = "";
			for (const f of [
				"caddy.pid",
				"cloudflared.pid",
				"url"
			]) try {
				rmSync(join(RUN_DIR, f));
			} catch {}
			say(ctx, "info", "[dsh-remote] tunnel + gate + login server stopped, state cleaned");
		};
	});
}
export { Config, apply, inject };
