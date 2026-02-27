#!/usr/bin/env node
require("dotenv").config();

/**
 * Noesis Ship — WebSocket Relay Server
 *
 * Pure WebSocket relay server for agent communication. No external messaging
 * service integrations (Telegram, WhatsApp, iMessage) — just WebSocket relay,
 * Bonjour/mDNS discovery, and session watcher.
 *
 * Wire protocol:
 *
 *   Client -> Server:
 *     {"type":"send","group":"group-id","to":"mini","message":"@mini check status"}
 *
 *   Server -> Client:
 *     {"type":"message","group":"group-id","from":"Mini Agent","fromId":"user-id","message":"...","timestamp":"..."}
 *
 *   Server -> Client (status):
 *     {"type":"status","websocket":"connected"}
 *
 * Environment variables:
 *   WS_PORT              — WebSocket port (default: 3100)
 *   AGENTS               — Agent roster as id:Name pairs (default: mini:Mini,m5:M5,dgx:DGX,copilot:Copilot)
 *   CLAUDE_SESSION_DIR   — Path to Claude project dir for session watcher
 *   MACHINE_NAME         — Display name for this machine's agent
 *   SESSION_GROUP_ID     — Default group ID for session messages
 *   NATS_URL             — NATS server URL (default: "nats://localhost:4222", optional)
 *   RELAY_URL            — Cloudflare Tunnel URL (e.g. "wss://ship.congruentsys.com", optional)
 */

const { WebSocketServer, WebSocket } = require("ws");
const { connect, StringCodec } = require("nats");
const http = require("http");
const path = require("path");
const fs = require("fs");
const SessionWatcher = require("./session-watcher");

// ─── Configuration ──────────────────────────────────────────────────────────

const WS_PORT = process.env.WS_PORT || 3100;
const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

// NATS connection state
let natsConnection = null;
const sc = StringCodec();

// Parse AGENTS from .env — format: "id:Name,id:Name" (default: mini:Mini,m5:M5,dgx:DGX,copilot:Copilot)
const AGENTS = (process.env.AGENTS || "mini:Mini,m5:M5,dgx:DGX,copilot:Copilot")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [id, name] = entry.split(":");
    return { id: id.trim().toLowerCase(), name: (name || id).trim() };
  });

// Session watcher: streams Claude Code conversation to clients
const CLAUDE_SESSION_DIR = process.env.CLAUDE_SESSION_DIR || "";
const MACHINE_NAME = process.env.MACHINE_NAME || require("os").hostname().split(".")[0];
const SESSION_GROUP_ID = process.env.SESSION_GROUP_ID || "";

// ─── NATS Connection ────────────────────────────────────────────────────────

async function initNATS() {
  try {
    console.log(`[NATS] Connecting to ${NATS_URL}...`);
    natsConnection = await connect({ servers: NATS_URL });
    console.log(`[NATS] Connected to ${natsConnection.getServer()}`);

    // Subscribe to channel messages from NATS
    const channelSub = natsConnection.subscribe("ship.channel.>");
    (async () => {
      for await (const msg of channelSub) {
        try {
          const data = sc.decode(msg.data);
          const parsed = JSON.parse(data);
          // Skip messages that originated from this server to prevent echo loops
          if (parsed.origin === MACHINE_NAME) continue;
          // Relay NATS messages to all WebSocket clients
          broadcastToClients(parsed);
        } catch (err) {
          console.error(`[NATS] Error processing message:`, err.message);
        }
      }
    })();

    // Subscribe to kanban events from NATS (EXP-009)
    const kanbanSub = natsConnection.subscribe("ship.kanban.>");
    (async () => {
      for await (const msg of kanbanSub) {
        try {
          const data = sc.decode(msg.data);
          const parsed = JSON.parse(data);
          console.log(`[NATS] Kanban event: ${msg.subject}`, parsed.item?.id || "");
          // Relay kanban events to all WebSocket clients
          broadcastToClients(parsed);
        } catch (err) {
          console.error(`[NATS] Error processing kanban event:`, err.message);
        }
      }
    })();

    // Subscribe to fleet alerts and status from NATS (EXP-994)
    const fleetSub = natsConnection.subscribe("ship.fleet.>");
    (async () => {
      for await (const msg of fleetSub) {
        try {
          const data = sc.decode(msg.data);
          const parsed = JSON.parse(data);
          console.log(`[NATS] Fleet event: ${msg.subject}`, parsed.alertType || parsed.type || "");
          // Relay fleet events to all WebSocket clients (Command Deck)
          broadcastToClients(parsed);
        } catch (err) {
          console.error(`[NATS] Error processing fleet event:`, err.message);
        }
      }
    })();

    // Handle connection errors
    (async () => {
      for await (const status of natsConnection.status()) {
        console.log(`[NATS] Status: ${status.type}: ${status.data}`);
      }
    })();

    // Handle connection close
    natsConnection.closed().then((err) => {
      if (err) {
        console.error(`[NATS] Connection closed with error:`, err.message);
      } else {
        console.log(`[NATS] Connection closed`);
      }
      natsConnection = null;
    });

  } catch (err) {
    console.warn(`[NATS] Connection failed: ${err.message}`);
    console.log(`[NATS] Running in WebSocket-only mode`);
    natsConnection = null;
  }
}

// ─── WebSocket Server ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });

wss.on("listening", () => {
  console.log(`[Bridge] WebSocket server listening on port ${WS_PORT}`);
});

wss.on("connection", (ws, req) => {
  const clientAddr = req.socket.remoteAddress;
  console.log(`[Bridge] Client connected from ${clientAddr}`);

  // Send session conversation history if watcher is active
  if (sessionWatcher) {
    sessionWatcher.sendHistoryTo(ws);
  }

  // Send current status on connect (includes agent roster)
  ws.send(JSON.stringify(getStatusPayload()));

  ws.on("message", async (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch (err) {
      console.error("[Bridge] Invalid JSON from client:", data.toString());
      return;
    }

    if (parsed.type === "send") {
      await handleSend(parsed, ws);
    } else if (parsed.type === "agent_message") {
      await handleAgentMessage(parsed, ws);
    } else if (parsed.type === "list_groups") {
      await handleListGroups(ws);
    } else if (parsed.type === "discover_group") {
      await handleDiscoverGroup(parsed, ws);
    } else if (parsed.type === "broadcast") {
      // Direct broadcast to all other WS clients (used by MCP server)
      broadcastToClients(parsed.payload || parsed, ws);
    } else {
      console.log("[Bridge] Unknown message type:", parsed.type);
    }
  });

  ws.on("close", () => {
    console.log(`[Bridge] Client disconnected: ${clientAddr}`);
  });

  ws.on("error", (err) => {
    console.error(`[Bridge] Client error: ${err.message}`);
  });
});

function broadcastToClients(obj, excludeWs) {
  const json = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(json);
    }
  }
}

// ─── Tailscale IP Detection ─────────────────────────────────────────────────

function getTailscaleIP() {
  const os = require("os");
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        const parts = addr.address.split(".");
        const a = parseInt(parts[0]);
        const b = parseInt(parts[1]);
        // Tailscale uses CGNAT range: 100.64.0.0/10 (100.64.x.x – 100.127.x.x)
        if (a === 100 && b >= 64 && b <= 127) {
          return addr.address;
        }
      }
    }
  }
  return null;
}

function getStatusPayload() {
  const payload = { type: "status", websocket: "connected", agents: AGENTS };
  // Include NATS connection status
  payload.nats = natsConnection ? "connected" : "disconnected";
  // Include configured default group so the app can use it during setup
  if (SESSION_GROUP_ID) {
    payload.defaultGroup = SESSION_GROUP_ID;
  }
  // Include machine name
  payload.machine = MACHINE_NAME;
  // Include active session info if session watcher is running
  if (sessionWatcher && sessionWatcher.activeFile) {
    payload.sessions = [{
      machine: MACHINE_NAME,
      sessionId: path.basename(sessionWatcher.activeFile, ".jsonl"),
      active: true,
    }];
  }
  // Include Tailscale IP if available — app uses it for remote connectivity
  const tsIP = getTailscaleIP();
  if (tsIP) {
    payload.tailscaleIP = tsIP;
  }
  // Include relay URL (Cloudflare Tunnel) if configured
  if (process.env.RELAY_URL) {
    payload.relayURL = process.env.RELAY_URL;
  }
  return payload;
}

function broadcastStatus() {
  broadcastToClients(getStatusPayload());
}

// ─── Routing ────────────────────────────────────────────────────────────────

async function handleSend(msg, senderWs) {
  const { group, to, message } = msg;

  // Broadcast to other WebSocket clients (agent processes) so they see user messages.
  // The sender already shows the message locally — exclude them to avoid duplicates.
  const cleanMessage = message.replace(/^@\w+\s*/, "") || message;
  const messagePayload = {
    type: "message",
    group,
    from: "User",
    fromId: "carclaw:user",
    message: cleanMessage,
    to: to || null,
    timestamp: new Date().toISOString(),
  };

  // Publish to NATS if connected (tag with origin to prevent echo loops)
  if (natsConnection && group) {
    try {
      const subject = `ship.channel.${group}`;
      natsConnection.publish(subject, sc.encode(JSON.stringify({ ...messagePayload, origin: MACHINE_NAME })));
      console.log(`[NATS] Published to ${subject}`);
    } catch (err) {
      console.error(`[NATS] Publish error:`, err.message);
    }
  }

  broadcastToClients(messagePayload, senderWs);

  // Code Companion sessions: write to inbox file
  const isSession = group && group.startsWith("session:");
  if (isSession) {
    console.log(`[Bridge] Session message: ${message.substring(0, 80)}`);
    writeSessionInbox(cleanMessage, to);
  }
}

// ─── Agent Messages ──────────────────────────────────────────────────────────
// Agents post messages through the bridge (not directly via Bot API).
// The bridge broadcasts to all WebSocket clients.
//
// WebSocket: {"type":"agent_message","group":"session:active","from":"M5","message":"All GPUs nominal"}
// HTTP POST: curl http://localhost:3102/message -d '{"group":"session:active","from":"M5","message":"All GPUs nominal"}'

async function handleAgentMessage(msg, senderWs) {
  const { group, from, message, to } = msg;

  if (!group || !from || !message) {
    console.warn("[Bridge] agent_message missing required fields (group, from, message)");
    return;
  }

  const timestamp = new Date().toISOString();

  // Broadcast to all WebSocket clients
  const bridgeMessage = {
    type: "message",
    group,
    from,
    fromId: `agent:${from.toLowerCase()}`,
    message,
    timestamp,
  };
  // Preserve `to` field for directed agent-to-agent messages
  if (to) {
    bridgeMessage.to = to;
  }

  // Publish to NATS if connected (tag with origin to prevent echo loops)
  if (natsConnection && group) {
    try {
      const subject = `ship.channel.${group}`;
      natsConnection.publish(subject, sc.encode(JSON.stringify({ ...bridgeMessage, origin: MACHINE_NAME })));
      console.log(`[NATS] Published agent message to ${subject}`);
    } catch (err) {
      console.error(`[NATS] Publish error:`, err.message);
    }
  }

  broadcastToClients(bridgeMessage);
  console.log(`[Bridge] Agent ${from}: ${message.substring(0, 80)}`);
}

// HTTP API for agent messages (port WS_PORT + 2)
const AGENT_API_PORT = process.env.AGENT_API_PORT || Number(WS_PORT) + 2;

const agentApiServer = http.createServer((req, res) => {
  // CORS headers for local development
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/message") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const msg = JSON.parse(body);
        await handleAgentMessage(msg, null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("[AgentAPI] Error:", err.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

agentApiServer.listen(AGENT_API_PORT, () => {
  console.log(`[AgentAPI] HTTP endpoint listening on port ${AGENT_API_PORT}`);
});

// ─── Group Listing ──────────────────────────────────────────────────────────

async function handleListGroups(ws) {
  // WebSocket-only mode: no external service groups to list
  const groups = [];
  ws.send(JSON.stringify({ type: "groups", groups }));
}

// Discover a group by ID — in WebSocket-only mode this is a no-op,
// but we still respond with the groups list for protocol compatibility.
async function handleDiscoverGroup(msg, ws) {
  await handleListGroups(ws);
}

// ─── Bonjour / mDNS ─────────────────────────────────────────────────────────

function startBonjour() {
  const { Bonjour } = require("bonjour-service");
  const bonjour = new Bonjour();
  const hostname = require("os").hostname();

  bonjour.publish({
    name: `Noesis Ship (${hostname})`,
    type: "noesis-ship",
    port: parseInt(WS_PORT, 10),
    txt: { version: "1", hostname },
  });

  console.log(`[Bonjour] Advertising _noesis-ship._tcp on port ${WS_PORT}`);
}

// ─── Session Inbox ───────────────────────────────────────────────────────────
// When a client sends a message to a Code Companion session, write it to an
// inbox file that Claude Code can read.

// Resolve the actual project path from the Claude session dir
// e.g. ~/.claude/projects/-Users-hankh95-Projects-carclaw -> /Users/hankh95/Projects/carclaw
function resolveProjectPath() {
  if (!CLAUDE_SESSION_DIR) return null;
  const dirName = path.basename(CLAUDE_SESSION_DIR);
  const projectPath = dirName.replace(/^-/, "/").replace(/-/g, "/");
  if (fs.existsSync(projectPath)) return projectPath;
  return null;
}

const PROJECT_PATH = resolveProjectPath();
const INBOX_FILE = PROJECT_PATH ? path.join(PROJECT_PATH, ".carclaw-inbox") : null;

function writeSessionInbox(message, to) {
  if (!INBOX_FILE) {
    console.log("[Bridge] No inbox file configured — skipping inbox write");
    return;
  }

  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${to ? `@${to} ` : ""}${message}\n`;

  try {
    fs.appendFileSync(INBOX_FILE, entry);
    console.log(`[Bridge] Wrote to inbox: ${message.substring(0, 60)}`);
  } catch (err) {
    console.error(`[Bridge] Error writing inbox: ${err.message}`);
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────

console.log("[Bridge] Starting Noesis Ship WebSocket Relay...");

// Initialize NATS connection (optional)
initNATS().catch((err) => {
  console.error(`[NATS] Initialization error:`, err.message);
});

startBonjour();

// Start Claude Code session watcher (streams conversation to clients)
let sessionWatcher = null;
if (CLAUDE_SESSION_DIR) {
  sessionWatcher = new SessionWatcher({
    sessionDir: CLAUDE_SESSION_DIR,
    machineName: MACHINE_NAME,
    groupId: SESSION_GROUP_ID,
    broadcastFn: (msg) => broadcastToClients(msg),
  });
  sessionWatcher.start();
}

if (INBOX_FILE) {
  console.log(`[Bridge] Session inbox: ${INBOX_FILE}`);
}
