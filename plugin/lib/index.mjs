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
	enabled: z.boolean().default(false).describe("启用远程访问（关闭即回收隧道；开启/改配置会产生新的临时链接）"),
	cloudflaredPath: z.string().default("").describe("cloudflared 路径（留空自动探测）"),
	caddyPath: z.string().default("").describe("caddy 路径（留空自动探测）"),
	notifyChannel: z.enum([
		"off",
		"webhook",
		"app"
	]).default("off").describe("飞书通知通道"),
	notifyAppId: z.string().default("").describe("飞书 App ID（app 通道）"),
	notifyOpenId: z.string().default("").describe("通知接收者 open_id（客户端页面有获取引导）"),
	passwordPolicy: z.enum([
		"full",
		"mask",
		"off"
	]).default("full").describe("URL 变化通知附带密码的档位（full 才能在换域后自救）")
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
const timers = /* @__PURE__ */ new Set();
const failCounts = /* @__PURE__ */ new Map();
const revealAt = /* @__PURE__ */ new Map();
function notifyText(policy) {
	if (policy === "full") return password;
	if (policy === "mask") return password.slice(0, 4) + "••••••••（完整密码见 DSH 页面密码卡）";
	return null;
}
function cardFor(title, color, bodyMd, url, note) {
	const elements = [{
		tag: "div",
		text: {
			tag: "lark_md",
			content: bodyMd
		}
	}];
	if (url) elements.push({
		tag: "action",
		actions: [{
			tag: "button",
			text: {
				tag: "plain_text",
				content: "打开 DSH"
			},
			url,
			type: "primary"
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
	if (!hook) throw new Error("webhook URL 未配置（客户端页面 → 通知）");
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
async function sendApp(card) {
	const appId = cfg.notifyAppId || "";
	const appSecret = await getSecret(APP_SECRET_REF);
	if (!appId || !appSecret) throw new Error("App ID / App Secret 未配置（客户端页面 → 通知）");
	if (!cfg.notifyOpenId) throw new Error("接收者 open_id 未配置");
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
	const sendJson = await (await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer " + tokenJson.tenant_access_token
		},
		body: JSON.stringify({
			receive_id: cfg.notifyOpenId,
			msg_type: "interactive",
			content: JSON.stringify(card)
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	})).json();
	if (sendJson.code !== 0) throw new Error("发送失败 code " + sendJson.code + "：" + (sendJson.msg || "unknown") + "（常见原因：应用缺 im:message 发消息权限）");
}
async function notify(ctx, event, url) {
	const channel = cfg.notifyChannel || "off";
	if (channel === "off") return;
	const [title, color] = {
		started: ["远程访问已开启", "green"],
		changed: ["访问地址已变化", "blue"],
		down: ["远程访问已断开", "red"],
		recovered: ["远程访问已恢复", "green"],
		test: ["测试通知", "grey"]
	}[event] ?? ["远程访问", "grey"];
	const tier = notifyText(cfg.passwordPolicy || "full");
	let bodyMd = event === "down" || event === "recovered" ? url ? "地址：" + url : "隧道进程已退出，正在自动恢复。" : "**访问地址**\n" + url;
	if (event === "started" || event === "changed" || event === "test") {
		if (tier === null) bodyMd += "\n密码：略（passwordPolicy=off）";
		else if (event !== "test") bodyMd += "\n**访问密码**：" + tier;
	}
	const card = cardFor(title, color, bodyMd, url, "dsh-remote · " + (/* @__PURE__ */ new Date()).toLocaleString("zh-CN"));
	try {
		if (channel === "webhook") await sendWebhook(card);
		else await sendApp(card);
		pushEvent(event, "通知已发送");
	} catch (e) {
		pushEvent(event, "通知失败：" + e.message);
		say(ctx, "warn", `[dsh-remote] notify failed: ${e.message}`);
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
	const body = b64url(Buffer.from(JSON.stringify({
		version: 1,
		authority,
		issuedAt: now,
		expiresAt: now + 6048e5
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
			if (origin) {
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
				const lockMsg = lock && lock.count >= LOGIN_MAX_FAILS && lock.until > Date.now() ? `<p style="color:#c00">失败次数过多，${Math.ceil((lock.until - Date.now()) / 1e3)}s 后重试</p>` : "";
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
				if (lock && lock.count >= LOGIN_MAX_FAILS && lock.until > Date.now()) {
					res.writeHead(429);
					res.end("locked");
					return;
				}
				if (timingSafeEq(String(new URLSearchParams(await readBody(req)).get("password") || ""), password)) {
					failCounts.delete(ip);
					const dsh = dshCookieParts(UPSTREAM_HOST);
					const cookies = [`rc_session=${sessionSecret}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`];
					if (dsh) cookies.push(`${dsh.name}=${dsh.value}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
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
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						running: !!cloudflaredChild?.pid && pidAlive(cloudflaredChild.pid),
						url: currentUrl,
						passwordMask: password.slice(0, 4) + "••••••••",
						policy: cfg.passwordPolicy || "full",
						channel: cfg.notifyChannel || "off",
						hasWebhook: !!await getSecret(WEBHOOK_REF),
						hasAppSecret: !!await getSecret(APP_SECRET_REF),
						openId: cfg.notifyOpenId || "",
						appId: cfg.notifyAppId || "",
						events
					}));
					return;
				}
				if (req.method === "POST" && path === "/rc-api/reveal") {
					const last = revealAt.get(ip) ?? 0;
					if (Date.now() - last < REVEAL_FREQ_MS) {
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
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
					return;
				}
				if (req.method === "POST" && path === "/rc-api/toggle") {
					const target = !cfg.enabled;
					try {
						ensureUserOverride(target);
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
				if (req.method === "POST" && path === "/rc-api/test") {
					if ((cfg.notifyChannel || "off") === "off") {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "通知通道未启用（设置表单里选 webhook 或 app）" }));
						return;
					}
					await notify(ctx, "test", currentUrl || null);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
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
function ensureUserOverride(enabled) {
	let s = readFileSync(PROFILE_PATCH, "utf8");
	const backup = s + `\n# (dsh-remote toggle backup ${Date.now()})\n`;
	writeFileSync(PROFILE_PATCH + ".bak-dsh-remote", backup);
	if (/- id: dsh-remote[\s\S]{0,240}?enabled:\s*(true|false)/.test(s)) s = s.replace(/(- id: dsh-remote[\s\S]{0,240}?enabled:\s*)(true|false)/, `$1${enabled}`);
	else s = s.replace(/\s*$/, "") + `\n- id: dsh-remote\n  config:\n    enabled: ${enabled}\n`;
	writeFileSync(PROFILE_PATCH, s);
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
function spawnCaddy(ctx, isAlive) {
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
		if (!isAlive()) return;
		pushEvent("down", "caddy 退出，5s 后自动重拉");
		timers.add(setTimeout(() => {
			if (isAlive()) spawnCaddy(ctx, isAlive);
		}, RESPAWN_DELAY_MS));
	});
}
function restartCaddy(ctx) {
	try {
		if (caddyChild?.pid) process.kill(caddyChild.pid);
	} catch {}
}
function spawnCloudflared(ctx, isAlive) {
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
			notify(ctx, changed ? "changed" : "started", m[0]);
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
		if (!isAlive()) return;
		pushEvent("down", "cloudflared 退出，5s 后自动重拉（quick tunnel 会自己死，事实 13）");
		notify(ctx, "down", currentUrl || null);
		timers.add(setTimeout(() => {
			if (isAlive()) spawnCloudflared(ctx, isAlive);
		}, RESPAWN_DELAY_MS));
	});
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
function apply(ctx, config = {}) {
	globalThis.__dshRemoteCtx = ctx;
	cfg = config;
	mkdirSync(RUN_DIR, { recursive: true });
	ctx.effect(() => {
		let dead = false;
		const isAlive = () => !dead;
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
			spawnCaddy(ctx, isAlive);
			spawnCloudflared(ctx, isAlive);
		};
		boot().catch((e) => {
			say(ctx, "error", "[dsh-remote] 启动失败：" + e.message);
			pushEvent("down", "启动失败：" + e.message);
		});
		return () => {
			dead = true;
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
