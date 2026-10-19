// A scripted page for tests: the browser slot filled with no browser. A test
// describes the site (`FakeSite`) — what each address shows, which elements a
// selector finds, what a click or a fill does — and the fake answers the
// page interface from that description. Nothing runs script and nothing is
// drawn (`evaluate` refuses): a screenshot is a 1×1 PNG, a PDF a minimal one, and every wait
// returns at once (`waited` adds up what the code under test asked to wait).

import {
  boundedSessions,
  BROWSER_LIMITS,
  type BrowserBox,
  type BrowserDownload,
  type BrowserLimits,
  type BrowserLocator,
  type BrowserPage,
  type BrowserRoute,
  type BrowserSlot,
} from './browser';

/** One element as the site shows it now. */
export interface FakeElement {
  text?: string;
  html?: string;
  /** Default true. */
  visible?: boolean;
  /** Default true. */
  enabled?: boolean;
  /** Default 800×600 at the origin, when visible. */
  box?: BrowserBox;
  attributes?: Readonly<Record<string, string>>;
  screenshot?(): Buffer;
  click?(): void;
  fill?(value: string): void;
  press?(key: string): void;
}

/** The document at one address: read afresh on every query, so a click
 *  that changes the site's state changes what the next query finds. */
export interface FakeDocument {
  title(): string;
  /** The elements `selector` finds. `getByRole('button', { name: 'Go' })`
   *  asks for `role=button[name="Go"]`, `getByTestId('x')` for `testid=x`,
   *  `getByLabel('Next')` for `label=Next`; a locator inside another
   *  asks for `outer >> inner`. */
  query(selector: string): FakeElement[];
  download?(): BrowserDownload;
  press?(key: string): void;
}

export interface FakeSite {
  /** The document at `url`; refuse an address the site does not serve. */
  open(url: string): FakeDocument;
}

/** The smallest valid PNG: one transparent pixel. */
export const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const MINIMAL_PDF = Buffer.from('%PDF-1.4\n%fake\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');

const DEFAULT_BOX: BrowserBox = { x: 0, y: 0, width: 800, height: 600 };

class FakeLocator implements BrowserLocator {
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
    private readonly pick: 'all' | number | 'first' = 'all',
  ) {}

  private elements(): FakeElement[] {
    const found = this.page.document().query(this.selector);
    if (this.pick === 'all') return found;
    const one = this.pick === 'first' ? found[0] : found[this.pick];
    return one === undefined ? [] : [one];
  }

  private one(action: string): FakeElement {
    const found = this.elements()[0];
    if (found === undefined) throw new Error(`fake page: ${action}: no element matches ${this.selector}`);
    return found;
  }

  locator(selector: string): BrowserLocator {
    return new FakeLocator(this.page, `${this.selector} >> ${selector}`);
  }
  nth(index: number): BrowserLocator {
    return new FakeLocator(this.page, this.selector, index);
  }
  first(): BrowserLocator {
    return new FakeLocator(this.page, this.selector, 'first');
  }
  filter(): BrowserLocator {
    throw new Error('fake page: filter is not scripted');
  }
  async all(): Promise<BrowserLocator[]> {
    return this.elements().map((_, i) => new FakeLocator(this.page, this.selector, i));
  }
  async count(): Promise<number> {
    return this.elements().length;
  }

  async click(): Promise<void> {
    const element = this.one('click');
    if (element.visible === false) throw new Error(`fake page: click: ${this.selector} is not visible`);
    element.click?.();
  }
  async fill(value: string): Promise<void> {
    this.one('fill').fill?.(value);
  }
  async press(key: string): Promise<void> {
    this.one('press').press?.(key);
  }
  async check(): Promise<void> {
    this.one('check').click?.();
  }
  async uncheck(): Promise<void> {
    this.one('uncheck').click?.();
  }
  async scrollIntoViewIfNeeded(): Promise<void> {
    this.one('scrollIntoViewIfNeeded');
  }
  async waitFor(options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden' }): Promise<void> {
    const state = options?.state ?? 'visible';
    const element = this.elements()[0];
    const visible = element !== undefined && element.visible !== false;
    const met =
      state === 'attached' ? element !== undefined : state === 'detached' ? element === undefined : state === 'visible' ? visible : !visible;
    if (!met) throw new Error(`fake page: waitFor: ${this.selector} never became ${state}`);
  }

  async isVisible(): Promise<boolean> {
    const element = this.elements()[0];
    return element !== undefined && element.visible !== false;
  }
  async isEnabled(): Promise<boolean> {
    return this.one('isEnabled').enabled !== false;
  }
  async isDisabled(): Promise<boolean> {
    return this.one('isDisabled').enabled === false;
  }
  async boundingBox(): Promise<BrowserBox | null> {
    const element = this.elements()[0];
    if (element === undefined || element.visible === false) return null;
    return element.box ?? DEFAULT_BOX;
  }
  async getAttribute(name: string): Promise<string | null> {
    return this.one('getAttribute').attributes?.[name] ?? null;
  }
  async textContent(): Promise<string | null> {
    return this.one('textContent').text ?? null;
  }
  async innerHTML(): Promise<string> {
    return this.one('innerHTML').html ?? '';
  }
  async screenshot(): Promise<Buffer> {
    const element = this.one('screenshot');
    return element.screenshot?.() ?? ONE_PIXEL_PNG;
  }

  async evaluate(): Promise<never> {
    throw new Error(`fake page: evaluate on ${this.selector} is not scripted`);
  }
  async evaluateAll(): Promise<never> {
    throw new Error(`fake page: evaluateAll on ${this.selector} is not scripted`);
  }
}

class FakePage implements BrowserPage {
  private current: { url: string; document: FakeDocument } | undefined;
  /** Milliseconds the code under test asked to wait. */
  waited = 0;
  readonly routes: string[] = [];

  constructor(private readonly site: FakeSite) {}

  document(): FakeDocument {
    if (this.current === undefined) throw new Error('fake page: nothing was opened (goto first)');
    return this.current.document;
  }

  async goto(url: string): Promise<null> {
    this.current = { url, document: this.site.open(url) };
    return null;
  }
  url(): string {
    return this.current?.url ?? 'about:blank';
  }
  async title(): Promise<string> {
    return this.current?.document.title() ?? '';
  }
  async setContent(): Promise<void> {
    throw new Error('fake page: setContent is not scripted');
  }
  async setViewportSize(): Promise<void> {}

  locator(selector: string): BrowserLocator {
    return new FakeLocator(this, selector);
  }
  getByRole(role: string, options?: { name?: string | RegExp }): BrowserLocator {
    return new FakeLocator(this, options?.name === undefined ? `role=${role}` : `role=${role}[name="${String(options.name)}"]`);
  }
  getByTestId(testId: string | RegExp): BrowserLocator {
    return new FakeLocator(this, `testid=${String(testId)}`);
  }
  getByLabel(text: string | RegExp): BrowserLocator {
    return new FakeLocator(this, `label=${String(text)}`);
  }
  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      this.document().press?.(key);
    },
  };

  async waitForTimeout(ms: number): Promise<void> {
    this.waited += ms;
  }
  async waitForLoadState(): Promise<void> {}
  async waitForSelector(selector: string): Promise<null> {
    if (this.document().query(selector).length === 0) throw new Error(`fake page: waitForSelector: nothing matches ${selector}`);
    return null;
  }
  async waitForFunction(): Promise<null> {
    return null;
  }
  async waitForEvent(): Promise<BrowserDownload> {
    const download = this.document().download?.();
    if (download === undefined) throw new Error('fake page: no download is scripted');
    return download;
  }
  async route(url: string, _handler: (route: BrowserRoute) => unknown): Promise<void> {
    this.routes.push(url);
  }

  async evaluate(): Promise<never> {
    throw new Error('fake page: evaluate is not scripted (nothing runs script here)');
  }

  async screenshot(): Promise<Buffer> {
    return ONE_PIXEL_PNG;
  }
  async pdf(): Promise<Buffer> {
    return MINIMAL_PDF;
  }
}

export interface FakeBrowser {
  slot: BrowserSlot;
  /** Every page a session opened, in order. */
  pages: FakePage[];
  /** Sessions whose browser was closed. */
  closed(): number;
}

/** The slot filled by the fake, under the slot's own session limits. */
export function fakeBrowser(site: FakeSite, limits: BrowserLimits = BROWSER_LIMITS): FakeBrowser {
  const pages: FakePage[] = [];
  let closed = 0;
  const withPage = boundedSessions<BrowserPage>({
    module: 'fake-browser',
    limits,
    log: { warn: () => undefined },
    open: async (_options, adopt) => {
      adopt(async () => {
        closed += 1;
      });
      const page = new FakePage(site);
      pages.push(page);
      return page;
    },
  });
  return { slot: { module: 'fake-browser', withPage }, pages, closed: () => closed };
}

export type { FakePage };
