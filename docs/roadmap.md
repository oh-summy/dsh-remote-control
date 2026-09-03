# Roadmap · 路线图

> For what each milestone includes, see [product-design.md](product-design.md) §7.

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| **M0** Project init | ✅ Done | Product design, repo setup |
| **M1** Mac remote access | ✅ Done | Tunnel + password gate + Feishu notifications + watchdog + stop verification |
| **M2** Mac stability | 🔧 In progress | Staged start, gate verification, watchdog gate detection done. Remaining: launchd autostart, Named Tunnel, rotate-password.sh, log rotation |
| **M3** Linux/VPS | ⏳ Planned | systemd units, VPS acceptance |
| **M4** DSH plugin | ⏳ Planned | Plugin package, Notifier interface |

## M1 acceptance criteria (all passed)

1. ✅ Mobile network (non-Wi-Fi) → quick URL → login → DSH UI fully usable
2. ✅ Streaming (WebSocket/SSE) ≥ 10 minutes without interruption
3. ✅ DSH restart → proxy layer auto-recovers, zero changes
4. ✅ 5 failed password attempts → rate limited
5. ✅ Memory overhead ≤ 30MB (cloudflared + caddy)
6. ✅ `down.sh` stops all components, `status.sh` reports all states

## M2 remaining items

- [ ] launchd autostart (plist)
- [ ] Named Tunnel fixed domain
- [ ] `rotate-password.sh` command
- [ ] Log rotation
- [ ] install.sh idempotency on clean environment

## Current focus

Docs reorganization + code cleanup (this branch). After merge, M2 remaining items.
