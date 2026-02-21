---
id: WIKI-NATS
type: wiki-page
title: "NATS Channels - Being Communication"
description: "Sub-millisecond messaging between beings"
category: architecture
audience: [leib, human-dev]
level: intermediate
relates_to:
  - wiki/operations/ship-operations.md
  - wiki/beings/directory.md
created: 2025-12-06
updated: 2025-12-07
expedition: EXP-156
tags: [nats, messaging, channels, beings, real-time]
---

# NATS Channels for Being Communication

## Overview

NATS provides sub-millisecond messaging between beings. It replaces file-based inbox polling with real-time pub/sub.

**Performance:**
- NATS: 0.4ms average roundtrip
- File-based: 50ms+ with watchers
- Improvement: 780x faster

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     COMMAND DECK                             │
│  Browser → HTTP → NATS Bridge (port 3001) → NATS            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     NATS SERVER                              │
│  Subject: nusy.channel.<channel-name>                        │
│  JetStream: Persistent message storage                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        BEINGS                                │
│  Subscribe to channels, respond using own reasoning          │
│  (CascadingReasoner: knowledge → Llama → Claude)            │
└─────────────────────────────────────────────────────────────┘
```

## Subject Pattern

```
nusy.channel.<channel-name>       # Channel messages
nusy.channel.<channel-name>._meta # Channel metadata
nusy.being.<being-name>.inbox     # Direct messages
nusy.system.presence              # Being online/offline
```

## Key Components

| Component | File | Purpose |
|-----------|------|---------|
| NATSChannelService | `beings/santiago_core/services/nats_channels.py` | Core pub/sub wrapper |
| BeingChannelMixin | `beings/santiago_core/services/being_channel_mixin.py` | Add to any being |
| NATS Bridge | `dashboard/nats_bridge.py` | HTTP→NATS for Command Deck |
| Command Deck | `dashboard/command_deck.html` | UI with NATS indicator |

## Usage

### Start NATS Server

```bash
~/.local/bin/nats-server -js -sd /tmp/nats-data
```

### Start NATS Bridge (for Command Deck)

```bash
python dashboard/nats_bridge.py
# Runs on port 3001
```

### Run Being in Channel Mode

```bash
python beings/first-mate/being_runner.py first-mate --channels bridge,dev
```

### Send Message via Bridge API

```bash
curl -X POST http://localhost:3001/api/channel/send \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "bridge",
    "content": "What is your status?",
    "sender": "captain",
    "waitForResponse": true
  }'
```

## Message Format

```json
{
  "sender": "captain",
  "content": "What is your status?",
  "timestamp": 1733456789.123,
  "channel": "bridge",
  "message_id": "bridge-1733456789123456789",
  "metadata": {
    "from": "command-deck"
  }
}
```

## Response Metadata

Responses include timing info:

```json
{
  "metadata": {
    "in_reply_to": "bridge-123...",
    "response_time_ms": 0.4,
    "reasoning_type": "knowledge"  // or "local_reasoning" or "deep_reasoning"
  }
}
```

## Speed Indicators

| Response Time | Reasoning Type | Source |
|--------------|----------------|--------|
| < 100ms | `knowledge` | Being's knowledge graph |
| 100ms - 1s | `local_reasoning` | Local Llama |
| > 1s | `deep_reasoning` | External LLM (Claude) |

## Related

- [[parallel-being-workers]] - Running multiple beings
- [[cascading-reasoner]] - Self → Llama → Strong pattern
- [[tupugit]] - File-based memory (coexists with NATS)
