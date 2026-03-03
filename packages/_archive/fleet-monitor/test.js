#!/usr/bin/env node
/**
 * Tests for @noesis-ship/fleet-monitor
 *
 * Tests alert detection logic with mock data.
 * Does NOT require NATS, tmux, or gh CLI.
 */

const { detectAlerts, _resetState } = require("./monitor");

let passed = 0;
let failed = 0;

function test(name, fn) {
  _resetState();
  try {
    fn();
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

// ─── First-Run Suppression ──────────────────────────────────────────────────

console.log("\n--- First-Run Suppression ---");

test("first run emits no alerts even with idle agents", () => {
  const sessions = [
    { name: "mini", lastActivity: Date.now() - 30 * 60_000, idleMinutes: 30, attached: true },
  ];
  const prs = [
    { number: 10, title: "Test PR", branch: "test", author: "mini", ciStatus: "SUCCESS", reviews: [] },
  ];
  const alerts = detectAlerts(sessions, prs);
  assert(alerts.length === 0, `expected 0 alerts, got ${alerts.length}`);
});

test("first run populates state for next cycle", () => {
  const sessions = [
    { name: "mini", lastActivity: Date.now(), idleMinutes: 0, attached: true },
  ];
  const prs = [];

  // First run — no alerts
  detectAlerts(sessions, prs);

  // Second run with same state — still no alerts (agent not idle)
  const alerts = detectAlerts(sessions, prs);
  assert(alerts.length === 0, `expected 0 alerts, got ${alerts.length}`);
});

// ─── Agent Stuck Detection ──────────────────────────────────────────────────

console.log("\n--- Agent Stuck Detection ---");

test("detects agent_stuck when idle exceeds threshold", () => {
  const activeSessions = [
    { name: "mini", lastActivity: Date.now(), idleMinutes: 0, attached: true },
  ];
  const idleSessions = [
    { name: "mini", lastActivity: Date.now() - 20 * 60_000, idleMinutes: 20, attached: true },
  ];

  // First run — populate
  detectAlerts(activeSessions, []);

  // Second run — agent now idle
  const alerts = detectAlerts(idleSessions, []);
  assert(alerts.length === 1, `expected 1 alert, got ${alerts.length}`);
  assert(alerts[0].alertType === "agent_stuck", `type: ${alerts[0].alertType}`);
  assert(alerts[0].payload.agent === "mini", `agent: ${alerts[0].payload.agent}`);
  assert(alerts[0].payload.idle_minutes === 20, `idle: ${alerts[0].payload.idle_minutes}`);
});

test("does not alert for agents below idle threshold", () => {
  const sessions = [
    { name: "mini", lastActivity: Date.now() - 5 * 60_000, idleMinutes: 5, attached: true },
  ];

  detectAlerts(sessions, []);
  const alerts = detectAlerts(sessions, []);
  assert(alerts.length === 0, `expected 0 alerts, got ${alerts.length}`);
});

// ─── Agent Crash Detection ──────────────────────────────────────────────────

console.log("\n--- Agent Crash Detection ---");

test("detects agent_crash when session disappears", () => {
  const sessions = [
    { name: "mini", lastActivity: Date.now(), idleMinutes: 0, attached: true },
    { name: "dgx", lastActivity: Date.now(), idleMinutes: 0, attached: true },
  ];

  // First run — two sessions
  detectAlerts(sessions, []);

  // Second run — dgx gone
  const remaining = [sessions[0]];
  const alerts = detectAlerts(remaining, []);
  assert(alerts.length === 1, `expected 1 alert, got ${alerts.length}`);
  assert(alerts[0].alertType === "agent_crash", `type: ${alerts[0].alertType}`);
  assert(alerts[0].payload.agent === "dgx", `agent: ${alerts[0].payload.agent}`);
});

// ─── PR Alerts ──────────────────────────────────────────────────────────────

console.log("\n--- PR Alerts ---");

test("detects new PR (pr_created)", () => {
  const prs1 = [
    { number: 10, title: "Old PR", branch: "old", author: "m5", ciStatus: "SUCCESS", reviews: [] },
  ];
  const prs2 = [
    ...prs1,
    { number: 11, title: "New PR", branch: "exp-999", author: "mini", ciStatus: "PENDING", reviews: [] },
  ];

  detectAlerts([], prs1);
  const alerts = detectAlerts([], prs2);

  const prAlert = alerts.find((a) => a.alertType === "pr_created");
  assert(prAlert, "expected pr_created alert");
  assert(prAlert.payload.pr === 11, `pr: ${prAlert.payload.pr}`);
  assert(prAlert.payload.agent === "mini", `agent: ${prAlert.payload.agent}`);
});

test("detects CI failure (ci_failed)", () => {
  const prs1 = [
    { number: 10, title: "Test PR", branch: "test", author: "mini", ciStatus: "PENDING", reviews: [] },
  ];
  const prs2 = [
    { number: 10, title: "Test PR", branch: "test", author: "mini", ciStatus: "FAILURE", reviews: [] },
  ];

  detectAlerts([], prs1);
  const alerts = detectAlerts([], prs2);

  const ciAlert = alerts.find((a) => a.alertType === "ci_failed");
  assert(ciAlert, "expected ci_failed alert");
  assert(ciAlert.payload.pr === 10, `pr: ${ciAlert.payload.pr}`);
});

test("does not re-alert CI failure if already FAILURE", () => {
  const prs = [
    { number: 10, title: "Test PR", branch: "test", author: "mini", ciStatus: "FAILURE", reviews: [] },
  ];

  detectAlerts([], prs);
  detectAlerts([], prs); // Second time with same FAILURE
  const alerts = detectAlerts([], prs); // Third time
  const ciAlerts = alerts.filter((a) => a.alertType === "ci_failed");
  assert(ciAlerts.length === 0, `expected 0 ci_failed alerts, got ${ciAlerts.length}`);
});

test("detects new review (pr_reviewed)", () => {
  const prs1 = [
    { number: 10, title: "Test PR", branch: "test", author: "mini", ciStatus: "SUCCESS", reviews: [] },
  ];
  const prs2 = [
    {
      number: 10, title: "Test PR", branch: "test", author: "mini", ciStatus: "SUCCESS",
      reviews: [{ author: "m5", state: "APPROVED" }],
    },
  ];

  detectAlerts([], prs1);
  const alerts = detectAlerts([], prs2);

  const reviewAlert = alerts.find((a) => a.alertType === "pr_reviewed");
  assert(reviewAlert, "expected pr_reviewed alert");
  assert(reviewAlert.payload.pr === 10, `pr: ${reviewAlert.payload.pr}`);
  assert(reviewAlert.payload.reviewer === "m5", `reviewer: ${reviewAlert.payload.reviewer}`);
  assert(reviewAlert.payload.passed === true, `passed: ${reviewAlert.payload.passed}`);
});

// ─── Deduplication ──────────────────────────────────────────────────────────

console.log("\n--- Deduplication ---");

test("agent_stuck is not duplicated in consecutive cycles", () => {
  const sessions = [
    { name: "mini", lastActivity: Date.now() - 20 * 60_000, idleMinutes: 20, attached: true },
  ];

  // First run — populate
  detectAlerts(sessions, []);

  // Second run — detect
  const alerts1 = detectAlerts(sessions, []);
  assert(alerts1.length === 1, `cycle 2: expected 1 alert, got ${alerts1.length}`);

  // Third run — should be deduped
  const alerts2 = detectAlerts(sessions, []);
  const stuckAlerts = alerts2.filter((a) => a.alertType === "agent_stuck");
  assert(stuckAlerts.length === 0, `cycle 3: expected 0 stuck alerts, got ${stuckAlerts.length}`);
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
