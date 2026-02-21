#!/usr/bin/env node
/**
 * CarClaw Agent Daemon
 *
 * Headless Claude Code agent that monitors the bridge for incoming
 * CarClaw messages and responds autonomously — no keyboard needed.
 *
 * Flow:
 *   1. Connects to bridge WebSocket
 *   2. Listens for messages from CarClaw (fromId = "carclaw:user")
 *   3. Spawns `claude -p` with the message, pointed at the project dir
 *   4. Streams the response back to CarClaw via the bridge
 *
 * Usage:
 *   node agent-daemon.js
 *
 * Environment:
 *   BRIDGE_URL       — WebSocket URL (default: ws://localhost:3100)
 *   PROJECT_DIR      — Project working directory (default: ~/Projects/carclaw)
 *   CLAUDE_BIN       — Path to claude binary (default: auto-detect)
 *   AGENT_NAME       — Display name (default: from bridge machine name)
 *   MAX_TURNS        — Max conversation turns per message (default: 10)
 */

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

// ─── Configuration ──────────────────────────────────────────────────────────

const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3100";
const PROJECT_DIR = process.env.PROJECT_DIR || path.join(require("os").homedir(), "Projects/carclaw");
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(__dirname, "node_modules/.bin/claude");
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "10", 10);
const RECONNECT_INTERVAL = 3000;

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
        if (msg.machine) agentName = msg.machine;
      } else if (msg.type === "message" && msg.fromId === "carclaw:user") {
        // Respond to all groups — both Code Companion (session:*) and agent chat (tg:*, etc.)
        if (msg.group) {
          log(`CarClaw message [${msg.group}]: ${msg.message.substring(0, 80)}`);
          enqueueMessage(msg);
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

function broadcastMessage(text, group) {
  sendToBridge({
    type: "broadcast",
    payload: {
      type: "message",
      group: group || "session:active",
      from: agentName,
      fromId: "agent:daemon",
      message: text,
      timestamp: new Date().toISOString(),
      sessionMessage: true,
    },
  });
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
    await handleCarClawMessage(msg);
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

// ─── Claude Code Invocation ─────────────────────────────────────────────────

function handleCarClawMessage(msg) {
  return new Promise((resolve, reject) => {
    const userMessage = msg.message;
    const group = msg.group;

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
        log(`Response (${response.length} chars): ${response.substring(0, 80)}...`);
        broadcastMessage(response, group);
      } else {
        log("No response from claude");
        broadcastMessage("(No response — claude may need authentication or configuration)", group);
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

log("Starting CarClaw Agent Daemon...");
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
