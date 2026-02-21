---
id: EXP-008
title: "Yurtle-ify All Noesis Ship Files"
type: expedition
status: done
created: 2026-02-21
priority: high
assignee: M5
tags: [yurtle, graph, documentation]
depends_on: []
---

# EXP-008: Yurtle-ify All Noesis Ship Files

Add yurtle frontmatter to all configuration, documentation, and template files
so that everything in the repo is graph-consumable by nusy beings.

## Why

Beings discover services, tools, and configuration through yurtle frontmatter.
Without it, files are invisible to the knowledge graph. Following the TupuGit
principle: files ARE the interface.

## Deliverables

1. Add yurtle frontmatter to all ship templates (`templates/*.yaml`)
2. Add yurtle frontmatter to all docs (`docs/*.md`)
3. Add yurtle frontmatter to Python module `__init__.py` files (service declarations)
4. Add yurtle frontmatter to adapter README/config files
5. Ensure all `.md` files follow 3-layer format (frontmatter + prose + structured blocks)

## Acceptance Criteria

- `discover_services()` finds all noesis-ship components
- Every `.md` and `.yaml` file has valid yurtle frontmatter
- A being can introspect the entire repo through the knowledge graph
