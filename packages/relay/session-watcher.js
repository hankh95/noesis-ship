/**
 * Claude Code Session Watcher
 *
 * Tails the active Claude Code conversation .jsonl file and streams
 * user/assistant messages to WebSocket clients. This turns CarClaw
 * into a mobile companion for Claude Code sessions.
 *
 * Configuration (env):
 *   CLAUDE_SESSION_DIR  — Path to Claude project dir (e.g. ~/.claude/projects/-Users-...)
 *   MACHINE_NAME        — Display name for this machine's agent (e.g. "M5", "DGX", "Mini")
 */

const fs = require("fs");
const path = require("path");

const HISTORY_LIMIT = 30; // Send last N conversation messages on client connect
const POLL_INTERVAL = 500; // Check for new lines every 500ms

class SessionWatcher {
  constructor({ sessionDir, machineName, groupId, broadcastFn }) {
    this.sessionDir = sessionDir;
    this.machineName = machineName || "Claude";
    this.groupId = groupId || "";
    this.broadcast = broadcastFn;
    this.activeFile = null;
    this.filePosition = 0;
    this.poller = null;
    this.dirWatcher = null;
    this.recentMessages = [];
  }

  start() {
    if (!this.sessionDir || !fs.existsSync(this.sessionDir)) {
      console.log(
        `[SessionWatcher] Disabled — dir not found: ${this.sessionDir || "(not set)"}`
      );
      return false;
    }

    this.activeFile = this.findActiveSession();
    if (!this.activeFile) {
      console.log("[SessionWatcher] No active session found");
      return false;
    }

    const sessionId = path.basename(this.activeFile, ".jsonl").substring(0, 8);
    console.log(
      `[SessionWatcher] Watching session ${sessionId}... as "${this.machineName}"`
    );

    // Load history and set file position
    this.loadHistory();

    // Start tailing for new lines
    this.startPolling();

    // Watch directory for new sessions
    this.watchDirectory();

    return true;
  }

  /** Find the most recently modified .jsonl in the session dir */
  findActiveSession() {
    try {
      const files = fs
        .readdirSync(this.sessionDir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(path.sep))
        .map((f) => {
          const fullPath = path.join(this.sessionDir, f);
          return { path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return files[0]?.path || null;
    } catch (err) {
      console.error("[SessionWatcher] Error finding session:", err.message);
      return null;
    }
  }

  /** Parse a .jsonl line into a bridge message (or null to skip) */
  parseLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }

    if (obj.type === "user") {
      const text = this.extractText(obj.message?.content);
      if (!text) return null;

      // Strip system-reminder blocks
      const clean = text
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .trim();
      if (!clean) return null;

      return {
        type: "message",
        group: this.groupId,
        from: "You",
        fromId: "session:user",
        message: clean,
        direction: "outbound",
        messageId: obj.uuid || undefined,
        timestamp: obj.timestamp,
        sessionMessage: true,
      };
    }

    if (obj.type === "assistant") {
      const text = this.extractText(obj.message?.content);
      if (!text) return null;

      return {
        type: "message",
        group: this.groupId,
        from: this.machineName,
        fromId: `session:${this.machineName.toLowerCase()}`,
        message: text,
        messageId: obj.uuid || undefined,
        timestamp: obj.timestamp,
        sessionMessage: true,
      };
    }

    return null; // Skip tool_use, tool_result, queue-operation, etc.
  }

  /** Extract text from a Claude message content array */
  extractText(content) {
    if (!Array.isArray(content)) return null;
    const texts = content
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    return texts.length > 0 ? texts.join("\n") : null;
  }

  /** Load recent messages from the .jsonl file */
  loadHistory() {
    try {
      const data = fs.readFileSync(this.activeFile, "utf8");
      const lines = data.split("\n").filter(Boolean);

      const messages = [];
      for (const line of lines) {
        const msg = this.parseLine(line);
        if (msg) messages.push(msg);
      }

      this.recentMessages = messages.slice(-HISTORY_LIMIT);
      this.filePosition = Buffer.byteLength(data, "utf8");

      console.log(
        `[SessionWatcher] Loaded ${this.recentMessages.length} messages from history`
      );
    } catch (err) {
      console.error("[SessionWatcher] Error loading history:", err.message);
    }
  }

  /** Send cached history to a specific WebSocket client */
  sendHistoryTo(ws) {
    for (const msg of this.recentMessages) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Poll the file for new appended lines */
  startPolling() {
    this.poller = setInterval(() => {
      try {
        const stats = fs.statSync(this.activeFile);
        if (stats.size <= this.filePosition) return;

        // Read new bytes
        const fd = fs.openSync(this.activeFile, "r");
        const buffer = Buffer.alloc(stats.size - this.filePosition);
        fs.readSync(fd, buffer, 0, buffer.length, this.filePosition);
        fs.closeSync(fd);

        this.filePosition = stats.size;
        const newData = buffer.toString("utf8");
        const lines = newData.split("\n").filter(Boolean);

        for (const line of lines) {
          const msg = this.parseLine(line);
          if (msg) {
            this.recentMessages.push(msg);
            this.broadcast(msg);
          }
        }

        // Keep buffer bounded
        if (this.recentMessages.length > HISTORY_LIMIT * 2) {
          this.recentMessages = this.recentMessages.slice(-HISTORY_LIMIT);
        }
      } catch {
        // File temporarily unavailable — skip this cycle
      }
    }, POLL_INTERVAL);
  }

  /** Watch directory for new session files */
  watchDirectory() {
    try {
      this.dirWatcher = fs.watch(this.sessionDir, (eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;

        const newActive = this.findActiveSession();
        if (newActive && newActive !== this.activeFile) {
          const sessionId = path
            .basename(newActive, ".jsonl")
            .substring(0, 8);
          console.log(`[SessionWatcher] Switched to session ${sessionId}...`);
          this.activeFile = newActive;
          this.loadHistory();

          // Broadcast history for new session
          for (const msg of this.recentMessages) {
            this.broadcast(msg);
          }
        }
      });
    } catch (err) {
      console.error("[SessionWatcher] Error watching directory:", err.message);
    }
  }

  stop() {
    if (this.poller) clearInterval(this.poller);
    if (this.dirWatcher) this.dirWatcher.close();
  }
}

module.exports = SessionWatcher;
