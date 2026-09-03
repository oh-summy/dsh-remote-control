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
| `up.sh` | `bin/up.sh` | Staged start: credentials → auth+Caddy → tunnel → gate verification |
| `down.sh` | `bin/down.sh` | Per-component stop, SIGKILL escalation, final verification |
| `watchdog.sh` | `bin/watchdog.sh` | Detects URL change / tunnel death / upstream unreachability |
| `auth-server.py` | `bin/auth-server.py` | Login page only (rate-limit + password check + issue cookie) |
| `notify-feishu.sh` | `bin/notify-feishu.sh` | Feishu card + plain-text password message |
| `status.sh` | `bin/status.sh` | Component status + gate/upstream health |
| `install.sh` | `scripts/install.sh` | Download official binaries, init config, link CLI |

## Data flow

1. **Start**: `up.sh` checks credentials → starts auth-server + Caddy → starts cloudflared →
   waits for URL → verifies local gate (302) + auth (200) → starts watchdog → pushes Feishu card
2. **Runtime**: watchdog monitors cloudflared PID, URL changes, and upstream reachability every 30s
3. **Stop**: `down.sh` kills each component by PID → SIGKILL leftovers → verifies port release

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
