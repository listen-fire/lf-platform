import { Readable } from 'node:stream';

interface OcrAdapter {
  extractPdf(
    rs: Readable,
    { numpages, size }: { numpages?: number; size: number },
  ): Promise<string | null>;
}

export { OcrAdapter };
