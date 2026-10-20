// A module's `ctx.ocr`: through the host's OCR door, a read's cost charged
// to the call that asked; an empty slot refusing by name.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { WireCostLineShape } from 'engine-contracts';

import { emptyOcrSlot, hostOcr, moduleContext, noCredential } from '../index';

interface Door {
  url: string;
  received: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function door(answer: (body: Record<string, unknown>) => { status: number; body: unknown }): Promise<Door> {
  const received: Door['received'] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ headers: request.headers, body });
      const { status, body: out } = answer(body);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/public/adapter/web/ocr`, received, close: () => new Promise((done) => server.close(() => done())) };
}

describe('ctx.ocr through the host door', () => {
  it('sends the bytes base64 with the door token, and charges the read to the call', async () => {
    const served = await door(() => ({ status: 200, body: { text: 'ACME ROBOTICS', pages: 2, cost: [{ label: 'ocr/document-ai', microdollars: 3000 }] } }));
    try {
      const charged: WireCostLineShape[] = [];
      const ocr = hostOcr({ url: served.url, headers: { authorization: 'Bearer host-token' } })({ charge: (line) => void charged.push(line) });
      const read = await ocr.read({ bytes: Buffer.from('%PDF-1.4 scanned'), contentType: 'application/pdf', name: 'deck.pdf', label: 'web.vc-url-retrieval' });
      expect(read).toEqual({ text: 'ACME ROBOTICS', pages: 2 });
      expect(charged).toEqual([{ label: 'ocr/document-ai', microdollars: 3000 }]);
      expect(served.received[0].headers.authorization).toBe('Bearer host-token');
      expect(served.received[0].body).toEqual({ bytes: Buffer.from('%PDF-1.4 scanned').toString('base64'), contentType: 'application/pdf', name: 'deck.pdf', label: 'web.vc-url-retrieval' });
    } finally {
      await served.close();
    }
  });

  it("refuses with the door's own message (an empty slot says so)", async () => {
    const served = await door(() => ({ status: 503, body: { error: 'ocr_slot_empty', message: 'the ocr slot is empty: name an OCR module in lf.yaml' } }));
    try {
      const ocr = hostOcr({ url: served.url, headers: {} })({ charge: () => undefined });
      await expect(ocr.read({ bytes: Buffer.from('x'), contentType: 'image/png', label: 'test' })).rejects.toThrow('the ocr slot is empty: name an OCR module in lf.yaml');
    } finally {
      await served.close();
    }
  });
});

describe('a host that lends no OCR', () => {
  it('gives its modules the empty slot, which says why before and on a read', async () => {
    const ctx = moduleContext({
      tenant: 't',
      credential: noCredential('none'),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      files: { put: async () => Promise.reject(new Error('none')), read: async () => Promise.reject(new Error('none')), expose: async () => Promise.reject(new Error('none')) },
      kv: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, list: async () => [], compareAndSet: async () => false },
      validateResults: false,
    });
    expect(ctx.ocr.emptyBecause).toBe('the ocr slot is empty: this host has no OCR to lend its modules');
    await expect(ctx.ocr.read({ bytes: Buffer.from('x'), contentType: 'image/png', label: 'test' })).rejects.toThrow('the ocr slot is empty');
    expect(emptyOcrSlot('why').emptyBecause).toBe('the ocr slot is empty: why');
  });
});
