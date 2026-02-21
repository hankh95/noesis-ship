#!/usr/bin/env node
/**
 * Noesis Ship MCP Server
 *
 * Exposes the Noesis Ship bridge to Claude Code via Model Context Protocol.
 * Connects to the bridge WebSocket and provides tools for bidirectional
 * communication with Ships Comm (the iOS app) and fleet agents.
 *
 * Tools:
 *   - check_inbox       Read new messages (human + agent) since last check
 *   - send_to_ships_comm  Send a message to the Ships Comm iOS app
 *   - send_to_agent     Send a directed message to a specific fleet agent
 *   - bridge_status     Get bridge connection status, agents, and sessions
 *
 * Resources:
 *   - noesis://inbox    Live inbox (with change notifications)
 *
 * Configuration (env):
 *   BRIDGE_URL  — WebSocket URL (default: ws://localhost:3100)
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const WebSocket = require("ws");

// ─── Configuration ──────────────────────────────────────────────────────────

const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3100";
const RECONNECT_INTERVAL = 3000;

// ─── Bridge Connection ──────────────────────────────────────────────────────

let ws = null;
let bridgeStatus = null;
let connected = false;
const inbox = [];          // Messages received from Ships Comm and agents
let lastReadIndex = 0;     // Track what's been read
let mcpServerRef = null;   // Reference for sending notifications

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
      } else if (msg.type === "message") {
        // Capture messages from Ships Comm user and from agents
        const isHuman = msg.fromId === "carclaw:user";
        const isAgent = msg.fromId && msg.fromId.startsWith("agent:");

        if (isHuman || isAgent) {
          inbox.push({
            timestamp: msg.timestamp || new Date().toISOString(),
            from: msg.from || "Unknown",
            fromId: msg.fromId,
            to: msg.to || null,
            message: msg.message,
            group: msg.group,
          });
          log(`Inbox [${isHuman ? "human" : "agent"}]: ${msg.message.substring(0, 60)}`);

          // Notify MCP client that inbox resource changed
          if (mcpServerRef) {
            try {
              mcpServerRef.server.notification({
                method: "notifications/resources/updated",
                params: { uri: "noesis://inbox" },
              });
            } catch {
              // Client may not support notifications
            }
          }
        }
      }
    } catch {
      // Skip unparseable messages
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
      log("Reconnecting to bridge...");
      connectBridge();
    }
  }, RECONNECT_INTERVAL);
}

function sendToBridge(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to bridge");
  }
  ws.send(JSON.stringify(obj));
}

// Logging goes to stderr (stdout is reserved for MCP protocol)
function log(msg) {
  process.stderr.write(`[Noesis MCP] ${msg}\n`);
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

async function main() {
  const server = new McpServer({
    name: "noesis-ship",
    version: "1.0.0",
  });
  mcpServerRef = server;

  // ── Tool: check_inbox ──────────────────────────────────────────────────

  server.tool(
    "check_inbox",
    "Read new messages from the Ships Comm iOS app and fleet agents. Returns messages received since the last check.",
    {},
    async () => {
      const newMessages = inbox.slice(lastReadIndex);
      lastReadIndex = inbox.length;

      if (newMessages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No new messages.",
            },
          ],
        };
      }

      const formatted = newMessages
        .map(
          (m) =>
            `[${m.timestamp}] ${m.from}${m.to ? ` → @${m.to}` : ""}: ${m.message}`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${newMessages.length} new message(s):\n\n${formatted}`,
          },
        ],
      };
    }
  );

  // ── Tool: send_to_ships_comm ───────────────────────────────────────────

  server.tool(
    "send_to_ships_comm",
    "Send a message to the Ships Comm iOS app. The message will appear in the conversation view.",
    {
      message: z.string().describe("The message to send to Ships Comm"),
    },
    async ({ message }) => {
      if (!connected) {
        return {
          content: [
            { type: "text", text: "Error: Not connected to bridge." },
          ],
          isError: true,
        };
      }

      // Get the active session group from bridge status
      const sessionGroup = bridgeStatus?.sessions?.[0]
        ? `session:${bridgeStatus.sessions[0].sessionId}`
        : "session:active";

      sendToBridge({
        type: "broadcast",
        payload: {
          type: "message",
          group: sessionGroup,
          from: bridgeStatus?.machine || "Claude Code",
          fromId: "mcp:claude-code",
          message,
          timestamp: new Date().toISOString(),
          sessionMessage: true,
        },
      });

      return {
        content: [
          { type: "text", text: `Sent to Ships Comm: "${message}"` },
        ],
      };
    }
  );

  // ── Tool: send_to_agent ────────────────────────────────────────────────

  server.tool(
    "send_to_agent",
    "Send a directed message to a specific fleet agent (Mini, DGX, M5). The target agent's daemon will process the message and respond.",
    {
      agent: z.string().describe("Target agent name (e.g., Mini, DGX, M5)"),
      message: z.string().describe("The message to send to the agent"),
      group: z.string().optional().describe("Channel group (default: fleet)"),
    },
    async ({ agent, message, group }) => {
      if (!connected) {
        return {
          content: [
            { type: "text", text: "Error: Not connected to bridge." },
          ],
          isError: true,
        };
      }

      const senderName = bridgeStatus?.machine || "MCP";

      sendToBridge({
        type: "broadcast",
        payload: {
          type: "message",
          group: group || "fleet",
          from: senderName,
          fromId: `agent:${senderName.toLowerCase()}`,
          to: agent,
          message,
          timestamp: new Date().toISOString(),
          sessionMessage: true,
        },
      });

      return {
        content: [
          { type: "text", text: `Sent to ${agent}: "${message}"` },
        ],
      };
    }
  );

  // ── Tool: bridge_status ────────────────────────────────────────────────

  server.tool(
    "bridge_status",
    "Get the current status of the Noesis Ship bridge (connected services, active sessions, agent roster).",
    {},
    async () => {
      if (!connected || !bridgeStatus) {
        return {
          content: [
            {
              type: "text",
              text: connected
                ? "Connected to bridge, awaiting status..."
                : `Not connected to bridge at ${BRIDGE_URL}`,
            },
          ],
        };
      }

      const lines = [
        `Bridge: ${BRIDGE_URL} (connected)`,
        `Machine: ${bridgeStatus.machine || "unknown"}`,
        `NATS: ${bridgeStatus.nats || "unknown"}`,
      ];

      if (bridgeStatus.tailscaleIP) {
        lines.push(`Tailscale: ${bridgeStatus.tailscaleIP}`);
      }

      if (bridgeStatus.relayURL) {
        lines.push(`Relay: ${bridgeStatus.relayURL}`);
      }

      if (bridgeStatus.agents?.length) {
        lines.push(
          `Agents: ${bridgeStatus.agents.map((a) => a.name).join(", ")}`
        );
      }

      if (bridgeStatus.sessions?.length) {
        lines.push(
          `Sessions: ${bridgeStatus.sessions.map((s) => `${s.machine}:${s.sessionId.substring(0, 8)}${s.active ? " (active)" : ""}`).join(", ")}`
        );
      }

      lines.push(`Inbox: ${inbox.length} total, ${inbox.length - lastReadIndex} unread`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );

  // ── Resource: noesis://inbox ────────────────────────────────────────────

  server.resource("noesis://inbox", "noesis://inbox", async (uri) => {
    if (inbox.length === 0) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: "No messages in inbox.",
          },
        ],
      };
    }

    const formatted = inbox
      .map(
        (m) =>
          `[${m.timestamp}] ${m.from}${m.to ? ` → @${m.to}` : ""}: ${m.message}`
      )
      .join("\n");

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: formatted,
        },
      ],
    };
  });

  // ── Start ──────────────────────────────────────────────────────────────

  // Connect to bridge first
  connectBridge();

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("MCP server started");
}

main().catch((err) => {
  process.stderr.write(`[Noesis MCP] Fatal: ${err.message}\n`);
  process.exit(1);
});
