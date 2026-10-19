// The engine's logger, and the way an embedder takes its lines. By default
// they go to the console as before; `routeEngineLogsTo` replaces that with the
// embedder's own sink (the CLI's output, a test's capture, the hosted
// product's logging library) without touching the code that logs.

import { setEngineLogHook, type EngineLogHook } from '../services/logger';

export {
  consoleLogHook,
  formatEngineLogLine,
  jsonLogsEnabled,
  logger,
  type EngineLogger,
  type EngineLogHook,
  type EngineLogLevel,
  type EngineLogLine,
} from '../services/logger';
// The request context id each line carries, read from the shell's own context.
export * from '../services/context/current_id';

/** What `routeEngineLogsTo` hands each line to. */
export type EngineLogSink = EngineLogHook;

/** Send every engine log line to `sink` instead of the console. Returns a
 *  function that puts the previous hook back. */
export function routeEngineLogsTo(sink: EngineLogHook): () => void {
  return setEngineLogHook(sink);
}
