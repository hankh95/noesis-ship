#!/usr/bin/env node

/**
 * Quick test: connects to the bridge WebSocket and verifies
 * it receives a status message on connect.
 *
 * Usage: node test-ws.js [url]
 *   Default url: ws://localhost:3100
 */

const WebSocket = require("ws");

const url = process.argv[2] || "ws://localhost:3100";
const TIMEOUT_MS = 5000;

console.log(`[Test] Connecting to ${url}...`);

const ws = new WebSocket(url);
let passed = false;

const timer = setTimeout(() => {
  if (!passed) {
    console.error("[Test] FAIL — timed out waiting for status message");
    ws.close();
    process.exit(1);
  }
}, TIMEOUT_MS);

ws.on("open", () => {
  console.log("[Test] Connected");
});

ws.on("message", (data) => {
  if (passed) return; // Ignore messages after first pass

  const msg = JSON.parse(data.toString());
  console.log("[Test] Received:", JSON.stringify(msg, null, 2));

  if (msg.type === "status") {
    const services = [];
    if (msg.telegram) services.push(`telegram=${msg.telegram}`);
    if (msg.whatsapp) services.push(`whatsapp=${msg.whatsapp}`);
    console.log(`[Test] PASS — status: ${services.join(", ")}`);
    passed = true;
    clearTimeout(timer);

    // Also test sending a message (will fail gracefully if no service connected)
    const testSend = {
      type: "send",
      group: "tg:test-group",
      to: "mini",
      message: "@mini test from bridge test script",
    };
    console.log("[Test] Sending test message...");
    ws.send(JSON.stringify(testSend));

    setTimeout(() => {
      console.log("[Test] Done");
      ws.close();
      process.exit(0);
    }, 500);
  }
});

ws.on("error", (err) => {
  console.error(`[Test] FAIL — connection error: ${err.message}`);
  clearTimeout(timer);
  process.exit(1);
});

ws.on("close", () => {
  console.log("[Test] Disconnected");
});
