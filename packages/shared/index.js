/**
 * @noesis-ship/shared — Shared utilities for noesis-ship packages
 */

const { loadConfig } = require("./config");
const { connectNATS, publishJSON, decodeJSON, sc } = require("./nats-helpers");
const {
  buildMessage,
  buildKanbanEvent,
  buildFleetAlert,
  buildFleetStatus,
  isFromSelf,
  isFromHuman,
  isDirectedTo,
  isFromAgent,
  channelSubject,
  fleetAlertSubject,
  FLEET_ALERT_SUBJECT,
  FLEET_STATUS_SUBJECT,
} = require("./wire-protocol");

module.exports = {
  // Config
  loadConfig,
  // NATS
  connectNATS,
  publishJSON,
  decodeJSON,
  sc,
  // Wire protocol
  buildMessage,
  buildKanbanEvent,
  buildFleetAlert,
  buildFleetStatus,
  isFromSelf,
  isFromHuman,
  isDirectedTo,
  isFromAgent,
  channelSubject,
  fleetAlertSubject,
  FLEET_ALERT_SUBJECT,
  FLEET_STATUS_SUBJECT,
};
