# dsh-remote-control

[English](README.md) | [中文](README.zh-CN.md)

Secure remote access for **DeepSeek Harness (DSH)** running on your own Mac or Linux server:
**Cloudflare Tunnel → password gate → DSH**, with **Feishu (Lark) notifications** pushed to your
phone whenever the entry URL or service state changes.

```
Browser ──HTTPS──▶ Cloudflare edge (Quick Tunnel: https://<random>.trycloudflare.com)
                        │  outbound-only connection, no inbound ports opened
                        ▼
                 cloudflared ──▶ Caddy (password gate, cookie session)
                        │  http://127.0.0.1:3080
                        ▼
                 DSH web profile (loopback only, zero modification)
```

## Why

- **No inbound ports** — the machine only makes outbound connections through the tunnel.
- **Password gate in front of DSH** — login page + signed session cookie (7 days), per-IP
  lockout after 5 failed attempts. DSH itself stays untouched.
- **Feishu notifications are a necessity, not a nice-to-have** — Quick Tunnel assigns a *new random
  URL on every start*; without a push channel you lose the entry. Every `start` / URL change /
  failure / recovery is pushed as a card message, plus a separate copy-friendly password message.
- **Survives DSH upgrades** — the chain only talks HTTP to `127.0.0.1:3080`; no DSH internal APIs
  are used. `Host`/`Origin` are rewritten at the proxy so DSH's browser-trust fence keeps passing
  even though the tunnel host changes on every restart.

## Quick start

Requirements: macOS (x86_64 / arm64) or Linux (x86_64 / arm64), `curl`, `python3`.
Windows is not officially supported — PRs welcome with real test evidence.

```bash
git clone https://github.com/oh-summy/dsh-remote-control.git
cd dsh-remote-control
scripts/install.sh     # downloads official cloudflared/caddy binaries, generates password
```

Then edit `~/.remote-control/rc.env` and set `RC_FEISHU_OPEN_ID` (your Feishu open id, `ou_...`),
and make sure a bot of your Feishu app can DM you. Start everything:

```bash
dsh-web start
```

`start` prints the URL and password, returns to the shell, and pushes a card + password to your
Feishu DM. Open the URL, enter the password once — the cookie lasts 7 days.

## Commands

| Command | Purpose |
|---|---|
| `dsh-web start` | Start the chain, print URL + password (Feishu notified) |
| `dsh-web stop` | Stop everything |
| `dsh-web restart` | Restart (URL changes; new card is pushed) |
| `dsh-web status` | Component status + gate/upstream health |
| `dsh-web logs [caddy\|cloudflared\|auth\|watchdog\|notify\|all]` | Tail logs |
| `dsh-web password` | Print the access password |
| `dsh-web url` | Print the current entry URL |
| `dsh-web install` | Install / repair (binaries, config, credentials, CLI link) |

## Configuration — `~/.remote-control/rc.env`

| Variable | Default | Meaning |
|---|---|---|
| `RC_UPSTREAM` | `127.0.0.1:3080` | Upstream service to protect (any local HTTP service, not just DSH) |
| `RC_LISTEN` | `127.0.0.1:4080` | Caddy listen address (loopback only) |
| `RC_FEISHU_OPEN_ID` | — | Feishu open id for bot DM (primary channel) |
| `RC_FEISHU_WEBHOOK` | — | Group custom-bot webhook (fallback channel) |
| `RC_NOTIFY_PASSWORD` | `full` | `full` = password pushed as its own message; `mask` = last 4 chars only |

Runtime data (password, token, logs) lives in `~/.remote-control/` with `600` permissions and
never enters git.

## Platform support

| Platform | Status |
|---|---|
| macOS x86_64 / arm64 | ✅ developed & verified here |
| Linux x86_64 / arm64 (Ubuntu/Debian first) | ✅ same installer, systemd units planned (M3) |
| Windows | ❌ not officially supported; PRs welcome with real test evidence |

## Security notes

- DSH keeps binding to `127.0.0.1` only; the only public surface is the Cloudflare edge behind
  the password gate.
- Password: 128-bit random, bcrypt-hashed files kept locally; failed logins lock the source IP
  for 5 minutes (HTTP 429).
- Session cookie is `HttpOnly` + `SameSite=Lax`, valid 7 days; rotate everything with
  `dsh-web restart` after editing `~/.remote-control/session.secret` / regenerating the password.
- Never commit `rc.env`, `password`, `session.secret` or rendered `Caddyfile` — `.gitignore`
  already covers them; CI plus review keep it that way.

## Roadmap

- [x] M1 — macOS: tunnel + password gate + Feishu card notifications, verified end-to-end
- [ ] M2 — launchd autostart, fixed domain (Named Tunnel), password rotation command
- [ ] M3 — Linux/VPS: systemd units, apt/dnf paths, POSIX-compat audit, real-VPS acceptance
- [ ] M4 — package as a DSH plugin (`dsh plugin --profile web add`), notifier interface

Design decisions and field notes (in Chinese): [docs/product-design.md](docs/product-design.md),
[docs/tech-notes.md](docs/tech-notes.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: CI must pass (`shellcheck` + syntax checks),
scripts stay bash-3.2/POSIX compatible, platform-specific changes come with real test evidence.

## License

[MIT](LICENSE) © 2026 Summy Wu (oh-summy)
