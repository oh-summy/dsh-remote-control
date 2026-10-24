// @oh-summy/dsh-remote — M1: cloudflared quick-tunnel lifecycle only (no UI, no gate).
// Lean by design: node builtins only, one module. See docs/dsh-plugin-design.md.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RUN_DIR = join(homedir(), ".remote-control", "run-plugin");
const UPSTREAM = "http://127.0.0.1:3080";
const URL_TIMEOUT_MS = 45_000;

export interface Config {
  enabled?: boolean;
  cloudflaredPath?: string;
}

function say(ctx: any, method: "info" | "warn", msg: string) {
  const logger = ctx.logger;
  if (logger && typeof logger[method] === "function") logger[method](msg);
  else if (method === "warn") console.warn(msg);
  else console.log(msg);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findBinary(config: Config): string {
  const candidates = [config.cloudflaredPath, join(homedir(), ".remote-control", "bin", "cloudflared")];
  for (const p of candidates) if (p && existsSync(p)) return p;
  return "cloudflared";
}

export function apply(ctx: any, config: Config = {}) {
  if (!config.enabled) return; // idle: bundle installed but switched off

  mkdirSync(RUN_DIR, { recursive: true });
  const pidFile = join(RUN_DIR, "cloudflared.pid");
  const logFile = join(RUN_DIR, "cloudflared.log");
  const urlFile = join(RUN_DIR, "url");

  // residue: a live pid from a previous run means the tunnel is already up (idempotent enable)
  if (existsSync(pidFile)) {
    const prev = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isFinite(prev) && prev > 0 && pidAlive(prev)) {
      say(ctx, "info", `[dsh-remote] cloudflared already running (pid ${prev}), reusing`);
      return;
    }
    rmSync(pidFile);
  }

  // lifecycle wrapped in ctx.effect: setup runs now, the returned disposer runs on
  // fiber teardown (recomposition/disable/uninstall). ctx.on("dispose") never fires
  // in this cordis version — official plugins all use ctx.effect (fact 14).
  ctx.effect(() => {
    writeFileSync(logFile, ""); // fresh log: the URL grep must only see this run
    const out = openSync(logFile, "a");
    const bin = findBinary(config);
    const child: ChildProcess = spawn(
      bin,
      ["tunnel", "--url", UPSTREAM, "--no-autoupdate", "--protocol", "http2"],
      { stdio: ["ignore", out, out] },
    );
    if (!child.pid) throw new Error("[dsh-remote] failed to spawn cloudflared at " + bin);
    writeFileSync(pidFile, String(child.pid));
    say(ctx, "info", `[dsh-remote] cloudflared spawning (pid ${child.pid}, binary: ${bin})`);

    const startedAt = Date.now();
    const timer = setInterval(() => {
      const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearInterval(timer);
        writeFileSync(urlFile, m[0] + "\n");
        say(ctx, "info", `[dsh-remote] tunnel up: ${m[0]} -> ${UPSTREAM}`);
      } else if (Date.now() - startedAt > URL_TIMEOUT_MS) {
        clearInterval(timer);
        say(ctx, "warn", `[dsh-remote] no trycloudflare URL within 45s — see ${logFile}`);
      }
    }, 2000);

    return () => { // disposer: runs on fiber teardown
      clearInterval(timer);
      try { if (child.pid) process.kill(child.pid); } catch { /* already gone */ }
      for (const f of [pidFile, urlFile]) { try { rmSync(f); } catch { /* absent */ } }
      try { closeSync(out); } catch { /* closed */ }
      say(ctx, "info", "[dsh-remote] cloudflared stopped, state cleaned");
    };
  });
}
