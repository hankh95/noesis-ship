---
id: EXP-005
title: "Polish MCP server with tool catalog documentation"
type: expedition
status: done
priority: medium
created: 2026-02-21
assignee: M5
depends_on: []
tags: [mcp, documentation, tools]
---

# Polish MCP server with tool catalog documentation

## Changes

1. **Renamed `send_to_carclaw` → `send_to_ships_comm`** — matches rebrand
2. **Renamed resource `carclaw://inbox` → `noesis://inbox`** — matches rebrand
3. **Added `send_to_agent` tool** — directed agent-to-agent messaging via MCP
4. **Inbox now captures agent messages** — not just human messages
5. **Bridge status shows Tailscale IP and relay URL** — when available
6. **Updated all comments and docs** — removed CarClaw references
