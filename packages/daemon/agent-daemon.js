#!/usr/bin/env node
/**
 * Noesis Ship Agent Daemon
 *
 * Headless Claude Code agent that monitors the bridge for incoming
 * messages and responds autonomously — no keyboard needed.
 *
 * Responds to:
 *   - Human messages (fromId = "carclaw:user") — always respond
 *   - Kanban events (type = "kanban_event") — notify and optionally auto-review
 *   - Direct agent-to-agent messages (msg.to = this agent's name) — respond
 *   - Undirected agent broadcasts — ignore (prevents infinite loops)
 *   - Own messages (from = this agent) — ignore (prevents echo)
 *
 * Flow:
 *   1. Connects to bridge WebSocket
 *   2. Listens for actionable messages (human or directed agent-to-agent)
 *   3. Spawns `claude -p` with the message, pointed at the project dir
 *   4. Posts the response back to the bridge
 *
 * Usage:
 *   node agent-daemon.js
 *
 * Environment:
 *   BRIDGE_URL       — WebSocket URL (default: ws://localhost:3100)
 *   PROJECT_DIR      — Project working directory (default: auto-detected ~/projects or ~/Projects)
 *   CLAUDE_BIN       — Path to claude binary (default: auto-detect)
 *   AGENT_NAME       — Display name (default: from bridge machine name)
 *   MAX_TURNS        — Max conversation turns per message (default: 10)
 */

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const { loadConfig, isFromSelf, isFromHuman, isDirectedTo, isFromAgent } = require("@noesis-ship/shared");

// ─── Configuration ──────────────────────────────────────────────────────────

const config = loadConfig();
const BRIDGE_URL = config.bridgeUrl;
const PROJECT_DIR = config.projectDir;
const CLAUDE_BIN = config.claudeBin;
const MAX_TURNS = config.maxTurns;
const RECONNECT_INTERVAL = config.reconnectInterval;

// ─── State ──────────────────────────────────────────────────────────────────

let ws = null;
let connected = false;
let bridgeStatus = null;
let agentName = process.env.AGENT_NAME || "M5";
let sessionId = null;    // For conversation continuity
let processing = false;  // Prevent concurrent requests
const messageQueue = [];

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [AgentDaemon] ${msg}`);
}

// ─── Bridge Connection ──────────────────────────────────────────────────────

function connectBridge() {
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (err) {
    log(`Connection error: ${err.message}`);
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    connected = true;
    log(`Connected to bridge at ${BRIDGE_URL}`);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "status") {
        bridgeStatus = msg;
        // Only adopt bridge machine name if no AGENT_NAME was explicitly configured.
        // Without this guard, remote agents (DGX, M5) get overwritten with "Mini".
        if (msg.machine && !process.env.AGENT_NAME) agentName = msg.machine;
      } else if (msg.type === "kanban_event") {
        // Handle kanban events (EXP-009)
        handleKanbanEvent(msg);
      } else if (msg.type === "message" && msg.group) {
        // Determine if this message is actionable (using @noesis-ship/shared helpers)
        const fromSelf = isFromSelf(msg, agentName);
        const fromHuman = isFromHuman(msg);
        const directedToMe = isDirectedTo(msg, agentName);
        const fromAgent = isFromAgent(msg);

        if (fromSelf) {
          // Ignore own messages (prevent echo)
        } else if (fromHuman) {
          // Always respond to human messages
          log(`Human message [${msg.group}]: ${msg.message.substring(0, 80)}`);
          enqueueMessage(msg);
        } else if (directedToMe) {
          // Respond to direct agent-to-agent messages (@Mini, @DGX, etc.)
          log(`Agent message from ${msg.from} [${msg.group}]: ${msg.message.substring(0, 80)}`);
          enqueueMessage(msg);
        } else if (fromAgent) {
          // Ignore undirected agent broadcasts (prevent infinite loops)
          log(`Ignoring broadcast from ${msg.from} (not directed to ${agentName})`);
        }
      }
    } catch {
      // Skip unparseable
    }
  });

  ws.on("close", () => {
    connected = false;
    log("Disconnected from bridge");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    log(`WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect() {
  setTimeout(() => {
    if (!connected) {
      log("Reconnecting...");
      connectBridge();
    }
  }, RECONNECT_INTERVAL);
}

function sendToBridge(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcastMessage(text, group, replyTo) {
  const payload = {
    type: "message",
    group: group || "session:active",
    from: agentName,
    fromId: `agent:${agentName.toLowerCase()}`,
    message: text,
    timestamp: new Date().toISOString(),
    sessionMessage: true,
  };
  // Direct reply: set `to` so only the original sender's daemon picks it up
  if (replyTo) {
    payload.to = replyTo;
  }
  sendToBridge({ type: "broadcast", payload });
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
    broadcastMessage(`Error: ${err.message}`, msg.group);
  }

  processing = false;
  // Process next if any
  if (messageQueue.length > 0) {
    processQueue();
  }
}

// ─── Kanban Event Handler (EXP-009) ─────────────────────────────────────────
// Reacts to kanban state changes relayed via the bridge.
// e.g., item moved to "review" → auto-trigger PR review

function handleKanbanEvent(event) {
  const item = event.item || {};
  const repo = event.repo || "unknown";

  log(`Kanban ${event.event}: ${item.id} → ${item.status} (repo: ${repo})`);

  if (event.event === "moved" && item.status === "review") {
    // Item moved to review — notify and optionally auto-review
    const notice = `[Kanban] ${item.id} "${item.title}" moved to review by ${item.assignee || "unknown"} in ${repo}`;
    broadcastMessage(notice, "session:active");
    log(notice);

    // If this agent is NOT the assignee, it could auto-review
    // For now, just broadcast — full auto-review can be added later
    if (item.assignee && item.assignee.toLowerCase() !== agentName.toLowerCase()) {
      log(`Could auto-review ${item.id} (assigned to ${item.assignee}, I am ${agentName})`);
    }
  } else if (event.event === "moved" && item.status === "done") {
    broadcastMessage(`[Kanban] ${item.id} "${item.title}" is done!`, "session:active");
  } else if (event.event === "assigned" && item.assignee) {
    if (item.assignee.toLowerCase() === agentName.toLowerCase()) {
      broadcastMessage(`[Kanban] ${item.id} "${item.title}" assigned to me`, "session:active");
      log(`I was assigned ${item.id}`);
    }
  }
}

// ─── Claude Code Invocation ─────────────────────────────────────────────────

function handleMessage(msg) {
  return new Promise((resolve, reject) => {
    const userMessage = msg.message;
    const group = msg.group;
    // For agent-to-agent: reply directly to sender. For human: broadcast to all.
    const replyTo = (msg.fromId && msg.fromId.startsWith("agent:")) ? msg.from : null;

    // Build claude command args
    const args = [
      "-p", userMessage,
      "--output-format", "text",
      "--max-turns", String(MAX_TURNS),
      "--dangerously-skip-permissions",
    ];

    // Resume conversation if we have a session
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    log(`Spawning claude: ${userMessage.substring(0, 60)}...`);

    // Build a clean env — strip CLAUDECODE to avoid nested session detection
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const child = spawn(CLAUDE_BIN, args, {
      cwd: PROJECT_DIR,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      // Try to capture session ID from stderr
      const sessionMatch = text.match(/session[_\s]*(?:id)?[:\s]*([a-f0-9-]{8,})/i);
      if (sessionMatch) {
        sessionId = sessionMatch[1];
        log(`Session ID: ${sessionId.substring(0, 8)}...`);
      }
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        log(`claude exited with code ${code}`);
        if (stderr) log(`stderr: ${stderr.substring(0, 200)}`);
      }

      const response = stdout.trim();
      if (response) {
        // Filter out boilerplate greetings that add no value
        const boilerplate = /^(ready to help|how can i help|hello|hi there|hey)[.!]?$/i;
        if (boilerplate.test(response)) {
          log(`Filtered boilerplate response: "${response}"`);
        } else {
          log(`Response (${response.length} chars): ${response.substring(0, 80)}...`);
          broadcastMessage(response, group, replyTo);
        }
      } else {
        log("No response from claude");
        broadcastMessage("(No response — claude may need authentication or configuration)", group, replyTo);
      }

      resolve();
    });

    child.on("error", (err) => {
      log(`Failed to spawn claude: ${err.message}`);
      reject(err);
    });

    // Timeout after 2 minutes
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        log("claude timed out — killing");
        child.kill("SIGTERM");
      }
    }, 120_000);
  });
}

// ─── Start ──────────────────────────────────────────────────────────────────

log("Starting Noesis Ship Agent Daemon...");
log(`Project: ${PROJECT_DIR}`);
log(`Claude: ${CLAUDE_BIN}`);
log(`Bridge: ${BRIDGE_URL}`);

connectBridge();

// Keep alive
process.on("SIGINT", () => {
  log("Shutting down...");
  if (ws) ws.close();
  process.exit(0);
});
