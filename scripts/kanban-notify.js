#!/usr/bin/env node

/**
 * kanban-notify.js — Publish kanban state changes to NATS
 *
 * Usage:
 *   node kanban-notify.js moved EXP-009 review --previous in-progress
 *   node kanban-notify.js created TASK-010 backlog
 *   node kanban-notify.js assigned EXP-009 DGX
 *
 * Environment:
 *   NATS_URL — NATS server URL (default: nats://localhost:4222)
 *   REPO_NAME — Repository name for the event (default: auto-detect from git)
 *
 * NATS subjects:
 *   ship.kanban.moved    — item moved to new status
 *   ship.kanban.created  — new item created
 *   ship.kanban.assigned — item assigned to agent
 */

const { connect, StringCodec } = require("nats");
const { execSync } = require("child_process");
const path = require("path");

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const sc = StringCodec();

function getRepoName() {
  if (process.env.REPO_NAME) return process.env.REPO_NAME;
  try {
    const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
    return path.basename(remote, ".git");
  } catch {
    return "unknown";
  }
}

function getItemDetails(itemId) {
  try {
    const output = execSync(`yurtle-kanban show ${itemId} --json`, { encoding: "utf8" });
    return JSON.parse(output);
  } catch {
    return { id: itemId };
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: kanban-notify.js <event> <item-id> [status] [--previous <status>] [--assignee <name>]");
    console.error("");
    console.error("Events: moved, created, assigned");
    console.error("");
    console.error("Examples:");
    console.error("  kanban-notify.js moved EXP-009 review --previous in-progress");
    console.error("  kanban-notify.js created TASK-010 backlog");
    console.error("  kanban-notify.js assigned EXP-009 DGX");
    process.exit(1);
  }

  const event = args[0];
  const itemId = args[1];
  const status = args[2] && !args[2].startsWith("--") ? args[2] : undefined;

  const flags = {};
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--previous" && args[i + 1]) {
      flags.previousStatus = args[++i];
    } else if (args[i] === "--assignee" && args[i + 1]) {
      flags.assignee = args[++i];
    }
  }

  return { event, itemId, status, ...flags };
}

async function main() {
  const { event, itemId, status, previousStatus, assignee } = parseArgs();
  const repo = getRepoName();

  // Get item details from yurtle-kanban if available
  const item = getItemDetails(itemId);

  const message = {
    type: "kanban_event",
    event,
    item: {
      id: item.id || itemId,
      title: item.title || itemId,
      status: status || item.status || "unknown",
      previousStatus: previousStatus || null,
      assignee: assignee || item.assignee || null,
      priority: item.priority || null,
    },
    repo,
    timestamp: new Date().toISOString(),
  };

  const subject = `ship.kanban.${event}`;

  let nc;
  try {
    nc = await connect({ servers: NATS_URL, timeout: 5000 });
    nc.publish(subject, sc.encode(JSON.stringify(message)));
    await nc.flush();
    console.log(`[kanban-notify] Published to ${subject}:`, JSON.stringify(message, null, 2));
    await nc.close();
  } catch (err) {
    // If NATS isn't available, log and exit gracefully
    console.warn(`[kanban-notify] NATS unavailable (${err.message}) — event not published`);
    if (nc) await nc.close().catch(() => {});
    process.exit(0); // Don't fail the kanban operation
  }
}

main();
