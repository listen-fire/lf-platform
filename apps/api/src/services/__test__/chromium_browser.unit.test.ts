// `@lf/chromium`, the platform's browser slot, held to the slot's contract
// against a page served on loopback; and the empty slot of the slim image.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';

import { documentReader } from '@listen-fire/web';
import { BrowserSlotEmpty, type BrowserSlot } from 'movement-engine/public/browser';
import { browserContractCases, type ContractSite } from 'movement-engine/public/testing';
import { chromiumSlot, platformBrowser } from '../playwright';

const PAGE = '<!doctype html><html><head><title>Browser contract</title></head><body><h1>Hello</h1></body></html>';

async function chromiumInstalled(): Promise<boolean> {
  const { chromium } = await import('playwright');
  return existsSync(chromium.executablePath());
}

describe('@lf/chromium (the platform browser slot)', () => {
  let server: Server;
  let site: ContractSite;
  let installed = false;

  beforeAll(async () => {
    installed = await chromiumInstalled();
    server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    site = { url: `http://127.0.0.1:${port}/`, title: 'Browser contract', heading: 'Hello' };
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  for (const contractCase of browserContractCases) {
    it(contractCase.name, async () => {
      // Without a Chromium build for this Playwright (`pnpm exec playwright
      // install chromium`), the slot cannot be held to anything: say so.
      if (!installed) throw new Error('no Chromium is installed for this Playwright; run `pnpm exec playwright install chromium` in apps/api');
      // The contract's limits are its own; the pages are Chromium's, opened
      // exactly as the platform's slot opens them.
      await contractCase.run((limits) => chromiumSlot(limits), site);
    }, 60_000);
  }
});

// A BriefLink deck as the source's crawler meets it: an email form, then a
// gallery of three slides with a next button disabled on the last.
const BRIEFLINK = `<!doctype html><html><head><title>Acme Seed Deck</title></head><body>
<form id="gate" onsubmit="event.preventDefault(); this.remove(); show();">
  <input name="email"><button type="submit">View</button>
</form>
<div class="DeckGalleryPageContainer" style="display:none;width:640px;height:360px;background:#246"><h1 id="n"></h1></div>
<button class="Button Right" style="display:none" onclick="next()">next</button>
<script>
  let slide = 1;
  function show() {
    document.querySelector('.DeckGalleryPageContainer').style.display = 'block';
    document.querySelector('.Button.Right').style.display = 'inline';
    render();
  }
  function render() {
    document.getElementById('n').textContent = 'Slide ' + slide;
    document.querySelector('.Button.Right').disabled = slide === 3;
  }
  function next() { slide += 1; render(); }
</script></body></html>`;

/** The platform's Chromium, with brieflink.com answered from this test. */
function chromiumServingBrieflink(): BrowserSlot {
  const slot = chromiumSlot({ concurrent: 1, sessionMs: 120_000, closeMs: 10_000 });
  return {
    module: slot.module,
    withPage: (fn, options) =>
      slot.withPage(async (page, session) => {
        await page.route('https://brieflink.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: BRIEFLINK }));
        return fn(page, session);
      }, options),
  };
}

describe('a gated source read through @lf/chromium', () => {
  it('reads a BriefLink deck behind its email form into a PDF of its three slides', async () => {
    if (!(await chromiumInstalled())) throw new Error('no Chromium is installed for this Playwright; run `pnpm exec playwright install chromium` in apps/api');
    const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
    const reader = documentReader({
      browser: chromiumServingBrieflink(),
      log: quiet,
      fetch,
      vision: async () => {
        throw new Error('the AI fallback is not expected here');
      },
      deckName: async () => null,
      alert: async () => undefined,
      keepScreenshot: async () => '',
      reportError: () => undefined,
      googleDriveApiKey: () => {
        throw new Error('no key');
      },
    });

    const pdf = await reader.getUrlAsPdfStream('https://brieflink.com/v/acme-seed', { email: 'ada@acme.test' });

    expect(pdf?.name).toBe('Acme Seed Deck.pdf');
    const chunks: Buffer[] = [];
    for await (const chunk of pdf!.data) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.toString('latin1').match(/\/Type \/Page\b/g)?.length).toBe(3);
  }, 120_000);
});

describe('the platform browser slot on the slim image', () => {
  const original = process.env.LISTEN_FIRE_IMAGE_VARIANT;
  afterEach(() => {
    if (original === undefined) delete process.env.LISTEN_FIRE_IMAGE_VARIANT;
    else process.env.LISTEN_FIRE_IMAGE_VARIANT = original;
  });

  it('is empty, and refuses a page naming the slot and the image that fills it', async () => {
    process.env.LISTEN_FIRE_IMAGE_VARIANT = 'slim';
    expect(platformBrowser.emptyBecause).toMatch(/api-slim image/);
    const attempt = platformBrowser.withPage(async () => 1);
    await expect(attempt).rejects.toBeInstanceOf(BrowserSlotEmpty);
    await expect(attempt).rejects.toThrow(/the browser slot is empty: .*ghcr\.io\/listen-fire\/api,/);
  });

  it('is filled on the api image', () => {
    delete process.env.LISTEN_FIRE_IMAGE_VARIANT;
    expect(platformBrowser.emptyBecause).toBeUndefined();
  });
});
