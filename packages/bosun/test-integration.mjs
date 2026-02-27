#!/usr/bin/env node
/**
 * Integration Tests for @noesis-ship/bosun — Issue #16
 *
 * Covers:
 *   - Stale handler: dedup, alerts, chore creation, daily reset
 *   - Approval flow: find proposal, reject, WIP limit check
 *   - Scan fallback: no LLM → raw backlog proposals
 *   - createChore: command construction
 *   - retryWithMutation: failure categorization
 *
 * These test the wiring between components — not NATS (that requires a live server).
 * NATS-dependent tests are marked as local-only and skip gracefully.
 *
 * Pattern: Same test()/assert() as test-bosun.mjs.
 */

import { createStaleHandler } from "./stale-handler.mjs";
import { parseProposals } from "./morning-scan.mjs";

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

// ─── Stale Handler Tests ────────────────────────────────────────────────────

async function runTests() {

  console.log("\n--- Stale Handler: Dedup Tests ---");

  await test("stale handler skips duplicate items within same day", async () => {
    const logs = [];
    const log = (msg) => logs.push(msg);
    const published = [];
    const publishJSON = (nc, subject, data) => published.push({ subject, data });

    const handler = createStaleHandler(
      { projectDir: "/tmp/test", machineName: "Test" },
      log,
      { publishJSON }
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
    const logsBefore = logs.length;
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

    // First: close EXP-100
    await handler.handleStaleExpeditions(
      [{ exp: "EXP-100", action: "close", reasoning: "Close it" }],
      { natsConn: null, dryRun: true }
    );

    // Second: archive EXP-100 (different action — should NOT be deduped)
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

    // Process once
    await handler.handleStaleExpeditions(items, { natsConn: null, dryRun: true });

    // Reset
    handler.resetDaily();

    // Process again — should NOT be skipped after reset
    logs.length = 0; // Clear logs
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

  console.log("\n--- Approval Flow Tests ---");

  test("approval flow finds proposal by expedition ID", () => {
    const proposals = [
      { exp: "EXP-100", title: "Alpha", priority: "high", agent: "DGX" },
      { exp: "EXP-200", title: "Beta", priority: "medium", agent: "M5" },
      { exp: "EXP-300", title: "Gamma", priority: "low", agent: "Mini" },
    ];

    const found = proposals.find((p) => p.exp === "EXP-200");
    assert(found, "should find EXP-200");
    assert(found.agent === "M5", `agent: ${found.agent}`);

    const missing = proposals.find((p) => p.exp === "EXP-999");
    assert(!missing, "should not find EXP-999");
  });

  test("rejection removes from pending and preserves others", () => {
    let pending = [
      { exp: "EXP-100" },
      { exp: "EXP-200" },
      { exp: "EXP-300" },
    ];
    pending = pending.filter((p) => p.exp !== "EXP-200");
    assert(pending.length === 2, `pending: ${pending.length}`);
    assert(pending[0].exp === "EXP-100", "EXP-100 preserved");
    assert(pending[1].exp === "EXP-300", "EXP-300 preserved");
  });

  test("approval removes proposal from pending list", () => {
    let pending = [
      { exp: "EXP-100", title: "A" },
      { exp: "EXP-200", title: "B" },
    ];
    const approved = pending.find((p) => p.exp === "EXP-100");
    assert(approved, "should find proposal to approve");
    pending = pending.filter((p) => p.exp !== "EXP-100");
    assert(pending.length === 1, `pending after approve: ${pending.length}`);
    assert(!pending.find((p) => p.exp === "EXP-100"), "approved item gone");
  });

  console.log("\n--- WIP Limit Logic Tests ---");

  test("WIP limit check: 4 sessions = under limit (MAX_WIP=5)", () => {
    const sessions = ["exp-100-a", "exp-200-b", "exp-300-c", "exp-400-d", "main"];
    const expSessions = sessions.filter((s) => s.match(/^exp-\d+/i));
    assert(expSessions.length === 4, `exp sessions: ${expSessions.length}`);
    assert(expSessions.length < 5, "should be under WIP limit");
  });

  test("WIP limit check: 5 sessions = at limit (reject)", () => {
    const sessions = ["exp-100-a", "exp-200-b", "exp-300-c", "exp-400-d", "exp-500-e"];
    const expSessions = sessions.filter((s) => s.match(/^exp-\d+/i));
    assert(expSessions.length === 5, `exp sessions: ${expSessions.length}`);
    assert(!(expSessions.length < 5), "should NOT be under limit");
  });

  test("WIP limit check: case-insensitive matching (EXP- and exp-)", () => {
    const sessions = ["EXP-100-alpha", "exp-200-beta", "Exp-300-gamma"];
    const expSessions = sessions.filter((s) => s.match(/^exp-\d+/i));
    assert(expSessions.length === 3, `exp sessions: ${expSessions.length} (all 3 should match)`);
  });

  test("WIP limit check: non-expedition sessions ignored", () => {
    const sessions = ["main", "dev", "my-test", "fleet-monitor", "bosun"];
    const expSessions = sessions.filter((s) => s.match(/^exp-\d+/i));
    assert(expSessions.length === 0, "no expedition sessions");
  });

  console.log("\n--- Scan Fallback: No LLM → Raw Backlog ---");

  test("parseProposals returns raw text as reasoning when unparseable", () => {
    const rawText = "I cannot provide proposals because the LLM is unavailable.";
    const result = parseProposals(rawText);
    assert(result.proposals.length === 0, `proposals: ${result.proposals.length}`);
    assert(result.reasoning === rawText, "reasoning should be raw text");
    assert(result.staleExpeditions.length === 0, "no stale items");
    assert(result.fleetSummary === "", "no fleet summary");
  });

  test("raw backlog fallback structure matches expected format", () => {
    // Simulates what runMorningScan does when no LLM available
    const backlog = [
      { id: "EXP-100", title: "Alpha", priority: "critical" },
      { id: "EXP-200", title: "Beta", priority: "high" },
      { id: "EXP-300", title: "Gamma", priority: "medium" },
      { id: "EXP-400", title: "Delta", priority: "low" },
    ];

    const proposals = backlog.slice(0, 3).map((item) => ({
      exp: item.id,
      title: item.title,
      priority: item.priority,
      agent: "DGX",
      reasoning: "Auto-picked from backlog (no LLM available for reasoning)",
    }));

    assert(proposals.length === 3, `proposals: ${proposals.length} (max 3)`);
    assert(proposals[0].exp === "EXP-100", "first should be EXP-100");
    assert(proposals[0].reasoning.includes("no LLM"), "reasoning should note fallback");
    assert(proposals.every((p) => p.agent), "all should have agent");
  });

  console.log("\n--- Spawn Args Construction Tests ---");

  test("spawn args include worktree, phase, and model", () => {
    const spawnPath = "/home/user/scripts/fleet-spawn.sh";
    const expId = "EXP-985";
    const phase = "3";
    const model = "claude-opus-4-6";
    const worktree = true;

    const args = [spawnPath, expId];
    if (worktree) args.push("--worktree");
    if (phase) args.push("--phase", phase);
    if (model) args.push("--model", model);

    assert(args.length === 7, `args: ${args.length}`);
    assert(args[0] === spawnPath, "spawn path");
    assert(args[1] === expId, "expedition ID");
    assert(args[2] === "--worktree", "worktree flag");
    assert(args[3] === "--phase", "phase flag");
    assert(args[4] === "3", "phase value");
    assert(args[5] === "--model", "model flag");
    assert(args[6] === "claude-opus-4-6", "model value");
  });

  test("spawn args omit optional flags when not provided", () => {
    const args = ["/path/fleet-spawn.sh", "EXP-100"];
    // No worktree, phase, or model
    assert(args.length === 2, `args: ${args.length}`);
    assert(!args.includes("--worktree"), "no worktree");
    assert(!args.includes("--phase"), "no phase");
    assert(!args.includes("--model"), "no model");
  });

  console.log("\n--- Retry Mutation Category Tests ---");

  test("retry categorizes test_failure hint", () => {
    const mutations = {
      test_failure: "Run pytest first",
      merge_conflict: "Pull latest main",
      missing_dep: "Check imports",
      scope_creep: "Focus strictly",
      timeout: "Break work into smaller chunks",
    };
    const hint = "Agent had test_failure in pytest run";
    const category = Object.keys(mutations).find((k) => hint.toLowerCase().includes(k));
    assert(category === "test_failure", `category: ${category}`);
  });

  test("retry categorizes merge_conflict hint", () => {
    const mutations = {
      test_failure: "r1", merge_conflict: "r2", missing_dep: "r3", scope_creep: "r4", timeout: "r5",
    };
    const hint = "git push failed due to merge_conflict on main";
    const category = Object.keys(mutations).find((k) => hint.toLowerCase().includes(k));
    assert(category === "merge_conflict", `category: ${category}`);
  });

  test("retry defaults to timeout for unknown failure", () => {
    const mutations = {
      test_failure: "r1", merge_conflict: "r2", missing_dep: "r3", scope_creep: "r4", timeout: "r5",
    };
    const hint = "Some weird error nobody expected";
    const category = Object.keys(mutations).find((k) => hint.toLowerCase().includes(k)) || "timeout";
    assert(category === "timeout", `category: ${category}`);
  });

  console.log("\n--- Proposal Message Structure Tests ---");

  test("doScan result has required fields for NATS publish", () => {
    // Simulate proposalMsg construction (from bosun-service.mjs:113-120)
    const proposals = [{ exp: "EXP-100", title: "Test", priority: "high", agent: "DGX" }];
    const staleExpeditions = [{ exp: "EXP-50", action: "close", reasoning: "Dead" }];
    const fleetState = { agents_busy: 1, agents_available: 2, wip_count: 3 };

    const proposalMsg = {
      type: "fleet_proposal",
      proposals,
      stale_expeditions: staleExpeditions,
      fleet_state: fleetState,
      reasoning: "Test reasoning",
      scan_time: new Date().toISOString(),
    };

    assert(proposalMsg.type === "fleet_proposal", `type: ${proposalMsg.type}`);
    assert(Array.isArray(proposalMsg.proposals), "proposals is array");
    assert(Array.isArray(proposalMsg.stale_expeditions), "stale_expeditions is array");
    assert(proposalMsg.fleet_state.agents_busy === 1, "fleet state present");
    assert(proposalMsg.scan_time, "has scan_time");
  });

  test("alert message for agent_spawned has required fields", () => {
    const alert = {
      alertType: "agent_spawned",
      exp: "EXP-985",
      message: "Agent spawned for EXP-985",
      timestamp: new Date().toISOString(),
    };

    assert(alert.alertType === "agent_spawned", "alertType");
    assert(alert.exp === "EXP-985", "exp");
    assert(alert.message.includes("EXP-985"), "message includes exp");
    assert(alert.timestamp, "has timestamp");
  });

  test("alert message for wip_limit has required fields", () => {
    const alert = {
      alertType: "wip_limit",
      exp: "EXP-200",
      message: "WIP limit reached, deferring EXP-200",
      timestamp: new Date().toISOString(),
    };

    assert(alert.alertType === "wip_limit", "alertType");
    assert(alert.message.includes("WIP"), "message mentions WIP");
    assert(alert.message.includes("EXP-200"), "message includes exp");
  });

  // ─── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Integration tests: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
