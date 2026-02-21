---
id: EXP-001
title: "Wire NATS to WebSocket adapter for channel relay"
type: expedition
status: done
priority: medium
created: 2026-02-21
assignee: DGX
depends_on: []
---

# Wire NATS to WebSocket adapter for channel relay

## Implementation

Added NATS integration to the WebSocket adapter with graceful fallback:

### Changes

1. **package.json**: Added `nats@^2.29.3` dependency
2. **server.js**:
   - Added NATS connection with `initNATS()` function
   - Subscribe to `ship.channel.*` subjects for NATS → WebSocket relay
   - Publish to `ship.channel.{group}` for WebSocket → NATS relay
   - Updated status payload to include NATS connection state
   - Environment variable: `NATS_URL` (default: "nats://localhost:4222")

3. **test-nats-integration.js**: Integration test verifying bidirectional relay

### Features

- **Backward compatible**: Works without NATS (Day 1 mode)
- **Graceful fallback**: If NATS unavailable, logs warning and continues WebSocket-only
- **Clear logging**: "NATS connected" or "Running in WebSocket-only mode"
- **Subject pattern**: `ship.channel.{channel_name}` for channel messages
- **Bidirectional relay**:
  - WebSocket messages → published to NATS
  - NATS messages → relayed to WebSocket clients

### Testing

Both modes verified:
- ✓ NATS mode: Messages relay correctly both directions
- ✓ WebSocket-only mode: Server starts and works without NATS
