/**
 * Noesis Ship — Wire Protocol
 *
 * Message format constants and builder functions.
 * All noesis-ship components use this shared wire protocol.
 *
 * @noesis-ship/shared
 */

/**
 * Build a channel message payload.
 * @param {object} opts
 * @param {string} opts.group - Channel group (e.g., "session:active", "fleet")
 * @param {string} opts.from - Sender display name
 * @param {string} opts.fromId - Sender identifier (e.g., "carclaw:user", "agent:m5")
 * @param {string} opts.message - Message text
 * @param {string} [opts.to] - Directed recipient (e.g., "Mini", "DGX")
 * @returns {object} Wire protocol message
 */
function buildMessage({ group, from, fromId, message, to }) {
  const payload = {
    type: "message",
    group: group || "session:active",
    from,
    fromId,
    message,
    timestamp: new Date().toISOString(),
    sessionMessage: true,
  };
  if (to) payload.to = to;
  return payload;
}

/**
 * Build a kanban event payload.
 * @param {string} event - Event type (e.g., "moved", "assigned", "created")
 * @param {object} item - Kanban item ({ id, title, status, assignee })
 * @param {string} repo - Repository name
 * @returns {object} Kanban event payload
 */
function buildKanbanEvent(event, item, repo) {
  return {
    type: "kanban_event",
    event,
    item,
    repo,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check if a message is from the specified agent (case-insensitive).
 * @param {object} msg - Wire protocol message
 * @param {string} agentName - Agent name to check
 * @returns {boolean}
 */
function isFromSelf(msg, agentName) {
  return msg.from && msg.from.toLowerCase() === agentName.toLowerCase();
}

/**
 * Check if a message is from a human user.
 * @param {object} msg - Wire protocol message
 * @returns {boolean}
 */
function isFromHuman(msg) {
  return msg.fromId === "carclaw:user";
}

/**
 * Check if a message is directed to a specific agent.
 * @param {object} msg - Wire protocol message
 * @param {string} agentName - Agent name
 * @returns {boolean}
 */
function isDirectedTo(msg, agentName) {
  return msg.to && msg.to.toLowerCase() === agentName.toLowerCase();
}

/**
 * Check if a message is from an agent (any agent).
 * @param {object} msg - Wire protocol message
 * @returns {boolean}
 */
function isFromAgent(msg) {
  return msg.fromId && msg.fromId.startsWith("agent:");
}

/**
 * NATS subject for a channel group.
 * @param {string} group - Channel group name
 * @returns {string} NATS subject
 */
function channelSubject(group) {
  return `ship.channel.${group}`;
}

/**
 * NATS subject for fleet alerts.
 */
const FLEET_ALERT_SUBJECT = "ship.fleet.alert";

/**
 * Build a fleet alert payload.
 * @param {string} alertType - Alert type (e.g., "pr_created", "ci_failed", "agent_stuck")
 * @param {object} payload - Alert-specific data
 * @returns {object} Fleet alert payload
 */
function buildFleetAlert(alertType, payload) {
  return {
    type: "fleet_alert",
    alertType,
    timestamp: new Date().toISOString(),
    ...payload,
  };
}

/**
 * Get the NATS subject for fleet alerts.
 * @returns {string} NATS subject
 */
function fleetAlertSubject() {
  return FLEET_ALERT_SUBJECT;
}

module.exports = {
  buildMessage,
  buildKanbanEvent,
  buildFleetAlert,
  isFromSelf,
  isFromHuman,
  isDirectedTo,
  isFromAgent,
  channelSubject,
  fleetAlertSubject,
  FLEET_ALERT_SUBJECT,
};
