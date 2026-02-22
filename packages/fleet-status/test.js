#!/usr/bin/env node
/**
 * @noesis-ship/fleet-status — Tests
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

// ─── Mock upstream servers ──────────────────────────────────────────────────

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

// ─── Helper: HTTP request ────────────────────────────────────────────────────

function req(port, method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    r.on("error", reject);
    r.end();
  });
}

// ─── Unit Tests ─────────────────────────────────────────────────────────────

function runUnitTests() {
  console.log("\n--- Unit Tests ---");

  const { FleetStatusService } = require("./fleet-status-service");

  test("constructor sets defaults", () => {
    const svc = new FleetStatusService({ port: 0 });
    assert.strictEqual(svc.port, 0);
    assert.ok(svc.natsMonitoringUrl);
  });

  test("parseConnections extracts agent names", () => {
    const svc = new FleetStatusService({ port: 0 });
    const connz = {
      connections: [
        { name: "relay", ip: "127.0.0.1", lang: "javascript" },
        { name: "fleet-log", ip: "127.0.0.1", lang: "javascript" },
        { name: "", ip: "127.0.0.1", lang: "nats-cli" },
      ],
    };
    const result = svc.parseConnections(connz);
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.named.length, 2);
    assert.ok(result.named.includes("relay"));
    assert.ok(result.named.includes("fleet-log"));
  });

  test("parseConnections handles empty connections", () => {
    const svc = new FleetStatusService({ port: 0 });
    const result = svc.parseConnections({ connections: [] });
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.named.length, 0);
  });
}

// ─── Integration Tests (with mock upstream servers) ─────────────────────────

async function runIntegrationTests() {
  console.log("\n--- Integration Tests (HTTP) ---");

  // Mock NATS monitoring (:8222)
  const mockNats = await createMockServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/healthz") {
      res.end(JSON.stringify({ status: "ok" }));
    } else if (req.url === "/connz") {
      res.end(JSON.stringify({
        connections: [
          { name: "relay", ip: "127.0.0.1", lang: "javascript" },
          { name: "daemon", ip: "127.0.0.1", lang: "javascript" },
        ],
      }));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });

  // Mock relay health
  const mockRelay = await createMockServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  });

  // Mock chat health
  const mockChat = await createMockServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", nats_connected: true }));
  });

  const natsPort = mockNats.address().port;
  const relayPort = mockRelay.address().port;
  const chatPort = mockChat.address().port;

  const { FleetStatusService } = require("./fleet-status-service");
  const svc = new FleetStatusService({
    port: 0,
    natsMonitoringUrl: `http://127.0.0.1:${natsPort}`,
    relayHealthUrl: `http://127.0.0.1:${relayPort}`,
    chatHealthUrl: `http://127.0.0.1:${chatPort}`,
  });

  await svc.startHTTP();
  const port = svc.httpServer.address().port;

  await asyncTest("GET /api/status returns healthy when all services up", async () => {
    const res = await req(port, "GET", "/api/status");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.overall, "healthy");
    assert.strictEqual(res.body.nats, "healthy");
    assert.strictEqual(res.body.relay, "healthy");
    assert.strictEqual(res.body.chat, "healthy");
    assert.ok(res.body.timestamp);
  });

  await asyncTest("GET /api/connections parses connz", async () => {
    const res = await req(port, "GET", "/api/connections");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total, 2);
    assert.ok(res.body.named.includes("relay"));
    assert.ok(res.body.named.includes("daemon"));
  });

  await asyncTest("GET /api/nats returns NATS health", async () => {
    const res = await req(port, "GET", "/api/nats");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, "healthy");
    assert.ok(res.body.connections);
  });

  await asyncTest("GET /health returns service health", async () => {
    const res = await req(port, "GET", "/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, "ok");
  });

  // Now test degraded mode: shut down NATS mock
  mockNats.close();

  await asyncTest("GET /api/status returns degraded when NATS down", async () => {
    const res = await req(port, "GET", "/api/status");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.overall, "degraded");
    assert.strictEqual(res.body.nats, "unreachable");
  });

  await asyncTest("GET unknown path returns 404", async () => {
    const res = await req(port, "GET", "/nonexistent");
    assert.strictEqual(res.status, 404);
  });

  // Cleanup
  svc.stop();
  mockRelay.close();
  mockChat.close();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log("@noesis-ship/fleet-status tests\n");

  runUnitTests();
  await runIntegrationTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
