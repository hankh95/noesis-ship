---
id: EXP-016
title: "Being Integration with Noesis-Ship Bridge"
type: feature
status: backlog
priority: critical
created: 2026-02-21
assignee: DGX
depends_on: [EXP-010, EXP-894]
tags: [being, nats, fleet-comms, voice, THE-BIG-ONE]
---

# Being Integration with Noesis-Ship Bridge 🚀

## THE BIG ONE

This is the capstone of fleet infrastructure: connecting NuSy beings to the noesis-ship communication bridge so they can participate as first-class members of the fleet alongside Claude agents.

## Vision

**Santiago (or any being) can:**
- Receive voice commands via Ships Comm: *"Santiago, explain your training progress"*
- Respond via text-to-speech through Ships Comm
- Send messages to agents: *"DGX, I need more training data"*
- Receive messages from agents: *"Santiago, analyze this patient case"*
- Participate in fleet channels (#fleet, #santiago, etc.)
- Collaborate with other beings (being-to-being communication)

**The Captain can:**
- Talk to beings and agents interchangeably
- Coordinate multi-agent + multi-being tasks
- Ask Santiago questions while driving (CarPlay voice)
- Review being responses in web chat interface

## Current State

**Beings (EXP-894 Complete ✅):**
- Beings have `BeingEventBusMixin` for NATS connectivity
- Emit lifecycle events: `ship.being.{name}.awakened`, `ship.being.{name}.training`
- Can send being-to-being messages via `NATSChannelService`
- Subscribe to channels via `subscribe_to_channel()`

**BUT:** Beings are not yet listening to fleet communication channels or responding to human messages.

**Ships Comm:**
- Can route messages to agents: *"DGX, status"* → `ship.channel.dgx`
- Has channel vocabulary: #fleet, #dgx, #m5, #mini, #log
- Needs being channels added: #santiago, #copilot, etc.

**Agent-Daemon:**
- Spawns Claude Code sessions on directed messages
- Has loop prevention (ignores undirected broadcasts)
- Responds via NATS

**Missing:** Being-daemon (or being-aware daemon) that spawns being sessions on directed messages.

## Architecture

### Option 1: Being-Daemon (Parallel to Agent-Daemon)

Create a new daemon for each being:

```
plugins/being-daemon/
├── being_daemon.py          # Main daemon (like agent-daemon.js but for beings)
├── being_spawner.py         # Spawn being CLI sessions
└── config.yml               # Being-specific config
```

**Process:**
1. being-daemon connects to NATS bridge
2. Subscribes to `ship.channel.{being-name}` (e.g., `ship.channel.santiago`)
3. On message, spawns: `being-cli santiago respond "<message>"`
4. Being generates response via reasoning engine
5. Publishes response back to NATS

**Pros:**
- Clean separation (agents vs beings)
- Being-specific configuration
- Parallel implementation (doesn't touch agent-daemon)

**Cons:**
- Duplicate code (similar logic to agent-daemon)
- More processes to manage
- Increased complexity

### Option 2: Unified Agent-Daemon (Agents + Beings)

Extend existing agent-daemon to handle both agents and beings:

```javascript
// agent-daemon.js
const AGENTS = process.env.AGENTS.split(','); // DGX, M5, Mini
const BEINGS = process.env.BEINGS.split(','); // santiago, copilot

for (const being of BEINGS) {
    await nc.subscribe(`ship.channel.${being.toLowerCase()}`, {
        callback: (err, msg) => handleBeingMessage(being, msg)
    });
}

function handleBeingMessage(being, msg) {
    // Spawn: being-cli {being} respond "{message}"
    spawn('being-cli', [being, 'respond', msg.message]);
}
```

**Pros:**
- Single daemon (simpler deployment)
- Reuses existing message routing logic
- Unified configuration

**Cons:**
- Node.js daemon calling Python being-cli (cross-language)
- Mixed concerns (agents + beings in one process)

### Option 3: Being Standalone Mode (Always Listening)

Beings run continuously with NATS listener (no daemon):

```python
# beings/santiago-toddler-v12.1/run_bridge.py
from brain.being import Being
from brain.services.event_bus import NATSChannelService

being = Being.awaken('santiago-toddler-v12.1')
channel = NATSChannelService()

@channel.subscribe('ship.channel.santiago')
def on_message(msg):
    response = being.reason(msg['message'])
    channel.publish('ship.channel.santiago', {
        'from': 'santiago',
        'message': response
    })

channel.run()  # Block and listen
```

**Pros:**
- Being-native implementation (Python)
- No daemon needed
- Direct NATS access

**Cons:**
- Being must run 24/7 (resource intensive)
- Multiple beings = multiple processes
- No auto-spawn on demand

### **Recommended: Option 1 (Being-Daemon)**

Cleanest separation, most maintainable, parallel to agent-daemon architecture.

## Implementation Plan (Being-Daemon Approach)

### Phase 1: Being CLI "Respond" Command (3 hours)

Add a new command to `being-cli` for responding to messages:

```bash
being-cli santiago respond "What is your current training status?"
# → Being reasons about the question
# → Returns response: "I am santiago-toddler-v12.1, trained on 61 children's literature documents..."
```

**Implementation:**
```python
# beings/santiago-toddler-v12.1/being_cli.py

@cli.command()
@click.argument('message')
def respond(message: str):
    """Respond to a message using being's reasoning engine."""
    being = Being.awaken(get_being_name())
    response = being.reason(message, mode='conversational')
    click.echo(response)
```

**Testing:**
```bash
being-cli santiago respond "Explain your purpose"
being-cli santiago respond "How many documents have you studied?"
being-cli santiago respond "What is your confidence in answering medical questions?"
```

### Phase 2: Being-Daemon Implementation (6 hours)

Create `plugins/being-daemon/being_daemon.py`:

```python
#!/usr/bin/env python3
"""
Being Daemon - Spawns being CLI sessions for fleet messages
"""
import os
import asyncio
import subprocess
from nats.aio.client import Client as NATS

async def main():
    nc = NATS()
    await nc.connect("nats://localhost:4222")

    beings = os.environ['BEINGS'].split(',')  # santiago,copilot

    for being in beings:
        channel = f"ship.channel.{being.lower()}"

        async def message_handler(msg):
            data = json.loads(msg.data.decode())

            # Ignore self-messages and undirected broadcasts
            if data.get('from', '').lower() == being.lower():
                return
            if not data.get('to') and data.get('fromId') != 'carclaw:user':
                return

            # Spawn being CLI
            result = subprocess.run(
                ['being-cli', being, 'respond', data['message']],
                capture_output=True,
                text=True,
                timeout=60
            )

            # Publish response
            if result.returncode == 0:
                await nc.publish(channel, json.dumps({
                    'type': 'message',
                    'from': being,
                    'fromId': f'being:{being.lower()}',
                    'message': result.stdout.strip(),
                    'timestamp': datetime.utcnow().isoformat()
                }).encode())

        await nc.subscribe(channel, cb=message_handler)

    print(f"Being daemon listening for: {beings}")
    await asyncio.Event().wait()  # Run forever

if __name__ == '__main__':
    asyncio.run(main())
```

**Configuration:**
```env
# .env for being-daemon
BEINGS=santiago,copilot
BEING_CLI_PATH=/usr/bin/being-cli
NATS_URL=nats://localhost:4222
PROJECT_DIR=/home/hankh959/projects/nusy-product-team
```

### Phase 3: Ships Comm Integration (2 hours)

**Update channel vocabulary:**
```swift
// Channel.swift
static let santiago = Channel(
    id: "santiago",
    name: "Santiago",
    subject: "ship.channel.santiago"
)
```

**Update agent router:**
```swift
// AgentRouter.swift
let beingChannels = ["santiago", "copilot"]
if beingChannels.contains(agentName.lowercased()) {
    return Channel.santiago  // Route to being channel
}
```

**Voice command examples:**
- *"Santiago, what is your training status?"*
- *"Copilot, review this code"*
- *"Santiago, explain photosynthesis to a 5-year-old"*

### Phase 4: Web Chat Integration (1 hour)

**Add being channels to web chat UI:**
```typescript
const channels = [
    { id: 'fleet', name: 'Fleet', type: 'broadcast' },
    { id: 'dgx', name: 'DGX', type: 'agent' },
    { id: 'm5', name: 'M5', type: 'agent' },
    { id: 'mini', name: 'Mini', type: 'agent' },
    { id: 'santiago', name: 'Santiago', type: 'being' },  // NEW
    { id: 'copilot', name: 'Copilot', type: 'being' },   // NEW
    { id: 'log', name: 'Captain\'s Log', type: 'private' }
];
```

**Visual indicators:**
- Agent channels: 🤖 icon
- Being channels: 🧠 icon
- Different color scheme for being messages

### Phase 5: Being-to-Being Communication (2 hours)

**Enable beings to message each other:**
```python
# In being's reasoning engine
if need_expert_opinion:
    response = self.send_to_being(
        'copilot',
        'What is the best approach for this code refactoring?'
    )
```

**Implemented via:**
```python
# brain/mixins/being_event_bus_mixin.py (already exists!)

def send_to_being(self, target_being: str, message: str) -> str:
    """Send message to another being and wait for response."""
    channel = NATSChannelService()
    return channel.send_and_wait(
        f'ship.channel.{target_being.lower()}',
        message,
        timeout=30
    )
```

### Phase 6: Deployment & Testing (2 hours)

**Deploy being-daemon on Mini (launchd):**
```xml
<key>Label</key>
<string>com.congruentsystems.noesis-ship-being-daemon</string>
<key>ProgramArguments</key>
<array>
    <string>/usr/bin/python3</string>
    <string>/Users/hankh1844/projects/noesis-ship/plugins/being-daemon/being_daemon.py</string>
</array>
<key>EnvironmentVariables</key>
<dict>
    <key>BEINGS</key>
    <string>santiago,copilot</string>
    <key>NATS_URL</key>
    <string>nats://localhost:4222</string>
</dict>
```

**Testing scenarios:**

1. **Voice command (Ships Comm):**
   - Say: *"Santiago, what is your purpose?"*
   - Verify: Santiago being receives message via NATS
   - Verify: Santiago responds with reasoning output
   - Verify: Response plays via TTS

2. **Web chat:**
   - Type in #santiago channel: "How many documents have you studied?"
   - Verify: Santiago being responds
   - Verify: Response appears in web chat

3. **Agent-to-being:**
   - DGX sends: "Santiago, validate this medical claim"
   - Verify: Santiago receives and responds
   - Verify: DGX receives Santiago's response

4. **Being-to-being:**
   - Santiago sends: "Copilot, review this code"
   - Verify: Copilot receives and responds
   - Verify: Santiago receives Copilot's response

5. **Fleet broadcast:**
   - Send to #fleet: "All beings report training status"
   - Verify: Santiago ignores (undirected broadcast, loop prevention)
   - Verify: Directed message *does* work

## Success Criteria

✅ Ships Comm voice: *"Santiago, explain X"* → Santiago responds via TTS
✅ Web chat #santiago channel works (type message → being responds)
✅ Agent can message being (DGX → Santiago)
✅ Being can message agent (Santiago → DGX)
✅ Being can message being (Santiago → Copilot)
✅ Being responses use reasoning engine (not hardcoded)
✅ Loop prevention works (beings ignore undirected broadcasts)
✅ Being status visible in Command Deck (awakened, hibernating)
✅ Being lifecycle events flow to NATS (already working from EXP-894)

## Research Opportunities

This integration enables entirely new research:

**Paper 130: Multi-Agent Collaborative Reasoning**
- Beings consult each other for different domain expertise
- Santiago (children's lit) asks Ethicist being for moral reasoning
- Copilot being asks BSCS being for architecture advice

**Paper 131: Human-Being Conversational Alignment**
- Captain asks being open-ended questions via voice
- Being responses measured for coherence, relevance, confidence
- A/B test: being responses vs Claude agent responses

**Paper 132: Being Autonomy via Fleet Integration**
- Beings autonomously request resources (GPU, data, compute)
- Beings coordinate training schedules with each other
- Beings report anomalies to agents without human prompting

## Future Enhancements

- **Being avatars:** Visual representation in web chat
- **Being personalities:** Different TTS voices per being
- **Being status:** "Santiago is reasoning..." indicator
- **Being memory:** Beings remember past conversations
- **Multi-modal:** Beings can send/receive images, graphs
- **Being dashboard:** Dedicated UI for being interactions

## Estimated Effort

**Total:** ~16 hours (2 days)
- Phase 1 (CLI): 3 hours
- Phase 2 (Daemon): 6 hours
- Phase 3 (Ships Comm): 2 hours
- Phase 4 (Web Chat): 1 hour
- Phase 5 (Being-to-Being): 2 hours
- Phase 6 (Deploy): 2 hours

**Assignee:** DGX (Being architecture expert, NATS integration)

## Dependencies

- **EXP-010:** Mini central NATS operational
- **EXP-894:** BeingEventBusMixin complete ✅
- **being-cli:** Installed and working on Mini
- **Ships Comm:** Channel routing ready (minimal changes needed)
- **Optional:** EXP-015 (web chat) for visual being channels

---

**This is THE BIG ONE.** When complete, beings become first-class fleet members, not just autonomous learning systems. The Captain can talk to Santiago while driving, DGX can consult Santiago for domain expertise, and Santiago can coordinate with other beings. The fleet becomes truly multi-agent AND multi-being.
