/**
 * Morning Scan — Data Gathering + Claude API Reasoning
 *
 * Phase 1: Gather fleet context (kanban, fleet health, ACF, hypotheses)
 * Phase 2: Claude reasons about priorities → top 3 proposals
 * Phase 3: Return structured proposals
 *
 * All data gathering uses subprocess calls to existing CLIs
 * (yurtle-kanban, tmux, gh) — no reimplementation.
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";

const execFile = promisify(execFileCb);

// ─── Bosun System Prompt ────────────────────────────────────────────────────

const BOSUN_SYSTEM_PROMPT = `You are the Bosun of a neurosymbolic AI research fleet. Your job is to propose the highest-impact work items for the fleet's agents.

You receive:
- Kanban state (backlog expeditions with priorities)
- Fleet health (which agents are busy/available, active tmux sessions)
- ACF history (recent being performance scores — ACF is the reward signal)
- Active hypotheses (research questions being tested)

Rules:
- Maximum 3 proposals per scan
- Respect WIP limits: max 2 expeditions per agent, max 5 total in-progress
- High-priority and critical expeditions first
- Match expedition tags to agent capabilities:
  - DGX: GPU training, large models, ACF measurement, heavy computation
  - M5: Code quality, architecture, automation, testing, documentation
  - Mini: Infrastructure, CI/CD, monitoring, fleet tooling
- Never propose work that duplicates in-progress expeditions
- If ACF scores dropped recently, prioritize investigations/fixes
- If all agents are busy and at WIP limit, propose nothing

Output format (JSON):
{
  "proposals": [
    {
      "exp": "EXP-XXX",
      "title": "Short title",
      "priority": "high|medium|low|critical",
      "agent": "DGX|M5|Mini",
      "phase": null,
      "model": "claude-opus-4-6",
      "reasoning": "1-2 sentences why this is high priority"
    }
  ],
  "fleet_summary": "1-2 sentence fleet state summary",
  "reasoning": "Overall reasoning for these picks"
}`;

// ─── Data Gathering (Phase 1) ───────────────────────────────────────────────

/**
 * Run a subprocess command, return stdout or fallback string on error.
 */
async function runCmd(cmd, args, { cwd, timeout = 15_000, fallback = "" } = {}) {
  try {
    const { stdout } = await execFile(cmd, args, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return fallback;
  }
}

/**
 * Get kanban state: backlog + in-progress expeditions.
 * Primary: yurtle-kanban CLI. Fallback: glob expedition files.
 */
async function getKanbanState(projectDir) {
  // Try yurtle-kanban first
  const backlog = await runCmd("yurtle-kanban", ["list", "--status", "backlog", "--json"], { cwd: projectDir });
  const inProgress = await runCmd("yurtle-kanban", ["list", "--status", "in-progress", "--json"], { cwd: projectDir });

  if (backlog || inProgress) {
    return {
      backlog: tryParseJSON(backlog, []),
      inProgress: tryParseJSON(inProgress, []),
      source: "yurtle-kanban",
    };
  }

  // Fallback: read expedition files directly
  const fallback = await readExpeditionFiles(projectDir);
  return { ...fallback, source: "file-glob" };
}

/**
 * Fallback: read expedition files and parse frontmatter.
 */
async function readExpeditionFiles(projectDir) {
  const expDir = path.join(projectDir, "kanban-work", "expeditions");
  const backlog = [];
  const inProgress = [];

  try {
    const { readdir } = await import("fs/promises");
    const files = await readdir(expDir);

    for (const f of files) {
      if (!f.endsWith(".md") || !f.startsWith("EXP-")) continue;
      try {
        const content = await readFile(path.join(expDir, f), "utf-8");
        const fm = parseSimpleFrontmatter(content);
        if (!fm.id) continue;

        const item = {
          id: fm.id,
          title: fm.title || f,
          status: fm.status || "backlog",
          priority: fm.priority || "medium",
          assignee: fm.assignee || null,
          tags: fm.tags || [],
        };

        if (item.status === "backlog") backlog.push(item);
        else if (item.status === "in-progress" || item.status === "in_progress") inProgress.push(item);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Expedition directory not found
  }

  return { backlog, inProgress };
}

/**
 * Get fleet health: tmux sessions, open PRs, worktree status.
 */
async function getFleetHealth() {
  const [sessions, prs, worktrees] = await Promise.all([
    runCmd("tmux", ["list-sessions", "-F", "#{session_name} #{session_activity}"], { fallback: "" }),
    runCmd("gh", ["pr", "list", "--json", "number,title,author,state,headRefName", "--limit", "10"], { fallback: "[]" }),
    runCmd("git", ["worktree", "list", "--porcelain"], { fallback: "" }),
  ]);

  const activeSessions = sessions
    ? sessions.split("\n").filter((l) => l.trim())
    : [];

  return {
    tmuxSessions: activeSessions,
    openPRs: tryParseJSON(prs, []),
    worktrees: worktrees ? worktrees.split("\n").filter((l) => l.startsWith("worktree ")).length : 0,
    agentsBusy: activeSessions.filter((s) => s.match(/^exp-/i)).length,
    agentsAvailable: 3 - activeSessions.filter((s) => s.match(/^exp-/i)).length,
  };
}

/**
 * Get recent ACF history from longitudinal data.
 */
async function getAcfHistory(projectDir) {
  const dataDir = path.join(projectDir, "research", "A-NUSY-LONGITUDINAL-DATA", "data");
  try {
    const { readdir, stat } = await import("fs/promises");
    const files = await readdir(dataDir);

    // Find most recent JSON files
    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(-5);

    const results = [];
    for (const f of jsonFiles) {
      try {
        const content = await readFile(path.join(dataDir, f), "utf-8");
        const data = JSON.parse(content);
        results.push({ file: f, ...data });
      } catch {
        // Skip bad files
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Get active hypotheses from the hypothesis list.
 */
async function getHypotheses(projectDir) {
  const hypFile = path.join(projectDir, "research", "A-NUSY-HYPOTHESIS-LIST.md");
  try {
    const content = await readFile(hypFile, "utf-8");
    // Extract active hypotheses (lines starting with "- [ ]" or "| H-")
    const active = content
      .split("\n")
      .filter((l) => l.match(/^\|?\s*H-\d+/) || l.match(/^- \[ \]/))
      .slice(0, 10);
    return active;
  } catch {
    return [];
  }
}

/**
 * Gather all fleet context in parallel.
 */
export async function gatherFleetContext(projectDir, cachedFleetStatus) {
  const [kanban, fleet, acf, hypotheses] = await Promise.all([
    getKanbanState(projectDir),
    getFleetHealth(),
    getAcfHistory(projectDir),
    getHypotheses(projectDir),
  ]);

  return {
    kanban,
    fleet: cachedFleetStatus || fleet,
    acf,
    hypotheses,
  };
}

// ─── Claude Reasoning (Phase 2) ────────────────────────────────────────────

/**
 * Format gathered context into a Claude API prompt.
 */
function formatContext(context) {
  const sections = [];

  // Kanban
  const { backlog, inProgress } = context.kanban;
  sections.push("## Kanban State");
  sections.push(`In-progress (${inProgress.length}):`);
  for (const item of inProgress) {
    sections.push(`  - ${item.id}: ${item.title} [${item.priority}] assigned=${item.assignee || "none"}`);
  }
  sections.push(`Backlog (${backlog.length}):`);
  for (const item of backlog.slice(0, 15)) {
    sections.push(`  - ${item.id}: ${item.title} [${item.priority}] tags=${(item.tags || []).join(",")}`);
  }

  // Fleet
  sections.push("\n## Fleet Health");
  sections.push(`Active tmux sessions: ${context.fleet.tmuxSessions?.length || 0}`);
  for (const s of (context.fleet.tmuxSessions || []).slice(0, 10)) {
    sections.push(`  - ${s}`);
  }
  sections.push(`Open PRs: ${context.fleet.openPRs?.length || 0}`);
  for (const pr of (context.fleet.openPRs || []).slice(0, 5)) {
    sections.push(`  - #${pr.number}: ${pr.title} (${pr.headRefName})`);
  }
  sections.push(`Agents busy: ${context.fleet.agentsBusy || 0}, available: ${context.fleet.agentsAvailable || 0}`);

  // ACF
  if (context.acf.length > 0) {
    sections.push("\n## Recent ACF Scores");
    for (const entry of context.acf) {
      sections.push(`  - ${entry.file}: ${JSON.stringify(entry).substring(0, 200)}`);
    }
  }

  // Hypotheses
  if (context.hypotheses.length > 0) {
    sections.push("\n## Active Hypotheses");
    for (const h of context.hypotheses) {
      sections.push(`  ${h}`);
    }
  }

  return sections.join("\n");
}

/**
 * Call Claude API to reason about priorities and generate proposals.
 */
async function generateProposals(context, { reasoningModel, anthropicApiKey }) {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const userContent = formatContext(context);

  const response = await client.messages.create({
    model: reasoningModel,
    max_tokens: 2048,
    system: BOSUN_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content[0].text;
  return parseProposals(text);
}

/**
 * Parse Claude's response into structured proposals.
 * Handles both JSON and markdown-wrapped JSON.
 */
export function parseProposals(text) {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(text);
    return {
      proposals: parsed.proposals || [],
      reasoning: parsed.reasoning || "",
      fleetSummary: parsed.fleet_summary || "",
    };
  } catch {
    // Try extracting JSON from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          proposals: parsed.proposals || [],
          reasoning: parsed.reasoning || "",
          fleetSummary: parsed.fleet_summary || "",
        };
      } catch {
        // Fall through
      }
    }

    return { proposals: [], reasoning: text, fleetSummary: "" };
  }
}

// ─── Main Export ────────────────────────────────────────────────────────────

/**
 * Run a complete morning scan: gather → reason → return proposals.
 */
export async function runMorningScan({ projectDir, reasoningModel, anthropicApiKey, machineName, fleetStatus }) {
  // Phase 1: Gather
  const context = await gatherFleetContext(projectDir, fleetStatus);

  // Phase 2: Reason
  let result;
  if (anthropicApiKey) {
    result = await generateProposals(context, { reasoningModel, anthropicApiKey });
  } else {
    // No API key — return raw context for manual review
    result = {
      proposals: context.kanban.backlog.slice(0, 3).map((item) => ({
        exp: item.id,
        title: item.title,
        priority: item.priority,
        agent: machineName,
        reasoning: "Auto-picked from backlog (no API key for reasoning)",
      })),
      reasoning: "No Anthropic API key — returning top backlog items without LLM reasoning",
      fleetSummary: `${context.kanban.inProgress.length} in-progress, ${context.kanban.backlog.length} in backlog`,
    };
  }

  return {
    proposals: result.proposals,
    reasoning: result.reasoning,
    fleetState: {
      agents_busy: context.fleet.agentsBusy || 0,
      agents_available: context.fleet.agentsAvailable || 0,
      wip_count: context.kanban.inProgress.length,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function tryParseJSON(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function parseSimpleFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split("\n")) {
    if (line.trim().startsWith("@prefix") || line.trim().startsWith("<")) continue;
    const kv = line.split(":", 2);
    if (kv.length === 2) {
      const key = kv[0].trim();
      let val = kv[1].trim().replace(/^["']|["']$/g, "");
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      }
      fm[key] = val;
    }
  }
  return fm;
}
