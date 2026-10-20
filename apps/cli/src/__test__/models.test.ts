// A model call through the real `lf` binary: the provider key and endpoint
// come from the secrets file's `@lf/anthropic` credential, the request reaches a
// fake Anthropic Messages API, and the model's answer lands in the external's
// write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FAKE_TEXT as GEMINI_TEXT, fakeGemini } from '../../../../modules/models/__test__/fake_vendors';
import { companies, lfCommand, project } from './example';
import { ACME_LLM_ANSWER, withModelsModule } from './models_module/project';

const ANSWER = 'Vireo Robotics, welcomed by a model';

interface Received {
  headers: IncomingHttpHeaders;
  body: { model: string; messages: Array<{ content: unknown }> };
}

// Answers every request as a stream, the way the shared client asks for it,
// spending 10 input tokens and `outputTokens` output tokens.
async function fakeAnthropic(outputTokens = 8): Promise<{ url: string; received: Received[]; close: () => void }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      const events: Array<[string, object]> = [
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, close: () => server.close() };
}

// Asynchronous rather than `lf()`'s spawnSync: the fake answers from this
// process's event loop.
function lfAsync(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

test('lf run: AI() calls Anthropic on the secrets key and its answer is written', async () => {
  const fake = await fakeAnthropic();
  try {
    const dir = project();
    appendFileSync(
      join(dir, '.lf/secrets.yaml'),
      `\nanthropic:\n  external: "@lf/anthropic"\n  api_key: test-key\n  base_url: ${fake.url}\n`,
    );
    writeFileSync(
      join(dir, 'movements/named.mvt'),
      [
        'import { acme_crm } from adapters',
        'import { acme } from credentials',
        '',
        'crm = connect acme_crm using acme',
        '',
        'function name_it(company: <crm-[:Company]->>) {',
        '  write crm-[:Company]-> { Name: ai("Write a welcome line for ${company.Name}") }',
        '}',
        '',
        'listen to crm { events: ["company.created"] } fire name_it',
        '',
      ].join('\n'),
    );

    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);

    assert.equal(fake.received.length, 1, run.out);
    const [request] = fake.received;
    assert.equal(request?.headers['x-api-key'], 'test-key');
    assert.match(JSON.stringify(request?.body.messages), /Write a welcome line for Vireo Robotics/);
    assert.ok(companies(dir).includes(ANSWER), `${companies(dir).join(', ')}\n${run.out}`);
  } finally {
    fake.close();
  }
});

test('lf run: a model call with no provider key fails naming the secrets entry', async () => {
  const dir = project();
  writeFileSync(
    join(dir, 'movements/named.mvt'),
    [
      'import { acme_crm } from adapters',
      'import { acme } from credentials',
      '',
      'crm = connect acme_crm using acme',
      '',
      'function name_it(company: <crm-[:Company]->>) {',
      '  write crm-[:Company]-> { Name: ai("Write a welcome line for ${company.Name}") }',
      '}',
      '',
      'listen to crm { events: ["company.created"] } fire name_it',
      '',
    ].join('\n'),
  );
  const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
  assert.match(run.out, /a model call needs a provider key/);
});

// A call whose prompt alone, at the model's published input price, costs
// more than the run has left is not made: the run pauses before it, as at its cap.
test('lf run: a call the run cannot afford is refused before it is made, and the run pauses', async () => {
  const fake = await fakeAnthropic();
  try {
    const dir = project();
    appendFileSync(join(dir, '.lf/secrets.yaml'), `\nanthropic:\n  external: "@lf/anthropic"\n  api_key: test-key\n  base_url: ${fake.url}\n`);
    appendFileSync(join(dir, 'lf.yaml'), '\nmaxRunCostUsd: 0.000001\n');
    writeFileSync(join(dir, 'movements/named.mvt'), TWO_CALLS);
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.match(run.out, /^run \S+ named:name_it parked/m);
    assert.equal(fake.received.length, 0, run.out);
  } finally {
    fake.close();
  }
});

// As on the
// platform, a run that meets its cap pauses before the priced call that would
// go over it, and an explicit resume carries on with its usage reset.
test('lf run: lf.yaml maxRunCostUsd pauses a run at its cap; lf resume carries on', async () => {
  // 100,000 output tokens is $1 at sonnet's price: the first answer spends past a cent's cap.
  const fake = await fakeAnthropic(100_000);
  try {
    const dir = project();
    appendFileSync(join(dir, '.lf/secrets.yaml'), `\nanthropic:\n  external: "@lf/anthropic"\n  api_key: test-key\n  base_url: ${fake.url}\n`);
    appendFileSync(join(dir, 'lf.yaml'), '\nmaxRunCostUsd: 0.01\n');
    writeFileSync(
      join(dir, 'movements/named.mvt'),
      [
        'import { acme_crm } from adapters',
        'import { acme } from credentials',
        '',
        'crm = connect acme_crm using acme',
        '',
        'function name_it(company: <crm-[:Company]->>) {',
        '  line = ai("Write a welcome line for ${company.Name}")',
        '  write crm-[:Company]-> { Name: ai("Shorten: ${line}") }',
        '}',
        '',
        'listen to crm { events: ["company.created"] } fire name_it',
        '',
      ].join('\n'),
    );
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    const paused = /^run (\S+) named:name_it parked/m.exec(run.out)?.[1];
    assert.ok(paused !== undefined, run.out);
    assert.equal(fake.received.length, 1, `the first call is made, the second waits:\n${run.out}`);
    assert.ok(!companies(dir).includes(ANSWER), companies(dir).join(', '));

    const resumed = await lfAsync(dir, 'resume', paused);
    assert.match(resumed.out, new RegExp(`^run ${paused} named:name_it completed`, 'm'));
    assert.equal(fake.received.length, 2, resumed.out);
    assert.match(JSON.stringify(fake.received[1]?.body.messages), /Shorten:/);
    assert.ok(companies(dir).includes(ANSWER), `${companies(dir).join(', ')}\n${resumed.out}`);
  } finally {
    fake.close();
  }
});

const TWO_CALLS = [
  'import { acme_crm } from adapters',
  'import { acme } from credentials',
  '',
  'crm = connect acme_crm using acme',
  '',
  'function name_it(company: <crm-[:Company]->>) {',
  '  line = ai("Write a welcome line for ${company.Name}")',
  '  write crm-[:Company]-> { Name: ai("Shorten: ${line}") }',
  '}',
  '',
  'listen to crm { events: ["company.created"] } fire name_it',
  '',
].join('\n');

// A third-party models module: what it answers it spent is the run's spend,
// so maxRunCostUsd counts its calls as it counts the built-in's.
test('lf run: a models module fills the models slot; its cost is the run\'s spend and the cap counts it', async () => {
  const dir = project();
  withModelsModule(dir);
  writeFileSync(join(dir, 'movements/named.mvt'), TWO_CALLS);
  const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.ok(companies(dir).includes(ACME_LLM_ANSWER), `${companies(dir).join(', ')}\n${run.out}`);
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    const rows = db.prepare('select spent_microdollars as spent from run').all() as Array<{ spent: number }>;
    // The example's own movement runs too, and calls no model.
    assert.deepEqual(rows.map((r) => r.spent).sort((a, b) => a - b), [0, 5000]);
  } finally {
    db.close();
  }

  const capped = project();
  withModelsModule(capped);
  appendFileSync(join(capped, 'lf.yaml'), '\nmaxRunCostUsd: 0.001\n');
  writeFileSync(join(capped, 'movements/named.mvt'), TWO_CALLS);
  const parked = await lfAsync(capped, 'run', '--event', 'events/company_created.json');
  assert.match(parked.out, /^run \S+ named:name_it parked/m, 'the first call spent past the cap, so the second waits');
  assert.ok(!companies(capped).includes(ACME_LLM_ANSWER), companies(capped).join(', '));
});

test('lf run: a models module answer without its token usage is refused', async () => {
  const dir = project();
  withModelsModule(dir, { ACME_LLM_NO_USAGE: '1' });
  writeFileSync(join(dir, 'movements/named.mvt'), TWO_CALLS);
  const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
  assert.match(run.out, /models\.call answered .*not \{ text, cost, usage/);
});

// A process module that asks the host for a model call (`ctx.models`): under a
// plain `lf run` too, not only `lf serve`, lf serves the models door and
// tells the externals it starts where it is (LF_HOST_URL, LF_HOST_TOKEN).
test('lf run: a plugin module asks the host for a model call through the models door', async () => {
  const fake = await fakeAnthropic();
  try {
    const dir = project();
    appendFileSync(join(dir, '.lf/secrets.yaml'), `\nanthropic:\n  external: "@lf/anthropic"\n  api_key: test-key\n  base_url: ${fake.url}\n`);
    mkdirSync(join(dir, 'externals/greeter'));
    writeFileSync(join(dir, 'externals/greeter/lf-external.yaml'), 'name: greeter\nkind: plugin\nmodule: ./greeter.ts\n');
    writeFileSync(
      join(dir, 'externals/greeter/greeter.ts'),
      `module.exports = {
  kind: 'plugin',
  name: '@acme/greeter',
  credentials: [],
  plugins: [{
    priced: false,
    signature: {
      name: 'greet',
      description: 'A welcome line for a company, written by the host\\'s model.',
      params: [{ name: 'name', type: { kind: 'string' }, required: true }],
      dataDependency: 'none',
      additions: {},
      effects: {},
      output: { kind: 'value', type: { kind: 'string' } },
    },
  }],
  create: (ctx: { models: { chat(input: { label: string; system: string; userMessage: string }): Promise<string> } }) => ({
    invokePlugin: async ({ config }: { config: Record<string, unknown> }) => ({
      text: await ctx.models.chat({ label: 'greeter.greet', system: 'You write welcome lines.', userMessage: \`Greet \${String(config.name)}\` }),
    }),
  }),
};
`,
    );
    rmSync(join(dir, 'movements/companies.mvt'));
    writeFileSync(
      join(dir, 'movements/greeted.mvt'),
      [
        'import { acme_crm } from adapters',
        'import { `@acme/greeter` as greeter } from plugins',
        'import { acme } from credentials',
        '',
        'crm = connect acme_crm using acme',
        '',
        'function greet_it(company: <crm-[:Company]->>) {',
        '  write crm-[:Company]-> { Name: greeter.greet(company.Name) }',
        '}',
        '',
        'listen to crm { events: ["company.created"] } fire greet_it',
        '',
      ].join('\n'),
    );
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);
    assert.equal(fake.received.length, 1, run.out);
    assert.match(JSON.stringify(fake.received[0]?.body.messages), /Greet Vireo Robotics/);
    assert.ok(companies(dir).includes(ANSWER), `${companies(dir).join(', ')}\n${run.out}`);
  } finally {
    fake.close();
  }
});

// @lf/models (modules/models) filling the models slot on Gemini, its settings
// in the secrets file as `lf connect models` writes them: AI() reaches the
// fake Gemini API on the install's key, and what the module priced the call
// at (from the shared price table) is the run's spend.
test('lf run: @lf/models on Gemini answers AI() and its priced cost is the run\'s spend', async () => {
  const gemini = await fakeGemini();
  try {
    const dir = project();
    const serve = resolve(__dirname, '../../../../modules/models/serve.ts');
    const command = [process.execPath, '--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), serve];
    const manifest = readFileSync(resolve(__dirname, '../../../../modules/models/lf-external.yaml'), 'utf8')
      .replace(/^command: .*$/m, `command: [${command.map((part) => JSON.stringify(part)).join(', ')}]`);
    mkdirSync(join(dir, 'externals/models'), { recursive: true });
    writeFileSync(join(dir, 'externals/models/lf-external.yaml'), manifest);
    appendFileSync(join(dir, 'lf.yaml'), '\ncore:\n  models: models\n');
    appendFileSync(join(dir, '.lf/secrets.yaml'), `\nmodels:\n  external: models\n  vendor: gemini\n  api_key: test-key\n  base_url: ${gemini.url}\n`);
    writeFileSync(join(dir, 'movements/named.mvt'), TWO_CALLS);

    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);
    assert.ok(companies(dir).includes(GEMINI_TEXT), `${companies(dir).join(', ')}\n${run.out}`);
    assert.equal(gemini.received.length, 2, run.out);
    assert.match(gemini.received[0]?.path ?? '', /\/models\/gemini-3\.8-flash:streamGenerateContent/);
    assert.match(JSON.stringify(gemini.received[0]?.body), /Write a welcome line for Vireo Robotics/);
    const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
    try {
      const rows = db.prepare('select spent_microdollars as spent from run').all() as Array<{ spent: number }>;
      // Two calls, each 10 tokens in and 4 out at gemini-3.8-flash's $1.50 / $7.50 per million: 45 apiece.
      assert.deepEqual(rows.map((r) => r.spent).sort((a, b) => a - b), [0, 90]);
    } finally {
      db.close();
    }
  } finally {
    await gemini.close();
  }
});
