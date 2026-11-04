// A Run now of a 0.12 automation, queued as a `run_carried` work row (real
// Postgres, the real drain, 0.12's real run host). The row's event is in 0.12's
// shape and only 0.12 reads it: one 0.12 cannot read, or an automation moved
// off 0.12 since the press, is recorded failed with the reason, so whoever
// follows the run by its id learns it.
//
// The rollout half: while services restart one by one, a 0.12.13 drain runs
// beside new ones. `drain01213Claims` is that release's claim statement and
// kinds (v0.12.13, apps/api/src/services/work/store.ts `claimDueWork`, and
// work/kinds.ts `CORE_WORK_KINDS`).

import { randomUUID } from 'node:crypto';

jest.mock('../execute', () => {
  const actual = jest.requireActual('../execute');
  return { ...actual, runMovementFiring: jest.fn(actual.runMovementFiring) };
});

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { testWorkContext } from '../../../../test/harness/work';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../../work/drain';
import { savedListens } from '../../../inbound/listen_door';
import { CARRIED_RUN_WORK_KIND, carriedRunHandler, registerCarriedRunWork } from '../carried_run_now';
import { runMovementFiring } from '../execute';
import { getMovementRunStatus, runMovementAsync } from '../run_now';
import { mintMovementVersionIfChanged } from '../version_store';

const mockedFiring = runMovementFiring as jest.Mock;

/** A manual listen as 0.12 spells it, reading the press's text. */
const ECHO_012 = 'function echo(run: <manual-[:Invocation]->>) {\n  t = run.Text\n  return t\n}\nlisten to manual fire echo\n';

/** The kinds a 0.12.13 drain claims: its core kinds (it registers no unit kind
 *  a press could be queued under). */
const DRAIN_01213_KINDS = [
  'dispatch_event',
  'resume_timer',
  'fire_cron',
  'poll_source',
  'wake_await',
  'fire_callback',
  'cron_reconcile',
  'poll_reconcile',
  'timer_sweep',
  'run_orphan_sweep',
];

/** What a 0.12.13 drain's claim takes for `teamId` right now. */
async function drain01213Claims(teamId: string): Promise<string[]> {
  const { rows } = await sql<{ kind: string }>`
    WITH c AS MATERIALIZED (
      SELECT id FROM automations.work
      WHERE host = 'platform' AND due_at <= ${new Date()} AND (lease_until IS NULL OR lease_until < now())
        AND kind = ANY(${DRAIN_01213_KINDS}::text[])
        AND team_id = ${teamId}::uuid
      ORDER BY due_at
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    )
    UPDATE automations.work w
    SET lease_owner = 'drain-0.12.13', lease_until = now() + interval '1 minute', lease_token = gen_random_uuid(), attempts = attempts + 1
    FROM c
    WHERE w.id = c.id
    RETURNING w.kind`.execute(getAutomationsQb(['work']));
  return rows.map((row) => row.kind);
}

describe('a Run now of a 0.12 automation, queued (real Postgres)', () => {
  let teamId: TeamId;
  let movementId: string;

  const runRow = (runId: string) =>
    getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('id', '=', runId as TriggerRunId)
      .select(['status', 'failure_reason'])
      .executeTakeFirst();

  const workRows = () =>
    getAutomationsQb(['work'])
      .selectFrom('work')
      .where('team_id', '=', teamId)
      .select(['kind', 'key', 'attempts', 'lease_owner', 'dead_at'])
      .execute();

  beforeAll(async () => {
    resetWorkHandlersForTests();
    registerCarriedRunWork();
    setWorkNotifier({ notify() {} });
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `k5a-carried-${teamId.slice(0, 8)}` } as any)
      .execute();
    movementId = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: movementId as MovementId, team_id: teamId, name: 'echo', source: ECHO_012, description: '', language_version: '0.12.13' })
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId, source: ECHO_012, languageVersion: '0.12.13' });
  });

  afterAll(async () => {
    setWorkNotifier(inProcessNotifier);
    resetWorkHandlersForTests();
    await cleanupTeam(teamId);
  });

  beforeEach(async () => {
    mockedFiring.mockClear();
    await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
  });

  const row = (over: Record<string, unknown> = {}) => ({
    teamId,
    movementId,
    movementName: 'echo',
    pin: '0.12.13',
    event: { pipelineInputId: `trigger:${movementId}`, adapterType: 'manual', triggerType: 'webhook', payload: { firedAt: '2026-11-04T10:00:00.000Z', text: 'hello' } },
    runId: randomUUID(),
    ...over,
  });

  it("a press 0.12's own schema cannot read is recorded failed, with the reason, and runs nothing", async () => {
    const queued = row({ event: { pipelineInputId: 'p', adapterType: 'manual', triggerType: 'not-a-trigger-type' } });
    await carriedRunHandler.run(queued, testWorkContext());
    expect(mockedFiring).not.toHaveBeenCalled();
    const settled = await runRow(queued.runId);
    expect(settled?.status).toBe('failed');
    expect(settled?.failure_reason).toContain('the queued press could not be read under language 0.12.13');
    expect(settled?.failure_reason).toContain('triggerType');
  });

  it("the press reaches 0.12 as it was queued: this release's schema never parses it, so it strips nothing", async () => {
    const event = { pipelineInputId: `trigger:${movementId}`, adapterType: 'manual', triggerType: 'webhook', payload: { firedAt: '2026-11-04T10:00:00.000Z', text: 'hello' }, onlyZeroTwelveKnows: true };
    const queued = row({ event });
    await carriedRunHandler.run(queued, testWorkContext());
    expect(mockedFiring).toHaveBeenCalledWith(expect.objectContaining({ door: { kind: 'manual', event } }));
    expect((await runRow(queued.runId))?.status).toBe('success');
  });

  it('an automation moved off 0.12 since the press is not handed the 0.12 event: failed, naming both versions', async () => {
    const moved = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: moved as MovementId, team_id: teamId, name: 'moved', source: ECHO_012, description: '', language_version: LANGUAGE_VERSION })
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId: moved, source: ECHO_012, languageVersion: LANGUAGE_VERSION });
    const queued = row({ movementId: moved });
    await carriedRunHandler.run(queued, testWorkContext());
    expect(mockedFiring).not.toHaveBeenCalled();
    const settled = await runRow(queued.runId);
    expect(settled?.status).toBe('failed');
    expect(settled?.failure_reason).toContain('queued under language 0.12.13');
    expect(settled?.failure_reason).toContain(`moved to ${LANGUAGE_VERSION}`);
  });

  describe('during a rollout, beside a 0.12.13 drain', () => {
    it("the new doors write one row for a 0.12 automation, `run_carried`: 0.12.13's claim never takes it, and a new drain runs it", async () => {
      // A trigger row as 0.12.13 left it: no listen plan in its config, so
      // the new doors judge nothing against it and queue no run from it.
      const triggerId = randomUUID();
      await getAutomationsQb(['trigger'])
        .insertInto('trigger')
        .values({ id: triggerId as TriggerId, team_id: teamId, name: 'movement/echo/echo', kind: 'manual', config: {} as never, movement_id: movementId as MovementId, fired_movement_name: 'echo', run_mode: 'live', provisioned_by_setup_agent: false } as never)
        .execute();
      expect(await savedListens({ teamId, adapterType: 'manual' })).toEqual([]);

      const queued = await runMovementAsync({ teamId: teamId as string, movementId, text: 'during a rollout' });
      if (!queued.ok) throw new Error(queued.errors.join('; '));

      expect(await workRows()).toEqual([
        { kind: CARRIED_RUN_WORK_KIND, key: `${CARRIED_RUN_WORK_KIND}:${queued.runId}`, attempts: 0, lease_owner: null, dead_at: null },
      ]);

      // The old drain's claim leaves it exactly as it was: no attempt counted,
      // no lease, no retry to bury it. The press waits, nothing is lost.
      expect(await drain01213Claims(teamId)).toEqual([]);
      expect(await workRows()).toEqual([
        { kind: CARRIED_RUN_WORK_KIND, key: `${CARRIED_RUN_WORK_KIND}:${queued.runId}`, attempts: 0, lease_owner: null, dead_at: null },
      ]);
      expect(await getMovementRunStatus({ teamId: teamId as string, runId: queued.runId })).toMatchObject({ status: 'running' });

      await drainUntilIdle({ owner: 'new-drain', teamId });

      expect(await getMovementRunStatus({ teamId: teamId as string, runId: queued.runId })).toMatchObject({ status: 'success' });
      expect(await workRows()).toEqual([]);
      await getAutomationsQb(['trigger']).deleteFrom('trigger').where('id', '=', triggerId as TriggerId).execute();
    });

    it("the stand-in for 0.12.13's claim does take a row of a kind that release knows", async () => {
      // Without this, the refusal above could pass on a statement that takes
      // nothing at all.
      await sql`
        INSERT INTO automations.work (host, kind, key, team_id, payload, due_at, updated_at)
        VALUES ('platform', 'resume_timer', ${`resume_timer:${randomUUID()}`}, ${teamId}::uuid, '{}'::jsonb, now() - interval '1 minute', now())`.execute(getAutomationsQb(['work']));
      expect(await drain01213Claims(teamId)).toEqual(['resume_timer']);
    });
  });

});
