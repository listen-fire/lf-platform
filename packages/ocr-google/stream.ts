import type { Readable } from 'node:stream';

export async function streamToBuffer(rs: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of rs) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
