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
  ],
};
