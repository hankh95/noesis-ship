# Noesis Ship

An open-source, pluggable multi-agent communication platform. NATS is the core nervous system. WebSocket, MCP, and HTTP/SSE are adapters. Tools like yurtle-kanban plug in alongside.

## Architecture

```
noesis-ship
├── NATS core (event bus, channels, KV, pub/sub)     ← Python
├── Adapters
│   ├── WebSocket (for Ships Comm iOS, web clients)  ← Node.js
│   ├── MCP (for Claude Code, LLM agents)            ← Node.js
│   └── HTTP/SSE (for Command Deck, dashboards)      ← planned
├── Service discovery (frontmatter-based)             ← Python
└── Plugin interface (yurtle-kanban, git, custom)
```

Each machine runs its own noesis-ship instance. No cross-talk between ships.

## Quick Start

### WebSocket Relay (no NATS required)

```bash
cp packages/shared/.env.example .env
# Edit .env with your machine name and agent roster
npm install
npm start
```

The relay starts on port 3100 (configurable via `WS_PORT`). Clients connect via WebSocket and messages are relayed between all connected clients.

### Agent Daemon

```bash
npm run daemon
```

The daemon connects to the local WebSocket relay and spawns Claude Code sessions to handle incoming messages.

### Python Core (requires NATS)

```bash
pip install noesis-ship
```

```python
from noesis_ship.core import EventBus, NATSChannelService
from noesis_ship.chat import ChatService

# Connect to NATS
bus = EventBus(nats_url="nats://localhost:4222")
await bus.connect()

# Emit events
await bus.emit("kanban.item-moved", "my-agent", {
    "item_id": "TASK-001",
    "from_column": "ready",
    "to_column": "in_progress"
})

# Subscribe to events
await bus.subscribe("kanban.*", my_handler)
```

## Components

### NATS Core (`noesis_ship/core/`)

The nervous system. Sub-millisecond pub/sub, persistent event streams, key-value state, and inter-agent channels.

| Module | Purpose |
|--------|---------|
| `event_bus.py` | Event publishing with JetStream persistence (24h retention) |
| `pubsub.py` | Fire-and-forget pub/sub for real-time notifications |
| `channels.py` | Being-to-being and agent-to-agent messaging channels |
| `kv_store.py` | Shared state via NATS KV buckets |
| `object_store.py` | Large file/blob storage via NATS Object Store |

### Chat Service (`noesis_ship/chat/`)

Conversation management with NATS persistence and file-based fallback.

| Module | Purpose |
|--------|---------|
| `models.py` | Message and Conversation data models |
| `service.py` | Chat service with NATS + file fallback |

### Service Discovery (`noesis_ship/discovery/`)

Frontmatter-based service discovery. Agents advertise capabilities via YAML frontmatter in their config files.

### Packages (`packages/`)

Modular npm workspace packages. Each is independently runnable.

| Package | Purpose |
|---------|---------|
| `@noesis-ship/shared` | Config loader, NATS helpers, wire protocol |
| `@noesis-ship/relay` | WebSocket relay server with Bonjour advertising |
| `@noesis-ship/daemon` | Headless Claude Code agent spawner |
| `@noesis-ship/fleet-log` | NATS-to-markdown transcript writer |
| `@noesis-ship/mcp-server` | MCP server for Claude Code tool integration |

## How It Works

1. **Day 1 (now):** WebSocket-only. Same behavior as a standalone bridge server. No NATS dependency.
2. **Day 2:** Add NATS connection to WebSocket adapter. Messages flow to NATS subjects.
3. **Day 3:** Agents subscribe to NATS. Claude agents and beings communicate.
4. **Day 4:** Fleet knowledge mesh, pair programming, cross-agent coordination.

## Ship Templates

Ships come in different sizes:

| Template | Agents | Use Case |
|----------|--------|----------|
| Dinghy | 1 | Solo agent, personal assistant |
| Sloop | 2 | Pair programming, code review |
| Galleon | 4-8 | Full development team |
| Carrier | 8+ | Multi-team fleet operations |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `3100` | WebSocket server port |
| `AGENTS` | — | Agent roster (`id:Name,id:Name`) |
| `MACHINE_NAME` | hostname | Display name for this machine |
| `CLAUDE_SESSION_DIR` | — | Path to Claude project sessions |
| `SESSION_GROUP_ID` | — | Default group for session messages |

## Related Projects

- **Ships Comm** (iOS) — Voice-first agent communication app (connects to noesis-ship via WebSocket)
- **yurtle-kanban** — Pluggable kanban board for agent work tracking
- **nusy-product-team** — AI beings platform (uses noesis-ship for communication)

## License

ISC

## Author

Congruent Systems PBC
