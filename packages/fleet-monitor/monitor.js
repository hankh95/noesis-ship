#!/usr/bin/env node
/**
 * Fleet Monitor Service
 *
 * Polls tmux agent sessions and GitHub PRs on a configurable interval,
 * detects actionable events, and publishes to NATS:
 *   - ship.fleet.status  — periodic status snapshot
 *   - ship.fleet.alert   — actionable events (agent_stuck, ci_failed, etc.)
 *
 * The relay (already subscribed to ship.fleet.>) forwards these to the
 * Command Deck via WebSocket.
 *
 * Environment:
 *   NATS_URL             — NATS server (default: nats://localhost:4222)
 *   MONITOR_INTERVAL_MIN — Polling interval in minutes (default: 10)
 *   IDLE_THRESHOLD_MIN   — Minutes idle before agent_stuck alert (default: 15)
 *   GITHUB_REPO          — Repository to monitor (default: hankh95/nusy-product-team)
 *   MACHINE_NAME         — Origin tag for NATS messages (default: hostname)
 *
 * @noesis-ship/fleet-monitor
 */

const os = require("os");
const {
  connectNATS,
  publishJSON,
  buildFleetAlert,
  buildFleetStatus,
  FLEET_ALERT_SUBJECT,
  FLEET_STATUS_SUBJECT,
} = require("@noesis-ship/shared");
const { collectTmuxSessions, collectGitHubPRs } = require("./collectors");

// ─── Configuration ──────────────────────────────────────────────────────────

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const INTERVAL_MS = (parseInt(process.env.MONITOR_INTERVAL_MIN || "10", 10)) * 60_000;
const IDLE_THRESHOLD_MIN = parseInt(process.env.IDLE_THRESHOLD_MIN || "15", 10);
const GITHUB_REPO = process.env.GITHUB_REPO || "hankh95/nusy-product-team";
const MACHINE_NAME = process.env.MACHINE_NAME || os.hostname();
const RECONNECT_INTERVAL = 5000;

// ─── State ──────────────────────────────────────────────────────────────────

let previousSessions = null;  // Map<name, session> — null = first run
let previousPRs = null;       // Map<number, pr> — null = first run
let lastAlertKeys = new Set(); // Dedup: "alertType:key" for current cycle

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [FleetMonitor] ${msg}`);
}

// ─── Alert Detection ────────────────────────────────────────────────────────

/**
 * Detect fleet alerts by comparing current state with previous state.
 * Returns an array of { alertType, payload } objects.
 *
 * First-run suppression: when previousSessions/previousPRs is null,
 * we populate state without emitting alerts to avoid startup spam.
 */
function detectAlerts(sessions, prs) {
  const alerts = [];
  const isFirstRun = previousSessions === null;

  if (!isFirstRun) {
    // ── Agent alerts ──────────────────────────────────────────────────

    for (const session of sessions) {
      // Agent stuck: idle longer than threshold
      if (session.idleMinutes >= IDLE_THRESHOLD_MIN) {
        const key = `agent_stuck:${session.name}`;
        if (!lastAlertKeys.has(key)) {
          alerts.push({
            alertType: "agent_stuck",
            payload: {
              agent: session.name,
              session: session.name,
              idle_minutes: session.idleMinutes,
              exp: "",
            },
          });
        }
      }
    }

    // Agent crash: session was in previous state but gone now
    const currentNames = new Set(sessions.map((s) => s.name));
    for (const [name] of previousSessions) {
      if (!currentNames.has(name)) {
        alerts.push({
          alertType: "agent_crash",
          payload: {
            agent: name,
            session: name,
            exit_code: -1,
            exp: "",
          },
        });
      }
    }

    // ── PR alerts ───────────────────────────────────────────────────

    for (const pr of prs) {
      const prev = previousPRs.get(pr.number);

      // New PR: not in previous state
      if (!prev) {
        alerts.push({
          alertType: "pr_created",
          payload: {
            pr: pr.number,
            agent: pr.author,
            exp: pr.branch,
          },
        });
        continue;
      }

      // CI failed: status changed to FAILURE
      if (pr.ciStatus === "FAILURE" && prev.ciStatus !== "FAILURE") {
        const key = `ci_failed:${pr.number}`;
        if (!lastAlertKeys.has(key)) {
          alerts.push({
            alertType: "ci_failed",
            payload: {
              pr: pr.number,
              exp: pr.branch,
              details: `CI failed on PR #${pr.number}: ${pr.title}`,
            },
          });
        }
      }

      // New review: more reviews than before
      if (pr.reviews.length > prev.reviews.length) {
        const newReview = pr.reviews[pr.reviews.length - 1];
        alerts.push({
          alertType: "pr_reviewed",
          payload: {
            pr: pr.number,
            reviewer: newReview.author,
            passed: newReview.state === "APPROVED",
          },
        });
      }
    }
  }

  // Update state for next cycle
  previousSessions = new Map(sessions.map((s) => [s.name, s]));
  previousPRs = new Map(prs.map((p) => [p.number, p]));

  // Build dedup keys for next cycle
  // Use stable keys: "alertType:identifier" (not full payload, which has changing fields)
  const newKeys = new Set();
  for (const a of alerts) {
    if (a.alertType === "agent_stuck") newKeys.add(`agent_stuck:${a.payload.agent}`);
    else if (a.alertType === "ci_failed") newKeys.add(`ci_failed:${a.payload.pr}`);
    else newKeys.add(`${a.alertType}:${JSON.stringify(a.payload)}`);
  }
  lastAlertKeys = newKeys;

  return alerts;
}

// ─── Polling Cycle ──────────────────────────────────────────────────────────

async function pollCycle(nc) {
  log("Polling...");

  // Collect data in parallel
  const [sessions, prs] = await Promise.all([
    collectTmuxSessions(),
    collectGitHubPRs(GITHUB_REPO),
  ]);

  log(`Collected: ${sessions.length} tmux sessions, ${prs.length} open PRs`);

  // Detect alerts
  const alerts = detectAlerts(sessions, prs);

  // Publish status snapshot
  const status = buildFleetStatus(
    sessions.map((s) => ({
      name: s.name,
      idleMinutes: s.idleMinutes,
      attached: s.attached,
    })),
    prs.map((p) => ({
      number: p.number,
      title: p.title,
      ciStatus: p.ciStatus,
      reviewStatus: p.reviews.length > 0 ? p.reviews[p.reviews.length - 1].state : "NONE",
    }))
  );
  publishJSON(nc, FLEET_STATUS_SUBJECT, status, MACHINE_NAME);
  log(`Published fleet status to ${FLEET_STATUS_SUBJECT}`);

  // Publish alerts
  for (const alert of alerts) {
    const payload = buildFleetAlert(alert.alertType, alert.payload);
    publishJSON(nc, FLEET_ALERT_SUBJECT, payload, MACHINE_NAME);
    log(`ALERT: ${alert.alertType} — ${JSON.stringify(alert.payload)}`);
  }

  if (alerts.length === 0) {
    log("No alerts this cycle");
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function start() {
  log("Starting Fleet Monitor...");
  log(`NATS: ${NATS_URL}`);
  log(`Interval: ${INTERVAL_MS / 60_000} minutes`);
  log(`Idle threshold: ${IDLE_THRESHOLD_MIN} minutes`);
  log(`GitHub repo: ${GITHUB_REPO}`);

  const conn = await connectNATS(NATS_URL, "FleetMonitor", log);
  if (!conn) {
    log(`Retrying in ${RECONNECT_INTERVAL / 1000}s...`);
    setTimeout(start, RECONNECT_INTERVAL);
    return;
  }

  const { nc } = conn;

  // Initial poll (first-run suppression will skip alerts)
  await pollCycle(nc);

  // Schedule recurring polls
  const timer = setInterval(() => {
    pollCycle(nc).catch((err) => {
      log(`Poll error: ${err.message}`);
    });
  }, INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    clearInterval(timer);
    try { await nc.drain(); } catch { /* drain may fail if already closed */ }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ─── Exports (for testing) ──────────────────────────────────────────────────

module.exports = { detectAlerts, _resetState };

function _resetState() {
  previousSessions = null;
  previousPRs = null;
  lastAlertKeys = new Set();
}

// ─── Start ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  start();
}
