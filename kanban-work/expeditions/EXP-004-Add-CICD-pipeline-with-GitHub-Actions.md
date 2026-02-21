---
id: EXP-004
title: "Add CI/CD pipeline with GitHub Actions"
type: expedition
status: done
priority: medium
created: 2026-02-21
assignee: M5
depends_on: []
tags: [ci, github-actions, testing]
---

# Add CI/CD pipeline with GitHub Actions

## What

GitHub Actions workflow that runs on push to main and PRs:

- **Python tests** (NATS core): pytest across Python 3.11/3.12/3.13
- **Node.js checks** (WebSocket adapter): syntax validation across Node 20/22
- **Lint**: JSON validity, YAML frontmatter in expeditions

## File

`.github/workflows/ci.yml`
