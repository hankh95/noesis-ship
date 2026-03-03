#!/usr/bin/env node
/**
 * Fleet Alert Test Publisher
 *
 * Publishes a test alert to ship.fleet.alert via NATS.
 * Used for live validation that the relay forwards alerts to WebSocket clients.
 *
 * Usage:
 *   node test-publish.js pr_created --pr 175 --exp EXP-994 --agent Mini
 *   node test-publish.js ci_failed --pr 176 --exp EXP-995
 *   node test-publish.js agent_stuck --agent DGX --exp EXP-994 --session exp-994
 *   node test-publish.js agent_crash --agent Mini --exp EXP-994 --session exp-994
 *   node test-publish.js acf_delta --pr 175 --exp EXP-994 --delta 0.03 --being santiago-toddler-v12
 *   node test-publish.js acf_regression --pr 176 --exp EXP-995 --delta -0.02 --being santiago-toddler-v12
 *
 * Environment:
 *   NATS_URL — NATS server (default: nats://localhost:4222)
 */

const { connectNATS, publishJSON, buildFleetAlert, FLEET_ALERT_SUBJECT } = require("@noesis-ship/shared");
const os = require("os");

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const MACHINE_NAME = os.hostname().split(".")[0];

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith("--")) {
        // Try to parse as number
        const num = Number(val);
        parsed[key] = isNaN(num) ? val : num;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

function showHelp() {
  console.log(`
Fleet Alert Test Publisher

Usage: node test-publish.js <alert_type> [options]

Alert Types:
  pr_created       --pr NUM --exp ID --agent NAME
  pr_reviewed      --pr NUM --reviewer NAME [--passed true|false]
  ci_failed        --pr NUM --exp ID [--details TEXT]
  agent_stuck      --agent NAME --exp ID --session NAME [--idle_minutes NUM]
  agent_crash      --agent NAME --exp ID --session NAME [--exit_code NUM]
  acf_delta        --pr NUM --exp ID --delta NUM --being NAME
  acf_regression   --pr NUM --exp ID --delta NUM --being NAME

Environment:
  NATS_URL         NATS server (default: nats://localhost:4222)

Examples:
  node test-publish.js pr_created --pr 175 --exp EXP-994 --agent Mini
  node test-publish.js agent_stuck --agent DGX --exp EXP-994 --session exp-994 --idle_minutes 18
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    showHelp();
    process.exit(0);
  }

  const alertType = args[0];
  const opts = parseArgs(args.slice(1));

  // Build the alert payload
  const alert = buildFleetAlert(alertType, opts);

  console.log(`Publishing fleet alert to ${FLEET_ALERT_SUBJECT}:`);
  console.log(JSON.stringify(alert, null, 2));
  console.log();

  // Connect to NATS
  const conn = await connectNATS(NATS_URL, "FleetAlertTest");
  if (!conn) {
    console.error("Failed to connect to NATS. Is the server running?");
    process.exit(1);
  }

  const { nc } = conn;

  // Publish
  publishJSON(nc, FLEET_ALERT_SUBJECT, alert, MACHINE_NAME);
  console.log(`Published to ${FLEET_ALERT_SUBJECT}`);

  // Flush and disconnect
  await nc.flush();
  await nc.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
