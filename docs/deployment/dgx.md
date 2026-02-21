# DGX Deployment Guide

Complete guide for deploying Noesis Ship on NVIDIA DGX Spark (Ubuntu Linux) with systemd service management.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Environment Configuration](#environment-configuration)
4. [Systemd Service Setup](#systemd-service-setup)
5. [NATS Server Configuration](#nats-server-configuration)
6. [Service Management](#service-management)
7. [Health Monitoring](#health-monitoring)
8. [Log Management](#log-management)
9. [Security Considerations](#security-considerations)
10. [Troubleshooting](#troubleshooting)

## Prerequisites

### System Requirements

- Ubuntu Linux (tested on 6.14.0-1015-nvidia)
- Node.js 18+ (installed at `/usr/bin/node`)
- Python 3.11+ (for NATS core)
- systemd 255+
- Network access on port 3100 (WebSocket) and 4222 (NATS)

### Required Permissions

You'll need:
- sudo access for systemd service installation
- User account with proper permissions for `/home/hankh959/projects/noesis-ship`
- Firewall configuration rights (if using UFW or iptables)

## Installation

### 1. Clone the Repository

```bash
cd /home/hankh959/projects
git clone https://github.com/hankh95/noesis-ship.git
cd noesis-ship
```

### 2. Install WebSocket Adapter Dependencies

```bash
cd adapters/websocket
npm install
```

### 3. Install Python Core (Optional for Day 2+)

```bash
cd /home/hankh959/projects/noesis-ship
pip install -e .
```

### 4. Install NATS Server

If not already installed:

```bash
# Download and install NATS server
curl -L https://github.com/nats-io/nats-server/releases/latest/download/nats-server-linux-arm64.tar.gz | tar xz
sudo mv nats-server /usr/local/bin/
sudo chmod +x /usr/local/bin/nats-server

# Verify installation
nats-server --version
```

Or if using user-local installation:

```bash
# NATS already at ~/.local/bin/nats-server
export PATH="$HOME/.local/bin:$PATH"
nats-server --version
```

## Environment Configuration

### Create .env File

```bash
cd /home/hankh959/projects/noesis-ship/adapters/websocket
cp .env.example .env
```

Edit `.env` for DGX:

```env
# WebSocket port for client connections
WS_PORT=3100

# Agent roster — format: id:Name,id:Name
AGENTS=dgx:DGX,mini:Mini,m5:M5,copilot:Copilot

# Display name for this machine's agent
MACHINE_NAME=DGX

# Claude Code session watcher (optional)
# Path to Claude project sessions dir
CLAUDE_SESSION_DIR=/home/hankh959/.claude/projects/-home-hankh959-projects-noesis-ship

# Default group ID for session messages
SESSION_GROUP_ID=fleet

# HTTP port for agent API (default: WS_PORT + 2)
AGENT_API_PORT=3102

# NATS connection (for Day 2+ features)
NATS_URL=nats://localhost:4222
```

### Environment Variables for Services

Key environment variables for systemd services:

| Variable | Value | Purpose |
|----------|-------|---------|
| `WS_PORT` | `3100` | WebSocket server port |
| `MACHINE_NAME` | `DGX` | Agent display name |
| `AGENTS` | `dgx:DGX,mini:Mini,m5:M5` | Agent roster |
| `NATS_URL` | `nats://localhost:4222` | NATS server connection |
| `NODE_ENV` | `production` | Node.js environment |
| `PROJECT_DIR` | `/home/hankh959/projects/noesis-ship` | Project root |
| `CLAUDE_BIN` | `/usr/local/bin/claude` | Claude CLI path |

## Systemd Service Setup

### Service File Locations

Systemd service files are placed in `/etc/systemd/system/`:

- `nats-server.service` — NATS message broker
- `noesis-ship-websocket.service` — WebSocket adapter
- `noesis-ship-agent-daemon.service` — Agent daemon (Claude Code spawner)

### 1. NATS Server Service

Create `/etc/systemd/system/nats-server.service`:

```ini
[Unit]
Description=NATS Server - Message Broker for Noesis Ship
Documentation=https://docs.nats.io/
After=network.target
Before=noesis-ship-websocket.service noesis-ship-agent-daemon.service

[Service]
Type=simple
User=hankh959
Group=hankh959
ExecStart=/home/hankh959/.local/bin/nats-server -js -c /home/hankh959/projects/noesis-ship/config/nats-server.conf
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nats-server

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/tmp

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target
```

### 2. WebSocket Adapter Service

Create `/etc/systemd/system/noesis-ship-websocket.service`:

```ini
[Unit]
Description=Noesis Ship WebSocket Adapter
Documentation=https://github.com/hankh95/noesis-ship
After=network.target nats-server.service
Wants=nats-server.service

[Service]
Type=simple
User=hankh959
Group=hankh959
WorkingDirectory=/home/hankh959/projects/noesis-ship/adapters/websocket
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=noesis-ship-ws

# Environment variables
Environment=NODE_ENV=production
Environment=WS_PORT=3100
Environment=MACHINE_NAME=DGX
Environment=AGENTS=dgx:DGX,mini:Mini,m5:M5,copilot:Copilot
Environment=NATS_URL=nats://localhost:4222

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/hankh959/projects/noesis-ship

# Resource limits
LimitNOFILE=4096
LimitNPROC=512

[Install]
WantedBy=multi-user.target
```

### 3. Agent Daemon Service

Create `/etc/systemd/system/noesis-ship-agent-daemon.service`:

```ini
[Unit]
Description=Noesis Ship Agent Daemon - Claude Code Spawner
Documentation=https://github.com/hankh95/noesis-ship
After=network.target noesis-ship-websocket.service
Wants=noesis-ship-websocket.service

[Service]
Type=simple
User=hankh959
Group=hankh959
WorkingDirectory=/home/hankh959/projects/noesis-ship/adapters/websocket
ExecStart=/usr/bin/node agent-daemon.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=noesis-ship-agent

# Environment variables
Environment=NODE_ENV=production
Environment=BRIDGE_URL=ws://localhost:3100
Environment=PROJECT_DIR=/home/hankh959/projects/noesis-ship
Environment=CLAUDE_BIN=/usr/local/bin/claude
Environment=AGENT_NAME=DGX
Environment=MAX_TURNS=10

# Security (relaxed for Claude Code spawning)
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/hankh959/projects/noesis-ship
ReadWritePaths=/home/hankh959/.claude

# Resource limits (higher for LLM inference)
LimitNOFILE=8192
LimitNPROC=1024

[Install]
WantedBy=multi-user.target
```

### Install Services

```bash
# Copy service files to systemd directory
sudo cp config/systemd/nats-server.service /etc/systemd/system/
sudo cp config/systemd/noesis-ship-websocket.service /etc/systemd/system/
sudo cp config/systemd/noesis-ship-agent-daemon.service /etc/systemd/system/

# Reload systemd configuration
sudo systemctl daemon-reload

# Enable services to start on boot
sudo systemctl enable nats-server
sudo systemctl enable noesis-ship-websocket
sudo systemctl enable noesis-ship-agent-daemon
```

## NATS Server Configuration

### Create NATS Configuration File

Create `/home/hankh959/projects/noesis-ship/config/nats-server.conf`:

```conf
# NATS Server Configuration for Noesis Ship
# DGX deployment

# Network
listen: 0.0.0.0:4222
http: 0.0.0.0:8222  # Monitoring port

# JetStream (persistent messaging)
jetstream {
    store_dir: /home/hankh959/projects/noesis-ship/data/jetstream
    max_mem: 1G
    max_file: 10G
}

# Limits
max_payload: 10MB
max_connections: 1000
ping_interval: 30s
ping_max: 3

# Logging
debug: false
trace: false
logtime: true
log_file: /home/hankh959/projects/noesis-ship/logs/nats-server.log
```

### Create Required Directories

```bash
cd /home/hankh959/projects/noesis-ship
mkdir -p data/jetstream
mkdir -p logs
mkdir -p config/systemd
```

## Service Management

### Start Services

Start all services in dependency order:

```bash
# Start NATS server first
sudo systemctl start nats-server

# Wait for NATS to be ready
sleep 2

# Start WebSocket adapter
sudo systemctl start noesis-ship-websocket

# Start agent daemon
sudo systemctl start noesis-ship-agent-daemon
```

Or start all at once (systemd will handle dependencies):

```bash
sudo systemctl start nats-server noesis-ship-websocket noesis-ship-agent-daemon
```

### Stop Services

```bash
# Stop all services
sudo systemctl stop noesis-ship-agent-daemon noesis-ship-websocket nats-server

# Or stop individually
sudo systemctl stop noesis-ship-agent-daemon
sudo systemctl stop noesis-ship-websocket
sudo systemctl stop nats-server
```

### Restart Services

```bash
# Restart individual service
sudo systemctl restart noesis-ship-websocket

# Restart all services
sudo systemctl restart nats-server noesis-ship-websocket noesis-ship-agent-daemon
```

### Check Service Status

```bash
# Check all Noesis Ship services
sudo systemctl status nats-server
sudo systemctl status noesis-ship-websocket
sudo systemctl status noesis-ship-agent-daemon

# One-line status for all services
sudo systemctl status nats-server noesis-ship-websocket noesis-ship-agent-daemon
```

### View Service Details

```bash
# Show detailed service configuration
systemctl show noesis-ship-websocket

# Check if service is enabled
systemctl is-enabled noesis-ship-websocket

# List all Noesis Ship services
systemctl list-units 'noesis-ship*' 'nats-server*'
```

## Health Monitoring

### Service Health Checks

#### 1. Check Service Status

```bash
# Quick health check
sudo systemctl is-active nats-server
sudo systemctl is-active noesis-ship-websocket
sudo systemctl is-active noesis-ship-agent-daemon
```

Expected output: `active` for all services.

#### 2. Check NATS Server Health

```bash
# Check NATS monitoring endpoint
curl http://localhost:8222/varz

# Check if NATS is listening
netstat -tulpn | grep 4222
```

Expected output: JSON health data and listening socket.

#### 3. Check WebSocket Adapter

```bash
# Check if WebSocket is listening
netstat -tulpn | grep 3100

# Test WebSocket connection
cd /home/hankh959/projects/noesis-ship/adapters/websocket
node test-ws.js
```

Expected output: WebSocket connection established.

#### 4. Check Agent API

```bash
# Check agent API health
curl http://localhost:3102/health
```

Expected output: `{"status":"ok","agent":"DGX","uptime":...}`

### Automated Health Monitoring Script

Create `/home/hankh959/projects/noesis-ship/scripts/health-check.sh`:

```bash
#!/bin/bash
# Noesis Ship Health Check Script for DGX

echo "=== Noesis Ship Health Check ==="
echo "Timestamp: $(date)"
echo ""

# Check services
echo "--- Services ---"
for service in nats-server noesis-ship-websocket noesis-ship-agent-daemon; do
    status=$(systemctl is-active $service)
    if [ "$status" = "active" ]; then
        echo "✓ $service: $status"
    else
        echo "✗ $service: $status"
    fi
done

echo ""
echo "--- Network ---"
for port in 4222 3100 8222; do
    if netstat -tulpn 2>/dev/null | grep -q ":$port "; then
        echo "✓ Port $port: listening"
    else
        echo "✗ Port $port: not listening"
    fi
done

echo ""
echo "--- NATS Health ---"
curl -s http://localhost:8222/varz | jq -r '"Connections: \(.connections) | Uptime: \(.uptime)"' 2>/dev/null || echo "✗ NATS monitoring unavailable"

echo ""
echo "--- Agent API Health ---"
curl -s http://localhost:3102/health | jq . 2>/dev/null || echo "✗ Agent API unavailable"

echo ""
echo "=== End Health Check ==="
```

Make executable:

```bash
chmod +x /home/hankh959/projects/noesis-ship/scripts/health-check.sh
```

Run health check:

```bash
/home/hankh959/projects/noesis-ship/scripts/health-check.sh
```

### Set Up Cron Job for Health Monitoring

```bash
# Edit crontab
crontab -e

# Add health check every 5 minutes
*/5 * * * * /home/hankh959/projects/noesis-ship/scripts/health-check.sh >> /home/hankh959/projects/noesis-ship/logs/health-check.log 2>&1
```

## Log Management

### View Logs

#### Using journalctl (systemd logs)

```bash
# View WebSocket adapter logs
sudo journalctl -u noesis-ship-websocket -f

# View agent daemon logs
sudo journalctl -u noesis-ship-agent-daemon -f

# View NATS server logs
sudo journalctl -u nats-server -f

# View all Noesis Ship logs together
sudo journalctl -u 'noesis-ship*' -u nats-server -f

# View logs since boot
sudo journalctl -u noesis-ship-websocket -b

# View logs from last hour
sudo journalctl -u noesis-ship-websocket --since "1 hour ago"

# View logs with priority (errors only)
sudo journalctl -u noesis-ship-websocket -p err
```

#### Log Files

NATS server logs to file (configured in `nats-server.conf`):

```bash
# View NATS log file
tail -f /home/hankh959/projects/noesis-ship/logs/nats-server.log

# Search for errors
grep -i error /home/hankh959/projects/noesis-ship/logs/nats-server.log
```

### Log Rotation

Configure logrotate for NATS logs:

Create `/etc/logrotate.d/noesis-ship`:

```
/home/hankh959/projects/noesis-ship/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 hankh959 hankh959
    postrotate
        systemctl reload nats-server >/dev/null 2>&1 || true
    endscript
}
```

### Export Logs for Analysis

```bash
# Export last 24 hours to file
sudo journalctl -u 'noesis-ship*' -u nats-server --since "24 hours ago" > /tmp/noesis-ship-logs-$(date +%Y%m%d).txt

# Export with JSON format
sudo journalctl -u noesis-ship-websocket -o json --since "1 hour ago" > /tmp/ws-logs.json
```

## Security Considerations

### Firewall Configuration

If using UFW (Uncomplicated Firewall):

```bash
# Allow WebSocket port from Tailscale subnet
sudo ufw allow from 100.64.0.0/10 to any port 3100 proto tcp comment 'Noesis Ship WebSocket - Tailscale'

# Allow NATS port (localhost only)
# NATS should only be accessible locally
sudo ufw deny 4222/tcp

# Allow NATS monitoring (localhost only)
sudo ufw deny 8222/tcp

# Reload firewall
sudo ufw reload
```

If using iptables directly:

```bash
# Allow WebSocket from Tailscale network
sudo iptables -A INPUT -p tcp -s 100.64.0.0/10 --dport 3100 -j ACCEPT -m comment --comment "Noesis Ship WebSocket - Tailscale"

# Deny NATS from external
sudo iptables -A INPUT -p tcp --dport 4222 -s 127.0.0.1 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 4222 -j DROP

# Save rules
sudo iptables-save | sudo tee /etc/iptables/rules.v4
```

### Service Isolation

The systemd service files include security hardening:

- `NoNewPrivileges=true` — Prevent privilege escalation
- `PrivateTmp=true` — Isolated /tmp directory
- `ProtectSystem=strict` — Read-only system directories
- `ProtectHome=read-only` — Limited home directory access
- `ReadWritePaths=...` — Explicitly allow write paths

### File Permissions

Ensure proper file ownership:

```bash
cd /home/hankh959/projects/noesis-ship

# Set ownership
sudo chown -R hankh959:hankh959 .

# Restrict permissions on .env
chmod 600 adapters/websocket/.env

# Make scripts executable
chmod +x scripts/*.sh
```

### NATS Security

For production deployments, enable NATS authentication:

Edit `/home/hankh959/projects/noesis-ship/config/nats-server.conf`:

```conf
# Authentication
authorization {
    user: noesis
    password: "$2a$11$..." # bcrypt hash
    timeout: 2
}
```

Generate bcrypt password:

```bash
# Using mkpasswd (from whois package)
mkpasswd -m bcrypt

# Or use NATS CLI
nats server passwd
```

Update WebSocket adapter to use authentication:

```env
NATS_URL=nats://noesis:password@localhost:4222
```

## Troubleshooting

### Service Won't Start

#### 1. Check Service Status

```bash
sudo systemctl status noesis-ship-websocket
```

Look for error messages in the output.

#### 2. Check Logs

```bash
sudo journalctl -u noesis-ship-websocket -n 50 --no-pager
```

#### 3. Common Issues

**Port Already in Use**

```bash
# Find process using port 3100
sudo lsof -i :3100

# Kill the process if needed
sudo kill <PID>

# Restart service
sudo systemctl restart noesis-ship-websocket
```

**Missing Dependencies**

```bash
cd /home/hankh959/projects/noesis-ship/adapters/websocket
npm install
sudo systemctl restart noesis-ship-websocket
```

**Permission Errors**

```bash
# Fix ownership
sudo chown -R hankh959:hankh959 /home/hankh959/projects/noesis-ship

# Restart service
sudo systemctl restart noesis-ship-websocket
```

### NATS Connection Failures

#### 1. Check NATS Server Status

```bash
sudo systemctl status nats-server
```

#### 2. Test NATS Connection

```bash
# Using NATS CLI
nats server ping

# Using curl (monitoring endpoint)
curl http://localhost:8222/varz
```

#### 3. Check NATS Logs

```bash
tail -f /home/hankh959/projects/noesis-ship/logs/nats-server.log
```

#### 4. Restart NATS

```bash
sudo systemctl restart nats-server
sleep 2
sudo systemctl restart noesis-ship-websocket
```

### WebSocket Connection Issues

#### 1. Test Local Connection

```bash
cd /home/hankh959/projects/noesis-ship/adapters/websocket
node test-ws.js
```

Expected output: Connection successful message.

#### 2. Check from Remote (Tailscale)

From another machine on Tailscale:

```bash
# Replace DGX_TAILSCALE_IP with actual IP
wscat -c ws://DGX_TAILSCALE_IP:3100
```

#### 3. Check Firewall Rules

```bash
sudo ufw status verbose
sudo iptables -L -n -v | grep 3100
```

### Agent Daemon Not Responding

#### 1. Check Claude CLI

```bash
# Verify Claude is installed
which claude

# Test Claude
claude --version
```

#### 2. Check Agent Daemon Logs

```bash
sudo journalctl -u noesis-ship-agent-daemon -f
```

#### 3. Manually Test Agent Daemon

```bash
cd /home/hankh959/projects/noesis-ship/adapters/websocket

# Stop service
sudo systemctl stop noesis-ship-agent-daemon

# Run manually to see errors
node agent-daemon.js
```

#### 4. Check Claude Session Directory

```bash
ls -la ~/.claude/projects/
```

Ensure the `CLAUDE_SESSION_DIR` environment variable points to the correct project.

### High Memory Usage

#### 1. Check Service Resource Usage

```bash
# Using systemd-cgtop
systemd-cgtop

# Using ps
ps aux | grep -E 'node|nats-server|claude'
```

#### 2. Check NATS JetStream Usage

```bash
# NATS monitoring
curl http://localhost:8222/jsz | jq .

# Check disk usage
du -sh /home/hankh959/projects/noesis-ship/data/jetstream
```

#### 3. Adjust Resource Limits

Edit service files and adjust limits:

```ini
# In /etc/systemd/system/noesis-ship-websocket.service
[Service]
MemoryMax=512M
CPUQuota=50%
```

Reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart noesis-ship-websocket
```

### Service Restart Loop

#### 1. Check Restart Count

```bash
systemctl show noesis-ship-websocket -p NRestarts
```

#### 2. Increase Restart Delay

Edit service file:

```ini
[Service]
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=60
```

#### 3. Check for Configuration Errors

```bash
# Validate Node.js syntax
node -c /home/hankh959/projects/noesis-ship/adapters/websocket/server.js
```

### Getting Help

If issues persist:

1. Collect diagnostic information:
   ```bash
   /home/hankh959/projects/noesis-ship/scripts/health-check.sh > diagnostic.txt
   sudo journalctl -u 'noesis-ship*' -u nats-server --since "1 hour ago" >> diagnostic.txt
   systemctl status noesis-ship-websocket noesis-ship-agent-daemon nats-server >> diagnostic.txt
   ```

2. Create an issue on GitHub: https://github.com/hankh95/noesis-ship/issues

3. Include:
   - DGX system information (Ubuntu version, hardware)
   - Service status and logs
   - Error messages
   - Steps to reproduce

## Quick Reference

### Common Commands

```bash
# Start all services
sudo systemctl start nats-server noesis-ship-websocket noesis-ship-agent-daemon

# Stop all services
sudo systemctl stop noesis-ship-agent-daemon noesis-ship-websocket nats-server

# Restart all services
sudo systemctl restart nats-server noesis-ship-websocket noesis-ship-agent-daemon

# View status
sudo systemctl status nats-server noesis-ship-websocket noesis-ship-agent-daemon

# View logs
sudo journalctl -u 'noesis-ship*' -u nats-server -f

# Health check
/home/hankh959/projects/noesis-ship/scripts/health-check.sh
```

### Service Dependencies

```
nats-server (port 4222)
    └── noesis-ship-websocket (port 3100)
            └── noesis-ship-agent-daemon (Claude Code spawner)
```

### Key Files

| File | Purpose |
|------|---------|
| `/etc/systemd/system/nats-server.service` | NATS server service definition |
| `/etc/systemd/system/noesis-ship-websocket.service` | WebSocket adapter service |
| `/etc/systemd/system/noesis-ship-agent-daemon.service` | Agent daemon service |
| `/home/hankh959/projects/noesis-ship/config/nats-server.conf` | NATS configuration |
| `/home/hankh959/projects/noesis-ship/adapters/websocket/.env` | Environment variables |
| `/home/hankh959/projects/noesis-ship/logs/nats-server.log` | NATS log file |

## Next Steps

After deployment:

1. Configure Ships Comm iOS app to connect to DGX via Tailscale
2. Test message sending and Claude Code agent responses
3. Set up monitoring and alerting
4. Review security hardening checklist
5. Configure backup for JetStream data (`data/jetstream/`)

For architecture details, see [Architecture](../architecture.md).
For adapter information, see [Adapters](../adapters.md).
