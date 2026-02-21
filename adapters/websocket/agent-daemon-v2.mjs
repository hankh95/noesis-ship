#!/usr/bin/env node
/**
 * Noesis Ship Agent Daemon v2
 *
 * Replaces agent-daemon.js (v1) with two key improvements:
 *
 * 1. Uses Claude Agent SDK `query()` instead of spawning `claude -p` processes
 *    - In-process execution (no subprocess overhead)
 *    - Reliable session ID from SDK init event
 *    - Streaming responses (real-time text to clients)
 *
 * 2. Connects directly to NATS instead of through WebSocket relay
 *    - Subscribes to ship.channel.> (same pattern as fleet-log-writer.js)
 *    - Publishes responses to ship.channel.{group}
 *    - Falls back to WebSocket when NATS unavailable
 *
 * Environment:
 *   NATS_URL         — NATS server URL (default: nats://localhost:4222)
 *   BRIDGE_URL       — WebSocket fallback URL (default: ws://localhost:3100)
 *   PROJECT_DIR      — Project working directory (default: ~/Projects/nusy-product-team)
 *   AGENT_NAME       — Display name (default: from hostname)
 *   MAX_TURNS        — Max conversation turns per message (default: 10)
 *   PERMISSION_MODE  — SDK permission mode (default: "default"; set to "bypassPermissions" for unattended operation)
 *
 * EXP-018: Agent Daemon v2 — Claude Agent SDK + NATS-native messaging
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { connect, StringCodec } from "nats";
import WebSocket from "ws";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

// Load .env if dotenv is available
try {
  const dotenv = await import("dotenv");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.join(__dirname, ".env") });
} catch {
  // dotenv not required
}

// ─── Configuration ──────────────────────────────────────────────────────────

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3100";
const PROJECT_DIR =
  process.env.PROJECT_DIR ||
  path.join(os.homedir(), "Projects/nusy-product-team");
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "10", 10);
const PERMISSION_MODE = process.env.PERMISSION_MODE || "default";
const RECONNECT_INTERVAL = 3000;
const RESPONSE_TIMEOUT = 120_000; // 2 minutes

// ─── State ──────────────────────────────────────────────────────────────────

let agentName = process.env.AGENT_NAME || os.hostname().split(".")[0];
let sessionId = null; // For conversation continuity
let processing = false; // Prevent concurrent requests
const messageQueue = [];

// Transport state
let natsConnection = null;
let ws = null;
let wsConnected = false;
const sc = StringCodec();

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [AgentDaemon-v2] ${msg}`);
}

// ─── Transport Layer ────────────────────────────────────────────────────────
// Tries NATS first; falls back to WebSocket (same as server.js pattern)

async function initTransport() {
  // Try NATS first
  try {
    log(`Connecting to NATS at ${NATS_URL}...`);
    natsConnection = await connect({ servers: NATS_URL });
    log(`NATS connected to ${natsConnection.getServer()}`);

    // Subscribe to all channel messages (same pattern as fleet-log-writer.js)
    const channelSub = natsConnection.subscribe("ship.channel.>");
    log("Subscribed to ship.channel.>");

    // Process NATS messages
    (async () => {
      for await (const msg of channelSub) {
        try {
          const data = sc.decode(msg.data);
          const parsed = JSON.parse(data);

          // Skip messages that originated from this agent (prevent echo)
          if (parsed.origin === agentName) continue;
          if (parsed.fromId === `agent:${agentName.toLowerCase()}`) continue;

          handleIncoming(parsed);
        } catch (err) {
          log(`NATS message error: ${err.message}`);
        }
      }
    })();

    // Monitor connection status
    (async () => {
      for await (const status of natsConnection.status()) {
        log(`NATS status: ${status.type}: ${status.data}`);
      }
    })();

    // Handle connection close — fall back to WebSocket
    natsConnection.closed().then((err) => {
      if (err) {
        log(`NATS closed with error: ${err.message}`);
      } else {
        log("NATS connection closed");
      }
      natsConnection = null;
      log("Falling back to WebSocket transport...");
      connectWebSocket();
    });

    return;
  } catch (err) {
    log(`NATS connection failed: ${err.message}`);
    log("Falling back to WebSocket transport...");
  }

  // Fall back to WebSocket
  connectWebSocket();
}

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (err) {
    log(`WebSocket connection error: ${err.message}`);
    scheduleWsReconnect();
    return;
  }

  ws.on("open", () => {
    wsConnected = true;
    log(`WebSocket connected to ${BRIDGE_URL}`);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "status") {
        // Adopt bridge machine name if no AGENT_NAME configured
        if (msg.machine && !process.env.AGENT_NAME) agentName = msg.machine;
      } else if (msg.type === "kanban_event") {
        handleKanbanEvent(msg);
      } else if (msg.type === "message" && msg.group) {
        handleIncoming(msg);
      }
    } catch {
      // Skip unparseable
    }
  });

  ws.on("close", () => {
    wsConnected = false;
    log("WebSocket disconnected");
    scheduleWsReconnect();
  });

  ws.on("error", (err) => {
    log(`WebSocket error: ${err.message}`);
  });
}

function scheduleWsReconnect() {
  setTimeout(() => {
    if (!wsConnected && !natsConnection) {
      log("Reconnecting WebSocket...");
      connectWebSocket();
    }
  }, RECONNECT_INTERVAL);
}

// ─── Message Routing ────────────────────────────────────────────────────────

function handleIncoming(msg) {
  if (msg.type === "kanban_event") {
    handleKanbanEvent(msg);
    return;
  }

  // Only process actionable messages (same logic as v1)
  const fromSelf =
    msg.from && msg.from.toLowerCase() === agentName.toLowerCase();
  const fromHuman = msg.fromId === "carclaw:user";
  const directedToMe =
    msg.to && msg.to.toLowerCase() === agentName.toLowerCase();
  const fromAgent = msg.fromId && msg.fromId.startsWith("agent:");

  if (fromSelf) {
    // Ignore own messages
  } else if (fromHuman) {
    log(`Human message [${msg.group}]: ${msg.message.substring(0, 80)}`);
    enqueueMessage(msg);
  } else if (directedToMe) {
    log(
      `Agent message from ${msg.from} [${msg.group}]: ${msg.message.substring(0, 80)}`
    );
    enqueueMessage(msg);
  } else if (fromAgent) {
    log(
      `Ignoring broadcast from ${msg.from} (not directed to ${agentName})`
    );
  }
}

// ─── Kanban Event Handler ───────────────────────────────────────────────────

function handleKanbanEvent(event) {
  const item = event.item || {};
  const repo = event.repo || "unknown";

  log(`Kanban ${event.event}: ${item.id} -> ${item.status} (repo: ${repo})`);

  if (event.event === "moved" && item.status === "review") {
    const notice = `[Kanban] ${item.id} "${item.title}" moved to review by ${item.assignee || "unknown"} in ${repo}`;
    publishResponse(notice, "session:active");
  } else if (event.event === "moved" && item.status === "done") {
    publishResponse(
      `[Kanban] ${item.id} "${item.title}" is done!`,
      "session:active"
    );
  } else if (event.event === "assigned" && item.assignee) {
    if (item.assignee.toLowerCase() === agentName.toLowerCase()) {
      publishResponse(
        `[Kanban] ${item.id} "${item.title}" assigned to me`,
        "session:active"
      );
      log(`I was assigned ${item.id}`);
    }
  }
}

// ─── Message Queue ──────────────────────────────────────────────────────────

function enqueueMessage(msg) {
  messageQueue.push(msg);
  processQueue();
}

async function processQueue() {
  if (processing || messageQueue.length === 0) return;
  processing = true;

  const msg = messageQueue.shift();
  try {
    await handleMessage(msg);
  } catch (err) {
    log(`Error processing message: ${err.message}`);
    publishResponse(`Error: ${err.message}`, msg.group);
  }

  processing = false;
  if (messageQueue.length > 0) {
    processQueue();
  }
}

// ─── Claude Agent SDK Invocation ────────────────────────────────────────────

async function handleMessage(msg) {
  const userMessage = msg.message;
  const group = msg.group;
  // For agent-to-agent: reply directly to sender. For human: broadcast to all.
  const replyTo =
    msg.fromId && msg.fromId.startsWith("agent:") ? msg.from : null;

  log(`SDK query: ${userMessage.substring(0, 60)}...`);

  const options = {
    cwd: PROJECT_DIR,
    maxTurns: MAX_TURNS,
    permissionMode: PERMISSION_MODE,
  };

  // Resume conversation if we have a session
  if (sessionId) {
    options.resume = sessionId;
  }

  let responseText = "";
  let response = null;

  try {
    response = query({
      prompt: userMessage,
      options,
    });

    // Timeout handler — interrupt the SDK query directly so the for-await
    // loop unblocks even if the SDK is waiting for the next event.
    const timeout = setTimeout(async () => {
      log("SDK query timed out — interrupting");
      if (response && response.interrupt) {
        try {
          await response.interrupt();
        } catch {
          // Interrupt may throw if already finished
        }
      }
    }, RESPONSE_TIMEOUT);

    try {
      for await (const message of response) {
        // Capture session ID from init event
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          log(`Session: ${sessionId.substring(0, 8)}...`);
        }

        // Collect final result
        if (message.type === "result") {
          if (message.subtype === "success") {
            responseText = message.result || "";
          } else {
            log(`SDK result: ${message.subtype}`);
            responseText =
              message.result || `(Query ended: ${message.subtype})`;
          }
          log(
            `Cost: $${message.total_cost_usd || "?"}, Turns: ${message.num_turns || "?"}`
          );
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log(`SDK error: ${err.message}`);
    responseText = `(Agent error: ${err.message})`;
    // Reset session on error — next message starts fresh
    sessionId = null;
  }

  // Send response
  if (responseText) {
    // Filter out boilerplate greetings
    const boilerplate =
      /^(ready to help|how can i help|hello|hi there|hey)[.!]?$/i;
    if (boilerplate.test(responseText.trim())) {
      log(`Filtered boilerplate: "${responseText.trim()}"`);
    } else {
      log(
        `Response (${responseText.length} chars): ${responseText.substring(0, 80)}...`
      );
      publishResponse(responseText, group, replyTo);
    }
  } else {
    log("No response from SDK");
    publishResponse(
      "(No response — agent may need authentication or configuration)",
      group,
      replyTo
    );
  }
}

// ─── Response Publishing ────────────────────────────────────────────────────

function publishResponse(text, group, replyTo) {
  const payload = {
    type: "message",
    group: group || "session:active",
    from: agentName,
    fromId: `agent:${agentName.toLowerCase()}`,
    message: text,
    timestamp: new Date().toISOString(),
    sessionMessage: true,
  };

  if (replyTo) {
    payload.to = replyTo;
  }

  // Prefer NATS, fall back to WebSocket
  if (natsConnection) {
    try {
      const subject = `ship.channel.${payload.group}`;
      const natsPayload = { ...payload, origin: agentName };
      natsConnection.publish(subject, sc.encode(JSON.stringify(natsPayload)));
      log(`Published to ${subject}`);
    } catch (err) {
      log(`NATS publish error: ${err.message}`);
      // Try WebSocket fallback
      sendViaWebSocket(payload);
    }
  } else {
    sendViaWebSocket(payload);
  }
}

function sendViaWebSocket(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("Cannot send — no transport available");
    return;
  }
  ws.send(JSON.stringify({ type: "broadcast", payload }));
}

// ─── Start ──────────────────────────────────────────────────────────────────

log("Starting Noesis Ship Agent Daemon v2...");
log(`Agent: ${agentName}`);
log(`Project: ${PROJECT_DIR}`);
log(`NATS: ${NATS_URL}`);
log(`WebSocket fallback: ${BRIDGE_URL}`);
log(`Max turns: ${MAX_TURNS}`);
log(`Permission mode: ${PERMISSION_MODE}`);
if (PERMISSION_MODE === "bypassPermissions") {
  log("WARNING: Running with bypassPermissions — all tool calls are auto-approved");
}

await initTransport();

// Keep alive — handle both SIGINT (Ctrl-C) and SIGTERM (process managers)
async function shutdown() {
  log("Shutting down...");
  if (natsConnection) {
    try {
      await natsConnection.drain();
    } catch {
      // drain may fail if already closed
    }
  }
  if (ws) ws.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
