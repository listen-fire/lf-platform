// The browser slot: a real web page a host can drive, for the work no plain
// fetch can do — a gated deck behind an email form, a viewer that draws
// slides with script, a page rendered to PDF or to an image. The engine never
// sees it; a module asks for it through its context (`ctx.browser`), and the
// host fills it or leaves it empty (docs/contracts/browser-slot.md).
//
// The page a session hands out is the part of a browser automation API the
// modules here use, written down as an interface: Playwright's `Page` is one
// (the built-in `@lf/chromium`), and a remote browser service speaking the
// same protocol is another. A module that needs more than this asks for it
// here first, so a host knows what filling the slot means.
//
// Every session is bounded by the slot, not by its caller: a few at once,
// each with a wall-clock limit after which its browser is closed whatever the
// page is doing. A hung navigation, a load that never settles or a slide loop
// that never ends cannot hold a place forever (`boundedSessions`).

import type { Readable } from 'node:stream';

import { Queue } from './queue';

/** Where an element is drawn, in CSS pixels. */
export interface BrowserBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserWaitOptions {
  timeout?: number;
}

export type BrowserElementState = 'attached' | 'detached' | 'visible' | 'hidden';

/** The elements a selector finds on the page, read when acted on. */
export interface BrowserLocator {
  locator(selector: string): BrowserLocator;
  nth(index: number): BrowserLocator;
  first(): BrowserLocator;
  filter(options?: { hasText?: string | RegExp; hasNotText?: string | RegExp }): BrowserLocator;
  all(): Promise<BrowserLocator[]>;
  count(): Promise<number>;

  click(options?: BrowserWaitOptions & { force?: boolean }): Promise<void>;
  fill(value: string, options?: BrowserWaitOptions): Promise<void>;
  press(key: string, options?: BrowserWaitOptions): Promise<void>;
  check(options?: BrowserWaitOptions): Promise<void>;
  uncheck(options?: BrowserWaitOptions): Promise<void>;
  scrollIntoViewIfNeeded(options?: BrowserWaitOptions): Promise<void>;
  waitFor(options?: BrowserWaitOptions & { state?: BrowserElementState }): Promise<void>;

  isVisible(options?: BrowserWaitOptions): Promise<boolean>;
  isEnabled(options?: BrowserWaitOptions): Promise<boolean>;
  isDisabled(options?: BrowserWaitOptions): Promise<boolean>;
  boundingBox(options?: BrowserWaitOptions): Promise<BrowserBox | null>;
  getAttribute(name: string, options?: BrowserWaitOptions): Promise<string | null>;
  textContent(options?: BrowserWaitOptions): Promise<string | null>;
  innerHTML(options?: BrowserWaitOptions): Promise<string>;
  /** A PNG of the element. */
  screenshot(options?: BrowserWaitOptions): Promise<Buffer>;

  /** Run `fn` in the page on the first matching element (`E`: the element
   *  type the caller knows the selector finds). */
  evaluate<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(fn: (element: E) => R | Promise<R>): Promise<R>;
  evaluate<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(fn: (element: E, arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
  /** Run `fn` in the page on every matching element. */
  evaluateAll<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(fn: (elements: E[]) => R | Promise<R>): Promise<R>;
}

/** A file the page downloaded. */
export interface BrowserDownload {
  suggestedFilename(): string;
  createReadStream(): Promise<Readable>;
}

/** One request the page made, held by a route. */
export interface BrowserRoute {
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  fulfill(response: { status?: number; contentType?: string; body?: string | Buffer }): Promise<void>;
}

export type BrowserLoadState = 'load' | 'domcontentloaded' | 'networkidle';

export type BrowserRole = 'button' | 'textbox' | 'link' | 'checkbox' | 'heading' | 'dialog';

export interface BrowserPdfOptions {
  format?: string;
  printBackground?: boolean;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
}

/** One open page. */
export interface BrowserPage {
  goto(url: string, options?: BrowserWaitOptions & { waitUntil?: BrowserLoadState | 'commit' }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  /** Replace the page's document with `html`. */
  setContent(html: string, options?: BrowserWaitOptions & { waitUntil?: BrowserLoadState | 'commit' }): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;

  locator(selector: string): BrowserLocator;
  getByRole(role: BrowserRole, options?: { name?: string | RegExp; exact?: boolean }): BrowserLocator;
  getByTestId(testId: string | RegExp): BrowserLocator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): BrowserLocator;
  keyboard: { press(key: string, options?: { delay?: number }): Promise<void> };

  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: BrowserLoadState, options?: BrowserWaitOptions): Promise<void>;
  waitForSelector(selector: string, options?: BrowserWaitOptions & { state?: BrowserElementState }): Promise<unknown>;
  waitForFunction<R>(fn: () => R | Promise<R>, arg?: undefined, options?: BrowserWaitOptions & { polling?: number | 'raf' }): Promise<unknown>;
  waitForFunction<R, Arg>(fn: (arg: Arg) => R | Promise<R>, arg: Arg, options?: BrowserWaitOptions & { polling?: number | 'raf' }): Promise<unknown>;
  waitForEvent(event: 'download', options?: BrowserWaitOptions): Promise<BrowserDownload>;
  /** Hold every request whose URL matches `url` (a glob) for `handler`. */
  route(url: string, handler: (route: BrowserRoute) => Promise<unknown> | unknown): Promise<void>;

  /** Run `fn` in the page. */
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  evaluate<R, Arg>(fn: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;

  /** A PNG of the viewport, or of the whole page. */
  screenshot(options?: BrowserWaitOptions & { fullPage?: boolean }): Promise<Buffer>;
  /** The page printed to PDF. */
  pdf(options?: BrowserPdfOptions): Promise<Buffer>;
}

/** The browser behind one page: closing it ends the session early (the slot
 *  closes it in any case when the session's function returns). */
export interface BrowserSession {
  close(): Promise<void>;
}

export interface BrowserPageOptions {
  viewport?: { width: number; height: number };
  userAgent?: string;
}

/** The slot's contract. */
export interface BrowserSlot {
  /** The module filling the slot (`@lf/chromium`), for log lines. */
  readonly module: string;
  /** Why the slot is empty, said before any session is asked for (a
   *  module refuses up front rather than inside a read that swallows
   *  errors); absent when a browser fills it. */
  readonly emptyBecause?: string;
  /** Open a page in a fresh browser, run `fn` with it, and close the browser.
   *  Waits for a place when the slot's sessions are all in use; refuses with
   *  `BrowserSessionTimedOut` when the session outlives its limit. */
  withPage<T>(fn: (page: BrowserPage, session: BrowserSession) => Promise<T>, options?: BrowserPageOptions): Promise<T>;
}

/** What bounds the sessions of one slot. */
export interface BrowserLimits {
  /** Sessions open at once; the rest wait. Each is a whole browser process. */
  concurrent: number;
  /** Wall-clock limit on a session, launch included. */
  sessionMs: number;
  /** How long closing a browser may take before it is abandoned. */
  closeMs: number;
}

export const BROWSER_LIMITS: BrowserLimits = { concurrent: 2, sessionMs: 5 * 60_000, closeMs: 10_000 };

/** The slot is empty on this host: a module asked for a browser and there is
 *  none. Says which slot, and what fills it. */
export class BrowserSlotEmpty extends Error {
  constructor(readonly why: string) {
    super(`the browser slot is empty: ${why}`);
    this.name = 'BrowserSlotEmpty';
  }
}

export class BrowserSessionTimedOut extends Error {
  constructor(module: string, timeoutMs: number) {
    super(`${module} session exceeded ${timeoutMs}ms wall-clock timeout`);
    this.name = 'BrowserSessionTimedOut';
  }
}

/** The slot of a host that has no browser: every session is refused,
 *  saying `why` (what this host is, and what would fill it). */
export function emptyBrowserSlot(why: string): BrowserSlot {
  return {
    module: '(none)',
    emptyBecause: why,
    withPage: async () => {
      throw new BrowserSlotEmpty(why);
    },
  };
}

export interface BrowserLog {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** How a module opens one page. `adopt` is called with the browser's close as
 *  soon as there is a browser to close, so a launch that hangs after that
 *  point is still closed when the session's limit passes. */
export type OpenPage<P> = (options: BrowserPageOptions | undefined, adopt: (close: () => Promise<void>) => void) => Promise<P>;

/**
 * Sessions bounded by `limits`: at most `concurrent` at once, each closed
 * after `sessionMs` whatever it is doing, and a close that hangs abandoned
 * after `closeMs` so its place is freed. The page type is the module's own
 * (`P`): a module that fills the slot hands its pages out as `BrowserPage`,
 * and the host's own code that needs the module's full API (rendering a PDF
 * with Playwright's options) uses the same sessions, under the same limits.
 */
export function boundedSessions<P>(input: {
  module: string;
  open: OpenPage<P>;
  log: BrowserLog;
  limits?: BrowserLimits;
}): <T>(fn: (page: P, session: BrowserSession) => Promise<T>, options?: BrowserPageOptions) => Promise<T> {
  const limits = input.limits ?? BROWSER_LIMITS;
  const queue = new Queue<unknown>({ concurrency: limits.concurrent });

  async function forceClose(close: () => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        close(),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('browser.close() timed out')), limits.closeMs);
        }),
      ]);
    } catch (err) {
      input.log.warn('browser.close() failed — abandoning browser to free queue slot', { module: input.module, err });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return <T>(fn: (page: P, session: BrowserSession) => Promise<T>, options?: BrowserPageOptions): Promise<T> => {
    const session = async (): Promise<T> => {
      // The timer is armed before the launch, so a launch that hangs (leaked
      // browsers from earlier killed sessions can do that) cannot hold the
      // place forever.
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserSessionTimedOut(input.module, limits.sessionMs)), limits.sessionMs);
      });

      let close: (() => Promise<void>) | undefined;
      let closed: Promise<void> | undefined;
      const closeOnce = (): Promise<void> => {
        if (close === undefined) return Promise.resolve();
        closed ??= forceClose(close);
        return closed;
      };
      try {
        return await Promise.race([
          (async () => {
            const page = await input.open(options, (browserClose) => {
              close = browserClose;
            });
            return fn(page, { close: closeOnce });
          })(),
          timedOut,
        ]);
      } catch (err) {
        if (err instanceof BrowserSessionTimedOut) {
          input.log.warn('browser session timed out — force-closing browser', {
            module: input.module,
            timeoutMs: limits.sessionMs,
            browserLaunched: close !== undefined,
          });
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        await closeOnce();
      }
    };
    // The queue is shared by sessions answering different types, so each
    // session settles its own promise rather than the queue's.
    return new Promise<T>((resolve, reject) => {
      void queue.enqueue(() => session().then(resolve, reject));
    });
  };
}
