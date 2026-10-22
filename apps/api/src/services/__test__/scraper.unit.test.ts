// Bright Data's Web Unlocker only executes JavaScript on request (a second
// billable call), so a client-rendered SPA's empty shell needs a deliberate
// JS-render retry. These tests exercise that retry decision and the shell
// detection it's built on; ScraperAPI always renders and is untouched by it.

jest.mock('../../lib/utils/environment', () => ({
  getEnvVar: () => 'test-value',
}));

// Real llm_usage.ts pulls in lib/kysely → prisma, which requires DB env vars
// at import time; stub it so this suite stays DB-free (metering itself isn't
// under test here — recordPluginCost is a no-op with no active run context).
jest.mock('../../lib/llm_usage', () => ({
  currentLlmUsageContext: () => undefined,
}));

const sendSlackNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../../lib/slack', () => ({ sendSlackNotification }));

import { installLimiter, MemoryLimiter } from 'movement-engine/public/limiter';

import { ScraperService, looksLikeSpaShell } from '../scraper';
import { BudgetExhausted, NO_BUDGET_LIMIT } from 'movement-engine/public/models';
import { withSpendMeter } from 'movement-engine/public/models';
import { captureEngineLogs } from '../../test/engine_logs';

const logs = captureEngineLogs();

const fetchMock = jest.fn();
global.fetch = fetchMock as never;

const okResponse = (body: string) => new Response(body, { status: 200 });

function bodyOf(callIndex: number): Record<string, unknown> {
  const [, options] = fetchMock.mock.calls[callIndex];
  return JSON.parse(options.body as string);
}

beforeEach(() => {
  // The slot's in-process limiter, fresh for each test so no count carries over.
  installLimiter(new MemoryLimiter());
  fetchMock.mockReset();
  sendSlackNotification.mockClear();
});

describe('ScraperService.getWebsite — brightdata JS-render fallback', () => {
  it('never re-fetches when the first pass is rich', async () => {
    const richHtml = `<html><body><p>${'Real page content. '.repeat(20)}</p></body></html>`;
    fetchMock.mockResolvedValueOnce(okResponse(richHtml));

    const text = await ScraperService.getWebsite('https://example.com', { provider: 'brightdata' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text.trim().length).toBeGreaterThan(50);
  });

  it('retries with render: true when the first pass is thin, and returns the rendered text', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('<html><body></body></html>'));
    const renderedHtml = `<html><body><p>${'Rendered content once JS ran. '.repeat(10)}</p></body></html>`;
    fetchMock.mockResolvedValueOnce(okResponse(renderedHtml));

    const text = await ScraperService.getWebsite('https://example.com', { provider: 'brightdata' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(0).render).toBeUndefined();
    expect(bodyOf(1).render).toBe(true);
    expect(text).toContain('Rendered content once JS ran.');
    expect(logs.info()).toContainEqual(
      expect.objectContaining({
        message: 'Retrying with JavaScript rendering',
        meta: expect.objectContaining({ url: 'https://example.com', reason: 'thin content' }),
      }),
    );
  });

  it('retries on an SPA shell signature (empty root div, short non-thin text)', async () => {
    const shellHtml =
      '<html><body><nav>Home About Contact — loading your dashboard, please wait a moment</nav>' +
      '<div id="root"></div></body></html>';
    fetchMock.mockResolvedValueOnce(okResponse(shellHtml));
    const renderedHtml = `<html><body><div id="root"><p>${'Dashboard data. '.repeat(20)}</p></div></body></html>`;
    fetchMock.mockResolvedValueOnce(okResponse(renderedHtml));

    const text = await ScraperService.getWebsite('https://example.com', { provider: 'brightdata' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).render).toBe(true);
    expect(text).toContain('Dashboard data.');
    expect(logs.info()).toContainEqual(
      expect.objectContaining({
        message: 'Retrying with JavaScript rendering',
        meta: expect.objectContaining({ reason: 'SPA shell' }),
      }),
    );
  });

  it('falls through to the JSON-script fallback and the no-content warning when the rendered pass is still thin', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('<html><body></body></html>'));
    fetchMock.mockResolvedValueOnce(okResponse('<html><body><!-- still empty --></body></html>'));

    const text = await ScraperService.getWebsite('https://example.com', { provider: 'brightdata' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text.trim().length).toBeLessThan(50);
    expect(logs.warn()).toContainEqual(
      expect.objectContaining({
        message: 'Scrape returned no meaningful content',
        meta: { url: 'https://example.com' },
      }),
    );
    expect(sendSlackNotification).toHaveBeenCalledTimes(1);
  });

  it('never re-fetches for the scraperapi provider (already renders on every call)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('<html><body></body></html>'));

    await ScraperService.getWebsite('https://example.com', { provider: 'scraperapi' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ScraperService.getWebsite — bodies that are not pages', () => {
  it.each([
    ['a PDF', 'https://city.example.gov/records/tax-sale.pdf'],
    ['an upper-case extension', 'https://city.example.gov/records/TAX-SALE.PDF'],
    ['an extension before a query string', 'https://city.example.gov/records/deck.pptx?dl=1'],
    ['an image', 'https://cdn.example.com/assets/logo.png'],
  ])('never requests %s', async (_case, url) => {
    const text = await ScraperService.getWebsite(url, { provider: 'brightdata' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toBe('');
  });

  it('returns nothing for a body whose first bytes are a PDF, and does not re-fetch', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(`%PDF-1.4\n${'0 obj <</Type/Page>>\n'.repeat(50)}`));

    const text = await ScraperService.getWebsite('https://example.com/report', {
      provider: 'brightdata',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toBe('');
    expect(logs.info()).toContainEqual(
      expect.objectContaining({
        message: 'Scrape returned a body that is not a page',
        meta: { url: 'https://example.com/report', reason: 'a PDF' },
      }),
    );
    expect(logs.messages('info')).not.toContain('Retrying with JavaScript rendering');
  });

  it('returns nothing when the response declares a binary content type', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('anything at all', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const text = await ScraperService.getWebsite('https://example.com/report', {
      provider: 'brightdata',
    });

    expect(text).toBe('');
    expect(logs.info()).toContainEqual(
      expect.objectContaining({
        message: 'Scrape returned a body that is not a page',
        meta: expect.objectContaining({ reason: 'content-type application/pdf' }),
      }),
    );
  });

  it('stops a huge body at the cap and does not re-render it', async () => {
    // Thin extracted text — everything is inside one comment — but the body
    // itself is far past the cap, so the thinness is the cap's doing.
    fetchMock.mockResolvedValueOnce(okResponse(`<html><body><!--${'a'.repeat(2_200_000)}`));

    const text = await ScraperService.getWebsite('https://example.com/huge', {
      provider: 'brightdata',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text.length).toBeLessThanOrEqual(50_000);
    expect(logs.info()).toContainEqual(
      expect.objectContaining({
        message: 'Not retrying with JavaScript rendering',
        meta: expect.objectContaining({ reason: expect.stringContaining('size cap') }),
      }),
    );
  });

  it('truncates extracted text at fifty thousand characters', async () => {
    const long = `<html><body><p>${'Real page content. '.repeat(6000)}</p></body></html>`;
    fetchMock.mockResolvedValueOnce(okResponse(long));

    const text = await ScraperService.getWebsite('https://example.com/long', {
      provider: 'brightdata',
    });

    expect(text.length).toBe(50_000);
  });
});

describe('looksLikeSpaShell', () => {
  it('flags an empty root div with no other text', () => {
    expect(looksLikeSpaShell('<html><body><div id="root"></div></body></html>')).toBe(true);
  });

  it('tolerates whitespace inside the mount point', () => {
    expect(looksLikeSpaShell('<div id="app">\n   \n</div>')).toBe(true);
  });

  it('flags an explicit "enable JavaScript" notice', () => {
    expect(looksLikeSpaShell('<html><body><p>Please enable JavaScript to view this site.</p></body></html>')).toBe(
      true,
    );
  });

  it('does not flag a long page even with an empty-looking mount div elsewhere', () => {
    const html = `<html><body><div id="root"></div><p>${'Real content. '.repeat(30)}</p></body></html>`;
    expect(looksLikeSpaShell(html)).toBe(false);
  });

  it('does not flag a mount point that already has content', () => {
    const html = '<html><body><div id="root"><p>Server-rendered content here.</p></div></body></html>';
    expect(looksLikeSpaShell(html)).toBe(false);
  });
});

describe('ScraperService.getWebsite — what a run is charged', () => {
  it('charges the call per Web Unlocker request, a rendered retry included', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('<html><body></body></html>'));
    const renderedHtml = `<html><body><p>${'Rendered content once JS ran. '.repeat(10)}</p></body></html>`;
    fetchMock.mockResolvedValueOnce(okResponse(renderedHtml));

    const { cost } = await withSpendMeter(NO_BUDGET_LIMIT, () =>
      ScraperService.getWebsite('https://example.com', { provider: 'brightdata' }),
    );
    expect(cost).toEqual([{ source: 'service:brightdata.web_unlocker', microdollars: 3_000 }]);
  });

  it('a failed request is not charged', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401, statusText: 'Unauthorized' }));
    const cost: unknown[] = [];
    await withSpendMeter(NO_BUDGET_LIMIT, async () => {
      await expect(ScraperService.getWebsite('https://example.com', { provider: 'brightdata' })).rejects.toThrow();
    }).then((metered) => cost.push(...metered.cost));
    expect(cost).toEqual([]);
  });

  it('is not started once the run has spent its budget', async () => {
    await expect(
      withSpendMeter({ remainingMicrodollars: 0 }, () =>
        ScraperService.getWebsite('https://example.com', { provider: 'brightdata' }),
      ),
    ).rejects.toThrow(BudgetExhausted);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const RICH_HTML = `<html><body><p>${'Real page content. '.repeat(20)}</p></body></html>`;

describe('ScraperService.getWebsite — Web Unlocker limits', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds ten requests in flight and sends the eleventh when one is answered', async () => {
    const answers: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          answers.push(() => {
            inFlight -= 1;
            resolve(okResponse(RICH_HTML));
          });
        }),
    );

    const scrapes = Array.from({ length: 12 }, (_, i) =>
      ScraperService.getWebsite(`https://example.com/${i}`, { provider: 'brightdata' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(10);

    answers[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(11);

    const done = Promise.all(scrapes);
    let answered = 1;
    while (answered < 12) {
      if (answers.length > answered) answers[answered++]();
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await done;
    expect(maxInFlight).toBe(10);
  });

  it('after a 429 waits the wait Bright Data named, then asks again', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      new Response('slow down', { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '7' } }),
    );
    fetchMock.mockResolvedValueOnce(okResponse(RICH_HTML));

    const scrape = ScraperService.getWebsite('https://example.com', { provider: 'brightdata' });
    await jest.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect((await scrape).trim().length).toBeGreaterThan(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('after a 429 with no named wait closes the zone for thirty seconds, for every scrape', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429, statusText: 'Too Many Requests' }));
    fetchMock.mockImplementation(async () => okResponse(RICH_HTML));

    const first = ScraperService.getWebsite('https://example.com/a', { provider: 'brightdata' });
    await jest.advanceTimersByTimeAsync(0);
    const second = ScraperService.getWebsite('https://example.com/b', { provider: 'brightdata' });

    await jest.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
