# Systemd Service Files

This directory contains systemd service unit files for running Noesis Ship services on Linux systems (Ubuntu/Debian).

## Files

- `nats-server.service` — NATS message broker service
- `noesis-ship-websocket.service` — WebSocket adapter service
- `noesis-ship-agent-daemon.service` — Agent daemon (Claude Code spawner)

## Installation

The service files use `__USER__` and `__HOME__` placeholders. The installer script handles this automatically:

```bash
sudo ./scripts/install-services-dgx.sh
```

Or manually template and copy:

```bash
sed -e "s|__USER__|$USER|g" -e "s|__HOME__|$HOME|g" *.service | sudo tee /etc/systemd/system/
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

- **User/Group**: Service files use `__USER__` placeholder — the installer auto-detects your username
- **Paths**: `__HOME__` placeholder is replaced with your home directory by the installer
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
