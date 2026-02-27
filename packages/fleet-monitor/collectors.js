/**
 * Fleet Monitor — Data Collectors
 *
 * Collects agent session state from tmux and PR state from GitHub CLI.
 * Both collectors use child_process.execFile for safety (no shell injection).
 *
 * @noesis-ship/fleet-monitor
 */

const { execFile } = require("child_process");

/**
 * Collect tmux agent sessions with idle time.
 *
 * Uses `tmux list-sessions` with format string to get session_activity
 * timestamps (epoch seconds). Computes idle time as delta from now.
 *
 * Note: `tmux capture-pane` returns blank for Claude Code TUI sessions,
 * so we rely on session_activity for liveness detection.
 *
 * @returns {Promise<Array<{name: string, lastActivity: number, idleMinutes: number, attached: boolean}>>}
 */
function collectTmuxSessions() {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["list-sessions", "-F", "#{session_name}|#{session_activity}|#{session_attached}"],
      { timeout: 5_000 },
      (err, stdout) => {
        if (err) {
          // tmux not running or no sessions — not an error
          resolve([]);
          return;
        }

        const now = Date.now();
        const sessions = stdout
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const [name, activityEpoch, attached] = line.split("|");
            const lastActivity = parseInt(activityEpoch, 10) * 1000; // to ms
            const idleMinutes = Math.floor((now - lastActivity) / 60_000);
            return {
              name,
              lastActivity,
              idleMinutes: Math.max(0, idleMinutes),
              attached: attached === "1",
            };
          });

        resolve(sessions);
      }
    );
  });
}

/**
 * Collect open GitHub PRs with CI and review status.
 *
 * Uses `gh pr list` with JSON output. Requires the `gh` CLI to be
 * installed and authenticated.
 *
 * @param {string} repo - Repository in "owner/name" format
 * @returns {Promise<Array<{number: number, title: string, branch: string, author: string, ciStatus: string, reviews: Array}>>}
 */
function collectGitHubPRs(repo) {
  return new Promise((resolve) => {
    execFile(
      "gh",
      [
        "pr", "list",
        "--repo", repo,
        "--state", "open",
        "--json", "number,title,headRefName,author,statusCheckRollup,reviews",
      ],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          // gh CLI not available or auth issues — not fatal
          resolve([]);
          return;
        }

        try {
          const raw = JSON.parse(stdout);
          const prs = raw.map((pr) => {
            // Determine overall CI status from statusCheckRollup
            const checks = pr.statusCheckRollup || [];
            let ciStatus = "UNKNOWN";
            if (checks.length > 0) {
              const hasFailure = checks.some(
                (c) => c.conclusion === "FAILURE" || c.conclusion === "failure"
              );
              const allSuccess = checks.every(
                (c) => c.conclusion === "SUCCESS" || c.conclusion === "success"
              );
              const hasPending = checks.some(
                (c) => !c.conclusion || c.conclusion === "PENDING" || c.status === "IN_PROGRESS"
              );
              if (hasFailure) ciStatus = "FAILURE";
              else if (allSuccess) ciStatus = "SUCCESS";
              else if (hasPending) ciStatus = "PENDING";
            }

            return {
              number: pr.number,
              title: pr.title,
              branch: pr.headRefName,
              author: pr.author?.login || "unknown",
              ciStatus,
              reviews: (pr.reviews || []).map((r) => ({
                author: r.author?.login || "unknown",
                state: r.state,
              })),
            };
          });

          resolve(prs);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

module.exports = { collectTmuxSessions, collectGitHubPRs };
