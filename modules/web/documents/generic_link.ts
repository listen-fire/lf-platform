import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';

import type { PdfStream } from './reader';

import { readerHost } from './host';

const genericLink = {
  get: async (url: string, type: 'PDF' | 'PPTX' | 'XLSX'): Promise<PdfStream> => {
    const webStream = await readerHost()
      .fetch(url)
      .then((res) => res.body);
    if (!webStream) {
      throw new Error(`Failed to fetch ${type} from ${url}`);
    }

    return {
      type: 'PDF_STREAM',
      data: Readable.from(webStream as ReadableStream),
      name: new URL(url).pathname.split('/').pop() ?? `document.${type.toLowerCase()}`,
    };
  },
};

export { genericLink };
