# NuSy Project — Claude Code Instructions

NuSy is a neurosymbolic AI platform where "beings" (AI agents) learn, reason, and work autonomously.

## Core Architecture

**Yurtle** is the knowledge representation format. Everything is stored as:
- Markdown files with YAML frontmatter (human-readable)
- RDF triples in semantic graphs (machine-queryable)
- Git-backed persistence (versioned, auditable)

**Y-Layer Architecture** (Being Knowledge):
- Y0: Raw source documents
- Y1: Extracted facts/concepts
- Y2: Relationships/edges
- Y3: Inferred knowledge
- Y4: Episodic memory
- Y5: Procedural skills
- Y6: Metacognition

**Kanban System** tracks all work using yurtle-kanban CLI (v1.9.0+):
```bash
yurtle-kanban board              # View kanban board
yurtle-kanban list --status in-progress  # List in-progress items
yurtle-kanban show EXP-XXX       # Show expedition details
yurtle-kanban create expedition "Title" --push  # Atomic: allocate ID + create + commit + push
yurtle-kanban move EXP-XXX done  # Update status
yurtle-kanban roadmap            # Prioritized backlog
yurtle-kanban history --week     # Recent completions
yurtle-kanban stats              # Board statistics
```

**Expedition File Format** (REQUIRED for yurtle-kanban detection):
```yaml
---
id: EXP-XXX
title: Short Title Here
status: backlog|in-progress|review|done
created: YYYY-MM-DD
priority: low|medium|high|critical
assignee: Agent Name (optional)
tags: [tag1, tag2]
related: [EXP-YYY, EXP-ZZZ]
---

# EXP-XXX: Full Title

Content...
```

**IMPORTANT:** Expeditions without YAML frontmatter will NOT appear in the kanban board.

Full yurtle-kanban docs: See the [yurtle-kanban README](https://github.com/hankh95/yurtle-kanban)

## Critical Rules

1. **Use `create --push` for new expeditions**: `yurtle-kanban create expedition "Title" --push` — this is a single atomic command that fetches latest, allocates the ID, creates the file, commits, and pushes. If another agent pushed first, it retries with a new ID. **Do NOT use the old `next-id` + manual file creation flow** — it has a race window that causes ID conflicts.
2. **ALL implementation work goes in a feature branch with a PR**: After the expedition is created on main (by `create --push`), create a branch (e.g., `exp-872-service-orientation`) and do all implementation work there. Never push implementation commits directly to main. Open a PR for review — we find a lot of issues when a different developer or agent reviews the work.
3. **Check paper relationships**: Before starting an expedition, check if it relates to a paper (see `.claude/docs/research-integration.md`)
4. **Prefer editing over creating**: Don't create new files unless necessary
5. **No merge without tests**: Run `pytest` before completing work

## Versioning

We use **semantic versioning** (SemVer) aligned with architecture versions:

**Current:** V12 (0.12.x) — Cognitive Signal Fusion (parallel voting, FHIR-CPG decision model)
**Previous:** V11 (0.11.x) — Y-Layer Reasoning Policy (UnifiedReasoningBrain)
**Legacy:** V10 (0.10.x) — Curriculum-driven domain expertise
**Deprecated:** V9 (0.9.x) — GPU-first architecture

| Architecture | Semantic Version | Git Tag | Status |
|--------------|------------------|---------|--------|
| V12 | 0.12.x | v0.12.x | **Active** |
| V11 | 0.11.x | v0.11.x | Supported |
| V10 | 0.10.x | v0.10.x | Legacy |
| V9 | 0.9.x | v0.9.x | Deprecated |

**Version locations** (must stay in sync):
- `pyproject.toml` → `version = "0.12.x"`
- `brain/__init__.py` → `__version__ = "0.12.x"`
- `brain/pyproject.toml` → `version = "0.12.x"`

**When to bump versions:**
- **Patch (0.9.x → 0.9.x+1)**: Bug fixes, documentation
- **Minor (0.9.x → 0.10.0)**: New features, architecture changes (V10)
- **Major (0.x → 1.0)**: Production release

**Release workflow:**
```bash
# Check current version
grep version pyproject.toml

# Update CHANGELOG.md with changes
# Update version in all 3 locations
# Commit: "chore: bump version to 0.9.x"
# Create git tag
git tag -a v0.9.x -m "Release 0.9.x: description"
git push origin v0.9.x
```

**Note:** Being directories like `santiago-toddler-v9` are NAMES, not version indicators. Don't rename them when bumping versions.

## Testing Strategy (TDD/BDD)

We follow **Test-Driven Development** with three levels of testing:

| Level | Type | Location | Purpose |
|-------|------|----------|---------|
| 1 | **Unit Tests** | `beings/{being}/voyage-trials/test_*.py` | Test individual functions/classes in isolation |
| 2 | **Integration Tests** | `beings/{being}/sea-trials/` | Test component interactions and workflows |
| 3 | **Live Being Tests** | `live-being-tests/` | Awaken a being and verify via CLI that it can perform new capabilities |

### TDD/BDD Workflow

```
1. Write test first (RED) → Test MUST fail before implementation
2. Implement minimal code → Just enough to pass the test
3. Run tests (GREEN) → All tests pass
4. Refactor → Clean up while keeping tests green
5. Live being test → Awaken being, use CLI to verify behavior
```

### Live Being Tests

After unit/integration tests pass, validate real being behavior:
```bash
# Awaken the being
python beings/{being}/awaken.py

# Use CLI to test new capability
being-cli {being} <command-to-test>

# Verify the being can actually do what we implemented
```

**No feature is complete until a live being demonstrates the capability.**

## Research Papers

Expeditions often collect data for research papers. Before starting work:
1. Check `research/A-NuSy_PAPERS_INDEX.md` for active papers
2. Check `research/A-NUSY-HYPOTHESIS-LIST.md` for hypotheses being tested
3. If your expedition validates a hypothesis, note before/after metrics for A/B comparison

## Key Directories

```
beings/                    # AI beings (agents)
brain/                     # Core reasoning engine
kanban-work/expeditions/   # Work items (EXP-XXX files)
research/                  # Papers and hypotheses
.claude/skills/            # Workflow skills (/work, /done, /expedition)
.claude/docs/              # Detailed guidance (Yurtle, research, etc.)
```

## Skills (Slash Commands)

Skills are defined in `.claude/skills/` directories. Each skill has a `SKILL.md` file with YAML frontmatter.

**User-Invocable Skills** (user types `/command`):

| Command | Purpose |
|---------|---------|
| `/work [EXP-XXX]` | Find and start next expedition |
| `/done` | Complete: tests, commit, push, update kanban |
| `/expedition <title>` | Create new expedition with proper ID |
| `/review EXP-XXX` | Pre-merge review |
| `/release` | Create a versioned release with git tag |
| `/branch-cleanup` | Clean up merged branches before starting work |
| `/sync` | Check handoffs, reviews, blocked items |
| `/blocked EXP-XXX "reason"` | Mark expedition as blocked |
| `/handoff EXP-XXX agent-b` | Hand off work to another agent |

**Agent-Invocable Skills** (Claude can invoke automatically):

| Command | Purpose |
|---------|---------|
| `/status` | Show kanban board and agent workload |

**Skill Configuration:**
- `disable-model-invocation: true` → User must invoke (significant actions)
- `disable-model-invocation: false` → Agent can invoke automatically

## Quick Reference

- **Architecture (V12)**: `ARCHITECTURE.md`
- **Architecture (historical)**: `docs/archive/` (V9, V10, V11 snapshots)
- **Yurtle Format**: `.claude/docs/yurtle-essentials.md`
- **Research Integration**: `.claude/docs/research-integration.md`
- **CI/CD Pipeline**: `.claude/docs/ci-cd-pipeline.md`
- **Being Creation**: `docs/BEING-CREATION-GUIDE.md`
- **Being CLI**: `docs/BEING-CLI-GUIDE.md`

## Workflow Conventions

### Expedition Workflow (Branch + PR Pattern)

When starting a new expedition (e.g., EXP-XXX):

1. `yurtle-kanban create expedition "Title" --push` — atomically claims the ID on main
2. `git checkout -b exp-XXX-short-description` — create feature branch
3. Do all implementation work on the feature branch
4. Run tests (`pytest`) before finishing
5. Push branch, create PR via `gh pr create`
6. Get review from another developer/agent before merging

**Key principle:** `create --push` handles the fetch + allocate + commit + push atomically. All code changes go through a branch + PR. Reviews catch issues that the implementing agent misses.

### Starting Work on Existing Expeditions

**IMPORTANT:** When you start working on an existing expedition (not created by you), you MUST:

1. **Assign yourself**: Use `yurtle-kanban move EXP-XXX in_progress --assign "YourAgentName"`
2. **Update status**: Move from `backlog` to `in_progress` if not already there
3. **Create a branch**: `git checkout -b exp-XXX-short-description`

```bash
# Example: Starting work on EXP-874
yurtle-kanban move EXP-874 in_progress --assign "DGX"
git checkout -b exp-874-ylayer-validation
# ... do work ...
```

**Why this matters:**
- Other agents can see who's working on what (avoids duplicate effort)
- The kanban board shows accurate WIP (work in progress)
- ACTIVE-CONTEXT.md coordination works correctly

### Branch Cleanup (After Merge)

**IMPORTANT:** After work is approved and merged to main, delete the feature branch:

```bash
# Delete local merged branches
git branch --merged main | grep -v "^\*" | grep -v "main" | xargs git branch -d

# Delete remote merged branches
git push origin --delete <branch-name>

# Or use the /branch-cleanup skill
```

This keeps the repo clean and prevents stale branch accumulation.

## Python Development

For Python projects:
- Always use type hints
- Run `pytest` after changes to core modules
- Check `mypy` for type errors before committing

## Session Management & Multi-Agent Coordination

### ACTIVE-CONTEXT.md (Read First Every Session!)

**Location:** `claude-workspace/ACTIVE-CONTEXT.md`

This file maintains continuity across sessions following [Anthropic's claude-progress.txt pattern](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

**Session Start Protocol:**
1. `git pull origin main`
2. Read `claude-workspace/ACTIVE-CONTEXT.md`
3. Check Agent Assignments - am I already assigned something?
4. Check Mini-Plans for ready work

**Session End Protocol:**
1. Update "Current Position" section with training status, blockers, etc.
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

Each machine has its own `~/.claude/CLAUDE.md` with agent name, hardware specs,
and AI capabilities. Claude Code loads it automatically alongside this file.

**To set up a new machine:** Create `~/.claude/CLAUDE.md` with the agent identity
block. See existing machines for the format.

| Agent | GitHub | Platform | Setup |
|-------|--------|----------|-------|
| **M5** | hankh95 | MacBook Pro M5 | `~/.claude/CLAUDE.md` on M5 |
| **DGX** | hankh959 | DGX Spark | `~/.claude/CLAUDE.md` on DGX |
| **Mini** | hankh1844 | Mac Mini M4 | `~/.claude/CLAUDE.md` on Mini |

Use your agent name (from `~/.claude/CLAUDE.md`) in:
- `assignee:` fields in expedition frontmatter
- Commit messages when agent attribution matters
- ACTIVE-CONTEXT.md agent assignments

See `kanban-work/TEAM.md` for the full team roster and naming rules.

### Multi-Agent Coordination

Multiple Claude instances may work in parallel. Each agent knows its own
identity and capabilities from its local `~/.claude/CLAUDE.md`.

Check Agent Assignments in ACTIVE-CONTEXT.md before starting to avoid conflicts.

See [EXP-761](kanban-work/expeditions/EXP-761-Active-Context-Session-Continuity.md) for full documentation.

## Yurtle First: Knowledge Representation Rules

**Principle:** Definitional knowledge belongs in Yurtle files, not Python code.

When beings are advanced enough, they should be able to load this codebase and do *real* self-improvement. That means every piece of definitional knowledge — domain ontologies, learning thresholds, safety rules, hypothesis definitions, scenario routing tables — must be in **Yurtle format**: markdown with TTL frontmatter, loadable into a being's knowledge graph.

### What Goes in Yurtle Files

| Knowledge Type | Location | Example |
|----------------|----------|---------|
| Domain ontologies | `knowledge/domains/*.md` | Concept types, predicates, example triples |
| Configuration thresholds | `knowledge/config/*.md` | CQ thresholds, capability thresholds |
| Safety/justification rules | `knowledge/config/*.md` | Always-justify domains, patterns |
| Routing tables (CUSR) | `knowledge/config/*.md` | Bloom levels, scenario types |
| Hypothesis definitions | `research/hypotheses/*.md` | Targets, metrics, comparisons |
| Infrastructure visibility | `knowledge/infrastructure/*.md` | Y-layer stubs for native-format files |

### What Stays in Python

- **Procedural code** — Functions, classes, algorithms
- **Adapters** — Code that *reads* from Yurtle files (see `brain/utils/yurtle_adapter.py`)
- **Business logic** — How to use the knowledge, not the knowledge itself

### The Pattern

Every definitional asset follows the same structure:

```markdown
---
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix domain: <https://nusy.dev/domain/> .

<#config-name> a domain:ConfigType ;
    domain:property "value" .
---

# Human-Readable Title

Prose explanation of what this is and when to use it.
```

### When Creating New Knowledge

1. **Ask:** "Is this knowledge or code?"
   - Knowledge = facts, rules, thresholds, relationships → Yurtle
   - Code = functions, algorithms, procedures → Python

2. **Check existing patterns:**
   - Domain configs: `knowledge/domains/childrens-literature.md`
   - Config thresholds: `knowledge/config/learning-thresholds.md`
   - Hypotheses: `research/hypotheses/paper-108-v7-perception.md`

3. **Use the adapter pattern:**
   ```python
   # In Python, load from Yurtle:
   from brain.utils.yurtle_adapter import load_domain_config
   config = load_domain_config("children_literature")
   ```

### Anti-Patterns (Don't Do This)

```python
# BAD: Hardcoded knowledge in Python
DOMAINS = {
    "children_literature": {
        "concept_types": ["Character", "Animal", "Place"],
        "predicates": ["friendOf", "enemyOf"]
    }
}

# GOOD: Load from Yurtle file
from brain.utils.yurtle_adapter import load_domain_config
config = load_domain_config("children_literature")
```

### Why This Matters

- **Self-improvement:** Beings can query and reason about their own configuration
- **Auditability:** Knowledge is versioned in git, not hidden in code
- **Flexibility:** Change thresholds without code deployment
- **Graph-queryable:** SPARQL-like queries over all definitional knowledge

See [EXP-803](kanban-work/expeditions/EXP-803-Yurtle-Non-Conformance-Remediation.md) for the full implementation and test suite.
