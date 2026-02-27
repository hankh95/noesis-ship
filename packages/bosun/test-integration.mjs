#!/usr/bin/env node
/**
 * Integration Tests for @noesis-ship/bosun — Issue #16
 *
 * Covers:
 *   - Stale handler: dedup, alerts, chore creation, daily reset
 *   - parseProposals → staleExpeditions → stale handler wiring
 *   - parseSimpleFrontmatter: direct tests including Yurtle RDF, colons, arrays
 *   - Scan fallback: unparseable LLM output
 *   - Full pipeline: LLM JSON → parse → stale handler → dedup across scans
 *
 * All tests import and call real source functions.
 * Pattern: Shared test()/assert() from test-helpers.mjs.
 */

import { test, assert, summary } from "./test-helpers.mjs";
import { createStaleHandler } from "./stale-handler.mjs";
import { parseProposals, parseSimpleFrontmatter } from "./morning-scan.mjs";

// ─── Stale Handler Tests ────────────────────────────────────────────────────

async function runTests() {

  console.log("\n--- Stale Handler: Dedup Tests ---");

  await test("stale handler skips duplicate items within same day", async () => {
    const logs = [];
    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Test" },
      (msg) => logs.push(msg),
      { publishJSON: () => {} }
    );

    const staleItems = [
      { exp: "EXP-100", action: "close", reasoning: "Missing files" },
      { exp: "EXP-200", action: "archive", reasoning: "Superseded" },
    ];

    // First call — both should be processed
    await handler.handleStaleExpeditions(staleItems, { natsConn: null, dryRun: true });
    const processedFirst = logs.filter((l) => l.includes("DRY RUN")).length;
    assert(processedFirst >= 2, `first run processed: ${processedFirst} (expected >=2)`);

    // Second call — both should be skipped (dedup)
    await handler.handleStaleExpeditions(staleItems, { natsConn: null, dryRun: true });
    const skipped = logs.filter((l) => l.includes("skipped")).length;
    assert(skipped >= 2, `second run skipped: ${skipped} (expected >=2)`);
  });

  await test("stale handler dedup key includes action (same exp different action = not dedup)", async () => {
    const logs = [];
    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Test" },
      (msg) => logs.push(msg),
      { publishJSON: () => {} }
    );

    await handler.handleStaleExpeditions(
      [{ exp: "EXP-100", action: "close", reasoning: "Close it" }],
      { natsConn: null, dryRun: true }
    );

    await handler.handleStaleExpeditions(
      [{ exp: "EXP-100", action: "archive", reasoning: "Archive it" }],
      { natsConn: null, dryRun: true }
    );

    const dryRuns = logs.filter((l) => l.includes("DRY RUN"));
    assert(dryRuns.length >= 2, `should process both actions: ${dryRuns.length}`);
    const skipped = logs.filter((l) => l.includes("skipped"));
    assert(skipped.length === 0, `should not skip different action: ${skipped.length}`);
  });

  await test("stale handler resetDaily clears dedup state", async () => {
    const logs = [];
    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Test" },
      (msg) => logs.push(msg),
      { publishJSON: () => {} }
    );

    const items = [{ exp: "EXP-100", action: "close", reasoning: "Test" }];
    await handler.handleStaleExpeditions(items, { natsConn: null, dryRun: true });

    handler.resetDaily();

    logs.length = 0;
    await handler.handleStaleExpeditions(items, { natsConn: null, dryRun: true });
    const skipped = logs.filter((l) => l.includes("skipped"));
    assert(skipped.length === 0, `after reset, should not skip: ${skipped.length}`);
    const processed = logs.filter((l) => l.includes("DRY RUN"));
    assert(processed.length >= 1, `after reset, should process: ${processed.length}`);
  });

  console.log("\n--- Stale Handler: Alert Publishing Tests ---");

  await test("stale handler publishes alert via injected publishJSON", async () => {
    const published = [];
    const publishJSON = (nc, subject, data, machine) => {
      published.push({ nc, subject, data, machine });
    };
    const fakeNc = { publish: () => {} };

    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "TestMachine" },
      () => {},
      { publishJSON }
    );

    await handler.handleStaleExpeditions(
      [{ exp: "EXP-500", action: "update", reasoning: "Needs Captain review" }],
      { natsConn: { nc: fakeNc }, dryRun: false }
    );

    assert(published.length === 1, `published: ${published.length}`);
    assert(published[0].subject === "ship.fleet.alert", `subject: ${published[0].subject}`);
    assert(published[0].data.alertType === "stale_item", `alertType: ${published[0].data.alertType}`);
    assert(published[0].data.exp === "EXP-500", `exp: ${published[0].data.exp}`);
    assert(published[0].data.action === "update", `action: ${published[0].data.action}`);
    assert(published[0].machine === "TestMachine", `machine: ${published[0].machine}`);
  });

  await test("stale handler does NOT create chore for 'update' action", async () => {
    const logs = [];
    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Test" },
      (msg) => logs.push(msg),
      { publishJSON: () => {} }
    );

    await handler.handleStaleExpeditions(
      [{ exp: "EXP-600", action: "update", reasoning: "Needs review" }],
      { natsConn: null, dryRun: true }
    );

    const choreLog = logs.filter((l) => l.includes("chore"));
    assert(choreLog.length === 0, `should not create chore for update: ${choreLog.join(", ")}`);
  });

  await test("stale handler creates chore for 'close' and 'archive' actions (dry run)", async () => {
    const logs = [];
    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Test" },
      (msg) => logs.push(msg),
      { publishJSON: () => {} }
    );

    await handler.handleStaleExpeditions(
      [
        { exp: "EXP-700", action: "close", reasoning: "All files deleted" },
        { exp: "EXP-800", action: "archive", reasoning: "Superseded by EXP-900" },
      ],
      { natsConn: null, dryRun: true }
    );

    const choreLogs = logs.filter((l) => l.includes("would create chore"));
    assert(choreLogs.length === 2, `chore logs: ${choreLogs.length} (expected 2)`);
    assert(choreLogs[0].includes("Close stale EXP-700"), `chore 1: ${choreLogs[0]}`);
    assert(choreLogs[1].includes("Archive stale EXP-800"), `chore 2: ${choreLogs[1]}`);
  });

  console.log("\n--- Stale Handler: Chore Title Formatting ---");

  await test("chore title capitalizes action and truncates reasoning", async () => {
    const logs = [];
    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Test" },
      (msg) => logs.push(msg),
      { publishJSON: () => {} }
    );

    const longReasoning = "This is a very long reasoning string that should be truncated to sixty characters because we want concise chore titles";
    await handler.handleStaleExpeditions(
      [{ exp: "EXP-900", action: "close", reasoning: longReasoning }],
      { natsConn: null, dryRun: true }
    );

    const choreLog = logs.find((l) => l.includes("would create chore"));
    assert(choreLog, "should have chore log");
    assert(choreLog.includes("Close stale EXP-900"), "should start with capitalized action");
    assert(choreLog.includes("..."), "long reasoning should be truncated");
  });

  // ─── parseProposals → Stale Handler Wiring ──────────────────────────────────

  console.log("\n--- parseProposals → Stale Handler Wiring ---");

  await test("parseProposals output feeds directly into stale handler", async () => {
    const llmOutput = JSON.stringify({
      proposals: [{ exp: "EXP-100", title: "Test", priority: "high", agent: "DGX", reasoning: "r" }],
      stale_expeditions: [
        { exp: "EXP-50", action: "close", reasoning: "Missing all referenced files" },
        { exp: "EXP-60", action: "archive", reasoning: "Superseded by EXP-300" },
      ],
      needs_review: [{ exp: "EXP-70", question: "Is this still relevant?" }],
      reasoning: "Found stale items",
    });

    // Step 1: parseProposals (real function)
    const parsed = parseProposals(llmOutput);
    assert(parsed.staleExpeditions.length === 2, `stale: ${parsed.staleExpeditions.length}`);
    assert(parsed.needsReview.length === 1, `needsReview: ${parsed.needsReview.length}`);

    // Step 2: Feed into stale handler (real function)
    const published = [];
    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Test" },
      () => {},
      { publishJSON: (nc, subj, data) => published.push({ subj, data }) }
    );

    await handler.handleStaleExpeditions(parsed.staleExpeditions, {
      natsConn: { nc: {} },
      dryRun: false,
    });

    assert(published.length === 2, `published alerts: ${published.length}`);
    assert(published[0].data.exp === "EXP-50", `alert 1 exp: ${published[0].data.exp}`);
    assert(published[1].data.exp === "EXP-60", `alert 2 exp: ${published[1].data.exp}`);
    assert(published[0].data.alertType === "stale_item", `alert type: ${published[0].data.alertType}`);
  });

  await test("parseProposals defaults stale and review arrays when missing", () => {
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

  // ─── Scan Fallback ─────────────────────────────────────────────────────────

  console.log("\n--- Scan Fallback: No LLM → Raw Backlog ---");

  test("parseProposals returns raw text as reasoning when unparseable", () => {
    const rawText = "I cannot provide proposals because the LLM is unavailable.";
    const result = parseProposals(rawText);
    assert(result.proposals.length === 0, `proposals: ${result.proposals.length}`);
    assert(result.reasoning === rawText, "reasoning should be raw text");
    assert(result.staleExpeditions.length === 0, "no stale items");
    assert(result.fleetSummary === "", "no fleet summary");
  });

  // ─── parseSimpleFrontmatter Direct Tests ───────────────────────────────────

  console.log("\n--- parseSimpleFrontmatter Direct Tests ---");

  test("parses standard YAML frontmatter", () => {
    const fm = parseSimpleFrontmatter(`---
id: EXP-100
title: Test Expedition
status: backlog
priority: high
assignee: Mini
---
# Content`);
    assert(fm.id === "EXP-100", `id: ${fm.id}`);
    assert(fm.title === "Test Expedition", `title: ${fm.title}`);
    assert(fm.status === "backlog", `status: ${fm.status}`);
    assert(fm.priority === "high", `priority: ${fm.priority}`);
    assert(fm.assignee === "Mini", `assignee: ${fm.assignee}`);
  });

  test("skips @prefix and < RDF lines in Yurtle frontmatter", () => {
    const fm = parseSimpleFrontmatter(`---
@prefix kb: <https://nusy.dev/kb/> .
@prefix exp: <https://nusy.dev/expedition/> .
<#EXP-300> a kb:Expedition .
id: EXP-300
title: Yurtle Knowledge Expedition
status: backlog
tags: [yurtle, rdf, graph]
---
# Content`);
    assert(fm.id === "EXP-300", `id: ${fm.id}`);
    assert(fm.title === "Yurtle Knowledge Expedition", `title: ${fm.title}`);
    assert(!fm["@prefix"], "@prefix should be skipped");
    assert(Array.isArray(fm.tags), "tags should be array");
    assert(fm.tags.includes("rdf"), `tags: ${fm.tags}`);
  });

  test("handles quoted title with colons (split bug fix)", () => {
    const fm = parseSimpleFrontmatter(`---
id: EXP-999
title: "HDD: Hypothesis-Driven Development"
status: backlog
---
# Content`);
    assert(fm.title === "HDD: Hypothesis-Driven Development", `title: ${fm.title}`);
  });

  test("handles unquoted value with colons", () => {
    const fm = parseSimpleFrontmatter(`---
id: EXP-888
title: Fix bug: memory leak in parser
status: in-progress
---
# Content`);
    assert(fm.title === "Fix bug: memory leak in parser", `title: ${fm.title}`);
  });

  test("parses array tags correctly", () => {
    const fm = parseSimpleFrontmatter(`---
tags: [testing, yurtle-first, "graph query"]
---`);
    assert(Array.isArray(fm.tags), "tags should be array");
    assert(fm.tags.length === 3, `tags length: ${fm.tags.length}`);
    assert(fm.tags.includes("testing"), "has testing");
    assert(fm.tags.includes("yurtle-first"), "has yurtle-first");
    assert(fm.tags.includes("graph query"), "has graph query");
  });

  test("handles empty tag arrays", () => {
    const fm = parseSimpleFrontmatter(`---
id: EXP-777
tags: []
---`);
    assert(Array.isArray(fm.tags), "tags should be array");
    assert(fm.tags.length === 0, `tags length: ${fm.tags.length}`);
  });

  test("returns empty object for missing frontmatter", () => {
    const fm = parseSimpleFrontmatter("# No frontmatter here\nJust content.");
    assert(Object.keys(fm).length === 0, `keys: ${Object.keys(fm)}`);
  });

  test("handles related array with EXP references", () => {
    const fm = parseSimpleFrontmatter(`---
id: EXP-100
related: [EXP-99, EXP-200, EXP-300]
---`);
    assert(Array.isArray(fm.related), "related should be array");
    assert(fm.related.length === 3, `related length: ${fm.related.length}`);
    assert(fm.related[0] === "EXP-99", `first: ${fm.related[0]}`);
  });

  // ─── Full Pipeline: parse → stale handler → dedup ─────────────────────────

  console.log("\n--- Full Pipeline: LLM JSON → parse → stale → dedup ---");

  await test("full pipeline: parse → handle → dedup across two scans", async () => {
    const scan1 = JSON.stringify({
      proposals: [],
      stale_expeditions: [
        { exp: "EXP-100", action: "close", reasoning: "Dead code" },
        { exp: "EXP-200", action: "update", reasoning: "Needs review" },
      ],
      reasoning: "Scan 1",
    });

    const scan2 = JSON.stringify({
      proposals: [],
      stale_expeditions: [
        { exp: "EXP-100", action: "close", reasoning: "Still dead" },  // duplicate
        { exp: "EXP-300", action: "archive", reasoning: "Superseded" }, // new
      ],
      reasoning: "Scan 2",
    });

    const logs = [];
    const published = [];
    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Pipeline" },
      (msg) => logs.push(msg),
      { publishJSON: (nc, subj, data) => published.push(data) }
    );

    // Scan 1
    const result1 = parseProposals(scan1);
    await handler.handleStaleExpeditions(result1.staleExpeditions, {
      natsConn: { nc: {} },
      dryRun: false,
    });

    // Scan 2
    const result2 = parseProposals(scan2);
    await handler.handleStaleExpeditions(result2.staleExpeditions, {
      natsConn: { nc: {} },
      dryRun: false,
    });

    // EXP-100 close should be deduped on scan 2
    assert(published.length === 3, `total alerts: ${published.length} (EXP-100, EXP-200, EXP-300)`);
    const exps = published.map((p) => p.exp);
    assert(exps.includes("EXP-100"), "has EXP-100");
    assert(exps.includes("EXP-200"), "has EXP-200");
    assert(exps.includes("EXP-300"), "has EXP-300");

    const skipped = logs.filter((l) => l.includes("skipped"));
    assert(skipped.length === 1, `deduped: ${skipped.length} (EXP-100 close on scan 2)`);
  });

  // ─── Summary ────────────────────────────────────────────────────────────────

  const failures = summary("Integration tests");
  process.exit(failures > 0 ? 1 : 0);
}

runTests();
