// The models module's OCR install served over the wire against the fake
// Gemini API, driven by the real SDK: the ocr slot's conformance kit, what
// reaches the vendor (the file inline, beside the instruction), and the price.

import { OCR_METHODS, OcrPricesAnswer, OcrReadAnswer } from 'engine-contracts/slots';
import { SlotClient, commonSlotCases, ocrSlotCases, pngOf, scannedPdfOf, serveSlot, textImage, type ServedSlot } from 'module-runtime/module-wire';

import { MODELS_OCR_MANIFEST, modelsOcrAnswer } from '../ocr';
import { FAKE_TEXT, fakeGemini, fakeOpenAi, type FakeVendor } from './fake_vendors';

let served: ServedSlot;
let api: FakeVendor;

beforeEach(async () => {
  served = await serveSlot({ manifest: MODELS_OCR_MANIFEST, answer: modelsOcrAnswer() });
  api = await fakeGemini();
});

afterEach(async () => {
  await served.close();
  await api.close();
});

const client = (extra: Record<string, string> = {}) => new SlotClient(served.address, { vendor: 'gemini', api_key: 'test-key', base_url: api.url, ...extra });

describe('gemini: the ocr slot conformance kit', () => {
  for (const conformance of [...commonSlotCases('ocr', OCR_METHODS), ...ocrSlotCases]) {
    it(conformance.name, async () => {
      await conformance.run(client());
    });
  }
});

describe('models_ocr', () => {
  it('sends a scanned PDF inline to the model sonnet goes to, and prices the read from the table', async () => {
    const pdf = scannedPdfOf([textImage(['ACME']), textImage(['ROBOTICS'])]);
    const answer = await client().read('ocr.read', { bytes: pdf.toString('base64'), contentType: 'application/pdf', label: 'test' }, OcrReadAnswer);
    expect(answer).toEqual({ text: FAKE_TEXT, pages: 2, cost: [{ label: 'gemini/gemini-3.8-flash', microdollars: 45 }] });
    const request = api.received[0];
    expect(request?.path).toMatch(/\/models\/gemini-3\.8-flash:streamGenerateContent/);
    expect(request?.body).toMatchObject({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') } }, { text: 'Transcribe this file.' }] }] });
  });

  it('sends an image as its own type', async () => {
    const png = pngOf(textImage(['HELLO']));
    await client().read('ocr.read', { bytes: png.toString('base64'), contentType: 'image/png', label: 'test' }, OcrReadAnswer);
    expect(api.received[0]?.body).toMatchObject({ contents: [{ parts: [{ inlineData: { mimeType: 'image/png' } }, { text: 'Transcribe this file.' }] }] });
  });

  it("publishes a page's least cost: Gemini's 258 tokens a page at the model's input price", async () => {
    // gemini-3.8-flash takes $1.50 per million input tokens.
    expect(await client().read('ocr.prices', {}, OcrPricesAnswer)).toEqual({ perPage: (258 * 1.5) / 1_000_000 });
  });

  it('refuses a vendor whose files it does not send', async () => {
    const openai = await fakeOpenAi();
    try {
      const call = new SlotClient(served.address, { vendor: 'openai', api_key: 'k', base_url: openai.url }).call('ocr.read', { bytes: 'aGk=', contentType: 'image/png', label: 'test' });
      await expect(call).rejects.toMatchObject({ code: 'bad_setting' });
      await expect(call).rejects.toThrow(/reads files on gemini/);
    } finally {
      await openai.close();
    }
  });
});
