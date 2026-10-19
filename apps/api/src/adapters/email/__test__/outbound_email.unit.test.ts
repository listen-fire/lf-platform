// The outbound-email seam's two guarantees:
//   1. an adapter that did not deliver reports FALSE (it used to report true),
//   2. every send lands in outbound_email, success or failure.

const inserted: { table: string; values: unknown }[] = [];
let insertShouldThrow = false;

function qbDouble() {
  return {
    insertInto: (table: string) => ({
      values: (values: unknown) => ({
        execute: async () => {
          if (insertShouldThrow) throw new Error('ledger table missing');
          inserted.push({ table, values });
          return [];
        },
      }),
    }),
  };
}

jest.mock('../../../lib/kysely', () => ({
  getQb: () => qbDouble(),
  getCoreQb: () => qbDouble(),
  getAutomationsQb: () => qbDouble(),
}));

import type { OutboundEmailMessager, SendArgs } from '@listen-fire/email';

import { withOutboundEmailLedger } from '../ledger';
import { FakeOutboundEmailAdapter, UnconfiguredOutboundEmailAdapter } from '@listen-fire/email';

const args = (over: Partial<SendArgs> = {}): SendArgs => ({
  recipients: [{ email: 'ada@example.com', username: 'Ada' }],
  subject: 'Your Listen-Fire trial has ended',
  data: '<p>hi</p>',
  ...over,
});

const stub = (result: boolean | Error): OutboundEmailMessager => ({
  send: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

beforeEach(() => {
  inserted.length = 0;
  insertShouldThrow = false;
});

describe('the ledger records every send', () => {
  it('writes a success row, tagged with the caller-supplied teamId and kind', async () => {
    const sut = withOutboundEmailLedger(stub(true), 'mailgun');

    await expect(
      sut.send(args({ metadata: { teamId: 'team-1', kind: 'trial_expiry' } })),
    ).resolves.toBe(true);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe('outbound_email');
    expect(inserted[0].values).toEqual([
      {
        team_id: 'team-1',
        recipient_email: 'ada@example.com',
        subject: 'Your Listen-Fire trial has ended',
        kind: 'trial_expiry',
        provider: 'mailgun',
        success: true,
        error: null,
      },
    ]);
  });

  it('writes a FAILURE row when the provider rejects the message', async () => {
    const sut = withOutboundEmailLedger(stub(false), 'mailgun');

    await expect(sut.send(args())).resolves.toBe(false);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].values).toMatchObject([{ success: false, error: expect.any(String) }]);
  });

  it('writes a failure row carrying the message when the adapter THROWS, and rethrows', async () => {
    const sut = withOutboundEmailLedger(stub(new Error('mailgun 502')), 'mailgun');

    await expect(sut.send(args())).rejects.toThrow('mailgun 502');

    expect(inserted[0].values).toMatchObject([{ success: false, error: 'mailgun 502' }]);
  });

  it('logs sends with no metadata rather than skipping them', async () => {
    const sut = withOutboundEmailLedger(stub(true), 'fake');

    await sut.send(args());

    expect(inserted[0].values).toMatchObject([{ team_id: null, kind: null, provider: 'fake' }]);
  });

  it('writes one row per recipient', async () => {
    const sut = withOutboundEmailLedger(stub(true), 'mailgun');

    await sut.send(
      args({
        recipients: [
          { email: 'a@x.com', username: 'A' },
          { email: 'b@x.com', username: 'B' },
        ],
      }),
    );

    expect((inserted[0].values as unknown[]).map((r) => (r as { recipient_email: string }).recipient_email))
      .toEqual(['a@x.com', 'b@x.com']);
  });

  it('never lets a ledger failure block the send', async () => {
    insertShouldThrow = true;
    const sut = withOutboundEmailLedger(stub(true), 'mailgun');

    await expect(sut.send(args())).resolves.toBe(true);
    expect(inserted).toHaveLength(0);
  });
});

describe('adapters report non-delivery honestly', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('the unconfigured production stub always fails', async () => {
    await expect(new UnconfiguredOutboundEmailAdapter().send(args())).resolves.toBe(false);
  });

  it('the unconfigured stub still produces a ledger row, so the failure is queryable', async () => {
    const sut = withOutboundEmailLedger(new UnconfiguredOutboundEmailAdapter(), 'unconfigured');

    await expect(sut.send(args())).resolves.toBe(false);

    expect(inserted[0].values).toMatchObject([{ provider: 'unconfigured', success: false }]);
  });

  it('the fake adapter fails when fake-channels is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;

    await expect(new FakeOutboundEmailAdapter().send(args())).resolves.toBe(false);
  });

  it('the fake adapter fails on a non-2xx from fake-channels', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as never;

    await expect(new FakeOutboundEmailAdapter().send(args())).resolves.toBe(false);
  });

  it('the fake adapter succeeds when fake-channels accepts the message', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as never;

    await expect(new FakeOutboundEmailAdapter().send(args())).resolves.toBe(true);
  });
});
