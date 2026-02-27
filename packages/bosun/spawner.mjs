/**
 * Agent Spawner — Wraps fleet-spawn.sh
 *
 * Handles:
 * - WIP limit checks (parse tmux session count)
 * - Spawn via fleet-spawn.sh --worktree
 * - Retry with prompt mutation on failure
 * - Logging spawn events
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

// Max concurrent expedition sessions (WIP limit)
const MAX_WIP = 5;

/**
 * Check if spawning another agent would exceed the WIP limit.
 * Counts active tmux sessions that look like expedition work.
 *
 * @param {object} config - Service configuration
 * @returns {Promise<boolean>} true if under limit, false if at/over limit
 */
export async function checkWipLimit(config) {
  try {
    const { stdout } = await execFile("tmux", ["list-sessions", "-F", "#{session_name}"], {
      timeout: 5000,
    });
    const sessions = stdout.trim().split("\n").filter(Boolean);
    // Count sessions that match expedition pattern (exp-NNN-*)
    const expSessions = sessions.filter((s) => s.match(/^exp-\d+/i));
    return expSessions.length < MAX_WIP;
  } catch {
    // tmux not running or no sessions — under limit
    return true;
  }
}

/**
 * Get current WIP count (number of active expedition tmux sessions).
 *
 * @returns {Promise<number>}
 */
export async function getWipCount() {
  try {
    const { stdout } = await execFile("tmux", ["list-sessions", "-F", "#{session_name}"], {
      timeout: 5000,
    });
    const sessions = stdout.trim().split("\n").filter(Boolean);
    return sessions.filter((s) => s.match(/^exp-\d+/i)).length;
  } catch {
    return 0;
  }
}

/**
 * Spawn an agent for an expedition using fleet-spawn.sh.
 *
 * @param {string} expId - Expedition ID (e.g., "EXP-985")
 * @param {object} options
 * @param {string} [options.phase] - Specific phase to work on
 * @param {string} [options.model] - Claude model to use
 * @param {boolean} [options.worktree=true] - Use git worktree for isolation
 * @param {object} options.config - Service configuration
 * @returns {Promise<string>} Spawn result message
 */
export async function spawnAgent(expId, options = {}) {
  const { phase, model, worktree = true, config } = options;

  const spawnPath = config.fleetSpawnPath;
  const args = [spawnPath, expId];

  if (worktree) args.push("--worktree");
  if (phase) args.push("--phase", phase);
  if (model) args.push("--model", model);

  try {
    const { stdout, stderr } = await execFile("bash", args, {
      timeout: 30_000,
      env: {
        ...process.env,
        NUSY_PROJECT_DIR: config.projectDir,
      },
    });

    const output = stdout.trim() || stderr.trim();
    return output || `Spawned ${expId}`;
  } catch (err) {
    throw new Error(`fleet-spawn failed for ${expId}: ${err.message}`);
  }
}

/**
 * Retry spawning with a mutated prompt hint.
 * Used when an agent crashes — adds context about what went wrong.
 *
 * @param {string} expId - Expedition ID
 * @param {string} failureHint - What went wrong in the previous attempt
 * @param {object} options - Same as spawnAgent options
 * @returns {Promise<string>}
 */
export async function retryWithMutation(expId, failureHint, options = {}) {
  // Categorize failure for prompt mutation
  const mutations = {
    test_failure: "Previous attempt had test failures. Run pytest first, fix failures before creating PR.",
    merge_conflict: "Previous attempt hit merge conflicts. Pull latest main, resolve conflicts, then proceed.",
    missing_dep: "Previous attempt had missing dependencies. Check imports and install requirements.",
    scope_creep: "Previous attempt went off-scope. Focus strictly on expedition acceptance criteria.",
    timeout: "Previous attempt timed out. Break work into smaller chunks, commit progress incrementally.",
  };

  const category = Object.keys(mutations).find((k) => failureHint.toLowerCase().includes(k)) || "timeout";
  const hint = mutations[category];

  // For now, just log and re-spawn — fleet-spawn.sh doesn't support mutation hints yet
  // TODO: Pass mutation hint via env var or prompt file
  console.log(`[Bosun] Retry ${expId} with mutation: ${hint}`);
  return spawnAgent(expId, options);
}

/**
 * Create a kanban chore via yurtle-kanban CLI.
 * Used by stale-handler to auto-create remediation chores.
 *
 * @param {string} title - Chore title
 * @param {object} options
 * @param {object} options.config - Service configuration (needs projectDir)
 * @returns {Promise<string>} CLI output
 */
export async function createChore(title, options = {}) {
  const { config } = options;

  try {
    const { stdout, stderr } = await execFile(
      "bash",
      ["-c", `yurtle-kanban create chore "${title.replace(/"/g, '\\"')}" --push`],
      {
        timeout: 30_000,
        cwd: config.projectDir,
        env: { ...process.env },
      },
    );

    return stdout.trim() || stderr.trim() || `Created chore: ${title}`;
  } catch (err) {
    throw new Error(`yurtle-kanban create chore failed: ${err.message}`);
  }
}
