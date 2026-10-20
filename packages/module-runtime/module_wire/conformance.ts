// The conformance suites of the slots with no family contract of their own
// (models, judge, files, wake, ocr), and the cases every slot module answers alike (its
// manifest, the envelope's refusals). Each runs against any server over the
// wire: written once here, they hold lf's built-ins (`lf --contract-<slot>`)
// and a third-party module in any language to the same meaning. The store,
// limiter and loop guard are held to their families' contract cases
// (`services/run_host/contract.ts`, `limiter/contract.ts`,
// `loop_guard/contract.ts`) driven over this same wire; the browser to
// `services/browser/contract.ts` through its wire client.

import { strict as assert } from 'node:assert';

import { PROTOCOL_VERSION, type WireCoreSlotShape as CoreSlot } from 'engine-contracts';
import {
  FilesOpenAnswer,
  JudgeArbitrateAnswer,
  MODELS_PRICES_METHOD,
  ModelsCallAnswer,
  ModelsPricesAnswer,
  OCR_PRICES_METHOD,
  OCR_UNSUPPORTED_TYPE_CODE,
  OcrPricesAnswer,
  OcrReadAnswer,
  StoredFile,
  WireSlotManifest,
  isFreePrice,
  type ModelPriceShape,
} from 'engine-contracts/slots';

import { pngOf, scannedPdfOf, textImage } from './scanned';
import { SlotClient, SlotRefused, postTo } from './wire';

export interface SlotConformanceCase {
  name: string;
  run(client: SlotClient): Promise<void>;
}

async function refusedWith(code: string, call: Promise<unknown>): Promise<SlotRefused> {
  try {
    await call;
  } catch (error) {
    if (error instanceof SlotRefused) {
      assert.equal(error.code, code, `expected the code ${code}, got ${error.code}: ${error.message}`);
      return error;
    }
    throw error;
  }
  assert.fail(`expected a refusal with the code ${code}, got an answer`);
}

/** Every slot module: its manifest names its slot and lists its methods, and
 *  the envelope's refusals read as the protocol's. */
export function commonSlotCases(slot: CoreSlot, methods: readonly string[]): SlotConformanceCase[] {
  return [
    {
      name: `${slot}: the manifest names the slot and lists its methods`,
      async run(client) {
        const manifest = await client.read('manifest', {}, WireSlotManifest);
        assert.equal(manifest.slot, slot);
        for (const method of methods) assert.ok(manifest.methods.includes(method), `the manifest lists ${method}`);
      },
    },
    {
      name: `${slot}: an unknown method is refused as method_not_implemented`,
      async run(client) {
        await refusedWith('method_not_implemented', client.call(`${slot}.noSuchMethod`, {}));
      },
    },
    {
      name: `${slot}: another protocol version is refused as protocol_version`,
      async run(client) {
        const answer = await postTo(client.address, JSON.stringify({ protocolVersion: '1', method: 'manifest', params: {} }));
        assert.equal(answer.status, 200);
        const body: unknown = JSON.parse(answer.body);
        assert.deepEqual(Reflect.get(Object(Reflect.get(Object(body), 'error')), 'code'), 'protocol_version');
        assert.notEqual(PROTOCOL_VERSION, '1');
      },
    },
    {
      name: `${slot}: a request without the module's token is answered 401`,
      async run(client) {
        if (client.address.token === undefined) return;
        const { token: _token, ...anonymous } = client.address;
        const answer = await postTo(anonymous, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, method: 'manifest', params: {} }));
        assert.equal(answer.status, 401);
      },
    },
  ];
}

/** The module's published price for `model`, when it publishes prices. */
async function publishedPrice(client: SlotClient, model: string): Promise<ModelPriceShape | undefined> {
  const manifest = await client.read('manifest', {}, WireSlotManifest);
  if (!manifest.methods.includes(MODELS_PRICES_METHOD)) return undefined;
  const { prices } = await client.read(MODELS_PRICES_METHOD, {}, ModelsPricesAnswer);
  return prices[model];
}

/** The models slot. `client` carries settings that reach a model. */
export const modelsSlotCases: SlotConformanceCase[] = [
  {
    name: 'models: a call that spent tokens reports what it cost, unless the model is published as free',
    async run(client) {
      const answer = await client.read('models.call', { label: 'conformance.priced', system: 'Answer briefly.', userMessage: 'Say hello.', model: 'sonnet' }, ModelsCallAnswer);
      const spent = answer.usage.inputTokens + answer.usage.outputTokens;
      const price = await publishedPrice(client, 'sonnet');
      if (spent === 0 || (price !== undefined && isFreePrice(price))) return;
      const total = answer.cost.reduce((sum, line) => sum + line.microdollars, 0);
      assert.ok(total > 0, `the call spent ${spent} tokens and reported a cost of ${total} microdollars`);
    },
  },
  {
    name: 'models: models.prices, when listed, prices the names a call writes in dollars per million tokens',
    async run(client) {
      const manifest = await client.read('manifest', {}, WireSlotManifest);
      if (!manifest.methods.includes(MODELS_PRICES_METHOD)) return;
      const { prices } = await client.read(MODELS_PRICES_METHOD, {}, ModelsPricesAnswer);
      assert.ok(prices.sonnet !== undefined, 'the table prices `sonnet`, a name every host writes');
    },
  },
  {
    name: 'models: one call, one answer: its text, what it cost and the tokens it spent',
    async run(client) {
      const answer = await client.read('models.call', { label: 'conformance.text', system: 'Answer briefly.', userMessage: 'Say hello.', model: 'sonnet' }, ModelsCallAnswer);
      assert.ok(answer.text.length > 0, 'the answer has text');
      for (const line of answer.cost) assert.ok(line.microdollars >= 0 && line.label.length > 0);
      assert.ok(answer.usage.inputTokens > 0 && answer.usage.outputTokens > 0, 'the answer reports the tokens it spent');
    },
  },
  {
    name: 'models: maxTokens is the answer\'s output ceiling',
    async run(client) {
      const answer = await client.read(
        'models.call',
        { label: 'conformance.ceiling', system: 'Answer at length.', userMessage: 'Tell a long story.', model: 'sonnet', maxTokens: 16 },
        ModelsCallAnswer,
      );
      assert.ok(answer.usage.outputTokens <= 16, `the answer spent ${answer.usage.outputTokens} output tokens under a ceiling of 16`);
    },
  },
  {
    name: 'models: a schema asks for the reply as data',
    async run(client) {
      const schema = { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] };
      const answer = await client.read(
        'models.call',
        { label: 'conformance.data', system: 'Answer as asked.', userMessage: 'Greet.', model: 'sonnet', schema, toolName: 'greet', toolDescription: 'a greeting' },
        ModelsCallAnswer,
      );
      assert.ok(answer.data !== undefined && answer.data !== null, 'the answer carries data');
    },
  },
  {
    name: 'models: a request missing its system prompt is refused as bad_request',
    async run(client) {
      await refusedWith('bad_request', client.call('models.call', { label: 'conformance.bad', userMessage: 'x' }));
    },
  },
];

const QUESTION = {
  asserted: { name: 'Acme' },
  candidates: [{ recordType: 'Company', externalId: 'c1', data: { name: 'ACME Inc' } }, { recordType: 'Company', externalId: 'c2', data: { name: 'Acme Ltd' } }],
  recordType: 'Company',
  constraints: { any: [{ all: [{ field: 'name', fuzzy: true }] }] },
  languageVersion: 5,
};

/** The judge slot. */
export const judgeSlotCases: SlotConformanceCase[] = [
  {
    name: 'judge: a question is answered with a candidate, or null to create',
    async run(client) {
      const answer = await client.read('judge.arbitrate', QUESTION, JudgeArbitrateAnswer);
      if (answer.index !== null) assert.ok(answer.index < QUESTION.candidates.length, 'the index names a candidate');
      if (answer.judgeUnavailable !== undefined) assert.equal(answer.index, null, 'a judge that was not asked picks none');
    },
  },
  {
    name: 'judge: candidates that are not a list are refused as bad_request',
    async run(client) {
      await refusedWith('bad_request', client.call('judge.arbitrate', { ...QUESTION, candidates: 'c1' }));
    },
  },
];

/** The files slot. */
export const filesSlotCases: SlotConformanceCase[] = [
  {
    name: 'files: a stored document reads back its bytes, and only its tenant owns it',
    async run(client) {
      const bytes = Buffer.from('hello, files slot é', 'utf8');
      const stored = await client.read('files.put', { tenant: 'team-a', name: 'note.txt', contentType: 'text/plain', bytes: bytes.toString('base64') }, StoredFile);
      assert.equal(stored.size, bytes.length);
      assert.equal(stored.name, 'note.txt');
      const uri = stored.source.objectUri;
      assert.equal(await client.call('files.owns', { objectUri: uri, tenant: 'team-a' }), true);
      assert.equal(await client.call('files.owns', { objectUri: uri, tenant: 'team-b' }), false);
      const opened = await client.read('files.open', { objectUri: uri }, FilesOpenAnswer);
      assert.deepEqual(Buffer.from(opened.bytes, 'base64'), bytes);
    },
  },
  {
    name: 'files: a document never stored is owned by no one and does not open',
    async run(client) {
      assert.equal(await client.call('files.owns', { objectUri: 'nowhere:missing', tenant: 'team-a' }), false);
      await assert.rejects(client.call('files.open', { objectUri: 'nowhere:missing' }), SlotRefused);
    },
  },
  {
    name: 'files: two documents of one name are two documents',
    async run(client) {
      const put = (text: string) =>
        client.read('files.put', { tenant: 'team-a', name: 'same.txt', contentType: 'text/plain', bytes: Buffer.from(text).toString('base64') }, StoredFile);
      const [first, second] = [await put('one'), await put('two')];
      assert.notEqual(first.source.objectUri, second.source.objectUri);
      const opened = await client.read('files.open', { objectUri: first.source.objectUri }, FilesOpenAnswer);
      assert.equal(Buffer.from(opened.bytes, 'base64').toString(), 'one');
    },
  },
];

// ── The OCR slot ────────────────────────────────────────────────────────────

const SCANNED_LINES = ['ACME ROBOTICS', 'SERIES A: $4,000,000'];

/** The OCR slot. `client` carries settings that reach a backend. */
export const ocrSlotCases: SlotConformanceCase[] = [
  {
    name: 'ocr: a scanned PDF is read: its text, the pages read and what they cost',
    async run(client) {
      const pdf = scannedPdfOf([textImage(SCANNED_LINES), textImage(['PAGE TWO'])]);
      const answer = await client.read('ocr.read', { bytes: pdf.toString('base64'), contentType: 'application/pdf', name: 'deck.pdf', label: 'conformance.pdf' }, OcrReadAnswer);
      assert.ok(answer.text.trim().length > 0, 'the answer has text');
      assert.equal(answer.pages, 2, 'both pages were read');
      for (const line of answer.cost) assert.ok(line.microdollars >= 0 && line.label.length > 0);
    },
  },
  {
    name: 'ocr: an image is read as one page',
    async run(client) {
      const png = pngOf(textImage(SCANNED_LINES));
      const answer = await client.read('ocr.read', { bytes: png.toString('base64'), contentType: 'image/png', name: 'shot.png', label: 'conformance.image' }, OcrReadAnswer);
      assert.ok(answer.text.trim().length > 0, 'the answer has text');
      assert.equal(answer.pages, 1);
    },
  },
  {
    name: 'ocr: a read that read pages reports what it cost, unless the module publishes its price as free',
    async run(client) {
      const png = pngOf(textImage(SCANNED_LINES));
      const answer = await client.read('ocr.read', { bytes: png.toString('base64'), contentType: 'image/png', label: 'conformance.priced' }, OcrReadAnswer);
      const manifest = await client.read('manifest', {}, WireSlotManifest);
      const free = manifest.methods.includes(OCR_PRICES_METHOD) && (await client.read(OCR_PRICES_METHOD, {}, OcrPricesAnswer)).perPage === 0;
      if (answer.pages === 0 || free) return;
      const total = answer.cost.reduce((sum, line) => sum + line.microdollars, 0);
      assert.ok(total > 0, `the read read ${answer.pages} pages and reported a cost of ${total} microdollars`);
    },
  },
  {
    name: 'ocr: ocr.prices, when listed, prices a page in dollars',
    async run(client) {
      const manifest = await client.read('manifest', {}, WireSlotManifest);
      if (!manifest.methods.includes(OCR_PRICES_METHOD)) return;
      const { perPage } = await client.read(OCR_PRICES_METHOD, {}, OcrPricesAnswer);
      assert.ok(Number.isFinite(perPage) && perPage >= 0);
    },
  },
  {
    name: 'ocr: a request without bytes is refused as bad_request',
    async run(client) {
      await refusedWith('bad_request', client.call('ocr.read', { contentType: 'application/pdf', label: 'conformance.bad' }));
    },
  },
  {
    name: 'ocr: bytes of a type the module does not read are refused as unsupported_type',
    async run(client) {
      const bytes = Buffer.from('PK\u0003\u0004 not a document').toString('base64');
      await refusedWith(OCR_UNSUPPORTED_TYPE_CODE, client.call('ocr.read', { bytes, contentType: 'application/zip', label: 'conformance.zip' }));
    },
  },
];

// ── The wake slot ───────────────────────────────────────────────────────────

/** What the wake slot's cases drive: the module, and the workers it has
 *  started. A wake module's effect is outside it (a queue service starting a
 *  worker), so the harness observes it: for a cloud queue module, the
 *  deliveries its queue makes to an endpoint the harness serves. */
export interface WakeHarness {
  client: SlotClient;
  /** When (epoch milliseconds, the harness's clock) each worker the module
   *  started began, since this harness was made. */
  started(): Promise<number[]>;
  /** How late after its due time a worker may start: the queue's delivery delay. */
  slackMs: number;
}

export interface WakeConformanceCase {
  name: string;
  run(harness: WakeHarness): Promise<void>;
}

const POLL_MS = 50;

/** The starts at or after `since`, once there is one; a failure at `by`. */
async function startsSince(harness: WakeHarness, since: number, by: number, what: string): Promise<number[]> {
  for (;;) {
    const starts = (await harness.started()).filter((at) => at >= since);
    if (starts.length > 0) return starts;
    if (Date.now() > by) assert.fail(`${what}: no worker started by ${new Date(by).toISOString()}`);
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/** The wake slot (docs/contracts/wake-slot.md). */
export const wakeSlotCases: WakeConformanceCase[] = [
  {
    name: 'wake: now is answered null, and a worker starts soon after',
    async run(harness) {
      const asked = Date.now();
      assert.equal(await harness.client.call('wake.now', { kind: 'fire_event' }), null);
      await startsSince(harness, asked, Date.now() + harness.slackMs, 'wake.now');
    },
  },
  {
    name: 'wake: at an instant ahead, a worker starts then and not before',
    async run(harness) {
      const at = Date.now() + 1_500;
      assert.equal(await harness.client.call('wake.at', { kind: 'resume_timer', at: new Date(at).toISOString() }), null);
      const starts = await startsSince(harness, 0, at + harness.slackMs, 'wake.at');
      for (const start of starts) assert.ok(start >= at, `a worker started ${at - start}ms before its instant`);
    },
  },
  {
    name: 'wake: at an instant already past is now',
    async run(harness) {
      const asked = Date.now();
      assert.equal(await harness.client.call('wake.at', { kind: 'resume_timer', at: new Date(asked - 60_000).toISOString() }), null);
      await startsSince(harness, asked, Date.now() + harness.slackMs, 'wake.at in the past');
    },
  },
  {
    name: 'wake: many nows in a row are each answered, and start a worker',
    async run(harness) {
      const asked = Date.now();
      for (const kind of ['fire_event', 'wake_await', 'fire_event', 'poll_listen', 'fire_callback']) {
        assert.equal(await harness.client.call('wake.now', { kind }), null);
      }
      await startsSince(harness, asked, Date.now() + harness.slackMs, 'five wake.now');
    },
  },
  {
    name: 'wake: an at that is not an instant, or a wake without its kind, is refused as bad_request',
    async run(harness) {
      await refusedWith('bad_request', harness.client.call('wake.at', { kind: 'resume_timer', at: 'soon' }));
      await refusedWith('bad_request', harness.client.call('wake.at', { kind: 'resume_timer' }));
      await refusedWith('bad_request', harness.client.call('wake.now', {}));
    },
  },
];
