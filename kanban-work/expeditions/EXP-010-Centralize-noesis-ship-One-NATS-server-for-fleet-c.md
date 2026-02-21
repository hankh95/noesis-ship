---
id: EXP-010
title: "Centralize noesis-ship: One NATS server for fleet coordination"
type: expedition
status: blocked
priority: medium
created: 2026-02-21
assignee: DGX
blocked_by: "Hardware acquisition (Mac Mini M4)"
depends_on: []
tags: [infrastructure, nats, centralization, ships-comm]
---

# Centralize noesis-ship: One NATS server for fleet coordination

## Status: BLOCKED — Waiting for Hardware

**Plan Approved:** 2026-02-21
**Plan Location:** `/home/hankh959/.claude/plans/floating-crafting-platypus.md`
**Blocked By:** Hardware acquisition (Mac Mini M4 or Ubuntu mini PC)

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

## Implementation Phases

### Phase 1: Hardware Setup (2-3 hours)
- Purchase and receive Mac Mini M4
- Install Tailscale, enable SSH
- Install Node.js 20+, Python 3.11+, NATS server

### Phase 2: Deploy noesis-ship (1-2 hours)
- Start NATS server and WebSocket adapter on central server
- Verify health endpoints

### Phase 3: Reconfigure Agents (1 hour)
- Update agent-daemon BRIDGE_URL on M5, DGX, Mini
- Stop local NATS/WebSocket services
- All agents now connect to central server via Tailscale

### Phase 4: Verification (45 minutes)
- Ships Comm iOS: Update bridge URL, test voice commands
- NATS pub/sub testing
- Agent-daemon log verification
- Optional: CarPlay testing

**Total effort:** ~5-7 hours spread over hardware delivery time

## Next Steps

1. **Hardware Acquisition:**
   - Order Mac Mini M4 (~$600) or Ubuntu mini PC (~$400-500)
   - Wait for delivery

2. **When Hardware Arrives:**
   - Follow Phase 1: Hardware Setup from the plan
   - Continue through Phase 2-4

3. **Post-Migration:**
   - Update Ships Comm iOS app with new bridge URL
   - Test voice commands: "Fleet, status check", "DGX, uptime?"
   - Verify all agent-daemons connect to central server

## Related Work

- **EXP-001:** NATS integration (complete) — foundation for this work
- **EXP-009:** Kanban EventBus (future) — will benefit from centralized NATS
- **EXP-901:** Mini agent-daemon (in progress) — will use central server
- **Ships Comm:** iOS/CarPlay voice app — already protocol-compatible

## Plan Details

See full implementation plan with security, rollback, and cost analysis:
`/home/hankh959/.claude/plans/floating-crafting-platypus.md`