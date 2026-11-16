// Runs production parked on a legacy id, met here. Each fixture holds the rows
// production's own code wrote at 0.12.13 (main at c388d81d;
// `fixtures/production-0.12.13`, whose generator says how), loaded as they stand
// into this branch's schema: what a database holds on deploy day. A fixture this
// branch's code wrote would prove nothing about that day. The 0.12 runs beside
// them are the deploy check's to refuse (scripts/deploy_check.ts): no engine
// here steps them.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import express from 'express';
import { sql } from 'kysely';

import type { AskId } from '../../../generated/kysely/asks/Ask';
import type { CallbackId } from '../../../generated/kysely/automations/Callback';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAsksQb, getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { captureEngineLogs } from '../../../test/engine_logs';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { answerAskById } from '../../asks/doors';
import { notifyEngineOfSettledAsks } from '../../asks/in_process_notifier';
import { resetAskSettledNotifierForTests } from '../../asks/notifier';
import { drainUntilIdle, resetWorkHandlersForTests } from '../../work/drain';
import { registerCoreWork } from '../../work/register';
import { askClosedSweepHandler, registerAskClosedSweepWork } from '../../asks/closed_sweep';
import { callbacksRouter } from '../../../interfaces/rest/callbacks';
import { RETIRED_CALLBACK_TEXT } from '../../interaction/retired_callback';

const FIXTURES = join(__dirname, 'fixtures', 'production-0.12.13');
const TEAM = '00000000-0000-4000-8000-0000000012a1' as TeamId;

interface Fixture {
  runId: string;
  rows: Record<string, Record<string, unknown>[]>;
}

/** Inserted in the order production's foreign keys need. A column this branch
 *  added takes its default; one it dropped would fail here, by name. */
const AUTOMATIONS_TABLES = ['movement', 'movement_version', 'trigger', 'trigger_run', 'parked_run', 'join_pending', 'join_branch_export', 'adapter_await', 'callback', 'park_library_source', 'work'];

async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  // A movement and its current version name each other: the pointer lands once
  // the version is in.
  const columns = Object.keys(row).filter((column) => !(table === 'movement' && column === 'current_version_id'));
  await sql`
    INSERT INTO ${sql.table(`automations.${table}`)} (${sql.join(columns.map((c) => sql.ref(c)))})
    SELECT ${sql.join(columns.map((c) => sql.ref(c)))}
    FROM jsonb_populate_record(null::${sql.table(`automations.${table}`)}, ${JSON.stringify(row)}::jsonb)
  `.execute(getAutomationsQb(['trigger_run']));
}

async function load(name: string): Promise<Fixture & { runId: TriggerRunId }> {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture;
  const db = getAutomationsQb(['trigger_run']);
  for (const table of AUTOMATIONS_TABLES) {
    for (const row of fixture.rows[table] ?? []) await insertRow(table, row);
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

  it('on a legacy 4 timer fails when it wakes, saying why: this release carries no engine for it', async () => {
    const { runId } = await load('legacy-4-timer');
    await timersDue(runId);
    await drain();
    expect(await runOf(runId)).toMatchObject({ status: 'failed', failure_reason: expect.stringContaining('carries no engine for versions 1 to 4') });
  });

  describe('on a legacy 4 question stays parked: nothing here can step it', () => {
    const logs = captureEngineLogs();
    const correlationsOf = (runId: TriggerRunId) => getAutomationsQb(['adapter_await']).selectFrom('adapter_await').where('run_id', '=', runId).select('id').execute();
    const wakeKeys = async () => (await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', TEAM).where('kind', '=', 'wake_await').select('key').execute()).map((row) => row.key);
    const errorsAbout = (runId: string) => logs.error().filter((line) => JSON.stringify(line).includes(runId));

    it('an answer and the closed sweep queue no wake for it', async () => {
      const legacy = await load('legacy-4-ask');
      expect(await answerAskById(legacy.rows.ask?.[0]?.id as AskId, { Budget: '10' })).toMatchObject({ kind: 'held' });
      expect(await wakeKeys()).toEqual([]);
      await askClosedSweepHandler.run({}, { now: new Date() } as never);
      expect(await wakeKeys()).toEqual([]);
      await drain();
      expect(await runOf(legacy.runId)).toMatchObject({ status: 'parked', failure_reason: null });
      expect(await correlationsOf(legacy.runId)).toHaveLength(1);
      expect(errorsAbout(legacy.runId)).toEqual([]);
    });

    it("production's own wake row is consumed once, says so, and leaves the run and its correlation standing", async () => {
      const { runId, rows } = await load('legacy-4-ask');
      const asked = rows.ask?.[0]?.id as AskId;
      await answerAskById(asked, { Budget: '10' });
      await insertRow('work', { kind: 'wake_await', key: `wake_await:${asked}`, team_id: TEAM, due_at: new Date(Date.now() - 1000).toISOString(), payload: { adapterType: 'ask', teamId: TEAM, correlationKey: asked } });
      expect(await wakeKeys()).toEqual([`wake_await:${asked}`]);
      await drain();
      expect(await wakeKeys()).toEqual([]);
      // No version this platform carries parks on keys, so it is dropped, with a warning naming it.
      expect(logs.warn().filter((line) => JSON.stringify(line).includes(asked))).toHaveLength(1);
      expect(await runOf(runId)).toMatchObject({ status: 'parked', failure_reason: null });
      expect(await correlationsOf(runId)).toHaveLength(1);
    });

    it("a tap on its callback at the link's door says the button was retired: the call is not spent and nothing is queued", async () => {
      const { runId } = await load('legacy-4-ask');
      const minted = (JSON.parse(readFileSync(join(FIXTURES, 'callback.json'), 'utf8')) as Fixture).rows.callback?.[0];
      await insertRow('callback', { ...minted, run_id: runId });
      const id = String(minted?.id);
      const app = express();
      app.use('/api/cb', callbacksRouter);
      const server = createServer(app);
      await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('the door has no port');
        const res = await fetch(`http://127.0.0.1:${address.port}/api/cb/${encodeURIComponent(id)}`, { method: 'POST', headers: { accept: 'application/json' } });
        expect(res.status).toBe(410);
        expect(await res.json()).toEqual({ outcome: 'retired', message: RETIRED_CALLBACK_TEXT });
      } finally {
        await new Promise((closed) => server.close(closed));
      }
      expect(await getAutomationsQb(['work']).selectFrom('work').where('team_id', '=', TEAM).select('kind').execute()).toEqual([]);
      const callback = await getAutomationsQb(['callback']).selectFrom('callback').where('id', '=', id as CallbackId).select(['status', 'calls']).executeTakeFirstOrThrow();
      expect(callback).toEqual({ status: 'live', calls: [] });
      expect(await runOf(runId)).toMatchObject({ status: 'parked', failure_reason: null });
    });
  });
});
