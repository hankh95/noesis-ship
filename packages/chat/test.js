#!/usr/bin/env node
/**
 * @noesis-ship/chat — Tests
 *
 * Run: node test.js
 */

const http = require("http");
const assert = require("assert");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ─── Helper: HTTP request ────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port: 0, // set before calling
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) opts.headers["Content-Length"] = Buffer.byteLength(body);

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Unit Tests (no server needed) ──────────────────────────────────────────

function runUnitTests() {
  console.log("\n--- Unit Tests ---");

  const { ChatService } = require("./chat-service");

  test("ChatService constructor sets defaults", () => {
    const svc = new ChatService({ port: 0 });
    assert.strictEqual(svc.natsConnected, false);
    assert.ok(svc.history instanceof Map);
    assert.ok(svc.channels instanceof Set);
  });

  test("trackMessage adds to history and channels", () => {
    const svc = new ChatService({ port: 0 });
    const msg = {
      type: "message",
      group: "fleet",
      from: "M5",
      fromId: "agent:m5",
      message: "hello",
      timestamp: new Date().toISOString(),
    };
    svc.trackMessage(msg);
    assert.strictEqual(svc.history.get("fleet").length, 1);
    assert.ok(svc.channels.has("fleet"));
  });

  test("trackMessage caps history at maxHistory", () => {
    const svc = new ChatService({ port: 0, maxHistory: 3 });
    for (let i = 0; i < 5; i++) {
      svc.trackMessage({
        type: "message",
        group: "fleet",
        from: "M5",
        message: `msg-${i}`,
        timestamp: new Date().toISOString(),
      });
    }
    const hist = svc.history.get("fleet");
    assert.strictEqual(hist.length, 3);
    assert.strictEqual(hist[0].message, "msg-2");
  });

  test("getHistory returns empty array for unknown channel", () => {
    const svc = new ChatService({ port: 0 });
    assert.deepStrictEqual(svc.getHistory("nonexistent"), []);
  });

  test("getHistory respects limit", () => {
    const svc = new ChatService({ port: 0 });
    for (let i = 0; i < 10; i++) {
      svc.trackMessage({
        type: "message",
        group: "test",
        from: "M5",
        message: `msg-${i}`,
        timestamp: new Date().toISOString(),
      });
    }
    const recent = svc.getHistory("test", 3);
    assert.strictEqual(recent.length, 3);
    assert.strictEqual(recent[0].message, "msg-7");
  });
}

// ─── Integration Tests (HTTP server) ────────────────────────────────────────

async function runIntegrationTests() {
  console.log("\n--- Integration Tests (HTTP) ---");

  const { ChatService } = require("./chat-service");
  const svc = new ChatService({ port: 0, machineName: "Test" });

  // Start server on random port
  await svc.startHTTP();
  const port = svc.httpServer.address().port;

  // Patch request helper to use the dynamic port
  function req(method, path, body) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { "Content-Type": "application/json" },
      };
      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) opts.headers["Content-Length"] = Buffer.byteLength(bodyStr);

      const r = http.request(opts, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      r.on("error", reject);
      if (bodyStr) r.write(bodyStr);
      r.end();
    });
  }

  await asyncTest("POST /api/send requires content", async () => {
    const res = await req("POST", "/api/send", { channel: "fleet" });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes("content"));
  });

  await asyncTest("POST /api/send requires channel", async () => {
    const res = await req("POST", "/api/send", { content: "hello" });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes("channel"));
  });

  await asyncTest("POST /api/send tracks message locally (no NATS)", async () => {
    const res = await req("POST", "/api/send", {
      channel: "fleet",
      content: "hello fleet",
      sender: "Captain",
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.ok);
    assert.ok(res.body.published);
    // Message should be tracked
    assert.strictEqual(svc.history.get("fleet").length, 1);
  });

  await asyncTest("GET /api/history/:channel returns tracked messages", async () => {
    const res = await req("GET", "/api/history/fleet");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.channel, "fleet");
    assert.strictEqual(res.body.messages.length, 1);
    assert.strictEqual(res.body.messages[0].message, "hello fleet");
  });

  await asyncTest("GET /api/history/:channel respects limit", async () => {
    // Add more messages
    for (let i = 0; i < 5; i++) {
      await req("POST", "/api/send", {
        channel: "fleet",
        content: `msg-${i}`,
        sender: "Captain",
      });
    }
    const res = await req("GET", "/api/history/fleet?limit=2");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.messages.length, 2);
  });

  await asyncTest("GET /api/channels lists known channels", async () => {
    const res = await req("GET", "/api/channels");
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.channels.includes("fleet"));
  });

  await asyncTest("GET /health reports status", async () => {
    const res = await req("GET", "/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, "ok");
    assert.strictEqual(res.body.nats_connected, false);
    assert.ok(res.body.timestamp);
  });

  await asyncTest("GET unknown path returns 404", async () => {
    const res = await req("GET", "/nonexistent");
    assert.strictEqual(res.status, 404);
  });

  // Cleanup
  svc.stop();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log("@noesis-ship/chat tests\n");

  runUnitTests();
  await runIntegrationTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
