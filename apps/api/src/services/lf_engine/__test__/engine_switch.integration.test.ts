// The engine switch (real DB, the real router and engine): for one team,
// exactly one of "the movements slot serves its movements" and "the platform's
// dispatch runs its listeners" holds, and LF_ENGINE_TEAMS decides which. An
// explicit dry run (the editor's test run) still dispatches on the platform.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { saveMovement } from '../../translation_graph/movement/provision';
import { MANUAL_ADAPTER_TYPE } from '../../translation_graph/adapters/manual';
import { dispatchTriggerByIdEvent } from '../../translation_graph/triggers/router';
import { storeTriggerEvent } from '../../translation_graph/triggers/event_store';
import { describeDroppedReason } from '../../translation_graph/triggers/dropped_reason';
import { answerFor } from '../../lf_movements/answer';

jest.mock('../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

const SOURCE = `import { manual } from adapters

runs = connect manual

function hello(go: <runs-[:\`Invocation\`]->>) {
}

listen to runs {} fire hello
`;

const savedEngineTeams = process.env.LF_ENGINE_TEAMS;
let teamId: TeamId;
let triggerId: TriggerId;

function manualEvent(): TriggerEvent {
  const firedAt = new Date().toISOString();
  return {
    pipelineInputId: `trigger:${triggerId}`,
    adapterType: MANUAL_ADAPTER_TYPE,
    triggerType: 'webhook',
    payload: { firedAt, submissionId: randomUUID() },
    occurredAt: firedAt,
  };
}

const runCount = async () =>
  (await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('trigger_id', '=', triggerId).select('id').execute()).length;

/** Whether the slot serves this team's movement (a refusal is "no"). */
async function slotServes(): Promise<boolean> {
  try {
    const listed = (await answerFor({ tenant: teamId })('movements.list', {}, {})) as Array<{ path: string }>;
    return listed.some((file) => file.path === 'hello.mvt');
  } catch {
    return false;
  }
}

/** Whether a live dispatch ran the listener, and what it answered. */
async function dispatchRuns(): Promise<{ ran: boolean; droppedReason: string | undefined; receipt: { status: string; failure_reason: string | null } }> {
  const before = await runCount();
  const event = manualEvent();
  const stored = await storeTriggerEvent({ teamId, triggerId, event });
  const outcome = await dispatchTriggerByIdEvent({ triggerId, teamId, event, storedEventId: stored.id });
  const receipt = await getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('id', '=', stored.id)
    .select(['status', 'failure_reason'])
    .executeTakeFirstOrThrow();
  return { ran: (await runCount()) > before, droppedReason: outcome.droppedReason, receipt };
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `engine-switch-${teamId.slice(0, 8)}` } as any)
    .execute();
  const saved = await saveMovement({ teamId, source: SOURCE, name: 'hello' });
  if (!saved.ok) throw new Error(`test: the probe movement did not save: ${JSON.stringify(saved)}`);
  const trigger = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', '=', saved.movementId as MovementId)
    .select('id')
    .executeTakeFirstOrThrow();
  triggerId = trigger.id as TriggerId;
});

afterEach(() => {
  if (savedEngineTeams === undefined) delete process.env.LF_ENGINE_TEAMS;
  else process.env.LF_ENGINE_TEAMS = savedEngineTeams;
});

afterAll(async () => {
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe('the engine switch', () => {
  it("the platform's dispatch and the movements slot are never both on for one team", async () => {
    delete process.env.LF_ENGINE_TEAMS;
    const servesUnset = await slotServes();
    const unset = await dispatchRuns();
    expect(servesUnset).toBe(false);
    expect(unset.ran).toBe(true);
    expect(unset.droppedReason).toBeUndefined();
    expect(servesUnset !== unset.ran).toBe(true);

    process.env.LF_ENGINE_TEAMS = teamId;
    const servesSet = await slotServes();
    const set = await dispatchRuns();
    expect(servesSet).toBe(true);
    expect(set.ran).toBe(false);
    expect(set.droppedReason).toBe('engine_lf');
    expect(set.receipt).toEqual({ status: 'suppressed', failure_reason: describeDroppedReason('engine_lf') });
    expect(servesSet !== set.ran).toBe(true);
  });

  it('an explicit dry run still dispatches on the platform for an lf-engined team', async () => {
    process.env.LF_ENGINE_TEAMS = teamId;
    const outcome = await dispatchTriggerByIdEvent({ triggerId, teamId, event: manualEvent(), dryRun: true });
    expect(outcome.droppedReason).toBeUndefined();
    expect(outcome.movementFirings).toEqual([expect.objectContaining({ movementName: 'hello', dryRun: true })]);
  });
});
