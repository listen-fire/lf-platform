// Starting an automation with a stored event, and replaying one, against a
// real database: "run with this event" fires the automation's listens on the
// event without reading their filters, and a replay reruns only the one listen
// it is asked of.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen, takenEquals } from '../../../test/harness/listens';
import { runWithEvent } from '../../translation_graph/movement/run_now';
import { keptPage } from '../captured_request';
import { deliverArrivals } from '../listen_door';
import { replayThroughListen } from '../listen_replay';

const ADAPTER = 'door_test';
const BY = { userId: randomUUID() };

let teamId: TeamId;
let closedOnly: { movementId: MovementId; listen: TriggerId };
let everything: { movementId: MovementId; first: TriggerId; second: TriggerId };

const open: Arrival = {
  edge: 'Things',
  identity: 'thing-1',
  landing: { recordId: 'thing-1', recordType: 'Thing', fields: { status: 'open' } },
};

async function newMovement(name: string): Promise<MovementId> {
  const id = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id, team_id: teamId, name, source: '', language_version: '0.15.3' }).execute();
  return id;
}

async function deliverOpen(): Promise<{ deliveryId: string; firedBy: string[] }> {
  const { deliveryId, fires } = await deliverArrivals({
    teamId,
    delivered: { adapterType: ADAPTER, credentialsId: null },
    subscriptionId: ADAPTER,
    externalId: null,
    source: 'webhook',
    arrivals: [open],
    request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals: [open] }),
  });
  return { deliveryId, firedBy: fires.map((fire) => fire.triggerId) };
}

/** The listens the runs queued after `since` are for. */
async function queuedFor(runIds: readonly string[]): Promise<string[]> {
  const { rows } = await sql<{ trigger_id: string }>`
    select payload->>'triggerId' as trigger_id from automations.work
    where team_id = ${teamId}::uuid and kind = 'fire_event' and payload->>'runId' in (${sql.join(runIds)})`.execute(getAutomationsQb(['work']));
  return rows.map((row) => row.trigger_id).sort();
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `event-${teamId.slice(0, 8)}` }).execute();
  closedOnly = {
    movementId: await newMovement('closed-only'),
    listen: '' as TriggerId,
  };
  closedOnly.listen = await insertTestListen({
    teamId,
    movementId: closedOnly.movementId,
    adapterType: ADAPTER,
    edge: 'Things',
    delivery: 'connection',
    movement: 'closed',
    taken: takenEquals('status', 'closed'),
  });
  const movementId = await newMovement('everything');
  everything = {
    movementId,
    first: await insertTestListen({ teamId, movementId, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'first' }),
    second: await insertTestListen({ teamId, movementId, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'second' }),
  };
});

afterAll(async () => {
  for (const table of ['work', 'trigger_run', 'event_receipt', 'arrival', 'arrival_identity', 'arrival_unjudged', 'delivery'] as const) {
    await sql`delete from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
  }
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe('run_with_this_event_needs_write_and_skips_the_filter (the service skips the filter)', () => {
  it('starts the automation on an event its listen filtered out, under a replay delivery of the stored one', async () => {
    const { deliveryId, firedBy } = await deliverOpen();
    expect(firedBy).not.toContain(closedOnly.listen);

    const started = await runWithEvent({ teamId, automationId: closedOnly.movementId, deliveryId, arrivalIndex: 0, by: BY });

    if (!started.ok) throw new Error(started.errors.join('; '));
    expect(started.runIds).toHaveLength(1);
    expect(await queuedFor(started.runIds)).toEqual([closedOnly.listen]);
    const { rows } = await sql<{ replay_of: string }>`
      select d.replay_of::text as replay_of from automations.delivery d
      join automations.work w on w.payload->>'deliveryId' = d.id::text
      where w.team_id = ${teamId}::uuid and w.payload->>'runId' = ${started.runIds[0]}::text`.execute(getAutomationsQb(['delivery']));
    expect(rows).toEqual([{ replay_of: deliveryId }]);
  });

  it('runs it again for a listen that ran it before, and starts one run for each listen of the automation', async () => {
    const { deliveryId, firedBy } = await deliverOpen();
    expect(firedBy).toEqual(expect.arrayContaining([everything.first, everything.second]));

    const started = await runWithEvent({ teamId, automationId: everything.movementId, deliveryId, arrivalIndex: 0, by: BY });

    if (!started.ok) throw new Error(started.errors.join('; '));
    expect(await queuedFor(started.runIds)).toEqual([everything.first, everything.second].sort());
  });

  it('only starts the automation asked for', async () => {
    const { deliveryId } = await deliverOpen();

    const started = await runWithEvent({ teamId, automationId: closedOnly.movementId, deliveryId, arrivalIndex: 0, by: BY });

    if (!started.ok) throw new Error(started.errors.join('; '));
    expect(await queuedFor(started.runIds)).toEqual([closedOnly.listen]);
  });

  it('refuses an event the delivery did not bring, and a delivery the team does not have', async () => {
    const { deliveryId } = await deliverOpen();

    expect(await runWithEvent({ teamId, automationId: closedOnly.movementId, deliveryId, arrivalIndex: 3, by: BY })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/brought no event at 3/)],
    });
    expect(await runWithEvent({ teamId, automationId: closedOnly.movementId, deliveryId: randomUUID(), arrivalIndex: 0, by: BY })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no delivery .* is kept for this team/)],
    });
  });
});

describe('replay_reruns_only_that_automations_listens', () => {
  it('reruns the one listen it is asked of, and no other listen of the automation or of any other', async () => {
    const { deliveryId } = await deliverOpen();

    const replayed = await replayThroughListen({ teamId, triggerId: everything.first, deliveryId, force: true });

    if (replayed.outcome !== 'replayed') throw new Error(replayed.reason);
    expect(await queuedFor(replayed.runIds)).toEqual([everything.first]);
  });
});
