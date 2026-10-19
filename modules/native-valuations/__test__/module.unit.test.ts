// The module as a host loads it: its definition, the API it opens from a
// credential, the webhook helpers' requests, and the inbound parse.

import { adapterInProcess, inProcessValidationDefault, refusingFiles, refusingKv } from 'module-kit';

import { nativeValuationsModule, registerValuationsWebhook, deregisterValuationsWebhook, valuationsApiFrom, parseValuationsEvents } from '../index';

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('the module definition', () => {
  it('answers to the hyphenated tag and declares its signed inbound', () => {
    expect(nativeValuationsModule.manifest.adapterType).toBe('native-valuations');
    expect(nativeValuationsModule.inbound).toMatchObject({ providerKey: 'native_valuations', scheme: 'attio' });
  });

  it('loads in process, reading the credential on each call', async () => {
    const seen: string[] = [];
    let fields: Record<string, string> = { apiKey: 'first', baseUrl: 'http://vals.test' };
    const loaded = adapterInProcess(nativeValuationsModule, {
      tenant: 'team-1',
      credential: { name: 'native_valuations', fields: async () => fields, update: async () => {} },
      kv: refusingKv('none'),
      files: refusingFiles('none'),
      log: quiet,
      fetch: async (_url, init) => {
        seen.push(String(new Headers(init?.headers).get('authorization')));
        return new Response(JSON.stringify({ data: { id: 'le-1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      validateResults: inProcessValidationDefault({}),
    });
    await loaded.adapter.readRecord?.({ recordType: 'Legal Entity', externalId: 'le-1' });
    fields = { apiKey: 'rotated', baseUrl: 'http://vals.test' };
    await loaded.adapter.readRecord?.({ recordType: 'Legal Entity', externalId: 'le-1' });
    expect(seen).toEqual(['Bearer first', 'Bearer rotated']);
  });
});

describe('valuationsApiFrom', () => {
  it('strips the /api/v1 an old credential stored in its base URL', () => {
    expect(valuationsApiFrom({ apiKey: 'k', baseUrl: 'https://app.example/api/v1/' }, { fetch })?.baseUrl).toBe('https://app.example');
  });

  it('prefers the host override, and is null without a key', () => {
    expect(valuationsApiFrom({ apiKey: 'k', baseUrl: 'https://app.example' }, { fetch, baseUrlOverride: 'http://fake' })?.baseUrl).toBe('http://fake');
    expect(valuationsApiFrom({ baseUrl: 'https://app.example' }, { fetch })).toBeNull();
    expect(valuationsApiFrom({ apiKey: '', baseUrl: 'https://app.example' }, { fetch })).toBeNull();
  });

  it('refuses a key with nowhere to send it', () => {
    expect(() => valuationsApiFrom({ apiKey: 'k' }, { fetch })).toThrow(/names no base URL/);
  });
});

describe('the webhook helpers', () => {
  it('register with a fresh secret and deregister by the target URL', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const api = {
      apiKey: 'k',
      baseUrl: 'http://vals.test',
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
        return new Response(null, { status: 204 });
      },
    };
    const registered = await registerValuationsWebhook(api, { targetUrl: 'https://cb/x', eventTypes: ['valuations:legal_entity:create'] });
    await deregisterValuationsWebhook(api, { externalId: 'https://cb/x' });
    expect(registered.externalId).toBe('https://cb/x');
    expect(registered.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([
      { url: 'http://vals.test/api/v1/valuations/webhooks', method: 'POST', body: { url: 'https://cb/x', eventTypes: ['valuations:legal_entity:create'], secret: registered.secret } },
      { url: 'http://vals.test/api/v1/valuations/webhooks?url=https%3A%2F%2Fcb%2Fx', method: 'DELETE', body: null },
    ]);
  });
});

describe('parseValuationsEvents', () => {
  it('makes one event of a delivery, its entity the record type, and nothing of junk', () => {
    const delivery = { event: 'valuations:investment:update', timestamp: 't', actor: { type: 'system', id: null }, data: { id: 'inv-1', before: null, after: { id: 'inv-1' } } };
    expect(parseValuationsEvents(delivery)).toEqual([
      { payload: delivery, externalId: 'inv-1', recordType: 'investment', eventType: 'valuations:investment:update', actor: { type: 'system', id: null } },
    ]);
    expect(parseValuationsEvents({ event: 'valuations:investment:update' })).toEqual([]);
  });
});
