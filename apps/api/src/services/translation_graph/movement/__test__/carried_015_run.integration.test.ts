// A Run now of a 0.15.3 automation that waits (real Postgres, the real drain):
// release 0.15.3's engine runs it, it parks in the run host's own rows, and
// the run host's timer drain resumes it on 0.15's engine to success. One run
// host, two engines.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../../work/drain';
import { registerTimerWork, timerWorkKey } from '../../../movement_engine/timer_resume';
import { registerCarriedRunWork } from '../carried_run_now';
import { getMovementRunStatus, runMovementAsync } from '../run_now';
import { mintMovementVersionIfChanged } from '../version_store';

/** A 0.15 Run now program that waits an hour, then answers. */
const WAITS_015 =
  'function go(i: <manual-[:Invocations]->>) {\n  await sleep(1h)\n  return "awake"\n}\n' + 'listen to manual-[:Invocations]-> fire go\n';

describe('a 0.15.3 automation run and resumed on the one run host (real Postgres)', () => {
  let teamId: TeamId;
  let movementId: string;

  const runRow = (runId: string) =>
    getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId as TriggerRunId).select(['status', 'failure_reason', 'engine']).executeTakeFirstOrThrow();

  const parkedLeaves = (runId: string) =>
    getAutomationsQb(['parked_run']).selectFrom('parked_run').where('run_id', '=', runId as TriggerRunId).select(['park_reason', 'status', 'state']).execute();

  beforeAll(async () => {
    resetWorkHandlersForTests();
    registerCarriedRunWork();
    registerTimerWork();
    setWorkNotifier({ notify() {} });
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `carried-015-${teamId.slice(0, 8)}` } as any)
      .execute();
    movementId = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: movementId as MovementId, team_id: teamId, name: 'waits', source: WAITS_015, description: '', language_version: '0.15.3' })
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId, source: WAITS_015, languageVersion: '0.15.3' });
  });

  afterAll(async () => {
    setWorkNotifier(inProcessNotifier);
    resetWorkHandlersForTests();
    await cleanupTeam(teamId);
  });

  it("parks in the run host's rows under 0.15's engine, and the timer drain resumes it to success", async () => {
    const queued = await runMovementAsync({ teamId, movementId, text: 'go' });
    expect(queued).toEqual(expect.objectContaining({ ok: true, movementName: 'go' }));
    if (!queued.ok) return;

    await drainUntilIdle({ owner: 'carried-015', teamId });
    expect(await runRow(queued.runId)).toEqual(expect.objectContaining({ status: 'parked', failure_reason: null }));
    const leaves = await parkedLeaves(queued.runId);
    expect(leaves).toEqual([expect.objectContaining({ park_reason: 'timer', status: 'parked' })]);
    // The park state is the engine's own, in the version every release reads.
    expect(leaves[0]?.state).toEqual(expect.objectContaining({ version: 4 }));

    const past = new Date(Date.now() - 60_000);
    await getAutomationsQb(['parked_run']).updateTable('parked_run').set({ wake_at: past }).where('run_id', '=', queued.runId as TriggerRunId).execute();
    await getAutomationsQb(['work']).updateTable('work').set({ due_at: past }).where('key', '=', timerWorkKey(queued.runId)).execute();
    await drainUntilIdle({ owner: 'carried-015', teamId });

    expect(await runRow(queued.runId)).toEqual(expect.objectContaining({ status: 'success', failure_reason: null }));
    const status = await getMovementRunStatus({ teamId, runId: queued.runId });
    expect(status).toEqual(expect.objectContaining({ status: 'success' }));
  });
});
