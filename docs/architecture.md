# Architecture

## Overview

Noesis Ship is a pluggable multi-agent communication platform. NATS is the core nervous system. Everything else is an adapter or plugin.

```
┌─────────────────────────────────────────────────────────┐
│                     Noesis Ship                         │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              NATS Core (Python)                  │   │
│  │                                                  │   │
│  │  EventBus ─── JetStream persistence (24h)        │   │
│  │  PubSub  ─── Fire-and-forget notifications       │   │
│  │  Channels ── Agent-to-agent messaging            │   │
│  │  KVStore ─── Shared state                        │   │
│  │  ObjectStore ─ Large file storage                │   │
│  └──────────────────────────────────────────────────┘   │
│              ▲              ▲              ▲             │
│              │              │              │             │
│  ┌───────────┴──┐ ┌────────┴───┐ ┌────────┴──────┐     │
│  │  WebSocket   │ │    MCP     │ │   HTTP/SSE    │     │
│  │  Adapter     │ │  Adapter   │ │   Adapter     │     │
│  │  (Node.js)   │ │  (Node.js) │ │   (planned)   │     │
│  └──────────────┘ └────────────┘ └───────────────┘     │
│         ▲                ▲                ▲             │
└─────────┼────────────────┼────────────────┼─────────────┘
          │                │                │
   Ships Comm iOS    Claude Code     Command Deck
   (voice-first)    (LLM agents)    (dashboards)
```

## NATS Core

NATS provides sub-millisecond pub/sub messaging. The core modules are:

### Event Bus (`src/core/event_bus.py`)

The primary event system. All significant actions emit events here.

- **JetStream persistence:** Events stored for 24h, enabling replay and catch-up
- **Subject hierarchy:** `ship.events.{category}.{action}.{entity_id}`
- **Fallback:** When NATS is unavailable, events are handled locally

Categories: `runner`, `being`, `kanban`, `expedition`, `chat`, `health`, `voyage`, `cargo`

### Pub/Sub (`src/core/pubsub.py`)

Fire-and-forget messaging for real-time notifications.

- **EventPublisher:** Publishes typed events to NATS subjects
- **EventSubscriber:** Pattern-based subscription with async handlers
- **ShipEventBus:** High-level wrapper combining pub and sub

### Channels (`src/core/channels.py`)

Direct messaging between agents and beings.

- **Point-to-point:** `ship.channel.{from}.{to}`
- **Group channels:** `ship.channel.group.{group_id}`
- **Message history:** JetStream-backed for replay

### KV Store (`src/core/kv_store.py`)

Shared state via NATS KV buckets.

- **Typed access:** Get/put/delete with JSON serialization
- **Watch:** Real-time notifications on key changes
- **TTL support:** Auto-expiring keys

### Object Store (`src/core/object_store.py`)

Large file storage via NATS Object Store.

- **Chunked uploads:** Handles files larger than NATS message limits
- **Metadata:** Attach metadata to stored objects
- **Versioning:** Object revision tracking

## Adapters

Adapters bridge external protocols to the NATS core.

### WebSocket Adapter (`adapters/websocket/`)

The primary adapter for real-time client communication. Runs standalone without NATS (Day 1 mode) or bridges WebSocket to NATS (Day 2+).

Components:
- **server.js** — WebSocket relay with Bonjour/mDNS discovery
- **agent-daemon.js** — Spawns Claude Code sessions for incoming messages
- **mcp-server.js** — MCP tool integration for Claude Code
- **session-watcher.js** — Streams Claude Code conversation transcripts

### MCP Adapter

Provides MCP (Model Context Protocol) tools for LLM agents to interact with the ship.

### HTTP/SSE Adapter (planned)

RESTful API with Server-Sent Events for dashboards and web clients.

## Per-Machine Isolation

Each machine runs its own noesis-ship instance. There is no broadcast cross-talk between machines. Communication paths:

```
M5 (MacBook)          Mini (Mac Mini)        DGX (GPU Server)
┌──────────┐          ┌──────────┐           ┌──────────┐
│ noesis-  │          │ noesis-  │           │ noesis-  │
│ ship     │          │ ship     │           │ ship     │
│ :3100    │          │ :3100    │           │ :3100    │
└────▲─────┘          └────▲─────┘           └────▲─────┘
     │                     │                      │
     │    Tailscale VPN    │                      │
     └─────────┬───────────┘──────────────────────┘
               │
        ┌──────┴──────┐
        │ Ships Comm  │
        │ (iOS app)   │
        └─────────────┘
```

Ships Comm connects directly to each machine over Tailscale. Messages sent to M5 go only to M5. Messages sent to Mini go only to Mini.

## Plugin Interface

Plugins wire into the ship via NATS subjects:

```python
# Example: Kanban plugin
class KanbanPlugin:
    async def install(self, bus: EventBus):
        await bus.subscribe("kanban.*", self.handle_event)

    async def handle_event(self, event: ShipEvent):
        match event.event_type:
            case "kanban.item-moved":
                # Handle item movement
                pass
```

## Ship Templates

Ships are configured via YAML templates:

- **Dinghy** — 1 agent (personal assistant)
- **Sloop** — 2 agents (pair programming)
- **Galleon** — 4-8 agents (full team)
- **Carrier** — 8+ agents (multi-team fleet)

See `templates/` for examples.
