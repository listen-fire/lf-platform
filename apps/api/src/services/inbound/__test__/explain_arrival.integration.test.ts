// "Why didn't this fire?" against a real database: a stored event judged again
// against the listens on its connection, only those of automations the asker
// may read, the first term that failed named; a host function asked now says
// its answer is as of now; and nothing is written.

import { LANGUAGE_VERSION } from 'movement-lang';
import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

const unreadable = new Set<string>();
jest.mock('../../../interfaces/access_route', () => ({
  ...jest.requireActual('../../../interfaces/access_route'),
  unseen: async (automationId: string | null) => automationId !== null && unreadable.has(automationId),
}));

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen, takenEquals } from '../../../test/harness/listens';
import { keptPage } from '../captured_request';
import { explainDeliveryArrival } from '../explain_arrival';
import { deliverArrivals } from '../listen_door';
import { platformPluginAnswers, startTeamAnswerFeed } from '../platform_plugin_answers';

const ADAPTER = 'why_test';
const IS_MEMBER = '@lf-platform/team/is_member';
const TABLES = ['work', 'trigger_run', 'event_receipt', 'arrival', 'arrival_identity', 'arrival_unjudged', 'delivery'] as const;

let teamId: TeamId;
let stopFeed: () => Promise<void>;

const from = (email: string): Arrival => ({
  edge: 'Things',
  identity: `thing-${email}`,
  landing: { recordId: `thing-${email}`, recordType: 'Thing', fields: { status: 'open', 'User Email': email } },
});

async function newMovement(name: string): Promise<MovementId> {
  const id = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id, team_id: teamId, name, source: '', language_version: LANGUAGE_VERSION }).execute();
  return id;
}

async function deliver(arrival: Arrival): Promise<string> {
  const { deliveryId } = await deliverArrivals({
    teamId,
    delivered: { adapterType: ADAPTER, credentialsId: null },
    subscriptionId: ADAPTER,
    externalId: null,
    source: 'webhook',
    arrivals: [arrival],
    request: keptPage({ adapterType: ADAPTER, credentialsId: null, arrivals: [arrival] }),
  });
  return deliveryId;
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const { rows } = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

beforeAll(() => {
  stopFeed = startTeamAnswerFeed();
});

afterAll(async () => {
  await stopFeed();
});

beforeEach(async () => {
  unreadable.clear();
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `why-${teamId.slice(0, 8)}` }).execute();
});

afterEach(async () => {
  for (const table of TABLES) {
    await sql`delete from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
  }
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe('why_lists_only_readable_listens_and_the_first_failed_term', () => {
  it('names the listens of automations the asker may read, and the term of each filter that failed', async () => {
    const closed = await newMovement('closed-only');
    const open = await newMovement('open-only');
    const secret = await newMovement('secret');
    const closedListen = await insertTestListen({ teamId, movementId: closed, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'closed', taken: takenEquals('status', 'closed') });
    const openListen = await insertTestListen({ teamId, movementId: open, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'open', taken: takenEquals('status', 'open') });
    await insertTestListen({ teamId, movementId: secret, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'secret', taken: takenEquals('status', 'closed') });
    unreadable.add(secret);
    const deliveryId = await deliver(from('ada@acme.test'));

    const explained = await explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 0 });

    if (!explained.ok) throw new Error(explained.errors.join('; '));
    expect(explained.listens.map((entry) => entry.automationName).sort()).toEqual(['closed-only', 'open-only']);
    const byListen = Object.fromEntries(explained.listens.map((entry) => [entry.listen, entry]));
    expect(byListen[openListen]).toMatchObject({ verdict: 'fires', automationId: open, hostAnswers: { used: false } });
    expect(byListen[closedListen]).toMatchObject({ verdict: 'does_not_fire', automationId: closed, hostAnswers: { used: false } });
    expect(byListen[closedListen]?.firstFailed).toEqual(expect.stringContaining('closed'));
  });

  it('answers a delivery the team does not have as one that is not there', async () => {
    expect(await explainDeliveryArrival({ teamId, deliveryId: randomUUID(), arrivalIndex: 0 })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no delivery .* is kept for this team/)],
    });
  });

  it('says so when the delivery brought no event at that place', async () => {
    const movementId = await newMovement('open-only');
    await insertTestListen({ teamId, movementId, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'open', taken: takenEquals('status', 'open') });
    const deliveryId = await deliver(from('ada@acme.test'));
    expect(await explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 4 })).toEqual({ ok: false, errors: [expect.stringMatching(/brought no event at 4/)] });
  });

  it('answers with no listens, not an error, when no listen is readable at all', async () => {
    const secret = await newMovement('secret');
    await insertTestListen({ teamId, movementId: secret, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: 'secret', taken: takenEquals('status', 'open') });
    unreadable.add(secret);
    const deliveryId = await deliver(from('ada@acme.test'));
    expect(await explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 0 })).toMatchObject({ ok: true, listens: [] });
  });
});

describe('why_says_a_host_answer_is_as_of_now', () => {
  it('asks the host now, names the function by its catalog key as the first term that failed, and says its answer is as of now', async () => {
    const movementId = await newMovement('team.lf');
    const listen = await insertTestListen({
      teamId,
      movementId,
      adapterType: ADAPTER,
      edge: 'Things',
      delivery: 'connection',
      movement: 'greet',
      checked: { asksHost: true, checked: { type: 'function', fn: IS_MEMBER, args: [{ type: 'edge_property', propertyTypeId: 'User Email', fieldOnly: true }] } },
    });
    const deliveryId = await deliver(from('stranger@elsewhere.test'));

    const explained = await explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 0 });

    if (!explained.ok) throw new Error(explained.errors.join('; '));
    const [entry] = explained.listens;
    expect(entry).toMatchObject({ listen, verdict: 'does_not_fire', firstFailed: expect.stringContaining(IS_MEMBER) });
    expect(entry?.hostAnswers).toMatchObject({ used: true, note: expect.stringMatching(/as of this question/) });
  });
});

describe('an explanation asks the host itself, not the cache', () => {
  it('reports the fresh answer over a kept stale one, and leaves the cache as it found it', async () => {
    const movementId = await newMovement('team.lf');
    await insertTestListen({
      teamId,
      movementId,
      adapterType: ADAPTER,
      edge: 'Things',
      delivery: 'connection',
      movement: 'greet',
      checked: { asksHost: true, checked: { type: 'function', fn: IS_MEMBER, args: [{ type: 'edge_property', propertyTypeId: 'User Email', fieldOnly: true }] } },
    });
    const email = 'former@acme.test';
    const cache = platformPluginAnswers();
    await cache.answers(teamId, [{ plugin: IS_MEMBER, args: [email] }], async () => ({ value: true }));
    const kept = cache.keptCount(teamId);
    expect(kept).toBe(1);
    const deliveryId = await deliver(from(email));

    const explained = await explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 0 });

    if (!explained.ok) throw new Error(explained.errors.join('; '));
    expect(explained.listens[0]).toMatchObject({ verdict: 'does_not_fire' });
    expect(cache.keptCount(teamId)).toBe(kept);
    const [stale] = await cache.answers(teamId, [{ plugin: IS_MEMBER, args: [email] }], async () => ({ value: 'asked again' }));
    expect(stale).toMatchObject({ value: true });
  });
});

describe('an explanation keeps nothing', () => {
  it('writes no run, fact, receipt, delivery or work', async () => {
    const movementId = await newMovement('team.lf');
    await insertTestListen({
      teamId,
      movementId,
      adapterType: ADAPTER,
      edge: 'Things',
      delivery: 'connection',
      movement: 'greet',
      checked: { asksHost: true, checked: { type: 'function', fn: IS_MEMBER, args: [{ type: 'edge_property', propertyTypeId: 'User Email', fieldOnly: true }] } },
    });
    const deliveryId = await deliver(from('stranger@elsewhere.test'));
    const before = await rowCounts();

    await explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 0 });
    await explainDeliveryArrival({ teamId, deliveryId, arrivalIndex: 0 });

    expect(await rowCounts()).toEqual(before);
  });
});
