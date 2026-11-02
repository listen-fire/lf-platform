// "Run now" as an arrival on the manual unit's `Invocations`, judged by the
// movement's one manual listen (the engine's judge, for real) and kept as a
// delivery. The store reads, the delivery's write and the drain are mocked;
// the REAL manual-listen gate (manualListenerMovements over the saved
// source), the judging and the result projection run. Covered:
//
//   1. a press is one `Invocations` arrival, carrying the actor, text and
//      files, kept with the run its listen minted; its id comes back
//   2. a requestId is the delivery's external id and names the run, so a
//      retried request is the same run
//   3. no movement / no manual listen / no provisioned listen / a trigger
//      that is no manual listen of the team → ok:false naming why
//   4. the in-process entry drains the team's work and projects the run

// Order-sensitive cycle guard (mirrors save.unit.test.ts): pre-require
// schemas.ts so `expressionSchema` resolves before ../types pulls it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

jest.mock('../store', () => ({ getMovementRow: jest.fn() }));

jest.mock('../../../../adapters/registry', () => ({
  services: { document: { upload: jest.fn() } },
}));

jest.mock('../../../inbound/listen_door', () => ({
  judgeArrivals: jest.requireActual('../../../inbound/listen_door').judgeArrivals,
  savedListens: jest.fn(),
  savedListenOf: jest.fn(),
  keepJudgedDelivery: jest.fn(),
}));
jest.mock('../../../work/drain', () => ({ drainUntilIdle: jest.fn(), notifyWork: jest.fn() }));
jest.mock('../../runs/trigger_run', () => ({
  reportedFailureReason: jest.requireActual('../../runs/trigger_run').reportedFailureReason,
}));
jest.mock('../../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));
// The per-run cost rollup is its own unit (llm_usage_run_cost.unit.test.ts) —
// stubbed here so this file doesn't also need a `getQb`/`llm_usage` double.
jest.mock('../../../../lib/llm_usage', () => ({
  runCostSummaries: jest.fn(async () => new Map()),
  costMicrodollarsToUsd: jest.fn((microdollars: number) => Math.round(microdollars / 100) / 10000),
}));

import type { ListenPlan } from 'engine-contracts';
import type { SavedListen } from '../../../inbound/listen_door';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';

import { runMovementNow, runMovementAsync, getMovementRunStatus } from '../run_now';

const { getAutomationsQb } = jest.requireMock('../../../../lib/kysely') as {
  getAutomationsQb: jest.Mock;
};
const { runCostSummaries } = jest.requireMock('../../../../lib/llm_usage') as {
  runCostSummaries: jest.Mock;
};
const { savedListens, savedListenOf, keepJudgedDelivery } = jest.requireMock('../../../inbound/listen_door') as {
  savedListens: jest.Mock;
  savedListenOf: jest.Mock;
  keepJudgedDelivery: jest.Mock;
};
const { drainUntilIdle, notifyWork } = jest.requireMock('../../../work/drain') as {
  drainUntilIdle: jest.Mock;
  notifyWork: jest.Mock;
};

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

const { getMovementRow } = jest.requireMock('../store') as {
  getMovementRow: jest.Mock;
};

const TEAM = 'team-1';
const MOVEMENT_ID = 'mov-row-1';
const TRIGGER_ID = 'trigger-manual-1';
const RUN_ID = 'run-async-1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LIVE_SOURCE = `import { \`@lf/attio\` as attio } from adapters
import { acme_main } from credentials

crm = connect attio using acme_main

function backfill(go: <manual-[:Invocations]->>) {
  crm-[c:Companies]-> {
    write c { Categories: "Reviewed" }
  }
}

listen to manual-[:Invocations]-> fire backfill
`;

/** listen-fire's own plan of a manual listen (conformance listen-pipelines.json). */
const MANUAL_PLAN: ListenPlan = {
  movement: 'backfill',
  connection: 'manual',
  adapter: 'manual',
  hops: [{ edge: 'Invocations', from: '', to: 'Invocation', judged: 'arrival' }],
};

const LISTEN: SavedListen = {
  pipeline: 'listen:backfill:backfill:6761be48',
  plan: MANUAL_PLAN,
  awaits: { own: [], carried: {} },
  fieldIds: {},
  triggerId: TRIGGER_ID as TriggerId,
  teamId: TEAM as TeamId,
  file: 'backfill',
  credentialsId: null,
};

/** What the delivery keeps, as `runMovementAsync` handed it over. */
function keptDelivery(): {
  externalId: string | null;
  source: string;
  adapterType: string;
  arrivals: Array<{ edge: string; identity: string; landing: { recordType: string; fields: Record<string, unknown> } }>;
  judged: { minted: Array<{ runId: string; listen: SavedListen }> };
} {
  expect(keepJudgedDelivery).toHaveBeenCalledTimes(1);
  return keepJudgedDelivery.mock.calls[0][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  getMovementRow.mockResolvedValue({
    id: MOVEMENT_ID,
    teamId: TEAM,
    name: 'backfill',
    source: LIVE_SOURCE,
  });
  savedListens.mockResolvedValue([LISTEN]);
  savedListenOf.mockResolvedValue(LISTEN);
  keepJudgedDelivery.mockResolvedValue({ kept: { kept: true, arrivalMark: 1 }, deliveryId: 'd-1', fires: [] });
  drainUntilIdle.mockResolvedValue({});
  services.document.upload.mockResolvedValue({ objectUri: 'doc://uploaded' });
  getAutomationsQb.mockImplementation(() => makeQbStub(null));
});

describe('runMovementAsync', () => {
  it('keeps one Invocations arrival with the run its manual listen minted, and returns that run', async () => {
    const result = await runMovementAsync({
      teamId: TEAM,
      movementId: MOVEMENT_ID,
      actor: { email: 'ada@example.com', name: 'Ada' },
    });

    const kept = keptDelivery();
    expect(kept.adapterType).toBe('manual');
    expect(kept.source).toBe('cli');
    expect(kept.externalId).toBeNull();
    expect(kept.arrivals).toEqual([
      {
        edge: 'Invocations',
        identity: expect.stringMatching(/^invocation:/),
        landing: {
          recordType: 'Invocation',
          fields: expect.objectContaining({ actorEmail: 'ada@example.com', actorName: 'Ada', firedAt: expect.any(String) }),
        },
      },
    ]);
    expect(kept.judged.minted).toHaveLength(1);
    expect(kept.judged.minted[0]!.listen).toBe(LISTEN);
    expect(result).toEqual({ ok: true, runId: kept.judged.minted[0]!.runId, status: 'running', movementName: 'backfill' });
    expect(savedListens).toHaveBeenCalledWith({ teamId: TEAM, adapterType: 'manual', movementId: MOVEMENT_ID });
    expect(notifyWork).toHaveBeenCalled();
    expect(drainUntilIdle).not.toHaveBeenCalled();
  });

  it('a requestId is the delivery`s external id and names the run, so a retry is the same run', async () => {
    const first = await runMovementAsync({ teamId: TEAM, movementId: MOVEMENT_ID, requestId: 'req-42' });
    const again = await runMovementAsync({ teamId: TEAM, movementId: MOVEMENT_ID, requestId: 'req-42' });
    const other = await runMovementAsync({ teamId: TEAM, movementId: MOVEMENT_ID, requestId: 'req-43' });

    expect(first.ok && again.ok && other.ok).toBe(true);
    if (!first.ok || !again.ok || !other.ok) return;
    expect(first.runId).toMatch(UUID);
    expect(again.runId).toBe(first.runId);
    expect(other.runId).not.toBe(first.runId);
    const call = keepJudgedDelivery.mock.calls[0][0];
    expect(call.externalId).toBe(`run-now:${LISTEN.pipeline}:req-42`);
    expect(call.arrivals[0].identity).toBe('invocation:req-42');
    expect(call.judged.minted[0].runId).toBe(first.runId);
  });

  it('carries text and uploaded files on the invocation', async () => {
    await runMovementAsync({
      teamId: TEAM,
      movementId: MOVEMENT_ID,
      text: '  Acme, Initech  ',
      files: [{ filename: 'deck.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('pdf').toString('base64') }],
    });

    const fields = keptDelivery().arrivals[0]!.landing.fields;
    expect(fields.text).toBe('Acme, Initech');
    expect(fields.files).toEqual([{ objectUri: 'doc://uploaded', filename: 'deck.pdf', contentType: 'application/pdf', size: 3 }]);
  });

  it('a triggerId runs that listen, skipping movement discovery', async () => {
    const result = await runMovementAsync({ teamId: TEAM, triggerId: TRIGGER_ID });

    expect(result.ok).toBe(true);
    expect(savedListenOf).toHaveBeenCalledWith(TRIGGER_ID);
    expect(getMovementRow).not.toHaveBeenCalled();
  });

  it('a trigger of another team, or no manual listen, runs nothing', async () => {
    savedListenOf.mockResolvedValueOnce({ ...LISTEN, teamId: 'team-2' });
    const crossTeam = await runMovementAsync({ teamId: TEAM, triggerId: TRIGGER_ID });
    savedListenOf.mockResolvedValueOnce({ ...LISTEN, plan: { ...MANUAL_PLAN, adapter: 'attio' } });
    const notManual = await runMovementAsync({ teamId: TEAM, triggerId: TRIGGER_ID });
    savedListenOf.mockResolvedValueOnce(null);
    const missing = await runMovementAsync({ teamId: TEAM, triggerId: TRIGGER_ID });

    for (const result of [crossTeam, notManual, missing]) {
      expect(result).toEqual({ ok: false, errors: [expect.stringContaining('is no manual listen of this team')] });
    }
    expect(keepJudgedDelivery).not.toHaveBeenCalled();
  });

  it('a missing movement is an ok:false error', async () => {
    getMovementRow.mockResolvedValueOnce(null);
    const result = await runMovementAsync({ teamId: TEAM, movementId: 'nope' });
    expect(result).toEqual({ ok: false, errors: ['movement nope not found'] });
  });

  it('a source without a manual listen is ok:false naming the fix', async () => {
    getMovementRow.mockResolvedValueOnce({
      id: MOVEMENT_ID,
      teamId: TEAM,
      name: 'backfill',
      source: LIVE_SOURCE.replace('listen to manual-[:Invocations]-> fire backfill\n', ''),
    });
    const result = await runMovementAsync({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('has no manual listen');
    expect(result.errors[0]).toContain('listen to manual-[:Invocations]-> fire');
  });

  it('a manual listen with no provisioned row points at saving', async () => {
    savedListens.mockResolvedValueOnce([]);
    const result = await runMovementAsync({ teamId: TEAM, movementId: MOVEMENT_ID });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('save the file');
  });

  it('neither movementId nor triggerId is an ok:false error', async () => {
    const result = await runMovementAsync({ teamId: TEAM });
    expect(result).toEqual({ ok: false, errors: ['runMovementNow needs exactly one of movementId / triggerId'] });
  });
});

describe('runMovementNow', () => {
  function runRow(over: Record<string, unknown>) {
    return {
      id: 'r',
      status: 'success',
      nodes_written: 3,
      dry_run: false,
      errors: [],
      started_at: new Date('2026-06-24T00:00:00Z'),
      completed_at: new Date('2026-06-24T00:00:30Z'),
      failed_at: null,
      failure_reason: null,
      limit_pause: null,
      ...over,
    };
  }

  it('queues the invocation, drains the team`s work, and projects the run as it settled', async () => {
    getAutomationsQb.mockImplementation(() => makeQbStub(runRow({ dry_run: true })));

    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });

    expect(drainUntilIdle).toHaveBeenCalledWith({ owner: 'run-now', teamId: TEAM });
    expect(result).toEqual({ ok: true, movementName: 'backfill', dryRun: true, recordCount: 3, errors: [] });
  });

  it('a failed run is ok:false with its reason', async () => {
    getAutomationsQb.mockImplementation(() => makeQbStub(runRow({ status: 'failed', failure_reason: 'the attio write was refused', failed_at: new Date() })));

    const result = await runMovementNow({ teamId: TEAM, movementId: MOVEMENT_ID });

    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('the attio write was refused')] });
  });

  it('a gate refusal is ok:false and drains nothing', async () => {
    getMovementRow.mockResolvedValueOnce(null);
    const result = await runMovementNow({ teamId: TEAM, movementId: 'nope' });
    expect(result).toEqual({ ok: false, errors: ['movement nope not found'] });
    expect(drainUntilIdle).not.toHaveBeenCalled();
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
