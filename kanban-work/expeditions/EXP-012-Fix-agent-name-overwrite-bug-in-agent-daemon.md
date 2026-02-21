---
id: EXP-012
title: "Fix agent name overwrite bug in agent-daemon"
type: expedition
status: backlog
priority: high
created: 2026-02-21
depends_on: []
tags: [bug, agent-daemon, agent-to-agent-messaging]
---

# Fix agent name overwrite bug in agent-daemon

## Problem

**Discovered during EXP-010 Phase 3 testing:** Agent-to-agent messaging routing is broken. All agent-daemons think they're named "Mini" instead of their actual names (DGX, M5, Mini).

**Root cause:** `adapters/websocket/agent-daemon.js:81` overwrites the `agentName` variable with the bridge's machine name:

```javascript
if (msg.machine) agentName = msg.machine;
```

When the bridge sends a status message, it includes `machine: "Mini"` (the central server's name). Each agent-daemon receives this and overwrites its own `agentName`, causing all agents to think they're "Mini".

**Impact:**
- ❌ Directed agent-to-agent messages fail to route correctly
- ❌ All agents ignore messages directed to their actual names
- ❌ Only messages directed to "Mini" get processed by all agents
- ✅ Human messages still work (fromId check)
- ✅ Loop prevention still works (broadcast ignore)

## Reproduction

**Setup:**
- Mini: Central NATS server at 100.113.140.45
- DGX: Remote agent connecting to Mini
- M5: Remote agent connecting to Mini

**Test:**
```bash
# Send directed message to DGX
curl -X POST http://100.113.140.45:3102/message \
  -H "Content-Type: application/json" \
  -d '{"group":"fleet","from":"Mini","message":"What GPU are you running?","to":"DGX"}'

# Expected: DGX daemon processes message
# Actual: DGX daemon logs "Ignoring broadcast from Mini (not directed to Mini)"
```

**DGX logs show:**
```
[AgentDaemon] Ignoring broadcast from Mini (not directed to Mini)
```

Even though the message was `"to":"DGX"`, the daemon checks `msg.to === "Mini"` because `agentName` was overwritten.

## Root Cause Analysis

**agent-daemon.js:47-81:**
```javascript
let agentName = process.env.AGENT_NAME || "M5";  // Line 47: Correct initialization

// ...

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === "status") {
    bridgeStatus = msg;
    if (msg.machine) agentName = msg.machine;  // Line 81: ❌ BUG!
  }
```

**The problem:**
- Each agent correctly sets `agentName` from `AGENT_NAME` environment variable on startup
- When the bridge sends status, it includes `msg.machine = "Mini"` (the bridge's own machine name)
- Line 81 overwrites each agent's `agentName` with "Mini"
- All subsequent message routing uses the wrong name

**Why this happened:**
- The bridge status message was originally designed for single-machine deployments
- `msg.machine` represented "this machine's name"
- In centralized architecture, the bridge runs on Mini, so `msg.machine = "Mini"`
- Agent-daemons on remote machines (DGX, M5) receive this and incorrectly adopt "Mini" as their name

## Solution

**Option 1: Remove the overwrite (simplest)**

Remove line 81 entirely. Each agent should use its own `AGENT_NAME` environment variable, never overwrite it.

```javascript
if (msg.type === "status") {
  bridgeStatus = msg;
  // DO NOT overwrite agentName from bridge status
}
```

**Option 2: Only use machine for fallback (safer)**

Only set agentName from bridge if it wasn't explicitly configured:

```javascript
if (msg.type === "status") {
  bridgeStatus = msg;
  // Only use bridge machine name if AGENT_NAME wasn't explicitly set
  if (!process.env.AGENT_NAME && msg.machine) {
    agentName = msg.machine;
  }
}
```

**Recommendation:** Option 2 (safer fallback behavior)

## Testing Plan

1. **Apply fix** to agent-daemon.js
2. **Commit and push** to main
3. **All agents pull** latest code: `cd /home/hankh959/projects/noesis-ship && git pull origin main`
4. **Restart all agent-daemons:**
   - DGX: `systemctl --user restart noesis-ship-agent-daemon`
   - M5: `launchctl unload ~/Library/LaunchAgents/com.congruentsystems.noesis-ship-agent-daemon.plist && launchctl load ~/Library/LaunchAgents/com.congruentsystems.noesis-ship-agent-daemon.plist`
   - Mini: (same as M5)
5. **Test directed messages:**
   ```bash
   # Mini → DGX
   curl -X POST http://100.113.140.45:3102/message \
     -H "Content-Type: application/json" \
     -d '{"group":"fleet","from":"Mini","message":"What GPU are you running?","to":"DGX"}'

   # Mini → M5
   curl -X POST http://100.113.140.45:3102/message \
     -H "Content-Type: application/json" \
     -d '{"group":"fleet","from":"Mini","message":"How many beings trained?","to":"M5"}'

   # DGX → Mini
   curl -X POST http://100.113.140.45:3102/message \
     -H "Content-Type: application/json" \
     -d '{"group":"fleet","from":"DGX","message":"What is your uptime?","to":"Mini"}'
   ```
6. **Verify logs** show correct routing:
   - DGX should log: `Agent message from Mini [fleet]: What GPU are you running?`
   - M5 should log: `Agent message from Mini [fleet]: How many beings trained?`
   - Mini should log: `Agent message from DGX [fleet]: What is your uptime?`
7. **Verify loop prevention** still works (undirected broadcasts ignored)

## Success Criteria

✅ Each agent correctly identifies with its own AGENT_NAME
✅ Directed messages route to the correct agent
✅ DGX responds to `"to":"DGX"` messages
✅ M5 responds to `"to":"M5"` messages
✅ Mini responds to `"to":"Mini"` messages
✅ Undirected broadcasts still ignored (no infinite loops)
✅ Human messages still work (`fromId: "carclaw:user"`)

## Related

- **EXP-010:** Centralization (this bug discovered during Phase 3 testing)
- **agent-daemon.js:** Line 81 needs fix
- **Centralized architecture:** Multi-machine deployment exposed this bug
