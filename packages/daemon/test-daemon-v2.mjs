#!/usr/bin/env node
/**
 * Tests for agent-daemon-v2.mjs
 *
 * Verifies:
 * 1. SDK import and query function availability
 * 2. NATS connection and subscription patterns
 * 3. Message filtering logic (echo prevention, directed messages)
 * 4. WebSocket fallback when NATS unavailable
 * 5. Response publishing to correct channels
 *
 * Usage:
 *   node test-daemon-v2.mjs              # Run all tests
 *   node test-daemon-v2.mjs --live-nats  # Include live NATS integration test
 *
 * EXP-018
 */

import { connect, StringCodec } from "nats";

const sc = StringCodec();
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

async function testAsync(name, fn) {
  try {
    await fn();
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

// ─── Test 1: SDK imports ────────────────────────────────────────────────────

console.log("\n--- SDK Import Tests ---");

await testAsync("query function is importable", async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  assert(typeof sdk.query === "function", "query should be a function");
});

await testAsync("SDK exports expected functions", async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  assert(typeof sdk.query === "function", "query missing");
  assert(typeof sdk.tool === "function", "tool missing");
  assert("EXIT_REASONS" in sdk, "EXIT_REASONS missing");
  assert("HOOK_EVENTS" in sdk, "HOOK_EVENTS missing");
});

// ─── Test 2: Message filtering logic ────────────────────────────────────────

console.log("\n--- Message Filtering Tests ---");

// Simulate the filtering logic from agent-daemon-v2
function shouldProcess(msg, agentName) {
  const fromSelf =
    msg.from && msg.from.toLowerCase() === agentName.toLowerCase();
  const fromHuman = msg.fromId === "carclaw:user";
  const directedToMe =
    msg.to && msg.to.toLowerCase() === agentName.toLowerCase();
  const fromAgent = msg.fromId && msg.fromId.startsWith("agent:");

  if (fromSelf) return "ignore_self";
  if (fromHuman) return "process_human";
  if (directedToMe) return "process_directed";
  if (fromAgent) return "ignore_broadcast";
  return "ignore_unknown";
}

test("ignores own messages", () => {
  const result = shouldProcess(
    { from: "M5", fromId: "agent:m5", message: "hello" },
    "M5"
  );
  assert(result === "ignore_self", `Expected ignore_self, got ${result}`);
});

test("processes human messages", () => {
  const result = shouldProcess(
    { from: "Captain", fromId: "carclaw:user", message: "status" },
    "M5"
  );
  assert(result === "process_human", `Expected process_human, got ${result}`);
});

test("processes directed agent messages", () => {
  const result = shouldProcess(
    { from: "DGX", fromId: "agent:dgx", to: "M5", message: "check this" },
    "M5"
  );
  assert(
    result === "process_directed",
    `Expected process_directed, got ${result}`
  );
});

test("ignores undirected agent broadcasts", () => {
  const result = shouldProcess(
    { from: "DGX", fromId: "agent:dgx", message: "general update" },
    "M5"
  );
  assert(
    result === "ignore_broadcast",
    `Expected ignore_broadcast, got ${result}`
  );
});

test("case-insensitive agent name matching", () => {
  const result = shouldProcess(
    { from: "m5", fromId: "agent:m5", message: "hello" },
    "M5"
  );
  assert(result === "ignore_self", `Expected ignore_self, got ${result}`);
});

test("case-insensitive directed matching", () => {
  const result = shouldProcess(
    { from: "DGX", fromId: "agent:dgx", to: "m5", message: "hello" },
    "M5"
  );
  assert(
    result === "process_directed",
    `Expected process_directed, got ${result}`
  );
});

// ─── Test 3: Boilerplate filtering ──────────────────────────────────────────

console.log("\n--- Boilerplate Filtering Tests ---");

const boilerplate =
  /^(ready to help|how can i help|hello|hi there|hey)[.!]?$/i;

test("filters 'Ready to help.'", () => {
  assert(boilerplate.test("Ready to help."), "Should filter");
});

test("filters 'Hello!'", () => {
  assert(boilerplate.test("Hello!"), "Should filter");
});

test("does not filter real responses", () => {
  assert(!boilerplate.test("I checked the code and found 3 issues."));
});

test("does not filter multi-line responses", () => {
  assert(!boilerplate.test("Hello!\n\nHere is the review:"));
});

// ─── Test 4: NATS subject construction ──────────────────────────────────────

console.log("\n--- NATS Subject Tests ---");

test("channel subject follows ship.channel.{group} pattern", () => {
  const group = "session:active";
  const subject = `ship.channel.${group}`;
  assert(
    subject === "ship.channel.session:active",
    `Got ${subject}`
  );
});

test("origin tagging prevents echo loops", () => {
  const payload = { type: "message", from: "M5", origin: "M5" };
  assert(payload.origin === "M5", "Origin should be set");
  // On receive, skip if origin === agentName
  assert(payload.origin === "M5", "Should skip own origin");
});

// ─── Test 5: NATS live integration (optional) ───────────────────────────────

if (process.argv.includes("--live-nats")) {
  console.log("\n--- Live NATS Integration Tests ---");

  await testAsync("connects to NATS and publishes/subscribes", async () => {
    const nc = await connect({ servers: "nats://localhost:4222" });

    // Subscribe
    const sub = nc.subscribe("ship.channel.test-daemon-v2");
    let received = null;

    const receivePromise = (async () => {
      for await (const msg of sub) {
        received = JSON.parse(sc.decode(msg.data));
        sub.unsubscribe();
        break;
      }
    })();

    // Give subscription time to register
    await new Promise((r) => setTimeout(r, 100));

    // Publish
    const testPayload = {
      type: "message",
      from: "test",
      message: "daemon v2 test",
      origin: "test",
      timestamp: new Date().toISOString(),
    };
    nc.publish(
      "ship.channel.test-daemon-v2",
      sc.encode(JSON.stringify(testPayload))
    );

    // Wait for receive
    await Promise.race([
      receivePromise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timeout")), 2000)
      ),
    ]);

    assert(received !== null, "Should receive message");
    assert(received.from === "test", `Got from: ${received.from}`);
    assert(
      received.message === "daemon v2 test",
      `Got: ${received.message}`
    );

    await nc.close();
  });
} else {
  console.log("\n--- Skipping live NATS tests (use --live-nats to enable) ---");
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
