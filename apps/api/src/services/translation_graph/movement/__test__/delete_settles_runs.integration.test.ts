// Deleting an automation settles the runs paused on it, whichever version
// they are on (real Postgres, the real delete). A paused run of a carried version has no trigger row: its Run now
// is recorded under the movement's own id, so the delete finds it there.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { deleteMovement } from '../provision';
import { carriedRunTriggerId } from '../carried_names';
import { insertTestListen } from '../../../../test/harness/listens';

jest.mock('../../../credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));
jest.mock('../../../../lib/slack', () => ({ sendSlackNotification: async () => undefined }));
jest.mock('../listen_subscriptions', () => ({ syncListenSubscriptions: async () => ({ notes: [], unregistered: [] }) }));

describe('deleting an automation with a run paused on it', () => {
  let teamId: TeamId;

  beforeAll(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `del-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterAll(async () => {
    await cleanupTeam(teamId);
  });

  async function seed(name: string, languageVersion: string): Promise<string> {
    const id = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: id as MovementId, team_id: teamId, name, source: 'function go() {\n}\n', description: '', language_version: languageVersion })
      .execute();
    return id;
  }

  /** A run paused on an ask, recorded under `triggerId`. */
  async function pausedRun(triggerId: string): Promise<TriggerRunId> {
    const runId = randomUUID() as TriggerRunId;
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: runId, team_id: teamId, trigger_id: triggerId, trigger_type: 'manual', status: 'parked', trigger_payload: {} } as any)
      .execute();
    await getAutomationsQb(['parked_run'])
      .insertInto('parked_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: randomUUID(), run_id: runId, address: 'root', status: 'parked', park_reason: 'ask' } as any)
      .execute();
    return runId;
  }

  const runOf = (runId: TriggerRunId) =>
    getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select(['status', 'failure_reason']).executeTakeFirstOrThrow();

  it.each([['0.12.13'], ['4']])('a run paused by a Run now of a %s automation, which has no trigger row, is stopped with the reason', async (pin) => {
    const id = await seed(`carried_${pin}`, pin);
    const runId = await pausedRun(carriedRunTriggerId(id));

    expect(await deleteMovement({ teamId, id })).toBe(true);

    expect(await runOf(runId)).toEqual({ status: 'failed', failure_reason: expect.stringContaining('the automation was deleted') });
  });

  it('a run paused on one of its listens is stopped', async () => {
    const id = await seed('listening', '0.15.1');
    const triggerId = await insertTestListen({ teamId, movementId: id as MovementId, adapterType: 'manual', edge: 'Invocations', delivery: 'connection' });
    const runId = await pausedRun(triggerId);

    await deleteMovement({ teamId, id });

    expect(await runOf(runId)).toEqual({ status: 'failed', failure_reason: expect.stringContaining('the automation was deleted') });
  });
});
