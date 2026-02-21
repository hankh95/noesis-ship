---
id: DOC-GETTING-STARTED
type: guide
title: "Getting Started with Noesis Ship"
category: onboarding
audience: [developer, agent]
created: 2026-02-21
tags: [setup, installation, quickstart]
---

# Getting Started

## Prerequisites

- Node.js 18+ (for WebSocket adapter)
- Python 3.11+ (for NATS core, optional for Day 1)
- NATS server (optional — WebSocket adapter works standalone)

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/hankh95/noesis-ship.git
cd noesis-ship
```

### 2. Set up the WebSocket adapter

```bash
cd adapters/websocket
cp .env.example .env
```

Edit `.env`:

```env
WS_PORT=3100
MACHINE_NAME=MyMachine
AGENTS=captain:Captain
```

Install dependencies and start:

```bash
npm install
npm start
```

You should see:

```
[Bridge] Starting Noesis Ship WebSocket Relay...
[Bonjour] Advertising _carclaw._tcp on port 3100
[WebSocket] Server listening on port 3100
```

### 3. Test the connection

In another terminal:

```bash
node test-ws.js
```

### 4. Send a test message

```bash
node send.js "Hello from the ship!"
```

## Setting Up the Agent Daemon

The agent daemon connects to the WebSocket adapter and spawns Claude Code sessions for incoming messages.

```bash
cd adapters/websocket

# Set up environment
export CLAUDE_SESSION_DIR=~/.claude/projects/-Users-you-Projects-yourproject
export MACHINE_NAME=MyMachine

node agent-daemon.js
```

## Setting Up Ships Comm (iOS)

1. Open the Ships Comm app
2. Go to Settings
3. Add a bridge with your machine's IP and port 3100
4. The app will discover available agents via Bonjour or manual entry

## Installing NATS (Optional)

For Day 2+ features (inter-agent communication, event persistence):

```bash
# macOS
brew install nats-server

# Linux
curl -L https://github.com/nats-io/nats-server/releases/latest/download/nats-server-linux-amd64.tar.gz | tar xz
sudo mv nats-server /usr/local/bin/

# Start NATS
nats-server -js  # -js enables JetStream
```

### Python Core Setup

```bash
pip install -e .
```

```python
from noesis_ship.core import EventBus

bus = EventBus()
await bus.connect()  # Connects to nats://localhost:4222
```

## Running as a Service

### macOS (launchd)

Create `~/Library/LaunchAgents/com.noesis-ship.websocket.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.noesis-ship.websocket</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/noesis-ship/adapters/websocket</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>WS_PORT</key>
        <string>3100</string>
        <key>MACHINE_NAME</key>
        <string>MyMachine</string>
        <key>AGENTS</key>
        <string>captain:Captain</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.noesis-ship.websocket.plist
```

### Linux (systemd)

Create `/etc/systemd/system/noesis-ship.service`:

```ini
[Unit]
Description=Noesis Ship WebSocket Adapter
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/noesis-ship/adapters/websocket
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=WS_PORT=3100
Environment=MACHINE_NAME=MyMachine
Environment=AGENTS=captain:Captain

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable noesis-ship
sudo systemctl start noesis-ship
```

## Platform-Specific Guides

### DGX (Ubuntu Linux with systemd)

For production deployment on NVIDIA DGX Spark or other Ubuntu Linux systems with systemd, see the comprehensive [DGX Deployment Guide](deployment/dgx.md), which includes:

- Systemd service configuration
- NATS server setup
- Service management and monitoring
- Security hardening
- Troubleshooting

## Next Steps

- Read the [Architecture](architecture.md) guide
- Learn about [Adapters](adapters.md)
- Explore [Ship Templates](../templates/)
- For production Linux deployment: [DGX Deployment Guide](deployment/dgx.md)
