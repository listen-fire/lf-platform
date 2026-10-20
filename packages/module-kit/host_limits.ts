// The limits door, asked by `ctx.fetch` so a module author never thinks of
// it: before each request to the provider the module asks the host "may I
// call now?", waits as long as the host says, releases the permit once the
// answer is in, and reports a 429 (with its Retry-After) as a throttle. One
// call to the module can become several provider requests and retries; each
// is counted, and the module never sees a counter. A host that hands no door
// on the call (a platform loading the module in process, an embedder, a host
// that counts the call itself) leaves `ctx.fetch` as it is.

import { HostLimitGrant, type HostLimitRequestShape, type WireHostLimitsDoorShape } from 'engine-contracts';

/** How long a 429 without a usable Retry-After quiets the provider. */
export const DEFAULT_THROTTLE_MS = 1000;

export interface LimitedFetchOptions {
  /** Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Default: `Date.now`, for an HTTP-date Retry-After. */
  now?: () => number;
}

/** `fetch` asking `door` before each request; `fetch` itself without one. */
export function limitedFetch(fetchImpl: typeof fetch, door: WireHostLimitsDoorShape | undefined, options: LimitedFetchOptions = {}): typeof fetch {
  if (door === undefined) return fetchImpl;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const doorOrigin = new URL(door.url).origin;
  const ask = async (question: HostLimitRequestShape): Promise<unknown> => {
    const response = await fetchImpl(door.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${door.ticket}` },
      body: JSON.stringify(question),
    });
    if (!response.ok) throw new Error(`the host's limits door answered ${response.status}: ${await response.text()}`);
    return response.json();
  };
  const acquire = async (): Promise<string> => {
    for (;;) {
      const grant = HostLimitGrant.parse(await ask({ op: 'acquire' }));
      if (grant.outcome === 'granted') return grant.permit;
      await sleep(grant.retryAfterMs);
    }
  };
  return async (input, init) => {
    // The host's own doors and files are not the provider.
    if (new URL(requestUrl(input)).origin === doorOrigin) return fetchImpl(input, init);
    const permit = await acquire();
    try {
      const response = await fetchImpl(input, init);
      // Before the release, so a request waiting on this permit sees the quiet.
      if (response.status === 429) await ask({ op: 'throttle', retryAfterMs: retryAfterMs(response.headers.get('retry-after'), now()) });
      return response;
    } finally {
      // A permit left held is freed by the host when the call answers.
      await ask({ op: 'release', permit }).catch(() => undefined);
    }
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** A Retry-After header (seconds, or an HTTP date) in milliseconds from `now`. */
export function retryAfterMs(header: string | null, now: number): number {
  if (header === null || header.trim() === '') return DEFAULT_THROTTLE_MS;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? DEFAULT_THROTTLE_MS : Math.max(0, at - now);
}
