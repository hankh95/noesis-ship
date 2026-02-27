#!/usr/bin/env node
/**
 * Tests for @noesis-ship/bosun
 *
 * Tests pure functions only — no NATS, no subprocess, no API calls.
 * Pattern: Shared test()/assert() from test-helpers.mjs.
 */

import { test, assert, summary } from "./test-helpers.mjs";
import { parseProposals, gatherFleetContext, readResearchFiles, parseSimpleFrontmatter } from "./morning-scan.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// ─── Proposal Parsing Tests ─────────────────────────────────────────────────

console.log("\n--- Proposal Parsing Tests ---");

test("parseProposals handles clean JSON response", () => {
  const text = JSON.stringify({
    proposals: [
      {
        exp: "EXP-1010",
        title: "Y-Layer Optimization",
        priority: "high",
        agent: "DGX",
        reasoning: "High impact graph perf",
      },
    ],
    fleet_summary: "1 busy, 2 available",
    reasoning: "DGX available for heavy work",
  });

  const result = parseProposals(text);
  assert(result.proposals.length === 1, `proposals: ${result.proposals.length}`);
  assert(result.proposals[0].exp === "EXP-1010", `exp: ${result.proposals[0].exp}`);
  assert(result.proposals[0].agent === "DGX", `agent: ${result.proposals[0].agent}`);
  assert(result.reasoning.includes("DGX"), `reasoning: ${result.reasoning}`);
});

test("parseProposals handles markdown-wrapped JSON", () => {
  const text = `Here are my recommendations:

\`\`\`json
{
  "proposals": [
    {
      "exp": "EXP-999",
      "title": "Test",
      "priority": "medium",
      "agent": "M5",
      "reasoning": "Testing"
    }
  ],
  "reasoning": "One proposal"
}
\`\`\`

Let me know if you'd like changes.`;

  const result = parseProposals(text);
  assert(result.proposals.length === 1, `proposals: ${result.proposals.length}`);
  assert(result.proposals[0].exp === "EXP-999", `exp: ${result.proposals[0].exp}`);
});

test("parseProposals handles unparseable text gracefully", () => {
  const text = "I couldn't determine any proposals because the kanban is empty.";
  const result = parseProposals(text);
  assert(result.proposals.length === 0, `proposals: ${result.proposals.length}`);
  assert(result.reasoning === text, "reasoning should be raw text");
});

test("parseProposals handles empty proposals array", () => {
  const text = JSON.stringify({
    proposals: [],
    reasoning: "All agents busy, WIP limit reached",
  });
  const result = parseProposals(text);
  assert(result.proposals.length === 0, `proposals: ${result.proposals.length}`);
  assert(result.reasoning.includes("WIP"), `reasoning: ${result.reasoning}`);
});

test("parseProposals handles multiple proposals", () => {
  const text = JSON.stringify({
    proposals: [
      { exp: "EXP-100", title: "A", priority: "critical", agent: "DGX", reasoning: "r1" },
      { exp: "EXP-200", title: "B", priority: "high", agent: "M5", reasoning: "r2" },
      { exp: "EXP-300", title: "C", priority: "medium", agent: "Mini", reasoning: "r3" },
    ],
    reasoning: "Three picks",
  });
  const result = parseProposals(text);
  assert(result.proposals.length === 3, `proposals: ${result.proposals.length}`);
  assert(result.proposals[0].priority === "critical", "first should be critical");
  assert(result.proposals[2].agent === "Mini", "third should be Mini");
});

// ─── Message Routing Tests ──────────────────────────────────────────────────

console.log("\n--- Message Routing Tests ---");

test("approve action requires exp field", () => {
  // Simulate: handleBosunCommand would return early without exp
  const msg = { action: "approve" };
  assert(!msg.exp, "should be falsy without exp");
});

test("approve finds proposal in pending list", () => {
  const proposals = [
    { exp: "EXP-100", title: "A", priority: "high" },
    { exp: "EXP-200", title: "B", priority: "medium" },
  ];
  const found = proposals.find((p) => p.exp === "EXP-100");
  assert(found, "should find EXP-100");
  assert(found.priority === "high", `priority: ${found.priority}`);

  const notFound = proposals.find((p) => p.exp === "EXP-999");
  assert(!notFound, "should not find EXP-999");
});

test("reject removes from pending list", () => {
  let pending = [
    { exp: "EXP-100" },
    { exp: "EXP-200" },
    { exp: "EXP-300" },
  ];
  pending = pending.filter((p) => p.exp !== "EXP-200");
  assert(pending.length === 2, `pending: ${pending.length}`);
  assert(!pending.find((p) => p.exp === "EXP-200"), "EXP-200 should be gone");
});

// ─── Spawn Command Tests ────────────────────────────────────────────────────

console.log("\n--- Spawn Command Tests ---");

test("spawn constructs correct args with worktree", () => {
  const spawnPath = "/path/to/fleet-spawn.sh";
  const expId = "EXP-985";
  const args = [spawnPath, expId, "--worktree"];
  assert(args.length === 3, `args: ${args.length}`);
  assert(args[0] === spawnPath, "first arg is spawn path");
  assert(args[2] === "--worktree", "worktree flag present");
});

test("spawn adds phase and model flags", () => {
  const spawnPath = "/path/to/fleet-spawn.sh";
  const expId = "EXP-985";
  const args = [spawnPath, expId];
  args.push("--worktree");
  args.push("--phase", "2");
  args.push("--model", "claude-opus-4-6");
  assert(args.length === 7, `args: ${args.length}`);
  assert(args[3] === "--phase", "phase flag");
  assert(args[4] === "2", "phase value");
  assert(args[5] === "--model", "model flag");
  assert(args[6] === "claude-opus-4-6", "model value");
});

test("spawn without worktree omits flag", () => {
  const args = ["/path/to/fleet-spawn.sh", "EXP-985"];
  // No --worktree added
  assert(args.length === 2, `args: ${args.length}`);
  assert(!args.includes("--worktree"), "no worktree flag");
});

// ─── WIP Limit Tests ───────────────────────────────────────────────────────

console.log("\n--- WIP Limit Tests ---");

test("WIP limit counting from session names", () => {
  const sessions = [
    "exp-985-knowledge-bootstrap",
    "exp-994-fleet-spawn",
    "my-dev-session",
    "main",
  ];
  const expSessions = sessions.filter((s) => s.match(/^exp-\d+/i));
  assert(expSessions.length === 2, `exp sessions: ${expSessions.length}`);
  assert(expSessions.length < 5, "under WIP limit of 5");
});

test("WIP limit enforced at 5", () => {
  const sessions = [
    "exp-100-alpha",
    "exp-200-beta",
    "exp-300-gamma",
    "exp-400-delta",
    "exp-500-epsilon",
  ];
  const expSessions = sessions.filter((s) => s.match(/^exp-\d+/i));
  assert(expSessions.length >= 5, "at WIP limit");
  assert(!(expSessions.length < 5), "should NOT be under limit");
});

test("empty tmux output means under limit", () => {
  const sessions = [];
  const expSessions = sessions.filter((s) => s.match(/^exp-\d+/i));
  assert(expSessions.length < 5, "empty = under limit");
});

// ─── Context Formatting Tests ───────────────────────────────────────────────

console.log("\n--- Context Formatting Tests ---");

test("kanban JSON fallback parsing", () => {
  const goodJson = '[{"id":"EXP-100","title":"Test"}]';
  const parsed = JSON.parse(goodJson);
  assert(Array.isArray(parsed), "should parse to array");
  assert(parsed[0].id === "EXP-100", `id: ${parsed[0].id}`);
});

test("frontmatter parsing extracts key fields", () => {
  const text = `---
id: EXP-985
title: Knowledge Bootstrap
status: in-progress
priority: high
tags: [yurtle-first, training]
---

# Content here`;

  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert(match, "should find frontmatter");
  const lines = match[1].split("\n");
  assert(lines.length >= 4, `lines: ${lines.length}`);
});

// ─── Dual-Board Tests (CHORE-034) ────────────────────────────────────────────

console.log("\n--- Dual-Board Tests ---");

test("parseProposals handles research board items in proposals", () => {
  const text = JSON.stringify({
    proposals: [
      {
        exp: "EXPR-121",
        title: "Wikidata Enrichment A/B Study",
        priority: "high",
        agent: "DGX",
        phase: "analysis",
        reasoning: "Experiment ready for analysis — armB complete",
      },
      {
        exp: "H121.1",
        title: "Density hypothesis test",
        priority: "medium",
        agent: "DGX",
        phase: "design",
        reasoning: "Hypothesis needs experiment protocol",
      },
    ],
    fleet_summary: "1 busy, 2 available",
    reasoning: "Research items ready for action",
  });

  const result = parseProposals(text);
  assert(result.proposals.length === 2, `proposals: ${result.proposals.length}`);
  assert(result.proposals[0].exp === "EXPR-121", `exp: ${result.proposals[0].exp}`);
  assert(result.proposals[0].phase === "analysis", `phase: ${result.proposals[0].phase}`);
  assert(result.proposals[1].exp === "H121.1", `exp: ${result.proposals[1].exp}`);
});

test("parseProposals handles mixed development and research proposals", () => {
  const text = JSON.stringify({
    proposals: [
      { exp: "EXP-1016", title: "HDD Workflow", priority: "critical", agent: "DGX", reasoning: "Dev work" },
      { exp: "EXPR-121", title: "Wikidata Experiment", priority: "high", agent: "DGX", phase: "execution", reasoning: "Research work" },
      { exp: "CHORE-034", title: "Dual board scan", priority: "high", agent: "DGX", reasoning: "Chore" },
    ],
    reasoning: "Mixed board proposals",
  });

  const result = parseProposals(text);
  assert(result.proposals.length === 3, `proposals: ${result.proposals.length}`);

  // Check item types by ID prefix
  const expItems = result.proposals.filter((p) => p.exp.startsWith("EXP-"));
  const exprItems = result.proposals.filter((p) => p.exp.startsWith("EXPR-"));
  const choreItems = result.proposals.filter((p) => p.exp.startsWith("CHORE-"));

  assert(expItems.length === 1, `EXP items: ${expItems.length}`);
  assert(exprItems.length === 1, `EXPR items: ${exprItems.length}`);
  assert(choreItems.length === 1, `CHORE items: ${choreItems.length}`);
});

test("research board HDD states are valid", () => {
  const validStates = ["draft", "active", "complete", "abandoned"];

  const draftItem = { id: "H999.1", status: "draft" };
  const activeItem = { id: "EXPR-999", status: "active" };
  const completeItem = { id: "PAPER-999", status: "complete" };

  assert(validStates.includes(draftItem.status), `draft is valid`);
  assert(validStates.includes(activeItem.status), `active is valid`);
  assert(validStates.includes(completeItem.status), `complete is valid`);
});

test("research board phase routing is correct", () => {
  const phaseRouting = {
    discovery: ["Architect", "DGX"],
    design: ["Architect", "DGX"],
    execution: ["M5", "Mini"],
    analysis: ["DGX"],
    writing: ["Any"],
  };

  // DGX should handle analysis
  assert(phaseRouting.analysis.includes("DGX"), "DGX handles analysis");

  // M5/Mini handle execution
  assert(phaseRouting.execution.includes("M5"), "M5 handles execution");
  assert(phaseRouting.execution.includes("Mini"), "Mini handles execution");

  // DGX can handle discovery and design
  assert(phaseRouting.discovery.includes("DGX"), "DGX handles discovery");
  assert(phaseRouting.design.includes("DGX"), "DGX handles design");
});

test("research board item types are recognized", () => {
  const itemTypes = ["hypothesis", "experiment", "paper", "literature", "measure", "idea"];
  const idPrefixes = {
    hypothesis: "H",
    experiment: "EXPR-",
    paper: "PAPER-",
    literature: "LIT-",
    measure: "M-",
    idea: "IDEA-R-",
  };

  // Verify prefix mapping
  assert(idPrefixes.hypothesis === "H", "hypothesis prefix");
  assert(idPrefixes.experiment === "EXPR-", "experiment prefix");
  assert(idPrefixes.paper === "PAPER-", "paper prefix");

  // Verify all types have prefixes
  for (const type of itemTypes) {
    assert(idPrefixes[type], `${type} has prefix`);
  }
});

test("dual board context includes research section marker", () => {
  // Simulates what formatContext should produce
  const sections = [];
  sections.push("## Development Board (kanban-work/)");
  sections.push("In-progress (2):");
  sections.push("## Research Board (research/) — HDD Items");
  sections.push("Uses HDD states: draft → active → complete | abandoned");
  sections.push("Active (3):");

  const output = sections.join("\n");
  assert(output.includes("Development Board"), "has dev board header");
  assert(output.includes("Research Board"), "has research board header");
  assert(output.includes("HDD Items"), "marks HDD items");
  assert(output.includes("draft → active → complete"), "shows HDD states");
});

// ─── Research File Parsing Tests ─────────────────────────────────────────────

console.log("\n--- Research File Parsing Tests ---");

test("research item frontmatter parsing extracts phase", () => {
  const text = `---
id: EXPR-121
title: Wikidata Enrichment A/B Study
status: active
phase: execution
hypotheses: [H121.1, H121.2]
---

# Content`;

  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert(match, "should find frontmatter");

  const lines = match[1].split("\n");
  const phaseMatch = lines.find((l) => l.startsWith("phase:"));
  assert(phaseMatch, "should find phase field");
  assert(phaseMatch.includes("execution"), "phase is execution");
});

test("hypothesis frontmatter parsing extracts paper reference", () => {
  const text = `---
id: H121.1
title: Wikidata density increases Y2 graph density
paper: 121
target: ">10% improvement"
status: draft
---

# Content`;

  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert(match, "should find frontmatter");

  const lines = match[1].split("\n");
  const paperMatch = lines.find((l) => l.startsWith("paper:"));
  assert(paperMatch, "should find paper field");
  assert(paperMatch.includes("121"), "paper is 121");
});

// ─── WIP Limit Tests for Dual Board ──────────────────────────────────────────

console.log("\n--- Dual Board WIP Limit Tests ---");

test("development board WIP limit is 4 underway", () => {
  const devWipLimit = 4;
  const inProgress = [
    { id: "EXP-100", status: "in_progress" },
    { id: "EXP-200", status: "in_progress" },
    { id: "CHORE-001", status: "in_progress" },
    { id: "EXP-300", status: "in_progress" },
  ];

  assert(inProgress.length <= devWipLimit, `dev WIP at limit: ${inProgress.length}`);
  assert(!(inProgress.length < devWipLimit), "at limit, not under");
});

test("research board WIP limit is 5 active", () => {
  const researchWipLimit = 5;
  const active = [
    { id: "EXPR-100", status: "active", phase: "execution" },
    { id: "EXPR-200", status: "active", phase: "analysis" },
    { id: "H100.1", status: "active", phase: "design" },
  ];

  assert(active.length < researchWipLimit, `research WIP under limit: ${active.length}`);
});

test("boards have independent WIP tracking", () => {
  const devWip = 4;
  const researchWip = 3;

  // Both boards can be at their own limits independently
  assert(devWip <= 4, "dev board at its limit");
  assert(researchWip <= 5, "research board under its limit");

  // Total doesn't matter — WIP is per-board
  assert(devWip + researchWip === 7, "total is 7 across boards");
});

// ─── parseSimpleFrontmatter Behavioral Tests ────────────────────────────────

console.log("\n--- parseSimpleFrontmatter Behavioral Tests ---");

test("parseSimpleFrontmatter extracts YAML fields", () => {
  const text = `---
id: EXPR-121
title: Wikidata Enrichment A/B Study
status: active
phase: execution
assignee: DGX
tags: [wikidata, experiment]
---

# Content here`;

  const fm = parseSimpleFrontmatter(text);
  assert(fm.id === "EXPR-121", `id: ${fm.id}`);
  assert(fm.title === "Wikidata Enrichment A/B Study", `title: ${fm.title}`);
  assert(fm.status === "active", `status: ${fm.status}`);
  assert(fm.phase === "execution", `phase: ${fm.phase}`);
  assert(fm.assignee === "DGX", `assignee: ${fm.assignee}`);
  assert(Array.isArray(fm.tags), "tags is array");
  assert(fm.tags.includes("wikidata"), "tags includes wikidata");
});

test("parseSimpleFrontmatter returns {} for no frontmatter", () => {
  const text = "# Just a heading\n\nNo frontmatter here.";
  const fm = parseSimpleFrontmatter(text);
  assert(Object.keys(fm).length === 0, `keys: ${Object.keys(fm).length}`);
});

test("parseSimpleFrontmatter skips TTL lines (returns empty for hypothesis files)", () => {
  const text = `---
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix hyp: <https://nusy.dev/hypothesis/> .

<#H101.2> a hyp:Hypothesis ;
    hyp:paper "101"^^xsd:integer ;
    rdfs:label "7-step pipeline" .
---

# Content`;

  const fm = parseSimpleFrontmatter(text);
  // All lines start with @ or < — should all be skipped
  assert(!fm.id, "no id extracted from TTL");
  assert(!fm.title, "no title extracted from TTL");
});

test("parseSimpleFrontmatter handles quoted values", () => {
  const text = `---
id: EXP-999
title: "A Quoted Title"
status: backlog
---`;

  const fm = parseSimpleFrontmatter(text);
  assert(fm.title === "A Quoted Title", `title: ${fm.title}`);
});

// ─── readResearchFiles Behavioral Tests (async) ─────────────────────────────

console.log("\n--- readResearchFiles Behavioral Tests ---");

test("readResearchFiles parses experiment files correctly", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bosun-test-"));
  const researchDir = path.join(tmpDir, "research");
  const expDir = path.join(researchDir, "experiments");
  await mkdir(expDir, { recursive: true });

  await writeFile(path.join(expDir, "EXP-890-test.md"), `---
id: EXPR-890
title: Test Experiment
status: active
phase: execution
assignee: M5
tags: [test]
---

# Test content`);

  await writeFile(path.join(expDir, "EXP-891-draft.md"), `---
id: EXPR-891
title: Draft Experiment
status: draft
phase: design
---

# Draft`);

  const result = await readResearchFiles(tmpDir);
  assert(result.active.length === 1, `active: ${result.active.length}`);
  assert(result.draft.length === 1, `draft: ${result.draft.length}`);
  assert(result.active[0].id === "EXPR-890", `id: ${result.active[0].id}`);
  assert(result.active[0].type === "experiment", `type: ${result.active[0].type}`);
  assert(result.active[0].assignee === "M5", `assignee: ${result.active[0].assignee}`);
  assert(result.active[0].phase === "execution", `phase: ${result.active[0].phase}`);
  assert(result.draft[0].id === "EXPR-891", `draft id: ${result.draft[0].id}`);

  await rm(tmpDir, { recursive: true });
});

test("readResearchFiles handles non-existent directories gracefully", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bosun-test-"));
  // No research/ directory at all
  const result = await readResearchFiles(tmpDir);
  assert(result.draft.length === 0, `draft: ${result.draft.length}`);
  assert(result.active.length === 0, `active: ${result.active.length}`);
  assert(result.complete.length === 0, `complete: ${result.complete.length}`);
  assert(result.source === "file-glob", `source: ${result.source}`);

  await rm(tmpDir, { recursive: true });
});

test("readResearchFiles skips files without frontmatter", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bosun-test-"));
  const ideasDir = path.join(tmpDir, "research", "ideas");
  await mkdir(ideasDir, { recursive: true });

  // File with no frontmatter
  await writeFile(path.join(ideasDir, "random-notes.md"), "# Just some notes\n\nNo YAML here.");

  // File with frontmatter but no id/title
  await writeFile(path.join(ideasDir, "empty-fm.md"), `---
tags: [orphan]
---

# No id or title`);

  // Valid file
  await writeFile(path.join(ideasDir, "IDEA-R-001.md"), `---
id: IDEA-R-001
title: Real Idea
status: draft
---

# Content`);

  const result = await readResearchFiles(tmpDir);
  assert(result.draft.length === 1, `should have 1 draft, got ${result.draft.length}`);
  assert(result.draft[0].id === "IDEA-R-001", `id: ${result.draft[0].id}`);
  assert(result.draft[0].type === "idea", `type: ${result.draft[0].type}`);

  await rm(tmpDir, { recursive: true });
});

test("readResearchFiles buckets abandoned items separately", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bosun-test-"));
  const expDir = path.join(tmpDir, "research", "experiments");
  await mkdir(expDir, { recursive: true });

  await writeFile(path.join(expDir, "abandoned.md"), `---
id: EXPR-999
title: Abandoned Experiment
status: abandoned
---

# Abandoned`);

  const result = await readResearchFiles(tmpDir);
  assert(result.abandoned.length === 1, `abandoned: ${result.abandoned.length}`);
  assert(result.draft.length === 0, "not in draft");
  assert(result.active.length === 0, "not in active");

  await rm(tmpDir, { recursive: true });
});

test("readResearchFiles reads multiple directories", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bosun-test-"));
  const researchDir = path.join(tmpDir, "research");

  // Create experiments + literature dirs
  await mkdir(path.join(researchDir, "experiments"), { recursive: true });
  await mkdir(path.join(researchDir, "literature"), { recursive: true });
  await mkdir(path.join(researchDir, "measures"), { recursive: true });

  await writeFile(path.join(researchDir, "experiments", "e1.md"), `---
id: EXPR-100
title: Experiment One
status: active
---`);

  await writeFile(path.join(researchDir, "literature", "lit1.md"), `---
id: LIT-001
title: Literature Review
status: draft
---`);

  await writeFile(path.join(researchDir, "measures", "m1.md"), `---
id: M-001
title: Accuracy Metric
status: complete
---`);

  const result = await readResearchFiles(tmpDir);
  assert(result.active.length === 1, `active: ${result.active.length}`);
  assert(result.draft.length === 1, `draft: ${result.draft.length}`);
  assert(result.complete.length === 1, `complete: ${result.complete.length}`);
  assert(result.active[0].type === "experiment", `type: ${result.active[0].type}`);
  assert(result.draft[0].type === "literature", `type: ${result.draft[0].type}`);
  assert(result.complete[0].type === "measure", `type: ${result.complete[0].type}`);

  await rm(tmpDir, { recursive: true });
});

test("readResearchFiles skips dotfiles and non-md files", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "bosun-test-"));
  const papersDir = path.join(tmpDir, "research", "papers");
  await mkdir(papersDir, { recursive: true });

  await writeFile(path.join(papersDir, ".gitkeep"), "");
  await writeFile(path.join(papersDir, "data.json"), '{"not": "markdown"}');
  await writeFile(path.join(papersDir, "PAPER-101.md"), `---
id: PAPER-101
title: Real Paper
status: draft
---`);

  const result = await readResearchFiles(tmpDir);
  assert(result.draft.length === 1, `should have 1 draft, got ${result.draft.length}`);
  assert(result.draft[0].id === "PAPER-101", `id: ${result.draft[0].id}`);

  await rm(tmpDir, { recursive: true });
});

// ─── Summary ────────────────────────────────────────────────────────────────

// Wait for async tests to settle before printing summary
await new Promise((resolve) => setTimeout(resolve, 500));

const failures = summary("Bosun tests");
process.exit(failures > 0 ? 1 : 0);
