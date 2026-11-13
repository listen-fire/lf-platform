import { z } from 'zod';

import { SECOND } from '../constants';
import { Prompt } from '../lib/prompts';
import { anthropicChat } from '../lib/anthropic';
import { getEnvVar } from '../lib/utils/environment';
import { neverAsAny } from 'movement-engine/public/types';
import { logger } from 'movement-engine/public/log';
import {
  limitRequest,
  limited,
  limiterSlot,
  throttleAfter,
  vendorWaitMs,
  type Caller,
  type Limiter,
} from 'movement-engine/public/limiter';
// Tavily is a legacy-only supplementary search (no DPA) — gated per-caller via
// `allowSupplementaryWebSearch`, which only the legacy pipelines pass.
import { webSearch as tavilySearch, isAvailable as tavilyAvailable } from '../lib/web_search';

// Google is discontinuing "search the entire web" in Programmable Search on
// 2027-01-01. Bright Data's SERP API returns Google's own results as JSON —
// same ranking, different transport — so it stands in as a second provider
// rather than a different search engine. Default stays `google` so an
// unset variable reproduces today's behaviour exactly.
export type WebSearchProvider = 'google' | 'brightdata';

export function resolveWebSearchProvider(env: NodeJS.ProcessEnv = process.env): WebSearchProvider {
  const value = env.WEB_SEARCH_PROVIDER ?? 'google';
  if (value === 'google' || value === 'brightdata') return value;
  throw new Error(
    `WEB_SEARCH_PROVIDER must be "google" or "brightdata" (got "${value}")`,
  );
}

// The SERP zone is provisioned separately from the Web Unlocker zone the page
// scraper uses (see scraper.ts's `missingBrightDataVars`) — a Bright Data
// account keeps one zone per product. The access token is shared.
function missingBrightDataSerpVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['BRIGHT_DATA_ACCESS_TOKEN', 'BRIGHT_DATA_SERP_ZONE'].filter((name) => !env[name]);
}

// SERP JSON is a few KB; these only guard a runaway or hung request, mirroring
// the ceilings scraper.ts holds a page fetch to. Against a live SERP zone,
// successful replies have arrived after as long as 65s, so the ceiling sits
// well past that rather than cutting off slow-but-good answers.
const BRIGHT_DATA_SERP_TIMEOUT = 90 * SECOND;
const MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES = 1 * 1024 * 1024;

// A zone that times out, rate-limits or returns an empty body on one call
// usually answers the same query moments later; three tries covers that
// without turning one search into minutes of waiting.
const BRIGHT_DATA_SERP_MAX_ATTEMPTS = 3;
// A 429 (from the gateway or from Bright Data) asks us to slow down; retrying
// sooner only extends the limit. This is the least it closes the zone for when
// Bright Data names no wait of its own.
const BRIGHT_DATA_SERP_RATE_LIMIT_RETRY_DELAY = 30 * SECOND;

// Verified against https://docs.brightdata.com/scraping-automation/serp-api/
// (2026-09-18): POST the target Google search URL through the SERP zone with
// `brd_json=1` in the query string, and the reply is Google's own parsed
// result set. Only the fields the callers below actually read are declared;
// everything else (`general`, `people_also_ask`, `knowledge`, …) passes
// through unparsed. `extensions` is a bonus on top of a result, so one the
// provider reshaped is dropped rather than costing the whole search.
const BrightDataSerpOrganicResult = z.object({
  link: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  extensions: z
    .array(z.object({ type: z.string().nullish(), text: z.string().nullish() }).catch({}))
    .nullish()
    .catch(null),
});

/** Google's extensions often read "location · role · organisation", which the
 *  description leaves out. They go first so that whoever clips a long snippet
 *  keeps them and loses the free text. Only the plain text kind is carried: a
 *  sitelink's text is a navigation label pointing at another page, not
 *  something the result says about its subject. Text the description already
 *  holds would only repeat itself in every prompt, so it is left out. This is
 *  what the web module's standalone search does. */
function snippetOf(hit: z.infer<typeof BrightDataSerpOrganicResult>): string | undefined {
  const description = hit.description ?? '';
  const extensions: string[] = [];
  for (const extension of hit.extensions ?? []) {
    const text = extension.type === 'text' ? extension.text?.trim() : undefined;
    if (!text || extensions.includes(text)) continue;
    if (description.toLowerCase().includes(text.toLowerCase())) continue;
    extensions.push(text);
  }
  if (extensions.length === 0) return hit.description;
  return [...extensions, ...(description ? [description] : [])].join(' · ');
}
const BrightDataSerpResponseShape = z.object({
  organic: z.array(BrightDataSerpOrganicResult),
});

/** Maps a parsed Bright Data reply onto the same `Search` shape the Google
 *  provider returns, so callers don't change. An `organic` array — even an
 *  empty one — is Google's own answer of "nothing found"; anything else
 *  (the key missing, the wrong type, an error envelope) is a shape this
 *  code doesn't understand, and fails rather than reading as "no results". */
function mapBrightDataSerpResponse(raw: unknown): Search {
  const parsed = BrightDataSerpResponseShape.safeParse(raw);
  if (!parsed.success) {
    const topLevelKeys =
      typeof raw === 'object' && raw !== null ? Object.keys(raw) : [];
    throw new Error(
      `Bright Data SERP response did not have the expected shape (top-level keys: ${
        topLevelKeys.length ? topLevelKeys.join(', ') : 'none'
      })`,
    );
  }

  const items: SearchResult[] = parsed.data.organic.map((hit) => ({
    link: hit.link,
    title: hit.title,
    snippet: snippetOf(hit),
  }));

  return { items };
}

/** The response body, read as a stream and abandoned at the cap — mirrors
 *  scraper.ts's `readCappedBytes`, sized down for a JSON reply rather than a
 *  whole page. */
async function readCappedText(response: Response): Promise<string> {
  if (!response.body) return response.text();

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (received < MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks, Math.min(received, MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES)).toString(
    'utf8',
  );
}

// ── Pacing ─────────────────────────────────────────────────────────────────
//
// Bright Data throttles a SERP zone per target host once its success rate
// drops, and says so with a 429 naming the rate it will accept ("Please
// decrease your request rate to 14/min", measured in production). Sending
// faster than that does not get answers sooner: every refused request costs a
// 30-second wait and one of three attempts, and keeps the success rate low.
// So requests wait their turn here instead of being sent and refused.
//
// A zone under load fails in other ways too (a 5xx, a timeout, an empty or
// malformed body), and about 30% of searches did in production. A lone failure
// is as likely chance as trouble, so only that search waits before its retry.
// Failures in a row mean the zone is struggling: it closes for every process,
// for longer the more follow, so it gets room to recover instead of more
// searches piling on. A 429 is Bright Data asking us to slow down, so it always
// closes the zone.

const BRIGHT_DATA_SERP_CALLER = 'bright-data/serp';

// With about 30% of searches failing, closing the zone on every failure would
// keep it closed most of the time; two in a row is rare enough by chance to
// mean trouble.
const FAILURES_IN_A_ROW_THAT_CLOSE_THE_ZONE = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How the zone is paced, read from the environment at each search. */
export interface BrightDataSerpPacing {
  perMinute: number;
  concurrent: number;
  /** The pause after a first failure, and after the second in a row; each further failure in a row doubles it. */
  backoffBaseMs: number;
  /** The longest pause; failures past it stay at it. */
  backoffMaxMs: number;
  /** How far, as a fraction of the pause, it may land either side of the curve. */
  backoffJitter: number;
}

interface WholeNumberSetting {
  name: string;
  fallback: number;
  meaning: string;
}

const PER_MINUTE: WholeNumberSetting = {
  name: 'BRIGHT_DATA_SERP_PER_MINUTE',
  fallback: 14,
  meaning: 'how many Bright Data SERP requests all processes sharing the limiter may send per minute',
};
const CONCURRENT: WholeNumberSetting = {
  name: 'BRIGHT_DATA_SERP_CONCURRENT',
  fallback: 4,
  meaning: 'how many Bright Data SERP requests all processes sharing the limiter may have in flight at once',
};
const BACKOFF_BASE_MS: WholeNumberSetting = {
  name: 'BRIGHT_DATA_SERP_BACKOFF_BASE_MS',
  fallback: 15 * SECOND,
  meaning: 'how many milliseconds a first failed search waits, and the second in a row closes the zone for',
};
const BACKOFF_MAX_MS: WholeNumberSetting = {
  name: 'BRIGHT_DATA_SERP_BACKOFF_MAX_MS',
  fallback: 60 * SECOND,
  meaning: 'the most milliseconds failures in a row close the zone for',
};
const BACKOFF_JITTER = { name: 'BRIGHT_DATA_SERP_BACKOFF_JITTER', fallback: 0.2 };

/** The value, or the default when unset. Throws on a value that is set but is
 *  not a positive whole number — a typo here must not read as "no limit". */
function readWholeNumber(setting: WholeNumberSetting, env: NodeJS.ProcessEnv): number {
  const raw = env[setting.name];
  if (raw === undefined || raw.trim() === '') return setting.fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${setting.name}="${raw}" is not a positive whole number. ` +
        `Set it to ${setting.meaning} (e.g. ${setting.name}=${setting.fallback}), ` +
        `or leave it unset for the default of ${setting.fallback}.`,
    );
  }
  return value;
}

/** A spread of 1 or more could pause for nothing, so it stays below 1. */
function readJitter(env: NodeJS.ProcessEnv): number {
  const raw = env[BACKOFF_JITTER.name];
  if (raw === undefined || raw.trim() === '') return BACKOFF_JITTER.fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(
      `${BACKOFF_JITTER.name}="${raw}" is not a fraction from 0 up to, but not including, 1. ` +
        `Set it to how far each pause after a failed search may land either side of its doubling curve, ` +
        `as a fraction of the pause (e.g. ${BACKOFF_JITTER.name}=${BACKOFF_JITTER.fallback}), ` +
        `or leave it unset for the default of ${BACKOFF_JITTER.fallback}.`,
    );
  }
  return value;
}

export function brightDataSerpPacing(env: NodeJS.ProcessEnv = process.env): BrightDataSerpPacing {
  const backoffBaseMs = readWholeNumber(BACKOFF_BASE_MS, env);
  const backoffMaxMs = readWholeNumber(BACKOFF_MAX_MS, env);
  if (backoffMaxMs < backoffBaseMs) {
    throw new Error(
      `${BACKOFF_MAX_MS.name} (${backoffMaxMs}) is below ${BACKOFF_BASE_MS.name} (${backoffBaseMs}). ` +
        `The longest pause after failed searches must be at least the first one.`,
    );
  }
  return {
    perMinute: readWholeNumber(PER_MINUTE, env),
    concurrent: readWholeNumber(CONCURRENT, env),
    backoffBaseMs,
    backoffMaxMs,
    backoffJitter: readJitter(env),
  };
}

/** Boot: refuse a malformed setting rather than letting the first search find out. */
export function assertBrightDataSerpPacingConfigured(env: NodeJS.ProcessEnv = process.env): void {
  brightDataSerpPacing(env);
}

/** The zone's limits as the limiter slot holds them, so every process on the
 *  shared limiter shares one count of each. */
function brightDataSerpRequest(zone: string, pacing: BrightDataSerpPacing) {
  const caller: Caller = { module: BRIGHT_DATA_SERP_CALLER, install: zone, team: '' };
  return {
    caller,
    request: limitRequest(caller, [
      { scope: 'install', calls: pacing.perMinute, per: '1m' },
      { scope: 'install', concurrent: pacing.concurrent },
    ]),
  };
}

/** What one retryable failure costs, given `streak` failures in a row counting
 *  this one. The first waits the base; each further one doubles it from the
 *  threshold up to the ceiling, then the pause is spread either side by up to
 *  the jitter so processes that failed together don't retry together (at the
 *  ceiling too, for the same reason). Only a 429, or failures in a row, close
 *  the zone for everyone; a lone failure is only this search's wait. A 429
 *  waits at least what Bright Data asked for, or the rate limit default when it
 *  named nothing. */
function brightDataSerpPause(
  streak: number,
  failure: { rateLimited: boolean; retryAfterMs?: number },
  pacing: BrightDataSerpPacing,
): { ms: number; closesZone: boolean } {
  const doublings = Math.max(streak - FAILURES_IN_A_ROW_THAT_CLOSE_THE_ZONE, 0);
  const curve = Math.min(pacing.backoffBaseMs * 2 ** doublings, pacing.backoffMaxMs);
  const spread = curve * pacing.backoffJitter * (2 * Math.random() - 1);
  const ms = Math.round(curve + spread);
  if (failure.rateLimited) {
    return { ms: Math.max(ms, failure.retryAfterMs ?? BRIGHT_DATA_SERP_RATE_LIMIT_RETRY_DELAY), closesZone: true };
  }
  return { ms, closesZone: streak >= FAILURES_IN_A_ROW_THAT_CLOSE_THE_ZONE };
}

// The limiter keeps no count a caller can read back, so the run of failures
// lives in this process. The pause it sets still closes the zone for every
// process, and the limiter keeps the later of two throttles, so one process's
// shorter pause never cuts short another's longer one. Kept per limiter, so a
// limiter installed afresh starts with no failures.
const failureStreaks = new WeakMap<Limiter, Map<string, number>>();

function failureStreaksOn(limiter: Limiter): Map<string, number> {
  let streaks = failureStreaks.get(limiter);
  if (streaks === undefined) {
    streaks = new Map();
    failureStreaks.set(limiter, streaks);
  }
  return streaks;
}

// What one attempt observed, for the per-attempt log line. Every field but
// `durationMs` is absent when the fetch itself rejected.
type BrightDataSerpAttemptTrace = {
  durationMs: number;
  status?: number;
  brdStatus?: string | null;
  brdError?: string | null;
  // Bright Data's machine-readable reason (`sr_rate_limit`, `verifying`, …),
  // which tells apart failures whose human-readable message is the same.
  brdErrorCode?: string | null;
  bytes?: number;
};

type BrightDataSerpAttemptOutcome =
  | ({ ok: true; search: Search } & BrightDataSerpAttemptTrace)
  | ({
      ok: false;
      retryable: boolean;
      // Whether this failure was a 429 at either layer; the retry loop waits
      // longer before the next attempt when it was.
      rateLimited: boolean;
      // How long Bright Data asked us to wait, when it said (`Retry-After`).
      retryAfterMs?: number;
      reason: string;
      error: Error;
    } & BrightDataSerpAttemptTrace);

/** Classifies an HTTP-style status code as a failure: 429 and 5xx are the
 *  zone under load and worth retrying; any other 4xx is a bad token, a
 *  disabled zone or a malformed request, which no retry will fix. */
function classifyFailureStatus(code: number): { retryable: boolean; rateLimited: boolean } {
  return { retryable: code === 429 || code >= 500, rateLimited: code === 429 };
}

/** One round-trip against the SERP endpoint, classified into an outcome the
 *  retry loop in `searchBrightData` can act on. Never throws: a fetch that
 *  rejects outright comes back as a retryable failure too. */
async function performBrightDataSerpAttempt(
  searchUrl: URL,
): Promise<BrightDataSerpAttemptOutcome> {
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getEnvVar('BRIGHT_DATA_ACCESS_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        zone: getEnvVar('BRIGHT_DATA_SERP_ZONE'),
        url: searchUrl.toString(),
        format: 'raw',
      }),
      signal: AbortSignal.timeout(BRIGHT_DATA_SERP_TIMEOUT),
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
    return {
      ok: false,
      retryable: true,
      rateLimited: false,
      reason: timedOut ? 'timed out' : `network error: ${error.message}`,
      error,
      durationMs: Date.now() - start,
    };
  }

  const brdStatus = response.headers.get('x-brd-status-code');
  const brdError = response.headers.get('x-brd-error');
  const brdErrorCode = response.headers.get('x-brd-error-code');
  const text = await readCappedText(response).catch(() => '');
  const trace: BrightDataSerpAttemptTrace = {
    durationMs: Date.now() - start,
    status: response.status,
    brdStatus,
    brdError,
    brdErrorCode,
    bytes: text.length,
  };

  // Bright Data answers HTTP 200 for a page it could not render (its own
  // selector wait timing out, or its own rate limit) and carries the real
  // outcome in `x-brd-status-code`, so that header decides first. Only when it
  // is absent or 2xx do the HTTP status and then the body decide.
  const brdStatusCode = brdStatus === null ? NaN : Number(brdStatus);
  if (Number.isFinite(brdStatusCode) && (brdStatusCode < 200 || brdStatusCode >= 300)) {
    const reason = `Bright Data reported ${brdStatusCode}${brdError ? `: ${brdError}` : ''}`;
    return {
      ok: false,
      ...classifyFailureStatus(brdStatusCode),
      retryAfterMs: vendorWaitMs(response),
      reason,
      error: new Error(`Bright Data SERP request failed: ${reason}`),
      ...trace,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      ...classifyFailureStatus(response.status),
      retryAfterMs: vendorWaitMs(response),
      reason: `HTTP ${response.status} ${response.statusText}`,
      error: new Error(
        `Bright Data SERP request failed: ${response.status} ${response.statusText}: ${text.slice(0, 200)}`,
      ),
      ...trace,
    };
  }

  let raw: unknown;
  try {
    raw = text.length ? JSON.parse(text) : undefined;
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    return {
      ok: false,
      retryable: true,
      rateLimited: false,
      reason: `response was not JSON (${response.status}, ${text.length} bytes)`,
      error: new Error('Bright Data SERP response was not valid JSON'),
      ...trace,
    };
  }

  try {
    return { ok: true, search: mapBrightDataSerpResponse(raw), ...trace };
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      rateLimited: false,
      reason: `response was missing the organic array (${response.status}, ${text.length} bytes)`,
      error: err instanceof Error ? err : new Error(String(err)),
      ...trace,
    };
  }
}

interface ProfileSearchInput {
  name: string;
  description?: string | null;
  company?: string | null;
}

// A selection from https://github.com/googleapis/google-api-nodejs-client/blob/main/src/apis/customsearch/v1.ts
type Search = {
  items?: SearchResult[];
  searchInformation?: {
    formattedSearchTime?: string;
    formattedTotalResults?: string;
    searchTime?: number;
    totalResults?: string;
  } | null;
  spelling?: { correctedQuery?: string; htmlCorrectedQuery?: string } | null;
  url?: { template?: string; type?: string } | null;
};

type SearchResult = {
  link?: string | null;
  snippet?: string | null;
  title?: string | null;
};

// What Google sends in place of a `Search` when it refuses the request: a bad
// or restricted key, an unknown `cx`, an exhausted quota, or an API that is
// not enabled on the key's project. A genuine no-match never carries `error`;
// it is a `Search` with no `items`.
type SearchErrorBody = {
  error: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
};

function isSearchErrorBody(body: unknown): body is SearchErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  return typeof body.error === 'object' && body.error !== null;
}

class WebSearch {
  async search(query: string): Promise<Search> {
    const provider = resolveWebSearchProvider();
    switch (provider) {
      case 'google':
        return this.searchGoogle(query);
      case 'brightdata':
        return this.searchBrightData(query);
      default:
        return neverAsAny(provider);
    }
  }

  private async searchGoogle(query: string): Promise<Search> {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', getEnvVar('GOOGLE_CUSTOM_SEARCH_API_KEY', { devDefault: 'local' }));
    url.searchParams.set('cx', getEnvVar('GOOGLE_CX', { devDefault: 'local' }));
    url.searchParams.set('q', query);

    const response = await fetch(url);
    const body: unknown = await response.json().catch(() => undefined);

    // A refusal arrives either as a non-2xx status or, for at least the quota
    // case, as a 200 whose body is an error envelope. Neither has `items`, so
    // passing it on would read downstream as "nothing found".
    if (!response.ok || isSearchErrorBody(body)) {
      const error = isSearchErrorBody(body) ? body.error : undefined;
      const code = error?.code ?? response.status;
      const status = error?.status ?? response.statusText;
      const reason = error?.errors?.[0]?.reason;
      const message = error?.message ?? reason ?? response.statusText;

      logger.warn('[web_search] Google Custom Search refused the request', {
        status: code,
        reason,
        message,
        query,
      });

      throw new Error(
        `Google Custom Search refused the request (${code} ${status}): ${message}. ` +
          `Check GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CX, and that the Custom Search JSON API is enabled on the key's Google Cloud project.`,
      );
    }

    return body as Search;
  }

  // Read lazily, same reason as scraper.ts's Bright Data path: importing this
  // module should never require the SERP zone to be provisioned.
  private async searchBrightData(query: string): Promise<Search> {
    const missing = missingBrightDataSerpVars();
    if (missing.length) {
      throw new Error(`Bright Data web search requires ${missing.join(' and ')} to be set`);
    }

    // The query text is the whole `q=` parameter, `site:` restriction and all
    // — the same string the Google provider would have received — so a
    // caller's existing `site:linkedin.com/in …` queries carry over unchanged.
    const searchUrl = new URL('https://www.google.com/search');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('brd_json', '1');

    const zone = getEnvVar('BRIGHT_DATA_SERP_ZONE');
    const pacing = brightDataSerpPacing();
    const { caller, request } = brightDataSerpRequest(zone, pacing);
    const limiter = limiterSlot();
    const streaks = failureStreaksOn(limiter);
    const failures: string[] = [];
    for (let attempt = 1; ; attempt++) {
      // A retry is a request the zone counts like any other, so it asks the
      // limiter too (and waits out a pause any search's failure set). The pause
      // is set before the permit is released, so a search waiting for a free
      // slot is never let in between a failure and the zone closing.
      const { outcome, pause } = await limited(limiter, request, async () => {
        const outcome = await performBrightDataSerpAttempt(searchUrl);
        if (outcome.ok) {
          streaks.delete(zone);
          return { outcome, pause: undefined };
        }
        if (!outcome.retryable) return { outcome, pause: undefined };
        const streak = (streaks.get(zone) ?? 0) + 1;
        streaks.set(zone, streak);
        const pause = brightDataSerpPause(streak, outcome, pacing);
        if (pause.closesZone) await throttleAfter(limiter, caller, pause.ms);
        return { outcome, pause };
      });
      const trace = {
        attempt,
        durationMs: outcome.durationMs,
        status: outcome.status,
        brdStatus: outcome.brdStatus,
        brdError: outcome.brdError,
        brdErrorCode: outcome.brdErrorCode,
        bytes: outcome.bytes,
      };

      if (outcome.ok) {
        logger.info('[web_search] Bright Data SERP request', { ...trace, outcome: 'ok' });
        return outcome.search;
      }

      const isLastAttempt = attempt >= BRIGHT_DATA_SERP_MAX_ATTEMPTS;
      const willRetry = outcome.retryable && !isLastAttempt;
      logger.info('[web_search] Bright Data SERP request', {
        ...trace,
        outcome: willRetry ? 'retry' : 'failed',
        reason: outcome.reason,
        pauseMs: pause?.ms,
        closedZone: pause?.closesZone,
      });

      if (!outcome.retryable) throw outcome.error;

      failures.push(`#${attempt} ${outcome.reason} (${outcome.durationMs}ms)`);
      if (isLastAttempt) {
        throw new Error(
          `Bright Data SERP request failed after ${attempt} attempts: ${failures.join('; ')}`,
        );
      }

      // Outside the limiter call, so the wait holds no slot and other
      // searches carry on.
      if (pause !== undefined && !pause.closesZone) await sleep(pause.ms);
    }
  }

  /**
   * Notes:
   *  - we use Google search results to avoid Linkedin's bot detection
   *  - the search is restricted to the linkedin.com/in namespace
   *  - results are sorted by Google's relevance
   */
  async findLinkedIn(
    { name, description, company }: ProfileSearchInput,
    { allowSupplementaryWebSearch = false }: { allowSupplementaryWebSearch?: boolean } = {},
  ): Promise<SearchResult[]> {
    const query = `site:linkedin.com/in ${name}`;

    const oldCompanies = description
      ? await anthropicChat({
          model: 'claude-haiku-4-5-20251001',
          label: 'linkedin_previous_companies',
          system: `Your function is to output a company that someone used to work at.
      The input is a terse summary of someone's experience.
      Output a vbar-separated list of companies this person has worked at (e.g. "ex Facebook" -> "Facebook"). If there is one company, output just that company.
      Another example might be "ex Facebook, used to work at Google" -> "Facebook | Google".
      If you are not sure or there's not enough information, respond with "not sure".`,
          userMessage: description,
        }).then((response) =>
          response.toLowerCase().replace(/"/g, '') === 'not sure' ? null : response,
        )
      : null;

    // by ORing the current company with the previous companies, we handle stealth founders who
    // haven't updated their LinkedIn yet, and increase the chance of a correct match
    const companies = (oldCompanies ? `${company} | ${oldCompanies}` : company ?? '').replace(
      / (\| )?/g,
      ' OR ',
    );

    // Combine query by name and extended by company
    const parsed = await this.search(query);
    const specific = await this.search(`${query} ${companies}`);

    // Google CSE is the primary path. Legacy pipelines may additionally fall back
    // to Tavily for the rare person+company empty case — gated, because Tavily has
    // no DPA and must never run for a movement (which stays Google-CSE-only).
    let supplementaryItems: SearchResult[] = [];
    if (
      allowSupplementaryWebSearch &&
      (specific.items ?? []).length === 0 &&
      companies.trim() &&
      tavilyAvailable()
    ) {
      try {
        const tavilyResults = await tavilySearch(`${name} ${companies} site:linkedin.com/in`, 5);
        supplementaryItems = tavilyResults
          .filter((r) => /linkedin\.com\/in\//.test(r.url))
          .map((r) => ({ link: r.url, title: r.title, snippet: r.snippet }));
      } catch {
        // Tavily unavailable — continue with Google results only
      }
    }

    const items = (specific.items ?? [])
      .concat(supplementaryItems)
      .concat(parsed.items ?? []);

    if (!items.length) {
      return [];
    }

    const itemsText = items
      .map(
        (item, index) => `${index + 1}. name: ${item.title}
        snippet: ${item.snippet}`,
      )
      .join('\n');

    const response = await Prompt.matchSearchResult({
      company: company ?? '',
      name,
      description: description ?? '',
      items: itemsText,
    });

    const match = response.find((res) => res.is_match);

    if (match) {
      return [items[match.number - 1]];
    }

    return [];
  }

  async findTwitter({ name, company }: ProfileSearchInput) {
    const parsed = await this.search(`site:twitter.com ${name}`);

    if (!parsed.items || !parsed.items.length) {
      return;
    }

    const lowerCompany = company?.toLowerCase();
    const profilesMentioningCompany = parsed.items.filter(
      ({ snippet }) => lowerCompany && snippet?.toLowerCase().includes(lowerCompany),
    );

    return profilesMentioningCompany.concat(parsed.items)[0]?.link;
  }
}

const WebSearchService = new WebSearch();

export { WebSearchService };
