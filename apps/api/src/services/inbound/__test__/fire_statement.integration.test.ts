// The fire list at the door, against a real database: an arrival from someone
// the automation's fire list does not admit starts no run and takes no receipt,
// is kept as a refused fact with its delivery, and is still logged, so it wakes
// another run's wait on its record. It is listed for a writer, whose replay of
// it starts the run, unjudged by the list, and records who replayed. Any other
// replay is judged as a fresh arrival. A member the source system vouches for
// starts a run at the door.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { arrivalReceiptKey } from 'movement-engine/public/inbound';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

jest.mock('../../translation_graph/adapters/resolve', () => ({ resolveAdapter: jest.fn() }));

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen } from '../../../test/harness/listens';
import { resolveAdapter as resolveAdapterImport } from '../../translation_graph/adapters/resolve';
import { keptPage } from '../captured_request';
import { movementEventsImpl } from '../arrival_ledger';
import { deliverArrivals } from '../listen_door';
import { replayThroughListen } from '../listen_replay';

const resolveAdapter = resolveAdapterImport as jest.Mock;

const ADAPTER = 'chat_fire_test';
const WRITER = randomUUID();

let teamId: TeamId;
let movementId: MovementId;
let listen: TriggerId;

/** A message from the chat user `user`, whom the source system vouches for. */
const message = (user: string, key: string): Exclude<Arrival, { gone: true }> => ({
  edge: 'Things',
  key,
  identity: `${user}:${key}`,
  landing: { recordId: key, recordType: 'Thing', fields: { status: 'open' } },
  actor: { identifier: user, scheme: 'opaque', adapterType: ADAPTER, label: user, proven: true },
});

/** The chat module: who posted, by their address. */
const ADDRESSES: Record<string, string> = { U1: 'ada@x.com', U8: 'mallory@evil.com', U9: 'eve@evil.com' };

/** While true, the chat module cannot say who posted. */
let lookupsDown = false;

async function deliver(arrival: Exclude<Arrival, { gone: true }>) {
  return deliverArrivals({
    teamId,
    delivered: { adapterType: ADAPTER, credentialsId: null },
    subscriptionId: ADAPTER,
    externalId: null,
    source: 'webhook',
    arrivals: [arrival],
    request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals: [arrival] }),
  });
}

/** A run of another automation parked waiting on the record `key`. */
async function waitingOn(key: string): Promise<string> {
  const runId = randomUUID();
  const qb = getAutomationsQb(['trigger_run', 'parked_run', 'wait_row']);
  await sql`insert into automations.trigger_run (id, team_id, trigger_id, trigger_type, status) values (${runId}::uuid, ${teamId}::uuid, ${randomUUID()}, 'webhook', 'parked')`.execute(qb);
  await sql`insert into automations.parked_run (run_id, address, park_reason, state) values (${runId}::uuid, 'leaf-1', 'await', '{}'::jsonb)`.execute(qb);
  await sql`insert into automations.wait_row (run_id, team_id, adapter_type, edge, key, since, address) values (${runId}::uuid, ${teamId}::uuid, ${ADAPTER}, 'Things', ${key}, 0, 'leaf-1')`.execute(qb);
  return runId;
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  movementId = randomUUID() as MovementId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `fire-${teamId.slice(0, 8)}` }).execute();
  const ada = randomUUID() as UserId;
  await getCoreQb(['user']).insertInto('user').values({ id: ada, default_team_id: teamId, username: `ada-${teamId.slice(0, 8)}` }).execute();
  await getCoreQb(['user_email']).insertInto('user_email').values({ user_id: ada, email: 'ada@x.com' }).execute();
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'triage', source: '' }).execute();
  listen = await insertTestListen({ teamId, movementId, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'triage', fire: [{ kind: 'team' }] });
  resolveAdapter.mockImplementation(async (input: { adapterType: string }) => {
    if (input.adapterType !== ADAPTER) throw new Error(`test: no module ${input.adapterType}`);
    return {
      getActorCandidates: async ({ event }: { event: { arrival?: { actor?: { identifier: string } } } }) => {
        if (lookupsDown) throw new Error('chat is down');
        const user = event.arrival?.actor?.identifier ?? '';
        const email = ADDRESSES[user];
        return email === undefined ? [] : [{ identity: { identifier: user, scheme: 'email', adapterType: ADAPTER, email }, source: 'originator' }];
      },
    };
  });
});

afterAll(async () => {
  for (const table of ['work', 'trigger_run', 'event_receipt', 'arrival', 'arrival_identity', 'arrival_unjudged', 'arrival_refused', 'wait_row', 'delivery'] as const) {
    await sql`delete from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
  }
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

const workOf = async (kind: string) => {
  const { rows } = await sql<{ payload: { runId?: string; deliveryId?: string } }>`
    select payload from automations.work where team_id = ${teamId}::uuid and kind = ${kind}::text`.execute(getAutomationsQb(['work']));
  return rows.map((row) => row.payload);
};

describe('a stranger`s message, on an automation only the team may fire', () => {
  const arrival = message('U9', 'thing-1');
  let deliveryId: string;
  let waiting: string;

  beforeAll(async () => {
    waiting = await waitingOn('thing-1');
    const delivered = await deliver(arrival);
    deliveryId = delivered.deliveryId;
    expect(delivered.kept.kept).toBe(true);
    expect(delivered.fires).toEqual([]);
  });

  it('starts no run, takes no receipt, and is kept as a refused fact with its delivery', async () => {
    expect(await workOf('fire_event')).toEqual([]);
    const { rows: receipts } = await sql`select 1 from automations.event_receipt where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['event_receipt']));
    expect(receipts).toEqual([]);
    const { rows: refused } = await sql<{ delivery_id: string; arrival: string; edge: string; adapter: string; reason: string }>`
      select delivery_id::text, arrival, edge, adapter, reason from automations.arrival_refused where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['arrival_refused']));
    expect(refused).toEqual([
      { delivery_id: deliveryId, arrival: arrivalReceiptKey(arrival), edge: 'Things', adapter: ADAPTER, reason: 'who acted is not among who may fire this automation' },
    ]);
  });

  it('still wakes another run`s wait on its record', async () => {
    expect((await workOf('wake_await')).map((payload) => payload.runId)).toEqual([waiting]);
  });

  it('is listed with its listen, delivery and reason, for a writer to replay', async () => {
    const listed = await movementEventsImpl({ teamId, movementId });
    expect(listed).toEqual([
      expect.objectContaining({ status: 'refused', triggerId: listen, deliveryId, adapterType: ADAPTER, failureReason: 'who acted is not among who may fire this automation', attempt: null }),
    ]);
  });

  it('a writer`s replay starts the run, unjudged by the list, and records who replayed', async () => {
    const replayed = await replayThroughListen({ teamId, triggerId: listen, deliveryId, by: { userId: WRITER, credentialId: 'key-1' } });

    if (replayed.outcome !== 'replayed') throw new Error(replayed.reason);
    expect(replayed.runIds).toHaveLength(1);
    const { rows } = await sql<{ replay_of: string; replayed_by: string; replayed_by_credential: string }>`
      select replay_of::text, replayed_by::text, replayed_by_credential from automations.delivery where id::text = ${replayed.replayDeliveryId}::text`.execute(getAutomationsQb(['delivery']));
    expect(rows).toEqual([{ replay_of: deliveryId, replayed_by: WRITER, replayed_by_credential: 'key-1' }]);
    expect((await workOf('fire_event')).map((payload) => payload.runId)).toEqual(replayed.runIds);
  });
});

describe('a stranger`s message kept unjudged, because who posted could not be looked up', () => {
  const arrival = message('U8', 'thing-3');
  const refusedOf = async (delivery: string) => {
    const { rows } = await sql<{ arrival: string }>`
      select arrival from automations.arrival_refused where team_id = ${teamId}::uuid and delivery_id = ${delivery}::uuid`.execute(getAutomationsQb(['arrival_refused']));
    return rows.map((row) => row.arrival);
  };

  it('is judged by the list when replayed, and refused; replayed again, the writer vouches for it and it runs', async () => {
    lookupsDown = true;
    const delivered = await deliver(arrival).finally(() => {
      lookupsDown = false;
    });
    expect(delivered.fires).toEqual([]);
    const { deliveryId } = delivered;
    const { rows: unjudged } = await sql`select 1 from automations.arrival_unjudged where team_id = ${teamId}::uuid and delivery_id::text = ${deliveryId}::text`.execute(
      getAutomationsQb(['arrival_unjudged']),
    );
    expect(unjudged).toHaveLength(1);
    expect(await refusedOf(deliveryId)).toEqual([]);

    const judged = await replayThroughListen({ teamId, triggerId: listen, deliveryId, by: { userId: WRITER } });
    if (judged.outcome !== 'replayed') throw new Error(judged.reason);
    expect(judged.runIds).toEqual([]);
    expect(judged.lines).toEqual([expect.stringContaining('may not start a run (who acted is not among who may fire this automation): kept as refused')]);
    expect(await refusedOf(deliveryId)).toEqual([arrivalReceiptKey(arrival)]);

    const vouched = await replayThroughListen({ teamId, triggerId: listen, deliveryId, by: { userId: WRITER } });
    if (vouched.outcome !== 'replayed') throw new Error(vouched.reason);
    expect(vouched.runIds).toHaveLength(1);
    const { rows } = await sql<{ replay_of: string; replayed_by: string }>`
      select replay_of::text, replayed_by::text from automations.delivery where id::text = ${vouched.replayDeliveryId}::text`.execute(getAutomationsQb(['delivery']));
    expect(rows).toEqual([{ replay_of: deliveryId, replayed_by: WRITER }]);
  });
});

it('a member the source system vouches for starts a run at the door', async () => {
  const { fires } = await deliver(message('U1', 'thing-2'));

  expect(fires).toHaveLength(1);
  const { rows } = await sql`select 1 from automations.arrival_refused where team_id = ${teamId}::uuid and arrival = ${arrivalReceiptKey(message('U1', 'thing-2'))}::text`.execute(
    getAutomationsQb(['arrival_refused']),
  );
  expect(rows).toEqual([]);
});
