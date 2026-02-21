#!/usr/bin/env node

/**
 * Sends a test message to the first known group via the bridge.
 * Usage: node send.js "your message here" [group-id] [url]
 */

const WebSocket = require("ws");

const message = process.argv[2];
const explicitGroup = process.argv[3];
const url = process.argv[4] || "ws://localhost:3100";

if (!message) {
  console.log("Usage: node send.js \"message\" [group-id] [ws-url]");
  console.log("       npm run send -- \"message\"");
  process.exit(1);
}

const ws = new WebSocket(url);

const timer = setTimeout(() => {
  console.error("Timed out");
  process.exit(1);
}, 5000);

ws.on("open", () => {
  if (explicitGroup) {
    sendMessage(explicitGroup);
  } else {
    // Ask for groups, send to first one
    ws.send(JSON.stringify({ type: "list_groups" }));
  }
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === "groups") {
    if (msg.groups.length === 0) {
      console.error("No groups found. Send a message in a group first.");
      ws.close();
      process.exit(1);
    }
    const group = msg.groups[0];
    console.log(`Target: ${group.name} (${group.id})`);
    sendMessage(group.id);
  }
});

function sendMessage(groupId) {
  clearTimeout(timer);
  ws.send(JSON.stringify({
    type: "send",
    group: groupId,
    to: "fleet",
    message: message,
  }));
  console.log(`Sent: "${message}"`);
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 1000);
}

ws.on("error", (err) => {
  clearTimeout(timer);
  console.error(`Cannot connect to bridge at ${url}: ${err.message}`);
  process.exit(1);
});
