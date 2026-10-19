// Plain text → PDF with no browser and no dependency: the layout the
// Chromium path produced for `FILE(content, "pdf")` (a `<pre>` of sans-serif
// 14px text on A4 with 30pt of margin all round, 1.5 line height, wrapped at
// the page edge), written as the PDF's own text operators in Helvetica.
//
// The Rust `lf` has the same renderer (crates/lf/src/plain_pdf.rs). The two
// are kept byte-identical by the shared golden files under
// crates/lf/tests/plain_pdf_golden, which each side's tests render and
// compare. Every measure is an integer so no rounding can differ.
//
// Text is Helvetica in WinAnsi, so a character outside Latin-1 and the
// Windows-1252 punctuation prints as "?" (the browser fell back to whatever
// font the host had; the slim image has none for CJK or emoji).

/** Helvetica advance widths (1/1000 em) for WinAnsi bytes 32..=255; 0 marks a byte WinAnsi leaves undefined. */
const WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 222, 222, 222, 222, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/** Windows-1252's 0x80..0x9F, which Unicode places elsewhere. */
const CP1252_HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

// 1/100 pt. A4, 30pt margins (16px page margin + 24px body padding), 10.5pt
// type on a 15.75pt line, the baseline 11.51pt under its line's top.
const PAGE_WIDTH = 59528;
const PAGE_HEIGHT = 84189;
const MARGIN = 3000;
const LINE = 1575;
const BASELINE = 1151;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE);
const FONT_SIZE = 1050;
/** The text column, in 1/1000 em at the font size. */
const COLUMN = Math.floor(((PAGE_WIDTH - 2 * MARGIN) * 1000) / FONT_SIZE);
const TAB_COLUMNS = 8;
const SPACE = 0x20;

function winAnsi(codePoint: number): number | undefined {
  if (codePoint >= 0x20 && codePoint < 0x7f) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  const high = CP1252_HIGH.get(codePoint);
  if (high !== undefined) return high;
  if (codePoint === 0x2212) return 0x2d;
  return undefined;
}

function isInvisible(codePoint: number): boolean {
  return (codePoint >= 0x200b && codePoint <= 0x200f) || codePoint === 0xfeff || codePoint === 0xfe0f;
}

/** One WinAnsi byte per printed character; a newline stays 0x0a. */
function toBytes(text: string): number[] {
  const bytes: number[] = [];
  let column = 0;
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint === 0x0a) {
      bytes.push(0x0a);
      column = 0;
    } else if (codePoint === 0x09) {
      const fill = TAB_COLUMNS - (column % TAB_COLUMNS);
      for (let i = 0; i < fill; i++) bytes.push(SPACE);
      column += fill;
    } else if (codePoint < 0x20 || isInvisible(codePoint)) {
      continue;
    } else {
      const byte = winAnsi(codePoint);
      const printed = byte !== undefined && WIDTHS[byte - 32] !== 0 ? byte : 0x3f;
      bytes.push(printed);
      column += 1;
    }
  }
  return bytes;
}

function advance(byte: number): number {
  return WIDTHS[byte - 32] ?? 0;
}

/** `white-space: pre-wrap; overflow-wrap: break-word`: spaces are kept, a run
 *  of them that crosses the edge hangs there, a word that does not fit moves
 *  to a new line, and a word longer than a line is broken at the edge. */
function wrap(bytes: readonly number[]): number[][] {
  const lines: number[][] = [];
  const body = bytes[bytes.length - 1] === 0x0a ? bytes.slice(0, -1) : bytes;
  let start = 0;
  for (let end = 0; end <= body.length; end++) {
    if (end === body.length || body[end] === 0x0a) {
      wrapParagraph(body.slice(start, end), lines);
      start = end + 1;
    }
  }
  return lines;
}

function wrapParagraph(paragraph: readonly number[], lines: number[][]): void {
  let line: number[] = [];
  let used = 0;
  let i = 0;
  while (i < paragraph.length) {
    const spaces = paragraph[i] === SPACE;
    let j = i;
    while (j < paragraph.length && (paragraph[j] === SPACE) === spaces) j++;
    const run = paragraph.slice(i, j);
    const width = run.reduce((sum, byte) => sum + advance(byte), 0);
    i = j;
    if (spaces) {
      line.push(...run);
      used += width;
      continue;
    }
    if (used + width > COLUMN && line.some((byte) => byte !== SPACE)) {
      lines.push(line);
      line = [];
      used = 0;
    }
    if (width <= COLUMN) {
      line.push(...run);
      used += width;
      continue;
    }
    for (const byte of run) {
      const w = advance(byte);
      if (used + w > COLUMN && line.length > 0) {
        lines.push(line);
        line = [];
        used = 0;
      }
      line.push(byte);
      used += w;
    }
  }
  lines.push(line);
}

function hundredths(value: number): string {
  return `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

function escapeString(bytes: readonly number[]): string {
  return bytes
    .map((byte) => {
      if (byte === 0x28 || byte === 0x29 || byte === 0x5c) return `\\${String.fromCharCode(byte)}`;
      return byte < 0x7f ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, '0')}`;
    })
    .join('');
}

function pageContent(lines: readonly (readonly number[])[]): string {
  const operations = ['BT', '/F1 10.5 Tf', '0.133 g'];
  lines.forEach((line, index) => {
    if (line.length === 0) return;
    const y = PAGE_HEIGHT - MARGIN - BASELINE - index * LINE;
    operations.push(`1 0 0 1 ${hundredths(MARGIN)} ${hundredths(y)} Tm (${escapeString(line)}) Tj`);
  });
  operations.push('ET');
  return operations.join('\n');
}

/** The PDF for `content`, deterministic: the same text gives the same bytes. */
export function renderPlainTextPdf(content: string): Buffer {
  const lines = wrap(toBytes(content));
  const pages: (readonly number[][])[] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  if (pages.length === 0) pages.push([]);

  // Objects: 1 catalog, 2 page tree, 3 font, then a page and its content per page.
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((pageLines, i) => {
    const content = pageContent(pageLines);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${hundredths(PAGE_WIDTH)} ${hundredths(PAGE_HEIGHT)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
