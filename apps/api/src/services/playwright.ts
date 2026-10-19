// `@lf/chromium`: the platform's browser slot, filled by a headless Chromium
// launched through Playwright (docs/contracts/browser-slot.md). The gated
// documents `@lf/web` reads (DocSend, Pitch, Canva, Notion, …) open their
// pages through the slot; the platform's own browser work — rendering a file
// to PDF, the legacy Slack preview — uses the same sessions through
// `PlaywrightService`, so every browser on the host shares one set of limits.
//
// The api image carries Chromium. An image without it (the slim one) leaves
// the slot empty, and a module asking for a page is refused naming the slot
// and the image that fills it.

import type { Page } from 'playwright';

import {
  boundedSessions,
  BROWSER_LIMITS,
  BrowserSlotEmpty,
  type BrowserLimits,
  type BrowserPageOptions,
  type BrowserSlot,
} from 'movement-engine/public/browser';
import { logger } from 'movement-engine/public/log';

export const CHROMIUM = '@lf/chromium';

// Sites like Notion turn away a Chrome version they consider outdated, judging
// by this string alone. It is not derived from the launched browser because
// the Chromium bundled with our pinned Playwright is itself outdated (129,
// which Notion rejects). Bump it to the current stable major when a site
// starts refusing it, as Notion did with 116.
const DESKTOP_CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const BROWSER_IMAGE = 'the api image (ghcr.io/listen-fire/api, build target api-browser)';

/** Why this process has no browser, or undefined when it may launch one. */
function emptyBecause(): string | undefined {
  if (process.env.LISTEN_FIRE_IMAGE_VARIANT === 'slim') {
    return `this is the api-slim image, which carries no Chromium; run ${BROWSER_IMAGE} to fill it`;
  }
  return undefined;
}

const MISSING_EXECUTABLE = /Executable doesn't exist/;

async function launch() {
  const why = emptyBecause();
  if (why !== undefined) throw new BrowserSlotEmpty(why);
  const playwright = await import('playwright');
  try {
    return await playwright.chromium.launch({ headless: true, executablePath: undefined });
  } catch (err) {
    if (err instanceof Error && MISSING_EXECUTABLE.test(err.message)) {
      throw new BrowserSlotEmpty(`no Chromium is installed for this process; run ${BROWSER_IMAGE}`);
    }
    throw err;
  }
}

function chromiumSessions(limits: BrowserLimits) {
  return boundedSessions<Page>({
    module: CHROMIUM,
    log: logger,
    limits,
    open: async (options, adopt) => {
      const browser = await launch();
      adopt(() => browser.close());
      const context = await browser.newContext({
        acceptDownloads: true,
        userAgent: DESKTOP_CHROME_USER_AGENT,
        ...options,
      });
      return context.newPage();
    },
  });
}

/** A Chromium slot with sessions of its own, under `limits`. */
export function chromiumSlot(limits: BrowserLimits): BrowserSlot {
  const withPage = chromiumSessions(limits);
  return {
    module: CHROMIUM,
    get emptyBecause() {
      return emptyBecause();
    },
    withPage: (fn, options) => withPage((page, session) => fn(page, session), options),
  };
}

// Each session is a whole Chromium process: the slot's limits (two at once,
// five minutes each) bound every browser this process opens.
const withChromiumPage = chromiumSessions(BROWSER_LIMITS);

/** The platform's browser slot: Chromium, or empty on an image without it. */
export const platformBrowser: BrowserSlot = {
  module: CHROMIUM,
  get emptyBecause() {
    return emptyBecause();
  },
  withPage: (fn, options) => withChromiumPage((page, session) => fn(page, session), options),
};

/**
 * Playwright's full page, for the platform's own browser work (a PDF printed
 * with Playwright's options). Same sessions, same limits as the slot.
 */
const PlaywrightService = {
  withPage<T>(fn: (page: Page) => Promise<T>, options?: BrowserPageOptions): Promise<T> {
    return withChromiumPage((page) => fn(page), options);
  },
};

export { PlaywrightService };
