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

## Fleet Comms — Central Server Live on Mini

**Updated:** 2026-02-21
**Status:** Mini M4 is running the central NATS + WebSocket relay. DGX is connected via Tailscale WebSocket but has no agent-daemon to respond to messages.

### Fleet Tailscale Network

| Device | Tailscale IP | Role |
|--------|-------------|------|
| Mini (Mac Mini M4) | 100.113.140.45 | **Central NATS server** |
| M5 (MacBook Pro) | 100.109.27.49 | Client (setting up) |
| DGX (DGX Spark) | 100.72.55.109 | Client (WebSocket connected, no agent-daemon) |

### Mini Central Services

| Service | Port | Status |
|---------|------|--------|
| NATS Server | 4222 | Running (launchd, KeepAlive) |
| NATS Monitoring | 8222 | Running |
| WebSocket Relay | 3100 | Running (launchd, KeepAlive) |
| Agent HTTP API | 3102 | Running |
| Agent Daemon | — | Running (launchd, KeepAlive) |

### DGX: Set Up Your Agent Daemon

DGX — you're connected to the WebSocket relay (we can see your Tailscale IP in the logs) but you need an agent-daemon running so you can respond to fleet messages. Here's what to do:

**1. Create a `.env` for the agent-daemon on DGX:**

```bash
# In your noesis-ship/adapters/websocket/ directory:
cat > .env.daemon <<'EOF'
BRIDGE_URL=ws://100.113.140.45:3100
PROJECT_DIR=/home/hankh959/projects/nusy-product-team
CLAUDE_BIN=/path/to/your/claude
AGENT_NAME=DGX
MAX_TURNS=10
EOF
```

Find your `claude` binary path: `which claude` or check `ps aux | grep claude` while a session is running.

**2. Run the agent-daemon:**

```bash
cd /home/hankh959/projects/noesis-ship/adapters/websocket
# Copy .env.daemon fields into your .env or export them
node agent-daemon.js
```

**3. For persistence (systemd on DGX):**

```ini
# /etc/systemd/user/noesis-ship-agent-daemon.service
[Unit]
Description=Noesis Ship Agent Daemon (DGX)
After=network-online.target

[Service]
ExecStart=/usr/bin/node /home/hankh959/projects/noesis-ship/adapters/websocket/agent-daemon.js
WorkingDirectory=/home/hankh959/projects/noesis-ship/adapters/websocket
Environment=BRIDGE_URL=ws://100.113.140.45:3100
Environment=PROJECT_DIR=/home/hankh959/projects/nusy-product-team
Environment=CLAUDE_BIN=/path/to/your/claude
Environment=AGENT_NAME=DGX
Environment=MAX_TURNS=10
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now noesis-ship-agent-daemon
```

**4. Test by sending a message back:**

```bash
curl -s -X POST http://100.113.140.45:3102/message \
  -H "Content-Type: application/json" \
  -d '{"group":"fleet","from":"DGX","message":"DGX reporting in. Agent daemon operational."}'
```

**Note:** You do NOT need your own NATS server. Mini is the central hub — all agents connect to Mini's WebSocket relay at `ws://100.113.140.45:3100`. The relay handles NATS pub/sub internally.

### M5: Setup Instructions Coming

M5 — same pattern as DGX but with launchd (macOS). When you're ready, the setup is:
- `BRIDGE_URL=ws://100.113.140.45:3100`
- `AGENT_NAME=M5`
- `PROJECT_DIR=/Users/hankh95/Projects/nusy-product-team`
- Find your claude binary and set `CLAUDE_BIN`

---

## Context Notes

- **Architecture:** NATS core (Python) + WebSocket adapter (Node.js) + agent daemon + MCP server
- **DGX:** noesis-ship deployed with 3 systemd services (will reconfigure to point to Mini)
- **M5:** Running noesis-ship locally (will reconfigure to point to Mini)
- **Ships Comm:** iOS/CarPlay voice app, protocol-compatible with noesis-ship (zero code changes)
- **Wire protocol:** Same as old carclaw-bridge — JSON over WebSocket
