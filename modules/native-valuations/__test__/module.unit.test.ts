// The module as a host loads it: its definition, the API it opens from a
// credential, the webhook helpers' requests, and a delivery's arrival.

import { adapterInProcess, inProcessValidationDefault, refusingFiles, refusingKv } from 'module-kit';

import { NativeValuationsAdapter, nativeValuationsModule, registerValuationsWebhook, deregisterValuationsWebhook, valuationsApiFrom } from '../index';

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

describe('a delivery', () => {
  const adapter = new NativeValuationsAdapter({ api: async () => null, log: quiet });
  const delivery = (event: string, before: unknown, after: unknown) => ({
    event,
    timestamp: '2026-11-02T10:00:00.000Z',
    actor: { type: 'system', id: null },
    data: { id: 'le-1', before, after },
  });

  it('arrives on the row’s Changes, about the row by its entity’s name and id, with the row before and after', async () => {
    const { events, arrivals } = await adapter.preprocessInbound({
      raw: delivery('valuations:legal_entity:update', { id: 'le-1', name: 'Acme', city: 'Leeds' }, { id: 'le-1', name: 'Acme Ltd', city: 'Leeds' }),
    });
    expect(events).toEqual([]);
    expect(arrivals).toEqual([
      {
        edge: 'Changes',
        key: 'le-1',
        identity: 'legal_entity:le-1:updated:2026-11-02T10:00:00.000Z',
        landing: {
          recordId: 'legal_entity:le-1:updated:2026-11-02T10:00:00.000Z',
          recordType: 'Legal Entity Change',
          fields: {
            Id: 'legal_entity:le-1:updated:2026-11-02T10:00:00.000Z',
            Kind: 'updated',
            'Changed Fields': ['Name'],
            'Record Id': 'le-1',
            Current: { Id: 'le-1', Name: 'Acme Ltd', City: 'Leeds' },
            Previous: { Id: 'le-1', Name: 'Acme', City: 'Leeds' },
          },
        },
        parents: [{ recordId: 'le-1', recordType: 'Legal Entity', fields: { id: 'le-1', name: 'Acme Ltd', city: 'Leeds' } }],
        about: { recordType: 'Legal Entity', externalId: 'le-1' },
        occurredAt: '2026-11-02T10:00:00.000Z',
      },
    ]);
  });

  it('names what a created row was given, and carries the deleted row as it was', async () => {
    const created = await adapter.preprocessInbound({ raw: delivery('valuations:asset:create', null, { id: 'le-1', name: 'Shares', type: null }) });
    expect(created.arrivals[0]?.landing).toMatchObject({ recordType: 'Asset Change', fields: { Kind: 'created', 'Changed Fields': ['Id', 'Name'] } });
    expect(created.arrivals[0]?.landing.fields).not.toHaveProperty('Previous');
    const deleted = await adapter.preprocessInbound({ raw: delivery('valuations:asset:delete', { id: 'le-1', name: 'Shares' }, null) });
    expect(deleted.arrivals[0]?.landing.fields).toMatchObject({ Kind: 'deleted', 'Changed Fields': [], Previous: { Id: 'le-1', Name: 'Shares' } });
    expect(deleted.arrivals[0]?.parents).toEqual([{ recordId: 'le-1', recordType: 'Asset', fields: { id: 'le-1', name: 'Shares' } }]);
  });

  it('runs nothing for junk or an entity it does not describe', async () => {
    expect((await adapter.preprocessInbound({ raw: { event: 'valuations:legal_entity:update' } })).arrivals).toEqual([]);
    expect((await adapter.preprocessInbound({ raw: delivery('valuations:fund:update', null, {}) })).arrivals).toEqual([]);
  });

  it('hangs a listenable Changes off each entity, landing on its change type', async () => {
    const entity = await adapter.describe('Legal Entity');
    expect(entity?.references.find((ref) => ref.name === 'Changes')).toMatchObject({
      targetTypeId: 'Legal Entity Change',
      listenable: true,
      delivery: 'connection',
      identity: 'Id',
      carries: ['Legal Entity'],
    });
    const investment = await adapter.describe('Investment');
    expect(investment?.references.find((ref) => ref.name === 'Changes')).not.toHaveProperty('carries');
    const change = await adapter.describe('Legal Entity Change');
    expect(change?.fields.map((field) => field.fieldId)).toEqual(['Id', 'Kind', 'Changed Fields', 'Record Id', 'Current', 'Previous']);
    await expect(adapter.arrivals.awaitKeys({ edge: 'Changes', heads: [{ recordId: 'le-1' }] })).resolves.toEqual([{ key: 'le-1' }]);
  });
});
