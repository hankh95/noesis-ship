/**
 * Noesis Ship — Configuration Loader
 *
 * Centralized config with env var overrides and defaults.
 * Used by all packages to ensure consistent configuration.
 *
 * @noesis-ship/shared
 */

const path = require("path");
const os = require("os");

/**
 * Load configuration from environment with sensible defaults.
 * @param {object} [overrides] - Override specific values
 * @returns {object} Configuration object
 */
function loadConfig(overrides = {}) {
  return {
    // NATS
    natsUrl: overrides.natsUrl || process.env.NATS_URL || "nats://localhost:4222",

    // WebSocket relay
    wsPort: parseInt(overrides.wsPort || process.env.WS_PORT || "3100", 10),
    bridgeUrl: overrides.bridgeUrl || process.env.BRIDGE_URL || "ws://localhost:3100",

    // Agent identity
    agentName: overrides.agentName || process.env.AGENT_NAME || os.hostname().split(".")[0],
    machineName: overrides.machineName || process.env.MACHINE_NAME || os.hostname().split(".")[0],

    // Agent roster (format: "id:Name,id:Name")
    agents: overrides.agents || process.env.AGENTS || "mini:Mini,m5:M5,dgx:DGX,copilot:Copilot",

    // Claude Code
    projectDir: overrides.projectDir || process.env.PROJECT_DIR || path.join(os.homedir(), "Projects/nusy-product-team"),
    claudeBin: overrides.claudeBin || process.env.CLAUDE_BIN || "claude",
    claudeSessionDir: overrides.claudeSessionDir || process.env.CLAUDE_SESSION_DIR || "",
    maxTurns: parseInt(overrides.maxTurns || process.env.MAX_TURNS || "10", 10),
    permissionMode: overrides.permissionMode || process.env.PERMISSION_MODE || "bypassPermissions",

    // Timing
    reconnectInterval: parseInt(overrides.reconnectInterval || process.env.RECONNECT_INTERVAL || "3000", 10),
    responseTimeout: parseInt(overrides.responseTimeout || process.env.RESPONSE_TIMEOUT || "120000", 10),
  };
}

module.exports = { loadConfig };
