// A listen whose filter asks the team's functions, against a real database: a
// member's message sets it off through the platform's own answers; one its
// host could not answer is kept waiting, with every later one it would run
// behind it, across deliveries; and its retry, one work row per listen,
// judges the line oldest first, runs each once, and lets go of one whose
// delivery can no longer be read again.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { arrivalReceiptKey } from 'movement-engine/public/inbound';

import type { Arrival, PluginAnswers, PluginQuestion } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';


import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { waitingListens } from '../../lf_store/records_door';
import { insertTestListen } from '../../../test/harness/listens';
import { ProvisioningService } from '../../provisioning';
import { movementEventsImpl } from '../arrival_ledger';
import { keptPage } from '../captured_request';
import { claimReceipt, deliverArrivals, fireRowSchema, RETRY_UNJUDGED_EVERY_MS, savedListenOf, WAITING_BEHIND, type JudgeHost } from '../listen_door';
import { startTeamAnswerFeed } from '../platform_plugin_answers';
import { retryWaitingLine } from '../unjudged_retry';

const ADAPTER = 'team_door_test';
const IS_MEMBER = '@lf-platform/team/is_member';

let teamId: TeamId;
let movementId: MovementId;
let triggerId: TriggerId;
let pipeline: string;

function message(identity: string, email: string): Exclude<Arrival, { gone: true }> {
  return { edge: 'Things', identity, landing: { recordId: identity, recordType: 'Thing', fields: { 'User Email': email } } };
}

/** The receipt key the message `identity` is kept under. */
const receiptOf = (identity: string): string => arrivalReceiptKey(message(identity, ''));

/** A host whose members are `members`, or that cannot be reached while `down`. */
function hostOf(state: { members: string[]; down: boolean }): JudgeHost & { asked: PluginQuestion[][] } {
  const asked: PluginQuestion[][] = [];
  return {
    asked,
    async answers(_team, questions): Promise<PluginAnswers> {
      asked.push(questions);
      if (state.down) throw new Error('the change feed is not listening');
      return questions.map((question) => ({ ...question, value: state.members.includes(String(question.args[0])) }));
    },
    waiting: (team, pipelines) => waitingListens({ tenant: team }, pipelines),
  };
}

async function deliver(arrivals: Arrival[], host?: JudgeHost): Promise<string> {
  const { deliveryId } = await deliverArrivals({
    teamId,
    delivered: { adapterType: ADAPTER, credentialsId: null },
    subscriptionId: ADAPTER,
    externalId: null,
    source: 'webhook',
    arrivals,
    request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals }),
    ...(host !== undefined ? { host } : {}),
  });
  return deliveryId;
}

async function facts(): Promise<Array<{ arrival: string; attempt: number; waiting: boolean; reason: string }>> {
  const { rows } = await sql<{ arrival: string; attempt: number; waiting: boolean; reason: string }>`
    select arrival, attempt, waiting, reason from automations.arrival_unjudged
    where team_id = ${teamId}::uuid order by noted_at, kept_order`.execute(getAutomationsQb(['arrival_unjudged']));
  return rows;
}

async function workOf(kind: string): Promise<Array<{ key: string; payload: unknown; due_at: Date }>> {
  const { rows } = await sql<{ key: string; payload: unknown; due_at: Date }>`
    select key, payload, due_at from automations.work where team_id = ${teamId}::uuid and kind = ${kind}::text order by created_at, updated_at`.execute(getAutomationsQb(['work']));
  return rows;
}

const firedIdentities = async (): Promise<string[]> => (await workOf('fire_event')).map((row) => fireRowSchema.parse(row.payload).arrival.identity);

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  movementId = randomUUID() as MovementId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `retry-${teamId.slice(0, 8)}` }).execute();
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'team.lf', source: '' }).execute();
  triggerId = await insertTestListen({
    teamId,
    movementId,
    adapterType: ADAPTER,
    edge: 'Things',
    delivery: 'connection',
    movement: 'greet',
    checked: {
      asksHost: true,
      checked: { type: 'function', fn: IS_MEMBER, args: [{ type: 'edge_property', propertyTypeId: 'User Email', fieldOnly: true }] },
    },
  });
  const listen = await savedListenOf(triggerId);
  if (listen === null) throw new Error('test: the listen was not saved');
  pipeline = listen.pipeline;
});

afterEach(async () => {
  for (const table of ['work', 'trigger_run', 'event_receipt', 'arrival', 'arrival_identity', 'arrival_unjudged', 'delivery'] as const) {
    await sql`delete from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
  }
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await getCoreQb(['team_membership']).deleteFrom('team_membership').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe('the platform answers the team`s functions', () => {
  let stopFeed: () => Promise<void>;

  beforeAll(() => {
    stopFeed = startTeamAnswerFeed();
  });

  afterAll(async () => {
    await stopFeed();
  });

  it('a_member_sets_the_listen_off', async () => {
    const email = `ada-${randomUUID().slice(0, 8)}@acme.test`;
    await ProvisioningService.provisionUser({ teamId, email, access: 'write' });

    await deliver([message('m1', email)]);

    expect(await firedIdentities()).toEqual(['m1']);
    expect(await facts()).toEqual([]);
  });

  it('a_stranger_does_not_and_nothing_is_kept_for_the_listen', async () => {
    await deliver([message('m1', `eve-${randomUUID().slice(0, 8)}@elsewhere.test`)]);

    expect(await firedIdentities()).toEqual([]);
    expect(await facts()).toEqual([]);
    expect(await workOf('retry_unjudged')).toEqual([]);
  });
});

describe('an arrival its host could not judge', () => {
  it('later_arrivals_wait_behind_an_unjudged_one', async () => {
    const state = { members: ['ada@acme.test', 'bo@acme.test'], down: true };
    const host = hostOf(state);
    const before = Date.now();

    await deliver([message('m1', 'ada@acme.test'), message('m2', 'bo@acme.test')], host);
    state.down = false;
    await deliver([message('m3', 'ada@acme.test')], host);

    expect((await facts()).map((f) => [f.arrival, f.waiting, f.reason === WAITING_BEHIND])).toEqual([
      [receiptOf('m1'), true, false],
      [receiptOf('m2'), true, true],
      [receiptOf('m3'), true, true],
    ]);
    // Asked once, for the first: the others waited asking nothing.
    expect(host.asked).toHaveLength(1);
    expect((await movementEventsImpl({ teamId, movementId })).map((item) => item.status)).toEqual(['waiting_for_host', 'waiting_for_host', 'waiting_for_host']);
    expect(await firedIdentities()).toEqual([]);
    const retries = await workOf('retry_unjudged');
    expect(retries.map((row) => [row.key, row.payload])).toEqual([[`retry_unjudged:${teamId}:${pipeline}`, { teamId, triggerId, pipeline }]]);
    expect(retries[0]!.due_at.getTime()).toBeGreaterThanOrEqual(before + RETRY_UNJUDGED_EVERY_MS - 1000);
  });

  it('a_retry_judges_in_arrival_order_and_runs_once', async () => {
    const state = { members: ['ada@acme.test', 'bo@acme.test'], down: true };
    const host = hostOf(state);
    await deliver([message('m1', 'ada@acme.test'), message('m2', 'bo@acme.test'), message('m3', 'eve@elsewhere.test')], host);
    await deliver([message('m4', 'ada@acme.test')], host);

    expect(await retryWaitingLine({ teamId, triggerId, pipeline, host })).toEqual({ kind: 'still_waiting', arrival: receiptOf('m1') });
    // An automatic retry that still cannot reach its host notes no new attempt.
    expect((await facts()).map((f) => f.attempt)).toEqual([0, 0, 0, 0]);

    state.down = false;
    expect(await retryWaitingLine({ teamId, triggerId, pipeline, host })).toEqual({ kind: 'done' });

    // The stranger runs nothing; the members run in the order they came.
    expect(await firedIdentities()).toEqual(['m1', 'm2', 'm4']);
    expect((await facts()).filter((f) => f.waiting)).toEqual([]);
    expect((await facts()).map((f) => f.attempt)).toEqual([0, 0, 0, 0]);
    expect(new Set((await movementEventsImpl({ teamId, movementId })).map((item) => item.status))).toEqual(new Set(['not_judged']));

    // Each runs once: its receipt is taken by its first run, and a retry taken
    // again (a fact left waiting by a crash between the run's queue and the
    // line's update) queues nothing more.
    for (const row of await workOf('fire_event')) {
      const fire = fireRowSchema.parse(row.payload);
      expect(await claimReceipt({ fire, run: { triggerType: 'webhook', recordId: null, payload: {}, movementVersionId: null }, chain: [] })).toEqual({ kind: 'run' });
    }
    await sql`update automations.arrival_unjudged set waiting = true where team_id = ${teamId}::uuid and arrival = ${receiptOf('m1')}::text`.execute(getAutomationsQb(['arrival_unjudged']));
    expect(await retryWaitingLine({ teamId, triggerId, pipeline, host })).toEqual({ kind: 'done' });
    expect(await firedIdentities()).toEqual(['m1', 'm2', 'm4']);
  });

  it('a retry lets go of an arrival whose delivery is gone, saying so, and judges the next', async () => {
    const state = { members: ['ada@acme.test'], down: true };
    const host = hostOf(state);
    const gone = await deliver([message('m1', 'ada@acme.test')], host);
    await deliver([message('m2', 'ada@acme.test')], host);
    await sql`delete from automations.delivery where team_id = ${teamId}::uuid and id = ${gone}::uuid`.execute(getAutomationsQb(['delivery']));
    state.down = false;

    expect(await retryWaitingLine({ teamId, triggerId, pipeline, host })).toEqual({ kind: 'done' });

    expect((await facts()).map((f) => [f.arrival, f.attempt, f.waiting])).toEqual([
      [receiptOf('m1'), 0, false],
      [receiptOf('m2'), 0, false],
      [receiptOf('m1'), 1, false],
    ]);
    expect((await facts()).at(-1)?.reason).toBe('its delivery is no longer kept, so it cannot be read again');
    expect(await firedIdentities()).toEqual(['m2']);
  });

  it('a listen edited since waits on nothing', async () => {
    const host = hostOf({ members: [], down: true });
    await deliver([message('m1', 'ada@acme.test')], host);

    expect(await retryWaitingLine({ teamId, triggerId, pipeline: 'listen:test:greet:edited', host })).toEqual({ kind: 'done' });
    expect(await retryWaitingLine({ teamId, triggerId: randomUUID() as TriggerId, pipeline, host })).toEqual({ kind: 'done' });
    expect((await facts()).map((f) => f.waiting)).toEqual([false]);
  });
});
