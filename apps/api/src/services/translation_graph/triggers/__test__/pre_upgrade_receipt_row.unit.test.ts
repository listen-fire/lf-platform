// A `dispatch_event` work row queued before the knowledge graph's receipts
// started recording `mutation` carries `triggerType: 'webhook'`. The row is
// self-describing: the drain runs it with the event exactly as stored, and the
// run is recorded under the type it names, so an old row neither fails to parse
// nor changes how it is dispatched.
//
// Mocked: the receipt/run lookups and the router.

const mockRows: { trigger_event?: { status: string }; trigger_run?: undefined } = {};
function chain(table: string): object {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (prop === 'executeTakeFirst') return async () => (table === 'trigger_event' ? mockRows.trigger_event : undefined);
        if (prop === 'execute') return async () => [];
        return () => chain(table);
      },
    },
  );
}
jest.mock('../../../../lib/kysely', () => ({
  getAutomationsQb: jest.fn((tables: string[]) => ({
    selectFrom: (table: string) => chain(table),
    updateTable: (table: string) => chain(table),
    [tables[0] ?? '']: undefined,
  })),
}));
jest.mock('../router', () => {
  const actual = jest.requireActual('../router');
  return { ...actual, dispatchTriggerByIdEvent: jest.fn(async () => ({ evaluations: [] })) };
});
jest.mock('../event_store', () => ({
  storeTriggerEvent: jest.fn(),
  markTriggerEventDispatched: jest.fn(),
  markTriggerEventFailed: jest.fn(),
  resetTriggerEventToReceived: jest.fn(),
  stampDroppedReason: jest.fn(),
}));
jest.mock('../../../work/store', () => ({ enqueueWork: jest.fn(), awaitTeamWorkSettled: jest.fn() }));
jest.mock('../../engine/platform_token_registry_db', () => ({ platformTokenRegistry: {} }));

import type { WorkContext } from '../../../work/kinds';

import { dispatchEventHandler } from '../dispatch_event';
import { dispatchTriggerByIdEvent, mapRecordingTriggerType } from '../router';

const dispatch = dispatchTriggerByIdEvent as jest.Mock;
const { markTriggerEventDispatched } = jest.requireMock('../event_store') as { markTriggerEventDispatched: jest.Mock };

const RECEIPT_ID = '00000000-0000-4000-8000-000000000001';
const TRIGGER = '00000000-0000-4000-8000-0000000000a1';
const TEAM = '00000000-0000-4000-8000-0000000000b1';

/** The row as the previous release queued it for a graph change. */
const preUpgradeRow = {
  triggerId: TRIGGER,
  teamId: TEAM,
  storedEventId: RECEIPT_ID,
  duplicate: false,
  triggerEvent: {
    pipelineInputId: `trigger:${TRIGGER}`,
    adapterType: 'kg',
    triggerType: 'webhook',
    payload: { recordId: 'r1', changeKind: 'update' },
    externalRecordRef: { adapterType: 'kg', externalId: 'r1' },
    occurredAt: '2026-10-19T10:00:00.000Z',
  },
};

const ctx: WorkContext = { now: new Date('2026-10-20T00:00:00.000Z') } as WorkContext;

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.trigger_event = { status: 'received' };
});

describe('draining a dispatch_event row written before the upgrade', () => {
  it("dispatches the event as stored, still typed 'webhook', and marks its receipt", async () => {
    await dispatchEventHandler.run(preUpgradeRow, ctx);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      triggerId: TRIGGER,
      storedEventId: RECEIPT_ID,
      event: { triggerType: 'webhook', externalRecordRef: { externalId: 'r1' } },
    });
    expect(markTriggerEventDispatched).toHaveBeenCalledWith(RECEIPT_ID);
  });

  it('is recorded under the type the row names, as before', () => {
    expect(mapRecordingTriggerType('webhook')).toBe('webhook');
    expect(mapRecordingTriggerType('mutation')).toBe('mutation');
  });

  it('a receipt already settled keeps its outcome and is not dispatched again', async () => {
    mockRows.trigger_event = { status: 'dispatched' };
    await dispatchEventHandler.run(preUpgradeRow, ctx);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
