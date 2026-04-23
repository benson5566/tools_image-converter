'use strict';

/**
 * Structured JSON logger.
 *
 * Outputs one JSON object per line to stdout (info) or stderr (error),
 * compatible with log aggregators (e.g. Datadog, Loki, CloudWatch).
 *
 * Usage:
 *   const { logger } = require('./utils/logger');
 *   logger.info('request', { method: 'POST', path: '/api/convert', status: 200, ip: '1.2.3.4' });
 *   logger.error('convert failed', { file: 'foo.png', reason: err.message, ip: '1.2.3.4' });
 */

/**
 * Serialise one log entry to a JSON line and write it to the given stream.
 *
 * @param {'info'|'error'} level
 * @param {string} message
 * @param {object} [meta={}]
 * @param {NodeJS.WriteStream} stream
 */
function _write(level, message, meta, stream) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  try {
    stream.write(JSON.stringify(entry) + '\n');
  } catch {
    // Fallback: if serialisation fails (e.g. circular refs), log minimal info
    stream.write(JSON.stringify({ timestamp: new Date().toISOString(), level, message }) + '\n');
  }
}

const logger = {
  /**
   * Log an informational message with optional metadata.
   *
   * @param {string} msg
   * @param {object} [meta={}]
   */
  info(msg, meta = {}) {
    _write('info', msg, meta, process.stdout);
  },

  /**
   * Log an error message with optional metadata.
   *
   * @param {string} msg
   * @param {object} [meta={}]
   */
  error(msg, meta = {}) {
    _write('error', msg, meta, process.stderr);
  },
};

module.exports = { logger };
