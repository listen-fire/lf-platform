// A closed ask reaches the run waiting on it, against a real DB.
//
// An answer and a cancel each deliver the ask's `Response` arrival at their
// door. The ask service's periodic closed sweep is the safety net behind both:
// it delivers each closed ask again, and the arrival's identity keeps a second
// delivery from waking anything twice. An answer wakes the wait: a
// `wake_await` row, then drain, then the run re-enters its await, which reads
// the wait's arrivals. A cancel reports the ask gone: the wait is stranded
// and its run is told so (`Wait Lost Its Record`), never woken empty. Only the
// engine step itself is stubbed, so the test can see what the re-entered
// await read. Store-level transitions stand in for a door whose delivery was
// lost.

import { randomUUID } from 'node:crypto';

const resumeMovementFiringMock = jest.fn();
jest.mock('../../translation_graph/movement/execute', () => ({
  ...jest.requireActual('../../translation_graph/movement/execute'),
  resumeMovementFiring: (input: unknown) => resumeMovementFiringMock(input),
}));

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { testWorkContext } from '../../../test/harness/work';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { getAsksQb, getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { TriggerRunRecorder } from '../../translation_graph/runs/trigger_run';
import { registerAwaitWork } from '../../movement_engine/await_resume';
import { makeRecorderParks } from '../../movement_engine/park_sink';
import { drainUntilIdle, inProcessNotifier, resetWorkHandlersForTests, setWorkNotifier } from '../../work/drain';
import { askClosedSweepHandler, registerAskClosedSweepWork } from '../closed_sweep';
import { answerAskByToken, cancelAskAndWake, createAsk } from '../doors';
import { notifyEngineOfSettledAsks } from '../in_process_notifier';
import { resetAskSettledNotifierForTests } from '../notifier';
import { ASK_ADAPTER_TYPE, ASK_TOKEN_PREFIX, answerAsk, cancelAsk } from '@listen-fire/ask';
import { getAsk, platformAskRecords, type AskRecord } from '../store';
import type { ListedArrival } from 'movement-engine/public/run-host';
import { postgresRunHostStore } from '../../movement_engine/run_host_store';

const SOURCE = 'go = manual()';
const ADDRESS = 'await-ask';

let teamId: TeamId;
let triggerId: TriggerId;
let movementVersionId: string;

beforeAll(async () => {
  resetWorkHandlersForTests();
  registerAwaitWork();
  registerAskClosedSweepWork();
  // The test drains explicitly.
  setWorkNotifier({ notify() {} });

  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `ask-expiry-${teamId.slice(0, 8)}` } as any)
    .execute();
  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: movementId, team_id: teamId, name: 'ask_then_wait', source: SOURCE } as any)
    .execute();
  movementVersionId = randomUUID();
  await getAutomationsQb(['movement_version'])
    .insertInto('movement_version')
    .values({
      id: movementVersionId,
      movement_id: movementId,
      team_id: teamId,
      version_number: 1,
      source: SOURCE,
      content_hash: 'ask-expiry-fixture',
      language_version: LANGUAGE_VERSION,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .execute();
  triggerId = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    .values({
      id: triggerId,
      team_id: teamId,
      name: 'Ask then wait',
      kind: 'webhook',
      movement_id: movementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    .execute();
});

afterAll(async () => {
  resetAskSettledNotifierForTests();
  setWorkNotifier(inProcessNotifier);
  resetWorkHandlersForTests();
  await cleanupTeam(teamId);
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

beforeEach(async () => {
  resumeMovementFiringMock.mockReset();
  // The team is shared across cases; each starts with an empty queue.
  await getAutomationsQb(['work']).deleteFrom('work').where('team_id', '=', teamId).execute();
});

/** A live run parked on a wait for an open ask's response, exactly as
 *  `commitAwaitPark` leaves it.
 *  `raise` makes the ask: through the module by default. */
async function runParkedOnAsk(
  raise: (runId: TriggerRunId) => Promise<AskRecord> = (runId) =>
    createAsk({ teamId, family: 'Check', prompt: 'Ship it?', provenance: { runId } }),
): Promise<{ runId: TriggerRunId; ask: AskRecord; waitId: string }> {
  const recorder = new TriggerRunRecorder({
    teamId,
    triggerId,
    triggerType: 'webhook',
    triggerEvent: {
      pipelineInputId: 'trigger:ask-expiry',
      adapterType: 'webhook',
      triggerType: 'webhook',
      payload: {},
    } as TriggerEvent,
    movementVersionId,
  });
  await recorder.ensureStarted();
  const runId = recorder.triggerRunId;
  const ask = await raise(runId);
  const since = await postgresRunHostStore.waits.mark();
  const { waitId } = await postgresRunHostStore.waits.open({
    runId, teamId, adapterType: ASK_ADAPTER_TYPE, edge: 'Response', key: ask.id, recordId: ask.id, since,
  });
  await makeRecorderParks(recorder).sink.commitAwaitPark({
    address: ADDRESS,
    state: { version: 3, address: ADDRESS, bindingName: null, scopeChain: [{ bindings: {} }] },
    waitId,
  });
  return { runId, ask, waitId };
}

/** Whether the run's wait was stranded (its record reported gone). */
async function stranded(runId: TriggerRunId): Promise<unknown[]> {
  return (await postgresRunHostStore.waits.stranded({ runId })).map(({ edge, key }) => ({ edge, key }));
}

async function wakeRows(): Promise<unknown[]> {
  const rows = await getAutomationsQb(['work'])
    .selectFrom('work')
    .where('team_id', '=', teamId)
    .where('kind', '=', 'wake_await')
    .select('payload')
    .execute();
  return rows.map((row) => row.payload);
}

async function sweep(): Promise<void> {
  await askClosedSweepHandler.run({}, testWorkContext());
}

/** The re-entered await: read the wait's arrivals, as the engine's await
 *  does, and complete the branch. */
function awaitReadsTheWait(waitId: string, seen: ListedArrival[][]): void {
  resumeMovementFiringMock.mockImplementation(async () => {
    seen.push((await postgresRunHostStore.waits.arrivals({ waitId })).arrivals);
    return { result: { parked: false } };
  });
}

describe('a closed ask reaches the run waiting on it', () => {
  it('an expired ask: the sweep reports it gone, which strands the wait and wakes nothing', async () => {
    const { runId, ask } = await runParkedOnAsk();

    // Still open: nothing delivered.
    await sweep();
    expect(await wakeRows()).toEqual([]);
    expect(await stranded(runId)).toEqual([]);

    await cancelAsk(platformAskRecords(teamId), { id: ask.id });
    await sweep();
    await sweep();
    await drainUntilIdle({ owner: 'test', teamId });
    expect(await wakeRows()).toEqual([]);
    expect(resumeMovementFiringMock).not.toHaveBeenCalled();
    expect(await stranded(runId)).toEqual([{ edge: 'Response', key: ask.id }]);
  });

  it('an answered ask whose delivery was lost (no notifier) wakes its wait exactly once', async () => {
    const { runId, ask, waitId } = await runParkedOnAsk();
    const seen: ListedArrival[][] = [];
    awaitReadsTheWait(waitId, seen);
    // The bare lattice transition, without the door's notifier: the arrival an
    // answer would have delivered never was.
    expect((await answerAsk(platformAskRecords(teamId), { id: ask.id, raw: 'true' })).kind).toBe('settled');
    expect(await wakeRows()).toEqual([]);

    await sweep();
    await sweep();
    expect(await wakeRows()).toEqual([{ waitId, runId, address: ADDRESS }]);

    await drainUntilIdle({ owner: 'test', teamId });
    expect(resumeMovementFiringMock).toHaveBeenCalledTimes(1);
    expect(resumeMovementFiringMock).toHaveBeenCalledWith(expect.objectContaining({ runId, reenter: true }));
    expect(seen).toEqual([[expect.objectContaining({ landing: expect.objectContaining({ recordId: ask.id }) })]]);
    expect(await wakeRows()).toEqual([]);

    // A later sweep delivers the same answer again: kept once, it wakes nothing.
    await sweep();
    expect(await wakeRows()).toEqual([]);
  });

  it('the cancel door reports the ask gone itself, before any sweep', async () => {
    // The composed deployment's wiring: the engine is here to be told.
    notifyEngineOfSettledAsks();
    const { runId, ask } = await runParkedOnAsk();

    expect((await cancelAskAndWake({ id: ask.id })).ok).toBe(true);
    expect(await wakeRows()).toEqual([]);
    expect(await stranded(runId)).toEqual([{ edge: 'Response', key: ask.id }]);
  });

  it('a run parked before ask was a module: the link-page answer wakes it, and the await lands', async () => {
    notifyEngineOfSettledAsks();
    // The ask row exactly as the built-in ask store wrote it (the table mints
    // the id; the token is the old store's shape).
    const { runId, ask, waitId } = await runParkedOnAsk(async (parkedRunId) => {
      const row = await getAsksQb(['ask'])
        .insertInto('ask')
        .values({
          team_id: teamId,
          family: 'Check',
          prompt: 'Ship it?',
          token: ASK_TOKEN_PREFIX + randomUUID().replace(/-/g, ''),
          token_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          provenance: JSON.stringify({ runId: parkedRunId }) as never,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const raised = await getAsk(row.id);
      if (raised === null) throw new Error('the old-shape ask row did not read back');
      return raised;
    });
    const seen: ListedArrival[][] = [];
    awaitReadsTheWait(waitId, seen);

    expect(await answerAskByToken(ask.token, 'true')).toMatchObject({ kind: 'answered' });
    expect(await wakeRows()).toEqual([{ waitId, runId, address: ADDRESS }]);

    await drainUntilIdle({ owner: 'test', teamId });
    expect(resumeMovementFiringMock).toHaveBeenCalledWith(expect.objectContaining({ runId, reenter: true }));
    expect(seen).toEqual([[expect.objectContaining({ landing: expect.objectContaining({ recordId: ask.id }) })]]);
  });
});
