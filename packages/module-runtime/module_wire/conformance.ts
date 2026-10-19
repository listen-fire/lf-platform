// The conformance suites of the slots with no family contract of their own
// (models, judge, files), and the cases every slot module answers alike (its
// manifest, the envelope's refusals). Each runs against any server over the
// wire: written once here, they hold lf's built-ins (`lf --contract-<slot>`)
// and a third-party module in any language to the same meaning. The store,
// limiter and loop guard are held to their families' contract cases
// (`services/run_host/contract.ts`, `limiter/contract.ts`,
// `loop_guard/contract.ts`) driven over this same wire; the browser to
// `services/browser/contract.ts` through its wire client.

import { strict as assert } from 'node:assert';

import { PROTOCOL_VERSION, type WireCoreSlotShape as CoreSlot } from 'engine-contracts';
import { FilesOpenAnswer, JudgeArbitrateAnswer, ModelsCallAnswer, StoredFile, WireSlotManifest } from 'engine-contracts/slots';

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

/** The models slot. `client` carries settings that reach a model. */
export const modelsSlotCases: SlotConformanceCase[] = [
  {
    name: 'models: one call, one answer: its text and what it cost',
    async run(client) {
      const answer = await client.read('models.call', { label: 'conformance.text', system: 'Answer briefly.', userMessage: 'Say hello.', model: 'sonnet' }, ModelsCallAnswer);
      assert.ok(answer.text.length > 0, 'the answer has text');
      for (const line of answer.cost) assert.ok(line.microdollars >= 0 && line.label.length > 0);
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
