// `ctx.fetch` asks the host's limits door before each request to the
// provider (retries too), reports a 429 as a throttle, and is the plain fetch
// on a call that hands no door.

import { Readable } from 'node:stream';

import { PROTOCOL_VERSION } from 'engine-contracts';
import type { PluginDeclaration } from 'engine-contracts';

import type { IncomingMessage, ServerResponse } from 'node:http';

import { defineModule } from '../define';
import { DEFAULT_THROTTLE_MS, limitedFetch, retryAfterMs } from '../host_limits';
import { refusingFiles, refusingKv } from '../in_process';
import { createModuleProtocolHandler } from '../module_server';

const door = { url: 'http://127.0.0.1:7777/api/public/adapter/%40lf%2Fpaced/limits', ticket: 't-1' };
const PROVIDER = 'https://api.example.com/things';

/** A fetch answering the door from `grants` (granted when it runs out) and
 *  the provider from `statuses` (200 when it runs out), logging each. */
function fakeFetch(opts: { grants?: Array<{ outcome: 'granted'; permit: string } | { outcome: 'wait'; retryAfterMs: number }>; statuses?: Array<{ status: number; retryAfter?: string }> } = {}) {
  const log: string[] = [];
  const grants = [...(opts.grants ?? [])];
  const statuses = [...(opts.statuses ?? [])];
  let permits = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === door.url) {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${door.ticket}`);
      const question: Record<string, unknown> = JSON.parse(String(init?.body));
      log.push(`door:${question.op}${question.permit !== undefined ? `:${question.permit}` : ''}${question.retryAfterMs !== undefined ? `:${question.retryAfterMs}` : ''}`);
      if (question.op !== 'acquire') return Response.json({});
      return Response.json(grants.shift() ?? { outcome: 'granted', permit: `p${++permits}` });
    }
    log.push(`provider:${url}`);
    const next = statuses.shift() ?? { status: 200 };
    return new Response('{}', { status: next.status, headers: next.retryAfter !== undefined ? { 'retry-after': next.retryAfter } : {} });
  };
  return { impl, log };
}

test('each request to the provider is asked for before it is sent and released after', async () => {
  const { impl, log } = fakeFetch();
  const limited = limitedFetch(impl, door);
  await limited(PROVIDER);
  await limited(new URL(PROVIDER));
  expect(log).toEqual(['door:acquire', `provider:${PROVIDER}`, 'door:release:p1', 'door:acquire', `provider:${PROVIDER}`, 'door:release:p2']);
});

test('a module retrying its provider asks again for each retry', async () => {
  const { impl, log } = fakeFetch({ statuses: [{ status: 503 }, { status: 503 }, { status: 200 }] });
  const limited = limitedFetch(impl, door);
  let response = await limited(PROVIDER);
  while (response.status === 503) response = await limited(PROVIDER);
  expect(log.filter((line) => line === 'door:acquire')).toHaveLength(3);
  expect(log.filter((line) => line.startsWith('door:release'))).toHaveLength(3);
});

test('told to wait, it waits that long and asks again', async () => {
  const { impl, log } = fakeFetch({ grants: [{ outcome: 'wait', retryAfterMs: 250 }, { outcome: 'granted', permit: 'late' }] });
  const slept: number[] = [];
  const limited = limitedFetch(impl, door, { sleep: async (ms) => void slept.push(ms) });
  await limited(PROVIDER);
  expect(slept).toEqual([250]);
  expect(log).toEqual(['door:acquire', 'door:acquire', `provider:${PROVIDER}`, 'door:release:late']);
});

test("a provider's 429 is reported as a throttle, before the permit is released", async () => {
  const { impl, log } = fakeFetch({ statuses: [{ status: 429, retryAfter: '7' }] });
  const response = await limitedFetch(impl, door)(PROVIDER);
  expect(response.status).toBe(429);
  expect(log).toEqual(['door:acquire', `provider:${PROVIDER}`, 'door:throttle:7000', 'door:release:p1']);
});

test('a Retry-After is seconds or a date; without one the quiet is short', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  expect(retryAfterMs('30', now)).toBe(30_000);
  expect(retryAfterMs('Tue, 20 Oct 2026 12:00:05 GMT', now)).toBe(5000);
  expect(retryAfterMs(null, now)).toBe(DEFAULT_THROTTLE_MS);
  expect(retryAfterMs('soon', now)).toBe(DEFAULT_THROTTLE_MS);
});

test("the host's own URLs (its files, its doors) are not the provider's requests", async () => {
  const { impl, log } = fakeFetch();
  await limitedFetch(impl, door)('http://127.0.0.1:7777/files/f1');
  expect(log).toEqual(['provider:http://127.0.0.1:7777/files/f1']);
});

test('without a door it is the fetch it was given', () => {
  const { impl } = fakeFetch();
  expect(limitedFetch(impl, undefined)).toBe(impl);
});

// ── Through the module server ───────────────────────────────────────────────

const FETCH_TWICE: PluginDeclaration = {
  priced: false,
  signature: {
    name: 'fetch_twice',
    description: 'Two requests to the provider.',
    params: [],
    dataDependency: 'none',
    additions: {},
    effects: {},
    output: { kind: 'value', type: { kind: 'string' } },
  },
};

const paced = defineModule({
  kind: 'plugin',
  name: '@lf/paced',
  credentials: [],
  limits: [{ scope: 'credential', calls: 10, per: '1s' }],
  plugins: [FETCH_TWICE],
  create: (ctx) => ({
    invokePlugin: async () => {
      await ctx.fetch(PROVIDER);
      await ctx.fetch(PROVIDER);
      return { text: 'done' };
    },
  }),
});

async function post(impl: typeof fetch, envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = createModuleProtocolHandler({
    definition: paced,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: impl,
    files: refusingFiles('no files'),
    kvFor: () => refusingKv('no kv'),
  });
  const req = Object.assign(Readable.from([JSON.stringify({ protocolVersion: PROTOCOL_VERSION, cacheScopeId: 's', ...envelope })]), {
    headers: {},
  }) as unknown as IncomingMessage;
  let payload = '';
  const res = { writeHead: () => undefined, end: (body: string) => void (payload = body) } as unknown as ServerResponse;
  await handler(req, res);
  return JSON.parse(payload);
}

const invoke = { method: 'invokePlugin', params: { name: 'fetch_twice', config: {}, extractedContext: {} } };

test('a module with limits says it asks per request, and asks the door its call was handed', async () => {
  const { impl, log } = fakeFetch();
  const manifest = await post(impl, { method: 'manifest', params: {} });
  expect(manifest.result).toMatchObject({ hostLimits: true, limits: [{ scope: 'credential', calls: 10, per: '1s' }] });
  const body = await post(impl, { ...invoke, hostLimits: door });
  expect(body.ok).toBe(true);
  expect(log.filter((line) => line === 'door:acquire')).toHaveLength(2);
});

test('a call handed no door (the host counted it) asks nobody', async () => {
  const { impl, log } = fakeFetch();
  const body = await post(impl, invoke);
  expect(body.ok).toBe(true);
  expect(log).toEqual([`provider:${PROVIDER}`, `provider:${PROVIDER}`]);
});
