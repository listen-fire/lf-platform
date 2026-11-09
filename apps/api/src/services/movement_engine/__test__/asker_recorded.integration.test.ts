// A question a run raises is told, as it is raised, which run asked it and that
// run's automation: real Postgres, a real saved movement on a manual listen,
// the real drain and engine host. Once the run is done no wait names the
// question, so what the host recorded is how the question's automation is
// still known (`services/access/whose.ts`).

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { getAsksQb, getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { saveMovement } from '../../translation_graph/movement/provision';
import { getMovementRunStatus, runMovementAsync } from '../../translation_graph/movement/run_now';
import { registerFireEventWork } from '../../inbound/fire_event';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { Whose } from '../../access/whose';

jest.mock('../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

const SOURCE = `qa = connect \`@lf/ask\`

function asked(go: <manual-[:Invocations]->>) {
  q = write qa-[:Check]-> { Prompt: "Close the deal?" }
}

listen to manual-[:Invocations]-> fire asked
`;

describe('a question a run raises names the run that asked it', () => {
  let teamId: TeamId;

  beforeAll(async () => {
    resetWorkHandlersForTests();
    registerFireEventWork();
    setWorkNotifier({ notify() {} });
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `asker-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterAll(async () => {
    setWorkNotifier(inProcessNotifier);
    resetWorkHandlersForTests();
    await cleanupTeam(teamId);
  });

  it('records the run and its automation on the question, so it stays the automation’s once the run is done', async () => {
    const saved = await saveMovement({ teamId: teamId as string, source: SOURCE, name: 'asker-probe' });
    if (!saved.ok) throw new Error(`test: the probe movement did not save: ${JSON.stringify(saved)}`);
    const queued = await runMovementAsync({ teamId: teamId as string, movementId: saved.movementId, text: 'go' });
    if (!queued.ok) throw new Error(queued.errors.join('; '));
    await drainUntilIdle({ owner: 'test', teamId });
    expect(await getMovementRunStatus({ teamId: teamId as string, runId: queued.runId })).toMatchObject({ status: 'success' });

    const ask = await getAsksQb(['ask']).selectFrom('ask').where('team_id', '=', teamId).select(['id', 'provenance']).executeTakeFirstOrThrow();
    expect(ask.provenance).toEqual({ adapterType: 'manual', runId: queued.runId, movementId: saved.movementId });
    const waits = await getAutomationsQb(['wait_row']).selectFrom('wait_row').where('run_id', '=', queued.runId as TriggerRunId).select('key').execute();
    expect(waits).toEqual([]);
    expect(await Whose.automationOfAsk({ askId: String(ask.id), teamIds: [teamId] })).toEqual({ teamId, automationId: saved.movementId });
  });
});
