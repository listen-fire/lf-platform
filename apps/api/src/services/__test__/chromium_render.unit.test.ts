// `web.render` through the platform's real browser slot (`@lf/chromium`): the
// PDF it prints holds the text it was given, in any script the machine's fonts
// cover, and an HTML email keeps its content. Needs a Chromium build for this
// Playwright (`pnpm exec playwright install chromium` in apps/api).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { webModule } from '@listen-fire/web';
import { BROWSER_LIMITS } from 'movement-engine/public/browser';
import { noCredential, pluginsInProcess, refusingFiles, refusingKv } from 'module-kit';

import { chromiumSlot } from '../playwright';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function chromiumInstalled(): Promise<boolean> {
  const { chromium } = await import('playwright');
  return existsSync(chromium.executablePath());
}

// The PDF's text layer, read outside jest: unpdf's loader needs
// --experimental-vm-modules, which this runner does not run under.
const READ_TEXT =
  "const { extractText } = require('unpdf');" +
  "let b = Buffer.alloc(0); process.stdin.on('data', (c) => (b = Buffer.concat([b, c])));" +
  "process.stdin.on('end', async () => { const r = await extractText(new Uint8Array(b), { mergePages: true }); process.stdout.write(r.text); });";

function textOf(base64: string): string {
  return execFileSync(process.execPath, ['-e', READ_TEXT], { cwd: resolve(__dirname, '../../..'), input: Buffer.from(base64, 'base64') }).toString();
}

describe('web.render over @lf/chromium', () => {
  const web = pluginsInProcess(webModule, {
    tenant: 't',
    credential: noCredential('none'),
    log: quiet,
    files: refusingFiles('none'),
    kv: refusingKv('none'),
    browser: chromiumSlot(BROWSER_LIMITS),
    validateResults: true,
  });
  const render = (config: Record<string, unknown>) => web.invoke({ name: 'render', config, extractedContext: {} });

  const need = async (): Promise<void> => {
    if (!(await chromiumInstalled())) throw new Error('no Chromium is installed for this Playwright; run `pnpm exec playwright install chromium` in apps/api');
  };

  it('prints plain Latin text, and a Latin-1 accent survives', async () => {
    await need();
    const answer = await render({ text: 'Quarterly update\nZürich café' });
    expect(answer.files?.value?.contentType).toBe('application/pdf');
    const text = textOf(answer.files?.value?.base64 ?? '');
    expect(text).toContain('Quarterly update');
    expect(text).toContain('Zürich café');
  }, 60_000);

  it('prints HTML as a page: its text is there and its tags are not', async () => {
    await need();
    const answer = await render({ text: '<html><body><h1>Subject line</h1><p>Hello <b>Ann</b>, thanks.</p><script>document.body.innerHTML="gone"</script></body></html>' });
    const text = textOf(answer.files?.value?.base64 ?? '');
    expect(text).toContain('Subject line');
    expect(text).toContain('Hello Ann');
    expect(text).not.toContain('<h1>');
    expect(text).not.toContain('gone');
  }, 60_000);

  // What prints depends on the fonts the machine has; this one asserts only
  // that the call succeeds and returns a PDF for text outside Latin-1.
  it('prints CJK, emoji and Arabic without refusing or substituting "?" for the whole text', async () => {
    await need();
    const answer = await render({ text: '東京 🚀 ✓ مرحبا' });
    expect(Buffer.from(answer.files?.value?.base64 ?? '', 'base64').subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);
});
