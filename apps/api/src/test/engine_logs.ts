// The engine's log lines in a test, taken through the engine's public sink
// (`routeEngineLogsTo`) rather than by mocking its logger module: a mock of
// the module reaches only the specifier it names, while the sink is where
// every line goes, whichever entry the code under test logged through.

import { routeEngineLogsTo, type EngineLogLevel, type EngineLogLine } from 'movement-engine/public/log';

export interface CapturedEngineLogs {
  /** Every line logged since this test began, in order. */
  lines(): readonly EngineLogLine[];
  error(): EngineLogLine[];
  warn(): EngineLogLine[];
  info(): EngineLogLine[];
  debug(): EngineLogLine[];
  /** The messages of the lines at `level` (every level when omitted). */
  messages(level?: EngineLogLevel): string[];
  /** Forget the lines captured so far, within a test. */
  clear(): void;
}

/** Capture the engine's log lines for each test of the enclosing `describe`
 *  (or file): a fresh capture before each test, the previous sink back after. */
export function captureEngineLogs(): CapturedEngineLogs {
  const captured: EngineLogLine[] = [];
  let restore: (() => void) | undefined;
  beforeEach(() => {
    captured.length = 0;
    restore = routeEngineLogsTo((line) => {
      captured.push(line);
    });
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });
  const at = (level: EngineLogLevel) => captured.filter((line) => line.level === level);
  return {
    lines: () => captured,
    error: () => at('error'),
    warn: () => at('warn'),
    info: () => at('info'),
    debug: () => at('debug'),
    messages: (level) => (level === undefined ? captured : at(level)).map((line) => line.message),
    clear: () => {
      captured.length = 0;
    },
  };
}

/** Drop every engine log line: the default for a test file, so a run of the
 *  suites is quiet unless a test captures the lines it asserts on. */
export function silenceEngineLogs(): () => void {
  return routeEngineLogsTo(() => {});
}
