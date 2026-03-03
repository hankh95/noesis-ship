#!/usr/bin/env node
/**
 * Bosun Operations Logger
 *
 * Subscribes to fleet NATS events and writes daily JSON operation logs.
 * Each day produces one file: ships/tackle/logs/bosun-ops/YYYY-MM-DD.json
 *
 * Events logged:
 *   ship.fleet.proposal   — Morning scan proposals
 *   ship.fleet.alert      — Spawns, WIP limits, crashes, PR events
 *   ship.fleet.status     — Fleet health snapshots
 *   ship.bosun.decision   — Trigger decisions (from EXP-1013)
 *
 * Environment:
 *   NATS_URL    — NATS server (default: nats://localhost:4222)
 *   OPS_LOG_DIR — Output directory (default: auto-detected ~/projects or ~/Projects)
 *
 * EXP-1014 Phase 2 — Operational Data Collection
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
const OPS_LOG_DIR = process.env.OPS_LOG_DIR || path.join(
  detectProjectDir(), "ships/tackle/logs/bosun-ops"
);
const RECONNECT_INTERVAL = 5000;

const sc = StringCodec();

// NATS subjects to subscribe to
const SUBJECTS = [
  "ship.fleet.proposal",
  "ship.fleet.alert",
  "ship.fleet.status",
  "ship.bosun.decision",
];

// ─── State ──────────────────────────────────────────────────────────────────

let currentDay = null; // "YYYY-MM-DD"
let dayEvents = [];    // Events for current day

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [OpsLog] ${msg}`);
}

// ─── File Management ────────────────────────────────────────────────────────

function getDayKey(date) {
  return date.toISOString().substring(0, 10);
}

function getFilePath(dayKey) {
  return path.join(OPS_LOG_DIR, `${dayKey}.json`);
}

function loadDayEvents(dayKey) {
  const filePath = getFilePath(dayKey);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      log(`Warning: corrupt file ${filePath}, starting fresh`);
    }
  }
  return [];
}

function saveDayEvents(dayKey, events) {
  const filePath = getFilePath(dayKey);
  fs.writeFileSync(filePath, JSON.stringify(events, null, 2));
}

function rolloverDay(newDay) {
  if (currentDay && currentDay !== newDay) {
    saveDayEvents(currentDay, dayEvents);
    log(`Day closed: ${currentDay} (${dayEvents.length} events)`);
  }
  currentDay = newDay;
  dayEvents = loadDayEvents(newDay);
  log(`Day started: ${newDay} (${dayEvents.length} existing events)`);
}

// ─── Event Handler ──────────────────────────────────────────────────────────

function handleEvent(subject, rawData) {
  let data;
  try {
    data = JSON.parse(sc.decode(rawData));
  } catch {
    return; // Skip unparseable messages
  }

  const now = new Date();
  const dayKey = getDayKey(now);

  // Rollover if day changed
  if (dayKey !== currentDay) {
    rolloverDay(dayKey);
  }

  const entry = {
    timestamp: now.toISOString(),
    subject,
    type: data.type || data.alertType || "unknown",
    data,
  };

  dayEvents.push(entry);

  // Flush to disk every 5 events (balance between durability and IO)
  if (dayEvents.length % 5 === 0) {
    saveDayEvents(currentDay, dayEvents);
  }

  // Log summary
  const summary = summarizeEvent(entry);
  log(`${subject}: ${summary}`);
}

function summarizeEvent(entry) {
  const { type, data } = entry;
  switch (type) {
    case "fleet_proposal":
      return `${(data.proposals || []).length} proposals`;
    case "fleet_status":
      return `${(data.agents || []).length} agents`;
    case "agent_spawned":
      return `spawned ${data.exp || "?"}`;
    case "agent_stuck":
      return `stuck ${data.session || "?"}`;
    case "agent_crash":
      return `crash ${data.session || "?"}`;
    case "wip_limit":
      return `WIP limit — deferred ${data.exp || "?"}`;
    case "pr_created":
      return `PR #${data.pr || "?"} for ${data.exp || "?"}`;
    case "ci_failed":
      return `CI failed PR #${data.pr || "?"}`;
    case "trigger":
      return `trigger ${data.triggerType || "?"} → ${data.triggerId || "?"}`;
    default:
      return type;
  }
}

// ─── NATS Connection ────────────────────────────────────────────────────────

async function start() {
  // Ensure output directory exists
  if (!fs.existsSync(OPS_LOG_DIR)) {
    fs.mkdirSync(OPS_LOG_DIR, { recursive: true });
  }

  log("Starting Bosun Operations Logger...");
  log(`NATS: ${NATS_URL}`);
  log(`Output: ${OPS_LOG_DIR}`);
  log(`Subjects: ${SUBJECTS.join(", ")}`);

  try {
    const nc = await connect({ servers: NATS_URL });
    log(`Connected to NATS at ${nc.getServer()}`);

    // Initialize current day
    rolloverDay(getDayKey(new Date()));

    // Subscribe to all fleet subjects
    for (const subject of SUBJECTS) {
      const sub = nc.subscribe(subject);
      log(`Subscribed to ${subject}`);

      // Process messages (non-blocking — each subscription runs concurrently)
      (async () => {
        for await (const msg of sub) {
          try {
            handleEvent(subject, msg.data);
          } catch (err) {
            log(`Error processing ${subject}: ${err.message}`);
          }
        }
      })();
    }

    // Monitor connection status
    (async () => {
      for await (const status of nc.status()) {
        log(`NATS: ${status.type}: ${status.data}`);
      }
    })();
  } catch (err) {
    log(`NATS connection failed: ${err.message}`);
    log(`Retrying in ${RECONNECT_INTERVAL / 1000}s...`);
    setTimeout(start, RECONNECT_INTERVAL);
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

function shutdown(signal) {
  log(`${signal} — flushing...`);
  if (currentDay && dayEvents.length > 0) {
    saveDayEvents(currentDay, dayEvents);
    log(`Saved ${dayEvents.length} events for ${currentDay}`);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Start ──────────────────────────────────────────────────────────────────

start();
