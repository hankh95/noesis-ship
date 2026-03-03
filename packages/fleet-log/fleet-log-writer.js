#!/usr/bin/env node
/**
 * Fleet Comms Log Writer
 *
 * Subscribes to all ship.channel.> NATS subjects and writes
 * time-windowed Yurtle markdown transcript files.
 *
 * Output: {LOG_DIR}/fleet-comms/YYYY-MM-DD_HHMM-HHMM.md
 *   - 4-hour time windows
 *   - Turtle frontmatter (participants, counts, channels)
 *   - Human-readable transcript with timestamps
 *
 * Environment:
 *   NATS_URL    — NATS server (default: nats://localhost:4222)
 *   LOG_DIR     — Output directory (default: auto-detected ~/projects or ~/Projects)
 *   WINDOW_HOURS — Hours per transcript file (default: 4)
 */

const { connect, StringCodec } = require("nats");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Configuration ──────────────────────────────────────────────────────────

function detectProjectDir() {
  const home = os.homedir();
  // Check lowercase first (Linux/DGX), then uppercase (macOS convention)
  for (const dir of ["projects", "Projects"]) {
    const candidate = path.join(home, dir, "nusy-product-team");
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fallback to lowercase if neither exists
  return path.join(home, "projects", "nusy-product-team");
}

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const LOG_DIR = process.env.LOG_DIR || path.join(
  detectProjectDir(), "ships/tackle/logs"
);
const WINDOW_HOURS = parseInt(process.env.WINDOW_HOURS || "4", 10);
const FLEET_COMMS_DIR = path.join(LOG_DIR, "fleet-comms");
const RECONNECT_INTERVAL = 5000;

const sc = StringCodec();

// ─── State ──────────────────────────────────────────────────────────────────

let currentWindow = null;     // "YYYY-MM-DD_HHMM-HHMM"
let messageCount = 0;
const participants = new Set();
const channels = new Set();

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [FleetLog] ${msg}`);
}

// ─── Time Windows ───────────────────────────────────────────────────────────

function getWindowForTime(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = date.getUTCHours();
  const windowStart = Math.floor(hour / WINDOW_HOURS) * WINDOW_HOURS;
  const windowEnd = windowStart + WINDOW_HOURS;

  const startStr = String(windowStart).padStart(2, "0") + "00";
  const endStr = String(windowEnd % 24).padStart(2, "0") + "00";
  const dateStr = `${year}-${month}-${day}`;

  return {
    key: `${dateStr}_${startStr}-${endStr}`,
    dateStr,
    startStr: `${String(windowStart).padStart(2, "0")}:00`,
    endStr: `${String(windowEnd % 24).padStart(2, "0")}:00`,
    startISO: `${dateStr}T${String(windowStart).padStart(2, "0")}:00:00Z`,
    endISO: `${dateStr}T${String(windowEnd % 24).padStart(2, "0")}:00:00Z`,
  };
}

function getFilePath(windowKey) {
  return path.join(FLEET_COMMS_DIR, `${windowKey}.md`);
}

// ─── Frontmatter ────────────────────────────────────────────────────────────

function buildFrontmatter(window) {
  const participantList = Array.from(participants).sort();
  const channelList = Array.from(channels).sort();
  const participantTurtle = participantList.map(p => `"${p}"`).join(", ");
  const channelTurtle = channelList.map(c => `"${c}"`).join(", ");

  return `---
@prefix ship: <https://nusy.dev/ship/> .
@prefix log: <https://nusy.dev/log/> .

<#fleet-comms-${window.key}> a log:FleetTranscript ;
    log:startTime "${window.startISO}" ;
    log:endTime "${window.endISO}" ;
    log:messageCount ${messageCount} ;
    log:participants ${participantTurtle || '"(none)"'} ;
    log:channels ${channelTurtle || '"(none)"'} .
---

# Fleet Comms \u2014 ${window.dateStr} ${window.startStr}\u2013${window.endStr} UTC

`;
}

function initializeFile(window) {
  const filePath = getFilePath(window.key);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buildFrontmatter(window));
    log(`Created transcript: ${window.key}`);
  }
}

function updateFrontmatter(window) {
  const filePath = getFilePath(window.key);
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  const fmEnd = content.indexOf("---", 4);
  if (fmEnd === -1) return;

  const bodyStart = content.indexOf("\n", fmEnd) + 1;
  const body = content.substring(bodyStart);
  const newContent = buildFrontmatter(window) + body;
  fs.writeFileSync(filePath, newContent);
}

// ─── Message Formatting ────────────────────────────────────────────────────

function formatMessage(msg) {
  const ts = msg.timestamp
    ? new Date(msg.timestamp).toISOString().substring(11, 16)
    : new Date().toISOString().substring(11, 16);

  const channel = msg.group || "unknown";
  const from = msg.from || "Unknown";
  const to = msg.to ? ` \u2192 ${msg.to}` : "";
  const message = msg.message || "";

  // Track metadata
  participants.add(from);
  if (msg.to) participants.add(msg.to);
  channels.add(channel);

  return `**${ts} [${channel}] ${from}${to}:**\n${message}\n\n`;
}

// ─── Message Handler ────────────────────────────────────────────────────────

function handleMessage(data) {
  let msg;
  try {
    msg = JSON.parse(sc.decode(data));
  } catch {
    return;
  }

  // Skip non-message payloads (status, etc.)
  if (!msg.message) return;

  // Skip origin-tagged messages (prevent double-logging from NATS echo)
  // We only want to log each message once
  const now = new Date();
  const window = getWindowForTime(now);

  // Check if window rolled over
  if (currentWindow !== window.key) {
    if (currentWindow) {
      // Update frontmatter of old window with final counts
      const oldWindow = getWindowForTime(
        new Date(now.getTime() - WINDOW_HOURS * 3600000)
      );
      updateFrontmatter(oldWindow);
      log(`Window closed: ${currentWindow} (${messageCount} messages)`);
    }
    currentWindow = window.key;
    messageCount = 0;
    participants.clear();
    channels.clear();
    initializeFile(window);
  }

  // Format and append
  const formatted = formatMessage(msg);
  const filePath = getFilePath(window.key);
  fs.appendFileSync(filePath, formatted);
  messageCount++;

  // Update frontmatter periodically (every 10 messages)
  if (messageCount % 10 === 0) {
    updateFrontmatter(window);
  }
}

// ─── NATS Connection ────────────────────────────────────────────────────────

async function start() {
  // Ensure output directory exists
  if (!fs.existsSync(FLEET_COMMS_DIR)) {
    fs.mkdirSync(FLEET_COMMS_DIR, { recursive: true });
  }

  log("Starting Fleet Comms Log Writer...");
  log(`NATS: ${NATS_URL}`);
  log(`Output: ${FLEET_COMMS_DIR}`);
  log(`Window: ${WINDOW_HOURS} hours`);

  try {
    const nc = await connect({ servers: NATS_URL });
    log(`Connected to NATS at ${nc.getServer()}`);

    // Subscribe to all channel messages
    const sub = nc.subscribe("ship.channel.>");
    log("Subscribed to ship.channel.>");

    // Initialize current window
    const now = new Date();
    const window = getWindowForTime(now);
    currentWindow = window.key;
    initializeFile(window);

    for await (const msg of sub) {
      try {
        handleMessage(msg.data);
      } catch (err) {
        log(`Error processing message: ${err.message}`);
      }
    }
  } catch (err) {
    log(`NATS connection failed: ${err.message}`);
    log(`Retrying in ${RECONNECT_INTERVAL / 1000}s...`);
    setTimeout(start, RECONNECT_INTERVAL);
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on("SIGINT", () => {
  log("Shutting down...");
  if (currentWindow) {
    const window = getWindowForTime(new Date());
    updateFrontmatter(window);
    log(`Final update: ${currentWindow} (${messageCount} messages)`);
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Terminated...");
  if (currentWindow) {
    const window = getWindowForTime(new Date());
    updateFrontmatter(window);
  }
  process.exit(0);
});

// ─── Start ──────────────────────────────────────────────────────────────────

start();
