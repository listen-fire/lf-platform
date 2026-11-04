// A new 0.12 run pausing and resuming on 0.12's own engine: a Run now queued as
// its `run_carried` row (real Postgres, the real drain, 0.12's real run host),
// paused on a timer, an ask and a callback, then resumed by the same work rows a
// production-parked run wakes by. No trigger row exists for it: the run fired
// through its movement, and a resume reads what it fires from the program.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type { AskId } from '../../../../generated/kysely/asks/Ask';

import { getAsksQb, getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { answerAskById } from '../../../asks/doors';
import { notifyEngineOfSettledAsks } from '../../../asks/in_process_notifier';
import { resetAskSettledNotifierForTests } from '../../../asks/notifier';
import { fireCallback } from '../../../movement_engine/callback_fire';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../../work/drain';
import { registerCoreWork } from '../../../work/register';
import { runMovementAsync } from '../run_now';
import { mintMovementVersionIfChanged } from '../version_store';

const ASK = 'import { `@lf/ask` as ask } from adapters\nqa = connect ask\n';
const AFTER = (t: string) => `  n = write qa-[:Form]-> { Prompt: ${t}, Fields: ["after"] }\n  return n\n}\nlisten to manual fire go\n`;
const HEAD = 'function go(run: <manual-[:Invocation]->>) {\n  t = run.Text\n';

const PROGRAMS = {
  timer: `${ASK}${HEAD}  await sleep(1h)\n${AFTER('t')}`,
  ask: `${ASK}${HEAD}  q = write qa-[:Form]-> { Prompt: "Deal?", Fields: ["Budget"] }\n  a = await first(q-[:Response]->)\n${AFTER('t')}`,
  callback: `${ASK}${HEAD}  cb = callback({\n    write qa-[:Form]-> { Prompt: "body", Fields: ["body"] }\n  })\n  c = await first(cb-[:Called]->)\n${AFTER('t')}`,
};

describe('a 0.12 Run now that pauses', () => {
  let teamId: TeamId;

  beforeAll(async () => {
    resetWorkHandlersForTests();
    registerCoreWork();
    setWorkNotifier({ notify() {} });
    resetAskSettledNotifierForTests();
    notifyEngineOfSettledAsks();
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `k5b-${teamId.slice(0, 8)}` } as never).execute();
  });

  afterAll(async () => {
    setWorkNotifier(inProcessNotifier);
    resetWorkHandlersForTests();
    await cleanupTeam(teamId);
  });

  async function pressed(name: keyof typeof PROGRAMS): Promise<TriggerRunId> {
    const movementId = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: movementId as MovementId, team_id: teamId, name: `pause_${name}`, source: PROGRAMS[name], description: '', language_version: '0.12.13' } as never)
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId, source: PROGRAMS[name], languageVersion: '0.12.13' });
    const queued = await runMovementAsync({ teamId, movementId, text: `pressed: ${name}` });
    if (!queued.ok) throw new Error(queued.errors.join('; '));
    await drainUntilIdle({ teamId, heartbeatMs: false });
    return queued.runId as TriggerRunId;
  }

  const status = (runId: TriggerRunId) =>
    getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select(['status', 'failure_reason']).executeTakeFirstOrThrow();
  /** Every write the team's asks hold, sorted: exact, so a write done twice fails. */
  const asked = async () => (await getAsksQb(['ask']).selectFrom('ask').where('team_id', '=', teamId).select('prompt').execute()).map((row) => row.prompt).sort();

  afterEach(async () => {
    await getAsksQb(['ask']).deleteFrom('ask').where('team_id', '=', teamId).execute();
  });

  it('on a timer parks, and wakes on 0.12 with what it had bound', async () => {
    const runId = await pressed('timer');
    expect(await status(runId)).toMatchObject({ status: 'parked', failure_reason: null });
    const past = new Date(Date.now() - 1000);
    await getAutomationsQb(['parked_run']).updateTable('parked_run').set({ wake_at: past }).where('run_id', '=', runId).execute();
    await getAutomationsQb(['work']).updateTable('work').set({ due_at: past }).where('team_id', '=', teamId).where('kind', '=', 'resume_timer').execute();
    await drainUntilIdle({ teamId, heartbeatMs: false });
    expect(await status(runId)).toMatchObject({ status: 'success' });
    expect(await asked()).toEqual(['pressed: timer']);
    const { engine } = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('id', '=', runId).select('engine').executeTakeFirstOrThrow();
    expect(engine).toBe('rust');
  });

  it('on an ask parks on its key, and an answer at the platform door wakes it', async () => {
    const runId = await pressed('ask');
    expect(await status(runId)).toMatchObject({ status: 'parked' });
    const ask = await getAsksQb(['ask']).selectFrom('ask').where('team_id', '=', teamId).where('prompt', '=', 'Deal?').select('id').executeTakeFirstOrThrow();
    expect(await answerAskById(ask.id as AskId, { Budget: '10' })).toMatchObject({ kind: 'answered' });
    await drainUntilIdle({ teamId, heartbeatMs: false });
    expect(await status(runId)).toMatchObject({ status: 'success' });
    expect(await asked()).toEqual(['Deal?', 'pressed: ask']);
  });

  it('on a callback parks, and a call runs its body and then the awaiter', async () => {
    const runId = await pressed('callback');
    expect(await status(runId)).toMatchObject({ status: 'parked' });
    const callback = await getAutomationsQb(['callback']).selectFrom('callback').where('run_id', '=', runId).select('id').executeTakeFirstOrThrow();
    expect(await fireCallback({ id: callback.id, values: {} })).toMatchObject({ kind: 'recorded' });
    await drainUntilIdle({ teamId, heartbeatMs: false });
    expect(await status(runId)).toMatchObject({ status: 'success' });
    expect(await asked()).toEqual(['body', 'pressed: callback']);
  });
});
