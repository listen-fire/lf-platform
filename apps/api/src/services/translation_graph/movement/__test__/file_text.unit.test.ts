// The FileRef → text seam's AUDIO kind: classification, transcription via
// the transcription capability, the duration-based meter report, and the size guard.
// streamFileRef + RawTextService are mocked — this suite proves file_text.ts
// itself (the other kinds are covered one level up in extraction-file tests).

const transcribeMock = jest.fn();
jest.mock('../../../../lib/models/transcription', () => ({
  transcribe: (...args: unknown[]) => transcribeMock(...args),
}));

const streamFileRefMock = jest.fn();
jest.mock('../../engine/files/retrieve', () => ({
  streamFileRef: (...args: unknown[]) => streamFileRefMock(...args),
}));

const getOrCreateRawTextIdMock = jest.fn();
const rawText = { getOrCreateId: (content: string) => getOrCreateRawTextIdMock(content) };
/** The team the file's bytes are redeemed for (the byte reader is mocked). */
const FILE_BYTES = { teamId: 'team-1' as TeamId };

// unpdf's PDF.js bundle is ESM, and jest's CJS vm cannot load it without
// --experimental-vm-modules — so the PARSER is mocked here (it still receives
// the real PDF bytes) and the real parse is exercised end-to-end in the dev
// loop, which runs the same code under plain node.
const extractTextMock = jest.fn();
jest.mock('unpdf', () => ({
  extractText: (...args: unknown[]) => extractTextMock(...args),
}));

import { Readable } from 'node:stream';

import { jsPDF } from 'jspdf';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { FileRef } from 'movement-engine/public/adapter';

import { FileOutsideTeamError } from 'movement-engine/public/files';
import { assertRunBudget, metered, NO_BUDGET_LIMIT } from 'movement-engine/public/models';
import { UnconfiguredOcrAdapter } from '../../../../adapters/ocr/unconfigured';
import { makeFileTextResolver } from '../file_text';
import { services } from '../../../../adapters/registry';
import { LlmUsageContext } from '../../../../lib/llm_usage';
import { captureEngineLogs } from '../../../../test/engine_logs';

const logs = captureEngineLogs();

const ocrMock = jest.fn();

function audioRef(overrides: Partial<{ name: string; contentType: string; size: number }> = {}): FileRef {
  return {
    __brand: 'FileRef',
    name: overrides.name ?? 'voice.ogg',
    contentType: overrides.contentType === '' ? undefined : (overrides.contentType ?? 'audio/ogg'),
    size: overrides.size,
    source: { adapterType: 'telegram', handle: 'file-1' },
  };
}

function resolvedAudio(bytes = 'fake-audio-bytes') {
  return { stream: Readable.from([Buffer.from(bytes)]), contentType: 'audio/ogg', size: bytes.length };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MAX_TRANSCRIPTION_BYTES;
  services.ocr = { extractPdf: ocrMock, read: jest.fn() };
  streamFileRefMock.mockResolvedValue(resolvedAudio());
  transcribeMock.mockResolvedValue({ text: 'hello from the voice note', durationSeconds: 2.4 });
  getOrCreateRawTextIdMock.mockResolvedValue('rt-audio-1');
});

describe('audio classification → transcription → raw text', () => {
  it.each([
    ['content type audio/ogg', { contentType: 'audio/ogg', name: 'x.bin' }],
    ['opus voice-note content type', { contentType: 'audio/ogg; codecs=opus', name: 'x' }],
    ['audio/mp4 (whatsapp/telegram audio)', { contentType: 'audio/mp4', name: 'x' }],
    ['.m4a extension only', { contentType: '', name: 'memo.m4a' }],
    ['.mp3 extension only', { contentType: '', name: 'song.mp3' }],
    ['.wav extension only', { contentType: '', name: 'clip.wav' }],
    ['.opus extension only', { contentType: '', name: 'note.opus' }],
    ['.webm extension only', { contentType: '', name: 'rec.webm' }],
  ])('transcribes when classified by %s', async (_label, over) => {
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    const result = await resolve({ file: audioRef(over) });
    expect(transcribeMock).toHaveBeenCalledWith('whisper-1', {
      audio: expect.any(Buffer),
      name: over.name,
      contentType: over.contentType || undefined,
      label: 'file_transcription',
    });
    expect(getOrCreateRawTextIdMock).toHaveBeenCalledWith('hello from the voice note');
    expect(result).toEqual({ text: 'hello from the voice note', rawTextId: 'rt-audio-1' });
  });

  it('hands the resolved bytes to the transcriber', async () => {
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    await resolve({ file: audioRef() });
    const [, { audio }] = transcribeMock.mock.calls[0];
    expect(String(audio)).toBe('fake-audio-bytes');
  });

  it('reports an empty transcript as unreadable rather than as nothing at all', async () => {
    transcribeMock.mockResolvedValue({ text: '   ' });
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    const result = await new LlmUsageContext({ teamId: 'team-1' }).runAsync(async () =>
      resolve({ file: audioRef() }),
    );
    expect(result).toEqual({ unreadable: 'no_text' });
    expect(getOrCreateRawTextIdMock).not.toHaveBeenCalled();
  });
});

describe('the size guard — no silent truncation', () => {
  it('skips (loudly) when the declared size exceeds the cap', async () => {
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('bytes')]) });
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    const result = await resolve({ file: audioRef({ size: 25 * 1024 * 1024 }) });
    expect(result).toMatchObject({ unreadable: 'extraction_failed' });
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(logs.warn()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('audio too large'),
        meta: expect.objectContaining({ name: 'voice.ogg' }),
      }),
    );
  });

  it('aborts (loudly) when an undeclared-size stream overruns the cap', async () => {
    process.env.MAX_TRANSCRIPTION_BYTES = '8';
    streamFileRefMock.mockResolvedValue({
      stream: Readable.from([Buffer.from('way-more-than-eight-bytes')]),
    });
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    const result = await resolve({ file: audioRef({ size: undefined }) });
    expect(result).toMatchObject({ unreadable: 'extraction_failed' });
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(logs.warn()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('audio too large'),
        meta: expect.objectContaining({ name: 'voice.ogg' }),
      }),
    );
  });
});

/** A born-digital PDF: real text in the page's text layer, no images. */
function textLayerPdf(lines: string[]): Buffer {
  const doc = new jsPDF();
  lines.forEach((line, i) => doc.text(line, 10, 10 + i * 10));
  return Buffer.from(doc.output('arraybuffer'));
}

function pdfRef(): FileRef {
  return {
    __brand: 'FileRef',
    name: 'onepager.pdf',
    contentType: 'application/pdf',
    source: { adapterType: 'slack', handle: 'F-1' },
  };
}

describe('a born-digital PDF is read from its own text layer — no OCR service', () => {
  const PROSE = [
    'Acme Corp raised a $5M seed round led by Example Ventures.',
    'Revenue is $1.2M ARR, growing 20% month over month.',
    'Jane Doe is the founder and chief executive.',
  ];

  function servePdf(lines: string[]): Buffer {
    const bytes = textLayerPdf(lines);
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([bytes]), size: bytes.length });
    return bytes;
  }

  it('extracts the text layer and never reaches the OCR provider', async () => {
    const bytes = servePdf(PROSE);
    extractTextMock.mockResolvedValue({ totalPages: 1, text: PROSE.join('\n') });
    getOrCreateRawTextIdMock.mockResolvedValue('rt-layer');

    const result = await makeFileTextResolver(rawText, FILE_BYTES)({ file: pdfRef() });

    // The parser was handed the PDF's own bytes …
    const handed = extractTextMock.mock.calls[0][0] as Uint8Array;
    expect(Buffer.from(handed).subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.from(handed).length).toBe(bytes.length);
    // … and its text is the file's text: no OCR service in the path at all.
    expect(ocrMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: PROSE.join('\n'), rawTextId: 'rt-layer' });
  });

  it('falls through to OCR when the pages carry no real text layer', async () => {
    // Two page numbers across two pages is what a stamping tool leaves on a
    // scan — it must not be mistaken for pages of prose.
    servePdf(['1']);
    extractTextMock.mockResolvedValue({ totalPages: 2, text: '1\n2' });
    ocrMock.mockResolvedValue('OCR read the scan.');
    getOrCreateRawTextIdMock.mockResolvedValue('rt-ocr');

    const result = await makeFileTextResolver(rawText, FILE_BYTES)({ file: pdfRef() });

    expect(ocrMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: 'OCR read the scan.', rawTextId: 'rt-ocr' });
  });

  it('still reaches OCR when the text layer cannot be read at all', async () => {
    servePdf(PROSE);
    extractTextMock.mockRejectedValue(new Error('invalid PDF structure'));
    ocrMock.mockResolvedValue('OCR read it anyway.');
    getOrCreateRawTextIdMock.mockResolvedValue('rt-ocr-2');

    const result = await makeFileTextResolver(rawText, FILE_BYTES)({ file: pdfRef() });

    expect(ocrMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: 'OCR read it anyway.', rawTextId: 'rt-ocr-2' });
  });

  it('says BOTH halves when there is no text layer and no OCR provider', async () => {
    servePdf(['1']);
    extractTextMock.mockResolvedValue({ totalPages: 1, text: '1' });
    ocrMock.mockRejectedValue(new Error('OCR is not configured, so text cannot be extracted.'));

    const result = await makeFileTextResolver(rawText, FILE_BYTES)({ file: pdfRef() });

    expect(result).toEqual({
      unreadable: 'extraction_failed',
      detail: 'no text layer; OCR is not configured, so text cannot be extracted.',
    });
  });
});

describe('the existing kinds are untouched', () => {
  it('a PDF with no text layer still routes to services.ocr', async () => {
    ocrMock.mockResolvedValue('pdf text');
    extractTextMock.mockResolvedValue({ totalPages: 1, text: '' });
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('%PDF')]), size: 4 });
    getOrCreateRawTextIdMock.mockResolvedValue('rt-pdf');
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    const result = await resolve({
      file: {
        __brand: 'FileRef',
        name: 'deck.pdf',
        contentType: 'application/pdf',
        source: { adapterType: 'email', handle: 'a-1' },
      },
    });
    expect(ocrMock).toHaveBeenCalled();
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: 'pdf text', rawTextId: 'rt-pdf' });
  });

  it("carries the extractor's own sentence when it throws", async () => {
    ocrMock.mockRejectedValue(new Error('OCR is not configured, so text cannot be extracted.'));
    extractTextMock.mockResolvedValue({ totalPages: 1, text: '' });
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('%PDF')]), size: 4 });
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    const result = await resolve({
      file: {
        __brand: 'FileRef',
        name: 'deck.pdf',
        contentType: 'application/pdf',
        source: { adapterType: 'email', handle: 'a-3' },
      },
    });
    expect(result).toEqual({
      unreadable: 'extraction_failed',
      detail: 'no text layer; OCR is not configured, so text cannot be extracted.',
    });
    expect(logs.warn()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('text extraction failed'),
        meta: expect.objectContaining({ name: 'deck.pdf' }),
      }),
    );
  });

  it('reports unreachable bytes as their own reason', async () => {
    streamFileRefMock.mockRejectedValue(new Error('file not found (404)'));
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    const result = await resolve({
      file: {
        __brand: 'FileRef',
        name: 'deck.pdf',
        contentType: 'application/pdf',
        source: { adapterType: 'email', handle: 'a-4' },
      },
    });
    expect(result).toEqual({ unreadable: 'bytes_unavailable', detail: 'file not found (404)' });
  });

  it("refuses, by name, a file that is not the team's — never an unreadable answer", async () => {
    const refused = new FileOutsideTeamError('document', 's3://bucket/another-team/deck.pdf');
    streamFileRefMock.mockRejectedValue(refused);
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    await expect(
      resolve({
        file: {
          __brand: 'FileRef',
          name: 'deck.pdf',
          contentType: 'application/pdf',
          source: { store: 'document', objectUri: 's3://bucket/another-team/deck.pdf' },
        },
      }),
    ).rejects.toBe(refused);
  });

  it('an unknown binary type is skipped — and says which type it was', async () => {
    const resolve = makeFileTextResolver(rawText, FILE_BYTES);
    const result = await resolve({
      file: {
        __brand: 'FileRef',
        name: 'archive.zip',
        contentType: 'application/zip',
        source: { adapterType: 'email', handle: 'a-2' },
      },
    });
    expect(result).toEqual({ unreadable: 'unsupported_type', detail: 'application/zip' });
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(ocrMock).not.toHaveBeenCalled();
  });
});

describe('NUL bytes in a font map with missing glyphs', () => {
  it('sanitises the text before the no-text check and the store', async () => {
    // Mirrors a real deck: a font map with no glyph for some characters left
    // U+0000 in the text layer (43 of them, e.g. `GPT\u00005.6\u0000Luna`).
    const raw =
      'Example Ventures backed the company. The deck says GPT\u00005.6\u0000Luna powers ' +
      'the product, with strong revenue growth and a large addressable market this year.';
    extractTextMock.mockResolvedValue({ totalPages: 1, text: raw });
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('%PDF')]), size: 4 });
    getOrCreateRawTextIdMock.mockResolvedValue('rt-sanitised');

    const result = await makeFileTextResolver(rawText, FILE_BYTES)({ file: pdfRef() });

    const sanitised = raw.replace(/\u0000/g, ' ');
    expect(sanitised).not.toContain('\u0000');
    expect(getOrCreateRawTextIdMock).toHaveBeenCalledWith(sanitised);
    expect(result).toEqual({ text: sanitised, rawTextId: 'rt-sanitised' });
    expect(ocrMock).not.toHaveBeenCalled();
  });

  it('leaves the run alone when storing provenance fails', async () => {
    const text = 'Acme Corp raised a $5M seed round led by Example Ventures. Revenue is $1.2M ARR this year.';
    extractTextMock.mockResolvedValue({ totalPages: 1, text });
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('%PDF')]), size: 4 });
    getOrCreateRawTextIdMock.mockRejectedValue(new Error('invalid byte sequence for encoding "UTF8": 0x00'));

    const result = await makeFileTextResolver(rawText, FILE_BYTES)({ file: pdfRef() });

    expect(result).toEqual({ text });
    expect(logs.warn()).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('could not store raw text provenance'),
        meta: expect.objectContaining({ name: 'onepager.pdf', message: expect.stringContaining('0x00') }),
      }),
    );
  });
});

describe('an image is read by OCR, and the run pays for it', () => {
  const readMock = jest.fn();
  const png = Buffer.from('png bytes');
  const image = (over: Partial<FileRef> = {}): FileRef => ({
    __brand: 'FileRef',
    name: 'shot.png',
    contentType: 'image/png',
    source: { adapterType: 'slack', handle: 'file-1' },
    ...over,
  });
  /** The host's own wrapping (`billedFileText`), under a budget. */
  const readUnder = (remainingMicrodollars: number | null, file: FileRef = image()) =>
    metered({ file, budget: remainingMicrodollars === null ? NO_BUDGET_LIMIT : { remainingMicrodollars } }, (input) =>
      makeFileTextResolver(rawText, FILE_BYTES)(input),
    );

  beforeEach(() => {
    services.ocr = { extractPdf: ocrMock, read: readMock };
    readMock.mockReset();
    streamFileRefMock.mockImplementation(async () => ({ stream: Readable.from([png]), size: png.length }));
    getOrCreateRawTextIdMock.mockResolvedValue('rt-image');
  });

  it('asks the reader for one page of the type it named, and charges the page as its own line', async () => {
    readMock.mockResolvedValue({ text: 'the words on it', pages: 1 });
    expect(await readUnder(null)).toEqual({
      text: 'the words on it',
      rawTextId: 'rt-image',
      cost: [{ source: 'service:google.document_ai', microdollars: 1500 }],
    });
    expect(readMock).toHaveBeenCalledWith(expect.any(Readable), { numpages: 1, size: png.length, mimeType: 'image/png' });
    expect(ocrMock).not.toHaveBeenCalled();
  });

  it('classifies by the extension where the content type says nothing', async () => {
    readMock.mockResolvedValue({ text: 'text', pages: 1 });
    await readUnder(null, image({ name: 'photo.JPEG', contentType: undefined }));
    expect(readMock).toHaveBeenCalledWith(expect.any(Readable), expect.objectContaining({ mimeType: 'image/jpeg' }));
  });

  it('charges every page of a many-page TIFF', async () => {
    readMock.mockResolvedValue({ text: 'text', pages: 3 });
    expect(await readUnder(null, image({ name: 'a.tiff', contentType: 'image/tiff' }))).toMatchObject({
      cost: [{ source: 'service:google.document_ai', microdollars: 4500 }],
    });
  });

  it('leaves an image with no text unreadable, its read still paid for, and nothing thrown', async () => {
    readMock.mockResolvedValue({ text: null, pages: 1 });
    expect(await readUnder(null)).toEqual({
      unreadable: 'no_text',
      cost: [{ source: 'service:google.document_ai', microdollars: 1500 }],
    });
    expect(getOrCreateRawTextIdMock).not.toHaveBeenCalled();
  });

  it('says the slot is empty on a deployment with no OCR provider, and charges nothing', async () => {
    services.ocr = new UnconfiguredOcrAdapter();
    expect(await readUnder(null)).toEqual({
      unreadable: 'extraction_failed',
      detail: expect.stringMatching(/^an image is read by OCR; OCR is not configured, so text cannot be extracted from this file\./),
      cost: [],
    });
  });

  it('a backend failure is unreadable, naming it, and charges nothing', async () => {
    readMock.mockRejectedValue(new Error('3 INVALID_ARGUMENT: unsupported input'));
    expect(await readUnder(null)).toEqual({
      unreadable: 'extraction_failed',
      detail: 'an image is read by OCR; 3 INVALID_ARGUMENT: unsupported input',
      cost: [],
    });
  });

  it('is refused before the read once the budget is spent, reaching the host as a refusal rather than an unreadable file', async () => {
    expect(await readUnder(0)).toEqual({ error: { kind: 'budget', message: expect.any(String) }, cost: [] });
    expect(readMock).not.toHaveBeenCalled();
  });

  it('reads outside a run with no meter, charging nobody', async () => {
    readMock.mockResolvedValue({ text: 'text', pages: 1 });
    expect(await makeFileTextResolver(rawText, FILE_BYTES)({ file: image() })).toEqual({ text: 'text', rawTextId: 'rt-image' });
  });

  it('leaves SVG unsupported', async () => {
    expect(await readUnder(null, image({ name: 'logo.svg', contentType: 'image/svg+xml' }))).toEqual({
      unreadable: 'unsupported_type',
      detail: 'image/svg+xml',
      cost: [],
    });
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe('a read past the run\'s budget, by the version the run is on', () => {
  const readUnderSpentBudget = (bytes: Parameters<typeof makeFileTextResolver>[1]) =>
    metered({ file: audioRef(), budget: { remainingMicrodollars: 0 } }, (input) => makeFileTextResolver(rawText, bytes)(input));

  beforeEach(() => {
    transcribeMock.mockImplementation(async () => {
      assertRunBudget();
      return { text: 'never heard', durationSeconds: 1 };
    });
  });

  it('a current run stops at the cap', async () => {
    expect(await readUnderSpentBudget(FILE_BYTES)).toEqual({ error: { kind: 'budget', message: expect.any(String) }, cost: [] });
  });

  it('a run on a carried release reads the file as unreadable and goes on, as it did', async () => {
    expect(await readUnderSpentBudget({ ...FILE_BYTES, asCarriedRelease: true })).toMatchObject({ unreadable: 'extraction_failed' });
  });
});
