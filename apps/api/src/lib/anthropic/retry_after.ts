import { SECOND } from '../../constants';

const MIN_DELAY = 1 * SECOND;
const MAX_DELAY = 120 * SECOND;

function clamp(ms: number): number {
  return Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(ms)));
}

/** `Retry-After` is either whole seconds or an HTTP date. */
function fromHeaderValue(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * SECOND;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : date - now;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  if ('get' in headers && typeof headers.get === 'function') {
    const value: unknown = headers.get(name);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Google's `google.rpc.RetryInfo` detail: `"retryDelay": "17s"` (or
 * `"17.5s"`) on the wire, `{ seconds: 17 }` in a decoded form. The genai SDK's
 * `ApiError` carries the JSON body only as text in its message.
 */
function fromRetryInfo(text: string): number | undefined {
  const quoted = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  if (quoted) return Number(quoted[1]) * SECOND;
  const object = /"retryDelay"\s*:\s*\{\s*"seconds"\s*:\s*"?(\d+)"?/.exec(text);
  return object ? Number(object[1]) * SECOND : undefined;
}

/**
 * How long the vendor asked a rate-limited caller to wait, or undefined when
 * it did not say. Clamped to [1s, 120s] so a hostile or absurd value can
 * neither spin nor stall a queue slot.
 */
export function rateLimitDelayMs(e: unknown, now: number = Date.now()): number | undefined {
  const headers = typeof e === 'object' && e !== null && 'headers' in e ? e.headers : undefined;
  const header = readHeader(headers, 'retry-after');
  const fromHeader = header === undefined ? undefined : fromHeaderValue(header, now);
  if (fromHeader !== undefined) return clamp(fromHeader);

  const text = e instanceof Error ? e.message : undefined;
  const fromBody = text === undefined ? undefined : fromRetryInfo(text);
  return fromBody === undefined ? undefined : clamp(fromBody);
}
