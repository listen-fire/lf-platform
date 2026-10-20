// No movement runs inside a request. The on-demand doors (Run now from the app
// and from MCP, a replay) and the receive doors (inbound email, WhatsApp) store
// a receipt and a work row and answer; whichever worker drains next runs the
// movement. Real Postgres, a real saved movement on a manual listener, the real
// router and engine; the dispatch seam is only spied on, so "nothing ran yet"
// is observable.

import { randomUUID } from 'node:crypto';

jest.mock('../router', () => {
  const actual = jest.requireActual('../router');
  return { ...actual, dispatchTriggerByIdEvent: jest.fn(actual.dispatchTriggerByIdEvent) };
});

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { testWorkContext } from '../../../../test/harness/work';
import { saveMovement } from '../../movement/provision';
import { getMovementRunStatus, runMovementAsync } from '../../movement/run_now';
import { dispatchTriggerByIdEvent } from '../router';
import {
  dispatchEventHandler,
  receiveTriggerEvent,
  registerDispatchWork,
  requeueReceipt,
} from '../dispatch_event';
import { settleOrphanedRunningRuns } from '../../runs/trigger_run';
import { ORPHAN_AFTER } from '../../../movement_engine/run_lease';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../../work/drain';

jest.mock('../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

const mockedDispatch = dispatchTriggerByIdEvent as jest.Mock;

const SOURCE = `import { manual } from adapters

runs = connect manual

function noted(go: <runs-[:\`Invocation\`]->>) {
}

listen to runs {} fire noted
`;

describe('queued runs: the doors answer, a worker runs the movement', () => {
  let teamId: TeamId;
  let movementId: string;
  let triggerId: TriggerId;
  let notified = 0;

  const runRow = (runId: string) =>
    getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId as TriggerRunId)
      .select(['status', 'last_heartbeat_at', 'failure_reason', 'trigger_event_id'])
      .executeTakeFirstOrThrow();

  const workRows = () =>
    getAutomationsQb(['work'])
      .selectFrom('work')
      .where('team_id', '=', teamId)
      .where('kind', '=', 'dispatch_event')
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
    registerDispatchWork();
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
      .select('id')
      .executeTakeFirstOrThrow();
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
    const queued = await runMovementAsync({ teamId: teamId as string, movementId });
    if (!queued.ok) throw new Error(queued.errors.join('; '));

    // The answer came back before anything ran.
    expect(mockedDispatch).not.toHaveBeenCalled();
    const waiting = await runRow(queued.runId);
    expect(waiting.status).toBe('running');
    expect(waiting.last_heartbeat_at).toBeNull();
    expect(waiting.trigger_event_id).not.toBeNull();
    expect((await workRows()).map((row) => row.key)).toEqual([`dispatch_event:run:${queued.runId}`]);
    expect(notified).toBe(1);
    const polled = await getMovementRunStatus({ teamId: teamId as string, runId: queued.runId });
    expect(polled).toMatchObject({ status: 'running' });

    await drainUntilIdle({ owner: 'test', teamId });

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith(expect.objectContaining({ existingRunId: queued.runId }));
    const settled = await getMovementRunStatus({ teamId: teamId as string, runId: queued.runId });
    expect(settled).toMatchObject({ status: 'success', dryRun: false });
    expect(await workRows()).toEqual([]);
    const receipt = await getAutomationsQb(['trigger_event'])
      .selectFrom('trigger_event')
      .where('id', '=', waiting.trigger_event_id as never)
      .select('status')
      .executeTakeFirstOrThrow();
    expect(receipt.status).toBe('dispatched');
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
    await dispatchEventHandler.run(row.payload, testWorkContext());
    await dispatchEventHandler.recover?.(row.payload, testWorkContext());

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(await runRow(queued.runId)).toMatchObject({ status: 'success' });
  });

  it('a paused listener: the queued run settles failed, naming the pause', async () => {
    await getAutomationsQb(['trigger'])
      .updateTable('trigger')
      .set({ run_mode: 'off' })
      .where('id', '=', triggerId)
      .execute();
    const queued = await runMovementAsync({ teamId: teamId as string, movementId });
    if (!queued.ok) throw new Error(queued.errors.join('; '));

    await drainUntilIdle({ owner: 'test', teamId });

    const settled = await runRow(queued.runId);
    expect(settled.status).toBe('failed');
    expect(settled.failure_reason).toMatch(/this listener is paused/);
  });

  it('a run waiting in the queue past the orphan window is not settled as orphaned', async () => {
    const queued = await runMovementAsync({ teamId: teamId as string, movementId });
    if (!queued.ok) throw new Error(queued.errors.join('; '));
    // As if the workers had been asleep for twice the orphan window.
    await getAutomationsQb(['trigger_run'])
      .updateTable('trigger_run')
      .set({ started_at: new Date(Date.now() - 2 * ORPHAN_AFTER) })
      .where('id', '=', queued.runId as TriggerRunId)
      .execute();

    await settleOrphanedRunningRuns();
    expect(await runRow(queued.runId)).toMatchObject({ status: 'running' });

    await drainUntilIdle({ owner: 'test', teamId });
    expect(await runRow(queued.runId)).toMatchObject({ status: 'success' });
  });

  it('the receive door (email, WhatsApp) queues a row and answers; a drain runs it; a redelivery runs nothing new', async () => {
    const before = (await runsOfTrigger()).length;
    const event: TriggerEvent = {
      pipelineInputId: `trigger:${triggerId}`,
      adapterType: 'manual',
      triggerType: 'webhook',
      payload: { firedAt: new Date().toISOString(), submissionId: randomUUID(), text: 'hello' },
      idempotencyKey: `<${randomUUID()}@example.com>`,
      occurredAt: new Date().toISOString(),
    };

    const received = await receiveTriggerEvent({ teamId, triggerId, event });
    expect(received.duplicate).toBe(false);
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(await workRows()).toHaveLength(1);
    expect(notified).toBe(1);

    await drainUntilIdle({ owner: 'test', teamId });
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect((await runsOfTrigger()).length).toBe(before + 1);

    const redelivered = await receiveTriggerEvent({ teamId, triggerId, event });
    expect(redelivered).toEqual({ eventId: received.eventId, duplicate: true });
    await drainUntilIdle({ owner: 'test', teamId });
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect((await runsOfTrigger()).length).toBe(before + 1);
  });

  it("the loop guard's held release goes back on the queue, due later, still carrying its run", async () => {
    const queued = await runMovementAsync({ teamId: teamId as string, movementId });
    if (!queued.ok) throw new Error(queued.errors.join('; '));
    const { trigger_event_id: receiptId } = await runRow(queued.runId);
    if (receiptId === null) throw new Error('test: the run has no receipt');
    await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();

    const dueAt = new Date(Date.now() + 60_000);
    await requeueReceipt({ storedEventId: receiptId, dueAt, runId: queued.runId as TriggerRunId });

    const [row] = await workRows();
    expect(row?.key).toBe(`dispatch_event:run:${queued.runId}`);
    expect(row?.payload).toMatchObject({ runId: queued.runId, storedEventId: receiptId });
    expect(row?.due_at.getTime()).toBe(dueAt.getTime());
    // Not due yet: a drain now runs nothing.
    await drainUntilIdle({ owner: 'test', teamId });
    expect(mockedDispatch).not.toHaveBeenCalled();
  });
});
