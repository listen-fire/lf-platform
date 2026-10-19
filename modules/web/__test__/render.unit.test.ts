// `web.render`: text or HTML drawn as a PDF by the host's browser. Held here
// against a fake browser slot that records the page it was given and answers a
// PDF; the real Chromium run is in apps/api (chromium_render.unit.test.ts).

import type { BrowserPage, BrowserSlot } from 'movement-engine/public/browser';

import { emptyBrowserSlot } from 'movement-engine/public/browser';
import { noCredential, pluginsInProcess, refusingFiles, refusingKv } from 'module-kit';

import { webModule } from '../index';
import { looksLikeHtml, pageOf } from '../render';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

interface Drawn {
  html: string;
  pdf: Parameters<BrowserPage['pdf']>[0];
}

/** A slot whose page remembers what it was asked to draw. */
function fakeSlot(): { slot: BrowserSlot; drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  const slot: BrowserSlot = {
    module: 'fake-browser',
    async withPage(fn) {
      let html = '';
      const page = {
        setContent: async (content: string) => {
          html = content;
        },
        pdf: async (options: Drawn['pdf']) => {
          drawn.push({ html, pdf: options });
          return Buffer.from('%PDF-1.4 fake');
        },
      } as unknown as BrowserPage;
      return fn(page, { close: async () => undefined });
    },
  };
  return { slot, drawn };
}

function render(browser: BrowserSlot, config: Record<string, unknown>) {
  const web = pluginsInProcess(webModule, {
    tenant: 't',
    credential: noCredential('none'),
    log: quiet,
    files: refusingFiles('none'),
    kv: refusingKv('none'),
    browser,
    validateResults: true,
  });
  return web.invoke({ name: 'render', config, extractedContext: {} });
}

describe('web.render', () => {
  it('is declared by @lf/web beside the six older plugins, with the call shape of pdf.render', () => {
    const declared = webModule.plugins.map((p) => p.signature.name);
    expect(declared).toContain('render');
    const signature = webModule.plugins.find((p) => p.signature.name === 'render')?.signature;
    expect(signature?.params.map((p) => p.name)).toEqual(['text', 'pageSize', 'margin']);
  });

  it('answers the browser\'s PDF as a file for the host to store', async () => {
    const { slot } = fakeSlot();
    const answer = await render(slot, { text: 'hello' });
    expect(answer.files?.value?.contentType).toBe('application/pdf');
    expect(Buffer.from(answer.files?.value?.base64 ?? '', 'base64').toString()).toContain('%PDF');
  });

  // The characters reach the browser untouched and in a UTF-8 page, so what
  // prints is the browser's fonts, not a substitution here.
  it.each([
    ['Latin', 'Zürich café Ærø'],
    ['CJK', '東京 北京 서울 ひらがな'],
    ['emoji and symbols', '🚀 ✓ ★ ₿ ∑ → ☂'],
    ['Arabic (shaping is the browser\'s)', 'مرحبا بالعالم'],
  ])('puts %s text on the page whole, with no "?" substituted', async (_name, text) => {
    const { slot, drawn } = fakeSlot();
    await render(slot, { text });
    expect(drawn).toHaveLength(1);
    expect(drawn[0].html).toContain(text);
    expect(drawn[0].html).toContain('<meta charset="utf-8">');
    expect(drawn[0].html).not.toContain('?');
  });

  it('keeps plain text\'s line breaks and escapes its markup characters', async () => {
    const { slot, drawn } = fakeSlot();
    await render(slot, { text: 'a < b\nline & two\n\tindented' });
    expect(drawn[0].html).toContain('white-space:pre-wrap');
    expect(drawn[0].html).toContain('a &lt; b\nline &amp; two\n\tindented');
  });

  it('draws HTML as a page, keeping its markup and locking script out', async () => {
    const { slot, drawn } = fakeSlot();
    await render(slot, { text: '<html><head><title>t</title></head><body><h1>Subject</h1><p>Hi <b>there</b></p></body></html>' });
    expect(drawn[0].html).toContain('<h1>Subject</h1><p>Hi <b>there</b></p>');
    expect(drawn[0].html).not.toContain('white-space:pre-wrap');
    expect(drawn[0].html).toContain("default-src 'none'");
  });

  it('wraps an HTML fragment (an email body) in a document', async () => {
    const { slot, drawn } = fakeSlot();
    await render(slot, { text: '<div>Dear <b>Ann</b>,</div><br>Thanks' });
    expect(drawn[0].html).toMatch(/^<!doctype html><html><head>.*<\/head><body><div>Dear <b>Ann<\/b>,<\/div><br>Thanks<\/body><\/html>$/);
  });

  it('does not take a comparison or an address in angle brackets for HTML', () => {
    expect(looksLikeHtml('if a < b and c > d')).toBe(false);
    expect(looksLikeHtml('Ann <ann@example.com> wrote')).toBe(false);
    expect(looksLikeHtml('x<y')).toBe(false);
    expect(pageOf('Ann <ann@example.com> wrote')).toContain('Ann &lt;ann@example.com&gt; wrote');
  });

  it('takes a page size and a margin in points, and refuses ones it does not know', async () => {
    const { slot, drawn } = fakeSlot();
    await render(slot, { text: 'x', pageSize: 'letter', margin: 72 });
    expect(drawn[0].pdf).toMatchObject({ format: 'Letter', margin: { top: '1.0000in', left: '1.0000in' } });
    await render(slot, { text: 'x' });
    expect(drawn[1].pdf).toMatchObject({ format: 'A4', margin: { top: `${(30 / 72).toFixed(4)}in` } });
    await expect(render(slot, { text: 'x', pageSize: 'a3' })).rejects.toThrow('pageSize is "a4" or "letter"');
    await expect(render(slot, { text: 'x', margin: 201 })).rejects.toThrow('margin is a whole number of points');
  });

  it('is refused by name when the browser slot is empty, with no other writer to fall back on', async () => {
    const empty = emptyBrowserSlot('this host has no browser to lend its modules');
    await expect(render(empty, { text: 'hello' })).rejects.toThrow(
      "@lf/web: render needs a browser, and the host's browser slot is empty (this host has no browser to lend its modules)",
    );
  });
});
