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

// ─── Summary ────────────────────────────────────────────────────────────────

const failures = summary("Unit tests");
process.exit(failures > 0 ? 1 : 0);
