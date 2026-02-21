---
id: EXP-018
title: "Agent Daemon v2: Claude Agent SDK + NATS-native messaging"
type: expedition
status: review
priority: high
created: 2026-02-21
assignee: M5
depends_on: [EXP-010]
tags: [agent-daemon, claude-sdk, nats, architecture, performance]
related: [EXP-001, EXP-010, EXP-901]
---

# EXP-018: Agent Daemon v2 — Claude Agent SDK + NATS-Native Messaging

## Problem

The current `agent-daemon.js` has two architectural limitations:

1. **Subprocess spawning per message**: Every incoming message spawns `claude -p <message>` as a child process (line 244). This means cold-start overhead, fragile session ID capture via stderr regex (line 262), and no real streaming — the entire response is buffered, then broadcast at once.

2. **WebSocket-only transport**: The daemon connects to the bridge via WebSocket (`ws://host:3100`), even though noesis-ship already has a full NATS pub/sub infrastructure (`ship.channel.*` subjects, JetStream, KV store). The bridge acts as a WebSocket→NATS relay, adding an unnecessary hop.

## Solution

Replace `agent-daemon.js` with `agent-daemon-v2.js` that:

1. **Uses the Claude Agent SDK** (`@anthropic-ai/claude-code` — already a dependency) instead of spawning processes. The SDK provides `query()` with native async streaming, reliable session management, and programmatic tool control.

2. **Subscribes directly to NATS** (`ship.channel.>`) instead of connecting through WebSocket. This aligns with EXP-010's centralized architecture where all agents connect to one NATS server.

## Architecture Comparison

### Current (v1)
```
Ships Comm → WebSocket → Bridge (server.js) → WebSocket → agent-daemon.js
                                                              ↓
                                                          spawn claude -p
                                                              ↓
                                                          collect stdout
                                                              ↓
                                                      WebSocket → Bridge → Ships Comm
```
- 4 network hops per message
- Process spawn per message (~500ms overhead)
- No streaming (buffered response)
- Fragile session capture (regex on stderr)

### Proposed (v2)
```
Ships Comm → WebSocket → Bridge → NATS (ship.channel.*)
                                      ↓
                                  agent-daemon-v2.js (NATS subscriber)
                                      ↓
                                  SDK query() — in-process, streaming
                                      ↓
                                  NATS publish → Bridge → Ships Comm
```
- 2 network hops (NATS pub/sub)
- In-process SDK call (no spawn overhead)
- Real-time streaming to clients
- Reliable session ID from SDK init event

## Design

### NATS Subject Mapping

Follow existing noesis-ship conventions from `server.js` and `fleet-log-writer.js`:

| Subject | Purpose |
|---------|---------|
| `ship.channel.>` | Subscribe — receive all channel messages |
| `ship.channel.{group}` | Publish — send responses back |
| `ship.events.agent.{action}.{agent}` | EventBus integration (health, status) |
| `ship.kv.beings_status` | KV Store — agent online/offline heartbeats |

### Message Flow

```
1. NATS subscription on ship.channel.> receives message
2. Filter: ignore own messages, undirected broadcasts (same logic as v1)
3. For actionable messages:
   a. If resumable session exists → query({ prompt, options: { resume: sessionId } })
   b. Else → query({ prompt, options: { cwd, maxTurns, allowedTools } })
4. Stream SDK events:
   - type="system", subtype="init" → capture sessionId
   - type="stream_event" → stream text chunks to NATS (optional)
   - type="result" → publish final response to ship.channel.{group}
5. Publish agent heartbeat to ship.kv.beings_status
```

### Session Management

The Agent SDK's `resume` option replaces the fragile stderr regex:

```javascript
const { query } = require("@anthropic-ai/claude-code");

// First message — new session
const response = query({
  prompt: userMessage,
  options: {
    cwd: PROJECT_DIR,
    maxTurns: MAX_TURNS,
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
  }
});

for await (const msg of response) {
  if (msg.type === "system" && msg.subtype === "init") {
    sessionId = msg.session_id;  // reliable capture
  }
  if (msg.type === "result") {
    nats.publish(`ship.channel.${group}`, encode(responsePayload));
  }
}

// Subsequent messages — resume session
const resumed = query({
  prompt: nextMessage,
  options: { resume: sessionId, maxTurns: MAX_TURNS }
});
```

### Graceful Degradation

When NATS is unavailable, fall back to WebSocket (same pattern as `server.js`):
- Try NATS connection first
- If NATS fails → connect via WebSocket (v1 behavior)
- Log transport mode for diagnostics

## Implementation Phases

### Phase 1: SDK Integration (replace `claude -p` spawning)

Create `agent-daemon-v2.js` alongside existing `agent-daemon.js`:

1. Replace `spawn(CLAUDE_BIN, args)` with SDK `query()` call
2. Use `for await` streaming instead of stdout buffering
3. Capture session ID from SDK init event (not stderr regex)
4. Support session resumption via `--resume`
5. Keep WebSocket transport for now (change transport in Phase 2)

**Tests:**
- SDK query produces response for simple prompt
- Session ID captured and reused across messages
- Streaming events arrive in correct order
- Timeout handling (SDK `interrupt()` replaces `child.kill()`)
- Boilerplate filtering still works
- Message queue serialization still works

### Phase 2: NATS-Native Transport

Switch from WebSocket to direct NATS subscription:

1. Connect to NATS (`nats://localhost:4222` or remote via Tailscale)
2. Subscribe to `ship.channel.>` (like `fleet-log-writer.js`)
3. Publish responses to `ship.channel.{group}`
4. Add origin tagging to prevent echo loops (like `server.js` line 268)
5. Keep WebSocket as fallback (graceful degradation)

**Tests:**
- NATS subscription receives messages
- Origin filtering prevents echo loops
- Response published to correct channel
- Fallback to WebSocket when NATS unavailable
- Reconnection on NATS disconnect

### Phase 3: EventBus + KV Integration

Wire into noesis-ship's Python EventBus patterns:

1. Publish `ship.events.agent.started.{agent}` on daemon start
2. Publish heartbeats to `ship.kv.beings_status` (online/offline)
3. Subscribe to `ship.events.kanban.*` for kanban events (replaces `handleKanbanEvent`)
4. Emit `ship.events.agent.response.{agent}` with metadata (duration, cost, turns)

### Phase 4: Streaming Responses (Optional Enhancement)

Stream text chunks to clients in real-time:

1. On `stream_event` with `text_delta` → publish partial to `ship.channel.{group}.stream`
2. Clients subscribe to `ship.channel.{group}.stream` for live updates
3. Final `result` message published to `ship.channel.{group}` (same as before)
4. Ships Comm can show "typing..." indicator during streaming

## File Plan

### New Files
| File | Purpose |
|------|---------|
| `adapters/websocket/agent-daemon-v2.js` | New daemon with SDK + NATS |
| `adapters/websocket/test-daemon-v2.js` | Integration tests |

### Modified Files
| File | Change |
|------|--------|
| `package.json` | Add `daemon:v2` script |
| `adapters/websocket/package.json` | Ensure `@anthropic-ai/claude-code` version >=2.1.49 |

### Preserved Files (no changes)
| File | Reason |
|------|--------|
| `agent-daemon.js` | Keep v1 as fallback until v2 proven |
| `server.js` | Bridge unchanged — v2 daemon bypasses it via NATS |
| `mcp-server.js` | MCP server unchanged |

## Success Criteria

1. Agent responds to Ships Comm voice commands via NATS (no WebSocket hop)
2. Session continuity across messages (verified by context recall)
3. Response latency reduced vs v1 (no process spawn overhead)
4. Streaming responses visible in Ships Comm (real-time text)
5. Heartbeat visible in NATS KV store
6. Graceful fallback to WebSocket when NATS unavailable

## References

- EXP-001: NATS integration (foundation)
- EXP-010: Centralized NATS architecture (prerequisite — done)
- EXP-901: Mini agent-daemon installation (uses v1, will upgrade to v2)
- `@anthropic-ai/claude-code` SDK: Already in `package.json`
- NATS subjects: `server.js` lines 267-270, `fleet-log-writer.js` line 209
