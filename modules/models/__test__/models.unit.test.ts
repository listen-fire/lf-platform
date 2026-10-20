// The models module served over the wire against fake Gemini and OpenAI
// APIs, driven by the real vendor SDKs: the slot's conformance kit, the
// prices it publishes and charges, and how a movement's model names reach
// the vendor's models. No real key reaches any vendor.

import { MODELS_METHODS, ModelsCallAnswer, ModelsPricesAnswer } from 'engine-contracts/slots';
import { SlotClient, SlotRefused, commonSlotCases, modelsSlotCases, serveSlot, type ServedSlot } from 'module-runtime/module-wire';

import { MODELS_MANIFEST, modelsAnswer } from '../models';
import { FAKE_TEXT, fakeGemini, fakeOpenAi, type FakeVendor } from './fake_vendors';

let served: ServedSlot;

beforeEach(async () => {
  served = await serveSlot({ manifest: MODELS_MANIFEST, answer: modelsAnswer() });
});

afterEach(async () => {
  await served.close();
});

const vendors: Array<{ vendor: 'gemini' | 'openai'; fake: () => Promise<FakeVendor> }> = [
  { vendor: 'gemini', fake: fakeGemini },
  { vendor: 'openai', fake: fakeOpenAi },
];

for (const { vendor, fake } of vendors) {
  describe(`${vendor}: the models slot conformance kit`, () => {
    let api: FakeVendor;
    beforeEach(async () => {
      api = await fake();
    });
    afterEach(async () => {
      await api.close();
    });
    for (const conformance of [...commonSlotCases('models', MODELS_METHODS), ...modelsSlotCases]) {
      it(conformance.name, async () => {
        await conformance.run(new SlotClient(served.address, { vendor, api_key: 'test-key', base_url: api.url }));
      });
    }
  });
}

const ask = { label: 'test.ask', system: 'Answer briefly.', userMessage: 'Say hello.' };

describe('gemini', () => {
  let api: FakeVendor;
  beforeEach(async () => {
    api = await fakeGemini();
  });
  afterEach(async () => {
    await api.close();
  });
  const client = (extra: Record<string, string> = {}) => new SlotClient(served.address, { vendor: 'gemini', api_key: 'test-key', base_url: api.url, ...extra });

  it('sends every movement model name to the default model on the key, and prices the answer from the table', async () => {
    const answer = await client().read('models.call', { ...ask, model: 'sonnet' }, ModelsCallAnswer);
    expect(answer.text).toBe(FAKE_TEXT);
    expect(api.received[0]?.path).toMatch(/\/models\/gemini-3\.8-flash:streamGenerateContent/);
    expect(api.received[0]?.headers['x-goog-api-key']).toBe('test-key');
    // gemini-3.8-flash is $1.50 in, $7.50 out per million: 10 * 1.5 + 4 * 7.5.
    expect(answer.cost).toEqual([{ label: 'gemini/gemini-3.8-flash', microdollars: 45 }]);
    expect(answer.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  });

  it('routes a name the install maps elsewhere, as the platform map does, and prices it at that model', async () => {
    const answer = await client({ model_map: '{"claude-opus-5": "gemini/gemini-3.1-pro-preview"}' }).read('models.call', { ...ask, model: 'opus5' }, ModelsCallAnswer);
    expect(api.received[0]?.path).toMatch(/\/models\/gemini-3\.1-pro-preview:/);
    // $2 in, $12 out: 10 * 2 + 4 * 12.
    expect(answer.cost).toEqual([{ label: 'gemini/gemini-3.1-pro-preview', microdollars: 68 }]);
  });

  it('publishes the price of every name a call may write', async () => {
    const { prices } = await client({ model: 'gemini-3.1-pro-preview' }).read('models.prices', {}, ModelsPricesAnswer);
    expect(prices.sonnet).toEqual({ input: 2, output: 12, cacheRead: 0.2 });
    expect(prices['claude-haiku-4-5']).toEqual(prices.sonnet);
  });

  it('answers a schema request as data, through a forced function call', async () => {
    const schema = { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] };
    const answer = await client().read('models.call', { ...ask, model: 'sonnet', schema, toolName: 'greet', toolDescription: 'a greeting' }, ModelsCallAnswer);
    expect(answer.data).toEqual({ greeting: 'hello' });
    expect(answer.cost[0]?.microdollars).toBeGreaterThan(0);
  });

  it('refuses a model that is no movement model name', async () => {
    await expect(client().call('models.call', { ...ask, model: 'gemini-3.8-flash' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses an install whose model has no price, rather than answering calls it cannot price', async () => {
    await expect(client({ model: 'gemini-unknown' }).call('models.call', { ...ask, model: 'sonnet' })).rejects.toThrow(/gemini\/gemini-unknown, which has no price/);
  });

  it('refuses a map line that sends a name to another vendor', async () => {
    await expect(client({ model_map: '{"claude-sonnet-5": "openai/gpt-5"}' }).call('models.prices', {})).rejects.toThrow(/this install's vendor is gemini/);
  });

  it('wants a project without an API key', async () => {
    const call = new SlotClient(served.address, { vendor: 'gemini' }).call('models.call', { ...ask, model: 'sonnet' });
    await expect(call).rejects.toBeInstanceOf(SlotRefused);
    await expect(call).rejects.toThrow(/google_project/);
  });
});

describe('openai', () => {
  let api: FakeVendor;
  beforeEach(async () => {
    api = await fakeOpenAi();
  });
  afterEach(async () => {
    await api.close();
  });

  it('sends a name to the default model on the key, under the output ceiling asked, and prices the answer', async () => {
    const client = new SlotClient(served.address, { vendor: 'openai', api_key: 'test-key', base_url: api.url });
    const answer = await client.read('models.call', { ...ask, model: 'haiku', maxTokens: 3 }, ModelsCallAnswer);
    expect(api.received[0]?.body).toMatchObject({ model: 'gpt-5-mini', max_completion_tokens: 3, stream: true });
    expect(api.received[0]?.headers.authorization).toBe('Bearer test-key');
    // gpt-5-mini is $0.25 in, $2 out: 10 * 0.25 + 3 * 2.
    expect(answer.cost).toEqual([{ label: 'openai/gpt-5-mini', microdollars: 9 }]);
  });
});

describe('settings', () => {
  it('names a missing vendor, and refuses one the platform does not speak', async () => {
    await expect(new SlotClient(served.address, {}).call('models.prices', {})).rejects.toThrow(/no `vendor` setting/);
    await expect(new SlotClient(served.address, { vendor: 'mistral' }).call('models.prices', {})).rejects.toThrow(/one of anthropic, vertex, openai, gemini/);
  });

  it('prices Claude on Vertex under its own names', async () => {
    const client = new SlotClient(served.address, { vendor: 'vertex', google_project: 'a-project' });
    const { prices } = await client.read('models.prices', {}, ModelsPricesAnswer);
    expect(prices.sonnet).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheCreation: 2.5 });
  });
});
