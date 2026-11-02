// A paused listen as a person sees and resumes it: the loop breaker's pause
// (with what it held) and the loop guard's, read per trigger and both cleared
// by one resume.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

import { getAutomationsQb } from '../../../lib/kysely';
import { setGuardPaused } from '../../loop_guard';
import { hold, setPaused, states } from '../../lf_store/listens';
import { listenPauses, resumeListen } from '../listen_pause';

let teamId: TeamId;

beforeEach(() => {
  teamId = randomUUID() as TeamId;
});

afterEach(async () => {
  await sql`delete from automations.listen_state where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['listen_state']));
  await sql`delete from automations.trigger where team_id = ${teamId}::uuid`.execute(getAutomationsQb(['trigger']));
});

/** A listen's trigger row, keyed by its pipeline. */
async function listenRow(pipeline: string): Promise<TriggerId> {
  const id = randomUUID() as TriggerId;
  await sql`
    insert into automations.trigger (id, team_id, name, kind, config)
    values (${id}::uuid, ${teamId}::uuid, ${`movement/sync/${pipeline}`}::text, 'attio', ${JSON.stringify({ listen: { pipeline } })}::jsonb)`.execute(getAutomationsQb(['trigger']));
  return id;
}

describe('a paused listen', () => {
  it('reads the loop breaker’s pause with what it held, and the loop guard’s, by trigger', async () => {
    const looped = await listenRow('listen:sync.lf:stamp:1');
    const guarded = await listenRow('listen:sync.lf:stamp:2');
    const running = await listenRow('listen:sync.lf:stamp:3');
    await setPaused({ tenant: teamId }, { pipeline: 'listen:sync.lf:stamp:1', paused: 'LISTEN_LOOP: sync.lf:stamp is paused' });
    await hold({ tenant: teamId }, { pipeline: 'listen:sync.lf:stamp:1' });
    await setGuardPaused({ triggerId: guarded, reason: 'ran 60 times in a minute', signal: 'trigger_rate' });

    const pauses = await listenPauses({ teamId, triggerIds: [looped, guarded, running] });
    expect(pauses.get(looped)).toEqual({ reason: 'LISTEN_LOOP: sync.lf:stamp is paused', held: 1 });
    expect(pauses.get(guarded)).toEqual({ reason: 'ran 60 times in a minute', held: 0 });
    expect(pauses.has(running)).toBe(false);
  });

  it('is resumed by one call that clears both pauses, saying what it held', async () => {
    const triggerId = await listenRow('listen:sync.lf:stamp:4');
    await setPaused({ tenant: teamId }, { pipeline: 'listen:sync.lf:stamp:4', paused: 'LISTEN_LOOP: sync.lf:stamp is paused' });
    await hold({ tenant: teamId }, { pipeline: 'listen:sync.lf:stamp:4' });
    await hold({ tenant: teamId }, { pipeline: 'listen:sync.lf:stamp:4' });
    await setGuardPaused({ triggerId, reason: 'ran 60 times in a minute', signal: 'trigger_rate' });

    expect(await resumeListen({ teamId, triggerId, resumedBy: 'test' })).toEqual({ resumed: true, held: 2 });
    expect((await listenPauses({ teamId, triggerIds: [triggerId] })).size).toBe(0);
    expect((await states({ tenant: teamId }, { pipelines: ['listen:sync.lf:stamp:4'] }))['listen:sync.lf:stamp:4']).toMatchObject({ paused: null, held: 0 });
    expect(await resumeListen({ teamId, triggerId, resumedBy: 'test' })).toEqual({ resumed: false, held: 0 });
  });

  it('is another team’s to resume only', async () => {
    const triggerId = await listenRow('listen:sync.lf:stamp:5');
    expect(await resumeListen({ teamId: randomUUID() as TeamId, triggerId, resumedBy: 'test' })).toBeNull();
  });
});
