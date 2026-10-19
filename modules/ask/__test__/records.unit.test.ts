// The lattice over a kv: open → answered | expired, both terminal, the first
// settle standing. A host whose kv several processes share refuses the settle
// another writer beat; the loser reads the winner back as `closed`.

import type { ModuleKv } from 'module-kit';

import { answerAsk, askByToken, cancelAsk, createAsk, getAsk, type AskRecords } from '../records';

function memoryKv(): ModuleKv & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, value) => {
      entries.set(key, JSON.parse(JSON.stringify(value)));
    },
    delete: async (key) => {
      entries.delete(key);
    },
    list: async (prefix) => [...entries].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    compareAndSet: async () => false,
  };
}

function records(kv: ModuleKv = memoryKv()): AskRecords {
  return { kv, answerUrl: (token) => `https://host.test/api/asks/${token}` };
}

describe('raising an ask', () => {
  it('keeps the record and its token, and links it at the host door', async () => {
    const asks = records();
    const ask = await createAsk(asks, { family: 'Check', prompt: 'Ship it?' });
    expect(ask).toMatchObject({ family: 'Check', state: 'open', answer: null });
    expect(ask.token.startsWith('ask_')).toBe(true);
    expect(ask.url).toBe(`https://host.test/api/asks/${ask.token}`);
    expect(await askByToken(asks, ask.token)).toMatchObject({ id: ask.id });
    expect(await askByToken(asks, 'not_a_token')).toBeNull();
  });
});

describe('answering', () => {
  it('coerces against the family and settles once', async () => {
    const asks = records();
    const ask = await createAsk(asks, { family: 'Check', prompt: 'Ship it?' });
    const first = await answerAsk(asks, { id: ask.id, raw: 'true' });
    expect(first).toMatchObject({ kind: 'settled', ask: { state: 'answered', answer: true } });
    const second = await answerAsk(asks, { id: ask.id, raw: false });
    expect(second).toMatchObject({ kind: 'closed', ask: { answer: true } });
  });

  it('refuses an answer that does not fit, leaving the ask open', async () => {
    const asks = records();
    const ask = await createAsk(asks, { family: 'Choose', prompt: 'Which?', options: ['a', 'b'] });
    expect(await answerAsk(asks, { id: ask.id, raw: 'c' })).toMatchObject({ kind: 'invalid' });
    expect((await getAsk(asks, ask.id))?.state).toBe('open');
  });

  it('is not_found for an ask the kv does not hold', async () => {
    expect(await answerAsk(records(), { id: '00000000-0000-4000-8000-000000000009', raw: true })).toEqual({ kind: 'not_found' });
  });

  it('refuses once the token has lapsed', async () => {
    const kv = memoryKv();
    const asks = records(kv);
    const ask = await createAsk(asks, { family: 'Check', prompt: 'Ship it?' });
    kv.entries.set(`ask:${ask.id}`, { ...(kv.entries.get(`ask:${ask.id}`) as object), tokenExpiresAt: new Date(0).toISOString() });
    expect(await answerAsk(asks, { id: ask.id, raw: true })).toMatchObject({ kind: 'closed' });
  });

  it('loses to a settle the host saw first: the host refuses, the record says closed', async () => {
    const kv = memoryKv();
    const asks = records(kv);
    const ask = await createAsk(asks, { family: 'Check', prompt: 'Ship it?' });
    // Another process answered between our read and our write; the host's
    // guard turns our write away.
    const racing: ModuleKv = {
      ...kv,
      set: async (key, value) => {
        kv.entries.set(key, { ...(kv.entries.get(key) as object), state: 'answered', answer: false });
        throw new Error('already settled');
      },
    };
    expect(await answerAsk(records(racing), { id: ask.id, raw: true })).toMatchObject({
      kind: 'closed',
      ask: { state: 'answered', answer: false },
    });
  });

  it('raises a write the host refused for any other reason', async () => {
    const kv = memoryKv();
    const ask = await createAsk(records(kv), { family: 'Check', prompt: 'Ship it?' });
    const broken: ModuleKv = { ...kv, set: async () => { throw new Error('disk full'); } };
    await expect(answerAsk(records(broken), { id: ask.id, raw: true })).rejects.toThrow('disk full');
  });
});

describe('cancelling', () => {
  it('expires an open ask, and a settled one is closed', async () => {
    const asks = records();
    const ask = await createAsk(asks, { family: 'Review', prompt: 'FYI' });
    expect(await cancelAsk(asks, { id: ask.id })).toMatchObject({ kind: 'settled', ask: { state: 'expired' } });
    expect(await cancelAsk(asks, { id: ask.id })).toMatchObject({ kind: 'closed' });
    expect(await answerAsk(asks, { id: ask.id, raw: 'ok' })).toMatchObject({ kind: 'closed', ask: { state: 'expired' } });
  });
});

describe('a host with no answer door', () => {
  it('refuses to raise an ask by name', async () => {
    const kv = memoryKv();
    const { AskAdapter } = await import('../adapter');
    const adapter = new AskAdapter({
      kv,
      answerUrl: () => {
        throw new Error('ask: this host has no answer door');
      },
    });
    await expect(
      adapter.createRecord({
        recordType: 'Check',
        fields: { Prompt: 'Ship it?' },
        mutationContext: { source: { type: 'agent' }, occurredAt: new Date().toISOString() },
      }),
    ).rejects.toThrow(/no answer door/);
    expect(kv.entries.size).toBe(0);
  });
});
