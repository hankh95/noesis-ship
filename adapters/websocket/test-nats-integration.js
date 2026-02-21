#!/usr/bin/env node

/**
 * Test NATS integration with WebSocket adapter
 *
 * Tests:
 * 1. WebSocket -> NATS: Send message via WebSocket, verify it's published to NATS
 * 2. NATS -> WebSocket: Publish message to NATS, verify it's relayed to WebSocket
 */

const { connect, StringCodec } = require("nats");
const WebSocket = require("ws");

const NATS_URL = "nats://localhost:4222";
const WS_URL = "ws://localhost:3100";
const sc = StringCodec();

async function testNATSIntegration() {
  console.log("Starting NATS integration test...\n");

  // Connect to NATS
  console.log("[1] Connecting to NATS...");
  const nc = await connect({ servers: NATS_URL });
  console.log("    Connected to NATS");

  // Connect to WebSocket
  console.log("[2] Connecting to WebSocket...");
  const ws = new WebSocket(WS_URL);

  await new Promise((resolve) => {
    ws.on("open", () => {
      console.log("    Connected to WebSocket\n");
      resolve();
    });
  });

  // Test 1: WebSocket -> NATS
  console.log("[TEST 1] WebSocket -> NATS relay");
  const test1Promise = new Promise((resolve) => {
    const sub = nc.subscribe("ship.channel.test-group");
    (async () => {
      for await (const msg of sub) {
        const data = JSON.parse(sc.decode(msg.data));
        console.log("    ✓ Received on NATS:", data.message);
        sub.unsubscribe();
        resolve();
      }
    })();

    // Send message via WebSocket
    console.log("    Sending via WebSocket...");
    ws.send(JSON.stringify({
      type: "send",
      group: "test-group",
      message: "Hello from WebSocket",
    }));
  });

  await test1Promise;
  console.log("    TEST 1 PASSED\n");

  // Test 2: NATS -> WebSocket
  console.log("[TEST 2] NATS -> WebSocket relay");
  const test2Promise = new Promise((resolve) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "message" && msg.message === "Hello from NATS") {
        console.log("    ✓ Received on WebSocket:", msg.message);
        resolve();
      }
    });

    // Publish message to NATS
    console.log("    Publishing to NATS...");
    const natsMessage = {
      type: "message",
      group: "test-group",
      from: "NATS Test",
      fromId: "test:nats",
      message: "Hello from NATS",
      timestamp: new Date().toISOString(),
    };
    nc.publish("ship.channel.test-group", sc.encode(JSON.stringify(natsMessage)));
  });

  await test2Promise;
  console.log("    TEST 2 PASSED\n");

  // Cleanup
  ws.close();
  await nc.drain();
  console.log("All tests passed! ✓");
  process.exit(0);
}

// Timeout: fail if tests don't complete within 10 seconds
setTimeout(() => {
  console.error("Test timed out after 10s");
  process.exit(1);
}, 10000);

// Run test
testNATSIntegration().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
