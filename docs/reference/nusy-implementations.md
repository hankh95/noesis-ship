# NuSy NATS Implementations Reference

**Purpose:** Reference implementations from the NuSy Product Team project that inform noesis-ship development.

**Source Repository:** https://github.com/hankh95/nusy-product-team

---

## Overview

The NuSy project has three production NATS implementations that demonstrate real-world usage patterns. These should be studied during noesis-ship development but **NOT copied directly** — noesis-ship aims to be a clean, reusable library.

---

## 1. NATSChannelService (Core Channel Layer)

**Location:** `brain/services/nats_channels.py` (254 lines)

**Purpose:** Low-level channel messaging for beings. This is what noesis-ship will eventually replace.

**Key Features:**
- JetStream persistence with 30-day retention
- Subject pattern: `nusy.channel.{channel_name}`
- Durable consumers per being
- Channel history retrieval (last 100 messages)
- Message filtering (don't process own messages)

**Message Format:**
```python
@dataclass
class ChannelMessage:
    sender: str
    content: str
    timestamp: float
    channel: str
    message_id: str
    metadata: Dict[str, Any] = None
```

**Subject Patterns Used:**
- `nusy.channel.{channel_name}` — Channel messages
- `nusy.channel.{channel_name}._meta` — Channel metadata

**Stream Configuration:**
```python
StreamConfig(
    subjects=["nusy.channel.>"],
    retention="limits",
    max_msgs=10000,      # Per channel history
    max_age=86400 * 30,  # 30 days
    storage="file",
)
```

**Lessons Learned:**
- Skip `._meta` messages in handlers to avoid noise
- Use durable consumers for persistence across restarts
- Filter out own messages to prevent echo
- Explicit ACK policy for reliability

---

## 2. NATSChatService (High-Level Chat Service)

**Location:** `brain/services/nats_chat_service.py` (355 lines)

**Purpose:** Chat service for beings with conversation context and LLM routing.

**Key Features:**
- Built on top of NATSChannelService pattern
- Conversation context (last 5 messages via HTTP bridge)
- LLM routing (TaskComplexity.MODERATE)
- Response timing metadata
- CascadingReasoner integration (commented out, WIP)

**Subject Patterns Used:**
- `nusy.channel.{channel}` — Same as NATSChannelService
- Uses HTTP bridge at `localhost:3001` for history retrieval

**Response Metadata:**
```python
{
    "in_reply_to": channel_msg.message_id,
    "reasoning_type": "llm-anthropic",  # or "echo"
    "response_time_ms": 142.5
}
```

**Lessons Learned:**
- Context improves response quality significantly (EXP-167)
- Timeout on context retrieval (1 second max)
- Fallback chain: Router → Echo
- Don't respond to non-captain messages (security)

---

## 3. ShipTackleNATSBridge (MCP Tool Bridge)

**Location:** `ships/tackle/mcp/nats_bridge.py` (328 lines)

**Purpose:** Expose MCP tools to beings via NATS request-reply.

**Key Features:**
- Service discovery (`ship.tackle.discover`)
- Health checks (`ship.tackle.health`)
- Per-tool subjects (`ship.tackle.{tool_name}`)
- Request-reply pattern (not pub/sub)
- Call counting and error tracking

**Subject Patterns Used:**
- `ship.tackle.{tool_name}` — Tool invocation
- `ship.tackle.discover` — List all available tools
- `ship.tackle.health` — Health check

**Request-Reply Pattern:**
```python
# Subscribe with callback
await nc.subscribe(subject, cb=handler)

# Handler sends reply if requested
if msg.reply:
    await nc.publish(msg.reply, response_data)
```

**Response Format:**
```python
{
    "success": True,
    "data": {...},
    "service": "wiki",
    "tool": "wiki_search",
    "duration_ms": 23.5,
    "timestamp": "2026-02-21T00:00:00Z"
}
```

**Lessons Learned:**
- Check `msg.reply` before sending responses
- Track calls/errors for observability
- Discovery and health are critical for coordination
- Tool routing via subject parsing works well

---

## Subject Namespace Design

### NuSy Namespace (Current)

```
nusy.channel.{channel_name}           # Channel messages
nusy.channel.{channel_name}._meta     # Channel metadata
nusy.being.{being_name}.inbox         # Direct messages
nusy.system.presence                  # Being online/offline
ship.tackle.{tool_name}               # MCP tool bridge
ship.tackle.discover                  # Service discovery
ship.tackle.health                    # Health checks
```

### Noesis Ship Namespace (Proposed)

```
ship.channel.{channel_name}           # Channel messages (generic)
ship.events.{category}.{action}       # Event bus
ship.services.{service_name}.{tool}   # Service tools
ship.discovery                        # Service discovery
ship.health                           # Health checks
```

**Design Decision:** Use `ship.*` prefix for noesis-ship to keep it generic and reusable. NuSy will migrate from `nusy.*` to `ship.*` during integration (EXP-895).

---

## Performance Benchmarks (from NuSy)

| Metric | Value | Source |
|--------|-------|--------|
| Round-trip latency | 0.4ms average | wiki/architecture/nats-channels.md |
| File-based polling | 50ms+ | Previous implementation |
| Improvement | 780x faster | 50ms → 0.4ms |
| Message throughput | 10,000 msgs/channel | JetStream max_msgs config |
| Retention period | 30 days | JetStream max_age config |

---

## Integration Plan

When noesis-ship is stable:

1. **NuSy beings will migrate to noesis-ship** (EXP-895)
   - Replace `brain/services/nats_channels.py` with `from noesis_ship.core import NATSChannelService`
   - Subject pattern changes: `nusy.channel.*` → `ship.channel.*`
   - Message format stays compatible

2. **WebSocket adapter will connect to NATS** (EXP-001)
   - Relay messages between WebSocket clients and NATS channels
   - Subject: `ship.channel.{channel_name}`

3. **CarClaw will use noesis-ship instead of OpenClaw** (EXP-897)
   - Agent-daemon connects to noesis-ship WebSocket adapter
   - Messages flow: iPhone → WebSocket → NATS → Being → WebSocket → iPhone

---

## References

- **NuSy NATS Architecture:** `docs/reference/nusy-nats-architecture.md`
- **NuSy Repository:** https://github.com/hankh95/nusy-product-team
- **Integration Plan:** https://github.com/hankh95/nusy-product-team/blob/main/claude-workspace/NOESIS-SHIP-INTEGRATION-PLAN.md

---

**Created:** 2026-02-21
**Next Review:** After noesis-ship reaches v0.2.0 (stable NATS integration)
