#!/usr/bin/env node

/**
 * Lists known groups from the running bridge server.
 * Usage: node groups.js [url]
 */

const WebSocket = require("ws");

const url = process.argv[2] || "ws://localhost:3100";

const ws = new WebSocket(url);

const timer = setTimeout(() => {
  console.error("Timed out connecting to bridge");
  process.exit(1);
}, 5000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "list_groups" }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === "status") {
    const services = Object.entries(msg)
      .filter(([k]) => k !== "type")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    console.log(`Bridge status: ${services}`);
  }

  if (msg.type === "groups") {
    clearTimeout(timer);
    if (msg.groups.length === 0) {
      console.log("No groups found. Send a message in a group first so the bot discovers it.");
    } else {
      console.log(`\n  Groups (${msg.groups.length}):\n`);
      for (const g of msg.groups) {
        console.log(`  [${g.service}] ${g.name}`);
        console.log(`         ID: ${g.id}\n`);
      }
    }
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (err) => {
  clearTimeout(timer);
  console.error(`Cannot connect to bridge at ${url}: ${err.message}`);
  console.error("Is the bridge running? Start with: npm start");
  process.exit(1);
});
