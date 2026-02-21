# Noesis Ship Active Context

**Updated:** 2026-02-21
**Last Agent:** M5

---

## Current Position

**Repository:** hankh95/noesis-ship
**Status:** EXP-010 centralization — Mini executing Phase 1

### Active Work

**EXP-010: Centralize noesis-ship on Mini M4**
- **Status:** In progress — Mini is setting up as central server
- **Assignee:** Mini agent
- **What:** One central NATS server on Mini, all agents connect via Tailscale
- **Expedition:** `kanban-work/expeditions/EXP-010-Centralize-noesis-ship-One-NATS-server-for-fleet-c.md`

**FEAT-016: Cloudflare Tunnel (Invisible Remote Connectivity)**
- **Status:** Code complete, not yet deployed
- **What:** `wss://ship.congruentsys.com` relay URL, auto-discovered by Ships Comm
- **Server:** `RELAY_URL` env var in server.js status payload
- **Installer:** `scripts/install-cloudflared.sh`
- **Config template:** `config/cloudflared/config.yml`

**EXP-009: Kanban NATS webhook**
- **Status:** PR #3 open, ready to merge
- **Branch:** `exp-009-kanban-nats-webhook`

### Completed Expeditions

| Expedition | Status | Notes |
|------------|--------|-------|
| EXP-001 | done | NATS ↔ WebSocket relay (PR #1 merged) |
| EXP-002 | done | CLAUDE.md (merged to main) |
| EXP-003 | done | DGX deployment docs (PR #2 merged) |
| EXP-009 | review | Kanban NATS webhook (PR #3 open) |
| EXP-010 | in-progress | Centralize on Mini M4 |

---

## Mini Setup Instructions (EXP-010 Phase 1)

**Config files now available:**
- `config/launchd/com.congruentsystems.nats.plist` — NATS server
- `config/launchd/com.congruentsystems.noesis-ship-websocket.plist` — WebSocket relay
- `config/launchd/com.congruentsystems.noesis-ship-agent-daemon.plist` — Agent daemon
- `config/nats-server.conf` — NATS server config (replace `__HOME__` placeholders)

**Prerequisites:**
```bash
brew install nats-server
brew install node  # if not installed
```

**Quick start:**
```bash
git clone https://github.com/hankh95/noesis-ship.git
cd noesis-ship/adapters/websocket && npm install
# Create .env (see EXP-010 expedition for template)
# Replace __HOME__ in config files with actual home dir
# Replace __MACHINE__ with machine name (e.g., Mini)
nats-server -c ../../config/nats-server.conf &
node server.js
```

**After services are running:**
1. Get Tailscale IP: `tailscale ip -4`
2. Share IP with DGX and M5 so they can reconfigure their agent-daemons
3. Test: Ships Comm connects to Mini's bridge URL

---

## Context Notes

- **Architecture:** NATS core (Python) + WebSocket adapter (Node.js) + agent daemon + MCP server
- **DGX:** noesis-ship deployed with 3 systemd services (will reconfigure to point to Mini)
- **M5:** Running noesis-ship locally (will reconfigure to point to Mini)
- **Ships Comm:** iOS/CarPlay voice app, protocol-compatible with noesis-ship (zero code changes)
- **Wire protocol:** Same as old carclaw-bridge — JSON over WebSocket
