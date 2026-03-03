/**
 * @noesis-ship/shared — Shared utilities for noesis-ship packages
 */

const { loadConfig } = require("./config");
const { connectNATS, publishJSON, decodeJSON, sc } = require("./nats-helpers");
const {
  buildMessage,
  buildKanbanEvent,
  isFromSelf,
  isFromHuman,
  isDirectedTo,
  isFromAgent,
  channelSubject,
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
  isFromSelf,
  isFromHuman,
  isDirectedTo,
  isFromAgent,
  channelSubject,
};
