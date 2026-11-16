// Shared polls of listenable edges (real DB, the real judge and delivery
// write; the module's poll faked). Listens on one polled edge of one
// connection with the same taken filter share one poll; what a later poll
// finds is kept as one delivery judged only by them; a first poll arms; a
// team on lf is not polled; the handler re-arms its row one interval on, or
// when its module said to poll again if that is sooner, and the reconcile
// keeps one row per shared poll.

import { randomUUID } from 'node:crypto';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { PollEdgeInput } from 'module-kit';

const polled = jest.fn<Promise<{ arrivals: Arrival[]; cursor?: unknown; pollAgainAt?: Date }>, [PollEdgeInput]>();
jest.mock('../edge_poller', () => ({
  edgePollerOf: async (input: { adapterType: string }) => (input.adapterType === 'poll_test' ? polled : null),
}));

import { sql } from 'kysely';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen, takenEquals } from '../../../test/harness/listens';
import { testWorkContext } from '../../../test/harness/work';
import { forgetLfEngineTeams, writeTeamEngine } from '../../lf_engine/team_engine';
import { listWorkByKind, removeWork } from '../../work/store';
import { pollEdgeHandler, pollReconcileHandler, pollShared, pollSubscriptionId, pollWorkKey, sharedPolls, type SharedPoll } from '../worker';

let teamId: TeamId;
let movementId: MovementId;

const arrival = (identity: string, status: string): Arrival => ({
  edge: 'Things',
  identity,
  landing: { recordId: identity, recordType: 'Thing', fields: { status } },
});

const firesOf = async () => {
  const rows = await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', teamId).where('kind', '=', 'fire_event').select('payload').execute();
  return rows.map((row) => row.payload as { triggerId: string; deliveryId: string });
};

const deliveries = () =>
  getAutomationsQb(['delivery']).selectFrom('delivery').where('team_id', '=', teamId).select(['id', 'source', 'subscription_id']).execute();

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  movementId = randomUUID() as MovementId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `polls-${teamId.slice(0, 8)}` }).execute();
  await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'polls', source: '' }).execute();
});

afterAll(async () => {
  for (const row of await listWorkByKind('poll_edge')) if (row.teamId === teamId) await removeWork({ key: row.key });
  await getAutomationsQb(['team_engine']).deleteFrom('team_engine').where('team_id', '=', teamId).execute();
  forgetLfEngineTeams();
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe('shared polls of a listenable edge', () => {
  let open: string;
  let alsoOpen: string;
  let closed: string;
  let shared: SharedPoll;

  it('groups the listens on one edge by the filter the module takes, and leaves a pushed edge out', async () => {
    open = await insertTestListen({ teamId, movementId, adapterType: 'poll_test', edge: 'Things', delivery: 'polled', pollEverySeconds: 120, taken: takenEquals('status', 'open'), movement: 'a' });
    alsoOpen = await insertTestListen({ teamId, movementId, adapterType: 'poll_test', edge: 'Things', delivery: 'polled', pollEverySeconds: 60, taken: takenEquals('status', 'open'), movement: 'b' });
    closed = await insertTestListen({ teamId, movementId, adapterType: 'poll_test', edge: 'Things', delivery: 'polled', taken: takenEquals('status', 'closed'), movement: 'c' });
    await insertTestListen({ teamId, movementId, adapterType: 'poll_test', edge: 'Things', delivery: 'connection', movement: 'd' });

    const polls = await sharedPolls({ teamId });

    expect(polls.map((poll) => poll.listens.map((l) => l.triggerId).sort())).toEqual(expect.arrayContaining([[open, alsoOpen].sort(), [closed]]));
    expect(polls).toHaveLength(2);
    const found = polls.find((poll) => poll.listens.length === 2);
    if (found === undefined) throw new Error('no shared poll');
    shared = found;
    // The most frequent of its listens' intervals.
    expect(shared.everyMs).toBe(60_000);
  });

  it('arms on the first poll: the cursor is kept and nothing is delivered', async () => {
    polled.mockResolvedValueOnce({ arrivals: [arrival('t-0', 'open')], cursor: 'c1' });

    expect(await pollShared(shared)).toEqual({ arrivals: 0, armed: true });

    expect(polled).toHaveBeenLastCalledWith({ edge: 'Things', filter: takenEquals('status', 'open') });
    expect(await deliveries()).toEqual([]);
    const { rows } = await sql<{ checkpoint: unknown }>`
      select checkpoint from automations.inbound_checkpoint where team_id = ${teamId}::uuid and subscription_id = ${pollSubscriptionId(shared.digest)}`.execute(getAutomationsQb(['inbound_checkpoint']));
    expect(rows).toEqual([{ checkpoint: 'c1' }]);
  });

  it('keeps a later poll as one delivery, judged by the listens sharing it only', async () => {
    polled.mockResolvedValueOnce({ arrivals: [arrival('t-1', 'open')], cursor: 'c2' });

    expect(await pollShared(shared)).toEqual({ arrivals: 1, armed: false });

    expect(polled).toHaveBeenLastCalledWith({ edge: 'Things', filter: takenEquals('status', 'open'), cursor: 'c1' });
    const [delivery] = await deliveries();
    expect(delivery).toMatchObject({ source: 'poll', subscription_id: pollSubscriptionId(shared.digest) });
    expect((await firesOf()).map((fire) => fire.triggerId).sort()).toEqual([open, alsoOpen].sort());
  });

  it('records the connection the poll was made for on the delivery it keeps', async () => {
    const connection = randomUUID();
    polled.mockResolvedValueOnce({ arrivals: [arrival('t-2', 'open')], cursor: 'c3' });

    await pollShared({ ...shared, key: { ...shared.key, credentialsId: connection } });

    const { rows } = await sql<{ credentials_id: string | null }>`
      select credentials_id::text as credentials_id from automations.delivery
      where team_id = ${teamId}::uuid and source = 'poll' order by received_at desc limit 1`.execute(getAutomationsQb(['delivery']));
    expect(rows).toEqual([{ credentials_id: connection }]);
  });

  const dueOf = async () => (await listWorkByKind('poll_edge')).find((each) => each.key === pollWorkKey(shared.digest))?.dueAt.getTime();

  it('re-arms its row one interval after a poll, and the reconcile keeps one row per shared poll', async () => {
    const now = new Date();
    polled.mockResolvedValueOnce({ arrivals: [], cursor: 'c3' });
    await pollEdgeHandler.run({ teamId, digest: shared.digest }, testWorkContext(now));
    const after = Date.now();
    expect(await dueOf()).toBeGreaterThanOrEqual(now.getTime() + 60_000);
    expect(await dueOf()).toBeLessThanOrEqual(after + 60_000);

    await pollReconcileHandler.run({}, testWorkContext(now));
    const mine = (await listWorkByKind('poll_edge')).filter((each) => each.teamId === teamId);
    expect(mine).toHaveLength(2);
  });

  it('re-arms its row when the module said the edge is next worth polling, within its interval', async () => {
    await removeWork({ key: pollWorkKey(shared.digest) });
    const soon = new Date(Date.now() + 15_000);
    polled.mockResolvedValueOnce({ arrivals: [], cursor: 'c4', pollAgainAt: soon });
    await pollEdgeHandler.run({ teamId, digest: shared.digest }, testWorkContext(new Date()));
    expect(await dueOf()).toBe(soon.getTime());
  });

  it('polls nothing for a team whose engine is lf', async () => {
    await writeTeamEngine(teamId, { engine: 'lf', changedBy: null });
    forgetLfEngineTeams();

    expect(await sharedPolls({ teamId })).toEqual([]);

    await writeTeamEngine(teamId, { engine: 'platform', changedBy: null });
    forgetLfEngineTeams();
  });
});
