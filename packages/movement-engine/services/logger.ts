// The engine's logger: four levels, each line handed to ONE hook. The default
// hook prints to the console in the format the platform has always printed
// (text, coloured in development, or one JSON object per line under
// LOG_FORMAT=json). A shell replaces the hook to take the lines itself — the
// hosted product hands them to its own winston logger, the CLI to its output,
// a test to a capture — so the engine carries no logging library.

import stringify from 'safe-stable-stringify';

import { currentContextId } from './context/current_id';
import { errorAwareReplacer, jsonLogLine, logFormatFromEnv } from './log_format';

export type EngineLogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface EngineLogLine {
  level: EngineLogLevel;
  message: string;
  meta: Record<string, unknown>;
}

export type EngineLogHook = (line: EngineLogLine) => void;

const isDev = process.env.NODE_ENV === 'development';
const jsonLogsEnabled = logFormatFromEnv(process.env) === 'json';

const PRIORITY: Record<EngineLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold: EngineLogLevel = isDev ? 'debug' : 'info';

// Winston's default level colours, so a developer's terminal looks as before.
const COLOUR: Record<EngineLogLevel, number> = { error: 31, warn: 33, info: 32, debug: 34 };

/** The message as text: an object is shown as JSON, an Error as its message
 *  (its stack goes into the metadata, where the replacer keeps it). */
function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  return stringify(message, errorAwareReplacer, 2) ?? String(message);
}

/** One line as the console prints it: `level: [context] message {meta}`, or
 *  the JSON object under LOG_FORMAT=json. Exported so a shell that keeps its
 *  own logging library prints exactly the same lines. */
export function formatEngineLogLine(
  { level, message, meta }: EngineLogLine,
  { colour = isDev && !jsonLogsEnabled }: { colour?: boolean } = {},
): string {
  const contextId = currentContextId();
  if (jsonLogsEnabled) {
    return jsonLogLine({ level, message, timestamp: new Date(), contextId, meta });
  }
  const prefix = contextId === undefined ? '' : `[${isDev ? contextId.slice(0, 8) : contextId}] `;
  const shownLevel = colour ? `\u001b[${COLOUR[level]}m${level}\u001b[39m` : level;
  const rest = stringify(meta, errorAwareReplacer);
  return rest !== undefined && rest !== '{}'
    ? `${shownLevel}: ${prefix}${message} ${rest}`
    : `${shownLevel}: ${prefix}${message}`;
}

/** Prints to stdout, every level, as winston's console transport did. */
export const consoleLogHook: EngineLogHook = (line) => {
  process.stdout.write(`${formatEngineLogLine(line)}\n`);
};

let hook: EngineLogHook = consoleLogHook;

/** Send every engine log line to `next` instead. Returns a function that puts
 *  the previous hook back. */
export function setEngineLogHook(next: EngineLogHook): () => void {
  const previous = hook;
  hook = next;
  return () => {
    hook = previous;
  };
}

function emit(level: EngineLogLevel, message: unknown, meta?: unknown): void {
  if (PRIORITY[level] > PRIORITY[threshold]) return;
  const fields: Record<string, unknown> =
    meta !== null && typeof meta === 'object' && !Array.isArray(meta) && !(meta instanceof Error)
      ? Object.fromEntries(Object.entries(meta))
      : meta === undefined
        ? {}
        : { meta };
  if (message instanceof Error && fields.stack === undefined) fields.stack = message.stack;
  hook({ level, message: messageText(message), meta: fields });
}

export interface EngineLogger {
  error(message: unknown, meta?: unknown): void;
  warn(message: unknown, meta?: unknown): void;
  info(message: unknown, meta?: unknown): void;
  debug(message: unknown, meta?: unknown): void;
}

export const logger: EngineLogger = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
};

export { jsonLogsEnabled };
