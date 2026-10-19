import stringify from "safe-stable-stringify";

/** Cloud Logging's severity names; `severity` is the field it reads the level from. */
type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

type LogFormat = "text" | "json";

const SEVERITY_BY_LEVEL: Record<string, Severity> = {
  error: "ERROR",
  warn: "WARNING",
  info: "INFO",
  http: "INFO",
  verbose: "DEBUG",
  debug: "DEBUG",
  silly: "DEBUG",
};

/** `LOG_FORMAT` unset is the human-readable format; anything but the two names is a typo worth failing on. */
function logFormatFromEnv(env: Record<string, string | undefined>): LogFormat {
  const raw = env.LOG_FORMAT;
  if (raw === undefined || raw === "" || raw === "text") return "text";
  if (raw === "json") return "json";
  throw new Error(`LOG_FORMAT must be "text" or "json", got "${raw}"`);
}

/**
 * `level` is the winston level name, which dev colouring may have wrapped in
 * escape codes, so callers pass the uncoloured one. A process-killing
 * exception is logged by winston at `error` with `exception: true`; Cloud
 * Logging has a level above ERROR for exactly that.
 */
function severityOf(
  level: string,
  { fatal = false }: { fatal?: boolean } = {},
): Severity {
  if (fatal) return "CRITICAL";
  return SEVERITY_BY_LEVEL[level] ?? "INFO";
}

const errorAwareReplacer = (_: string, value: unknown) => {
  if (value instanceof Error) {
    return {
      ...value,
      message: value.message,
      stack: value.stack,
      // @ts-ignore
      trace: value.trace,
    };
  }
  return value;
};

interface JsonLogInput {
  level: string;
  message: unknown;
  timestamp: Date;
  contextId?: string;
  meta: Record<string, unknown>;
}

/**
 * One log line as a single JSON object. The reserved keys are written last so
 * a caller's metadata can never shadow `severity`, `message` or `timestamp`.
 * Metadata goes through the same Error-aware stringifier as the text format,
 * so what a line already carries is unchanged and nothing new is revealed.
 */
function jsonLogLine({
  level,
  message,
  timestamp,
  contextId,
  meta,
}: JsonLogInput): string {
  const { exception, ...rest } = meta;
  return (
    stringify(
      {
        ...rest,
        ...(contextId === undefined ? {} : { contextId }),
        severity: severityOf(level, { fatal: exception === true }),
        message:
          typeof message === "string"
            ? message
            : stringify(message, errorAwareReplacer) ?? String(message),
        timestamp: timestamp.toISOString(),
      },
      errorAwareReplacer,
    ) ?? "{}"
  );
}

export { errorAwareReplacer, jsonLogLine, logFormatFromEnv, severityOf };
export type { LogFormat, Severity };
