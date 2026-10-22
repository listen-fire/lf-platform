/**
 * Unit-tests for `movement.ts`. The `runs` procedure body is thin (delegates
 * to `movementRunsImpl`); `movementRunsImpl` is tested here directly via
 * kysely stubs — no real DB required.
 *
 * Scenario: a movement with two lanes (triggers A and B), two runs each.
 * Assert that the merged result is newest-first and each run carries the
 * correct `lane` from its originating trigger's name.
 */

/**
 * A kysely stub keyed by TABLE, not by which accessor asked for it. Phase 2
 * re-keyed movement.ts onto `getAutomationsQb` for every table it touches
 * (trigger, trigger_run, trigger_event) — there's no longer a per-table
 * accessor to alias a fixed row set to, so the stub must dispatch on the
 * table name passed to `.selectFrom()` itself. `getKnowledgeQb`/`getQb`/
 * `getCoreQb` are unused by the code under test but still stubbed (empty)
 * so an accidental call fails loudly instead of picking up stale rows.
 */
function makeQbStub(rowsByTable: Record<string, unknown[]>) {
  const stub: any = {
    where: () => stub,
    select: () => stub,
    orderBy: () => stub,
    limit: () => stub,
    groupBy: () => stub,
  };
  let rows: unknown[] = [];
  stub.selectFrom = (table: string) => {
    rows = rowsByTable[table] ?? [];
    return stub;
  };
  stub.execute = async () => rows;
  stub.executeTakeFirst = async () => rows[0];
  return stub;
}

describe('movement router — sanity', () => {
  it('exports the router factory', async () => {
    const { movementRouter } = await import('../movement');
    expect(typeof movementRouter).toBe('function');
  });
});

describe('movementRunsImpl', () => {
  const TEAM_ID = 'team-abc' as never;
  const MOVEMENT_ID = '00000000-0000-0000-0000-000000000001';

  const TRIGGER_A = { id: 'trig-a', name: 'Email lane' };
  const TRIGGER_B = { id: 'trig-b', name: 'Slack lane' };

  // Four synthetic runs: two per lane, interleaved by created_at (newest first
  // after the DESC ORDER BY which the real query applies — our stub returns them
  // in the order provided, newest first, matching what the DB would return).
  const now = new Date('2026-06-27T12:00:00Z');
  const minus1h = new Date('2026-06-27T11:00:00Z');
  const minus2h = new Date('2026-06-27T10:00:00Z');
  const minus3h = new Date('2026-06-27T09:00:00Z');

  const RUN_ROWS = [
    {
      id: 'run-1',
      trigger_id: TRIGGER_A.id,
      status: 'success',
      nodes_written: 3,
      dry_run: false,
      started_at: now,
      completed_at: now,
      failed_at: null,
      failure_reason: null,
      created_at: now,
    },
    {
      id: 'run-2',
      trigger_id: TRIGGER_B.id,
      status: 'failed',
      nodes_written: 0,
      dry_run: false,
      started_at: minus1h,
      completed_at: null,
      failed_at: minus1h,
      failure_reason: 'timeout',
      created_at: minus1h,
    },
    {
      id: 'run-3',
      trigger_id: TRIGGER_A.id,
      status: 'success',
      nodes_written: 1,
      dry_run: true,
      started_at: minus2h,
      completed_at: minus2h,
      failed_at: null,
      failure_reason: null,
      created_at: minus2h,
    },
    {
      id: 'run-4',
      trigger_id: TRIGGER_B.id,
      status: 'success',
      nodes_written: 0,
      dry_run: false,
      started_at: minus3h,
      completed_at: minus3h,
      failed_at: null,
      failure_reason: null,
      created_at: minus3h,
    },
  ];

  // Cost rows for two of the four runs — the other two made no model calls.
  const LLM_USAGE_ROWS = [
    { trigger_run_id: 'run-1', calls: 2, input_tokens: 500, output_tokens: 100, cost_microdollars: 3000 },
    { trigger_run_id: 'run-3', calls: 1, input_tokens: 50, output_tokens: 10, cost_microdollars: 200 },
  ];

  beforeEach(() => {
    jest.resetModules();

    const automationsQbStub = makeQbStub({
      trigger: [TRIGGER_A, TRIGGER_B],
      trigger_run: RUN_ROWS,
    });

    jest.doMock('../../../../lib/kysely', () => ({
      getKnowledgeQb: jest.fn(() => makeQbStub({})),
      getAutomationsQb: jest.fn(() => automationsQbStub),
      getQb: jest.fn(() => makeQbStub({ llm_usage: LLM_USAGE_ROWS })),
      getCoreQb: jest.fn(() => makeQbStub({})),
    }));

    // summariseRun is imported by movement.ts from ./triggers — stub it to
    // avoid pulling in the full triggers module dependency tree.
    jest.doMock('../triggers', () => ({
      summariseRun: jest.fn((row: { failed_at: Date | null; status: string; nodes_written: number }) => {
        if (row.failed_at !== null) return 'Failed: ' + (row as any).failure_reason;
        return `Processed — ${row.nodes_written} records`;
      }),
    }));
  });

  afterEach(() => {
    jest.dontMock('../../../../lib/kysely');
    jest.dontMock('../triggers');
  });

  it('returns all runs merged newest-first with correct lane labels', async () => {
    const { movementRunsImpl } = await import('../movement');
    const result = await movementRunsImpl({ teamId: TEAM_ID, movementId: MOVEMENT_ID });

    expect(result).toHaveLength(4);

    // Newest-first order preserved (our stub returns them in that order).
    expect(result[0].id).toBe('run-1');
    expect(result[1].id).toBe('run-2');
    expect(result[2].id).toBe('run-3');
    expect(result[3].id).toBe('run-4');

    // Lane labels come from the originating trigger's name.
    expect(result[0].lane).toBe('Email lane');
    expect(result[1].lane).toBe('Slack lane');
    expect(result[2].lane).toBe('Email lane');
    expect(result[3].lane).toBe('Slack lane');

    // Spot-check field mapping.
    expect(result[0].nodesWritten).toBe(3);
    expect(result[0].dryRun).toBe(false);
    expect(result[1].failedAt).toBe(minus1h);
    expect(result[1].failureReason).toBe('timeout');
    expect(result[2].dryRun).toBe(true);

    // Cost rolls up from llm_usage, per run — a run with no usage rows
    // reads as zero, not missing.
    expect(result[0].costMicrodollars).toBe(3000);
    expect(result[0].calls).toBe(2);
    expect(result[0].inputTokens).toBe(500);
    expect(result[0].outputTokens).toBe(100);
    expect(result[2].costMicrodollars).toBe(200);
    expect(result[1].costMicrodollars).toBe(0);
    expect(result[1].calls).toBe(0);
    expect(result[3].costMicrodollars).toBe(0);
  });

  it('returns an empty array when the movement has no triggers', async () => {
    jest.resetModules();
    jest.doMock('../../../../lib/kysely', () => ({
      getKnowledgeQb: jest.fn(() => makeQbStub({})),
      getAutomationsQb: jest.fn(() => makeQbStub({ trigger: [] })),
      getQb: jest.fn(() => makeQbStub({})),
      getCoreQb: jest.fn(() => makeQbStub({})),
    }));
    jest.doMock('../triggers', () => ({
      summariseRun: jest.fn(),
    }));

    const { movementRunsImpl } = await import('../movement');
    const result = await movementRunsImpl({ teamId: TEAM_ID, movementId: MOVEMENT_ID });
    expect(result).toEqual([]);
  });
});

describe('movementEventsImpl', () => {
  const TEAM_ID = 'team-abc' as never;
  const MOVEMENT_ID = '00000000-0000-0000-0000-000000000001';

  const TRIGGER_A = { id: 'trig-a', name: 'movement/inbox/on_email' };
  const TRIGGER_B = { id: 'trig-b', name: 'movement/inbox/on_slack' };

  const now = new Date('2026-06-27T12:00:00Z');
  const minus1h = new Date('2026-06-27T11:00:00Z');

  const EVENT_ROWS = [
    {
      id: 'evt-1',
      trigger_id: TRIGGER_B.id,
      adapter_type: 'slack',
      status: 'failed',
      failure_reason: 'no handler',
      occurred_at: now,
      created_at: now,
    },
    {
      id: 'evt-2',
      trigger_id: TRIGGER_A.id,
      adapter_type: 'email',
      status: 'dispatched',
      failure_reason: null,
      occurred_at: minus1h,
      created_at: minus1h,
    },
  ];

  beforeEach(() => {
    jest.resetModules();
    const automationsQbStub = makeQbStub({
      trigger: [TRIGGER_A, TRIGGER_B],
      trigger_event: EVENT_ROWS,
    });
    jest.doMock('../../../../lib/kysely', () => ({
      getKnowledgeQb: jest.fn(() => makeQbStub({})),
      getAutomationsQb: jest.fn(() => automationsQbStub),
      getQb: jest.fn(() => makeQbStub({})),
      getCoreQb: jest.fn(() => makeQbStub({})),
    }));
    jest.doMock('../triggers', () => ({ summariseRun: jest.fn() }));
  });

  afterEach(() => {
    jest.dontMock('../../../../lib/kysely');
    jest.dontMock('../triggers');
  });

  it('annotates each arrival with the lane it landed on', async () => {
    const { movementEventsImpl } = await import('../movement');
    const result = await movementEventsImpl({ teamId: TEAM_ID, movementId: MOVEMENT_ID });

    expect(result.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
    expect(result[0].lane).toBe('movement/inbox/on_slack');
    expect(result[1].lane).toBe('movement/inbox/on_email');
    expect(result[0].failureReason).toBe('no handler');
    expect(result[1].adapterType).toBe('email');
    expect(result[1].occurredAt).toBe(minus1h);
  });

  it('returns an empty array when the movement has no triggers', async () => {
    jest.resetModules();
    jest.doMock('../../../../lib/kysely', () => ({
      getKnowledgeQb: jest.fn(() => makeQbStub({})),
      getAutomationsQb: jest.fn(() => makeQbStub({ trigger: [], trigger_event: EVENT_ROWS })),
      getQb: jest.fn(() => makeQbStub({})),
      getCoreQb: jest.fn(() => makeQbStub({})),
    }));
    jest.doMock('../triggers', () => ({ summariseRun: jest.fn() }));

    const { movementEventsImpl } = await import('../movement');
    expect(
      await movementEventsImpl({ teamId: TEAM_ID, movementId: MOVEMENT_ID }),
    ).toEqual([]);
  });
});

describe('latestRunsByTriggerId', () => {
  // Two lanes: Email lane has runs, Slack lane has none.
  const TEAM_ID = 'team-xyz' as never;
  const EMAIL_TRIGGER_ID = 'trig-email';
  const SLACK_TRIGGER_ID = 'trig-slack';

  const now = new Date('2026-06-27T12:00:00Z');
  const minus1h = new Date('2026-06-27T11:00:00Z');

  // Two runs for EMAIL, zero for SLACK. Ordered newest-first (as the DB returns them).
  const RUN_ROWS = [
    {
      id: 'run-latest',
      trigger_id: EMAIL_TRIGGER_ID,
      status: 'success',
      nodes_written: 5,
      dry_run: false,
      started_at: now,
      completed_at: now,
      failed_at: null,
      failure_reason: null,
      created_at: now,
    },
    {
      id: 'run-older',
      trigger_id: EMAIL_TRIGGER_ID,
      status: 'success',
      nodes_written: 2,
      dry_run: false,
      started_at: minus1h,
      completed_at: minus1h,
      failed_at: null,
      failure_reason: null,
      created_at: minus1h,
    },
  ];

  beforeEach(() => {
    jest.resetModules();

    const automationsQbStub = makeQbStub({ trigger_run: RUN_ROWS });
    jest.doMock('../../../../lib/kysely', () => ({
      getKnowledgeQb: jest.fn(() => makeQbStub({})),
      getAutomationsQb: jest.fn(() => automationsQbStub),
      getQb: jest.fn(() => makeQbStub({})),
      getCoreQb: jest.fn(() => makeQbStub({})),
    }));
    jest.doMock('../triggers', () => ({
      summariseRun: jest.fn(() => 'Processed — 5 records'),
    }));
  });

  afterEach(() => {
    jest.dontMock('../../../../lib/kysely');
    jest.dontMock('../triggers');
  });

  it('returns the most recent run for lanes with runs, absent for lanes without', async () => {
    const { latestRunsByTriggerId } = await import('../movement');
    const result = await latestRunsByTriggerId({
      teamId: TEAM_ID,
      triggerIds: [EMAIL_TRIGGER_ID, SLACK_TRIGGER_ID],
    });

    // Email lane has runs → present in map with the latest run (run-latest, not run-older).
    expect(result.has(EMAIL_TRIGGER_ID)).toBe(true);
    const emailRun = result.get(EMAIL_TRIGGER_ID)!;
    expect(emailRun.id).toBe('run-latest');
    expect(emailRun.nodesWritten).toBe(5);
    expect(emailRun.status).toBe('success');
    expect(emailRun.summary).toBe('Processed — 5 records');
    // No llm_usage rows stubbed for this suite — cost reads as zero.
    expect(emailRun.costMicrodollars).toBe(0);
    expect(emailRun.calls).toBe(0);

    // Slack lane has no runs → absent from map → caller maps to null.
    expect(result.has(SLACK_TRIGGER_ID)).toBe(false);
    expect(result.get(SLACK_TRIGGER_ID) ?? null).toBeNull();
  });

  it('returns an empty map when triggerIds is empty', async () => {
    const { latestRunsByTriggerId } = await import('../movement');
    const result = await latestRunsByTriggerId({ teamId: TEAM_ID, triggerIds: [] });
    expect(result.size).toBe(0);
  });
});

describe('check — the server lint for an installed pin', () => {
  const ATTIO_IMPORT = (field: string) => `import { attio } from adapters
import { acme_main } from credentials

crm = connect attio using acme_main

function \`Import Companies\`(go: <manual-[:Invocation]->>) {
  write crm-[:Companies]-> {
    unique by (Name)
    ${field}: go.Text
  }
}

listen as "Import companies" to manual fire \`Import Companies\`
`;
  const BARE_MANUAL = 'function echo(run: <manual-[:Invocation]->>) {\n  return 1\n}\nlisten to manual fire echo\n';

  async function caller() {
    const { fromCatalogSnapshot, mockCatalogSnapshot } = await import('movement-lang');
    const snapshot = mockCatalogSnapshot({
      adapters: {
        attio: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          schema: {
            positions: { Companies: { properties: { Name: 'text' }, edges: {} } },
            collections: { Companies: { target: 'Companies' } },
            writableRoots: { Companies: { fields: { Name: 'text' }, resultShape: { externalId: 'text', Name: 'text' } } },
          },
        },
      },
      credentials: { acme_main: { adapters: ['attio'] } },
    });
    jest.doMock('../../../../services/context', () => ({
      currentContext: () => ({
        user: { id: 'user-1', teamId: 'team-1' },
        principal: { userId: 'user-1', teamId: 'team-1', access: 'write', scopes: ['*'], pinnedTeamId: null },
      }),
    }));
    jest.doMock('../../../../services/user', () => ({
      UserService: { getById: async () => ({ id: 'user-1' }) },
    }));
    jest.doMock('../../../../services/translation_graph/movement/catalog', () => ({
      ...jest.requireActual('../../../../services/translation_graph/movement/catalog'),
      movementCatalogForTeam: async () => ({
        catalog: fromCatalogSnapshot(snapshot),
        resolveCredentialId: () => undefined,
        resolveFile: () => undefined,
        notes: [],
        gaps: [],
        runSnapshot: () => snapshot,
      }),
    }));
    const { movementRouter } = await import('../movement');
    const { trpc } = await import('../../trpc');
    return movementRouter(trpc.procedure).createCaller({ authorise: async () => {} } as never);
  }

  beforeEach(() => {
    jest.resetModules();
  });
  afterEach(() => {
    jest.dontMock('../../../../services/context');
    jest.dontMock('../../../../services/user');
    jest.dontMock('../../../../services/translation_graph/movement/catalog');
  });

  it('a bare manual listen has no diagnostics under the installed pin', async () => {
    const { diagnostics } = await (await caller()).check({ source: BARE_MANUAL });
    expect(diagnostics).toEqual([]);
  });

  it('an unknown field is the wasm checker\'s error', async () => {
    const clean = await (await caller()).check({ source: ATTIO_IMPORT('Name') });
    expect(clean.diagnostics).toEqual([]);
    const { diagnostics } = await (await caller()).check({ source: ATTIO_IMPORT('Nmae') });
    expect(diagnostics.filter((d) => d.severity === 'error').length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.message.includes('Nmae'))).toBe(true);
  });
});
