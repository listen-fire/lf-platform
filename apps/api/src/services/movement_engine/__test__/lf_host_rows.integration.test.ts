// The platform's side of the line between its runs and lf's in the shared run
// tables: every platform scan that sweeps, wakes, re-arms, settles or resumes
// leaves a row marked host = 'lf' alone, while the same scan still acts on the
// platform's own row beside it. lf's rows are written here directly, as the lf
// store module writes them.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { testWorkContext } from '../../../test/harness/work';
import { settleOrphanedRunningRuns } from '../../translation_graph/runs/trigger_run';
import { pruneTriggerRuns } from '../../translation_graph/runs/prune';
import { settleStampedParkedRuns } from '../../interaction/run_failure';
import { resumeRun } from '../../interaction/operator';
import { listParkedRuns } from '../../interaction/observability';
import { ORPHAN_AFTER } from '../run_lease';
import { settleCancelledTimersHandler, timerWorkKey } from '../timer_resume';
import { postgresRunHostStore, returnLeavesOfLapsedLeases } from '../run_host_store';
import { mintCallback } from '../callback_store';
import { fireCallback, getDoorCallback } from '../callback_fire';

type Host = 'platform' | 'lf';

let teamId: TeamId;

beforeEach(() => {
  teamId = randomUUID() as TeamId;
});

afterEach(async () => {
  await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

async function insertRun(input: {
  host: Host;
  status: 'running' | 'parked';
  triggerId?: string;
  startedAt?: Date;
  cancelRequested?: boolean;
}): Promise<TriggerRunId> {
  const row = await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({
      team_id: teamId,
      trigger_id: input.triggerId ?? randomUUID(),
      trigger_type: 'webhook',
      status: input.status,
      host: input.host,
      ...(input.startedAt !== undefined ? { started_at: input.startedAt, last_heartbeat_at: input.startedAt } : {}),
      ...(input.cancelRequested === true ? { cancel_requested_at: new Date(), cancel_reason: 'Cancelled by a test' } : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertLeaf(input: {
  runId: TriggerRunId;
  reason: 'timer' | 'await';
  status?: 'parked' | 'resuming';
  wakeAt?: Date;
}): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .insertInto('parked_run')
    .values({
      run_id: input.runId,
      address: 'root/0',
      status: input.status ?? 'parked',
      park_reason: input.reason,
      wake_at: input.wakeAt ?? null,
      state: sql`'{}'::jsonb`,
    })
    .execute();
}

async function runRow(runId: TriggerRunId) {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['status', 'failure_reason'])
    .executeTakeFirst();
}

async function leafStatus(runId: TriggerRunId): Promise<string | undefined> {
  const row = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .select('status')
    .executeTakeFirst();
  return row?.status;
}

describe('the platform leaves lf rows alone', () => {
  it('an lf running run with a stale heartbeat survives the orphan sweep; the platform one beside it is failed', async () => {
    const stale = new Date(Date.now() - 2 * ORPHAN_AFTER);
    const lf = await insertRun({ host: 'lf', status: 'running', startedAt: stale });
    const platform = await insertRun({ host: 'platform', status: 'running', startedAt: stale });

    await settleOrphanedRunningRuns();

    expect(await runRow(lf)).toMatchObject({ status: 'running', failure_reason: null });
    expect(await runRow(platform)).toMatchObject({ status: 'failed' });
  });

  it("a resuming leaf of an lf run with a lapsed lease stays resuming: it is lf's to return", async () => {
    const lf = await insertRun({ host: 'lf', status: 'parked' });
    const platform = await insertRun({ host: 'platform', status: 'parked' });
    await insertLeaf({ runId: lf, reason: 'await', status: 'resuming' });
    await insertLeaf({ runId: platform, reason: 'await', status: 'resuming' });

    await returnLeavesOfLapsedLeases();

    expect(await leafStatus(lf)).toBe('resuming');
    expect(await leafStatus(platform)).toBe('parked');
  });

  it('an lf timer park is not re-armed by the timer sweep; the platform one is', async () => {
    const wakeAt = new Date(Date.now() + 60 * 60 * 1000);
    const lf = await insertRun({ host: 'lf', status: 'parked' });
    const platform = await insertRun({ host: 'platform', status: 'parked' });
    await insertLeaf({ runId: lf, reason: 'timer', wakeAt });
    await insertLeaf({ runId: platform, reason: 'timer', wakeAt });

    await settleCancelledTimersHandler.run({}, testWorkContext());

    const armed = await getAutomationsQb(['work'])
      .selectFrom('work')
      .where('key', 'in', [timerWorkKey(lf), timerWorkKey(platform)])
      .select(['key', 'host'])
      .execute();
    expect(armed).toEqual([{ key: timerWorkKey(platform), host: 'platform' }]);
  });

  it('an lf parked run stamped for cancel is not settled by the stamped-run sweep', async () => {
    const lf = await insertRun({ host: 'lf', status: 'parked', cancelRequested: true });
    await insertLeaf({ runId: lf, reason: 'await' });

    await settleStampedParkedRuns();

    expect(await runRow(lf)).toMatchObject({ status: 'parked' });
    expect(await leafStatus(lf)).toBe('parked');
  });

  it('resumeRun refuses an lf run', async () => {
    const lf = await insertRun({ host: 'lf', status: 'parked' });

    await expect(resumeRun({ runId: lf, teamId })).rejects.toThrow('this run is stepped by lf: resume it there');
  });

  it("an lf run's await is not found by the platform's correlation lookup", async () => {
    const lf = await insertRun({ host: 'lf', status: 'parked' });
    const platform = await insertRun({ host: 'platform', status: 'parked' });
    const correlationKey = `C1:${randomUUID()}`;
    for (const runId of [lf, platform]) {
      await postgresRunHostStore.correlations.correlate({ runId, teamId, address: 'root/0', adapterType: 'slack', correlationKey });
    }

    const found = await postgresRunHostStore.correlations.correlated({ adapterType: 'slack', teamId, correlationKey });

    expect(found.map((row) => row.runId)).toEqual([platform]);
  });

  it("an lf run's callback is unknown at the platform's door", async () => {
    const lf = await insertRun({ host: 'lf', status: 'parked' });
    const callback = await mintCallback({ teamId, runId: lf, address: 'root/0', params: [], state: {} });

    expect(await getDoorCallback(callback.id)).toBeNull();
    expect(await fireCallback({ id: callback.id, values: {} })).toEqual({ kind: 'not_found' });
    const after = await getAutomationsQb(['callback']).selectFrom('callback').where('id', '=', callback.id).select(['status', 'calls']).executeTakeFirst();
    expect(after).toEqual({ status: 'live', calls: [] });
  });

  it('a live lf run outlives the retention prune; a settled one ages out', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const live = await insertRun({ host: 'lf', status: 'parked' });
    const settled = await insertRun({ host: 'lf', status: 'parked' });
    await getAutomationsQb(['trigger_run']).updateTable('trigger_run').set({ status: 'success' }).where('id', '=', settled).execute();
    await getAutomationsQb(['trigger_run']).updateTable('trigger_run').set({ created_at: old }).where('id', 'in', [live, settled]).execute();

    const pruned = await pruneTriggerRuns({ teamId });

    expect(pruned.deletedRunIds).toEqual([settled]);
    expect(await runRow(live)).toMatchObject({ status: 'parked' });
  });

  it('an lf run is listed beside the platform\'s, named by its movement', async () => {
    const lf = await insertRun({ host: 'lf', status: 'parked', triggerId: 'listen:welcome.lf:greet' });
    await insertLeaf({ runId: lf, reason: 'timer', wakeAt: new Date(Date.now() + 60_000) });

    const parked = await listParkedRuns(teamId);

    expect(parked.map((run) => ({ runId: run.runId, automationName: run.automationName }))).toEqual([
      { runId: lf, automationName: 'greet' },
    ]);
  });
});
