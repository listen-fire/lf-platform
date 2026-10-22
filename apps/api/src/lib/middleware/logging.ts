import expressWinston from 'express-winston';
import winston from 'winston';

import type { RequestHandler } from 'express';

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

/** Query parameters that carry an OAuth sign-in in flight: a provider's
 *  redirect to a callback route (the platform's connect flows, lf's relay). */
const SIGN_IN_PARAMETERS = ['code', 'state'];

/** A request's URL as the log writes it: one carrying a sign-in's `code` or
 *  `state` loses its whole query, so the log never holds an authorization
 *  code or the state that would redeem it. */
function loggedUrl(url: string): string {
  const at = url.indexOf('?');
  if (at === -1) return url;
  const query = new URLSearchParams(url.slice(at + 1));
  return SIGN_IN_PARAMETERS.some((name) => query.has(name)) ? `${url.slice(0, at)}?[redacted]` : url;
}

/**
 * Logs request informat
 *
 * NOTE: the CF-Connecting-IP will list the real client IP since Render is behind Cloudflare
 */
const requestLogger = expressWinston.logger({
  transports: [serverLogger],
  meta: true,
  colorize: !jsonLogsEnabled,
  // The URL comes from `res.locals.loggedUrl`, never `req.url`. A `msg` function
  // is no way round it: express-winston compiles a function's output as a
  // template again whenever it contains `{{`, which a URL can.
  msg: '{{req.get("CF-Connecting-IP")}} {{req.method}} {{res.statusCode}} {{res.locals.loggedUrl}} {{req.body.query?.split(" ")[0]}} {{req.body.operationName}}  {{res.responseTime}}ms',
  requestWhitelist: ['ip'],
  ignoredRoutes: [HEALTH_CHECK_ENDPOINT],
});

const expressLogger: RequestHandler = (req, res, next) => {
  res.locals.loggedUrl = loggedUrl(req.originalUrl);
  requestLogger(req, res, next);
};

export { expressLogger, loggedUrl };
