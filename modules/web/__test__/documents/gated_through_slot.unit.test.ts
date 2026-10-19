// One gated source driven end to end through the browser slot, with a
// scripted page in place of a browser: a BriefLink deck behind an email form,
// three slides, a next button that is disabled on the last. Read once
// through the reader (what the platform calls), once through the module's
// own fetch-url with the slot filled by the host (what an embedder lending a
// browser gets), and once with the slot empty.

import { noCredential, pluginsInProcess, refusingKv, type ModuleFiles } from 'module-kit';
import type { FileRef } from 'engine-contracts';
import { fakeBrowser, type FakeDocument, type FakeSite } from 'movement-engine/public/testing';

import { webModule } from '../../index';
import { documentReader } from '../../documents/reader';
import { readerHost } from './reader_host';

const DECK_URL = 'https://brieflink.com/v/acme-seed';
const SLIDES = 3;

/** BriefLink as the crawler sees it: an email form, then a gallery. */
function brieflinkSite(): FakeSite & { typed: string[] } {
  const typed: string[] = [];
  let authenticated = false;
  let slide = 0;
  const document: FakeDocument = {
    title: () => 'Acme Seed Deck',
    query(selector) {
      switch (selector) {
        case 'input[name="email"]':
          return authenticated ? [] : [{ fill: (value) => void typed.push(value) }];
        case 'input[name="passcode"]':
          return [];
        case 'button[type="submit"]':
          return authenticated ? [] : [{ click: () => (authenticated = true) }];
        case '.DeckGalleryPageContainer':
          return authenticated ? [{ box: { x: 0, y: 0, width: 1024, height: 576 } }] : [];
        case 'button.Button.Right':
          return [{ enabled: slide < SLIDES - 1, click: () => (slide += 1) }];
        default:
          return [];
      }
    },
  };
  return {
    typed,
    open(url) {
      if (url !== DECK_URL) throw new Error(`fake BriefLink: nothing at ${url}`);
      return document;
    },
  };
}

async function bytesOf(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The pages of a PDF jsPDF wrote. */
function pageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
}

describe('a gated source through the browser slot', () => {
  it('reads a BriefLink deck behind its email form into a PDF of its slides', async () => {
    const site = brieflinkSite();
    const browser = fakeBrowser(site);
    const reader = documentReader(readerHost(browser.slot));

    const pdf = await reader.getUrlAsPdfStream(DECK_URL, { email: 'ada@acme.test' });

    expect(pdf).not.toBeNull();
    expect(pdf?.name).toBe('Acme Seed Deck.pdf');
    const bytes = await bytesOf(pdf!.data);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(bytes)).toBe(SLIDES);
    expect(site.typed).toEqual(['ada@acme.test']);
    expect(browser.closed()).toBe(1);
  });

  it('refuses a deck that asks for an email when none was given, saying so', async () => {
    const reader = documentReader(readerHost(fakeBrowser(brieflinkSite()).slot));
    await expect(reader.getUrlAsPdfStream(DECK_URL, {})).rejects.toThrow('This BriefLink needs an email to view');
  });

  it('serves fetch-url from the module, keeping the deck in the host files', async () => {
    const site = brieflinkSite();
    const kept: Array<{ name?: string; contentType?: string; size: number }> = [];
    const files: ModuleFiles = {
      put: async ({ bytes, name, contentType }): Promise<FileRef> => {
        kept.push({ ...(name !== undefined ? { name } : {}), ...(contentType !== undefined ? { contentType } : {}), size: bytes.length });
        return { __brand: 'FileRef', name: name ?? 'file', contentType: contentType ?? 'application/octet-stream', size: bytes.length, url: 'https://files.test/deck.pdf' };
      },
      read: async () => {
        throw new Error('not read in this test');
      },
      expose: async () => ({ url: 'https://files.test/deck.pdf' }),
    };
    const web = pluginsInProcess(webModule, {
      tenant: 't',
      credential: noCredential('none'),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      files,
      kv: refusingKv('none'),
      browser: fakeBrowser(site).slot,
      validateResults: true,
    });

    const answer = await web.invoke({ name: 'fetch-url', config: { url: DECK_URL, email: 'ada@acme.test' }, extractedContext: {} });

    expect(kept).toEqual([{ name: 'Acme Seed Deck.pdf', contentType: 'application/pdf', size: expect.any(Number) }]);
    expect(JSON.stringify(answer)).toContain('https://files.test/deck.pdf');
  });
});
