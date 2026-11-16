// T5 — who an inbound email acts as: the platform's own parse of its sender
// and forwarding inboxes (`emailActorCandidates`, adapters/email/arrival.ts,
// which the email module made up to 0.13), exercised through Listen-Fire's
// `resolveActingUser`.
//
// The auth chain (owned by `resolveActingUser`, fed by the parsed
// candidates):
//   1. Sender (`From:`) as `originator` → `user_email WHERE NOT
//      is_service_email`.
//   2. Forwarding-header recipients as `relay` → `user_email WHERE
//      is_service_email = true`.
//   3. Otherwise → null. Dispatcher rejects.

import type { TeamId } from '../../../generated/kysely/core/Team';
import { arrivalTriggerOf, type TriggerEvent } from 'movement-engine/public/inbound';
import type { ActingUserTriggerContext } from '../adapters/acting_user_shared';

// DB mock: each `where` chain ends in an `executeTakeFirst` that returns
// the next queued row. Tests queue rows in the order the adapter will
// look them up.
const dbQueue: Array<unknown> = [];
function setDbRow(row: unknown) {
  dbQueue.push(row);
}
function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_t: object, prop: string | symbol): unknown {
      if (prop === 'executeTakeFirst') return async () => dbQueue.shift() ?? null;
      if (prop === 'execute') return async () => [];
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

import { resolveActingUser } from '../adapters/acting_user/resolve';
import { emailActorCandidates, inboundEmailArrival } from '../adapters/email/arrival';

const TEAM_ID = 'team-1' as TeamId;

// Drive the full acting-user path: the platform parses candidates off what
// landed, `resolveActingUser` maps them to a team user.
function identify(input: {
  event: TriggerEvent;
  trigger?: ActingUserTriggerContext;
}) {
  return resolveActingUser({
    teamId: TEAM_ID,
    trigger: input.trigger,
    getCandidates: async () => emailActorCandidates(input.event.arrival?.landing.fields ?? {}),
  });
}

/** The run trigger an inbound email makes: the arrival the platform's door
 *  builds from the provider's payload, as a `fire_event` row hands it to the
 *  run. */
function makeEvent(payload: Record<string, unknown>): TriggerEvent {
  return arrivalTriggerOf({
    pipelineInputId: 'pi-1',
    adapterType: 'email',
    now: new Date('2026-11-02T12:00:00Z'),
    arrival: inboundEmailArrival({ payload, fallbackIdentity: 'request-1' }),
  });
}

beforeEach(() => {
  dbQueue.length = 0;
});

describe('email acting-user — creator override (T6)', () => {
  it('overrides to creator when overrideActingUserToCreator is set (skips sender chain)', async () => {
    setDbRow({ id: 'creator-1', email: 'creator@example.com', username: 'creator' });
    const user = await identify({
      event: makeEvent({ sender: '"Ext" <ext@other.com>' }),
      trigger: {
        id: 't-1',
        kind: 'INBOUND_EMAIL',
        config: { overrideActingUserToCreator: true },
        createdByUserId: 'creator-1',
      },
    });
    expect(user).toEqual({ id: 'creator-1', email: 'creator@example.com', name: 'creator' });
  });

  it('rejects when override is on but the trigger has no creator', async () => {
    const user = await identify({
      event: makeEvent({ sender: '"Ada" <ada@example.com>' }),
      trigger: {
        id: 't-1',
        kind: 'INBOUND_EMAIL',
        config: { overrideActingUserToCreator: true },
        createdByUserId: null,
      },
    });
    expect(user).toBeNull();
  });
});

describe('email acting-user', () => {
  it('authenticates as sender when From matches a non-service user_email', async () => {
    setDbRow({ id: 'u-1', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      event: makeEvent({ sender: '"Ada Okafor" <ada@example.com>' }),
    });
    expect(user).toEqual({
      id: 'u-1',
      email: 'ada@example.com',
      name: 'ada',
    });
  });

  it('falls through to service-account when sender is not registered', async () => {
    // Sender lookup misses.
    setDbRow(null);
    // Intermediate-recipient (service-account) lookup hits.
    setDbRow({ id: 'u-svc-owner', email: 'dealflow@example.com', username: 'ada' });
    const user = await identify({
      event: makeEvent({
        sender: 'external@example.com',
        recipient: 'inbox+dealflow@example.com',
        'Delivered-To': 'dealflow@example.com',
      }),
    });
    expect(user).toEqual({
      id: 'u-svc-owner',
      email: 'dealflow@example.com',
      name: 'ada',
    });
  });

  it('rejects when neither sender nor any forwarding header maps to a team user', async () => {
    // Nothing matches.
    const user = await identify({
      event: makeEvent({
        sender: 'external@example.com',
        recipient: 'inbox+dealflow@example.com',
      }),
    });
    expect(user).toBeNull();
  });

  it('ignores the terminal inbox+ recipient as an auth signal (routing-only)', async () => {
    // No row matches anywhere — sender external, no forwarding header,
    // and the `recipient` lookup arm requires service-email = true,
    // which `inbox+dealflow@example.com` doesn't satisfy.
    const user = await identify({
      event: makeEvent({
        sender: 'external@example.com',
        recipient: 'inbox+dealflow@example.com',
      }),
    });
    expect(user).toBeNull();
  });

  it('returns null when the payload has no usable headers', async () => {
    const user = await identify({ event: makeEvent({}) });
    expect(user).toBeNull();
  });

  it('parses From from message-headers when not present as a top-level key', async () => {
    setDbRow({ id: 'u-2', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      event: makeEvent({
        'message-headers': [
          ['Subject', 'A subject'],
          ['From', '"Ada" <ada@example.com>'],
        ],
      }),
    });
    expect(user?.email).toBe('ada@example.com');
  });

  // T5-audit — parity with legacy `mailgun.adapter.ts:getSenderIdentifier`,
  // which falls back to a plus-stripped lookup against rows with
  // `accepts_plus_addressing = true`. Without this, a legitimate sender
  // whose client adds a plus-tag (e.g. `ada+notes@example.com`) was
  // accepted by the legacy mailgun handler but rejected by the new gate.
  it('authenticates a sender via the plus-stripped fallback when the canonical row accepts plus-addressing', async () => {
    // Direct lookup misses.
    setDbRow(null);
    // Plus-stripped lookup hits.
    setDbRow({ id: 'u-3', email: 'ada@example.com', username: 'ada' });
    const user = await identify({
      event: makeEvent({ sender: 'ada+notes@example.com' }),
    });
    expect(user).toEqual({
      id: 'u-3',
      email: 'ada@example.com',
      name: 'ada',
    });
  });

  it('falls back to plus-stripped lookup for the intermediate-recipient arm too', async () => {
    // Sender direct miss + sender plus-strip skipped (no '+' in sender).
    setDbRow(null);
    // Intermediate direct miss.
    setDbRow(null);
    // Intermediate plus-stripped hit on service email.
    setDbRow({ id: 'u-svc', email: 'dealflow@example.com', username: 'ada' });
    const user = await identify({
      event: makeEvent({
        sender: 'external@example.com',
        'Delivered-To': 'dealflow+abc@example.com',
      }),
    });
    expect(user?.email).toBe('dealflow@example.com');
  });
});

describe('emailActorCandidates', () => {
  it('names the raw sender as the originator even when auth would go through a service account', () => {
    expect(emailActorCandidates({ sender: '"External Sender" <ext@example.com>', recipient: 'dealflow@example.com' })).toEqual([
      { identity: { identifier: 'ext@example.com', scheme: 'email', adapterType: 'email', email: 'ext@example.com' }, source: 'originator' },
      { identity: { identifier: 'dealflow@example.com', scheme: 'email', adapterType: 'email', email: 'dealflow@example.com' }, source: 'relay' },
    ]);
  });

  it('reads From from message-headers when sender top-level is missing', () => {
    const [sender] = emailActorCandidates({ 'message-headers': JSON.stringify([['From', 'plain@example.com']]) });
    expect(sender).toEqual({ identity: expect.objectContaining({ identifier: 'plain@example.com', scheme: 'email' }), source: 'originator' });
  });

  it('names nobody when the fields carry no sender or recipient', () => {
    expect(emailActorCandidates({})).toEqual([]);
  });
});
