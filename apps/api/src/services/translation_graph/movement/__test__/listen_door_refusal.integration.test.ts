// A listen's firing asks the pin's version to fire its listens before
// anything else (real Postgres, real router). A 0.12 automation can still have
// a trigger row (one made before the deploy, one the deploy check has not yet
// removed): an arrival it is judged against is refused with the registry's
// listen text and recorded failed, and runs on no engine, 0.12's included.

import { randomUUID } from 'node:crypto';

import { refusalOf } from '@listen-fire/language-versions';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { loadGuardPausedState } from '../../../loop_guard';
import { resolveAdapter } from '../../adapters/resolve';
import { dispatchTriggerByIdEvent } from '../../triggers/router';
import { mintMovementVersionIfChanged } from '../version_store';
import { runCarriedSegment } from '../carried_run';

jest.mock('../../../loop_guard', () => {
  const actual = jest.requireActual('../../../loop_guard');
  return { ...actual, loadGuardPausedState: jest.fn(actual.loadGuardPausedState) };
});
jest.mock('../../adapters/resolve', () => {
  const actual = jest.requireActual('../../adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn(actual.resolveAdapter) };
});
jest.mock('../carried_run', () => {
  const actual = jest.requireActual('../carried_run');
  return { ...actual, runCarriedSegment: jest.fn(actual.runCarriedSegment) };
});

/** A 0.12 automation with a manual listen, as 0.12 spells it. */
const STAMP_012 = 'function stamp(run: <manual-[:Invocation]->>) {\n  t = run.Text\n  return t\n}\nlisten to manual fire stamp\n';

describe("a listen's firing of a 0.12 automation (real Postgres, real router)", () => {
  let teamId: TeamId;

  beforeAll(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `k5a-listen-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterAll(async () => {
    await cleanupTeam(teamId);
  });

  it('a leftover trigger row is refused with the listen text, recorded failed, and runs on no engine', async () => {
    const movementId = randomUUID();
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      .values({ id: movementId as MovementId, team_id: teamId, name: 'stamp', source: STAMP_012, description: '', language_version: '0.12.13' })
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId, source: STAMP_012, languageVersion: '0.12.13' });
    const triggerId = randomUUID();
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({
        id: triggerId as TriggerId,
        team_id: teamId,
        name: 'movement/stamp/stamp',
        kind: 'manual',
        config: {} as never,
        movement_id: movementId as MovementId,
        fired_movement_name: 'stamp',
        run_mode: 'live',
        provisioned_by_setup_agent: false,
      } as never)
      .execute();
    const event: TriggerEvent = {
      pipelineInputId: `trigger:${triggerId}`,
      adapterType: 'manual',
      triggerType: 'webhook',
      payload: { firedAt: new Date().toISOString(), text: 'hello' },
    };

    const dispatched = await dispatchTriggerByIdEvent({ teamId, triggerId, event });

    // Asked first: nothing was counted, no source adapter built, no sender judged.
    expect(loadGuardPausedState).not.toHaveBeenCalled();
    expect(resolveAdapter).not.toHaveBeenCalled();
    const refusal = refusalOf('0.12.13', 'listen');
    expect(refusal).toMatch(/but not to fire its listens/);
    expect(dispatched.errors).toEqual([{ triggerEntryId: triggerId, message: refusal }]);
    expect(runCarriedSegment).not.toHaveBeenCalled();
    const runs = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .where('trigger_id', '=', triggerId)
      .select(['status', 'failure_reason'])
      .execute();
    expect(runs).toEqual([{ status: 'failed', failure_reason: expect.stringContaining(refusal ?? 'unreachable') }]);
  });
});
