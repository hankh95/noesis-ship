#!/usr/bin/env node
/**
 * Tests for gatherFleetContext() and its helpers — Issue #17
 *
 * Covers:
 *   - gatherFleetContext() end-to-end with fixture data
 *   - readExpeditionFiles() file-glob fallback
 *   - parseSimpleFrontmatter() via real file-glob path with Yurtle fixtures
 *   - Graceful degradation when data sources fail
 *   - Cached fleet status passthrough
 *
 * Pattern: Shared test()/assert() from test-helpers.mjs.
 * Tests use a temp directory with Yurtle-format fixture files.
 */

import { test, assert, summary } from "./test-helpers.mjs";
import { gatherFleetContext, parseProposals } from "./morning-scan.mjs";
import { writeFile, mkdir, rm } from "fs/promises";
import path from "path";
import os from "os";

// ─── Fixture Setup ──────────────────────────────────────────────────────────

const FIXTURE_DIR = path.join(os.tmpdir(), `bosun-test-${Date.now()}`);
const EXP_DIR = path.join(FIXTURE_DIR, "kanban-work", "expeditions");
const HYP_FILE = path.join(FIXTURE_DIR, "research", "A-NUSY-HYPOTHESIS-LIST.md");
const ACF_DIR = path.join(FIXTURE_DIR, "research", "A-NUSY-LONGITUDINAL-DATA", "data");

/**
 * Create fixture files that match real Yurtle format.
 * These are markdown files with YAML frontmatter — the canonical NuSy knowledge format.
 */
async function setupFixtures() {
  await mkdir(EXP_DIR, { recursive: true });
  await mkdir(path.dirname(HYP_FILE), { recursive: true });
  await mkdir(ACF_DIR, { recursive: true });
  await mkdir(path.join(FIXTURE_DIR, "scripts"), { recursive: true });

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

// ─── Helper: assert kanban used file-glob (skip test otherwise) ─────────────

function requireFileGlob(ctx, testName) {
  if (ctx.kanban.source !== "file-glob") {
    console.log(`  SKIP  ${testName} (yurtle-kanban responded — file-glob path not exercised)`);
    return false;
  }
  return true;
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

  await test("kanban fallback reads expedition files when yurtle-kanban unavailable", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    assert(ctx.kanban.backlog !== undefined, "missing backlog");
    assert(ctx.kanban.inProgress !== undefined, "missing inProgress");

    if (requireFileGlob(ctx, "kanban fallback item counts")) {
      assert(ctx.kanban.backlog.length >= 2, `backlog: ${ctx.kanban.backlog.length} (expected >=2: EXP-100, EXP-300)`);
      assert(ctx.kanban.inProgress.length >= 2, `inProgress: ${ctx.kanban.inProgress.length} (expected >=2: EXP-200, EXP-400)`);
    }
  });

  console.log("\n--- readExpeditionFiles() Fallback Tests ---");

  await test("file-glob fallback parses standard YAML frontmatter", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    if (!requireFileGlob(ctx, "standard YAML frontmatter")) return;

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
    if (!requireFileGlob(ctx, "RDF @prefix lines")) return;

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
    if (!requireFileGlob(ctx, "status variants")) return;

    const exp200 = ctx.kanban.inProgress.find((i) => i.id === "EXP-200");
    assert(exp200, "EXP-200 (in-progress) should be in inProgress");

    const exp400 = ctx.kanban.inProgress.find((i) => i.id === "EXP-400");
    assert(exp400, "EXP-400 (in_progress) should be in inProgress");
  });

  await test("file-glob fallback excludes non-EXP files", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    if (!requireFileGlob(ctx, "non-EXP exclusion")) return;

    const all = [...ctx.kanban.backlog, ...ctx.kanban.inProgress];
    const readme = all.find((i) => i.title === "# This should be ignored");
    assert(!readme, "README.md should be excluded (not EXP-*.md)");
  });

  await test("file-glob fallback excludes done expeditions from both lists", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    if (!requireFileGlob(ctx, "done exclusion")) return;

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

  await test("ACF history reads recent JSON files sorted by filename", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    assert(Array.isArray(ctx.acf), "acf should be array");
    assert(ctx.acf.length === 2, `acf entries: ${ctx.acf.length} (expected 2)`);
    // Files are sorted by name (ISO date prefix) — last entry is most recent
    const latest = ctx.acf[ctx.acf.length - 1];
    assert(latest.acf_score === 0.75, `latest acf: ${latest.acf_score}`);
    assert(latest.being === "santiago-toddler-v12", `being: ${latest.being}`);
  });

  console.log("\n--- Expedition Facts Tests ---");

  await test("expedition facts gracefully handles missing stale detector", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    assert(ctx.expeditionFacts !== undefined, "expeditionFacts should exist");
    assert(ctx.expeditionFacts.total === 0, `total: ${ctx.expeditionFacts.total}`);
    assert(Array.isArray(ctx.expeditionFacts.expeditions), "expeditions should be array");
  });

  console.log("\n--- Fleet Health Tests ---");

  await test("fleet health returns structure with expected fields", async () => {
    const ctx = await gatherFleetContext(FIXTURE_DIR);
    assert(ctx.fleet !== undefined, "fleet should exist");
    // getFleetHealth() always returns these fields even when tools fail
    assert(Array.isArray(ctx.fleet.tmuxSessions), `tmuxSessions should be array, got ${typeof ctx.fleet.tmuxSessions}`);
    assert(typeof ctx.fleet.agentsBusy === "number", `agentsBusy should be number, got ${typeof ctx.fleet.agentsBusy}`);
    assert(typeof ctx.fleet.agentsAvailable === "number", `agentsAvailable should be number`);
    assert(typeof ctx.fleet.worktrees === "number", `worktrees should be number`);
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

  // Cleanup
  await cleanupFixtures();

  // ─── Summary ────────────────────────────────────────────────────────────────

  const failures = summary("gatherFleetContext tests");
  process.exit(failures > 0 ? 1 : 0);
}

runTests();
