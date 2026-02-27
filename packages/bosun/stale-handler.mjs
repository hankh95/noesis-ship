/**
 * Stale Expedition Handler
 *
 * Processes stale expeditions detected by the morning scan LLM.
 * For each stale item:
 *   - Publishes a stale_item alert to ship.fleet.alert
 *   - Creates a kanban chore for close/archive actions
 *   - Skips duplicates (dedup per day)
 *
 * Epoch 4.6.6 — ROADMAP-V4-AUTOMATION.md
 */

import { createChore } from "./spawner.mjs";

/**
 * Create a stale handler with deduplication and logging.
 *
 * @param {object} config - Service configuration (projectDir, machineName)
 * @param {function} log - Logging function
 * @param {object} deps - Injectable dependencies
 * @param {function} deps.publishJSON - NATS publish function
 * @returns {{ handleStaleExpeditions: function, resetDaily: function }}
 */
export function createStaleHandler(config, log, deps = {}) {
  const { publishJSON } = deps;

  // Dedup: track processed items per day as "EXP-XXX-action"
  let processedToday = new Set();
  let lastResetDate = todayStr();

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function resetIfNewDay() {
    const today = todayStr();
    if (today !== lastResetDate) {
      processedToday = new Set();
      lastResetDate = today;
      log("Stale handler: daily reset");
    }
  }

  /**
   * Process stale expeditions from a morning scan result.
   *
   * @param {Array<{exp: string, action: string, reasoning: string}>} staleExpeditions
   * @param {object} opts
   * @param {object|null} opts.natsConn - NATS connection { nc, sc }
   * @param {boolean} opts.dryRun - If true, log but don't publish or create chores
   */
  async function handleStaleExpeditions(staleExpeditions, { natsConn, dryRun }) {
    resetIfNewDay();

    for (const item of staleExpeditions) {
      const { exp, action, reasoning } = item;
      const dedupKey = `${exp}-${action}`;

      if (processedToday.has(dedupKey)) {
        log(`Stale: ${exp} (${action}) — skipped (already processed today)`);
        continue;
      }

      processedToday.add(dedupKey);
      log(`Stale: ${exp} (${action}) — ${reasoning}`);

      // Publish alert
      const alert = {
        alertType: "stale_item",
        exp,
        action,
        reasoning,
        message: `Stale expedition ${exp}: ${action} — ${reasoning}`,
        timestamp: new Date().toISOString(),
      };

      if (dryRun) {
        log(`DRY RUN — would publish stale_item alert for ${exp}`);
      } else if (natsConn && publishJSON) {
        publishJSON(natsConn.nc, "ship.fleet.alert", alert, config.machineName);
      }

      // Create chore for actionable items (close, archive)
      if (action === "close" || action === "archive") {
        const choreTitle = `${capitalize(action)} stale ${exp}: ${truncate(reasoning, 60)}`;

        if (dryRun) {
          log(`DRY RUN — would create chore: "${choreTitle}"`);
        } else {
          try {
            const result = await createChore(choreTitle, { config });
            log(`Created chore for ${exp}: ${result}`);
          } catch (err) {
            log(`Failed to create chore for ${exp}: ${err.message}`);
          }
        }
      }
      // "update" action: alert only — Captain reviews
    }
  }

  function resetDaily() {
    processedToday = new Set();
    lastResetDate = todayStr();
  }

  return { handleStaleExpeditions, resetDaily };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || "";
  return str.slice(0, maxLen - 3) + "...";
}
