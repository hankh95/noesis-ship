/**
 * Noesis Ship — NATS Connection Helpers
 *
 * Shared NATS connection factory and utilities used by all packages.
 *
 * @noesis-ship/shared
 */

const { connect, StringCodec } = require("nats");

const sc = StringCodec();

/**
 * Connect to NATS with standard error handling and status monitoring.
 * @param {string} url - NATS server URL
 * @param {string} label - Component label for logging (e.g., "Relay", "Daemon")
 * @param {function} [logFn] - Optional logging function (default: console.log)
 * @returns {Promise<{nc: NatsConnection, sc: StringCodec} | null>} Connection or null if failed
 */
async function connectNATS(url, label, logFn) {
  const log = logFn || ((msg) => console.log(`[NATS:${label}] ${msg}`));

  try {
    log(`Connecting to ${url}...`);
    const nc = await connect({ servers: url });
    log(`Connected to ${nc.getServer()}`);

    // Monitor connection status
    (async () => {
      for await (const status of nc.status()) {
        log(`Status: ${status.type}: ${status.data}`);
      }
    })();

    return { nc, sc };
  } catch (err) {
    log(`Connection failed: ${err.message}`);
    return null;
  }
}

/**
 * Publish a JSON message to a NATS subject with origin tagging.
 * @param {NatsConnection} nc - NATS connection
 * @param {string} subject - NATS subject
 * @param {object} payload - Message payload
 * @param {string} origin - Origin machine name (for echo prevention)
 */
function publishJSON(nc, subject, payload, origin) {
  const tagged = { ...payload, origin };
  nc.publish(subject, sc.encode(JSON.stringify(tagged)));
}

/**
 * Decode a NATS message to a JSON object.
 * @param {NatsMsg} msg - NATS message
 * @returns {object} Parsed JSON
 */
function decodeJSON(msg) {
  return JSON.parse(sc.decode(msg.data));
}

module.exports = { connectNATS, publishJSON, decodeJSON, sc };
