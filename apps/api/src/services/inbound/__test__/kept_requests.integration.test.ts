// What a delivery keeps of how it came in, against a real database: a door
// that read its own arrivals keeps them as a page, which a replay judges again
// through a listen on that module only; a kept request is shown only to a team
// admin, each read recorded (ruling 3); and the prune forgets requests and
// deliveries with the runs' retention.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen } from '../../../test/harness/listens';
import { pruneTriggerRuns } from '../../translation_graph/runs/prune';
import { capturedRequest, keptPage } from '../captured_request';
import { deliverArrivals } from '../listen_door';
import { replayThroughListen } from '../listen_replay';
import { showDeliveryRequest } from '../show_request';

const ADAPTER = 'door_test';
const ADMIN = { userId: randomUUID(), access: 'admin' as const };

let teamId: TeamId;
let otherTeamId: TeamId;
let movementId: MovementId;
let listen: TriggerId;
let elsewhere: TriggerId;

const arrival = (identity: string): Arrival => ({
  edge: 'Things',
  identity,
  landing: { recordId: identity, recordType: 'Thing', fields: { status: 'open' } },
});

async function deliver(input: { identity: string; request: unknown }): Promise<string> {
  const arrivals = [arrival(input.identity)];
  const { deliveryId } = await deliverArrivals({
    teamId,
    delivered: { adapterType: ADAPTER, credentialsId: null },
    subscriptionId: ADAPTER,
    externalId: null,
    source: 'webhook',
    arrivals,
    request: input.request,
  });
  return deliveryId;
}

const reads = async (deliveryId: string) =>
  getAutomationsQb(['delivery_request_read'])
    .selectFrom('delivery_request_read')
    .where('team_id', '=', teamId)
    .where('delivery_id', '=', deliveryId)
    .select(['read_by', 'credential_id'])
    .execute();

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  otherTeamId = randomUUID() as TeamId;
  movementId = randomUUID() as MovementId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `kept-${teamId.slice(0, 8)}` }).execute();
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'kept', source: '' }).execute();
  listen = await insertTestListen({ teamId, movementId, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'heard' });
  elsewhere = await insertTestListen({ teamId, movementId, adapterType: 'other_test', edge: 'Things', delivery: 'connection', movement: 'other' });
});

afterAll(async () => {
  for (const table of ['work', 'trigger_run', 'event_receipt', 'arrival', 'arrival_identity', 'arrival_unjudged', 'delivery', 'delivery_request_read'] as const) {
    await sql`delete from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
  }
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe('a page a door read itself', () => {
  let deliveryId: string;

  it('is kept with the delivery and replayed through a listen on its module, the module asked nothing', async () => {
    deliveryId = await deliver({ identity: 'mail-1', request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals: [arrival('mail-1')] }) });

    const replayed = await replayThroughListen({ teamId, triggerId: listen, deliveryId });

    if (replayed.outcome !== 'replayed') throw new Error(replayed.reason);
    expect(replayed.runIds).toHaveLength(1);
    const { rows } = await sql<{ replay_of: string }>`
      select replay_of::text as replay_of from automations.delivery where id::text = ${replayed.replayDeliveryId}::text`.execute(getAutomationsQb(['delivery']));
    expect(rows).toEqual([{ replay_of: deliveryId }]);
  });

  it('is refused, naming both, through a listen on another module', async () => {
    expect(await replayThroughListen({ teamId, triggerId: elsewhere, deliveryId })).toEqual({
      outcome: 'refused',
      reason: expect.stringMatching(new RegExp(`^delivery ${deliveryId} came from ${ADAPTER}: \\S+ listens on other_test$`)),
    });
  });
});

describe('showing a kept request (ruling 3)', () => {
  let deliveryId: string;

  beforeAll(async () => {
    deliveryId = await deliver({
      identity: 'msg-1',
      request: capturedRequest({
        keeping: { captureHeaders: ['x-event-kind', 'x-signature'], redactFields: ['token'] },
        headers: { 'content-type': 'application/json', 'x-event-kind': 'message', 'x-signature': 'sha256=abc' },
        rawBody: Buffer.from(JSON.stringify({ text: 'hello', token: 'secret' }), 'utf8'),
        arrivals: [arrival('msg-1')],
      }),
    });
  });

  it.each(['read', 'write'] as const)('is refused to a %s member who is not an admin, and records nothing', async (access) => {
    const shown = await showDeliveryRequest({ teamId, deliveryId, reader: { userId: randomUUID(), access } });

    expect(shown).toEqual({ outcome: 'refused', reason: "only the team's admins may read a delivery's request" });
    expect(await reads(deliveryId)).toEqual([]);
  });

  it('is shown to an admin as kept (redacted, declared headers only), and the read is recorded', async () => {
    const shown = await showDeliveryRequest({ teamId, deliveryId, reader: { ...ADMIN, credentialId: 'key-1' } });

    if (shown.outcome !== 'shown') throw new Error(shown.reason);
    expect(shown.kept).toEqual({
      kind: 'request',
      method: 'POST',
      path: '',
      query: '',
      headers: { 'content-type': 'application/json', 'x-event-kind': 'message' },
      body: JSON.stringify({ text: 'hello' }),
      bodyEncoding: 'utf8',
      arrivalIds: [expect.any(String)],
    });
    expect(await reads(deliveryId)).toEqual([{ read_by: ADMIN.userId, credential_id: 'key-1' }]);
  });

  it("is refused for another team's delivery", async () => {
    const shown = await showDeliveryRequest({ teamId: otherTeamId, deliveryId, reader: ADMIN });

    expect(shown.outcome).toBe('refused');
  });

  it('shows a page as the arrivals it read', async () => {
    const page = await deliver({ identity: 'mail-2', request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals: [arrival('mail-2')] }) });

    const shown = await showDeliveryRequest({ teamId, deliveryId: page, reader: ADMIN });

    if (shown.outcome !== 'shown') throw new Error(shown.reason);
    expect(shown.kept).toEqual({ kind: 'page', adapter: ADAPTER, credential: null, arrivals: [arrival('mail-2')] });
  });
});

describe('the prune (ruling 3: a request is forgotten with its delivery)', () => {
  it('forgets an old delivery and its request, and keeps one a queued run still names, its request forgotten', async () => {
    const old = await deliver({ identity: 'old-1', request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals: [arrival('old-1')] }) });
    const named = await deliver({ identity: 'old-2', request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals: [arrival('old-2')] }) });
    await sql`update automations.delivery set received_at = now() - interval '30 days' where id in (${old}::uuid, ${named}::uuid)`.execute(getAutomationsQb(['delivery']));
    // `old`'s queued run is let go; `named`'s stays queued.
    await sql`delete from automations.work where team_id = ${teamId}::uuid and kind = 'fire_event' and payload->>'deliveryId' = ${old}::text`.execute(getAutomationsQb(['work']));

    const pruned = await pruneTriggerRuns({ teamId, olderThanDays: 7 });

    expect(pruned.deletedDeliveries).toBe(1);
    const { rows: left } = await sql<{ id: string; request: unknown }>`
      select id::text as id, request from automations.delivery where id::text = any(${[old, named]}::text[])`.execute(getAutomationsQb(['delivery']));
    expect(left).toEqual([{ id: named, request: null }]);
  });
});
