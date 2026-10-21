import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { openAiRoutes } from '../openai';

/**
 * Route-level tests for the fake OpenAI chat completions, run via `node --test`
 * (through `tsx --test`, no jest in this package — see package.json). The
 * fake is stateless, so each test only needs its own listener.
 */

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/openai/v1', openAiRoutes());
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}/openai/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_weather',
    description: 'Weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, days: { type: 'integer' }, unit: { enum: ['c', 'f'] } },
      required: ['city', 'unit'],
    },
  },
};

const BASE = {
  model: 'gpt-5',
  max_completion_tokens: 256,
  messages: [{ role: 'user', content: 'Weather in Paris?' }],
};

async function post(baseUrl: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test', ...headers },
    body: JSON.stringify(body),
  });
}

/** Every `data:` frame of an SSE body, `[DONE]` included as the string. */
async function frames(res: globalThis.Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => f.slice('data: '.length))
    .map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
}

interface ChunkLike {
  choices: Array<{
    delta: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } };
}

function assemble(all: unknown[]) {
  const chunks = all.filter((f): f is ChunkLike => f !== '[DONE]');
  let text = '';
  let args = '';
  let name: string | undefined;
  let id: string | undefined;
  let finish: string | null = null;
  for (const c of chunks) {
    for (const choice of c.choices) {
      text += choice.delta.content ?? '';
      for (const call of choice.delta.tool_calls ?? []) {
        id ??= call.id;
        name ??= call.function?.name;
        args += call.function?.arguments ?? '';
      }
      finish = choice.finish_reason ?? finish;
    }
  }
  return { text, args, name, id, finish, usage: chunks.find((c) => c.usage)?.usage, done: all.at(-1) === '[DONE]' };
}

test('openai: 401 without a bearer key', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BASE),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('openai: text scenario, non streaming', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await post(baseUrl, BASE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'gpt-5');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.choices[0].message.content, 'Hello from the fake OpenAI.');
    assert.ok(body.usage.prompt_tokens > 0);
  } finally {
    await close();
  }
});

test('openai: text scenario, streamed in pieces with a usage frame and [DONE]', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await post(baseUrl, { ...BASE, stream: true, stream_options: { include_usage: true } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const all = await frames(res);
    const reply = assemble(all);
    assert.equal(reply.text, 'Hello from the fake OpenAI.');
    assert.equal(reply.finish, 'stop');
    assert.ok(reply.done);
    assert.ok(reply.usage);
    assert.equal(reply.usage.prompt_tokens_details.cached_tokens, Math.floor(reply.usage.prompt_tokens / 2));
    assert.ok(all.length > 4, 'the text arrives in more than one delta');
  } finally {
    await close();
  }
});

test('openai: tool_call scenario builds arguments from the tool schema', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await post(baseUrl, { ...BASE, stream: true, tools: [WEATHER_TOOL] }, { 'X-Fake-Scenario': 'tool_call' });
    const reply = assemble(await frames(res));
    assert.equal(reply.name, 'lookup_weather');
    assert.match(reply.id ?? '', /^call_fake_/);
    assert.deepEqual(JSON.parse(reply.args), { city: 'fake', unit: 'c' });
    assert.equal(reply.finish, 'tool_calls');
    assert.equal(reply.usage, undefined, 'no usage frame unless include_usage asked for one');
  } finally {
    await close();
  }
});

test('openai: with no header, a forced tool is called and finishes with stop, as OpenAI does', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await post(baseUrl, {
      ...BASE,
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
    });
    const body = await res.json();
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'lookup_weather');
  } finally {
    await close();
  }
});

test('openai: with no header, a tool loop calls once and then answers the result in text', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const first = await (await post(baseUrl, { ...BASE, tools: [WEATHER_TOOL] })).json();
    const call = first.choices[0].message.tool_calls[0];
    assert.equal(first.choices[0].finish_reason, 'tool_calls');

    const second = await (
      await post(baseUrl, {
        ...BASE,
        tools: [WEATHER_TOOL],
        messages: [
          ...BASE.messages,
          { role: 'assistant', tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: '{"temp":21}' },
        ],
      })
    ).json();
    assert.equal(second.choices[0].finish_reason, 'stop');
    assert.equal(second.choices[0].message.content, 'The fake OpenAI read 1 tool result(s).');
  } finally {
    await close();
  }
});

test('openai: length scenario', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const reply = assemble(await frames(await post(baseUrl, { ...BASE, stream: true }, { 'X-Fake-Scenario': 'length' })));
    assert.equal(reply.finish, 'length');
    assert.ok(reply.text.length > 0);
  } finally {
    await close();
  }
});

test('openai: partial_tool_json scenario cuts the arguments mid-JSON and finishes with length', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const reply = assemble(
      await frames(await post(baseUrl, { ...BASE, stream: true, tools: [WEATHER_TOOL] }, { 'X-Fake-Scenario': 'partial_tool_json' })),
    );
    assert.equal(reply.finish, 'length');
    assert.throws(() => JSON.parse(reply.args));
  } finally {
    await close();
  }
});

test('openai: the request is validated against the documented body', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const cases: Array<[string, unknown, string]> = [
      ['unknown top-level field', { ...BASE, max_output_tokens: 5 }, ''],
      ['empty tools array', { ...BASE, tools: [] }, 'tools'],
      ['bad reasoning_effort', { ...BASE, reasoning_effort: 'xhigh' }, 'reasoning_effort'],
      ['more than four stops', { ...BASE, stop: ['a', 'b', 'c', 'd', 'e'] }, 'stop'],
      ['bare base64 image', { ...BASE, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'iVBOR' } }] }] }, 'messages.0.content'],
      [
        'pdf without a data URL',
        { ...BASE, messages: [{ role: 'user', content: [{ type: 'file', file: { file_data: 'JVBER', filename: 'a.pdf' } }] }] },
        'messages.0.content',
      ],
    ];
    for (const [label, body, param] of cases) {
      const res = await post(baseUrl, body);
      assert.equal(res.status, 400, label);
      const error = (await res.json()).error;
      assert.equal(error.type, 'invalid_request_error', label);
      if (param) assert.ok(String(error.param).startsWith(param), `${label}: param ${error.param}`);
    }
  } finally {
    await close();
  }
});

test('openai: tool messages must answer the assistant turn right before them', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const orphan = await post(baseUrl, {
      ...BASE,
      messages: [...BASE.messages, { role: 'tool', tool_call_id: 'call_x', content: 'r' }],
    });
    assert.equal(orphan.status, 400);

    const unanswered = await post(baseUrl, {
      ...BASE,
      messages: [
        ...BASE.messages,
        { role: 'assistant', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'user', content: 'next' },
      ],
    });
    assert.equal(unanswered.status, 400);
    assert.match((await unanswered.json()).error.message, /missing: call_x/);
  } finally {
    await close();
  }
});

test('openai: an unknown scenario, or a tool scenario with no tools, is a 400', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    assert.equal((await post(baseUrl, BASE, { 'X-Fake-Scenario': 'nope' })).status, 400);
    assert.equal((await post(baseUrl, BASE, { 'X-Fake-Scenario': 'tool_call' })).status, 400);
  } finally {
    await close();
  }
});
