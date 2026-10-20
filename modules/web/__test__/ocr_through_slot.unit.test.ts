// The dealflow plugin (vc-url-retrieval) reading a deck that is screenshots
// compiled into a PDF, with no text layer of its own: off the platform its
// text comes from the host's ocr slot (`ctx.ocr`), the read's cost charged to
// the call. With the slot empty the deck is unreadable, saying so.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { WireCostLineShape } from 'engine-contracts';
import { pluginsInProcess, refusingFiles, refusingKv, type ModuleOcr, type ModuleOcrRead, type ModuleSpend } from 'module-kit';
import { scannedPdfOf, textImage } from 'movement-engine/public/module-wire';

import { webModule } from '../index';

const DECK_TEXT = 'ACME ROBOTICS. Warehouse arms that pick anything. Raising a $4,000,000 Series A to scale deployments.';
const DECK = scannedPdfOf([textImage(['ACME ROBOTICS']), textImage(['SERIES A: $4,000,000'])]);
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** The deck host and the Anthropic API the classifier asks, on one loopback server. */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'GET' && request.url === '/deck.pdf') {
        response.writeHead(200, { 'content-type': 'application/pdf' });
        response.end(DECK);
        return;
      }
      const answer = JSON.stringify({ type: 'pitch_deck', password: null });
      const events: Array<[string, object]> = [
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function web(ocr: ModuleOcr | undefined, spend: ModuleSpend) {
  return pluginsInProcess(webModule, {
    tenant: 't',
    credential: { name: 'web', fields: async () => ({ anthropicApiKey: 'test-key' }), update: async () => undefined },
    spend,
    log: quiet,
    files: refusingFiles('none'),
    kv: refusingKv('none'),
    baseUrlOverride: base,
    ...(ocr !== undefined ? { ocr } : {}),
    validateResults: true,
  });
}

const retrieve = (plugins: ReturnType<typeof web>) =>
  plugins.invoke({ name: 'vc-url-retrieval', config: { text: `Hi! Our deck is here: ${base}/deck.pdf — thanks for looking.` }, extractedContext: {} });

describe('vc-url-retrieval off the platform', () => {
  it("reads a deck of screenshots through the host's ocr slot, and charges the read to the call", async () => {
    const reads: ModuleOcrRead[] = [];
    const charged: WireCostLineShape[] = [];
    const spend: ModuleSpend = { charge: (line) => void charged.push(line) };
    const ocr: ModuleOcr = {
      read: async (input) => {
        reads.push(input);
        spend.charge({ label: 'document-ai/ocr', microdollars: 3000 });
        return { text: DECK_TEXT, pages: 2 };
      },
    };
    const answer = await retrieve(web(ocr, spend));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.contentType).toBe('application/pdf');
    expect(Buffer.from(reads[0]?.bytes ?? []).equals(DECK)).toBe(true);
    expect(JSON.stringify(answer)).toContain('Warehouse arms that pick anything');
    expect(charged).toContainEqual({ label: 'document-ai/ocr', microdollars: 3000 });
  });

  it('finds no text in the deck when the slot is empty, and reads nothing', async () => {
    const answer = await retrieve(web(undefined, { charge: () => undefined }));
    expect(JSON.stringify(answer)).not.toContain('Warehouse arms');
  });
});
