#!/usr/bin/env node
/**
 * @noesis-ship/chat — Chat Messaging Service
 *
 * HTTP API for sending and receiving messages via NATS pub/sub.
 * Replaces the Python nats_bridge.py with a Node.js microservice.
 *
 * Endpoints:
 *   POST /api/send         — Send message to NATS channel
 *   GET  /api/history/:ch  — Recent messages for a channel
 *   GET  /api/channels     — List known channels
 *   GET  /health           — Service health check
 *
 * Environment:
 *   NATS_URL           — NATS server (default: nats://localhost:4222)
 *   CHAT_PORT          — HTTP port (default: 3103)
 *   CONVERSATIONS_DIR  — Markdown transcript directory (optional)
 *   MACHINE_NAME       — Origin tag for echo prevention
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { connectNATS, publishJSON, decodeJSON } = require("@noesis-ship/shared/nats-helpers");
const { buildMessage, channelSubject } = require("@noesis-ship/shared/wire-protocol");

// ─── ChatService ─────────────────────────────────────────────────────────────

class ChatService {
  constructor(opts = {}) {
    this.port = opts.port ?? parseInt(process.env.CHAT_PORT || "3103", 10);
    this.natsUrl = opts.natsUrl || process.env.NATS_URL || "nats://localhost:4222";
    this.machineName = opts.machineName || process.env.MACHINE_NAME || "Chat";
    this.conversationsDir = opts.conversationsDir || process.env.CONVERSATIONS_DIR || null;
    this.maxHistory = opts.maxHistory || 100;

    // State
    this.nc = null;
    this.natsConnected = false;
    this.history = new Map();   // channel → [messages]
    this.channels = new Set();
    this.httpServer = null;
  }

  // ─── Message Tracking ────────────────────────────────────────────────────

  trackMessage(msg) {
    const channel = msg.group || "unknown";
    this.channels.add(channel);

    if (!this.history.has(channel)) {
      this.history.set(channel, []);
    }

    const hist = this.history.get(channel);
    hist.push(msg);

    // Cap history
    while (hist.length > this.maxHistory) {
      hist.shift();
    }
  }

  getHistory(channel, limit) {
    const hist = this.history.get(channel) || [];
    if (limit && limit < hist.length) {
      return hist.slice(-limit);
    }
    return [...hist];
  }

  // ─── Markdown Persistence ────────────────────────────────────────────────

  persistMessage(channel, msg) {
    if (!this.conversationsDir) return;

    try {
      if (!fs.existsSync(this.conversationsDir)) {
        fs.mkdirSync(this.conversationsDir, { recursive: true });
      }

      const sanitized = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
      const filePath = path.join(this.conversationsDir, `${sanitized}.md`);
      const ts = msg.timestamp || new Date().toISOString();
      const time = ts.substring(11, 16);
      const to = msg.to ? ` \u2192 ${msg.to}` : "";
      const line = `**${time} ${msg.from}${to}:** ${msg.message}\n\n`;

      fs.appendFileSync(filePath, line);
    } catch (err) {
      console.error(`[Chat] Persist error: ${err.message}`);
    }
  }

  // ─── NATS ────────────────────────────────────────────────────────────────

  async connectNATS() {
    const result = await connectNATS(this.natsUrl, "Chat");
    if (!result) {
      console.log("[Chat] Running without NATS (HTTP-only mode)");
      return;
    }

    this.nc = result.nc;
    this.natsConnected = true;

    // Subscribe to all channel messages
    const sub = this.nc.subscribe("ship.channel.>");
    (async () => {
      for await (const msg of sub) {
        try {
          const parsed = decodeJSON(msg);
          // Skip messages from self
          if (parsed.origin === this.machineName) continue;
          if (parsed.message) {
            this.trackMessage(parsed);
            this.persistMessage(parsed.group || "unknown", parsed);
          }
        } catch (err) {
          console.error(`[Chat] NATS message error: ${err.message}`);
        }
      }
    })();

    // Handle close
    this.nc.closed().then((err) => {
      if (err) console.error(`[Chat] NATS closed with error: ${err.message}`);
      this.natsConnected = false;
      this.nc = null;
    });
  }

  // ─── HTTP API ────────────────────────────────────────────────────────────

  handleRequest(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === "POST" && pathname === "/api/send") {
      this.handleSend(req, res);
    } else if (req.method === "GET" && pathname.startsWith("/api/history/")) {
      const channel = pathname.slice("/api/history/".length);
      const limit = parseInt(url.searchParams.get("limit") || "0", 10);
      this.handleHistory(res, channel, limit || undefined);
    } else if (req.method === "GET" && pathname === "/api/channels") {
      this.handleChannels(res);
    } else if (req.method === "GET" && pathname === "/health") {
      this.handleHealth(res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  handleSend(req, res) {
    const MAX_BODY = 64 * 1024; // 64 KB
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY && !aborted) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const { channel, content, sender, to } = parsed;

      if (!channel) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing required field: channel" }));
        return;
      }
      if (!content) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing required field: content" }));
        return;
      }

      const msg = buildMessage({
        group: channel,
        from: sender || "User",
        fromId: "deck:captain",
        message: content,
        to: to || undefined,
      });

      // Track locally
      this.trackMessage(msg);
      this.persistMessage(channel, msg);

      // Publish to NATS if connected
      let natsPublished = false;
      if (this.nc && this.natsConnected) {
        try {
          publishJSON(this.nc, channelSubject(channel), msg, this.machineName);
          natsPublished = true;
        } catch (err) {
          console.error(`[Chat] NATS publish error: ${err.message}`);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        published: true,
        nats: natsPublished,
        message: msg,
      }));
    });
  }

  handleHistory(res, channel, limit) {
    const messages = this.getHistory(channel, limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ channel, messages, count: messages.length }));
  }

  handleChannels(res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ channels: Array.from(this.channels).sort() }));
  }

  handleHealth(res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      nats_connected: this.natsConnected,
      channels: this.channels.size,
      timestamp: new Date().toISOString(),
    }));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  startHTTP() {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));
      this.httpServer.listen(this.port, () => {
        const addr = this.httpServer.address();
        console.log(`[Chat] HTTP API listening on port ${addr.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    if (this.nc) {
      this.nc.close();
      this.nc = null;
      this.natsConnected = false;
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  const svc = new ChatService();

  console.log("[Chat] Starting @noesis-ship/chat...");
  svc.connectNATS().catch((err) => {
    console.error(`[Chat] NATS init error: ${err.message}`);
  });
  svc.startHTTP();

  process.on("SIGINT", () => {
    console.log("[Chat] Shutting down...");
    svc.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    svc.stop();
    process.exit(0);
  });
}

module.exports = { ChatService };
