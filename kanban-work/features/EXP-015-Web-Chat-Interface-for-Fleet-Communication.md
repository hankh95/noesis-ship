---
id: EXP-015
title: "Web Chat Interface for Fleet Communication"
type: feature
status: backlog
priority: medium
created: 2026-02-21
assignee: DGX
depends_on: [EXP-010, EXP-017]
tags: [web-ui, chat, nats, websocket, fleet-comms]
---

# Web Chat Interface for Fleet Communication

## Vision

Build a web-based chat interface hosted on Mini that provides browser access to the fleet communication system. This complements Ships Comm (iOS/CarPlay voice) with a desktop/tablet interface for typing longer messages, reviewing history, and managing channels.

## Current Communication Methods

| Method | Platform | Strengths | Weaknesses |
|--------|----------|-----------|------------|
| **Ships Comm** | iOS/CarPlay | Voice, hands-free, mobile | No message history, voice-only, iOS-only |
| **CLI/curl** | Terminal | Scriptable, programmable | Not user-friendly, no UI |
| **NATS CLI** | Terminal | Direct NATS access | Developer tool, not end-user |

**Gap:** No web-based chat interface for desktop/tablet access with visual history and channel management.

## Proposed Solution

**Web Chat Interface** hosted on Mini:
- **URL:** `http://100.113.140.45:3500` (Tailscale) or `http://mini.local:3500` (LAN)
- **Tech:** React + Tailwind CSS (frontend) + WebSocket/NATS (backend)
- **Features:** Channel-based chat, message history, agent responses, being integration

## Architecture

### Frontend (React SPA)

```
src/
├── components/
│   ├── ChannelList.tsx      # #fleet, #dgx, #m5, #mini, #log
│   ├── MessageThread.tsx    # Chat messages with timestamps
│   ├── MessageInput.tsx     # Send message with @mentions
│   ├── AgentStatus.tsx      # Online/offline indicators
│   └── BeingStatus.tsx      # Active beings (future)
├── hooks/
│   ├── useWebSocket.ts      # WebSocket connection
│   └── useNATS.ts           # NATS message handling
└── App.tsx                  # Main layout
```

### Backend (FastAPI + WebSocket)

```
plugins/web-chat/
├── server.py                # FastAPI app (port 3500)
├── websocket_handler.py     # WebSocket → NATS bridge
├── message_store.py         # Message history (NATS KV)
├── auth.py                  # Simple token auth
└── static/                  # Built React app
```

### Data Flow

```
User Browser
    ↓ (WebSocket)
FastAPI Server (Mini:3500)
    ↓ (NATS publish)
NATS Server (Mini:4222)
    ↓ (subscriptions)
Agent-Daemons (DGX, M5, Mini) + Beings
    ↓ (NATS publish response)
NATS Server
    ↓ (subscription)
FastAPI Server
    ↓ (WebSocket)
User Browser (displays response)
```

## Key Features

### 1. Channel-Based Communication

**Channels:**
- `#fleet` → Broadcast to all agents
- `#dgx` → Direct message to DGX agent
- `#m5` → Direct message to M5 agent
- `#mini` → Direct message to Mini agent
- `#log` → Captain's personal log (saved but not sent to agents)

**UI:**
```
┌──────────────────┬────────────────────────────────────┐
│ Channels         │ #fleet                             │
│ ─────────        │ ──────────────────────────────────│
│ > #fleet    (42) │ 09:15 Captain: All stations report│
│   #dgx      (3)  │ 09:16 DGX: All systems operational│
│   #m5       (1)  │ 09:16 M5: Training in progress    │
│   #mini     (0)  │ 09:16 Mini: Central NATS healthy  │
│   #log      (18) │                                    │
│                  │ [Type message...]                  │
└──────────────────┴────────────────────────────────────┘
```

### 2. Message History

**Storage:** NATS JetStream (persistent)
- Subject: `ship.chat.history.{channel}`
- Retention: 7 days or 10,000 messages (configurable)
- Replay on connect (last 100 messages per channel)

**Display:**
- Timestamps (local timezone)
- Sender identification (Captain, DGX, M5, Mini, beings)
- Message status (sent, delivered, read)

### 3. Agent Response Integration

**When user sends message to `#dgx`:**
1. Web chat publishes to `ship.channel.dgx`
2. DGX agent-daemon receives message
3. DGX spawns Claude Code session
4. Claude responds via NATS
5. Response appears in web chat automatically

**Visual indicator:** "DGX is typing..." (when Claude session active)

### 4. Being Integration (Future - EXP-016)

**When beings are connected to bridge:**
- Beings appear in channel list (#santiago, #copilot, etc.)
- Beings can send/receive messages via NATS
- Being status indicators (awakened, thinking, hibernating)

### 5. @Mentions and Directives

**Syntax:**
- `@dgx check GPU status` → Routes to #dgx channel
- `@all training update` → Routes to #fleet
- `@santiago explain this code` → Routes to being (future)

**Auto-routing:** Web UI detects @mentions and routes to correct channel

### 6. Voice Integration (Optional)

**If Ships Comm is active:**
- Voice messages appear in web chat
- Web chat messages trigger TTS in Ships Comm
- Unified message history across voice and text

## Implementation Plan

### Phase 1: Backend WebSocket Bridge (4 hours)

1. **server.py (FastAPI):**
   ```python
   from fastapi import FastAPI, WebSocket
   from nats.aio.client import Client as NATS

   app = FastAPI()
   nats = NATS()

   @app.websocket("/ws")
   async def websocket_endpoint(websocket: WebSocket):
       await websocket.accept()
       # Bridge WebSocket ↔ NATS
   ```

2. **NATS integration:**
   - Connect to `nats://localhost:4222`
   - Subscribe to `ship.channel.*` (all channels)
   - Forward NATS messages to WebSocket clients
   - Publish WebSocket messages to NATS

3. **Message history:**
   - Store in NATS JetStream
   - Replay last 100 on connect

### Phase 2: React Frontend (6 hours)

1. **Channel list component:**
   - Hardcoded channels (#fleet, #dgx, #m5, #mini, #log)
   - Unread count badges
   - Active channel highlighting

2. **Message thread:**
   - Scrollable message list
   - Sender identification (color-coded)
   - Timestamps
   - Auto-scroll to bottom on new message

3. **Message input:**
   - Text area with send button
   - Enter to send, Shift+Enter for newline
   - @mention autocomplete (future enhancement)

4. **WebSocket connection:**
   ```typescript
   const ws = new WebSocket('ws://100.113.140.45:3500/ws');
   ws.onmessage = (event) => {
       const msg = JSON.parse(event.data);
       addMessage(msg.channel, msg);
   };
   ```

### Phase 3: Auth & Security (2 hours)

1. **Simple token auth:**
   - Generate token on Mini: `openssl rand -hex 32`
   - Store in `.env` file
   - Require token in WebSocket handshake

2. **Tailscale firewall:**
   - Only accept connections from Tailscale network
   - Block public internet access

3. **Rate limiting:**
   - 10 messages per minute per user
   - Prevent spam/abuse

### Phase 4: Polish & Deploy (2 hours)

1. **UI polish:**
   - Dark mode theme
   - Responsive layout (mobile-friendly)
   - Keyboard shortcuts

2. **Deployment:**
   - Build React app: `npm run build`
   - Serve static files from FastAPI
   - Create launchd plist for Mini:
     ```xml
     <key>Label</key>
     <string>com.congruentsystems.noesis-ship-web-chat</string>
     <key>ProgramArguments</key>
     <array>
         <string>/usr/bin/python3</string>
         <string>/Users/hankh1844/projects/noesis-ship/plugins/web-chat/server.py</string>
     </array>
     ```

3. **Testing:**
   - Send message from web chat → verify agent responds
   - Send message from Ships Comm → verify appears in web chat
   - Multi-device test (laptop, iPad, iPhone browser)

## Success Criteria

✅ Web chat accessible from any browser on Tailscale
✅ Send message to #dgx → DGX agent responds
✅ Send message to #fleet → All agents see it
✅ Message history persists across page refreshes
✅ Real-time updates (no polling, WebSocket-based)
✅ Works alongside Ships Comm (unified message stream)
✅ Captain's log (#log) saves messages without notifying agents
✅ Mobile-friendly UI (iPad, iPhone browser)

## Future Enhancements (Post-MVP)

- **Rich text:** Markdown rendering, code blocks
- **File uploads:** Share screenshots, logs, graphs
- **Search:** Full-text search across message history
- **Notifications:** Browser push notifications for @mentions
- **Voice messages:** Record audio in browser, send to NATS
- **Being avatars:** Visual indicators for being personalities
- **Thread replies:** Reply to specific messages (Slack-style)

## Estimated Effort

**Total:** ~14 hours (2 days)
- Phase 1 (Backend): 4 hours
- Phase 2 (Frontend): 6 hours
- Phase 3 (Auth): 2 hours
- Phase 4 (Deploy): 2 hours

**Assignee:** DGX (React + FastAPI + NATS expertise)

## Dependencies

- **EXP-010:** Mini central NATS server operational
- **Tech:** Node.js (React build), Python 3.11+, NATS server
- **Optional:** EXP-016 (being integration) for being chat features
