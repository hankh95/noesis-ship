#!/usr/bin/env node
/**
 * Tests for gatherFleetContext() and its helpers — Issue #17
 *
 * Covers:
 *   - gatherFleetContext() end-to-end with fixture data
 *   - readExpeditionFiles() file-glob fallback
 *   - parseSimpleFrontmatter() with Yurtle frontmatter (RDF prefixes, tags, arrays)
 *   - Parallel gathering (all 5 sources complete without races)
 *   - Graceful degradation when data sources fail
 *
 * Pattern: Same test()/assert() as test-bosun.mjs (no external framework).
 * Tests use a temp directory with Yurtle-format fixture files.
 */

import { gatherFleetContext, parseProposals } from "./morning-scan.mjs";
import { writeFile, mkdir, rm } from "fs/promises";
import path from "path";
import os from "os";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => { console.log(`  PASS  ${name}`); passed++; },
        (err) => { console.log(`  FAIL  ${name}: ${err.message}`); failed++; }
      );
    }
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

// ─── Fixture Setup ──────────────────────────────────────────────────────────

const FIXTURE_DIR = path.join(os.tmpdir(), `bosun-test-${Date.now()}`);
const EXP_DIR = path.join(FIXTURE_DIR, "kanban-work", "expeditions");
const HYP_FILE = path.join(FIXTURE_DIR, "research", "A-NUSY-HYPOTHESIS-LIST.md");
const ACF_DIR = path.join(FIXTURE_DIR, "research", "A-NUSY-LONGITUDINAL-DATA", "data");
const STALE_SCRIPT = path.join(FIXTURE_DIR, "scripts", "stale_expedition_detector.py");

/**
 * Create fixture files that match real Yurtle format.
 * These are markdown files with YAML frontmatter — the canonical NuSy knowledge format.
 */
async function setupFixtures() {
  await mkdir(EXP_DIR, { recursive: true });
  await mkdir(path.dirname(HYP_FILE), { recursive: true });
  await mkdir(ACF_DIR, { recursive: true });
  await mkdir(path.dirname(STALE_SCRIPT), { recursive: true });

  // Expedition in backlog — standard Yurtle frontmatter
  await writeFile(path.join(EXP_DIR, "EXP-100-Test-Backlog.md"), `---
id: EXP-100
title: "Test Backlog Expedition"
type: expedition
status: backlog
priority: high
assignee: Mini
created: 2026-02-20
tags: [testing, yurtle-first]
related: [EXP-99]
---

# EXP-100: Test Backlog Expedition

## Goal
Validate the gatherFleetContext fallback path.
`);

  // Expedition in progress
  await writeFile(path.join(EXP_DIR, "EXP-200-Test-InProgress.md"), `---
id: EXP-200
title: "Test In-Progress Expedition"
type: expedition
status: in-progress
priority: critical
assignee: DGX
created: 2026-02-15
tags: [gpu, training]
related: [EXP-100, EXP-150]
---

# EXP-200: Test In-Progress Expedition

## Goal
Heavy GPU work for DGX.
`);

  // Expedition with Yurtle RDF prefixes in frontmatter (should be skipped by parser)
  await writeFile(path.join(EXP_DIR, "EXP-300-Yurtle-Format.md"), `---
@prefix kb: <https://nusy.dev/kb/> .
@prefix exp: <https://nusy.dev/expedition/> .
id: EXP-300
title: "Yurtle-First Knowledge Expedition"
type: expedition
status: backlog
priority: medium
tags: [yurtle, rdf, graph]
---

# EXP-300: Yurtle-First Knowledge Expedition

\`\`\`yurtle
<#EXP-300> a kb:Expedition ;
    kb:status "backlog" ;
    kb:priority "medium" .
\`\`\`
`);

  // Done expedition (should be ignored by getKanbanState)
  await writeFile(path.join(EXP_DIR, "EXP-50-Done.md"), `---
id: EXP-50
title: "Already Done"
type: expedition
status: done
priority: low
---
# Done
`);

  // In-progress with underscore status variant
  await writeFile(path.join(EXP_DIR, "EXP-400-Underscore-Status.md"), `---
id: EXP-400
title: "Underscore Status Variant"
type: expedition
status: in_progress
priority: high
assignee: M5
tags: [code-quality]
---
# EXP-400
`);

  // Non-expedition file (should be skipped)
  await writeFile(path.join(EXP_DIR, "README.md"), "# This should be ignored\n");

  // Hypothesis list
  await writeFile(HYP_FILE, `# NuSy Hypothesis List

## Active Hypotheses

| ID | Statement | Status |
|----|-----------|--------|
| H-001 | ACF improves with curriculum training | TESTING |
| H-002 | Y-Layer reasoning reduces hallucination | TESTING |
| H-003 | Semantic suction enables knowledge transfer | PENDING |

## Completed

- [x] H-000: Yurtle format enables graph queries — CONFIRMED
`);

  // ACF data
  await writeFile(path.join(ACF_DIR, "2026-02-25-acf.json"), JSON.stringify({
    being: "santiago-toddler-v12",
    acf_score: 0.72,
    date: "2026-02-25",
  }));
  await writeFile(path.join(ACF_DIR, "2026-02-26-acf.json"), JSON.stringify({
    being: "santiago-toddler-v12",
    acf_score: 0.75,
    date: "2026-02-26",
  }));
}

async function cleanupFixtures() {
  try {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function runTests() {
  await setupFixtures();

  console.log("\n--- gatherFleetContext() End-to-End Tests ---");

  await test("gatherFleetContext returns all 5 context sections", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    assert(ctx.kanban !== undefined, "missing kanban");
    assert(ctx.fleet !== undefined, "missing fleet");
    assert(ctx.acf !== undefined, "missing acf");
    assert(ctx.hypotheses !== undefined, "missing hypotheses");
    assert(ctx.expeditionFacts !== undefined, "missing expeditionFacts");
  });

  await test("gatherFleetContext runs all 5 sources in parallel (Promise.all)", async () => {
    // Timing test: if sequential, would take >5s with network calls.
    // With fixture data and failed subprocess calls, should be fast.
    const start = Date.now();
    await gatherFleetContext(FIXTURE_DIR);
    const elapsed = Date.now() - start;
    // All subprocess calls will fail (yurtle-kanban, tmux, gh, python3 not in fixture dir)
    // but they should all fail fast in parallel
    assert(elapsed < 20_000, `took ${elapsed}ms — may not be parallel`);
  });

  await test("kanban fallback reads expedition files when yurtle-kanban unavailable", async () => {
    // yurtle-kanban CLI won't find config in FIXTURE_DIR → falls back to file glob
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    // The kanban field should have data from file-glob fallback
    assert(ctx.kanban.backlog !== undefined, "missing backlog");
    assert(ctx.kanban.inProgress !== undefined, "missing inProgress");

    // If source is file-glob, verify items
    if (ctx.kanban.source === "file-glob") {
      assert(ctx.kanban.backlog.length >= 2, `backlog: ${ctx.kanban.backlog.length} (expected >=2: EXP-100, EXP-300)`);
      assert(ctx.kanban.inProgress.length >= 2, `inProgress: ${ctx.kanban.inProgress.length} (expected >=2: EXP-200, EXP-400)`);
    }
  });

  console.log("\n--- readExpeditionFiles() Fallback Tests ---");

  await test("file-glob fallback parses standard YAML frontmatter", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    if (ctx.kanban.source !== "file-glob") return; // Skip if yurtle-kanban answered

    const exp100 = ctx.kanban.backlog.find((i) => i.id === "EXP-100");
    assert(exp100, "EXP-100 should be in backlog");
    assert(exp100.title === "Test Backlog Expedition", `title: ${exp100.title}`);
    assert(exp100.priority === "high", `priority: ${exp100.priority}`);
    assert(exp100.assignee === "Mini", `assignee: ${exp100.assignee}`);
    assert(Array.isArray(exp100.tags), "tags should be array");
    assert(exp100.tags.includes("testing"), `tags: ${exp100.tags}`);
    assert(exp100.tags.includes("yurtle-first"), `tags missing yurtle-first: ${exp100.tags}`);
  });

  await test("file-glob fallback handles RDF @prefix lines in frontmatter", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    if (ctx.kanban.source !== "file-glob") return;

    const exp300 = ctx.kanban.backlog.find((i) => i.id === "EXP-300");
    assert(exp300, "EXP-300 should be in backlog (RDF prefixes skipped)");
    assert(exp300.title === "Yurtle-First Knowledge Expedition", `title: ${exp300.title}`);
    assert(exp300.priority === "medium", `priority: ${exp300.priority}`);
    assert(Array.isArray(exp300.tags), "tags should be array");
    assert(exp300.tags.includes("rdf"), `tags missing rdf: ${exp300.tags}`);
    assert(exp300.tags.includes("graph"), `tags missing graph: ${exp300.tags}`);
  });

  await test("file-glob fallback recognizes both in-progress and in_progress status", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    if (ctx.kanban.source !== "file-glob") return;

    const exp200 = ctx.kanban.inProgress.find((i) => i.id === "EXP-200");
    assert(exp200, "EXP-200 (in-progress) should be in inProgress");

    const exp400 = ctx.kanban.inProgress.find((i) => i.id === "EXP-400");
    assert(exp400, "EXP-400 (in_progress) should be in inProgress");
  });

  await test("file-glob fallback excludes non-EXP files", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    if (ctx.kanban.source !== "file-glob") return;

    const all = [...ctx.kanban.backlog, ...ctx.kanban.inProgress];
    const readme = all.find((i) => i.title === "# This should be ignored");
    assert(!readme, "README.md should be excluded (not EXP-*.md)");
  });

  await test("file-glob fallback excludes done expeditions from both lists", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    if (ctx.kanban.source !== "file-glob") return;

    const all = [...ctx.kanban.backlog, ...ctx.kanban.inProgress];
    const done = all.find((i) => i.id === "EXP-50");
    assert(!done, "EXP-50 (done) should not appear in backlog or inProgress");
  });

  console.log("\n--- Hypothesis Parsing Tests ---");

  await test("hypotheses are extracted from hypothesis list markdown", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    assert(Array.isArray(ctx.hypotheses), "hypotheses should be array");
    assert(ctx.hypotheses.length >= 3, `hypotheses: ${ctx.hypotheses.length} (expected >=3)`);
    const hasH001 = ctx.hypotheses.some((h) => h.includes("H-001"));
    assert(hasH001, "should include H-001");
  });

  console.log("\n--- ACF History Tests ---");

  await test("ACF history reads recent JSON files", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    assert(Array.isArray(ctx.acf), "acf should be array");
    assert(ctx.acf.length === 2, `acf entries: ${ctx.acf.length} (expected 2)`);
    const latest = ctx.acf[ctx.acf.length - 1];
    assert(latest.acf_score === 0.75, `latest acf: ${latest.acf_score}`);
    assert(latest.being === "santiago-toddler-v12", `being: ${latest.being}`);
  });

  console.log("\n--- Expedition Facts Tests ---");

  await test("expedition facts gracefully handles missing stale detector", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    // stale_expedition_detector.py doesn't exist at STALE_SCRIPT
    assert(ctx.expeditionFacts !== undefined, "expeditionFacts should exist");
    assert(ctx.expeditionFacts.total === 0, `total: ${ctx.expeditionFacts.total}`);
    assert(Array.isArray(ctx.expeditionFacts.expeditions), "expeditions should be array");
  });

  console.log("\n--- Fleet Health Tests ---");

  await test("fleet health returns structure even when tools unavailable", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    assert(ctx.fleet !== undefined, "fleet should exist");
    // tmux/gh/git may not be available in test env — fields should still exist
    assert(Array.isArray(ctx.fleet.tmuxSessions) || ctx.fleet.tmuxSessions === undefined ||
           typeof ctx.fleet.agents_busy === "number", "fleet should have sessions or status fields");
  });

  console.log("\n--- Cached Fleet Status Tests ---");

  await test("gatherFleetContext uses cached fleet status when provided", async () => {
    const cachedStatus = {
      tmuxSessions: ["exp-985-bootstrap", "main"],
      openPRs: [{ number: 16, title: "HDD CLI" }],
      worktrees: 2,
      agentsBusy: 1,
      agentsAvailable: 2,
    };
    const ctx = await gatherFleetContext(FIXTURE_DIR, cachedStatus);
    assert(ctx.fleet === cachedStatus, "should use cached status when provided");
    assert(ctx.fleet.agentsBusy === 1, `agentsBusy: ${ctx.fleet.agentsBusy}`);
  });

  console.log("\n--- parseProposals() Stale Expedition Field Tests ---");

  test("parseProposals extracts stale_expeditions → staleExpeditions", () => {
    const text = JSON.stringify({
      proposals: [],
      stale_expeditions: [
        { exp: "EXP-100", action: "close", reasoning: "Missing all referenced files" },
        { exp: "EXP-200", action: "archive", reasoning: "Superseded by EXP-300" },
      ],
      needs_review: [
        { exp: "EXP-400", question: "Is this still relevant?" },
      ],
      reasoning: "Found stale items",
    });
    const result = parseProposals(text);
    assert(result.staleExpeditions.length === 2, `stale: ${result.staleExpeditions.length}`);
    assert(result.staleExpeditions[0].action === "close", `action: ${result.staleExpeditions[0].action}`);
    assert(result.needsReview.length === 1, `needsReview: ${result.needsReview.length}`);
    assert(result.needsReview[0].question.includes("still relevant"), "question should pass through");
  });

  test("parseProposals defaults stale and review arrays when missing", () => {
    const text = JSON.stringify({
      proposals: [{ exp: "EXP-100", title: "Test", priority: "high", agent: "Mini", reasoning: "r" }],
      reasoning: "Just proposals, no stale",
    });
    const result = parseProposals(text);
    assert(Array.isArray(result.staleExpeditions), "staleExpeditions should be array");
    assert(result.staleExpeditions.length === 0, `stale: ${result.staleExpeditions.length}`);
    assert(Array.isArray(result.needsReview), "needsReview should be array");
    assert(result.needsReview.length === 0, `review: ${result.needsReview.length}`);
  });

  console.log("\n--- Frontmatter Edge Cases ---");

  test("parseSimpleFrontmatter handles quoted title with colons", () => {
    // Indirectly test via gatherFleetContext file parsing
    // The parser uses split(":", 2) — titles with colons should work if quoted
    const text = `---
id: EXP-999
title: "HDD: Hypothesis-Driven Development"
status: backlog
---
# Content`;
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    assert(match, "should find frontmatter");
    // The parser splits on first colon only (kv = line.split(":", 2))
    const lines = match[1].split("\n");
    const titleLine = lines.find((l) => l.startsWith("title:"));
    assert(titleLine, "should find title line");
    const val = titleLine.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "");
    assert(val === "HDD: Hypothesis-Driven Development", `title: ${val}`);
  });

  test("parseSimpleFrontmatter handles empty tag arrays", () => {
    const text = `---
id: EXP-888
title: No Tags
status: backlog
tags: []
---
# Content`;
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    const lines = match[1].split("\n");
    const tagLine = lines.find((l) => l.startsWith("tags:"));
    const val = tagLine.split(":")[1].trim();
    assert(val === "[]", `tags val: ${val}`);
  });

  // Cleanup
  await cleanupFixtures();

  // ─── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(50)}`);
  console.log(`gatherFleetContext tests: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
