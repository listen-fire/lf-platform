// Deleting an automation settles the runs paused on it, whichever version
// they are on, and closes the callbacks they hold (real Postgres, the real
// delete). A paused run of a carried version has no trigger row: its Run now
// is recorded under the movement's own id, so the delete finds it there.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { CallbackId } from '../../../../generated/kysely/automations/Callback';

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

  /** A run paused on an ask, with a callback it still holds, recorded under `triggerId`. */
  async function pausedRun(triggerId: string, state: 'parked' | 'running' = 'parked'): Promise<{ runId: TriggerRunId; callbackId: CallbackId }> {
    const runId = randomUUID() as TriggerRunId;
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: runId, team_id: teamId, trigger_id: triggerId, trigger_type: 'manual', status: state, trigger_payload: {} } as any)
      .execute();
    if (state === 'parked') {
      await getAutomationsQb(['parked_run'])
        .insertInto('parked_run')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .values({ id: randomUUID(), run_id: runId, address: 'root', status: 'parked', park_reason: 'ask' } as any)
        .execute();
    }
    const callbackId = randomUUID() as CallbackId;
    await getAutomationsQb(['callback'])
      .insertInto('callback')
      .values({ id: callbackId, team_id: teamId, run_id: runId, address: 'root', params: {}, state: {}, status: 'live' })
      .execute();
    return { runId, callbackId };
  }

  const runOf = (runId: TriggerRunId) =>
    getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select(['status', 'failure_reason']).executeTakeFirstOrThrow();
  const callbackStatus = async (id: CallbackId) =>
    (await getAutomationsQb(['callback']).selectFrom('callback').where('id', '=', id).select('status').executeTakeFirstOrThrow()).status;

  it.each([['0.12.13'], ['4']])('a run paused by a Run now of a %s automation, which has no trigger row, is stopped with the reason, and its callback closed', async (pin) => {
    const id = await seed(`carried_${pin}`, pin);
    const { runId, callbackId } = await pausedRun(carriedRunTriggerId(id));

    expect(await deleteMovement({ teamId, id })).toBe(true);

    expect(await runOf(runId)).toEqual({ status: 'failed', failure_reason: expect.stringContaining('the automation was deleted') });
    expect(await callbackStatus(callbackId)).toBe('revoked');
  });

  it('a run paused on one of its listens is stopped, and its callback closed', async () => {
    const id = await seed('listening', '0.15.1');
    const triggerId = await insertTestListen({ teamId, movementId: id as MovementId, adapterType: 'manual', edge: 'Invocations', delivery: 'connection' });
    const { runId, callbackId } = await pausedRun(triggerId);

    await deleteMovement({ teamId, id });

    expect(await runOf(runId)).toEqual({ status: 'failed', failure_reason: expect.stringContaining('the automation was deleted') });
    expect(await callbackStatus(callbackId)).toBe('revoked');
  });

  it('a callback held by a run that is running when its automation is deleted is closed: there is no program left to resume into', async () => {
    const id = await seed('running', '0.15.1');
    const triggerId = await insertTestListen({ teamId, movementId: id as MovementId, adapterType: 'manual', edge: 'Invocations', delivery: 'connection' });
    const { runId, callbackId } = await pausedRun(triggerId, 'running');

    await deleteMovement({ teamId, id });

    expect((await runOf(runId)).status).toBe('running');
    expect(await callbackStatus(callbackId)).toBe('revoked');
  });
});
