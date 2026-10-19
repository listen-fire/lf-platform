import expressWinston from 'express-winston';
import winston from 'winston';

import { formatEngineLogLine, jsonLogsEnabled, type EngineLogLevel } from 'movement-engine/public/log';
import { HEALTH_CHECK_ENDPOINT } from '../../constants';

function engineLevel(raw: unknown): EngineLogLevel {
  const levels: readonly EngineLogLevel[] = ['error', 'warn', 'info', 'debug'];
  return levels.find((level) => level === raw) ?? 'info';
}

// The server's winston logger: request lines (express-winston needs a winston
// transport) and a process-killing exception, printed in exactly the engine
// logger's line format so the server's output reads as one stream.
const serverLogger = winston.createLogger({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  transports: [new winston.transports.Console({ handleExceptions: true })],
  format: winston.format.printf((info) => {
    const { level: _level, message, splat: _splat, ...meta } = info;
    return formatEngineLogLine({
      level: engineLevel(info[Symbol.for('level')]),
      message: typeof message === 'string' ? message : String(message),
      meta,
    });
  }),
});

/**
 * Logs request informat
 *
 * NOTE: the CF-Connecting-IP will list the real client IP since Render is behind Cloudflare
 */
const expressLogger = expressWinston.logger({
  transports: [serverLogger],
  meta: true,
  colorize: !jsonLogsEnabled,
  msg: '{{req.get("CF-Connecting-IP")}} {{req.method}} {{res.statusCode}} {{req.url}} {{req.body.query?.split(" ")[0]}} {{req.body.operationName}}  {{res.responseTime}}ms',
  requestWhitelist: ['ip'],
  ignoredRoutes: [HEALTH_CHECK_ENDPOINT],
});

export { expressLogger };
