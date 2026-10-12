import pino from 'pino';
import { config, SERVER_NAME, SERVER_VERSION, BUILD_SHA } from '../config.js';

/**
 * Structured JSON to stderr. stdout is reserved: the stdio transport speaks
 * JSON-RPC there, and a stray log line corrupts the stream.
 */
export const logger = pino(
  {
    level: config.logLevel,
    base: { svc: SERVER_NAME, version: SERVER_VERSION, sha: BUILD_SHA },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2),
);

export type Logger = pino.Logger;

/** One child logger per tool call, so every line is greppable by request_id. */
export const callLogger = (requestId: string, tool: string): Logger =>
  logger.child({ request_id: requestId, tool });
