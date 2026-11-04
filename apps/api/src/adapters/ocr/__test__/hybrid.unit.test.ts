import { Readable } from 'node:stream';

import { HybridAdapter } from '../hybrid';
import type { OcrAdapter } from '../interface';

async function bytesOf(rs: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of rs) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

function adapter(read: OcrAdapter['read']): OcrAdapter {
  return { extractPdf: jest.fn(), read };
}

const OPTIONS = { numpages: 1, size: 3, mimeType: 'image/png' };

describe('HybridAdapter.read', () => {
  it('answers from the first adapter when it reads', async () => {
    const google = jest.fn();
    const hybrid = new HybridAdapter(adapter(google), adapter(async () => ({ text: 'openai', pages: 1 })));
    expect(await hybrid.read(Readable.from([Buffer.from('png')]), OPTIONS)).toEqual({ text: 'openai', pages: 1 });
    expect(google).not.toHaveBeenCalled();
  });

  it('falls back on a throw, with the whole file though the first attempt spent its stream', async () => {
    const openAi = adapter(async (rs) => {
      await bytesOf(rs);
      throw new Error('refused');
    });
    let seen: string | undefined;
    const google = adapter(async (rs, options) => {
      seen = await bytesOf(rs);
      expect(options).toEqual(OPTIONS);
      return { text: 'google', pages: 1 };
    });
    expect(await new HybridAdapter(google, openAi).read(Readable.from([Buffer.from('png')]), OPTIONS)).toEqual({ text: 'google', pages: 1 });
    expect(seen).toBe('png');
  });

  it('takes "no text" as the answer, not a failure to retry at a second price', async () => {
    const google = jest.fn();
    const hybrid = new HybridAdapter(adapter(google), adapter(async () => ({ text: null, pages: 1 })));
    expect(await hybrid.read(Readable.from([Buffer.from('png')]), OPTIONS)).toEqual({ text: null, pages: 1 });
    expect(google).not.toHaveBeenCalled();
  });
});
