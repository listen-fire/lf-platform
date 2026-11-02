// No movement runs inside a request. Run now (from the app and from MCP)
// keeps its press as a delivery whose one Invocations arrival the
// movement's manual listen took, with a `fire_event` row for the run, and
// answers; whichever worker drains next runs the movement under the listen's
// receipt. Real Postgres, a real saved movement on a manual listen, the real
// judge, router and engine; the dispatch seam is only spied on, so "nothing
// ran yet" is observable.

import { randomUUID } from 'node:crypto';

jest.mock('../../triggers/router', () => {
  const actual = jest.requireActual('../../triggers/router');
  return { ...actual, dispatchTriggerByIdEvent: jest.fn(actual.dispatchTriggerByIdEvent) };
});

import { sql } from 'kysely';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { testWorkContext } from '../../../../test/harness/work';
import { saveMovement } from '../provision';
import { getMovementRunStatus, runMovementAsync } from '../run_now';
import { dispatchTriggerByIdEvent } from '../../triggers/router';
import { fireEventHandler, registerFireEventWork } from '../../../inbound/fire_event';
import { settleOrphanedRunningRuns } from '../../runs/trigger_run';
import { ORPHAN_AFTER } from '../../../movement_engine/run_lease';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../../work/drain';

jest.mock('../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

const mockedDispatch = dispatchTriggerByIdEvent as jest.Mock;

const SOURCE = `function noted(go: <manual-[:Invocations]->>) {
}

listen to manual-[:Invocations]-> fire noted
`;

describe('queued runs: Run now answers, a worker runs the movement', () => {
  let teamId: TeamId;
  let movementId: string;
  let triggerId: TriggerId;
  let notified = 0;

  const runRow = (runId: string) =>
    getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId as TriggerRunId)
      .select(['status', 'last_heartbeat_at', 'failure_reason'])
      .executeTakeFirst();

  const workRows = () =>
    getAutomationsQb(['work'])
      .selectFrom('work')
      .where('team_id', '=', teamId)
      .where('kind', '=', 'fire_event')
      .select(['key', 'payload', 'due_at'])
      .execute();

  const runsOfTrigger = () =>
    getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('trigger_id', '=', triggerId)
      .select(['id', 'status'])
      .execute();

  beforeAll(async () => {
    resetWorkHandlersForTests();
    registerFireEventWork();
    setWorkNotifier({
      notify() {
        notified += 1;
      },
    });

    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `queued-${teamId.slice(0, 8)}` } as any)
      .execute();

    const saved = await saveMovement({ teamId: teamId as string, source: SOURCE, name: 'queued-probe' });
    if (!saved.ok) throw new Error(`test: the probe movement did not save: ${JSON.stringify(saved)}`);
    movementId = saved.movementId;
    const trigger = await getAutomationsQb(['trigger'])
      .selectFrom('trigger')
      .where('movement_id', '=', movementId as never)
      .select(['id', 'kind'])
      .executeTakeFirstOrThrow();
    expect(trigger.kind).toBe('manual');
    triggerId = trigger.id as TriggerId;
  });

  afterAll(async () => {
    setWorkNotifier(inProcessNotifier);
    resetWorkHandlersForTests();
    await cleanupTeam(teamId);
  });

  beforeEach(async () => {
    mockedDispatch.mockClear();
    notified = 0;
    await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['trigger'])
      .updateTable('trigger')
      .set({ run_mode: 'live' })
      .where('id', '=', triggerId)
      .execute();
  });

  it('Run now answers with a waiting run and runs nothing; a drain runs it to success', async () => {
    const queued = await runMovementAsync({ teamId: teamId as string, movementId, text: 'hello' });
    if (!queued.ok) throw new Error(queued.errors.join('; '));

    // The answer came back before anything ran.
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(await runRow(queued.runId)).toBeUndefined();
    const [row] = await workRows();
    expect(row?.payload).toMatchObject({ runId: queued.runId, triggerId, arrival: { edge: 'Invocations' } });
    expect(row?.due_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(notified).toBeGreaterThan(0);
    const polled = await getMovementRunStatus({ teamId: teamId as string, runId: queued.runId });
    expect(polled).toMatchObject({ status: 'running' });
    const delivery = await sql<{ source: string }>`
      select source from automations.delivery where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['delivery']));
    expect(delivery.rows).toEqual([{ source: 'cli' }]);

    await drainUntilIdle({ owner: 'test', teamId });

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith(expect.objectContaining({ existingRunId: queued.runId }));
    const settled = await getMovementRunStatus({ teamId: teamId as string, runId: queued.runId });
    expect(settled).toMatchObject({ status: 'success', dryRun: false });
    expect(await workRows()).toEqual([]);
  });

  it('a retried Run now with the same requestId is the same run, and it runs once', async () => {
    const before = (await runsOfTrigger()).length;
    const requestId = randomUUID();
    const first = await runMovementAsync({ teamId: teamId as string, movementId, requestId });
    const retry = await runMovementAsync({ teamId: teamId as string, movementId, requestId });
    if (!first.ok || !retry.ok) throw new Error('test: run now refused');
    expect(retry.runId).toBe(first.runId);
    expect(await workRows()).toHaveLength(1);

    await drainUntilIdle({ owner: 'test', teamId });

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect((await runsOfTrigger()).length).toBe(before + 1);
  });

  it('a second claim of a run that already started never starts it again', async () => {
    const queued = await runMovementAsync({ teamId: teamId as string, movementId });
    if (!queued.ok) throw new Error(queued.errors.join('; '));
    const [row] = await workRows();
    if (row === undefined) throw new Error('test: no work row');

    await drainUntilIdle({ owner: 'test', teamId });
    // The same row claimed again (a lapsed lease, a redelivered tick).
    await fireEventHandler.run(row.payload, testWorkContext());
    await fireEventHandler.recover?.(row.payload, testWorkContext());

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(await runRow(queued.runId)).toMatchObject({ status: 'success' });
  });

  it('a paused listen: the queued run settles failed, naming the pause', async () => {
    await getAutomationsQb(['trigger'])
      .updateTable('trigger')
      .set({ run_mode: 'off' })
      .where('id', '=', triggerId)
      .execute();
    const queued = await runMovementAsync({ teamId: teamId as string, movementId });
    if (!queued.ok) throw new Error(queued.errors.join('; '));

    await drainUntilIdle({ owner: 'test', teamId });

    const settled = await runRow(queued.runId);
    expect(settled?.status).toBe('failed');
    expect(settled?.failure_reason).toMatch(/this listener is paused/);
  });

  it('a run its row started, back in the queue past the orphan window, is not settled as orphaned', async () => {
    const queued = await runMovementAsync({ teamId: teamId as string, movementId });
    if (!queued.ok) throw new Error(queued.errors.join('; '));
    // As if a worker wrote the run row waiting, and then the workers slept
    // for twice the orphan window.
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      .values({
        id: queued.runId as TriggerRunId,
        team_id: teamId,
        trigger_id: triggerId,
        trigger_type: 'webhook',
        status: 'running',
        started_at: new Date(Date.now() - 2 * ORPHAN_AFTER),
        last_heartbeat_at: null,
      })
      .execute();

    await settleOrphanedRunningRuns();
    expect(await runRow(queued.runId)).toMatchObject({ status: 'running' });
  });
});
