// The Document AI module, started as the process lf starts (serve.ts), over
// the wire against a fake Document AI, driven by Google's own client in its
// REST mode: the ocr slot's conformance kit, the price per page, and what
// reaches the processor. A generated service account key signs its own
// tokens, so nothing reaches Google. (A process, not this test's own: Google's
// HTTP client loads its fetch by a dynamic import jest's sandbox refuses.)

import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';

import { OCR_METHODS, OcrPricesAnswer, OcrReadAnswer } from 'engine-contracts/slots';
import { SlotClient, SlotRefused, commonSlotCases, ocrSlotCases, pngOf, scannedPdfOf, startModule, textImage, type StartedModule } from 'module-runtime/module-wire';

import { fakeDocumentAi, pageText, type FakeDocumentAi } from './fake_document_ai';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

let served: StartedModule;
let api: FakeDocumentAi;

beforeAll(async () => {
  served = await startModule(process.execPath, ['--require', require.resolve('tsx/cjs'), resolve(__dirname, '../serve.ts')]);
}, 60_000);

afterAll(async () => {
  await served.close();
});

beforeEach(async () => {
  api = await fakeDocumentAi();
});

afterEach(async () => {
  await api.close();
});

const settings = (extra: Record<string, string> = {}) => ({
  project: 'acme-ocr',
  location: 'eu',
  processor_id: 'proc-1',
  client_email: 'ocr@acme-ocr.iam.gserviceaccount.com',
  private_key: privateKey,
  base_url: api.url,
  ...extra,
});

describe('the ocr slot conformance kit', () => {
  for (const conformance of [...commonSlotCases('ocr', OCR_METHODS), ...ocrSlotCases]) {
    it(conformance.name, async () => {
      await conformance.run(new SlotClient(served.address, settings()));
    });
  }
});

describe('document_ai', () => {
  const pdf = () => scannedPdfOf([textImage(['ACME']), textImage(['ROBOTICS']), textImage(['SERIES A'])]);

  it("reads a short scan online at the install's processor, signed by its service account, each page priced", async () => {
    const answer = await new SlotClient(served.address, settings()).read('ocr.read', { bytes: pdf().toString('base64'), contentType: 'application/pdf', label: 'test' }, OcrReadAnswer);
    expect(answer.pages).toBe(3);
    expect(answer.text).toBe(`>>PAGE_START<<\n${pageText(1)}\n>>PAGE_START<<\n${pageText(2)}\n>>PAGE_START<<\n${pageText(3)}\n`);
    expect(answer.cost).toEqual([{ label: 'document-ai/ocr', microdollars: 4500 }]);
    const request = api.received[0];
    expect(request?.path).toMatch(/^\/v1\/projects\/acme-ocr\/locations\/eu\/processors\/proc-1:process(\?|$)/);
    expect(request?.headers.authorization).toMatch(/^Bearer ey/);
    expect(request?.body).toMatchObject({ rawDocument: { mimeType: 'application/pdf' } });
  });

  it('reads an image as its own type, one page', async () => {
    const png = pngOf(textImage(['HELLO']));
    const answer = await new SlotClient(served.address, settings()).read('ocr.read', { bytes: png.toString('base64'), contentType: 'image/png', label: 'test' }, OcrReadAnswer);
    expect(answer.pages).toBe(1);
    expect(api.received[0]?.body).toMatchObject({ rawDocument: { mimeType: 'image/png', content: png.toString('base64') } });
  });

  it("publishes and charges the install's own price per page", async () => {
    const client = new SlotClient(served.address, settings({ price_per_page: '0.01' }));
    expect(await client.read('ocr.prices', {}, OcrPricesAnswer)).toEqual({ perPage: 0.01 });
    const answer = await client.read('ocr.read', { bytes: pdf().toString('base64'), contentType: 'application/pdf', label: 'test' }, OcrReadAnswer);
    expect(answer.cost).toEqual([{ label: 'document-ai/ocr', microdollars: 30_000 }]);
  });

  it('batches a long file through the bucket, reads every shard, and leaves the bucket empty', async () => {
    const long = scannedPdfOf(Array.from({ length: 16 }, (_, i) => textImage([`PAGE ${i + 1}`], 1)));
    const client = new SlotClient(served.address, settings({ bucket: 'acme-ocr-scratch', storage_url: api.url }));
    const answer = await client.read('ocr.read', { bytes: long.toString('base64'), contentType: 'application/pdf', label: 'test' }, OcrReadAnswer);
    expect(answer.pages).toBe(16);
    expect(answer.text.startsWith(`>>PAGE_START<<\n${pageText(1)}\n>>PAGE_START<<\n${pageText(2)}\n`)).toBe(true);
    expect(answer.text).toContain(pageText(16));
    expect(answer.cost).toEqual([{ label: 'document-ai/ocr', microdollars: 24_000 }]);
    const batch = api.received.find((r) => r.path.includes(':batchProcess'));
    expect(batch?.body).toMatchObject({ inputDocuments: { gcsDocuments: { documents: [{ mimeType: 'application/pdf' }] } } });
    expect([...api.objects.keys()]).toEqual([]);
  });

  it('refuses a long file when no bucket is set, naming what is missing', async () => {
    const long = scannedPdfOf(Array.from({ length: 16 }, (_, i) => textImage([`PAGE ${i + 1}`], 1)));
    const refused = await new SlotClient(served.address, settings()).call('ocr.read', { bytes: long.toString('base64'), contentType: 'application/pdf', label: 'test' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SlotRefused);
    expect(String(Reflect.get(Object(refused), 'message'))).toMatch(/read in batch through a Cloud Storage bucket, and no bucket is set/);
    expect(api.received).toHaveLength(0);
  });

  it('refuses an install missing its processor, naming the setting', async () => {
    const { processor_id: _processor, ...rest } = settings();
    const refused = await new SlotClient(served.address, rest).call('ocr.read', { bytes: pdf().toString('base64'), contentType: 'application/pdf', label: 'test' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SlotRefused);
    expect(Reflect.get(Object(refused), 'code')).toBe('missing_setting');
    expect(String(Reflect.get(Object(refused), 'message'))).toMatch(/processor_id/);
  });
});
