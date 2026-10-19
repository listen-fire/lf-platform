// The browser slot's contract suite: the cases every module filling the slot
// is held to — the built-in `@lf/chromium` against a page served on loopback
// (apps/api), and the scripted fake page the gated-document tests drive
// (fake_browser.ts). Runner-agnostic, as the other slots' suites are: each
// case is a name and an async body that throws on failure (node:assert).

import assert from 'node:assert/strict';
import { BrowserSessionTimedOut, type BrowserLimits, type BrowserSlot } from 'module-runtime/browser';

/** A page the slot under test can open: its address and what it shows. */
export interface ContractSite {
  url: string;
  title: string;
  /** The text of its one `h1`. */
  heading: string;
}

/** A slot under `limits`, over the module being held to the contract. */
export type MakeBrowserSlot = (limits: BrowserLimits) => BrowserSlot;

export interface BrowserContractCase {
  name: string;
  run(make: MakeBrowserSlot, site: ContractSite): Promise<void>;
}

const ROOMY: BrowserLimits = { concurrent: 2, sessionMs: 60_000, closeMs: 10_000 };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const browserContractCases: BrowserContractCase[] = [
  {
    name: 'opens a page at an address and reads it',
    async run(make, site) {
      const read = await make(ROOMY).withPage(async (page) => {
        await page.goto(site.url);
        await page.waitForLoadState('domcontentloaded');
        return { url: page.url(), title: await page.title(), heading: await page.locator('h1').first().textContent() };
      });
      assert.equal(read.url, site.url);
      assert.equal(read.title, site.title);
      assert.equal(read.heading, site.heading);
    },
  },
  {
    name: 'takes a screenshot of the page and of an element, as PNG',
    async run(make, site) {
      const [whole, element] = await make(ROOMY).withPage(async (page) => {
        await page.goto(site.url);
        return [await page.screenshot(), await page.locator('h1').first().screenshot()];
      });
      assert.ok(whole.subarray(0, 8).equals(PNG_MAGIC), 'the page screenshot is a PNG');
      assert.ok(element.subarray(0, 8).equals(PNG_MAGIC), 'the element screenshot is a PNG');
    },
  },
  {
    name: 'renders the page to PDF',
    async run(make, site) {
      const pdf = await make(ROOMY).withPage(async (page) => {
        await page.goto(site.url);
        return page.pdf({ format: 'A4', printBackground: true, margin: { top: '16px', right: '16px', bottom: '16px', left: '16px' } });
      });
      assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    },
  },
  {
    name: 'answers what the session function answers, and passes on what it throws',
    async run(make, site) {
      const slot = make(ROOMY);
      assert.equal(await slot.withPage(async () => 42), 42);
      await assert.rejects(
        slot.withPage(async (page) => {
          await page.goto(site.url);
          throw new Error('the caller gave up');
        }),
        /the caller gave up/,
      );
      // The session that threw gave its place back.
      assert.equal(await slot.withPage(async () => 'again'), 'again');
    },
  },
  {
    name: 'a session closed early by its caller still answers',
    async run(make, site) {
      const answer = await make(ROOMY).withPage(async (page, session) => {
        await page.goto(site.url);
        const title = await page.title();
        await session.close();
        await session.close();
        return title;
      });
      assert.equal(answer, site.title);
    },
  },
  {
    name: 'sessions beyond the limit wait for a place',
    async run(make) {
      const slot = make({ ...ROOMY, concurrent: 1 });
      let open = 0;
      let most = 0;
      const one = () =>
        slot.withPage(async (page) => {
          open += 1;
          most = Math.max(most, open);
          await page.waitForTimeout(50);
          await new Promise((resolve) => setTimeout(resolve, 50));
          open -= 1;
        });
      await Promise.all([one(), one(), one()]);
      assert.equal(most, 1, 'never more than one session at once');
    },
  },
  {
    name: 'a session outliving its limit is refused, and the next one runs',
    async run(make, site) {
      // Long enough for a real browser to launch and load the page in the
      // session after.
      const slot = make({ ...ROOMY, concurrent: 1, sessionMs: 2_000 });
      await assert.rejects(
        slot.withPage(() => new Promise<never>(() => undefined)),
        (err: unknown) => err instanceof BrowserSessionTimedOut,
      );
      const title = await slot.withPage(async (page) => {
        await page.goto(site.url);
        return page.title();
      });
      assert.equal(title, site.title);
    },
  },
];
