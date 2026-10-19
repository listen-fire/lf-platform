// runMovementNow — "Run now" as a manual-channel event injection. The
// dispatch seam (`dispatchTriggerByIdEvent`) and the store reads are
// mocked; the REAL manual-listener gate (manualListenerMovements over the
// saved source) and result projection run. Covered:
//
//   1. injects a manual invocation event on the listener's derived
//      trigger row through normal dispatch (uniform trigger_run), with
//      the initiating actor on the payload, and projects the firing
//   2. a paused listener (run_mode off) is ok:false naming the pause
//   3. no movement / no manual listener / no derived row → ok:false with
//      actionable errors
//   4. a dispatch failure surfaces as ok:false with the message (never
//      thrown)

// Order-sensitive cycle guard (mirrors save.unit.test.ts): pre-require
// schemas.ts so `expressionSchema` resolves before ../types pulls it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

jest.mock('../store', () => ({
  getMovementRow: jest.fn(),
  listDerivedTriggerRows: jest.fn(),
}));

jest.mock('../../triggers/router', () => ({
  dispatchTriggerByIdEvent: jest.fn(),
}));

jest.mock('../../../../adapters/registry', () => ({
  services: { document: { upload: jest.fn() } },
}));

// Async-path collaborators: the trigger/movement resolution, the queue that
// records the run and its work row (its id is what async returns), and the qb.
// The queue itself runs for real in queued_run_doors.integration.test.ts.
jest.mock('../../storage/tg_table', () => ({ loadTriggerById: jest.fn() }));
jest.mock('../execute', () => ({ movementForTrigger: jest.fn() }));
jest.mock('../../triggers/dispatch_event', () => ({ queueRun: jest.fn() }));
jest.mock('../../runs/trigger_run', () => ({
  reportedFailureReason: jest.requireActual('../../runs/trigger_run').reportedFailureReason,
}));
jest.mock('../../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));
jest.mock('../../../../lib/errors', () => ({ handleError: jest.fn() }));
// The per-run cost rollup is its own unit (llm_usage_run_cost.unit.test.ts) —
// stubbed here so this file doesn't also need a `getQb`/`llm_usage` double.
jest.mock('../../../../lib/llm_usage', () => ({
  runCostSummaries: jest.fn(async () => new Map()),
  costMicrodollarsToUsd: jest.fn((microdollars: number) => Math.round(microdollars / 100) / 10000),
}));

import { runMovementNow, runMovementAsync, getMovementRunStatus } from '../run_now';

const { loadTriggerById } = jest.requireMock('../../storage/tg_table') as {
  loadTriggerById: jest.Mock;
};
const { movementForTrigger } = jest.requireMock('../execute') as {
  movementForTrigger: jest.Mock;
};
const { queueRun } = jest.requireMock('../../triggers/dispatch_event') as {
  queueRun: jest.Mock;
};
const { getAutomationsQb } = jest.requireMock('../../../../lib/kysely') as {
  getAutomationsQb: jest.Mock;
};
const { runCostSummaries } = jest.requireMock('../../../../lib/llm_usage') as {
  runCostSummaries: jest.Mock;
};

const RUN_ID = 'run-async-1';

/** Chainable qb stub: every builder method returns `this`; terminals resolve. */
function makeQbStub(row: unknown) {
  const builder: Record<string, jest.Mock> = {};
  for (const m of [
    'selectFrom',
    'updateTable',
    'set',
    'where',
    'select',
  ]) {
    builder[m] = jest.fn(() => builder);
  }
  builder.execute = jest.fn(async () => []);
  builder.executeTakeFirst = jest.fn(async () => row);
  return builder;
}

const { services } = jest.requireMock('../../../../adapters/registry') as {
  services: { document: { upload: jest.Mock } };
};

const { getMovementRow, listDerivedTriggerRows } = jest.requireMock('../store') as {
  getMovementRow: jest.Mock;
  listDerivedTriggerRows: jest.Mock;
};
const { dispatchTriggerByIdEvent } = jest.requireMock('../../triggers/router') as {
  dispatchTriggerByIdEvent: jest.Mock;
};

const TEAM = 'team-1';
const MOVEMENT_ID = 'mov-row-1';
const TRIGGER_ID = 'trigger-manual-1';

const LIVE_SOURCE = `import { manual, attio, kg } from adapters
import { acme_main } from credentials

crm = attio(credentials: acme_main)

runs = manual()
graph = kg()
movement backfill(go: <runs-[:Invocation]->>) {
  crm-[c:companies]-> {
    write graph-[:company]-> { unique by (\`name\`), name: c.\`name\` }
  }
}

listen to runs {} fire backfill
`;

beforeEach(() => {
  jest.clearAllMocks();
  getMovementRow.mockResolvedValue({
    id: MOVEMENT_ID,
    teamId: TEAM,
    name: 'backfill',
    source: LIVE_SOURCE,
  });
  listDerivedTriggerRows.mockResolvedValue([
    {
      id: TRIGGER_ID,
      name: 'movement/backfill/backfill',
      kind: 'manual',
      config: {},
      credentialsId: null,
      runMode: 'live',
    },
  ]);
  dispatchTriggerByIdEvent.mockResolvedValue({
    evaluations: [],
    movementFirings: [{ movementName: 'backfill', writes: 3, dryRun: false }],
  });
  services.document.upload.mockResolvedValue({ objectUri: 'doc://uploaded' });

  // Async-path defaults.
  loadTriggerById.mockResolvedValue({ id: TRIGGER_ID, movementId: MOVEMENT_ID });
  movementForTrigger.mockResolvedValue({
    id: MOVEMENT_ID,
    name: 'backfill',
    currentVersionId: 'ver-1',
  });
  queueRun.mockResolvedValue({ runId: RUN_ID, duplicate: false });
  getAutomationsQb.mockImplementation(() => makeQbStub(null));
});

describe('runMovementNow', () => {
  it('injects a manual invocation event through normal dispatch and projects the firing', async () => {
    const result = await runMovementNow({
      teamId: TEAM,
      movementId: MOVEMENT_ID,
      actor: { email: 'ada@example.com', name: 'Ada' },
    });

    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerId: TRIGGER_ID,
        teamId: TEAM,
        event: expect.objectContaining({
          adapterType: 'manual',
          triggerType: 'webhook',
          payload: expect.objectContaining({
            actorEmail: 'ada@example.com',
            actorName: 'Ada',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      movementName: 'backfill',
      dryRun: false,
      recordCount: 3,
      errors: [],
    });
  });

  it('a rehearsing listener reports dryRun from the firing', async () => {
    dispatchTriggerByIdEvent.mockResolvedValue({
      evaluations: [],
      movementFirings: [{ movementName: 'backfill', writes: 2, dryRun: true }],
    });
    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result).toMatchObject({ ok: true, dryRun: true, recordCount: 2 });
  });

  it('a paused listener (run_mode off) is ok:false naming the pause', async () => {
    dispatchTriggerByIdEvent.mockResolvedValue({
      evaluations: [],
      droppedReason: 'run_mode_off',
    });
    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('paused');
  });

  it('every gate drop is named, never a raw sentinel', async () => {
    dispatchTriggerByIdEvent.mockResolvedValue({
      evaluations: [],
      droppedReason: 'echo_suppressed',
    });
    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).not.toContain('echo_suppressed');
    expect(result.errors[0]).toContain('echo');
  });

  it('a missing movement is an ok:false error', async () => {
    getMovementRow.mockResolvedValue(null);
    const result = await runMovementNow({ teamId: TEAM, movementId: 'ghost' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('not found');
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });

  it('a source without a manual listener is ok:false naming the fix', async () => {
    getMovementRow.mockResolvedValue({
      id: MOVEMENT_ID,
      teamId: TEAM,
      name: 'backfill',
      source: LIVE_SOURCE.replace('listen to runs {} fire backfill', ''),
    });
    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('manual listener');
    expect(result.errors[0]).toContain('listen to go {} fire');
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });

  it('a manual listener with no provisioned row points at saving', async () => {
    listDerivedTriggerRows.mockResolvedValue([]);
    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('save the file');
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });

  it('a differently-named manual channel is runnable too (discovery is name-agnostic)', async () => {
    getMovementRow.mockResolvedValue({
      id: MOVEMENT_ID,
      teamId: TEAM,
      name: 'backfill',
      // Rename the manual instance throughout — discovery keys on the
      // construction being `manual`, not on the instance's name.
      source: LIVE_SOURCE.replaceAll('runs', 'kickoff'),
    });
    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result.ok).toBe(true);
  });

  it('a triggerId invocation dispatches directly, skipping movement discovery', async () => {
    const result = await runMovementNow({
      teamId: TEAM,
      triggerId: 'trigger-direct',
      actor: { email: 'ada@example.com' },
    });
    expect(getMovementRow).not.toHaveBeenCalled();
    expect(listDerivedTriggerRows).not.toHaveBeenCalled();
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: 'trigger-direct' }),
    );
    expect(result.ok).toBe(true);
  });

  it('carries text + uploaded files on the manual invocation payload', async () => {
    await runMovementNow({
      teamId: TEAM,
      movementId: MOVEMENT_ID,
      text: '  hello  ',
      files: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'aGk=' }],
    });
    expect(services.document.upload).toHaveBeenCalledTimes(1);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          payload: expect.objectContaining({
            text: 'hello',
            files: [
              expect.objectContaining({ objectUri: 'doc://uploaded', filename: 'a.txt' }),
            ],
          }),
        }),
      }),
    );
  });

  it('neither movementId nor triggerId is an ok:false error', async () => {
    const result = await runMovementNow({ teamId: TEAM });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('exactly one');
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });

  it('a dispatch failure surfaces as ok:false with the message (never thrown)', async () => {
    dispatchTriggerByIdEvent.mockResolvedValue({
      evaluations: [],
      errors: [
        { triggerEntryId: TRIGGER_ID, message: "MOVENG_UNSUPPORTED: the construct '…'" },
      ],
    });
    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('MOVENG_UNSUPPORTED');
  });
});

describe('runMovementAsync', () => {
  it('queues the manual invocation and returns { runId, status: running } without dispatching', async () => {
    const result = await runMovementAsync({ teamId: TEAM, movementId: MOVEMENT_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runId).toBe(RUN_ID);
    expect(result.status).toBe('running');
    expect(result.movementName).toBe('backfill');
    expect(queueRun).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerId: TRIGGER_ID,
        teamId: TEAM,
        movementVersionId: 'ver-1',
        event: expect.objectContaining({ adapterType: 'manual', pipelineInputId: `trigger:${TRIGGER_ID}` }),
      }),
    );
    // Nothing runs in the request: the worker that drains the row dispatches.
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });

  it('a requestId becomes the event delivery id, so a retried request is the same run', async () => {
    await runMovementAsync({ teamId: TEAM, movementId: MOVEMENT_ID, requestId: 'press-1' });
    const queued = queueRun.mock.calls[0]?.[0] as { event: { idempotencyKey?: string; payload: { submissionId: string } } };
    expect(queued.event.idempotencyKey).toBe('press-1');
    expect(queued.event.payload.submissionId).toBe('press-1');
  });

  it('without a requestId the event carries no delivery id (every press is a run)', async () => {
    await runMovementAsync({ teamId: TEAM, movementId: MOVEMENT_ID });
    const queued = queueRun.mock.calls[0]?.[0] as { event: { idempotencyKey?: string } };
    expect(queued.event.idempotencyKey).toBeUndefined();
  });

  it('a non-movement trigger is ok:false (nothing to run)', async () => {
    loadTriggerById.mockResolvedValue({ id: TRIGGER_ID, movementId: null });
    const result = await runMovementAsync({ teamId: TEAM, triggerId: TRIGGER_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('not a movement trigger');
    expect(queueRun).not.toHaveBeenCalled();
  });

  it('a missing movement listener is ok:false (resolution gate runs)', async () => {
    getMovementRow.mockResolvedValue(undefined);
    const result = await runMovementAsync({ teamId: TEAM, movementId: 'ghost' });
    expect(result.ok).toBe(false);
    expect(queueRun).not.toHaveBeenCalled();
  });
});

describe('getMovementRunStatus', () => {
  beforeEach(() => {
    runCostSummaries.mockResolvedValue(new Map());
  });

  it('projects a finished run row into the concise poll shape', async () => {
    const startedAt = new Date('2026-06-24T00:00:00Z');
    const completedAt = new Date('2026-06-24T00:00:30Z');
    getAutomationsQb.mockImplementation(() =>
      makeQbStub({
        id: RUN_ID,
        status: 'success',
        nodes_written: 3,
        errors: [],
        dry_run: false,
        started_at: startedAt,
        completed_at: completedAt,
        failed_at: null,
        failure_reason: null,
      }),
    );
    const result = await getMovementRunStatus({ teamId: TEAM, runId: RUN_ID });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.status).toBe('success');
    expect(result.recordCount).toBe(3);
    expect(result.startedAt).toBe(startedAt.toISOString());
    expect(result.finishedAt).toBe(completedAt.toISOString());
    expect(result.failedAt).toBeNull();
    // No usage rows for this run — cost reads as zero, not missing.
    expect(result.costUsd).toBe(0);
    expect(result.modelCalls).toBe(0);
  });

  it('carries the run’s rolled-up model-call cost', async () => {
    getAutomationsQb.mockImplementation(() =>
      makeQbStub({
        id: RUN_ID,
        status: 'success',
        nodes_written: 1,
        errors: [],
        dry_run: false,
        started_at: new Date('2026-06-24T00:00:00Z'),
        completed_at: new Date('2026-06-24T00:00:05Z'),
        failed_at: null,
        failure_reason: null,
      }),
    );
    runCostSummaries.mockResolvedValue(
      new Map([[RUN_ID, { runId: RUN_ID, costMicrodollars: 12_345, calls: 4, inputTokens: 100, outputTokens: 20 }]]),
    );
    const result = await getMovementRunStatus({ teamId: TEAM, runId: RUN_ID });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.costUsd).toBeCloseTo(0.0123, 4);
    expect(result.modelCalls).toBe(4);
  });

  it('a missing/cross-team run id is not found', async () => {
    getAutomationsQb.mockImplementation(() => makeQbStub(undefined));
    const result = await getMovementRunStatus({ teamId: TEAM, runId: 'ghost' });
    expect('error' in result).toBe(true);
  });
});
