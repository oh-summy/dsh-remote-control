# Architecture · 架构设计

> For user-facing guide, see [README](../README.md). For implementation details, see
> [tech-notes.md](tech-notes.md).

## System overview

```
Browser ──HTTPS──▶ Cloudflare edge (Quick Tunnel: https://<random>.trycloudflare.com)
                        │  outbound-only connection, no inbound ports opened
                        ▼
                 cloudflared ──▶ Caddy (password gate, cookie session)
                        │  http://127.0.0.1:3080
                        ▼
                 DSH web profile (loopback only, zero modification)
```

## Components

| Component | File | Role |
|---|---|---|
| `up.sh` | `bin/up.sh` | Staged start (credentials → auth+Caddy → tunnel → gate verification) under a startup lock (`run/starting`) |
| `down.sh` | `bin/down.sh` | Per-component stop (identity-checked pids), SIGKILL escalation, final verification |
| `watchdog.sh` | `bin/watchdog.sh` | Resident guard: URL change / gate respawn (caddy/auth) / tunnel death → hands over to selfheal / upstream unreachability; active-standby election via atomic pid claim |
| `selfheal.sh` | `bin/selfheal.sh` | Self-heal executor: reruns `up.sh` with 30s→600s backoff (6 attempts); on total failure enters cooldown (`run/heal-failed`) and pages for manual `dsh-web start` |
| `auth-server.py` | `bin/auth-server.py` | Login page only (rate-limit + password check + issue cookie) |
| `notify-feishu.sh` | `bin/notify-feishu.sh` | Feishu card + plain-text password message |
| `status.sh` | `bin/status.sh` | Component status + runtime flags (`starting`/`heal-failed`/`stopped`) + gate/upstream health |
| `install.sh` | `scripts/install.sh` | Download official binaries, init config, link CLI |
| `rotate-password.sh` | `scripts/rotate-password.sh` | Rotate access password, restart if running |

## Tunnel modes

### Quick Tunnel (default)
- Random URL on every start: `https://<random>.trycloudflare.com`
- No Cloudflare account required
- Feishu notification required to receive the URL

### Named Tunnel (optional)
- Fixed domain: `https://dsh.example.com`
- Requires Cloudflare account + DNS control
- Setup: `dsh-web tunnel-setup` or manual steps in README
- Config: set `RC_TUNNEL_NAME` + `RC_TUNNEL_HOSTNAME` in `rc.env`

## Data flow

1. **Start**: `up.sh` takes the `run/starting` lock (watchdog observes only while held) → checks
   credentials → starts auth-server + Caddy → starts cloudflared → waits for URL → verifies local
   gate (302) + auth (200) → clears `run/heal-failed` → starts watchdog (skipped if already
   running) → pushes Feishu card
2. **Runtime**: watchdog monitors cloudflared PID, gate components, URL changes, and upstream
   reachability every 30s; respawns dead gate components in place (URL unchanged); hands a dead
   tunnel to `selfheal.sh`; rotates logs when they exceed 1MB (keeps 5 backups)
3. **Self-heal**: `selfheal.sh` reruns `up.sh` with backoff (30s→600s, 6 attempts); a manual
   `dsh-web stop` wins at any point (`run/stopped` checked before and during each attempt); after
   total failure the watchdog cools down until the next successful `dsh-web start`
4. **Stop**: `down.sh` kills each component by identity-checked PID (kills selfheal's child
   `up.sh` first) → SIGKILL leftovers → verifies port release; the resident watchdog exits only
   when `run/stopped` exists
5. **Autostart**: `dsh-web autostart` installs a launchd plist on macOS that guards
   `watchdog.sh` with `KeepAlive` — the chain comes up at boot through the watchdog/selfheal
   path, and a killed watchdog is respawned by launchd

## Security model

- **Password**: 128-bit random, stored locally with `600` permissions
- **Session**: Cookie = token from `session.secret` (256-bit), verified by Caddy internally
- **Rate limit**: 5 failed attempts → IP locked for 5 minutes (HTTP 429)
- **Cookie attributes**: `HttpOnly` + `SameSite=Lax`, 7-day expiry
- **Host/Origin rewrite**: Caddy rewrites headers to upstream address so DSH's browser-trust fence
  passes regardless of tunnel domain (see [tech-notes.md](tech-notes.md) §2.3)

## Design decisions

For the reasoning behind each decision (why Caddy over Basic Auth, why Quick Tunnel, etc.),
see [product-design.md](product-design.md) §6.

Key principles:
1. **Zero DSH coupling** — the chain only talks HTTP to `127.0.0.1:3080`; no DSH internal APIs
2. **Reuse mature components** — Caddy for auth/proxy, cloudflared for tunnel; no custom crypto
3. **Platform differences isolated** — only `install.sh` and service unit files contain platform logic
