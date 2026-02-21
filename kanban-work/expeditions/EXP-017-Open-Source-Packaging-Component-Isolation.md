---
id: EXP-017
title: "Open-Source Packaging & Component Isolation"
status: review
created: 2026-02-21
priority: medium
assignee: M5
tags: [infrastructure, open-source, packaging, docker]
related: [EXP-010, EXP-012]
---

# EXP-017: Open-Source Packaging & Component Isolation

## Problem

Noesis-ship has grown into 5+ services (relay, daemon, fleet-log, MCP, session-watcher) all living in a single `adapters/websocket/` directory with one shared `package.json`. This works for us but blocks open-sourcing — not everyone wants all parts. Someone running a solo agent doesn't need the fleet log writer or MCP server.

## Solution

Restructure noesis-ship into **npm workspace packages** with **Docker Compose profiles** for opt-in deployment. Each component becomes independently installable and runnable.

## Target Structure

```
noesis-ship/
  packages/
    relay/              # WebSocket server + Bonjour discovery
    daemon/             # Agent daemon (spawns Claude Code)
    fleet-log/          # NATS → Yurtle markdown transcripts
    mcp-server/         # MCP server for Claude Code tool integration
    shared/             # NATS helpers, config loader, wire protocol types
  config/               # NATS server configs (nats-server.conf)
  deploy/
    docker-compose.yml  # Profiles: agents, logging, mcp, dashboard
    launchd/            # macOS plists (one per component)
    systemd/            # Linux template unit (noesis@relay, noesis@daemon, etc.)
  noesis_ship/          # Python core (unchanged)
  docs/
  templates/            # Ship templates (dinghy, sloop, galleon)
```

## Key Design Decisions

### npm Workspaces (not Turborepo/Nx)
- Plain npm workspaces — zero config, built-in, upgrade path to Turborepo exists
- 5 packages doesn't justify Nx/Turborepo overhead
- Each package independently `cd packages/relay && npm install && npm start`-able

### Docker Compose with Profiles
```bash
docker compose up                        # NATS + relay (minimum)
docker compose --profile agents up       # + agent daemon
docker compose --profile logging up      # + fleet log writer
docker compose --profile "*" up          # everything
```

### Config: dotenv + Defaults File
- `.env.example` committed (template), `.env` gitignored (secrets)
- `packages/shared/config.js` — checked-in structural defaults with env var overrides
- Startup validation for required vars (NATS_URL, etc.)

### Deployment Templates
- **macOS:** One launchd plist per component (`dev.noesis.relay.plist`, etc.)
- **Linux:** systemd template unit `noesis@.service` → `noesis@relay`, `noesis@daemon`
- **Docker:** Compose profiles for opt-in

### Python Stays Separate
- Command Deck (Dash app) stays in nusy-product-team
- Coupled via NATS subjects and shared config schema
- Docker Compose can reference it as an external service

## Implementation Phases

### Phase 1: Package Split (~2 hours)
1. Create `packages/` directory with 5 packages
2. Move files from `adapters/websocket/` → appropriate packages
3. Extract shared code (NATS connection, wire protocol types, config loader) into `packages/shared`
4. Each package gets its own `package.json` with only its deps
5. Root `package.json` workspace config
6. Verify: `npm install` at root, each package starts independently

### Phase 2: Docker Compose (~1 hour)
1. Create `deploy/docker-compose.yml` with NATS + relay as base
2. Add profiles: `agents`, `logging`, `mcp`
3. Create minimal Dockerfiles per package
4. Verify: `docker compose up` starts NATS + relay only

### Phase 3: Deployment Templates (~1 hour)
1. Templatize existing launchd plists → `deploy/launchd/`
2. Create systemd template unit → `deploy/systemd/noesis@.service`
3. Add install scripts (macOS + Linux)
4. Update docs/getting-started.md

### Phase 4: Config Cleanup (~30 min)
1. Create `.env.example` with all env vars documented
2. Create `packages/shared/config.js` with defaults + validation
3. Remove hardcoded paths from individual packages
4. Verify: fresh clone → copy `.env.example` → services start

### Phase 5: Documentation (~1 hour)
1. Update README.md with component overview and quickstart
2. Per-package README with install/run/config instructions
3. Architecture diagram showing component relationships
4. Contributing guide

## Success Criteria

- Fresh `git clone && npm install && npm start` starts NATS + relay
- Each package runs independently (`cd packages/relay && npm install && npm start`)
- `docker compose --profile agents up` starts relay + daemon
- Existing launchd/systemd deployments migrate cleanly
- All existing tests pass
- README makes it clear which components are optional

## What NOT to Do

- Don't adopt Nx or Turborepo (overkill for 5 packages)
- Don't mix Python into npm workspace (different toolchain)
- Don't add TOML config parser (JSON/JS is native to Node.js)
- Don't add PM2 (systemd/launchd already handle process management)
- Don't add Kubernetes/Helm (Docker Compose is sufficient)
