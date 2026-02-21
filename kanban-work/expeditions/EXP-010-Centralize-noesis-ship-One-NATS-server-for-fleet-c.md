---
id: EXP-010
title: "Centralize noesis-ship: One NATS server for fleet coordination"
type: expedition
status: done
priority: high
created: 2026-02-21
assignee: Mini
depends_on: []
tags: [infrastructure, nats, centralization, ships-comm]
---

# Centralize noesis-ship: One NATS server for fleet coordination

## Status: READY — Test on Current Mini M4 (No Purchase Needed!)

**Plan Approved:** 2026-02-21
**Plan Location:** `/home/hankh959/.claude/plans/floating-crafting-platypus.md`
**Assigned To:** Mini agent (macOS infrastructure work)
**Test Approach:** Use existing Mini M4 as central server

## Test Plan — No New Hardware Required! 🎉

**Decision:** Test centralized architecture on **existing Mini M4** before purchasing dedicated hardware.

**Approach:**
- Mini runs NATS + WebSocket adapter (central server)
- Mini also runs agent-daemon (connects to localhost:3100)
- DGX and M5 connect to Mini's Tailscale IP remotely
- **Cost:** $0 (use existing hardware)
- **Time:** ~2 hours (vs 5-7 hours + hardware delivery)

**Benefits:**
- Immediate validation of architecture
- Real performance data
- Ships Comm voice testing today
- Can decide later if dedicated hardware is worth it

## Executive Summary

Currently running noesis-ship on each machine (M5, DGX, Mini) wastes resources and prevents true fleet coordination. This expedition centralizes noesis-ship on dedicated hardware accessible via Tailscale.

**Solution:** One central server running NATS + WebSocket adapter, all agents connect remotely.

**Key Benefits:**
- True fleet coordination (shared KV store, shared event history)
- Ships Comm iOS/CarPlay voice integration (already protocol-compatible!)
- Foundation for web apps (Kanban UI, Command Deck)
- Lower resource usage on compute machines
- Single point of management

## Architecture

```
Dedicated Server (Mac Mini M4)
├── NATS Server (4222)           ← Central event bus
├── WebSocket Adapter (3100)     ← Ships Comm iOS
├── Kanban Web UI (3200)         ← Future
└── Command Deck (8050)          ← Future
         │
    Tailscale VPN
         │
    ┌────┴────┬─────────┐
    │   M5    │   DGX   │  Mini
    │ agent-  │ agent-  │ agent-
    │ daemon  │ daemon  │ daemon
```

## Ships Comm Integration ✅

**Good news:** Noesis-ship WebSocket adapter is already fully compatible with Ships Comm!

- Same wire protocol (BridgeProtocol.swift)
- Same JSON message format
- Channel routing already works (#fleet, #m5, #dgx, #mini, #log)
- **Zero code changes** to Ships Comm — just update bridge URL

**Voice flow (already works):**
1. User: "Hey Siri, DGX check status"
2. Ships Comm → WebSocket → noesis-ship → NATS
3. DGX agent-daemon receives via NATS subscription
4. Claude responds → NATS → WebSocket → Ships Comm TTS

## Hardware Decision

**Recommended:** Mac Mini M4 ($600)
- 95%+ uptime target
- Low power (~15W idle)
- macOS familiarity
- Silent, reliable, excellent performance
- Can host web apps later

**Alternative:** Ubuntu Mini PC ($400-500)

**Total cost:** $660 Year 1 (hardware + electricity)

## Implementation Phases (Test on Existing Mini)

### Phase 1: Mini Setup as Central Server (~1 hour) — **MINI AGENT**
1. Clone noesis-ship repo (if not present)
2. Install dependencies: `cd adapters/websocket && npm install`
3. Configure `.env` for Mini:
   ```env
   WS_PORT=3100
   NATS_URL=nats://localhost:4222
   MACHINE_NAME=Mini
   AGENTS=dgx:DGX,mini:Mini,m5:M5,copilot:Copilot
   CLAUDE_SESSION_DIR=/Users/hankh1844/.claude/projects/-Users-hankh1844-projects-nusy-product-team
   ```
4. Start NATS server (launchd or manual)
5. Start WebSocket adapter (launchd or manual)
6. Install agent-daemon (EXP-901) connecting to localhost:3100
7. Get Mini's Tailscale IP: `tailscale ip -4`

### Phase 2: Reconfigure Remote Agents (~30 min) — **DGX + M5 AGENTS**
1. **DGX agent (systemd):**
   - Update `~/.config/systemd/user/noesis-ship-agent-daemon.service`
   - Change `BRIDGE_URL=ws://<mini-tailscale-ip>:3100`
   - Stop local NATS/WebSocket: `systemctl --user stop nats-server noesis-ship-websocket`
   - Restart agent-daemon: `systemctl --user restart noesis-ship-agent-daemon`

2. **M5 agent (launchd):**
   - Update `~/Library/LaunchAgents/com.congruentsystems.noesis-ship-agent-daemon.plist`
   - Change `BRIDGE_URL` to Mini's Tailscale IP
   - Restart agent-daemon via launchctl

### Phase 3: Verification (~30 min) — **ALL AGENTS + USER**
1. **Ships Comm iOS:**
   - Update bridge URL to Mini's Tailscale IP
   - Test: "Fleet, status check" (all 3 agents respond)
   - Test: "DGX, uptime?", "Mini, hello?"
   - Verify TTS responses

2. **NATS Pub/Sub:**
   - From any machine: `nats pub --server=nats://<mini-ip>:4222 ship.channel.fleet "Test"`
   - Verify all agents receive

3. **Logs:**
   - Mini: Check NATS, WebSocket, agent-daemon logs
   - DGX: `journalctl --user -u noesis-ship-agent-daemon -f`
   - M5: Launchd logs

**Total effort:** ~2 hours (all agents working in parallel)

## Next Steps — Handoff to Mini Agent

**Mini agent:** Pick up Phase 1 when ready:
1. Read `claude-workspace/ACTIVE-CONTEXT.md` for full context
2. Execute Phase 1: Set up Mini as central server
3. Coordinate with DGX and M5 for Phase 2 (agent reconfig)
4. Test with Ships Comm (Phase 3)

**DGX/M5 agents:** Wait for Mini to complete Phase 1, then:
- DGX: Reconfigure DGX agent-daemon to point to Mini
- M5: Reconfigure M5 agent-daemon to point to Mini

**After Testing:**
- If performance is good → Keep Mini as permanent central server ($0 cost)
- If dedicated hardware needed → We've validated the architecture and know exactly what to buy

## Related Work

- **EXP-001:** NATS integration (complete) — foundation for this work
- **EXP-009:** Kanban EventBus (future) — will benefit from centralized NATS
- **EXP-901:** Mini agent-daemon (in progress) — will use central server
- **Ships Comm:** iOS/CarPlay voice app — already protocol-compatible

## Plan Details

See full implementation plan with security, rollback, and cost analysis:
`/home/hankh959/.claude/plans/floating-crafting-platypus.md`