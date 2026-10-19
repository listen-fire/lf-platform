import { Readable } from 'node:stream';

import { OcrAdapter } from './interface';

const MESSAGE =
  'OCR is not configured, so text cannot be extracted from this PDF. Set ' +
  'GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_EMAIL, GOOGLE_CLIENT_ID, GOOGLE_PROJECT_ID, ' +
  'GOOGLE_PROJECT_LOCATION, GOOGLE_OCR_PROCESSOR_ID and GOOGLE_STORAGE_BUCKET_NAME.';

/**
 * The stand-in for a deployment with no OCR provider — same bargain as the
 * unconfigured document provider: booting must not require credentials for a
 * capability the deployment may never use, but reaching for the capability
 * must say exactly what is missing.
 */
class UnconfiguredOcrAdapter implements OcrAdapter {
  constructor(private readonly message: string = MESSAGE) {}

  async extractPdf(
    _rs: Readable,
    _meta: { numpages?: number; size: number },
  ): Promise<string | null> {
    throw new Error(this.message);
  }
}

export { UnconfiguredOcrAdapter };
