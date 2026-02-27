#!/usr/bin/env node
/**
 * Noesis Ship LLM Bosun Service
 *
 * Orchestrator that scans for work, reasons about priorities via Claude API,
 * proposes expeditions to Captain, and spawns agents on approval.
 *
 * NATS subjects:
 *   ship.channel.bosun  ← Captain commands (approve, reject, scan, status)
 *   ship.fleet.status   ← Fleet health updates (cached)
 *   ship.fleet.alert    ← PR/CI/agent events
 *   ship.kanban.>       ← Kanban hook events (item created, status change, etc.)
 *   ship.fleet.proposal → Morning proposals (published)
 *   ship.fleet.alert    → Completion/ACF alerts (published)
 *
 * CLI flags:
 *   --scan-once     Run one scan, print proposals, exit
 *   --dry-run       Don't publish to NATS, don't spawn agents
 *   --interval <m>  Scan interval in minutes (default: 30)
 *
 * Environment: See .env.example
 *
 * Epoch 4.1 + 4.6.6 — ROADMAP-V4-AUTOMATION.md
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";

// CJS interop — shared package is CommonJS
const require = createRequire(import.meta.url);
const {
  connectNATS,
  publishJSON,
  decodeJSON,
  buildMessage,
  channelSubject,
} = require("@noesis-ship/shared");

// Load .env
try {
  const dotenv = await import("dotenv");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.join(__dirname, ".env") });
} catch {
  // dotenv not required in production
}

import { runMorningScan } from "./morning-scan.mjs";
import { spawnAgent, checkWipLimit } from "./spawner.mjs";
import { createStaleHandler } from "./stale-handler.mjs";

// ─── Configuration ──────────────────────────────────────────────────────────

const config = {
  natsUrl: process.env.NATS_URL || "nats://localhost:4222",
  projectDir: process.env.NUSY_PROJECT_DIR || path.join(os.homedir(), "Projects/nusy-product-team"),
  fleetSpawnPath: process.env.FLEET_SPAWN_PATH || path.join(os.homedir(), "Projects/nusy-product-team/scripts/fleet-spawn.sh"),
  scanInterval: parseInt(process.env.SCAN_INTERVAL_MINUTES || "30", 10) * 60_000,
  scanOnStartup: process.env.SCAN_ON_STARTUP !== "false",
  machineName: process.env.MACHINE_NAME || os.hostname().split(".")[0],
  // LLM config: Local Ollama first (Qwen-72B), API fallback
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  localReasoningModel: process.env.LOCAL_REASONING_MODEL || "qwen2.5:72b",
  reasoningModel: process.env.REASONING_MODEL || "claude-sonnet-4-6",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
};

// ─── CLI Args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const scanOnce = args.includes("--scan-once");
const dryRun = args.includes("--dry-run");
const intervalIdx = args.indexOf("--interval");
if (intervalIdx !== -1 && args[intervalIdx + 1]) {
  config.scanInterval = parseInt(args[intervalIdx + 1], 10) * 60_000;
}

// ─── State ──────────────────────────────────────────────────────────────────

let natsConn = null; // { nc, sc }
let scanTimer = null;
let pendingProposals = []; // Latest proposals awaiting approval
let latestFleetStatus = null; // Cached from ship.fleet.status

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [Bosun] ${msg}`);
}

// ─── Stale Handler ──────────────────────────────────────────────────────────

const staleHandler = createStaleHandler(config, log, { publishJSON });

// ─── Morning Scan ───────────────────────────────────────────────────────────

async function doScan() {
  log("Starting scan...");
  try {
    const result = await runMorningScan({
      projectDir: config.projectDir,
      reasoningModel: config.reasoningModel,
      anthropicApiKey: config.anthropicApiKey,
      machineName: config.machineName,
      fleetStatus: latestFleetStatus,
      ollamaBaseUrl: config.ollamaBaseUrl,
    });

    pendingProposals = result.proposals || [];

    const proposalMsg = {
      type: "fleet_proposal",
      proposals: pendingProposals,
      stale_expeditions: result.staleExpeditions || [],
      fleet_state: result.fleetState || {},
      reasoning: result.reasoning || "",
      scan_time: new Date().toISOString(),
    };

    if (dryRun) {
      log("DRY RUN — proposals:");
      console.log(JSON.stringify(proposalMsg, null, 2));
    } else if (natsConn) {
      publishJSON(natsConn.nc, "ship.fleet.proposal", proposalMsg, config.machineName);
      log(`Published ${pendingProposals.length} proposals to ship.fleet.proposal`);
    }

    // Handle stale expeditions (publish alerts, create chores)
    if (result.staleExpeditions?.length > 0) {
      await staleHandler.handleStaleExpeditions(result.staleExpeditions, {
        natsConn,
        dryRun,
      });
    }

    return proposalMsg;
  } catch (err) {
    log(`Scan error: ${err.message}`);
    return null;
  }
}

// ─── Message Handlers ───────────────────────────────────────────────────────

async function handleBosunCommand(msg) {
  const { action, exp, phase, model } = msg;

  switch (action) {
    case "approve": {
      if (!exp) {
        log("Approve: missing expedition ID");
        return;
      }
      const proposal = pendingProposals.find((p) => p.exp === exp);
      if (!proposal) {
        log(`Approve: ${exp} not in pending proposals`);
        return;
      }
      log(`Approved: ${exp} — spawning agent...`);
      pendingProposals = pendingProposals.filter((p) => p.exp !== exp);

      if (dryRun) {
        log(`DRY RUN — would spawn ${exp} (model: ${model || proposal.model || config.reasoningModel})`);
        return;
      }

      const wipOk = await checkWipLimit(config);
      if (!wipOk) {
        log(`WIP limit reached — deferring ${exp}`);
        if (natsConn) {
          publishJSON(natsConn.nc, "ship.fleet.alert", {
            alertType: "wip_limit",
            exp,
            message: `WIP limit reached, deferring ${exp}`,
            timestamp: new Date().toISOString(),
          }, config.machineName);
        }
        return;
      }

      try {
        const result = await spawnAgent(exp, {
          phase: phase || proposal.phase,
          model: model || proposal.model,
          config,
        });
        log(`Spawned ${exp}: ${result}`);
        if (natsConn) {
          publishJSON(natsConn.nc, "ship.fleet.alert", {
            alertType: "agent_spawned",
            exp,
            message: `Agent spawned for ${exp}`,
            timestamp: new Date().toISOString(),
          }, config.machineName);
        }
      } catch (err) {
        log(`Spawn failed for ${exp}: ${err.message}`);
      }
      break;
    }

    case "reject": {
      if (!exp) return;
      pendingProposals = pendingProposals.filter((p) => p.exp !== exp);
      log(`Rejected: ${exp} — removed from pending`);
      break;
    }

    case "scan": {
      log("Manual scan requested");
      await doScan();
      break;
    }

    case "status": {
      const status = {
        type: "fleet_status_response",
        pending: pendingProposals,
        fleet: latestFleetStatus,
        uptime: process.uptime(),
        machine: config.machineName,
        timestamp: new Date().toISOString(),
      };
      if (dryRun) {
        console.log(JSON.stringify(status, null, 2));
      } else if (natsConn) {
        publishJSON(natsConn.nc, "ship.channel.bosun", status, config.machineName);
      }
      break;
    }

    default:
      log(`Unknown action: ${action}`);
  }
}

function handleFleetAlert(msg) {
  const { alertType, exp } = msg;

  switch (alertType) {
    case "pr_created":
      log(`PR created for ${exp || "unknown"}: ${msg.url || ""}`);
      break;

    case "agent_stuck":
      log(`Agent stuck on ${exp || "unknown"}: ${msg.message || ""}`);
      break;

    case "agent_crash": {
      log(`Agent crashed on ${exp || "unknown"} — consider retry`);
      break;
    }

    case "stale_item":
      log(`Stale item: ${exp || "unknown"} (${msg.action || "?"}) — ${msg.reasoning || ""}`);
      break;

    default:
      log(`Fleet alert: ${alertType} — ${msg.message || ""}`);
  }
}

function handleFleetStatus(msg) {
  latestFleetStatus = msg;
  log(`Fleet status updated: ${msg.agents_busy || 0} busy, ${msg.agents_available || 0} available`);
}

function handleKanbanEvent(subject, data) {
  const { event, item_id, item_type, title, assignee } = data;

  if (!item_id) {
    log(`Kanban: Malformed ${subject} event — missing item_id`);
    return;
  }

  switch (subject) {
    case "ship.kanban.idea.created":
      log(`Kanban: New idea ${item_id} — "${title || "?"}" (architect evaluation pending)`);
      break;
    case "ship.kanban.expedition.started":
      log(`Kanban: Expedition started ${item_id} by ${assignee || "unassigned"}`);
      break;
    case "ship.kanban.item.completed":
      log(`Kanban: Completed ${item_id} (${item_type || "?"})`);
      break;
    case "ship.kanban.expedition.stale":
      log(`Kanban: Stale expedition ${item_id} — "${title || "?"}"`);
      break;
    case "ship.kanban.expedition.assigned":
      log(`Kanban: ${item_id} assigned to ${assignee || "?"}`);
      break;
    case "ship.kanban.item.blocked":
      log(`Kanban: ${item_id} BLOCKED — "${title || "?"}"`);
      break;
    default:
      log(`Kanban: [${subject}] ${item_id || "?"} ${event || ""}`);
  }
}

// ─── NATS Subscription Router ───────────────────────────────────────────────

async function subscribeAll(nc, sc) {
  // 1. Captain commands
  const bosunSub = nc.subscribe("ship.channel.bosun");
  log("Subscribed to ship.channel.bosun");

  (async () => {
    for await (const msg of bosunSub) {
      try {
        const data = decodeJSON(msg);
        // Skip own messages
        if (data.origin === config.machineName) continue;
        // Skip non-command messages (like our status responses)
        if (data.type === "fleet_status_response") continue;
        await handleBosunCommand(data);
      } catch (err) {
        log(`Bosun command error: ${err.message}`);
      }
    }
  })();

  // 2. Fleet alerts
  const alertSub = nc.subscribe("ship.fleet.alert");
  log("Subscribed to ship.fleet.alert");

  (async () => {
    for await (const msg of alertSub) {
      try {
        const data = decodeJSON(msg);
        if (data.origin === config.machineName) continue;
        handleFleetAlert(data);
      } catch (err) {
        log(`Alert error: ${err.message}`);
      }
    }
  })();

  // 3. Fleet status
  const statusSub = nc.subscribe("ship.fleet.status");
  log("Subscribed to ship.fleet.status");

  (async () => {
    for await (const msg of statusSub) {
      try {
        const data = decodeJSON(msg);
        handleFleetStatus(data);
      } catch (err) {
        log(`Status error: ${err.message}`);
      }
    }
  })();

  // 4. Kanban events (published by yurtle-kanban hook engine)
  const kanbanSub = nc.subscribe("ship.kanban.>");
  log("Subscribed to ship.kanban.>");

  (async () => {
    for await (const msg of kanbanSub) {
      try {
        const data = decodeJSON(msg);
        if (data.origin === config.machineName) continue;
        handleKanbanEvent(msg.subject, data);
      } catch (err) {
        log(`Kanban event error: ${err.message}`);
      }
    }
  })();
}

// ─── Scan Timer ─────────────────────────────────────────────────────────────

function startScanTimer() {
  if (scanTimer) clearInterval(scanTimer);
  const intervalMin = config.scanInterval / 60_000;
  log(`Scan interval: ${intervalMin} minutes`);
  scanTimer = setInterval(doScan, config.scanInterval);
}

// ─── Startup ────────────────────────────────────────────────────────────────

async function main() {
  log("Starting Noesis Ship LLM Bosun...");
  log(`Machine: ${config.machineName}`);
  log(`Project: ${config.projectDir}`);
  log(`Local LLM: ${config.localReasoningModel} @ ${config.ollamaBaseUrl}`);
  log(`Fallback: ${config.reasoningModel} (API)`);
  log(`NATS: ${config.natsUrl}`);
  if (dryRun) log("DRY RUN mode — no NATS publishing, no spawning");

  // --scan-once: run one scan and exit
  if (scanOnce) {
    const result = await doScan();
    if (result && !dryRun) {
      log("Scan complete. Use NATS to approve proposals.");
    }
    process.exit(0);
  }

  // Connect to NATS
  if (!dryRun) {
    natsConn = await connectNATS(config.natsUrl, "Bosun", log);
    if (!natsConn) {
      log("NATS connection failed — running in offline mode (scan-only)");
    } else {
      await subscribeAll(natsConn.nc, natsConn.sc);
    }
  }

  // Start scan timer
  startScanTimer();

  // Initial scan on startup
  if (config.scanOnStartup) {
    // Small delay to let NATS subscriptions settle
    setTimeout(doScan, 2000);
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

async function shutdown() {
  log("Shutting down...");
  if (scanTimer) clearInterval(scanTimer);
  if (natsConn) {
    try {
      await natsConn.nc.drain();
    } catch {
      // drain may fail if already closed
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Start ──────────────────────────────────────────────────────────────────

await main();
