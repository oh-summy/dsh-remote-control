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
  are used.

## Quick start

Requirements: macOS (x86_64 / arm64) or Linux (x86_64 / arm64), `curl`, `python3`.
Windows is not officially supported — PRs welcome with real test evidence.

```bash
git clone https://github.com/oh-summy/dsh-remote-control.git
cd dsh-remote-control
scripts/install.sh     # downloads official cloudflared/caddy binaries, generates password
```

Prerequisite: the DSH web profile must already be running on `127.0.0.1:3080` (start it yourself
with `dsh web`) — `dsh-web` manages the gateway only and never starts/stops DSH.

Then edit `~/.remote-control/rc.env`:

- **Primary notification channel (bot DM):** set `RC_FEISHU_OPEN_ID` (your open id, `ou_...`).
  Requires [`lark-cli`](https://github.com/larksuite/cli) installed and configured with your
  Feishu app (`lark-cli config init`); the app's bot needs IM permission and must be able to
  DM you.
- **Fallback channel:** set `RC_FEISHU_WEBHOOK` (group custom-bot webhook) — works without
  lark-cli. If both are set, DM is used and webhook only on failure.

Start everything:

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
- Password: 128-bit random, stored locally with `600` permissions; failed logins lock the
  source IP for 5 minutes (HTTP 429).
- Session cookie is `HttpOnly` + `SameSite=Lax`, valid 7 days. To rotate: regenerate the
  password (`scripts/gen-password.sh`) and/or edit `~/.remote-control/session.secret`, then
  `dsh-web restart`.
- Never commit `rc.env`, `password`, `session.secret` or rendered `Caddyfile` — `.gitignore`
  already covers them; CI plus review keep it that way.

## Architecture

For system architecture, design decisions, and component interaction, see [docs/architecture.md](docs/architecture.md).

## Roadmap

For milestone progress and what's next, see [docs/roadmap.md](docs/roadmap.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) · [中文版](CONTRIBUTING.zh-CN.md). In short: CI must pass (`shellcheck` + syntax checks),
scripts stay bash-3.2/POSIX compatible, platform-specific changes come with real test evidence.

## License

[MIT](LICENSE) © 2026 Summy Wu (oh-summy)