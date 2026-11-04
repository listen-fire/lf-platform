import { Readable } from 'node:stream';

/** What a read found: the text (null when the pages hold none) and how many
 *  pages were read. */
interface OcrRead {
  text: string | null;
  pages: number;
}

interface OcrAdapter {
  extractPdf(
    rs: Readable,
    { numpages, size }: { numpages?: number; size: number },
  ): Promise<string | null>;
  read(
    rs: Readable,
    options: { numpages?: number; size: number; mimeType?: string },
  ): Promise<OcrRead>;
}

export { OcrAdapter, OcrRead };
