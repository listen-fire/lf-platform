// The knowledge graph's change events take the inbound path every adapter's
// events take: the `@lf/kg` module reads the store's envelope
// (`preprocessInbound`), the shared capture tail scopes it to the listens it
// matches and stores one receipt each, and a `dispatch_event` work row is
// queued per receipt. No movement runs here — the drainer runs the rows.
//
// REAL: queueKnowledgeChange, captureProviderTriggerEvents (trigger scope,
// the record scope by name through the adapter, the trigger type),
// captureDiscriminableEvent + triggerEventOf (the event a run is handed),
// enqueueCapturedEvents, and the module's own envelope reading.
// Mocked: the trigger index, the receipt store, the work table, adapter
// resolution (a fake graph surface around the module's real reader), and the
// DB.

import type { MutationContext } from 'movement-engine/public/adapter';
import type { MutationEventEnvelope } from '../../../lib/knowledge/store/events';

function mockChainable(): object {
  const handler: ProxyHandler<object> = {
    get(_target: object, prop: string | symbol): unknown {
      if (prop === 'execute') return async () => [];
      if (prop === 'executeTakeFirst') return async () => undefined;
      if (prop === 'then') return undefined;
      return () => mockChainable();
    },
  };
  return new Proxy({}, handler);
}
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockChainable()),
  getAutomationsQb: jest.fn(() => mockChainable()),
  getQb: jest.fn(() => mockChainable()),
  getCoreQb: jest.fn(() => mockChainable()),
}));

jest.mock('../../translation_graph/storage/tg_table', () => ({
  findTriggersByKind: jest.fn(),
}));

let receiptCounter = 0;
const seenKeys = new Set<string>();
jest.mock('../../translation_graph/triggers/event_store', () => ({
  storeTriggerEvent: jest.fn(async (input: { triggerId: string; event: { idempotencyKey?: string } }) => {
    const key = `${input.triggerId}:${input.event.idempotencyKey ?? ''}`;
    const duplicate = seenKeys.has(key);
    seenKeys.add(key);
    receiptCounter += 1;
    return { id: `00000000-0000-4000-8000-${String(receiptCounter).padStart(12, '0')}`, duplicate };
  }),
  markTriggerEventDispatched: jest.fn(),
  markTriggerEventFailed: jest.fn(),
}));

jest.mock('../../work/store', () => ({
  enqueueWork: jest.fn(async () => undefined),
  awaitTeamWorkSettled: jest.fn(async () => true),
}));

jest.mock('../../translation_graph/adapters/resolve', () => ({
  resolveAdapter: jest.fn(),
}));

jest.mock('../../work/drain', () => ({
  registerWorkKinds: jest.fn(),
  registerWorkHandler: jest.fn(),
  notifyWork: jest.fn(),
}));
jest.mock('../../knowledge/mutation_outbox/worker', () => ({ drainOnce: jest.fn() }));

import { changeEventsOf, kgManifest } from '@listen-fire/kg';

jest.mock('../../translation_graph/adapters/registry', () => {
  const { kgManifest: manifest } = jest.requireActual('@listen-fire/kg/manifest');
  return {
    getAdapterManifest: jest.fn((type: string) => (type === 'kg' ? manifest({ changeWebhooks: false }) : null)),
    hasAdapter: jest.fn(() => true),
    resolveAdapterSlug: jest.fn((type: string) => (type === 'KG_MUTATION' ? 'kg' : type)),
    getAdapter: jest.fn(),
    listAdapterTypes: jest.fn(() => []),
  };
});

import { queueKnowledgeChange, registerKnowledgeChangeWork } from '../knowledge_changes';

const { findTriggersByKind } = jest.requireMock('../../translation_graph/storage/tg_table') as {
  findTriggersByKind: jest.Mock;
};
const { enqueueWork } = jest.requireMock('../../work/store') as { enqueueWork: jest.Mock };
const { resolveAdapter } = jest.requireMock('../../translation_graph/adapters/resolve') as {
  resolveAdapter: jest.Mock;
};

const TEAM = '00000000-0000-0000-0000-000000000010';
const COMPANY_NODE = '00000000-0000-0000-0000-00000000c001';

const mutationContext: MutationContext = {
  source: { type: 'user_edit', adapterType: 'kg' },
  occurredAt: '2026-10-19T10:00:00.000Z',
};

/** The graph's surface for one team: its model's names and ids, and the
 *  module's own envelope reader. */
const kgFake = {
  adapterType: 'kg',
  async preprocessInbound(input: { raw: unknown }) {
    return { events: changeEventsOf(input.raw, () => undefined) };
  },
  async listEntryPoints() {
    return [
      { typeId: 'company', displayName: 'company', externalId: 'nt-company', readable: true, writable: true },
      { typeId: 'person', displayName: 'person', externalId: 'nt-person', readable: true, writable: true },
    ];
  },
  async describe(typeRef: string) {
    if (typeRef !== 'company') return null;
    return {
      typeId: 'company',
      displayName: 'company',
      fields: [
        { fieldId: 'pt-name', displayName: 'name', kind: 'string', writable: true, required: false },
        { fieldId: 'pt-domains', displayName: 'domains', kind: 'string', writable: true, required: false },
      ],
      references: [],
    };
  },
};

const TRIGGERS = [
  {
    id: 't-company',
    kind: 'kg',
    // Post-D40: the listen is persisted VERBATIM — names, not store ids.
    config: { type: 'company', events: ['record.updated'], fields: ['domains'] },
    credentialsId: 'cred-kg-1',
    runMode: 'live',
    movementId: 'mov-company',
  },
  {
    id: 't-person',
    kind: 'kg',
    // A PRE-D40 row: the store's own currency, still filtering until re-saved.
    config: { type: 'person', node_type_id: 'nt-person', change_kinds: ['created'] },
    credentialsId: 'cred-kg-1',
    runMode: 'live',
    movementId: 'mov-person',
  },
];

function companyChange(overrides: Partial<MutationEventEnvelope['data']> = {}): MutationEventEnvelope {
  const data = {
    recordId: COMPANY_NODE,
    nodeTypeId: 'nt-company',
    changeKind: 'update' as const,
    changedFields: ['pt-domains'],
    context: mutationContext,
    ...overrides,
  };
  const event = { create: 'record.created', update: 'record.updated', delete: 'record.deleted' } as const;
  return { event: event[data.changeKind], timestamp: mutationContext.occurredAt, data };
}

/** The receipts the queued rows carry, in order. */
function queuedReceipts(): Array<{ triggerId: string; triggerEvent: Record<string, unknown> }> {
  return enqueueWork.mock.calls.map(([row]: [{ kind: string; payload: never }]) => {
    expect(row.kind).toBe('dispatch_event');
    return row.payload;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seenKeys.clear();
  findTriggersByKind.mockResolvedValue(TRIGGERS);
  resolveAdapter.mockResolvedValue(kgFake);
});

describe('queueKnowledgeChange — a graph change through the inbound path', () => {
  it('queues one run row for the listen it matches, and runs nothing', async () => {
    const result = await queueKnowledgeChange({ teamId: TEAM, envelope: companyChange(), outboxId: 'o-1' });

    expect(result).toEqual({ queued: 1 });
    const [receipt] = queuedReceipts();
    expect(receipt.triggerId).toBe('t-company');
  });

  it('hands the run a MUTATION event anchored on the changed record, as the in-process path did', async () => {
    await queueKnowledgeChange({ teamId: TEAM, envelope: companyChange(), outboxId: 'o-1' });

    const [{ triggerEvent }] = queuedReceipts();
    expect(triggerEvent).toMatchObject({
      adapterType: 'kg',
      triggerType: 'mutation',
      recordId: COMPANY_NODE,
      changeType: 'update',
      changedFields: ['pt-domains'],
      occurredAt: mutationContext.occurredAt,
      idempotencyKey: 'knowledge_outbox:o-1',
      payload: {
        recordId: COMPANY_NODE,
        nodeTypeId: 'nt-company',
        changeKind: 'update',
        changedFields: ['pt-domains'],
        context: mutationContext,
      },
    });
    // The store's own record, so no external record reference.
    expect(triggerEvent.externalRecordRef).toBeUndefined();
  });

  it("skips a change kind outside the listen's `events`", async () => {
    const result = await queueKnowledgeChange({
      teamId: TEAM,
      envelope: companyChange({ changeKind: 'create' }),
      outboxId: 'o-2',
    });
    expect(result).toEqual({ queued: 0 });
    expect(enqueueWork).not.toHaveBeenCalled();
  });

  it("skips an update that touches none of the listen's `fields` (by name, through the adapter)", async () => {
    const result = await queueKnowledgeChange({
      teamId: TEAM,
      envelope: companyChange({ changedFields: ['pt-name'] }),
      outboxId: 'o-3',
    });
    expect(result).toEqual({ queued: 0 });
  });

  it('routes by the watched type: a person change wakes only the (pre-D40) person listen', async () => {
    const result = await queueKnowledgeChange({
      teamId: TEAM,
      envelope: companyChange({ recordId: COMPANY_NODE, nodeTypeId: 'nt-person', changeKind: 'create', changedFields: [] }),
      outboxId: 'o-4',
    });
    expect(result).toEqual({ queued: 1 });
    expect(queuedReceipts().map((r) => r.triggerId)).toEqual(['t-person']);
  });

  it('a redelivered outbox row is a duplicate receipt and queues nothing twice', async () => {
    await queueKnowledgeChange({ teamId: TEAM, envelope: companyChange(), outboxId: 'o-5' });
    enqueueWork.mockClear();
    const again = await queueKnowledgeChange({ teamId: TEAM, envelope: companyChange(), outboxId: 'o-5' });
    expect(again).toEqual({ queued: 0 });
  });

  it('a body that is not a change envelope queues nothing', async () => {
    const result = await queueKnowledgeChange({
      teamId: TEAM,
      envelope: { nope: true } as unknown as MutationEventEnvelope,
      outboxId: 'o-6',
    });
    expect(result).toEqual({ queued: 0 });
    expect(findTriggersByKind).not.toHaveBeenCalled();
  });
});

describe('the module manifest the platform lists the graph by', () => {
  it('declares its subscription methods only where the store POSTs its events', () => {
    expect(kgManifest({ changeWebhooks: false }).methods).not.toContain('ensureEventSubscription');
    expect(kgManifest({ changeWebhooks: true }).methods).toContain('ensureEventSubscription');
  });
});

// The previous release delivered an outbox row by calling the engine in the
// same process and persisted nothing of its own: no receipt, no work row. The
// only state an upgrade can catch mid-flight is the outbox row itself, still
// undelivered (perhaps retried), and its envelope has not changed shape. The new
// kind picks it up like any other row.
describe('an outbox row left undelivered by the previous release', () => {
  const { registerWorkKinds } = jest.requireMock('../../work/drain') as { registerWorkKinds: jest.Mock };
  const { drainOnce } = jest.requireMock('../../knowledge/mutation_outbox/worker') as { drainOnce: jest.Mock };

  const oldRow = { teamId: TEAM, envelope: companyChange(), outboxId: 'old-1' };
  type Drain = (input: { deliverLocally: (change: typeof oldRow) => Promise<void> }) => Promise<void>;

  async function runKind(): Promise<void> {
    registerKnowledgeChangeWork();
    const [[kinds]] = registerWorkKinds.mock.calls as [[Array<{ kind: string; handler: { run(): Promise<void> } }>]];
    expect(kinds.map((k) => k.kind)).toEqual(['knowledge_changes']);
    await kinds[0]!.handler.run();
  }

  it('is queued exactly once when the drain delivers it', async () => {
    drainOnce.mockImplementation(async ({ deliverLocally }: Parameters<Drain>[0]) => deliverLocally(oldRow));
    await runKind();
    expect(enqueueWork).toHaveBeenCalledTimes(1);
  });

  it('is still queued once when the drain dies after queueing and delivers it again', async () => {
    drainOnce.mockImplementation(async ({ deliverLocally }: Parameters<Drain>[0]) => deliverLocally(oldRow));
    await runKind();
    registerWorkKinds.mockClear();
    await runKind();
    expect(enqueueWork).toHaveBeenCalledTimes(1);
  });
});
