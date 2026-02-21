# Noesis Ship — Claude Code Instructions

Noesis Ship is a pluggable multi-agent communication platform. NATS is the core nervous system. WebSocket, MCP, and HTTP/SSE are adapters that bridge external clients to the NATS event bus.

## Project Identity

**What is Noesis Ship?**

A communication platform for multi-agent systems. Each machine runs its own noesis-ship instance — no broadcast cross-talk between machines. Clients (Ships Comm iOS, Claude Code, Command Deck) connect via adapters and communicate through NATS.

**Current Status:** Day 1 (WebSocket-only mode) → Day 2 (NATS integration)

## Architecture Overview

```
noesis-ship
├── NATS Core (Python)
│   ├── EventBus — JetStream persistence (24h retention)
│   ├── PubSub — Fire-and-forget notifications
│   ├── Channels — Agent-to-agent messaging
│   ├── KVStore — Shared state
│   └── ObjectStore — Large file storage
├── Adapters (Node.js)
│   ├── WebSocket — Ships Comm iOS, web clients
│   ├── MCP — Claude Code, LLM agents
│   └── HTTP/SSE — Command Deck (planned)
└── Plugins — yurtle-kanban, git, custom integrations
```

**Key Principle:** NATS is the core. Everything else is an adapter or plugin.

## Kanban System

Work is tracked using **yurtle-kanban** CLI with nautical theming.

### Quick Reference

```bash
yurtle-kanban board                    # View kanban board
yurtle-kanban list --status backlog    # List backlog items
yurtle-kanban show EXP-XXX             # Show expedition details
yurtle-kanban create expedition "Title" --push  # Atomic: allocate ID + create + commit + push
yurtle-kanban move EXP-XXX in_progress # Update status
yurtle-kanban move EXP-XXX done        # Mark complete
```

Full documentation: [yurtle-kanban README](https://github.com/hankh95/yurtle-kanban)

### Work Item Types

Work items are organized by type into separate directories:

| Type | Directory | Prefix | When to use |
|------|-----------|--------|-------------|
| **expedition** | `kanban-work/expeditions/` | `EXP-` | All feature work — new capabilities, enhancements, cross-cutting changes |
| **task** | `kanban-work/tasks/` | `TASK-` | Discrete units of work: evaluations, config changes, maintenance |
| **bug** | `kanban-work/bugs/` | `BUG-` | Defects, incorrect behavior, things that need fixing |

**Note:** This repo uses the **nautical theme**. Expeditions are the nautical equivalent of features — do not create a `features/` directory.

**Ask the user** if you're unsure which type to use. The user will specify the type when requesting new work items.

### Work Item File Format

**REQUIRED** for yurtle-kanban detection:

```yaml
---
id: EXP-XXX
title: Short Title Here
type: expedition
status: backlog|in-progress|review|done
priority: low|medium|high|critical
created: YYYY-MM-DD
assignee: Agent Name (optional)
tags: [tag1, tag2]
related: [EXP-YYY]
---

# EXP-XXX: Full Title

Content...
```

**IMPORTANT:** Work items without YAML frontmatter will NOT appear in the kanban board.

## Contribution Workflow

### 1. Creating New Expeditions

Use the atomic `create --push` command:

```bash
yurtle-kanban create expedition "Add MCP health check endpoint" --push
```

This command:
- Fetches latest from main
- Allocates the next available EXP-XXX ID
- Creates the expedition file with proper frontmatter
- Commits and pushes atomically
- Handles ID conflicts if another agent pushed first

**Do NOT** use the old `next-id` + manual file creation flow — it has race conditions.

### 2. Working on Expeditions

**Branch + PR Pattern** (REQUIRED for all implementation work):

1. Start work: `yurtle-kanban move EXP-XXX in_progress --assign "YourAgentName"`
2. Create feature branch: `git checkout -b exp-XXX-short-description`
3. Implement on the feature branch (NEVER push directly to main)
4. Run tests: `pytest` (or `npm test` for Node.js)
5. Push branch and create PR: `gh pr create`
6. Get review from another developer/agent before merging

**Why this matters:** Reviews catch issues that the implementing agent misses.

### 3. Completing Work

After PR is approved and merged:

```bash
# Mark expedition done
yurtle-kanban move EXP-XXX done

# Clean up feature branch
git branch -d exp-XXX-short-description
git push origin --delete exp-XXX-short-description
```

## Key Directories

```
noesis-ship/
├── noesis_ship/           # Python core (NATS integration)
│   ├── core/              # EventBus, PubSub, Channels, KV, Object Store
│   ├── chat/              # Chat service with persistence
│   └── discovery/         # Service discovery
├── adapters/              # External protocol adapters
│   ├── websocket/         # WebSocket relay (Node.js)
│   │   ├── server.js      # WebSocket relay + Bonjour discovery
│   │   ├── agent-daemon.js # Claude Code session spawner
│   │   ├── mcp-server.js  # MCP tool integration
│   │   └── session-watcher.js # Session transcript streaming
│   └── mcp/               # (planned)
├── tests/                 # Python test suite
├── kanban-work/           # Work tracking (nautical theme)
│   ├── expeditions/       # Feature work (EXP-XXX)
│   ├── tasks/             # Discrete work items (TASK-XXX)
│   └── bugs/              # Defects and fixes (BUG-XXX)
├── templates/             # Ship templates (Dinghy, Sloop, Galleon, Carrier)
├── docs/                  # Architecture and guides
└── claude-workspace/      # Session continuity (ACTIVE-CONTEXT.md)
```

## Testing Strategy

### Python (NATS Core)

We follow **Test-Driven Development**:

1. Write test first (RED) — Test MUST fail
2. Implement minimal code — Just enough to pass
3. Run tests (GREEN) — `pytest`
4. Refactor — Keep tests green

**Test locations:**
- Unit tests: `tests/test_*.py`
- Integration tests: `tests/integration/`

**Running tests:**
```bash
pytest                    # All tests
pytest tests/test_core.py # Specific module
pytest -v                 # Verbose output
```

### Node.js (Adapters)

```bash
cd adapters/websocket
npm test
```

### Manual Testing

For adapters and end-to-end flows:

```bash
# Start WebSocket adapter
cd adapters/websocket
npm start

# In another terminal, test connection
node test-ws.js

# Send a test message
node send.js "Test message"
```

## Versioning

We use **semantic versioning** (SemVer):

**Current:** 0.1.0 (Day 1 — WebSocket-only mode)

**Version locations** (must stay in sync):
- `pyproject.toml` → `version = "0.1.x"`
- `package.json` → `"version": "0.1.x"`
- `noesis_ship/__init__.py` → `__version__ = "0.1.x"`

**When to bump:**
- **Patch (0.1.x → 0.1.x+1):** Bug fixes, documentation
- **Minor (0.1.x → 0.2.0):** New features (e.g., Day 2 NATS integration)
- **Major (0.x → 1.0):** Production release, API breaking changes

**Release workflow:**
```bash
# Update CHANGELOG.md
# Update version in all 3 locations
git commit -m "chore: bump version to 0.2.0"
git tag -a v0.2.0 -m "Release 0.2.0: Day 2 NATS integration"
git push origin v0.2.0
```

## Development Guidelines

### 1. Prefer Editing Over Creating

Don't create new files unless necessary. Look for existing files that can be enhanced.

### 2. Type Hints Required (Python)

```python
# GOOD
async def emit(self, event_type: str, source: str, data: dict) -> None:
    ...

# BAD
async def emit(self, event_type, source, data):
    ...
```

### 3. No Merge Without Tests

All PRs must have tests. Run `pytest` (Python) or `npm test` (Node.js) before creating a PR.

### 4. Configuration via Environment Variables

Use `.env` files for local configuration. Never commit secrets.

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `3100` | WebSocket server port |
| `AGENTS` | — | Agent roster (`id:Name,id:Name`) |
| `MACHINE_NAME` | hostname | Machine display name |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |

## Multi-Agent Coordination

### ACTIVE-CONTEXT.md (Read First Every Session)

**Location:** `claude-workspace/ACTIVE-CONTEXT.md`

This file maintains continuity across sessions following [Anthropic's claude-progress.txt pattern](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

**Session Start Protocol:**
1. `git pull origin main`
2. Read `claude-workspace/ACTIVE-CONTEXT.md`
3. Check Agent Assignments — am I already assigned something?
4. Check for blocked or in-progress items

**Session End Protocol:**
1. Update "Current Position" with what you completed
2. Append to "Recent Voyages" with:
   - What you completed
   - Key decisions made
   - Files created/modified
   - What next session should do
   - Any blockers
3. Commit and push:
```bash
git add claude-workspace/
git commit -m "chore: update ACTIVE-CONTEXT after session"
git push origin main
```

### Agent Identity

Each machine has its own `~/.claude/CLAUDE.md` with agent name, hardware specs, and capabilities. Claude Code loads it automatically.

**Fleet roster:**

| Agent | GitHub | Platform | Role |
|-------|--------|----------|------|
| **M5** | hankh95 | MacBook Pro M5 | General development, design |
| **DGX** | hankh959 | DGX Spark | Heavy compute, training, GPU work |
| **Mini** | hankh1844 | Mac Mini M4 | Background services, testing |

Use your agent name (from `~/.claude/CLAUDE.md`) in:
- `assignee:` fields in expedition frontmatter
- Commit messages when attribution matters
- ACTIVE-CONTEXT.md agent assignments

### Avoiding Conflicts

Before starting work:
1. Check ACTIVE-CONTEXT.md for agent assignments
2. Use `yurtle-kanban move EXP-XXX in_progress --assign "YourName"`
3. Create a feature branch immediately

## Quick Reference

### Documentation

- **Architecture:** `docs/architecture.md`
- **Getting Started:** `docs/getting-started.md`
- **Adapters:** `docs/adapters.md`
- **NuSy Integration:** `docs/reference/nusy-nats-architecture.md`

### Common Commands

```bash
# Kanban
yurtle-kanban board
yurtle-kanban create expedition "Title" --push
yurtle-kanban move EXP-XXX in_progress --assign "Agent"
yurtle-kanban move EXP-XXX done

# Python
pytest
pytest -v
pytest tests/test_core.py

# Node.js (adapters)
cd adapters/websocket
npm install
npm start
npm test

# Git workflow
git checkout -b exp-XXX-feature-name
gh pr create
git push origin --delete exp-XXX-feature-name  # After merge
```

## Day 1 vs Day 2

### Day 1 (Current)

- WebSocket adapter runs standalone
- No NATS dependency
- Direct relay between connected clients
- Same behavior as standalone bridge server

### Day 2 (In Progress)

- WebSocket adapter connects to NATS
- Messages flow to NATS subjects
- Agents subscribe to NATS channels
- Event persistence via JetStream
- KV store for shared state

### Day 3+ (Future)

- Fleet knowledge mesh
- Cross-agent coordination
- Pair programming workflows
- Multi-agent orchestration

## Ship Templates

Ships come in different sizes:

| Template | Agents | Use Case |
|----------|--------|----------|
| Dinghy | 1 | Solo agent, personal assistant |
| Sloop | 2 | Pair programming, code review |
| Galleon | 4-8 | Full development team |
| Carrier | 8+ | Multi-team fleet operations |

See `templates/` for configuration examples.

## Related Projects

- **Ships Comm** (iOS) — Voice-first agent communication app
- **yurtle-kanban** — Pluggable kanban board for agent work tracking
- **nusy-product-team** — AI beings platform (uses noesis-ship for communication)

## Contributing

This is a platform/library project. Contributions should:

1. Follow the Branch + PR pattern
2. Include tests for new functionality
3. Update documentation in `docs/`
4. Pass all tests before PR submission
5. Get review from another developer/agent

## License

ISC

## Author

Congruent Systems PBC
