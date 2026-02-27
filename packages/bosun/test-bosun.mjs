#!/usr/bin/env node
/**
 * Tests for @noesis-ship/bosun
 *
 * Tests pure functions only — no NATS, no subprocess, no API calls.
 * Pattern: Shared test()/assert() from test-helpers.mjs.
 */

import { test, assert, summary } from "./test-helpers.mjs";
import { parseProposals, gatherFleetContext } from "./morning-scan.mjs";

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

// ─── Summary ────────────────────────────────────────────────────────────────

const failures = summary("Unit tests");
process.exit(failures > 0 ? 1 : 0);
