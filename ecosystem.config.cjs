/**
 * PM2 Ecosystem — Noesis Ship Services
 *
 * Deploy with:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Fleet automation services (bosun, fleet-monitor, fleet-status, fleet-log,
 * bosun-ops, bosun-decision-sink) archived — see packages/_archive/ and
 * nusy-product-team EXP-1062.
 */

module.exports = {
  apps: [
    {
      name: "relay",
      script: "packages/relay/server.js",
      env: {
        NATS_URL: "nats://localhost:4222",
        PORT: "3001",
      },
      restart_delay: 5000,
    },
    // CHORE-077: Command Deck dashboard
    {
      name: "command-deck",
      script: ".venv/bin/python",
      args: "dashboard/v2/app.py",
      cwd: process.env.NUSY_PROJECT_DIR || require("os").homedir() + "/projects/nusy-product-team",
      env: {
        NATS_URL: "nats://localhost:4222",
      },
      restart_delay: 5000,
    },
  ],
};
