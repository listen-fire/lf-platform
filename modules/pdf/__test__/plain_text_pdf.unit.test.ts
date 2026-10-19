import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderPlainTextPdf } from '../plain_text_pdf';

// Regenerate the goldens with UPDATE_GOLDEN=1, and read the diff.
const FIXTURES = join(__dirname, '__fixtures__');
const names = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.txt'))
  .map((file) => file.slice(0, -'.txt'.length));

// A real reader (pdf.js) cannot load under jest's VM, so the structure is read
// off the bytes.
function read(bytes: Buffer): { pages: number; text: string; mediaBox: string } {
  const raw = bytes.toString('latin1');
  expect(raw.startsWith('%PDF-1.4\n')).toBe(true);
  expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
  const pages = (raw.match(/\/Type \/Page /g) ?? []).length;
  const text = [...raw.matchAll(/\((.*)\) Tj/g)].map((m) => m[1]).join('\n');
  return { pages, text, mediaBox: /\/MediaBox \[([^\]]*)\]/.exec(raw)?.[1] ?? '' };
}

describe('renderPlainTextPdf', () => {
  it.each(names)('%s renders the golden bytes', (name) => {
    const { bytes } = renderPlainTextPdf(readFileSync(join(FIXTURES, `${name}.txt`), 'utf8'));
    if (process.env.UPDATE_GOLDEN) writeFileSync(join(FIXTURES, `${name}.pdf`), bytes);
    expect(bytes.equals(readFileSync(join(FIXTURES, `${name}.pdf`)))).toBe(true);
  });

  it('is a PDF a reader can open, with the composed text in it', () => {
    const { pages, text } = read(renderPlainTextPdf('Hello (world)\nsecond line').bytes);
    expect(pages).toBe(1);
    expect(text).toContain('Hello \\(world\\)');
    expect(text).toContain('second line');
  });

  it('breaks into pages at 49 lines', () => {
    const forty = Array.from({ length: 49 }, (_, i) => `line ${i}`).join('\n');
    expect(read(renderPlainTextPdf(forty).bytes).pages).toBe(1);
    expect(read(renderPlainTextPdf(`${forty}\nmore`).bytes).pages).toBe(2);
  });

  it('prints a character Helvetica lacks as a question mark, and says which', () => {
    const { bytes, lacking } = renderPlainTextPdf('a 中 b 中 c 😀');
    expect(read(bytes).text).toContain('a ? b ? c ?');
    expect(lacking).toEqual(['中', '😀']);
  });

  it('lacks nothing for Latin-1 and Windows-1252 punctuation', () => {
    expect(renderPlainTextPdf('café “quoted” — €5 ñ').lacking).toEqual([]);
  });

  it('sets a letter page when asked, and a wider margin fits fewer lines', () => {
    expect(read(renderPlainTextPdf('x', { pageSize: 'letter', margin: 30 }).bytes).mediaBox).toBe('0 0 612.00 792.00');
    const lines = Array.from({ length: 49 }, (_, i) => `line ${i}`).join('\n');
    expect(read(renderPlainTextPdf(lines, { pageSize: 'a4', margin: 60 }).bytes).pages).toBe(2);
  });
});
