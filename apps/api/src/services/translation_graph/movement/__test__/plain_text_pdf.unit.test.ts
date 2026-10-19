import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderPlainTextPdf } from '../plain_text_pdf';

// The goldens are shared with the Rust renderer (crates/lf/src/plain_pdf.rs):
// both sides must produce these exact bytes. Regenerate with UPDATE_GOLDEN=1
// on this side, then run the Rust tests to see the other agree.
const FIXTURES = join(__dirname, '../../../../../../../crates/lf/tests/plain_pdf_golden');
const names = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.txt'))
  .map((file) => file.slice(0, -'.txt'.length));

// A real reader (pdf.js) cannot load under jest's VM; the reader check against
// Chromium's output is the script in the n-pdf CHANGELOG entry's recipe.
function read(bytes: Buffer): { pages: number; text: string } {
  const raw = bytes.toString('latin1');
  expect(raw.startsWith('%PDF-1.4\n')).toBe(true);
  expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
  const pages = (raw.match(/\/Type \/Page /g) ?? []).length;
  const text = [...raw.matchAll(/\((.*)\) Tj/g)].map((m) => m[1]).join('\n');
  return { pages, text };
}

describe('renderPlainTextPdf', () => {
  it.each(names)('%s renders the golden bytes', (name) => {
    const bytes = renderPlainTextPdf(readFileSync(join(FIXTURES, `${name}.txt`), 'utf8'));
    if (process.env.UPDATE_GOLDEN) writeFileSync(join(FIXTURES, `${name}.pdf`), bytes);
    expect(bytes.equals(readFileSync(join(FIXTURES, `${name}.pdf`)))).toBe(true);
  });

  it('is a PDF a reader can open, with the composed text in it', () => {
    const { pages, text } = read(renderPlainTextPdf('Hello (world)\nsecond line'));
    expect(pages).toBe(1);
    expect(text).toContain('Hello \\(world\\)');
    expect(text).toContain('second line');
  });

  it('breaks into pages at 49 lines', () => {
    const forty = Array.from({ length: 49 }, (_, i) => `line ${i}`).join('\n');
    expect(read(renderPlainTextPdf(forty)).pages).toBe(1);
    expect(read(renderPlainTextPdf(`${forty}\nmore`)).pages).toBe(2);
  });

  it('prints a character Helvetica lacks as a question mark', () => {
    const { text } = read(renderPlainTextPdf('a 中 b'));
    expect(text).toContain('a ? b');
  });
});
