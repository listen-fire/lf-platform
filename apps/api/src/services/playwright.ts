import type { Page, Browser, BrowserContextOptions } from 'playwright';

import { Queue } from 'movement-engine/public/queue';
import { MINUTE } from '../constants';
import { logger } from 'movement-engine/public/log';

// Each withPage call spawns a full Chromium process — limit concurrency
const playwrightQueue = new Queue<unknown>({ concurrency: 2 });

// Wall-clock cap on any single browser session. Without this, a hung
// `page.goto` / `waitForLoadState('networkidle')` / infinite slide loop can
// pin a queue slot indefinitely and starve every other extract that needs a
// browser.
const WITH_PAGE_TIMEOUT = 5 * MINUTE;

class WithPageTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Playwright session exceeded ${timeoutMs}ms wall-clock timeout`);
    this.name = 'WithPageTimeoutError';
  }
}

// Sites like Notion turn away a Chrome version they consider outdated, judging
// by this string alone. It is not derived from the launched browser because
// the Chromium bundled with our pinned Playwright is itself outdated (129,
// which Notion rejects). Bump it to the current stable major when a site
// starts refusing it, as Notion did with 116.
const DESKTOP_CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

// The slim API image (ghcr.io/listen-fire/api-slim) leaves Chromium out so a
// scale-from-zero container pulls and starts faster. Everything that renders a
// page or a PDF goes through getBrowser, so this is the one place that names
// the fix.
class BrowserUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `This feature needs Chromium, which is not available here (${reason}). ` +
        'Run the browser variant of the API image (ghcr.io/listen-fire/api, ' +
        'build target api-browser) instead of the slim one (ghcr.io/listen-fire/api-slim).',
    );
    this.name = 'BrowserUnavailableError';
  }
}

const MISSING_EXECUTABLE = /Executable doesn't exist/;

class Playwright {
  async instance() {
    return import('playwright');
  }

  async getBrowser() {
    if (process.env.LISTEN_FIRE_IMAGE_VARIANT === 'slim') {
      throw new BrowserUnavailableError('this is the slim image');
    }
    const playwright = await this.instance();
    try {
      return await playwright.chromium.launch({
        headless: true,
        executablePath: undefined,
      });
    } catch (err) {
      if (err instanceof Error && MISSING_EXECUTABLE.test(err.message)) {
        throw new BrowserUnavailableError('no Chromium is installed');
      }
      throw err;
    }
  }

  /**
   * Obtain a webpage to use for the duration of a function. This uses a pattern
   * of scope-based resource management like `with` statements in Python and
   * try-with-resource statements in Java
   */
  async withPage<T>(
    fn: (page: Page, browser: Browser) => Promise<T>,
    options?: BrowserContextOptions,
  ): Promise<T> {
    return playwrightQueue.enqueue(async () => {
      // The timer is armed *before* getBrowser() so that a hung
      // `chromium.launch()` (which can happen after leaked browser handles
      // accumulate from prior killed sessions) can't pin the queue slot
      // forever. Anything that runs inside the queue worker is bounded.
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new WithPageTimeoutError(WITH_PAGE_TIMEOUT));
        }, WITH_PAGE_TIMEOUT);
      });

      let browser: Browser | undefined;
      try {
        return await Promise.race([
          (async () => {
            browser = await this.getBrowser();
            const context = await browser.newContext({
              acceptDownloads: true,
              userAgent: DESKTOP_CHROME_USER_AGENT,
              ...options,
            });
            const page = await context.newPage();
            return fn(page, browser);
          })(),
          timeoutPromise,
        ]);
      } catch (err) {
        if (err instanceof WithPageTimeoutError) {
          logger.warn('Playwright withPage timed out — force-closing browser', {
            timeoutMs: WITH_PAGE_TIMEOUT,
            browserLaunched: !!browser,
          });
        }
        throw err;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (browser) await this.forceCloseBrowser(browser);
      }
    }) as Promise<T>;
  }

  private async forceCloseBrowser(browser: Browser): Promise<void> {
    // browser.close() can itself hang if Chromium is unresponsive. Race it
    // against a short timer so the queue slot is freed even if the underlying
    // process leaks (Playwright SIGTERMs leaked children on parent exit).
    const CLOSE_TIMEOUT = 10_000;
    try {
      await Promise.race([
        browser.close(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('browser.close() timed out')), CLOSE_TIMEOUT),
        ),
      ]);
    } catch (err) {
      logger.warn('browser.close() failed — abandoning browser to free queue slot', { err });
    }
  }
}

const PlaywrightService = new Playwright();

export { PlaywrightService, BrowserUnavailableError };
