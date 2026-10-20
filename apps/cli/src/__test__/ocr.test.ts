// The ocr slot through the real `lf`: its conformance cases held against
// lf's own client of the slot's module (`lf --contract-ocr-slot`), over
// @listen-fire/document-ai before a fake Document AI and @listen-fire/models'
// OCR install before a fake Gemini; and runs that read a deck of screenshots
// compiled into a PDF (no text layer): `File.read` and `extractOne` in a
// movement, a plugin's `ctx.ocr` through lf's OCR door, each read's cost on
// the run; and the empty slot saying so.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { OCR_METHODS } from 'engine-contracts/slots';
import { SlotClient, commonSlotCases, ocrSlotCases, scannedPdfOf, startModule, textImage, type StartedModule } from 'movement-engine/public/module-wire';

import { fakeDocumentAi, pageText, type FakeDocumentAi } from '../../../../modules/document-ai/__test__/fake_document_ai';
import { fakeGemini, type FakeVendor } from '../../../../modules/models/__test__/fake_vendors';
import { companies, lfCommand, project } from './example';
import { lfBinary } from './lf_bin';

const MODULES = resolve(__dirname, '../../../../modules');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

/** How node starts a module's TypeScript entry. */
const tsx = (entry: string) => [process.execPath, '--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), entry];

/** The package's install entry in `dir`'s externals folder, started from its source. */
function install(dir: string, entry: string, yaml: string, serve: string): void {
  const manifest = readFileSync(join(MODULES, yaml), 'utf8').replace(/^command: .*$/m, `command: [${tsx(join(MODULES, serve)).map((part) => JSON.stringify(part)).join(', ')}]`);
  mkdirSync(join(dir, 'externals', entry), { recursive: true });
  writeFileSync(join(dir, 'externals', entry, 'lf-external.yaml'), manifest);
}

/** Document AI's settings as environment variables, as a container sets them. */
function documentAiEnv(api: FakeDocumentAi): Record<string, string> {
  return {
    LF_SECRET__DOCUMENT_AI__EXTERNAL: 'document_ai',
    LF_SECRET__DOCUMENT_AI__PROJECT: 'acme-ocr',
    LF_SECRET__DOCUMENT_AI__LOCATION: 'eu',
    LF_SECRET__DOCUMENT_AI__PROCESSOR_ID: 'proc-1',
    LF_SECRET__DOCUMENT_AI__CLIENT_EMAIL: 'ocr@acme-ocr.iam.gserviceaccount.com',
    LF_SECRET__DOCUMENT_AI__PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    LF_SECRET__DOCUMENT_AI__BASE_URL: api.url,
  };
}

function documentAiProject(): string {
  const dir = project();
  install(dir, 'document_ai', 'document-ai/lf-external.yaml', 'document-ai/serve.ts');
  appendFileSync(join(dir, 'lf.yaml'), '\ncore:\n  ocr: document_ai\n');
  return dir;
}

// ── Conformance through lf's client ─────────────────────────────────────────

const bridges: Array<{ over: string; start(): Promise<{ lf: StartedModule; close(): Promise<void> }> }> = [
  {
    over: "lf's client of @listen-fire/document-ai",
    async start() {
      const api = await fakeDocumentAi();
      const lf = await startModule(lfBinary(), ['--contract-ocr-slot', '--dir', documentAiProject()], { env: documentAiEnv(api) });
      return { lf, close: async () => (await lf.close(), await api.close()) };
    },
  },
  {
    over: "lf's client of @listen-fire/models' OCR install",
    async start() {
      const gemini: FakeVendor = await fakeGemini();
      const dir = project();
      install(dir, 'models_ocr', 'models/lf-external.ocr.yaml', 'models/serve_ocr.ts');
      appendFileSync(join(dir, 'lf.yaml'), '\ncore:\n  ocr: models_ocr\n');
      const env = { LF_SECRET__MODELS_OCR__EXTERNAL: 'models_ocr', LF_SECRET__MODELS_OCR__VENDOR: 'gemini', LF_SECRET__MODELS_OCR__API_KEY: 'test-key', LF_SECRET__MODELS_OCR__BASE_URL: gemini.url };
      const lf = await startModule(lfBinary(), ['--contract-ocr-slot', '--dir', dir], { env });
      return { lf, close: async () => (await lf.close(), await gemini.close()) };
    },
  },
];

for (const bridge of bridges) {
  describe(bridge.over, () => {
    let started: { lf: StartedModule; close(): Promise<void> };
    before(async () => {
      started = await bridge.start();
    });
    after(async () => {
      await started.close();
    });
    for (const conformance of [...commonSlotCases('ocr', OCR_METHODS), ...ocrSlotCases]) {
      test(conformance.name, async () => {
        await conformance.run(new SlotClient(started.lf.address, {}));
      });
    }
  });
}

// ── Runs that read a scanned deck ───────────────────────────────────────────

const DECK = scannedPdfOf([textImage(['ACME ROBOTICS']), textImage(['SERIES A'])]);

/** A plugin handing the run the scanned deck as a file (`scanner.scan()`),
 *  and one reading it itself through the host (`scanner.read()`, `ctx.ocr`). */
function withScanner(dir: string): void {
  mkdirSync(join(dir, 'externals/scanner'));
  writeFileSync(join(dir, 'externals/scanner/deck.pdf'), DECK);
  writeFileSync(join(dir, 'externals/scanner/lf-external.yaml'), 'name: scanner\nkind: plugin\nmodule: ./scanner.ts\n');
  const plugin = (name: string, output: string) =>
    `{ priced: false, signature: { name: '${name}', description: '${name} the deck.', params: [], dataDependency: 'none', additions: {}, effects: {}, output: ${output} } }`;
  writeFileSync(
    join(dir, 'externals/scanner/scanner.ts'),
    `const deck = require('node:fs').readFileSync(require('node:path').join(__dirname, 'deck.pdf'));
module.exports = {
  kind: 'plugin',
  name: '@acme/scanner',
  credentials: [],
  plugins: [${plugin('scan', "{ kind: 'value', type: { kind: 'file' } }")}, ${plugin('read', "{ kind: 'value', type: { kind: 'string' } }")}],
  create: (ctx: { ocr: { read(input: { bytes: Uint8Array; contentType: string; label: string }): Promise<{ text: string }> } }) => ({
    invokePlugin: async ({ name }: { name: string }) =>
      name === 'scan'
        ? { files: { value: { name: 'deck.pdf', contentType: 'application/pdf', base64: deck.toString('base64') } } }
        : { text: (await ctx.ocr.read({ bytes: deck, contentType: 'application/pdf', label: 'scanner.read' })).text },
  }),
};
`,
  );
}

function movement(dir: string, body: string, head = ''): void {
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/deck.mvt'),
    [
      'import { acme_crm } from adapters',
      'import { `@acme/scanner` as scanner } from plugins',
      'import { acme } from credentials',
      '',
      'crm = connect acme_crm using acme',
      head,
      'function read_deck(company: <crm-[:Company]->>) {',
      body,
      '}',
      '',
      'listen to crm { events: ["company.created"] } fire read_deck',
      '',
    ].join('\n'),
  );
}

function lfRun(dir: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(['run', '--event', 'events/company_created.json']), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1', ...env } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

function spent(dir: string): number[] {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return (db.prepare('select spent_microdollars as spent from run').all() as Array<{ spent: number }>).map((r) => r.spent).sort((a, b) => a - b);
  } finally {
    db.close();
  }
}

const OCR_TEXT = `>>PAGE_START<<\n${pageText(1)}\n>>PAGE_START<<\n${pageText(2)}\n`;

test('lf run: File.read of a deck of screenshots is read by the ocr slot, two pages at $0.0015 on the run', async () => {
  const api = await fakeDocumentAi();
  try {
    const dir = documentAiProject();
    withScanner(dir);
    movement(dir, '  deck = scanner.scan()\n  write crm-[:Company]-> { Name: coalesce(File.read(deck), "none") }');
    const run = await lfRun(dir, documentAiEnv(api));
    assert.equal(run.code, 0, run.out);
    assert.ok(companies(dir).includes(OCR_TEXT), `${JSON.stringify(companies(dir))}\n${run.out}`);
    assert.equal(api.received.length, 1, run.out);
    assert.match(api.received[0]?.path ?? '', /\/v1\/projects\/acme-ocr\/locations\/eu\/processors\/proc-1:process/);
    assert.equal(Buffer.from(String((api.received[0]?.body.rawDocument as { content?: string } | undefined)?.content), 'base64').equals(DECK), true);
    assert.deepEqual(spent(dir), [3000]);
  } finally {
    await api.close();
  }
});

/** The Messages API the extraction asks, answering every call with `answer`. */
async function fakeAnthropic(answer: string): Promise<{ url: string; received: Array<Record<string, unknown>>; close(): Promise<void> }> {
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      received.push(JSON.parse(raw));
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close: () => new Promise((done) => server.close(() => done())) };
}

test('lf run: extractOne over a deck of screenshots reads the text the ocr slot gave it', async () => {
  const api = await fakeDocumentAi({ texts: ['ACME ROBOTICS', 'SERIES A: $4,000,000'] });
  const anthropic = await fakeAnthropic(JSON.stringify({ record: { name: { value: "Acme Robotics", evidence: "ACME ROBOTICS" } } }));
  try {
    const dir = documentAiProject();
    appendFileSync(join(dir, '.lf/secrets.yaml'), `\nanthropic:\n  external: "@lf/anthropic"\n  api_key: test-key\n  base_url: ${anthropic.url}\n`);
    withScanner(dir);
    movement(dir, '  deck = scanner.scan()\n  d = extractOne([deck], node D: "the company" { name: <text> "the company\'s name" })\n  write crm-[:Company]-> { Name: coalesce(d.name, "none") }');
    const run = await lfRun(dir, documentAiEnv(api));
    assert.equal(run.code, 0, run.out);
    assert.equal(api.received.length, 1, run.out);
    assert.match(JSON.stringify(anthropic.received[0]), /ACME ROBOTICS[\s\S]*SERIES A: \$4,000,000/);
    assert.ok(companies(dir).includes('Acme Robotics'), `${JSON.stringify(companies(dir))}\n${run.out}`);
    const [total = 0] = spent(dir);
    assert.ok(total > 3000, `the run spent the read's 3,000 microdollars and the model call's: ${total}`);
  } finally {
    await api.close();
    await anthropic.close();
  }
});

test("lf run: a plugin reads a scanned PDF through lf's OCR door (ctx.ocr), the read charged to the run", async () => {
  const api = await fakeDocumentAi();
  try {
    const dir = documentAiProject();
    withScanner(dir);
    movement(dir, '  write crm-[:Company]-> { Name: scanner.read() }');
    const run = await lfRun(dir, documentAiEnv(api));
    assert.equal(run.code, 0, run.out);
    assert.ok(companies(dir).includes(OCR_TEXT), `${JSON.stringify(companies(dir))}\n${run.out}`);
    assert.deepEqual(spent(dir), [3000]);
  } finally {
    await api.close();
  }
});

test('lf run: with the ocr slot empty, a scanned deck has no text and the run says why', async () => {
  const dir = project();
  withScanner(dir);
  movement(dir, '  deck = scanner.scan()\n  write crm-[:Company]-> { Name: coalesce(File.read(deck), "none") }');
  const run = await lfRun(dir, {});
  assert.equal(run.code, 0, run.out);
  assert.ok(companies(dir).includes('none'), `${JSON.stringify(companies(dir))}\n${run.out}`);
  const door = project();
  withScanner(door);
  movement(door, '  write crm-[:Company]-> { Name: scanner.read() }');
  const refused = await lfRun(door, {});
  assert.match(refused.out, /the ocr slot is empty/);
});
