---
id: DOC-ADAPTERS
type: doc
title: "Noesis Ship Adapters"
category: adapters
audience: [developer, agent]
created: 2026-02-21
tags: [websocket, mcp, adapters, protocols]
---

# Adapters

Adapters bridge external protocols to the Noesis Ship core. Each adapter runs as a separate process and communicates with the NATS core (when available) or operates standalone.

## WebSocket Adapter

The WebSocket adapter (`adapters/websocket/`) provides real-time bidirectional communication for clients like Ships Comm (iOS) and web dashboards.

### Protocol

Messages are JSON over WebSocket:

```json
// Client → Server (send a message)
{
  "type": "send",
  "group": "session:active",
  "to": "m5",
  "message": "What are you working on?"
}

// Server → Client (incoming message)
{
  "type": "message",
  "group": "session:active",
  "from": "M5",
  "fromId": "agent:m5",
  "message": "Working on FEAT-017",
  "timestamp": "2026-02-20T12:00:00.000Z"
}

// Server → Client (status update)
{
  "type": "status",
  "agents": [
    { "id": "m5", "name": "M5" },
    { "id": "mini", "name": "Mini" }
  ],
  "sessions": [
    { "machine": "M5", "sessionId": "abc123", "active": true }
  ],
  "machine": "M5",
  "tailscaleIP": "100.109.27.49"
}

// Client → Server (list available groups)
{
  "type": "list_groups"
}

// Server → Client (broadcast from agent)
{
  "type": "message",
  "group": "session:active",
  "from": "M5",
  "fromId": "agent:m5",
  "message": "Response content here",
  "timestamp": "2026-02-20T12:00:01.000Z"
}
```

### Bonjour/mDNS Discovery

The adapter advertises itself via Bonjour:

- Service type: `_carclaw._tcp`
- Port: configurable (default 3100)
- TXT record: `version=1, hostname=<machine-hostname>`

Ships Comm auto-discovers adapters on the local network.

### Agent HTTP API

Agents can post messages via HTTP (port WS_PORT + 2, default 3102):

```bash
curl -X POST http://localhost:3102/message \
  -H "Content-Type: application/json" \
  -d '{"group":"session:active","from":"M5","message":"Hello from agent"}'
```

## MCP Adapter

The MCP adapter (`adapters/websocket/mcp-server.js`) provides Model Context Protocol tools for Claude Code:

### Tools

| Tool | Description |
|------|-------------|
| `check_inbox` | Read messages from the ship |
| `send_to_carclaw` | Send a message to all connected clients |
| `bridge_status` | Get adapter connection status |

### Configuration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "noesis-ship": {
      "command": "node",
      "args": ["/path/to/noesis-ship/adapters/websocket/mcp-server.js"],
      "env": {
        "BRIDGE_URL": "ws://localhost:3100"
      }
    }
  }
}
```

## Writing a Custom Adapter

Adapters connect to NATS and translate between external protocols and NATS subjects.

### Python Example

```python
import nats
import json

class MyAdapter:
    def __init__(self, nats_url="nats://localhost:4222"):
        self.nats_url = nats_url
        self.nc = None

    async def start(self):
        self.nc = await nats.connect(self.nats_url)

        # Subscribe to messages from the ship
        await self.nc.subscribe("ship.events.>", cb=self.on_event)

        # Start your external protocol server here
        await self.run_server()

    async def on_event(self, msg):
        event = json.loads(msg.data.decode())
        # Translate to your protocol and send to clients
        await self.send_to_clients(event)

    async def publish_to_ship(self, subject, data):
        await self.nc.publish(subject, json.dumps(data).encode())
```

### Node.js Example

```javascript
const { connect } = require("nats");

class MyAdapter {
  async start() {
    this.nc = await connect({ servers: "nats://localhost:4222" });

    // Subscribe to ship events
    const sub = this.nc.subscribe("ship.events.>");
    for await (const msg of sub) {
      const event = JSON.parse(msg.data.toString());
      await this.sendToClients(event);
    }
  }

  async publishToShip(subject, data) {
    this.nc.publish(subject, JSON.stringify(data));
  }
}
```

### Subject Conventions

| Subject Pattern | Purpose |
|----------------|---------|
| `ship.events.{category}.{action}` | Event bus messages |
| `ship.channel.{from}.{to}` | Point-to-point messaging |
| `ship.channel.group.{id}` | Group messaging |
| `ship.kv.{bucket}.{key}` | KV store operations |
| `ship.discovery.{service}` | Service announcements |
