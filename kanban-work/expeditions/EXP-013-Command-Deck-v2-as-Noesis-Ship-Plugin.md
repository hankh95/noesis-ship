---
id: EXP-013
title: "Command Deck v2 as Noesis-Ship Plugin"
type: expedition
status: backlog
priority: medium
created: 2026-02-21
assignee: DGX
depends_on: [EXP-010, EXP-017]
tags: [dashboard, web-ui, nats, gradio, fleet-monitoring]
---

# Command Deck v2 as Noesis-Ship Plugin

## Vision

Port the existing Command Deck dashboard (Gradio-based fleet monitoring UI from nusy-product-team) to run as a noesis-ship plugin hosted on Mini's central server. This provides a unified fleet dashboard accessible from any browser.

## Current State (nusy-product-team)

**Location:** `dashboard/command_deck.py`
**Tech:** Gradio (Python web framework)
**Port:** 3000
**Features:**
- Running beings status (via `ps aux`)
- GPU utilization (nvidia-smi)
- Kanban board state (from `kanban_state.json`)
- Recent git commits
- LLM routing statistics (local vs cloud)

**Limitations:**
- Runs locally on each machine
- No cross-fleet visibility
- No NATS integration
- Polling-based updates (not real-time)

## Target State (noesis-ship plugin)

**Location:** `plugins/command-deck/` (new)
**Host:** Mini M4 at `http://100.113.140.45:8050`
**Tech:** Gradio + NATS subscriptions
**Port:** 8050 (avoid conflicts with WebSocket 3100, HTTP API 3102)

**Enhanced Features:**
- ✅ Fleet-wide being status (DGX, Mini, M5 beings)
- ✅ Fleet-wide GPU monitoring (aggregate + per-machine)
- ✅ Multi-project kanban (nusy-product-team, noesis-ship, etc.)
- ✅ Real-time training metrics via NATS events
- ✅ Agent-daemon health (connection status, uptime)
- ✅ NATS health (JetStream, KV, connections)
- ✅ Ships Comm connection status
- ✅ Fleet-wide git sync status

## Architecture

### Plugin Structure

```
plugins/command-deck/
├── __init__.py           # Plugin registration
├── dashboard.py          # Gradio UI (port from nusy-product-team)
├── nats_collector.py     # NATS event subscriptions
├── fleet_status.py       # Fleet-wide aggregation
├── requirements.txt      # gradio, nats-py
└── README.md            # Setup instructions
```

### NATS Integration

**Subscriptions (receive fleet events):**
- `ship.being.*.awakened` → Being lifecycle events
- `ship.being.*.training` → Training progress updates
- `ship.being.*.hibernate` → Being shutdown events
- `ship.agent.*.status` → Agent-daemon health reports
- `ship.metrics.*` → GPU, CPU, memory metrics

**Publications (send dashboard commands):**
- `ship.command.awaken` → Awaken a being remotely
- `ship.command.hibernate` → Hibernate a being
- `ship.command.reload` → Reload agent config

### Data Flow

```
Fleet Machines (DGX, Mini, M5)
    ↓ (publish events)
NATS Server (Mini:4222)
    ↓ (subscribe)
Command Deck Plugin (Mini:8050)
    ↓ (Gradio UI)
User Browser (any device on Tailscale)
```

### Real-Time Updates

**Gradio refresh strategy:**
- NATS events update in-memory state
- Gradio UI polls state every 5 seconds (or uses `gr.update()` for real-time)
- Fleet metrics cached in memory (updated by NATS subscriptions)

## Implementation Plan

### Phase 1: Plugin Scaffold (~2 hours)

1. Create `plugins/command-deck/` directory structure
2. Copy existing `dashboard/command_deck.py` as baseline
3. Add NATS connection setup (from `brain/services/event_bus.py` pattern)
4. Update port to 8050
5. Add plugin registration interface

### Phase 2: NATS Integration (~3 hours)

1. **nats_collector.py:**
   - Subscribe to `ship.being.*` events
   - Subscribe to `ship.agent.*` events
   - Subscribe to `ship.metrics.*` events
   - Store fleet state in memory (dict keyed by machine name)

2. **fleet_status.py:**
   - Aggregate being status across all machines
   - Aggregate GPU metrics (total fleet utilization)
   - Health checks (agent-daemon connected, NATS reachable)

3. **dashboard.py updates:**
   - Replace `get_beings_status()` with fleet-wide query
   - Replace `get_gpu_status()` with fleet aggregate
   - Add agent-daemon health tab
   - Add NATS health tab

### Phase 3: Multi-Project Kanban (~2 hours)

1. Fetch kanban state from multiple repos via git
2. Display unified view (all expeditions, all projects)
3. Color-code by project (nusy-product-team, noesis-ship)
4. Link to GitHub for expedition details

### Phase 4: Deployment (~1 hour)

1. Add launchd plist for Mini:
   ```xml
   <key>Label</key>
   <string>com.congruentsystems.noesis-ship-command-deck</string>
   <key>ProgramArguments</key>
   <array>
       <string>/usr/bin/python3</string>
       <string>/Users/hankh1844/projects/noesis-ship/plugins/command-deck/dashboard.py</string>
   </array>
   <key>EnvironmentVariables</key>
   <dict>
       <key>NATS_URL</key>
       <string>nats://localhost:4222</string>
       <key>PORT</key>
       <string>8050</string>
   </dict>
   ```

2. Start service on Mini
3. Access via `http://100.113.140.45:8050` (Tailscale) or `http://mini.local:8050` (LAN)

## Success Criteria

✅ Command Deck accessible from any browser on Tailscale
✅ Shows real-time being status across all fleet machines
✅ GPU metrics aggregate DGX + Mini (+ M5 if applicable)
✅ Training events update in real-time via NATS
✅ Agent-daemon health visible (connected, uptime, last message)
✅ Multi-project kanban view (nusy-product-team + noesis-ship)
✅ No polling of remote machines (all via NATS pub/sub)

## Dependencies

- **EXP-010:** NATS centralization must be complete (Mini is central server)
- **nusy-product-team:** Beings must emit training events to NATS (EXP-894 complete ✅)
- **Python packages:** gradio, nats-py, git (for multi-repo kanban)

## Future Enhancements

- Live being chat interface (send messages to beings via NATS)
- Training job queue (schedule overnight retraining)
- Paper experiment dashboard (hypothesis results, A/B metrics)
- Cloudflare tunnel for public access (optional)

## Estimated Effort

**Total:** ~8 hours (1 day)
**Assignee:** DGX (Python + NATS expertise)
