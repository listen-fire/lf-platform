// Scanned files for the OCR slot's tests: a picture of text, as a PNG and as
// a PDF that holds only that picture (no text layer: the PDF a screenshot
// tool or a scanner writes). The letters are drawn from a 5×7 bitmap font, so
// a real OCR backend reads them; a fake one never looks.

import { deflateSync } from 'node:zlib';

/** One grey byte per pixel, rows top to bottom; 0 is black. */
export interface GreyImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

// Each glyph: seven rows of five bits, the leftmost pixel the highest bit.
const GLYPHS: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14],
  4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0],
  '-': [0, 0, 0, 31, 0, 0, 0], $: [4, 15, 20, 14, 5, 30, 4], '%': [24, 25, 2, 4, 8, 19, 3],
};

/** `lines` drawn black on white, upper-cased, `scale` pixels to a font dot. */
export function textImage(lines: readonly string[], scale = 4): GreyImage {
  const margin = 4 * scale;
  const advance = 6 * scale;
  const lineHeight = 10 * scale;
  const width = margin * 2 + Math.max(1, ...lines.map((line) => line.length)) * advance;
  const height = margin * 2 + lines.length * lineHeight;
  const pixels = new Uint8Array(width * height).fill(255);
  lines.forEach((line, row) => {
    [...line.toUpperCase()].forEach((char, column) => {
      const glyph = GLYPHS[char] ?? GLYPHS[' '];
      glyph.forEach((bits, y) => {
        for (let x = 0; x < 5; x++) {
          if ((bits >> (4 - x)) & 1) {
            for (let dy = 0; dy < scale; dy++) {
              const top = margin + row * lineHeight + y * scale + dy;
              const left = margin + column * advance + x * scale;
              pixels.fill(0, top * width + left, top * width + left + scale);
            }
          }
        }
      });
    });
  });
  return { width, height, pixels };
}

/** The pixel rows: PNG's lead each with a filter byte (0, none); a PDF image stream's have none. */
function rows(image: GreyImage, filterBytes: boolean): Buffer {
  if (!filterBytes) return Buffer.from(image.pixels);
  const out = Buffer.alloc((image.width + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    out[y * (image.width + 1)] = 0;
    out.set(image.pixels.subarray(y * image.width, (y + 1) * image.width), y * (image.width + 1) + 1);
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The image as an 8-bit greyscale PNG. */
export function pngOf(image: GreyImage): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows(image, true))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PDF of one page per image, each page the image alone: no font, no text layer. */
export function scannedPdfOf(images: readonly GreyImage[]): Buffer {
  const objects: Buffer[] = [];
  /** The object's number. */
  const add = (body: Buffer | string): number => objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
  const stream = (dictionary: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
  const catalog = add('');
  const pagesAt = add('');
  const pageIds: number[] = [];
  for (const image of images) {
    const picture = add(stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(rows(image, false))));
    const draw = add(stream('', Buffer.from(`q ${image.width} 0 0 ${image.height} 0 0 cm /Im0 Do Q`, 'latin1')));
    pageIds.push(add(`<< /Type /Page /Parent ${pagesAt} 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Im0 ${picture} 0 R >> >> /Contents ${draw} 0 R >>`));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesAt} 0 R >>`, 'latin1');
  objects[pagesAt - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1');
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let at = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(at);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(object);
    at += object.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
