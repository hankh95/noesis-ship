# Noesis Ship Active Context

**Updated:** 2026-02-21
**Last Agent:** M5

---

## Current Position

**Repository:** hankh95/noesis-ship
**Status:** ✅ EXP-010 Phase 2 Complete (ALL AGENTS CONNECTED) — Phase 3 Testing Next

### Infrastructure Update — EXP-010 Centralization

**Status:** Phase 2 complete (Mini ✅, DGX ✅, M5 ✅) — Phase 3 testing next

**Architecture Change:** Moving from distributed NATS (each machine runs its own) to centralized NATS (one central server, all agents connect remotely)

**Central Server:**
- **Machine:** Mini (Mac Mini M4)
- **Tailscale IP:** `100.113.140.45`
- **Services Running:**
  - NATS server: `nats://100.113.140.45:4222`
  - WebSocket adapter: `ws://100.113.140.45:3100`
  - Agent-daemon: Connected to localhost

**Phase 1 — Mini Setup (✅ COMPLETE):**
- Mini is now the central NATS server
- NATS + WebSocket adapter running via launchd
- Mini agent-daemon connected to localhost:3100
- All services confirmed running and healthy

**Phase 2 — Agent Reconfiguration:**
- **DGX (✅ COMPLETE):** Agent-daemon → `ws://100.113.140.45:3100`
  - Local NATS/WebSocket stopped and disabled
  - Systemd service updated and running
  - Verified connection via logs: "Connected to bridge at ws://100.113.140.45:3100"
- **M5 (✅ COMPLETE):** Agent-daemon → `ws://100.113.140.45:3100`
  - Local WebSocket relay stopped and unloaded
  - New agent-daemon plist created and loaded
  - MCP config updated to point to Mini
  - Verified connection via logs: "Connected to bridge at ws://100.113.140.45:3100"
  - Test message sent via HTTP API: "M5 reporting in"

**Phase 3 — Testing (⏳ READY):**
- NATS pub/sub test across all machines
- Ships Comm iOS app voice testing
- Verify fleet coordination (#fleet, #m5, #dgx, #mini channels)

See [EXP-010](https://github.com/hankh95/noesis-ship/blob/main/kanban-work/expeditions/EXP-010-Centralize-noesis-ship-One-NATS-server-for-fleet-c.md) for full expedition details.

### Active Work

**EXP-010: Centralize noesis-ship on Mini M4**
- **Status:** Phase 2 in progress — Mini ✅ + DGX ✅, M5 pending
- **Assignee:** Multi-agent (Mini complete, DGX complete, M5 next)
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
| EXP-010 | in-progress | Centralize on Mini M4 (Phase 2: Mini ✅, DGX ✅, M5 pending) |

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
**Status:** Mini M4 is running the central NATS + WebSocket relay. DGX agent-daemon is connected and operational. M5 setup pending.

### Fleet Tailscale Network

| Device | Tailscale IP | Role | Status |
|--------|-------------|------|--------|
| Mini (Mac Mini M4) | 100.113.140.45 | **Central NATS server** | ✅ Running |
| DGX (DGX Spark) | 100.72.55.109 | Client | ✅ Connected |
| M5 (MacBook Pro) | 100.109.27.49 | Client | ✅ Connected |

### Mini Central Services

| Service | Port | Status |
|---------|------|--------|
| NATS Server | 4222 | Running (launchd, KeepAlive) |
| NATS Monitoring | 8222 | Running |
| WebSocket Relay | 3100 | Running (launchd, KeepAlive) |
| Agent HTTP API | 3102 | Running |
| Agent Daemon | — | Running (launchd, KeepAlive) |

### M5: Setup Instructions

M5 — you're next! Same pattern as DGX but with launchd (macOS). Here's what to do:

**1. Update your agent-daemon launchd plist:**

File: `~/Library/LaunchAgents/com.congruentsystems.noesis-ship-agent-daemon.plist`

Change the `BRIDGE_URL` environment variable:
```xml
<key>EnvironmentVariables</key>
<dict>
    <key>BRIDGE_URL</key>
    <string>ws://100.113.140.45:3100</string>
    <key>AGENT_NAME</key>
    <string>M5</string>
    <key>PROJECT_DIR</key>
    <string>/Users/hankh95/Projects/nusy-product-team</string>
    <key>CLAUDE_BIN</key>
    <string>/path/to/your/claude</string>
    <key>MAX_TURNS</key>
    <string>10</string>
</dict>
```

**2. Stop local NATS/WebSocket services (if running):**

```bash
launchctl unload ~/Library/LaunchAgents/com.congruentsystems.nats.plist
launchctl unload ~/Library/LaunchAgents/com.congruentsystems.noesis-ship-websocket.plist
# Optionally disable them so they don't auto-start
```

**3. Restart agent-daemon:**

```bash
launchctl unload ~/Library/LaunchAgents/com.congruentsystems.noesis-ship-agent-daemon.plist
launchctl load ~/Library/LaunchAgents/com.congruentsystems.noesis-ship-agent-daemon.plist
```

**4. Verify connection:**

Check logs to confirm connection to Mini's central server.

**Note:** You do NOT need your own NATS server. Mini is the central hub — all agents connect to Mini's WebSocket relay at `ws://100.113.140.45:3100`.

---

## Agent-to-Agent Comms — Now Live (Pull Required!)

**Updated:** 2026-02-21 by Mini
**File changed:** `adapters/websocket/agent-daemon.js`
**Action required:** DGX and M5 — `git pull origin main` and restart your agent-daemon.

### What Changed

The agent-daemon previously only responded to human/CarClaw messages (`fromId === "carclaw:user"`). It now supports **full agent-to-agent messaging** via NATS.

### Message Routing Rules

| Message Type | `fromId` | `to` field | Daemon Action |
|-------------|----------|------------|---------------|
| Human message | `carclaw:user` | any | **Respond** (always) |
| Directed agent message | `agent:mini` | `DGX` | **Respond** (addressed to me) |
| Undirected agent broadcast | `agent:mini` | (none) | **Ignore** (loop prevention) |
| Own message | `agent:dgx` | any | **Ignore** (echo prevention) |

### How to Send Agent-to-Agent Messages

```bash
# Mini asks DGX a question (DGX daemon will respond)
curl -s -X POST http://localhost:3102/message \
  -H "Content-Type: application/json" \
  -d '{"group":"fleet","from":"Mini","message":"What GPU memory is available?","to":"DGX"}'

# DGX asks Mini a question (Mini daemon will respond)
curl -s -X POST http://100.113.140.45:3102/message \
  -H "Content-Type: application/json" \
  -d '{"group":"fleet","from":"DGX","message":"How many beings are trained?","to":"Mini"}'

# Broadcast to fleet (NO agent auto-responds — only humans see it)
curl -s -X POST http://100.113.140.45:3102/message \
  -H "Content-Type: application/json" \
  -d '{"group":"fleet","from":"Mini","message":"Training complete for santiago-toddler-v12.1"}'
```

### Loop Prevention

The key design decision: **undirected agent broadcasts are ignored by daemons.** This prevents:
- Agent A sends to fleet → Agent B responds → Agent A responds to that → infinite loop

Only **directed messages** (`"to": "DGX"`) trigger a daemon response. The reply is also directed back to the original sender, so it doesn't cascade.

### Restart Instructions

After `git pull origin main`:

**DGX:**
```bash
systemctl --user restart noesis-ship-agent-daemon
```

**M5:**
```bash
launchctl unload ~/Library/LaunchAgents/com.congruentsystems.noesis-ship-agent-daemon.plist
launchctl load ~/Library/LaunchAgents/com.congruentsystems.noesis-ship-agent-daemon.plist
```

---

## Recent Voyages

### 2026-02-21 — Mini — Agent-to-Agent Comms Fix

**What was completed:**
- Expanded agent-daemon.js message filter from human-only to human + directed agent messages
- Added loop prevention (ignore undirected agent broadcasts, ignore own messages)
- Agent responses to other agents are directed back (`to` field) to prevent cascade
- Renamed `handleCarClawMessage` → `handleMessage`, updated `fromId` to use agent name
- Updated header docs to describe the new routing rules

**Files modified:**
- `adapters/websocket/agent-daemon.js`
- `kanban-work/expeditions/EXP-010-*.md` (status → in-progress)
- `claude-workspace/ACTIVE-CONTEXT.md` (this file)

**What next session should do:**
- DGX + M5: `git pull` and restart agent-daemons to pick up the change
- Test: Mini sends directed message to DGX, verify DGX daemon responds
- Test: Agent broadcast does NOT trigger daemon responses (loop prevention)

---

### 2026-02-21 — DGX — EXP-010 Phase 2 Complete ✅

**What was completed:**
1. **DGX Phase 2:** Connected to Mini's central server
   - Updated `~/.config/systemd/user/noesis-ship-agent-daemon.service`
   - Changed `BRIDGE_URL=ws://100.113.140.45:3100`
   - Stopped and disabled local NATS/WebSocket services:
     - `systemctl --user stop nats-server noesis-ship-websocket`
     - `systemctl --user disable nats-server noesis-ship-websocket`
   - Reloaded systemd and restarted agent-daemon
   - Verified connection: "Connected to bridge at ws://100.113.140.45:3100"

**Key decisions:**
- Test centralized architecture on existing Mini M4 (no new hardware purchase)
- Mini serves as central server ($0 cost vs $600 for new hardware)
- Agent-daemons connect via Tailscale for security

**Files modified:**
- DGX: `~/.config/systemd/user/noesis-ship-agent-daemon.service`
- noesis-ship: `claude-workspace/ACTIVE-CONTEXT.md` (this file)

**What next session should do:**
- **M5 agent:** Execute Phase 2 for M5 (update BRIDGE_URL, restart agent-daemon)
- **After M5 connects:** Phase 3 testing (NATS pub/sub, Ships Comm voice commands)

**Blockers:** None — M5 just needs to reconfigure when ready

---

### 2026-02-21 — Mini — EXP-010 Phase 1 Complete ✅

**What was completed:**
1. **Mini Phase 1:** Set up central NATS server at 100.113.140.45
   - NATS server running via launchd
   - WebSocket adapter running on port 3100
   - Agent-daemon connected to localhost
   - All services confirmed healthy

---

### 2026-02-21 — DGX — Repository Setup

**What was completed:**
- Cloned hankh95/noesis-ship to `/home/hankh959/projects/noesis-ship`
- Conducted comprehensive architecture review
- Added yurtle-kanban integration with proper directory structure
- Created 7 expeditions for platform development
- Added CLAUDE.md and ACTIVE-CONTEXT.md to repository root

**Key decisions:**
- Use `kanban-work/expeditions/` directory structure (matches nusy-product-team)
- Split work between noesis-ship (platform) and nusy-product-team (integration)
- Priority order: EXP-002 (CLAUDE.md) → EXP-001 (NATS to WebSocket) → EXP-003 (deployment docs)

**Files created/modified:**
- `docs/architecture-review-dgx.md` (new)
- `.kanban/config.yaml` (new)
- `kanban-work/expeditions/EXP-001.md` through `EXP-007.md` (new)
- `CLAUDE.md` (new)
- `claude-workspace/ACTIVE-CONTEXT.md` (new)

**What next session should do:**
- Begin with EXP-002 (Add CLAUDE.md with agent identity)
- After EXP-002: Tackle EXP-001 (Wire NATS to WebSocket adapter) — critical path
- After EXP-001: EXP-003 (Document DGX deployment) — critical path

**Blockers:** None

---

## Context Notes

- **Architecture:** NATS core (Python) + WebSocket adapter (Node.js) + agent daemon + MCP server
- **Current State:** Centralized on Mini (100.113.140.45), DGX connected, M5 pending
- **DGX:** Agent-daemon connected to Mini central server (local NATS/WebSocket disabled)
- **M5:** Needs Phase 2 reconfiguration to connect to Mini
- **Ships Comm:** iOS/CarPlay voice app, protocol-compatible with noesis-ship (zero code changes)
- **Wire protocol:** Same as old carclaw-bridge — JSON over WebSocket
