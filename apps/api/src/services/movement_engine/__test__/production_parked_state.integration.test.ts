// Runs production parked, resumed here. Each fixture holds the rows production's
// own code wrote at 0.12.13 (main at c388d81d; `fixtures/production-0.12.13`, whose
// generator says how), loaded as they stand into this branch's schema: what a
// database holds on deploy day. A fixture this branch's code wrote would prove
// nothing about that day.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'kysely';

import type { AskId } from '../../../generated/kysely/asks/Ask';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAsksQb, getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { answerAskById } from '../../asks/doors';
import { notifyEngineOfSettledAsks } from '../../asks/in_process_notifier';
import { resetAskSettledNotifierForTests } from '../../asks/notifier';
import { drainUntilIdle, resetWorkHandlersForTests } from '../../work/drain';
import { registerCoreWork } from '../../work/register';
import { registerAskClosedSweepWork } from '../../asks/closed_sweep';
import { LANGUAGE_VERSION } from 'movement-lang';

import { failRunAndCancelRequests } from '../../interaction/run_failure';
import { liveDeployCheckDeps } from '../../translation_graph/movement/language_upgrade';
import { getMovementRow } from '../../translation_graph/movement/store';
import { fireCallback } from '../callback_fire';
import { resumeLimitPausedRun } from '../limit_resume';

const FIXTURES = join(__dirname, 'fixtures', 'production-0.12.13');
const TEAM = '00000000-0000-4000-8000-0000000012a1' as TeamId;

interface Fixture {
  runId: string;
  rows: Record<string, Record<string, unknown>[]>;
}

/** Inserted in the order production's foreign keys need. A column this branch
 *  added takes its default; one it dropped would fail here, by name. */
const AUTOMATIONS_TABLES = ['movement', 'movement_version', 'trigger', 'trigger_run', 'parked_run', 'join_pending', 'join_branch_export', 'adapter_await', 'callback', 'park_library_source', 'work'];

async function load(name: string): Promise<Fixture & { runId: TriggerRunId }> {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture;
  const db = getAutomationsQb(['trigger_run']);
  for (const table of AUTOMATIONS_TABLES) {
    for (const row of fixture.rows[table] ?? []) {
      // A movement and its current version name each other: the pointer lands
      // once the version is in.
      const columns = Object.keys(row).filter((column) => !(table === 'movement' && column === 'current_version_id'));
      await sql`
        INSERT INTO ${sql.table(`automations.${table}`)} (${sql.join(columns.map((c) => sql.ref(c)))})
        SELECT ${sql.join(columns.map((c) => sql.ref(c)))}
        FROM jsonb_populate_record(null::${sql.table(`automations.${table}`)}, ${JSON.stringify(row)}::jsonb)
      `.execute(db);
    }
  }
  for (const row of fixture.rows.movement ?? []) {
    await sql`UPDATE automations.movement SET current_version_id = ${String(row.current_version_id)}::uuid WHERE id = ${String(row.id)}::uuid`.execute(db);
  }
  for (const row of fixture.rows.ask ?? []) {
    const columns = Object.keys(row);
    await sql`
      INSERT INTO asks.ask (${sql.join(columns.map((c) => sql.ref(c)))})
      SELECT ${sql.join(columns.map((c) => sql.ref(c)))}
      FROM jsonb_populate_record(null::asks.ask, ${JSON.stringify(row)}::jsonb)
    `.execute(db);
  }
  return { ...fixture, runId: fixture.runId as TriggerRunId };
}

/** The clock moved past every timer the fixture parked on. */
async function timersDue(runId: TriggerRunId): Promise<void> {
  const past = new Date(Date.now() - 1000);
  await getAutomationsQb(['parked_run']).updateTable('parked_run').set({ wake_at: past }).where('run_id', '=', runId).where('park_reason', '=', 'timer').execute();
  await getAutomationsQb(['work']).updateTable('work').set({ due_at: past }).where('team_id', '=', TEAM).where('kind', '=', 'resume_timer').execute();
}

async function runOf(runId: TriggerRunId) {
  return getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select(['status', 'failure_reason']).executeTakeFirstOrThrow();
}

/** What the run asked after its park: the proof it carried on from where it
 *  stopped, with what it had bound before. */
async function asksOfTeam(): Promise<{ prompt: string; state: string }[]> {
  return getAsksQb(['ask']).selectFrom('ask').where('team_id', '=', TEAM).select(['prompt', 'state']).orderBy('created_at').execute();
}

async function drain(): Promise<void> {
  await drainUntilIdle({ teamId: TEAM, heartbeatMs: false });
}

describe('a run production parked', () => {
  beforeAll(async () => {
    resetWorkHandlersForTests();
    registerCoreWork();
    registerAskClosedSweepWork();
    resetAskSettledNotifierForTests();
    notifyEngineOfSettledAsks();
    await getCoreQb(['team'])
      .insertInto('team')
      .values({ id: TEAM, name: 'production fixture' } as never)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  });

  afterEach(async () => {
    await getAsksQb(['ask']).deleteFrom('ask').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['trigger_run']).deleteFrom('trigger_run').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', TEAM).execute();
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', TEAM).execute();
  });

  afterAll(async () => {
    await cleanupTeam(TEAM);
    resetWorkHandlersForTests();
  });

  it('on a timer wakes on its own engine, with what it had bound', async () => {
    const { runId } = await load('timer');
    await timersDue(runId);
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
    expect(await asksOfTeam()).toEqual([{ prompt: 'written before the park: timer', state: 'open' }]);
  });

  it('on an ask carries on when the ask is answered at the platform door', async () => {
    const { runId, rows } = await load('ask');
    const asked = rows.ask?.[0]?.id as AskId;
    expect(await answerAskById(asked, { Budget: '10' })).toMatchObject({ kind: 'answered' });
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
    expect(await asksOfTeam()).toContainEqual({ prompt: 'written before the park: ask', state: 'open' });
    expect(await getAutomationsQb(['adapter_await']).selectFrom('adapter_await').where('run_id', '=', runId).select('id').execute()).toEqual([]);
  });

  it('on a callback runs the body, then the awaiter, and revokes nothing early', async () => {
    const { runId, rows } = await load('callback');
    const id = rows.callback?.[0]?.id as string;
    expect(await fireCallback({ id, values: {} })).toMatchObject({ kind: 'recorded', queued: true });
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
    expect((await asksOfTeam()).map((ask) => ask.prompt).sort()).toEqual(['body', 'written before the park: callback']);
    const callback = await getAutomationsQb(['callback']).selectFrom('callback').where('run_id', '=', runId).select('status').executeTakeFirstOrThrow();
    expect(callback.status).toBe('fired');
    expect(await fireCallback({ id, values: {} })).toMatchObject({ kind: 'closed' });
  });

  it('in a race settles it with the arm that won, and closes the loser', async () => {
    const { runId } = await load('race');
    await timersDue(runId);
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
    const asks = await asksOfTeam();
    expect(asks).toContainEqual({ prompt: 'written before the park: race', state: 'open' });
    expect(asks.find((ask) => ask.prompt === 'Deal?')?.state).not.toBe('open');
  });

  it('with a callback tapped and its body queued by production finishes: the queued rows run here', async () => {
    const { runId, rows } = await load('callback-tapped');
    expect((rows.work ?? []).map((row) => row.kind).sort()).toEqual(['fire_callback', 'wake_await']);
    await getAutomationsQb(['work']).updateTable('work').set({ due_at: new Date(Date.now() - 1000) }).where('team_id', '=', TEAM).execute();
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
    expect((await asksOfTeam()).map((ask) => ask.prompt).sort()).toEqual(['body', 'written before the park: callback']);
  });

  it("with an ask answered and production's wake row queued wakes by that row: it names a key, not a wait", async () => {
    const { runId, rows } = await load('ask-answered');
    const wake = rows.work?.find((row) => row.kind === 'wake_await');
    expect(wake?.payload).toMatchObject({ adapterType: 'ask', correlationKey: rows.ask?.[0]?.id });
    await getAutomationsQb(['work']).updateTable('work').set({ due_at: new Date(Date.now() - 1000) }).where('team_id', '=', TEAM).execute();
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
  });

  it('paused at its cost limit stays paused until resumed, then carries on from the statement it stopped before', async () => {
    const { runId } = await load('limit');
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'parked' });
    expect(await resumeLimitPausedRun(runId)).toEqual({ resumed: 1 });
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
    expect(await asksOfTeam()).toEqual([{ prompt: 'written before the park: limit', state: 'open' }]);
  });

  it('survives the deploy check that stops its automation: the run keeps its row, and wakes', async () => {
    const { runId, rows } = await load('timer');
    const deps = liveDeployCheckDeps({ tag: 'test', language: LANGUAGE_VERSION });
    const movement = await getMovementRow({ teamId: TEAM, id: String(rows.movement?.[0]?.id) });
    if (movement === null) throw new Error('test: no movement');
    await deps.unprovision(movement);
    expect(await runOf(runId)).toMatchObject({ status: 'parked' });
    await timersDue(runId);
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
  });

  it('cancelled closes what stands behind it: its correlation, its ask, its callback', async () => {
    const { runId, rows } = await load('ask');
    await failRunAndCancelRequests({ runId, message: 'stopped' });
    expect(await runOf(runId)).toMatchObject({ status: 'failed', failure_reason: 'stopped' });
    expect(await getAutomationsQb(['adapter_await']).selectFrom('adapter_await').where('run_id', '=', runId).select('id').execute()).toEqual([]);
    const ask = await getAsksQb(['ask']).selectFrom('ask').where('id', '=', rows.ask?.[0]?.id as AskId).select('state').executeTakeFirstOrThrow();
    expect(ask.state).not.toBe('open');
  });

  it('on a legacy 4 timer wakes on the legacy engine', async () => {
    const { runId } = await load('legacy-4-timer');
    await timersDue(runId);
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'success' });
  });

  it('on a legacy 4 ask stays parked, loudly unresumed, rather than being failed: this build has no way to step it', async () => {
    const { runId, rows } = await load('legacy-4-ask');
    await answerAskById(rows.ask?.[0]?.id as AskId, { Budget: '10' });
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'parked' });
  });
});
