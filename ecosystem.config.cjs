/**
 * PM2 Ecosystem — Bosun Fleet Services
 *
 * Deploy on DGX with:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * EXP-1014 Phase 1 — Service Deployment
 */

module.exports = {
  apps: [
    {
      name: "bosun",
      script: "packages/bosun/bosun-service.mjs",
      env: {
        NATS_URL: "nats://localhost:4222",
        SCAN_INTERVAL_MINUTES: "30",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
        // Disable local LLM — Ollama stuck, use API only (EXP-1029)
        OLLAMA_BASE_URL: "http://localhost:1/disabled",
      },
      restart_delay: 5000,
    },
    {
      name: "fleet-monitor",
      script: "packages/fleet-monitor/monitor.js",
      env: {
        NATS_URL: "nats://localhost:4222",
      },
      restart_delay: 5000,
    },
    {
      name: "fleet-status",
      script: "packages/fleet-status/fleet-status-service.js",
      env: {
        NATS_URL: "nats://localhost:4222",
      },
      restart_delay: 5000,
    },
    {
      name: "fleet-log",
      script: "packages/fleet-log/fleet-log-writer.js",
      env: {
        NATS_URL: "nats://localhost:4222",
      },
      restart_delay: 5000,
    },
    {
      name: "bosun-ops",
      script: "packages/bosun-ops/ops-logger.js",
      env: {
        NATS_URL: "nats://localhost:4222",
      },
      restart_delay: 5000,
    },
    {
      name: "relay",
      script: "packages/relay/server.js",
      env: {
        NATS_URL: "nats://localhost:4222",
        PORT: "3001",
      },
      restart_delay: 5000,
    },
    // EXP-1030: Persist Bosun proposals to decision journal
    {
      name: "bosun-decision-sink",
      script: ".venv/bin/python",
      args: "ships/tackle/logs/bosun_decision_sink.py",
      cwd: process.env.NUSY_PROJECT_DIR || require("os").homedir() + "/projects/nusy-product-team",
      env: {
        NATS_URL: "nats://localhost:4222",
      },
      restart_delay: 5000,
    },
  ],
};
