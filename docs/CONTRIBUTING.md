# Contributing

[中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest in `dsh-remote-control`!

## Architecture overview

Before contributing, it helps to understand the system:

```
Browser ──HTTPS──▶ Cloudflare edge (Quick Tunnel)
                        │
                        ▼
                 cloudflared ──▶ Caddy (password gate)
                        │  http://127.0.0.1:3080
                        ▼
                 DSH web profile (loopback only)
```

- `bin/up.sh` — staged start (credentials → auth+Caddy → tunnel → gate verification)
- `bin/down.sh` — per-component stop + final verification
- `bin/watchdog.sh` — monitors URL change / tunnel death / upstream health
- `bin/auth-server.py` — login page only (rate-limit + password check + cookie)
- `bin/notify-feishu.sh` — Feishu card + plain-text password
- `bin/status.sh` — component status + health checks
- `scripts/install.sh` — downloads official binaries, inits config

For detailed architecture, see [docs/architecture.md](docs/architecture.md).

## Ground Rules

1. **CI must pass.** Every PR runs `shellcheck` (all shell scripts, `bin/dsh-web` included),
   `bash -n`, and `python3 -m py_compile`. No warnings tolerated on new code.
2. **bash 3.2 / POSIX compatibility is mandatory.** macOS still ships bash 3.2; do not use
   bash-4+ features (associative arrays, `${var,,}`, `mapfile`, ...).
3. **Platform evidence.** Changes touching platform-specific behavior (macOS, Linux distros,
   or Windows) must come from a real machine — include OS version, architecture, and what you
   ran. Windows PRs are accepted only with real test evidence since CI cannot cover it.
4. **Secrets never enter git.** Do not commit (or paste in issues) passwords, tokens,
   `rc.env`, `session.secret`, rendered `Caddyfile`, or your own `open_id` / entry URLs.
5. **One PR, one concern.** Keep diffs reviewable; squashed commits are welcome.
6. **Changes land via PR review** — direct pushes to `main` are not allowed (branch protection
   requires the `lint` check and a review).

## Workflow

```bash
git clone https://github.com/oh-summy/dsh-remote-control.git
cd dsh-remote-control
# optional but recommended: local shellcheck before pushing
shellcheck bin/*.sh scripts/*.sh bin/dsh-web && python3 -m py_compile bin/auth-server.py
git checkout -b feat/your-feature
# ... develop ...
git push -u origin feat/your-feature   # then open a PR against main
```

CI runs on `push` and `pull_request`; the `lint` check is required by branch protection.

## Reporting bugs

Include: OS + arch, `dsh-web status` output (it contains no secrets), the relevant file from
`dsh-web logs <component>`, and what you expected vs. what happened.