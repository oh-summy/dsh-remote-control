# Roadmap · 路线图

> For what each milestone includes, see [product-design.md](product-design.md) §7.

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| **M0** Project init | ✅ Done | Product design, repo setup |
| **M1** Mac remote access | ✅ Done | Tunnel + password gate + Feishu notifications + watchdog + stop verification |
| **M2** Mac stability | ✅ Done | Staged start, gate verification, watchdog, launchd autostart, Named Tunnel, rotate-password.sh, log rotation |
| **M3** Linux/VPS | ⏳ Planned | systemd units, VPS acceptance |
| **M4** DSH plugin | ⏳ Planned | Plugin package, Notifier interface |

## M1 acceptance criteria (all passed)

1. ✅ Mobile network (non-Wi-Fi) → quick URL → login → DSH UI fully usable
2. ✅ Streaming (WebSocket/SSE) ≥ 10 minutes without interruption
3. ✅ DSH restart → proxy layer auto-recovers, zero changes
4. ✅ 5 failed password attempts → rate limited
5. ✅ Memory overhead ≤ 30MB (cloudflared + caddy)
6. ✅ `down.sh` stops all components, `status.sh` reports all states

## M2 completed items

- [x] launchd autostart (plist) — `dsh-web autostart [off]`
- [x] Named Tunnel fixed domain — set `RC_TUNNEL_NAME` + `RC_TUNNEL_HOSTNAME` in rc.env
- [x] `rotate-password.sh` command — `dsh-web rotate-password`
- [x] Log rotation — automatic in watchdog (1MB threshold, 5 backups)
- [x] install.sh idempotency on clean environment — safe to re-run, `--force` to reinstall binaries

## Current focus

M2 completed. Next: M3 Linux/VPS support (systemd units, VPS acceptance).