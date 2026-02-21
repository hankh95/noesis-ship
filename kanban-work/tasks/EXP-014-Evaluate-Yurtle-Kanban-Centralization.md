---
id: EXP-014
title: "Evaluate Yurtle-Kanban Centralization"
type: task
status: backlog
priority: low
created: 2026-02-21
assignee: DGX
depends_on: [EXP-010]
tags: [kanban, multi-project, web-ui, evaluation]
---

# Evaluate Yurtle-Kanban Centralization

## Question

Should yurtle-kanban be centralized as a noesis-ship plugin hosted on Mini, or remain distributed (CLI + git on each machine)?

## Current State (Distributed)

**Architecture:**
- yurtle-kanban CLI runs on each machine (DGX, Mini, M5)
- Expeditions stored as markdown files in each repo's `kanban-work/expeditions/`
- State managed via git (commit + push for atomic ID allocation)
- Each repo has its own kanban board

**Projects using yurtle-kanban:**
- `nusy-product-team` (143+ expeditions)
- `noesis-ship` (16+ expeditions)
- Potentially: other repos in the future

**Advantages:**
- ✅ Git-native workflow (version control, blame, diffs)
- ✅ Works offline (no server dependency)
- ✅ Simple deployment (pip install, done)
- ✅ Expedition files are human-readable markdown
- ✅ CLI is fast and familiar
- ✅ No single point of failure

**Limitations:**
- ❌ No cross-project visibility (can't see all work at once)
- ❌ Must switch repos to view different boards
- ❌ Manual coordination for cross-repo dependencies
- ❌ No web UI (CLI only)

## Proposed State (Centralized)

**Architecture:**
- Yurtle-kanban web UI hosted on Mini at port 3200
- Multi-project support (aggregate boards from all repos)
- Still git-backed (web UI commits to repos)
- NATS-connected for real-time updates across agents

**Potential Advantages:**
- ✅ Unified fleet-wide kanban view
- ✅ Cross-project visibility (see all work in one dashboard)
- ✅ Web-accessible from any device (iPhone, iPad, etc.)
- ✅ Real-time updates via NATS (agents see status changes immediately)
- ✅ Visual drag-and-drop (if we build that)
- ✅ Better for Captain (one URL to check all work)

**Potential Disadvantages:**
- ❌ Adds complexity (web server, NATS integration)
- ❌ Requires Mini to be running (single point of failure)
- ❌ Git workflow becomes indirect (web UI → git commits)
- ❌ Development effort (~10-15 hours to build)
- ❌ Maintenance burden (another service to monitor)

## Analysis

### Use Case: Agent Daily Work

**Distributed (current):**
```bash
# Agent workflow
yurtle-kanban board                        # View work
yurtle-kanban create expedition "..." --push  # Create work
yurtle-kanban move EXP-XXX in-progress      # Update status
```
Fast, familiar, works offline.

**Centralized:**
- Navigate to `http://100.113.140.45:3200`
- Click project → view board
- Create expedition via web form
- Drag card to "in-progress"

Slower, but better multi-project visibility.

### Use Case: Captain Monitoring

**Distributed:**
- Ask agents for status via Ships Comm
- Check each repo's GitHub web UI
- Read ACTIVE-CONTEXT.md files

**Centralized:**
- Open `http://100.113.140.45:3200` on iPhone
- See all fleet work at a glance
- Real-time updates as agents work

**Winner for this use case:** Centralized (significantly better)

### Use Case: Cross-Project Dependencies

**Example:** EXP-013 (noesis-ship) depends on beings emitting NATS events (nusy-product-team EXP-894)

**Distributed:**
- Manual coordination via ACTIVE-CONTEXT.md
- Agents check cross-repo dependencies manually

**Centralized:**
- Dependency graph across projects
- Auto-detect blocking expeditions
- Visual dependency tree

**Winner:** Centralized (if we implement dependency features)

## Recommendation

**Phase 1: Build Evaluation Prototype (4 hours)**

Create a minimal centralized kanban web UI to evaluate the benefits:

1. **Tech stack:** Simple Flask/FastAPI web server
2. **Features:**
   - List all expeditions from multiple repos
   - Filter by project, status, assignee
   - Display as table (not fancy board UI yet)
3. **Git integration:**
   - Clone repos to `/tmp` on Mini
   - `git pull` every 60s to refresh
   - Read-only (no editing yet)
4. **Access:** `http://100.113.140.45:3200`

**Decision criteria after prototype:**
- If Captain finds multi-project view valuable → Build Phase 2 (editing, NATS integration)
- If CLI is sufficient → Archive prototype, keep distributed model

**Phase 2: Full Implementation (IF approved after Phase 1) (10-15 hours)**

1. **Web UI framework:** React + Tailwind (or Gradio for faster dev)
2. **Backend:** FastAPI with git operations
3. **Features:**
   - Drag-and-drop kanban board
   - Create/edit expeditions via web forms
   - Git commits on every change
   - Multi-project tabs
   - Dependency graph visualization
4. **NATS integration:**
   - Publish `ship.kanban.*.updated` on status changes
   - Agents subscribe to auto-refresh their context
5. **Deployment:** launchd on Mini

## Alternatives Considered

### Option 1: Keep Distributed, Improve Tooling

Enhance CLI instead of centralizing:
- `yurtle-kanban fleet-status` → Show cross-repo work
- `yurtle-kanban dependencies EXP-XXX` → Check cross-repo blocking
- Multi-repo config file

**Pros:** No centralization complexity
**Cons:** Still CLI-only, no web UI for Captain

### Option 2: GitHub Projects Integration

Use GitHub Projects for web UI instead of custom:
- GitHub Projects supports multi-repo boards
- Free, hosted, familiar UI

**Pros:** Zero development, zero hosting
**Cons:** Not NATS-integrated, requires internet, less customizable

### Option 3: Hybrid Model

CLI remains primary, web UI is optional view-only:
- Agents use CLI (fast workflow)
- Captain uses web UI (monitoring only)
- Web UI reads from git, doesn't write

**Pros:** Best of both worlds
**Cons:** Duplicate interfaces (maintenance cost)

## Decision Framework

**Centralize IF:**
- Captain wants single-pane-of-glass for all fleet work
- Cross-project visibility is valuable
- Web access from iPhone/iPad is important
- NATS integration benefits outweigh complexity

**Keep Distributed IF:**
- CLI workflow is sufficient for agents
- Captain is comfortable checking multiple repos
- Simplicity is more valuable than features
- Development time is better spent elsewhere

## Next Steps

1. **Captain:** Decide if multi-project web UI is valuable
2. **If yes:** DGX builds Phase 1 evaluation prototype (4 hours)
3. **Captain tests:** Use for 1 week, evaluate value
4. **If valuable:** DGX builds Phase 2 full implementation
5. **If not valuable:** Archive prototype, keep distributed

## Estimated Effort

**Phase 1 (Prototype):** 4 hours
**Phase 2 (Full):** 10-15 hours
**Total:** 14-19 hours (2-3 days)

## Dependencies

- **EXP-010:** Mini central server operational
- **Git repos:** Multi-repo access on Mini
- **Python:** Flask/FastAPI for web server
