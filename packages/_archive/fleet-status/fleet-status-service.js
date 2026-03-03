#!/usr/bin/env node
/**
 * @noesis-ship/fleet-status — Fleet Health Monitoring Service
 *
 * HTTP API that polls NATS monitoring and service endpoints to provide
 * a comprehensive fleet health summary.
 *
 * Endpoints:
 *   GET /api/status       — Full fleet status (NATS, relay, chat, agents)
 *   GET /api/nats         — NATS health + connection info
 *   GET /api/connections  — NATS connection list
 *   GET /health           — Service health check
 *
 * Environment:
 *   FLEET_STATUS_PORT     — HTTP port (default: 3104)
 *   NATS_MONITORING_URL   — NATS monitoring endpoint (default: http://localhost:8222)
 *   RELAY_HEALTH_URL      — Relay health endpoint (default: http://localhost:3102/health)
 *   CHAT_HEALTH_URL       — Chat health endpoint (default: http://localhost:3103/health)
 */

const http = require("http");

// ─── FleetStatusService ──────────────────────────────────────────────────────

class FleetStatusService {
  constructor(opts = {}) {
    this.port = opts.port ?? parseInt(process.env.FLEET_STATUS_PORT || "3104", 10);
    this.natsMonitoringUrl = opts.natsMonitoringUrl || process.env.NATS_MONITORING_URL || "http://localhost:8222";
    this.relayHealthUrl = opts.relayHealthUrl || process.env.RELAY_HEALTH_URL || "http://localhost:3102/health";
    this.chatHealthUrl = opts.chatHealthUrl || process.env.CHAT_HEALTH_URL || "http://localhost:3103/health";
    this.timeout = opts.timeout || 3000;
    this.httpServer = null;
  }

  // ─── Upstream Queries ──────────────────────────────────────────────────

  fetchJSON(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        timeout: this.timeout,
      };

      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      });

      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }

  async checkNatsHealth() {
    const health = await this.fetchJSON(`${this.natsMonitoringUrl}/healthz`);
    return health ? "healthy" : "unreachable";
  }

  async getNatsConnections() {
    const connz = await this.fetchJSON(`${this.natsMonitoringUrl}/connz`);
    if (!connz) return { total: 0, named: [], raw: null };
    return this.parseConnections(connz);
  }

  parseConnections(connz) {
    const conns = connz.connections || [];
    const named = conns
      .map((c) => c.name)
      .filter(Boolean);
    return { total: conns.length, named, raw: connz };
  }

  async checkServiceHealth(url) {
    const health = await this.fetchJSON(url);
    return health && health.status === "ok" ? "healthy" : "unreachable";
  }

  // ─── HTTP API ──────────────────────────────────────────────────────────

  handleRequest(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/api/status") {
      this.handleStatus(res);
    } else if (req.method === "GET" && pathname === "/api/nats") {
      this.handleNats(res);
    } else if (req.method === "GET" && pathname === "/api/connections") {
      this.handleConnections(res);
    } else if (req.method === "GET" && pathname === "/health") {
      this.handleHealth(res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  async handleStatus(res) {
    const [nats, relay, chat, connections] = await Promise.all([
      this.checkNatsHealth(),
      this.checkServiceHealth(this.relayHealthUrl),
      this.checkServiceHealth(this.chatHealthUrl),
      this.getNatsConnections(),
    ]);

    const overall = (nats === "healthy" && relay === "healthy" && chat === "healthy")
      ? "healthy"
      : "degraded";

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      overall,
      nats,
      relay,
      chat,
      connections: connections.total,
      agents: connections.named,
      timestamp: new Date().toISOString(),
    }));
  }

  async handleNats(res) {
    const [status, connections] = await Promise.all([
      this.checkNatsHealth(),
      this.getNatsConnections(),
    ]);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status,
      connections: connections.total,
      agents: connections.named,
      timestamp: new Date().toISOString(),
    }));
  }

  async handleConnections(res) {
    const connections = await this.getNatsConnections();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(connections));
  }

  handleHealth(res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      timestamp: new Date().toISOString(),
    }));
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  startHTTP() {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));
      this.httpServer.listen(this.port, () => {
        const addr = this.httpServer.address();
        console.log(`[FleetStatus] HTTP API listening on port ${addr.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  const svc = new FleetStatusService();
  console.log("[FleetStatus] Starting @noesis-ship/fleet-status...");
  svc.startHTTP();

  process.on("SIGINT", () => {
    console.log("[FleetStatus] Shutting down...");
    svc.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    svc.stop();
    process.exit(0);
  });
}

module.exports = { FleetStatusService };
