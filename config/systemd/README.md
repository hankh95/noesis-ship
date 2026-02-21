# Systemd Service Files

This directory contains systemd service unit files for running Noesis Ship services on Linux systems (Ubuntu/Debian).

## Files

- `nats-server.service` — NATS message broker service
- `noesis-ship-websocket.service` — WebSocket adapter service
- `noesis-ship-agent-daemon.service` — Agent daemon (Claude Code spawner)

## Installation

Copy these files to `/etc/systemd/system/`:

```bash
sudo cp *.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## Enable Services

```bash
sudo systemctl enable nats-server
sudo systemctl enable noesis-ship-websocket
sudo systemctl enable noesis-ship-agent-daemon
```

## Start Services

```bash
sudo systemctl start nats-server
sudo systemctl start noesis-ship-websocket
sudo systemctl start noesis-ship-agent-daemon
```

## Check Status

```bash
sudo systemctl status nats-server noesis-ship-websocket noesis-ship-agent-daemon
```

## Configuration Notes

- **User/Group**: Services run as user `hankh959` (change to your username)
- **Paths**: Update all paths to match your installation directory
- **NATS Server Path**: Update `ExecStart` in `nats-server.service` to point to your NATS binary
- **Node.js Path**: Update `ExecStart` in WebSocket and agent daemon services if Node.js is not at `/usr/bin/node`

## Security

Services include systemd security hardening:

- `NoNewPrivileges=true` — Prevent privilege escalation
- `PrivateTmp=true` — Isolated /tmp directory
- `ProtectSystem=strict` — Read-only system directories
- `ProtectHome=read-only` — Limited home directory access
- `ReadWritePaths=...` — Explicitly allowed write paths

Review and adjust security settings based on your environment.

## See Also

- [DGX Deployment Guide](../../docs/deployment/dgx.md) — Complete deployment documentation
- [Getting Started](../../docs/getting-started.md) — General installation guide
