---
id: EXP-011
title: "Fix agent-daemon identity override bug"
type: expedition
status: ready
priority: high
created: 2026-02-21
assignee:
depends_on: [EXP-010]
tags: [bug, agent-daemon, identity]
---

# Fix agent-daemon identity override bug

## Problem

When an agent-daemon connects to a remote bridge (centralized architecture from EXP-010), the bridge sends a status message containing `machine: "<server-name>"`. The daemon overrides its own identity with this value:

```javascript
// agent-daemon.js, inside connectBridge()
if (msg.type === "status") {
    bridgeStatus = msg;
    if (msg.machine) agentName = msg.machine;  // BUG: overwrites AGENT_NAME
}
```

This means every daemon connected to Mini's bridge thinks it **is** Mini:

- M5's daemon sets `agentName = "Mini"` (should be "M5")
- DGX's daemon sets `agentName = "Mini"` (should be "DGX")

### Consequences

1. **Directed messages to M5/DGX are ignored** — `"to": "M5"` doesn't match `agentName` ("Mini")
2. **All daemons respond to `"to": "Mini"`** — duplicate responses from every agent
3. **`fromId` is wrong** — responses are tagged `agent:mini` regardless of which daemon sent them
4. **Echo prevention is broken** — M5's daemon ignores messages `from: "Mini"` (the real Mini), not `from: "M5"`

## Fix

Remove the `agentName` override from the status handler. The daemon should always use its own `AGENT_NAME` env var (or hostname fallback):

```javascript
// Before (broken)
if (msg.type === "status") {
    bridgeStatus = msg;
    if (msg.machine) agentName = msg.machine;
}

// After (fixed)
if (msg.type === "status") {
    bridgeStatus = msg;
    // Do NOT override agentName — use AGENT_NAME env var
}
```

The `machine` field in the status message is the **server's** identity, not the client's. It can be stored in `bridgeStatus` for informational purposes but must not replace the agent's own name.

## Files to modify

| File | Change |
|------|--------|
| `adapters/websocket/agent-daemon.js` | Remove `agentName = msg.machine` line |

## Verification

1. Start Mini bridge (central server)
2. Connect M5 daemon with `AGENT_NAME=M5`
3. Send directed message `"to": "M5"` — M5 should respond
4. Send directed message `"to": "Mini"` — only Mini should respond
5. Check M5 response `fromId` is `agent:m5`, not `agent:mini`
6. Send broadcast — no daemon responds (loop prevention still works)
