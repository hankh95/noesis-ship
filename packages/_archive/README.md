# Archived Fleet Automation Packages

**Archived:** 2026-03-03
**Issue:** [#23](https://github.com/hankh95/noesis-ship/issues/23)
**Related:** [nusy-product-team EXP-1062](https://github.com/hankh95/nusy-product-team/blob/main/kanban-work/expeditions/EXP-1062-Simplify-Fleet-Archive-Autonomous-Automation-Keep-.md)

## Why

The autonomous fleet orchestration (Bosun, auto-dispatch, fleet monitoring) was
replaced by Captain-directed workflow via VSCode + Claude extension. Real-time
visibility and control is more valuable than autonomous orchestration.

See EXP-1062 for the full decision rationale and EXP-1061 ship's log for the
safety analysis that led to this decision.

## What's Here

| Package | What it did |
|---------|------------|
| `bosun/` | Bosun service — NATS-based work proposal and dispatch orchestration |
| `bosun-ops/` | Ops logger for Bosun service events |
| `fleet-alert/` | Fleet alert publisher (NATS → notifications) |
| `fleet-log/` | Fleet log writer (NATS → JSONL on disk) |
| `fleet-monitor/` | Fleet health monitor with collectors |
| `fleet-status/` | Fleet status service (agent health, session tracking) |

## What Was Kept

- `packages/shared/` — Shared NATS helpers and config
- `packages/relay/` — WebSocket relay (being communication)
- `packages/daemon/` — Agent daemon
- `packages/mcp-server/` — MCP server bridge
- `packages/chat/` — Chat service
