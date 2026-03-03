#!/usr/bin/env node
/**
 * Tests for @noesis-ship/shared
 */

const {
  loadConfig,
  buildMessage,
  buildKanbanEvent,
  isFromSelf,
  isFromHuman,
  isDirectedTo,
  isFromAgent,
  channelSubject,
} = require("./index");

let passed = 0;
let failed = 0;

function test(name, fn) {
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

// ─── Config Tests ───────────────────────────────────────────────────────────

console.log("\n--- Config Tests ---");

test("loadConfig returns defaults", () => {
  const cfg = loadConfig();
  assert(cfg.natsUrl === "nats://localhost:4222", `natsUrl: ${cfg.natsUrl}`);
  assert(cfg.wsPort === 3100, `wsPort: ${cfg.wsPort}`);
  assert(cfg.maxTurns === 10, `maxTurns: ${cfg.maxTurns}`);
  assert(cfg.reconnectInterval === 3000, `reconnect: ${cfg.reconnectInterval}`);
});

test("loadConfig accepts overrides", () => {
  const cfg = loadConfig({ natsUrl: "nats://remote:4222", maxTurns: "20" });
  assert(cfg.natsUrl === "nats://remote:4222", `natsUrl: ${cfg.natsUrl}`);
  assert(cfg.maxTurns === 20, `maxTurns: ${cfg.maxTurns}`);
});

// ─── Wire Protocol Tests ────────────────────────────────────────────────────

console.log("\n--- Wire Protocol Tests ---");

test("buildMessage creates valid payload", () => {
  const msg = buildMessage({
    group: "fleet",
    from: "M5",
    fromId: "agent:m5",
    message: "hello",
  });
  assert(msg.type === "message", `type: ${msg.type}`);
  assert(msg.group === "fleet", `group: ${msg.group}`);
  assert(msg.from === "M5", `from: ${msg.from}`);
  assert(msg.timestamp, "missing timestamp");
  assert(!msg.to, "should not have to field");
});

test("buildMessage includes to field when specified", () => {
  const msg = buildMessage({
    group: "fleet",
    from: "M5",
    fromId: "agent:m5",
    message: "hello",
    to: "DGX",
  });
  assert(msg.to === "DGX", `to: ${msg.to}`);
});

test("buildKanbanEvent creates valid payload", () => {
  const evt = buildKanbanEvent("moved", { id: "EXP-018", title: "Test", status: "done" }, "noesis-ship");
  assert(evt.type === "kanban_event", `type: ${evt.type}`);
  assert(evt.event === "moved", `event: ${evt.event}`);
  assert(evt.item.id === "EXP-018", `item.id: ${evt.item.id}`);
  assert(evt.repo === "noesis-ship", `repo: ${evt.repo}`);
});

test("isFromSelf detects own messages (case-insensitive)", () => {
  assert(isFromSelf({ from: "M5" }, "M5"), "exact match");
  assert(isFromSelf({ from: "m5" }, "M5"), "lowercase");
  assert(!isFromSelf({ from: "DGX" }, "M5"), "different agent");
});

test("isFromHuman detects human messages", () => {
  assert(isFromHuman({ fromId: "carclaw:user" }), "human");
  assert(!isFromHuman({ fromId: "agent:m5" }), "agent");
});

test("isDirectedTo detects directed messages", () => {
  assert(isDirectedTo({ to: "M5" }, "M5"), "exact");
  assert(isDirectedTo({ to: "m5" }, "M5"), "lowercase");
  assert(!isDirectedTo({ to: "DGX" }, "M5"), "different");
  assert(!isDirectedTo({}, "M5"), "no to field");
});

test("isFromAgent detects agent messages", () => {
  assert(isFromAgent({ fromId: "agent:m5" }), "agent");
  assert(!isFromAgent({ fromId: "carclaw:user" }), "human");
});

test("channelSubject builds correct NATS subject", () => {
  assert(channelSubject("fleet") === "ship.channel.fleet", "fleet");
  assert(channelSubject("session:active") === "ship.channel.session:active", "session");
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
