// Fake vendor APIs for the models module's tests: local HTTP servers that
// answer the real vendor SDKs' streamed requests the way the vendor would,
// so what reaches them is the wire request a real key would send.
//
// - Gemini (Google's Gemini API, as the SDK speaks it with an API key):
//   `POST /v1beta/models/<model>:streamGenerateContent?alt=sse`.
// - OpenAI: `POST /chat/completions` with `stream: true`.
//
// Each answers 10 input tokens and min(4, the request's output ceiling)
// output tokens; a forced function call is answered with a call whose
// arguments are `{ greeting: 'hello' }`.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface FakeVendor {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

export const FAKE_TEXT = 'Hello from the fake vendor';
export const INPUT_TOKENS = 10;
const OUTPUT_TOKENS = 4;

function field(value: unknown, ...path: string[]): unknown {
  let at: unknown = value;
  for (const key of path) at = at !== null && typeof at === 'object' ? Reflect.get(at, key) : undefined;
  return at;
}

async function serve(answer: (request: Received) => string[]): Promise<FakeVendor> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const one: Received = { path: request.url ?? '/', headers: request.headers, body: raw === '' ? {} : JSON.parse(raw) };
      received.push(one);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(answer(one).map((data) => `data: ${data}\n\n`).join(''));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

export function fakeGemini(): Promise<FakeVendor> {
  return serve(({ body }) => {
    const ceiling = field(body, 'generationConfig', 'maxOutputTokens');
    const output = Math.min(OUTPUT_TOKENS, typeof ceiling === 'number' ? ceiling : OUTPUT_TOKENS);
    const forced = field(body, 'toolConfig', 'functionCallingConfig', 'mode') === 'ANY';
    const declarations = field(body, 'tools', '0', 'functionDeclarations');
    const name = Array.isArray(declarations) ? field(declarations[0], 'name') : undefined;
    const part = forced ? { functionCall: { name, args: { greeting: 'hello' } } } : { text: FAKE_TEXT };
    return [
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: INPUT_TOKENS, candidatesTokenCount: output, totalTokenCount: INPUT_TOKENS + output },
        modelVersion: 'fake',
      }),
    ];
  });
}

export function fakeOpenAi(): Promise<FakeVendor> {
  return serve(({ body }) => {
    const ceiling = body.max_completion_tokens;
    const output = Math.min(OUTPUT_TOKENS, typeof ceiling === 'number' ? ceiling : OUTPUT_TOKENS);
    const forced = field(body, 'tool_choice', 'function', 'name');
    const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: String(body.model) };
    const delta =
      typeof forced === 'string'
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: forced, arguments: JSON.stringify({ greeting: 'hello' }) } }] }
        : { role: 'assistant', content: FAKE_TEXT };
    return [
      JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }),
      JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: typeof forced === 'string' ? 'tool_calls' : 'stop' }] }),
      JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: INPUT_TOKENS, completion_tokens: output, total_tokens: INPUT_TOKENS + output } }),
      '[DONE]',
    ];
  });
}
