// Who acted on an arrival a run waits for, against a real database: the door
// finds the waits on the arrival's edge, and the automation of each waiting
// run, reached by the version the run pins, says whether it reads `Actor`, as
// its last save recorded. The automation is saved the real way, on a manual
// listen, so its runs start from no listen that hears the press.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';

// Only the chat module is faked: the save's catalog resolves the real manual unit.
jest.mock('../../translation_graph/adapters/resolve', () => {
  const actual = jest.requireActual('../../translation_graph/adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn(actual.resolveAdapter) };
});
jest.mock('../../credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { resolveAdapter as resolveAdapterImport } from '../../translation_graph/adapters/resolve';
import { saveMovement } from '../../translation_graph/movement/provision';
import { ACTOR, withActors } from '../actors';

const resolveAdapter = resolveAdapterImport as jest.Mock;
const { resolveAdapter: actualResolveAdapter } = jest.requireActual('../../translation_graph/adapters/resolve');
const askedChat = () => resolveAdapter.mock.calls.some(([input]) => input.adapterType === 'chat');

/** An approval started by hand, whose handler names who approved. */
const approval = (handled: string) => `function approve(go: <manual-[:Invocations]->>) {
  ${handled}
}

listen to manual-[:Invocations]-> fire approve
`;

let teamId: TeamId;

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    .values({ id: teamId, name: `actors-${teamId.slice(0, 8)}` })
    .execute();
  const chat = {
    getActorCandidates: async () => [{ identity: { identifier: 'U1', scheme: 'email', adapterType: 'chat', email: 'ada@x.com' }, source: 'originator' }],
  };
  resolveAdapter.mockImplementation(async (input: { adapterType: string }) => (input.adapterType === 'chat' ? chat : actualResolveAdapter(input)));
});

afterEach(async () => {
  await cleanupTeam(teamId);
});

/** Saves `source` as the automation `approval`, returning its id. */
async function saved(source: string, id?: string): Promise<string> {
  const result = await saveMovement({ audience: { for: 'run' }, teamId, source, name: 'approval', ...(id !== undefined ? { id } : {}) });
  if (!result.ok) throw new Error(`test: the approval did not save: ${JSON.stringify(result)}`);
  return result.movementId;
}

/** A run of the automation's current version, started by its manual
 *  trigger, parked waiting on `edge` of the chat module. */
async function waitingRun(movementId: string, edge: string): Promise<void> {
  const qb = getAutomationsQb(['movement', 'trigger', 'trigger_run', 'wait_row']);
  const { rows } = await sql<{ trigger_id: string; version_id: string }>`
    select t.id::text as trigger_id, m.current_version_id::text as version_id
    from automations.movement m join automations.trigger t on t.movement_id = m.id
    where m.id = ${movementId}::uuid and t.kind = 'manual'`.execute(qb);
  const [started] = rows;
  if (started === undefined) throw new Error('test: the approval has no manual trigger');
  const runId = randomUUID();
  await sql`insert into automations.trigger_run (id, team_id, trigger_id, trigger_type, status, movement_version_id) values (${runId}::uuid, ${teamId}::uuid, ${started.trigger_id}, 'webhook', 'parked', ${started.version_id}::uuid)`.execute(qb);
  await sql`insert into automations.wait_row (run_id, team_id, adapter_type, edge, key, since) values (${runId}::uuid, ${teamId}::uuid, 'chat', ${edge}, 'msg-1', 0)`.execute(qb);
}

const PRESS: Exclude<Arrival, { gone: true }> = {
  edge: 'Presses',
  identity: 'press-1',
  landing: { recordType: 'Press', fields: { value: 'approve' } },
  actor: { identifier: 'U1', scheme: 'opaque', adapterType: 'chat', label: 'U1', proven: true },
};

const delivered = { adapterType: 'chat', credentialsId: null };

it('writes who pressed for a run, started by hand, of an automation whose handler reads Actor', async () => {
  await waitingRun(await saved(approval('who = go.Actor?.Email')), 'Presses');

  const { arrivals, actors } = await withActors([PRESS], { team: teamId, listens: [], adapter: delivered });

  const [arrival] = arrivals;
  expect(arrival !== undefined && !('gone' in arrival) ? arrival.landing.fields[ACTOR] : undefined).toMatchObject({ Id: 'U1', Email: 'ada@x.com', Proven: true });
  expect(actors.map((actor) => actor.kind)).toEqual(['written']);
});

it('asks nothing for a run of an automation reading Actor that waits on another edge', async () => {
  await waitingRun(await saved(approval('who = go.Actor?.Email')), 'Messages');

  expect((await withActors([PRESS], { team: teamId, listens: [], adapter: delivered })).actors).toEqual([{ kind: 'unneeded' }]);
  expect(askedChat()).toBe(false);
});

it('asks nothing once the same automation is saved with a handler that does not read Actor', async () => {
  const id = await saved(approval('who = go.Actor?.Email'));
  await waitingRun(await saved(approval('said = 1'), id), 'Presses');

  expect((await withActors([PRESS], { team: teamId, listens: [], adapter: delivered })).actors).toEqual([{ kind: 'unneeded' }]);
  expect(askedChat()).toBe(false);
});
