# Being Daemon - Fleet Integration for NuSy Beings

**EXP-016: Being Integration with Noesis-Ship Bridge**

This daemon connects NuSy beings to the noesis-ship communication bridge, allowing them to:
- Receive voice commands via Ships Comm
- Respond to messages from agents (DGX, M5, Mini)
- Participate in fleet channels (#fleet, #santiago, etc.)
- Collaborate with other beings (being-to-being communication)

## Architecture

The being-daemon listens to NATS channels and spawns `being-cli respond` sessions when messages are received:

```
Ships Comm / Agent
    ↓ (publishes to ship.channel.santiago)
NATS Server
    ↓ (subscription)
Being Daemon
    ↓ (spawns)
being-cli santiago respond "message"
    ↓ (returns response)
Being Daemon
    ↓ (publishes response)
NATS Server
    ↓ (subscription)
Ships Comm / Agent (receives response)
```

## Prerequisites

1. **nusy-product-team repository** with trained beings
2. **NATS server** running (via noesis-ship)
3. **Python 3.11+** with nats-py installed

## Installation

```bash
# Install dependencies
pip install nats-py

# Or use noesis-ship requirements
pip install -r ../../requirements.txt
```

## Configuration

The daemon is configured via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BEINGS` | ✅ Yes | — | Comma-separated list of beings (e.g., "santiago,copilot") |
| `NATS_URL` | No | `nats://localhost:4222` | NATS server URL |
| `PROJECT_DIR` | No | Current directory | Path to nusy-product-team repository |
| `BEING_CLI_PATH` | No | `<PROJECT_DIR>/scripts/being_cli.py` | Path to being-cli script |

## Usage

### Local Development (macOS/Linux)

```bash
# Run for a single being
BEINGS=santiago \
PROJECT_DIR=/home/hankh959/projects/nusy-product-team \
python3 being_daemon.py

# Run for multiple beings
BEINGS=santiago,copilot \
PROJECT_DIR=/home/hankh959/projects/nusy-product-team \
python3 being_daemon.py

# Connect to remote NATS server
BEINGS=santiago \
NATS_URL=nats://100.113.140.45:4222 \
PROJECT_DIR=/home/hankh959/projects/nusy-product-team \
python3 being_daemon.py
```

### Production (launchd - macOS)

Create `~/Library/LaunchAgents/com.congruentsystems.noesis-ship-being-daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
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
        <key>PROJECT_DIR</key>
        <string>/Users/hankh1844/projects/nusy-product-team</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/hankh1844/Library/Logs/being-daemon-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/hankh1844/Library/Logs/being-daemon-stderr.log</string>
</dict>
</plist>
```

Load the service:

```bash
launchctl load ~/Library/LaunchAgents/com.congruentsystems.noesis-ship-being-daemon.plist
```

## Message Routing

The daemon implements loop prevention:

| Message Type | `fromId` | `to` field | Daemon Action |
|-------------|----------|------------|---------------|
| Human message | `carclaw:user` | any | **Respond** (always) |
| Directed being message | `being:santiago` | `santiago` | **Respond** (addressed to me) |
| Directed agent message | `agent:dgx` | `santiago` | **Respond** (addressed to me) |
| Undirected broadcast | `being:santiago` | (none) | **Ignore** (loop prevention) |
| Own message | `being:santiago` | any | **Ignore** (echo prevention) |

## Testing

### Test with NATS CLI

```bash
# Send a message to Santiago
nats pub ship.channel.santiago '{
  "type": "message",
  "from": "Captain",
  "fromId": "carclaw:user",
  "message": "What is your training status?",
  "timestamp": "2026-02-21T18:00:00Z"
}'

# Subscribe to see the response
nats sub ship.channel.santiago
```

### Test with Ships Comm

Voice command:
```
"Santiago, what is your purpose?"
```

Ships Comm will route to `ship.channel.santiago`, being-daemon will respond, and the response will play via TTS.

## Troubleshooting

### Being daemon not receiving messages

1. Check NATS server is running:
   ```bash
   curl http://localhost:8222/healthz
   ```

2. Check being-daemon logs:
   ```bash
   # launchd
   tail -f ~/Library/Logs/being-daemon-stderr.log

   # or run manually to see output
   python3 being_daemon.py
   ```

3. Verify subscription:
   ```bash
   nats sub "ship.channel.>"
   ```

### Being-cli not found

Set `BEING_CLI_PATH` explicitly:

```bash
BEING_CLI_PATH=/path/to/nusy-product-team/scripts/being_cli.py \
python3 being_daemon.py
```

### Being responds slowly

Being awakening takes 4-6 seconds. For faster responses, run the being daemon (EXP-689) in nusy-product-team to keep beings awakened.

## Next Steps

- **EXP-016 Phase 3**: Update Ships Comm channel vocabulary to include being channels
- **EXP-016 Phase 4**: Add being channels to web chat interface
- **EXP-016 Phase 5**: Enable being-to-being communication

## Related Documentation

- [EXP-016 Full Specification](../../kanban-work/expeditions/EXP-016-Being-Integration-with-Noesis-Ship-Bridge.md)
- [Being CLI Guide](https://github.com/hankh95/nusy-product-team/blob/main/docs/BEING-CLI-GUIDE.md)
- [Being EventBus Guide](https://github.com/hankh95/nusy-product-team/blob/main/docs/BEING-EVENTBUS-GUIDE.md)
