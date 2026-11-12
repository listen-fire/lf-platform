// web_search — the provider switch and the Bright Data SERP mapping.
//
// `findLinkedIn`/`findTwitter` aren't under test here (they're the same
// regardless of provider); only `.search()`, which is where the provider
// switch and the Bright Data request/response live. `lib/prompts` and
// `lib/anthropic` are mocked purely to keep the module import cheap — nothing
// under test touches them.

jest.mock('../../lib/prompts', () => ({ Prompt: { matchSearchResult: jest.fn() } }));
jest.mock('../../lib/anthropic', () => ({ anthropicChat: jest.fn() }));
jest.mock('../../lib/web_search', () => ({
  webSearch: jest.fn(),
  isAvailable: () => false,
}));

import { installLimiter, MemoryLimiter } from 'movement-engine/public/limiter';
import { logger } from 'movement-engine/public/log';

import { brightDataSerpPacing, WebSearchService } from '../web_search';

const fetchMock = jest.fn();
global.fetch = fetchMock as never;

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  // `Date` is faked with the timers: the limiter measures its minute and its
  // throttles with it, and a wait it asks for is a timer.
  jest.useFakeTimers();
  // The slot's in-process limiter, fresh for each test so no count carries over.
  installLimiter(new MemoryLimiter());
  fetchMock.mockReset();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.WEB_SEARCH_PROVIDER;
  process.env.GOOGLE_CUSTOM_SEARCH_API_KEY = 'google-key';
  process.env.GOOGLE_CX = 'google-cx';
  delete process.env.BRIGHT_DATA_ACCESS_TOKEN;
  delete process.env.BRIGHT_DATA_SERP_ZONE;
  // Every Bright Data request shares the zone's limit, and these tests make
  // more than a default minute's worth between them; the limit itself is
  // under test below.
  process.env.BRIGHT_DATA_SERP_PER_MINUTE = '1000';
  delete process.env.BRIGHT_DATA_SERP_CONCURRENT;
  delete process.env.BRIGHT_DATA_SERP_BACKOFF_BASE_MS;
  delete process.env.BRIGHT_DATA_SERP_BACKOFF_MAX_MS;
  delete process.env.BRIGHT_DATA_SERP_BACKOFF_JITTER;
  // The middle of the spread, so a pause lands exactly on its curve; the
  // spread itself is under test below.
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// The default pauses in web_search.ts: a first failure's, and a 429's that
// names no wait. Advancing fake timers by these flushes a pause without
// sleeping the suite.
const FIRST_PAUSE_MS = 15_000;
const RATE_LIMIT_PAUSE_MS = 30_000;

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('WebSearchService.search — provider switch', () => {
  it('defaults to google when WEB_SEARCH_PROVIDER is unset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await WebSearchService.search('acme');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('https://www.googleapis.com/customsearch/v1');
  });

  it('routes to google explicitly', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'google';
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await WebSearchService.search('acme');

    expect(String(fetchMock.mock.calls[0][0])).toContain('googleapis.com');
  });

  it('routes to brightdata', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    await WebSearchService.search('acme');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.brightdata.com/request');
  });

  it('rejects an unrecognised value naming the variable and the values', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'bing';

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'WEB_SEARCH_PROVIDER must be "google" or "brightdata" (got "bing")',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Google answers a refused request (bad key, unknown cx, API not enabled on
// the key's project, exhausted quota) with an `error` envelope and no
// `items`. Passed through, that reads downstream as "nobody found", so it
// has to fail instead.
describe('WebSearchService.search — google refusals', () => {
  it('returns a normal result unchanged', async () => {
    const items = [{ link: 'https://example.com/', title: 'Example', snippet: 'An example' }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ items }));

    const result = await WebSearchService.search('example');

    expect(result.items).toEqual(items);
  });

  it('a 403 refusal fails naming the API to enable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 403,
            message: 'This project does not have the access to Custom Search JSON API.',
            status: 'PERMISSION_DENIED',
            errors: [{ reason: 'forbidden' }],
          },
        },
        { status: 403 },
      ),
    );

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      /Google Custom Search refused the request \(403 PERMISSION_DENIED\): This project does not have the access to Custom Search JSON API\..*Custom Search JSON API is enabled/,
    );
  });

  it('a 200 carrying an error envelope fails with its message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        error: {
          code: 429,
          message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'.",
          status: 'RESOURCE_EXHAUSTED',
          errors: [{ reason: 'rateLimitExceeded' }],
        },
      }),
    );

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      /\(429 RESOURCE_EXHAUSTED\): Quota exceeded for quota metric 'Queries'/,
    );
  });
});

describe('WebSearchService.search — brightdata request shape', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  it('encodes a query with spaces and quotes into the google search url, bearer auth, and the SERP zone', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    await WebSearchService.search('site:linkedin.com/in "Jane Doe" Acme Inc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/request');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer token-123',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(options.body as string);
    expect(body.zone).toBe('serp_zone');
    expect(body.format).toBe('raw');

    const requestedUrl = new URL(body.url);
    expect(requestedUrl.origin + requestedUrl.pathname).toBe('https://www.google.com/search');
    expect(requestedUrl.searchParams.get('q')).toBe('site:linkedin.com/in "Jane Doe" Acme Inc');
    expect(requestedUrl.searchParams.get('brd_json')).toBe('1');
  });

  it('missing variables fail naming them, without making a request', async () => {
    delete process.env.BRIGHT_DATA_ACCESS_TOKEN;
    delete process.env.BRIGHT_DATA_SERP_ZONE;

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'Bright Data web search requires BRIGHT_DATA_ACCESS_TOKEN and BRIGHT_DATA_SERP_ZONE to be set',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing only the zone names just the zone', async () => {
    delete process.env.BRIGHT_DATA_SERP_ZONE;

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'Bright Data web search requires BRIGHT_DATA_SERP_ZONE to be set',
    );
  });
});

describe('WebSearchService.search — brightdata response mapping', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  it('maps a realistic parsed reply into the shared result type', async () => {
    // Shape documented at https://docs.brightdata.com/scraping-automation/serp-api/
    // (organic[].link/title/description/rank/global_rank; only the three
    // fields callers read — title, link, snippet — are mapped).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        general: { search_engine: 'google', query: 'Basecamp company', results_cnt: 12_400_000 },
        organic: [
          {
            rank: 1,
            global_rank: 1,
            title: 'Basecamp — Project management software',
            link: 'https://basecamp.com/',
            description: 'A simpler way to work. Basecamp puts everything in one place.',
          },
          {
            rank: 2,
            global_rank: 2,
            title: 'Basecamp (company) - Wikipedia',
            link: 'https://en.wikipedia.org/wiki/Basecamp_(company)',
            description: 'Basecamp, formerly 37signals, is an American software company.',
          },
        ],
        people_also_ask: [{ question: 'Who owns Basecamp?' }],
      }),
    );

    const result = await WebSearchService.search('Basecamp company');

    expect(result.items).toEqual([
      {
        link: 'https://basecamp.com/',
        title: 'Basecamp — Project management software',
        snippet: 'A simpler way to work. Basecamp puts everything in one place.',
      },
      {
        link: 'https://en.wikipedia.org/wiki/Basecamp_(company)',
        title: 'Basecamp (company) - Wikipedia',
        snippet: 'Basecamp, formerly 37signals, is an American software company.',
      },
    ]);
  });

  it('carries plain text extensions ahead of the description, once each, and drops the rest', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        organic: [
          {
            title: 'Jane Doe - Head of Platform - Acme | LinkedIn',
            link: 'https://www.linkedin.com/in/jane-doe',
            description: 'Experience: Acme · Education: Example University',
            extensions: [
              { type: 'text', text: 'Berlin' },
              // A repeat, text the description already holds, a sitelink and a
              // blank each add nothing to the snippet.
              { type: 'text', text: 'Berlin' },
              { type: 'text', text: 'education: example university' },
              { type: 'site_link', text: 'Contact info' },
              { type: 'text', text: '  ' },
              { type: 'text', text: 'Head of Platform' },
            ],
          },
          { link: 'https://example.com/a', description: 'Only a description', extensions: [{ type: 'site_link', text: 'Home' }] },
          { link: 'https://example.com/b', extensions: [{ type: 'text', text: 'No description' }] },
        ],
      }),
    );

    const result = await WebSearchService.search('Jane Doe');

    expect(result.items?.map((item) => item.snippet)).toEqual([
      'Berlin · Head of Platform · Experience: Acme · Education: Example University',
      'Only a description',
      'No description',
    ]);
  });

  it('tolerates an extensions field the provider reshaped, keeping the description', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        organic: [
          { link: 'https://example.com/a', description: 'Kept', extensions: 'not a list' },
          { link: 'https://example.com/b', description: 'Also kept', extensions: [{ type: 'text', text: 7 }, 'odd', { type: 'text', text: 'Zürich' }] },
        ],
      }),
    );

    const result = await WebSearchService.search('anything');

    expect(result.items?.map((item) => item.snippet)).toEqual(['Kept', 'Zürich · Also kept']);
  });

  it('an empty organic array is a real "no results", not an error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ general: { search_engine: 'google', query: 'no such thing' }, organic: [] }),
    );

    const result = await WebSearchService.search('no such thing');

    expect(result.items).toEqual([]);
  });

  it('an unexpected shape (no organic array) is retried, then the result returned', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'zone not found', status: 'failed' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS);

    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a non-JSON body is retried, then the result returned', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>not json</html>', { status: 200 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS);

    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a non-2xx configuration error (403) fails at once, naming the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('zone unauthorized', { status: 403 }));

    await expect(WebSearchService.search('acme')).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Measured against a live SERP zone: a render failure (the zone's own
// selector wait timing out) and the zone's own rate limit both arrive as
// HTTP 200 with the real outcome in `x-brd-status-code` and an empty body.
describe('WebSearchService.search — brightdata retries', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  const timeoutError = () =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  const brdRenderFailure = () =>
    new Response('', {
      status: 200,
      headers: {
        'x-brd-status-code': '502',
        'x-brd-error': 'waiting for selector "#main" failed',
      },
    });

  it('recovers from a Bright Data 502 with an empty body', async () => {
    fetchMock.mockResolvedValueOnce(brdRenderFailure());
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ organic: [{ link: 'https://example.com/', title: 'Example' }] }),
    );

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS);

    expect((await promise).items).toEqual([
      { link: 'https://example.com/', title: 'Example', snippet: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from a timeout', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS);

    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from an HTTP 500', async () => {
    fetchMock.mockResolvedValueOnce(new Response('internal error', { status: 500 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS);

    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits the longer rate-limit delay after a Bright Data 429', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'x-brd-status-code': '429' } }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');

    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS - FIRST_PAUSE_MS);
    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits the wait Bright Data's Retry-After names when it is longer than the pause", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'x-brd-status-code': '429', 'retry-after': '45' } }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');

    await jest.advanceTimersByTimeAsync(44_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a Retry-After shorter than the pause waits the pause', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'x-brd-status-code': '429', 'retry-after': '7' } }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');

    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an HTTP 429 throttles the zone too', async () => {
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    const promise = WebSearchService.search('acme');
    await jest.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect((await promise).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a 429 holds another search's request until the wait is over", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'x-brd-status-code': '429', 'retry-after': '20' } }),
    );
    fetchMock.mockImplementation(async () => jsonResponse({ organic: [] }));

    const first = WebSearchService.search('first');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = WebSearchService.search('second');
    await jest.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a Bright Data 403 fails at once, without retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'x-brd-status-code': '403' } }),
    );

    await expect(WebSearchService.search('acme')).rejects.toThrow(/Bright Data reported 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails after three transient failures, naming each attempt', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());
    fetchMock.mockResolvedValueOnce(brdRenderFailure());
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    const expectation = expect(WebSearchService.search('acme')).rejects.toThrow(
      /^Bright Data SERP request failed after 3 attempts: #1 timed out \(\d+ms\); #2 Bright Data reported 502: waiting for selector "#main" failed \(\d+ms\); #3 response was not JSON \(200, 0 bytes\) \(\d+ms\)$/,
    );
    // The second failure in a row doubles the pause.
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS);
    await jest.advanceTimersByTimeAsync(2 * FIRST_PAUSE_MS);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('Bright Data SERP pacing settings', () => {
  it('each has a default, so an unset or blank environment needs nothing', () => {
    const defaults = {
      perMinute: 14,
      concurrent: 4,
      backoffBaseMs: 15_000,
      backoffMaxMs: 60_000,
      backoffJitter: 0.2,
    };
    expect(brightDataSerpPacing({})).toEqual(defaults);
    expect(
      brightDataSerpPacing({
        BRIGHT_DATA_SERP_PER_MINUTE: '  ',
        BRIGHT_DATA_SERP_CONCURRENT: '',
        BRIGHT_DATA_SERP_BACKOFF_BASE_MS: ' ',
        BRIGHT_DATA_SERP_BACKOFF_MAX_MS: '',
        BRIGHT_DATA_SERP_BACKOFF_JITTER: ' ',
      }),
    ).toEqual(defaults);
  });

  it('reads each one', () => {
    expect(
      brightDataSerpPacing({
        BRIGHT_DATA_SERP_PER_MINUTE: '30',
        BRIGHT_DATA_SERP_CONCURRENT: '2',
        BRIGHT_DATA_SERP_BACKOFF_BASE_MS: '1000',
        BRIGHT_DATA_SERP_BACKOFF_MAX_MS: '8000',
        BRIGHT_DATA_SERP_BACKOFF_JITTER: '0',
      }),
    ).toEqual({
      perMinute: 30,
      concurrent: 2,
      backoffBaseMs: 1_000,
      backoffMaxMs: 8_000,
      backoffJitter: 0,
    });
  });

  describe.each([
    'BRIGHT_DATA_SERP_PER_MINUTE',
    'BRIGHT_DATA_SERP_CONCURRENT',
    'BRIGHT_DATA_SERP_BACKOFF_BASE_MS',
    'BRIGHT_DATA_SERP_BACKOFF_MAX_MS',
  ])('%s', (name) => {
    it.each(['fourteen', '0', '-5', '1.5', '14/min'])('refuses %p naming the variable', (raw) => {
      expect(() => brightDataSerpPacing({ [name]: raw })).toThrow(
        `${name}="${raw}" is not a positive whole number`,
      );
    });
  });

  it.each(['1', '1.5', '-0.1', 'a fifth', '20%'])(
    'refuses a jitter of %p naming the variable',
    (raw) => {
      expect(() => brightDataSerpPacing({ BRIGHT_DATA_SERP_BACKOFF_JITTER: raw })).toThrow(
        `BRIGHT_DATA_SERP_BACKOFF_JITTER="${raw}" is not a fraction from 0 up to, but not including, 1`,
      );
    },
  );

  it('refuses a ceiling below the first pause', () => {
    expect(() =>
      brightDataSerpPacing({
        BRIGHT_DATA_SERP_BACKOFF_BASE_MS: '20000',
        BRIGHT_DATA_SERP_BACKOFF_MAX_MS: '10000',
      }),
    ).toThrow(
      'BRIGHT_DATA_SERP_BACKOFF_MAX_MS (10000) is below BRIGHT_DATA_SERP_BACKOFF_BASE_MS (20000)',
    );
  });
});

// Measured in production: thirty-odd searches demanded at once, and Bright
// Data refusing most of them with "Please decrease your request rate to
// 14/min". Requests now wait for the limiter instead of being sent and refused.
describe('Bright Data SERP pacing', () => {
  const MINUTE_MS = 60_000;

  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
    process.env.BRIGHT_DATA_SERP_PER_MINUTE = '14';
    // These demand dozens at once to find the minute's limit; the cap on how
    // many run at once is under test below.
    process.env.BRIGHT_DATA_SERP_CONCURRENT = '1000';
    fetchMock.mockImplementation(async () => jsonResponse({ organic: [] }));
  });

  it('refuses the request past the limit with a retryAt, and the search waits rather than sending', async () => {
    const limiter = new MemoryLimiter();
    installLimiter(limiter);
    const grants: Array<Awaited<ReturnType<MemoryLimiter['acquire']>>> = [];
    const acquire = limiter.acquire.bind(limiter);
    jest.spyOn(limiter, 'acquire').mockImplementation(async (request) => {
      const grant = await acquire(request);
      grants.push(grant);
      return grant;
    });
    const start = Date.now();

    const searches = Array.from({ length: 15 }, (_, i) => WebSearchService.search(`q${i}`));
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(14);
    const refusal = grants.find((grant) => !grant.granted);
    if (refusal === undefined || refusal.granted) throw new Error('the fifteenth request was not refused');
    // The window is rolling: the first call leaves it a whole minute after it was made.
    const retryAt = Date.parse(refusal.retryAt);
    expect(retryAt - start).toBe(MINUTE_MS);

    await jest.advanceTimersByTimeAsync(retryAt - start - 1);
    expect(fetchMock).toHaveBeenCalledTimes(14);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all(searches);
    expect(fetchMock).toHaveBeenCalledTimes(15);
  });

  it('N requests at once take about (N - 14) / 14 minutes, and no longer', async () => {
    const start = Date.now();
    const sentAt: number[] = [];
    fetchMock.mockImplementation(async () => {
      sentAt.push(Date.now() - start);
      return jsonResponse({ organic: [] });
    });
    const searches = Array.from({ length: 42 }, (_, i) => WebSearchService.search(`q${i}`));

    await jest.advanceTimersByTimeAsync(0);
    expect(sentAt).toHaveLength(14);

    await jest.advanceTimersByTimeAsync(2 * MINUTE_MS);
    await Promise.all(searches);
    expect(sentAt).toHaveLength(42);
    // The limiter is a rolling window: no minute holds more than 14, so a
    // request goes no sooner than a minute after the one 14 places before it.
    for (const [i, at] of sentAt.entries()) {
      if (i >= 14) expect(at - sentAt[i - 14]).toBeGreaterThanOrEqual(MINUTE_MS);
    }
    // (42 - 14) / 14 = two minutes for the last one, give or take rounding.
    expect(Math.max(...sentAt)).toBeGreaterThan(2 * MINUTE_MS - 100);
    expect(Math.max(...sentAt)).toBeLessThanOrEqual(2 * MINUTE_MS + 100);
  });

  it('every search, retries included, asks the limiter', async () => {
    process.env.BRIGHT_DATA_SERP_PER_MINUTE = '2';

    const searches = ['a', 'b', 'c'].map((q) => WebSearchService.search(q));
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The third waits until the first has left the minute's window.
    await jest.advanceTimersByTimeAsync(MINUTE_MS);
    await Promise.all(searches);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// Measured in production: about 30% of searches failed under load, and only a
// 429 slowed the others down. Every failure Bright Data might recover from
// now closes the zone for every search, for longer the more follow in a row.
describe('Bright Data SERP failures pause the zone', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  const badGateway = () =>
    new Response('', { status: 200, headers: { 'x-brd-status-code': '502' } });
  const found = () => jsonResponse({ organic: [] });

  /** When each request reached Bright Data, counted from now. */
  function recordSends(reply: () => Response): number[] {
    const start = Date.now();
    const sentAt: number[] = [];
    fetchMock.mockImplementation(async () => {
      sentAt.push(Date.now() - start);
      return reply();
    });
    return sentAt;
  }

  /** Each reply held open until the test answers it. */
  function holdReplies(): Array<(response: Response) => void> {
    const answers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => answers.push(resolve)));
    return answers;
  }

  function loggedPauses(info: jest.SpyInstance): unknown[] {
    return info.mock.calls
      .filter(([message]) => message === '[web_search] Bright Data SERP request')
      .map(([, meta]: unknown[]) =>
        typeof meta === 'object' && meta !== null && 'pauseMs' in meta ? meta.pauseMs : undefined,
      );
  }

  it('a 502 holds the next search, a different query too, until the pause has passed', async () => {
    fetchMock.mockResolvedValueOnce(badGateway());
    fetchMock.mockImplementation(async () => found());

    const first = WebSearchService.search('first');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = WebSearchService.search('second');
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a search waiting for a free slot is not let in between a failure and the zone closing', async () => {
    process.env.BRIGHT_DATA_SERP_CONCURRENT = '1';
    fetchMock.mockResolvedValueOnce(badGateway());
    fetchMock.mockImplementation(async () => found());

    const first = WebSearchService.search('first');
    const second = WebSearchService.search('second');
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('failures in a row double the pause up to the ceiling, then stay there, and the log says each', async () => {
    const info = jest.spyOn(logger, 'info');
    const sentAt = recordSends(badGateway);

    const first = WebSearchService.search('first').catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(45_000);
    expect(await first).toBeInstanceOf(Error);

    // A new search carries on the zone's run of failures, not a fresh one.
    const second = WebSearchService.search('second').catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(await second).toBeInstanceOf(Error);

    expect(sentAt).toEqual([0, 15_000, 45_000, 105_000, 165_000, 225_000]);
    expect(loggedPauses(info)).toEqual([15_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it('a success resets the run of failures', async () => {
    fetchMock.mockResolvedValueOnce(badGateway());
    fetchMock.mockResolvedValueOnce(badGateway());
    fetchMock.mockResolvedValueOnce(found());
    fetchMock.mockResolvedValueOnce(badGateway());
    fetchMock.mockImplementation(async () => found());

    const first = WebSearchService.search('first');
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS + 2 * FIRST_PAUSE_MS);
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // A third failure in a row would have closed the zone for 60s.
    const second = WebSearchService.search('second');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(1);
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("a 429's Retry-After longer than the curve is honoured further along the run too", async () => {
    fetchMock.mockResolvedValueOnce(badGateway());
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'x-brd-status-code': '429', 'retry-after': '45' } }),
    );
    const sentAt = recordSends(found);

    const promise = WebSearchService.search('acme');
    // The curve would say 30s for the second failure; Bright Data asked for 45s.
    await jest.advanceTimersByTimeAsync(FIRST_PAUSE_MS + 45_000);
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentAt).toEqual([FIRST_PAUSE_MS + 45_000]);
  });

  it('runs at most 4 searches at once, and a fifth starts when one finishes', async () => {
    const answers = holdReplies();

    const searches = Array.from({ length: 5 }, (_, i) => WebSearchService.search(`q${i}`));
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // However long the four take, the fifth waits for one of them.
    await jest.advanceTimersByTimeAsync(80_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    answers[0](found());
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    for (const answer of answers.slice(1)) answer(found());
    await Promise.all(searches);
  });

  describe('each setting overrides its default', () => {
    it('BRIGHT_DATA_SERP_CONCURRENT', async () => {
      process.env.BRIGHT_DATA_SERP_CONCURRENT = '2';
      const answers = holdReplies();

      const searches = Array.from({ length: 3 }, (_, i) => WebSearchService.search(`q${i}`));
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      answers[0](found());
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      for (const answer of answers.slice(1)) answer(found());
      await Promise.all(searches);
    });

    it('BRIGHT_DATA_SERP_BACKOFF_BASE_MS', async () => {
      process.env.BRIGHT_DATA_SERP_BACKOFF_BASE_MS = '1000';
      fetchMock.mockResolvedValueOnce(badGateway());
      fetchMock.mockImplementation(async () => found());

      const promise = WebSearchService.search('acme');
      await jest.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await promise;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('BRIGHT_DATA_SERP_BACKOFF_MAX_MS', async () => {
      process.env.BRIGHT_DATA_SERP_BACKOFF_MAX_MS = '20000';
      const sentAt = recordSends(badGateway);

      const promise = WebSearchService.search('acme').catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(35_000);
      expect(await promise).toBeInstanceOf(Error);
      // 15s, then 30s held to the 20s ceiling.
      expect(sentAt).toEqual([0, 15_000, 35_000]);
    });

    it.each([
      // [setting, random, pause]: the default spreads ±20%, a set one by its own fraction.
      [undefined, 0, 12_000],
      [undefined, 0.75, 16_500],
      ['0.5', 0, 7_500],
      ['0.5', 0.75, 18_750],
      ['0', 0, 15_000],
    ])('BRIGHT_DATA_SERP_BACKOFF_JITTER=%p with a random draw of %p pauses %pms', async (jitter, random, pause) => {
      if (jitter !== undefined) process.env.BRIGHT_DATA_SERP_BACKOFF_JITTER = jitter;
      jest.spyOn(Math, 'random').mockReturnValue(random);
      fetchMock.mockResolvedValueOnce(badGateway());
      fetchMock.mockImplementation(async () => found());

      const promise = WebSearchService.search('acme');
      await jest.advanceTimersByTimeAsync(pause - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await promise;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
