#!/usr/bin/env node
/**
 * Integration test for the WebSocket adapter.
 *
 * Starts the server, connects a test client, sends a message, and verifies
 * it's relayed correctly. Exits with code 0 on success, 1 on failure.
 *
 * Usage: node tests/test_websocket_adapter.js
 */

const { spawn } = require("child_process");
const WebSocket = require("ws");
const path = require("path");

const WS_PORT = 13100; // Use a non-standard port to avoid conflicts
const TIMEOUT_MS = 10000;

let server;
let passed = 0;
let failed = 0;

function log(msg) {
  console.log(`[test] ${msg}`);
}

function assert(condition, msg) {
  if (condition) {
    passed++;
    log(`  PASS: ${msg}`);
  } else {
    failed++;
    log(`  FAIL: ${msg}`);
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "adapters", "websocket", "server.js");
    server = spawn("node", [serverPath], {
      env: {
        ...process.env,
        WS_PORT: String(WS_PORT),
        MACHINE_NAME: "TestMachine",
        AGENTS: "test:TestAgent",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let started = false;

    server.stdout.on("data", (data) => {
      const line = data.toString();
      if (!started && line.includes("listening")) {
        started = true;
        resolve();
      }
    });

    server.stderr.on("data", (data) => {
      // Suppress stderr during tests
    });

    server.on("error", reject);

    // Timeout if server doesn't start
    setTimeout(() => {
      if (!started) reject(new Error("Server start timeout"));
    }, 5000);
  });
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Client connect timeout")), 3000);
  });
}

function waitForMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Message timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function runTests() {
  log("Starting WebSocket adapter integration tests...\n");

  // Test 1: Server starts and accepts connections
  log("Test 1: Server accepts connections");
  try {
    await startServer();
    assert(true, "Server started on port " + WS_PORT);
  } catch (err) {
    assert(false, "Server failed to start: " + err.message);
    return;
  }

  // Test 2: Client connects and receives status
  log("\nTest 2: Client receives status on connect");
  let client1;
  try {
    client1 = await connectClient();
    assert(true, "Client 1 connected");

    const status = await waitForMessage(client1);
    assert(status.type === "status", `Received status message (type=${status.type})`);
    assert(status.machine === "TestMachine", `Machine name is TestMachine (got ${status.machine})`);
    assert(Array.isArray(status.agents), "Agents is an array");
    assert(status.agents.length > 0, `Has agents (count=${status.agents?.length})`);
  } catch (err) {
    assert(false, "Client connection/status failed: " + err.message);
    return;
  }

  // Test 3: Second client connects
  log("\nTest 3: Second client connects");
  let client2;
  try {
    client2 = await connectClient();
    assert(true, "Client 2 connected");

    const status = await waitForMessage(client2);
    assert(status.type === "status", "Client 2 received status");
  } catch (err) {
    assert(false, "Client 2 failed: " + err.message);
  }

  // Test 4: Message relay between clients
  log("\nTest 4: Message relay between clients");
  try {
    const messagePromise = waitForMessage(client2);

    client1.send(JSON.stringify({
      type: "send",
      group: "session:test",
      to: "test",
      message: "Hello from test",
    }));

    const relayed = await messagePromise;
    assert(relayed.type === "message", `Relayed message type is "message" (got ${relayed.type})`);
    assert(relayed.message.includes("Hello from test"), `Message content relayed correctly`);
    assert(relayed.from === "User", `From field is "User" (got ${relayed.from})`);
  } catch (err) {
    assert(false, "Message relay failed: " + err.message);
  }

  // Test 5: List groups
  log("\nTest 5: List groups request");
  try {
    const groupsPromise = waitForMessage(client1);
    client1.send(JSON.stringify({ type: "list_groups" }));
    const groups = await groupsPromise;
    assert(groups.type === "groups", `Groups response type (got ${groups.type})`);
    assert(Array.isArray(groups.groups), "Groups is an array");
  } catch (err) {
    assert(false, "List groups failed: " + err.message);
  }

  // Cleanup
  client1?.close();
  client2?.close();
}

async function main() {
  try {
    await runTests();
  } catch (err) {
    log(`Unexpected error: ${err.message}`);
    failed++;
  } finally {
    if (server) {
      server.kill("SIGTERM");
    }

    log(`\n=============================`);
    log(`Results: ${passed} passed, ${failed} failed`);
    log(`=============================`);

    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
