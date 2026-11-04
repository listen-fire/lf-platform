import { Readable } from 'node:stream';

import { logger } from 'movement-engine/public/log';
import { OcrAdapter, OcrRead } from './interface';

class HybridAdapter implements OcrAdapter {
  constructor(
    private googleAdapter: OcrAdapter,
    private openAiAdapter: OcrAdapter,
  ) {}

  async extractPdf(rs: Readable, options: { numpages?: number; size: number }) {
    try {
      const openAiResult = await this.openAiAdapter.extractPdf(rs, options);
      return openAiResult;
    } catch (e) {
      logger.info(
        `Failed to extract text from PDF using OpenAI, falling back to Google. Error: ${e}`,
      );
      const googleResult = await this.googleAdapter.extractPdf(rs, options);
      return googleResult;
    }
  }

  /**
   * The same order as a PDF: OpenAI, then Google when OpenAI throws; a read
   * that found no text is an answer, not a failure. The bytes are held first
   * because the first attempt spends a stream, so a fallback over the same one
   * reads nothing and answers "no text" for a file nobody read.
   */
  async read(rs: Readable, options: { numpages?: number; size: number; mimeType?: string }): Promise<OcrRead> {
    const bytes = await streamToBuffer(rs);
    try {
      return await this.openAiAdapter.read(Readable.from(bytes), options);
    } catch (e) {
      logger.info(`Failed to read the file using OpenAI, falling back to Google. Error: ${e}`);
      return this.googleAdapter.read(Readable.from(bytes), options);
    }
  }
}

async function streamToBuffer(rs: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of rs) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export { HybridAdapter };
