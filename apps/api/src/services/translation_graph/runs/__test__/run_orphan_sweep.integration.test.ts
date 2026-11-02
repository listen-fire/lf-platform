// The periodic orphan sweep against the real tables: a `running` run whose
// segment has gone silent fails; a live run
// and a parked one are left alone.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { testWorkContext } from '../../../../test/harness/work';
import { noteFirstFiringLeaseLost, runOrphanSweepHandler } from '../trigger_run';
import { getMovementRunStatus } from '../../movement/run_now';

const MINUTE = 60_000;

async function seedRun(input: {
  teamId: TeamId;
  status: 'running' | 'parked';
  lastHeartbeatAt: Date;
}): Promise<TriggerRunId> {
  const id = randomUUID() as TriggerRunId;
  await getAutomationsQb(['trigger_run'])
    .insertInto('trigger_run')
    .values({
      id,
      team_id: input.teamId,
      trigger_id: randomUUID(),
      trigger_type: 'webhook',
      status: input.status,
      started_at: input.lastHeartbeatAt,
      last_heartbeat_at: input.lastHeartbeatAt,
    })
    .execute();
  return id;
}

async function runState(id: TriggerRunId) {
  return getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', id)
    .select(['status', 'failure_reason'])
    .executeTakeFirstOrThrow();
}

describe('run_orphan_sweep (real DB)', () => {
  let teamId: TeamId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `orphan-sweep-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('fails a silent running run; leaves a live run and a parked run alone', async () => {
    const now = new Date();
    const orphan = await seedRun({
      teamId,
      status: 'running',
      lastHeartbeatAt: new Date(now.getTime() - 2 * MINUTE),
    });
    const live = await seedRun({ teamId, status: 'running', lastHeartbeatAt: now });
    const parked = await seedRun({
      teamId,
      status: 'parked',
      lastHeartbeatAt: new Date(now.getTime() - 2 * MINUTE),
    });

    await runOrphanSweepHandler.run({}, testWorkContext(now));

    expect(await runState(orphan)).toEqual({
      status: 'failed',
      failure_reason: 'segment did not complete: process died or stalled',
    });
    expect((await runState(live)).status).toBe('running');
    expect((await runState(parked)).status).toBe('parked');
  });

  it('settles a first firing that stopped for a lost lease with that reason, not a dead process', async () => {
    const id = await seedRun({ teamId, status: 'running', lastHeartbeatAt: new Date(Date.now() - 2 * MINUTE) });
    await noteFirstFiringLeaseLost(id);
    // Until it is settled the note is not a failure: a reader reports a run
    // still running, with no failure reason.
    expect(await getMovementRunStatus({ teamId, runId: id })).toMatchObject({ status: 'running', failureReason: null });

    await runOrphanSweepHandler.run({}, testWorkContext(new Date()));

    expect(await runState(id)).toEqual({
      status: 'failed',
      failure_reason: 'segment did not complete: its run lease was lost to another instance',
    });
    expect(await getMovementRunStatus({ teamId, runId: id })).toMatchObject({
      status: 'failed',
      failureReason: 'segment did not complete: its run lease was lost to another instance',
    });
  });

  it('judges a run that never beat by its start', async () => {
    const now = new Date();
    const id = randomUUID() as TriggerRunId;
    await getAutomationsQb(['trigger_run'])
      .insertInto('trigger_run')
      .values({
        id,
        team_id: teamId,
        trigger_id: randomUUID(),
        trigger_type: 'webhook',
        status: 'running',
        started_at: new Date(now.getTime() - 2 * MINUTE),
        last_heartbeat_at: null,
      })
      .execute();

    await runOrphanSweepHandler.run({}, testWorkContext(now));

    expect((await runState(id)).status).toBe('failed');
  });
});
