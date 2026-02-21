---
id: EXP-003
title: "Document DGX deployment with systemd services"
type: expedition
status: review
priority: medium
created: 2026-02-21
completed: 2026-02-21
assignee: DGX
pr_url: https://github.com/hankh95/noesis-ship/pull/2
depends_on: []
---

# Document DGX deployment with systemd services

## Implementation Summary

Created comprehensive DGX deployment documentation with production-ready systemd services.

### Documentation Added

- **docs/deployment/dgx.md**: Complete deployment guide (1300+ lines) covering:
  - Prerequisites and installation
  - Environment configuration
  - Systemd service setup
  - Service management commands
  - Health monitoring and logging
  - Security hardening
  - Comprehensive troubleshooting

### Systemd Services

Created three production-ready systemd unit files in `config/systemd/`:

1. **nats-server.service**: NATS message broker with JetStream
2. **noesis-ship-websocket.service**: WebSocket adapter
3. **noesis-ship-agent-daemon.service**: Claude Code spawner

All services include:
- Security hardening (NoNewPrivileges, ProtectSystem, PrivateTmp)
- Proper resource limits
- Auto-restart on failure
- Journal logging integration

### Configuration Files

- **config/nats-server.conf**: NATS server configuration with JetStream persistence
- **config/systemd/README.md**: Installation and configuration guide

### Scripts

- **scripts/health-check.sh**: Automated health monitoring (checks services, ports, NATS, API)
- **scripts/install-services-dgx.sh**: One-command installation script

### Other Changes

- Updated `.gitignore` to exclude `logs/` and `data/` directories
- Updated `docs/getting-started.md` with link to DGX deployment guide

## Pull Request

PR #2: https://github.com/hankh95/noesis-ship/pull/2

Ready for review and merge.
