// The knowledge graph's change events take the inbound path every module's
// arrivals take: the `@lf/kg` module reads the store's envelope
// (`preprocessInbound`), and its arrivals are kept as one delivery of the
// graph's install, judged by every listen of the team on the graph, keyed on
// the outbox row so a redelivery keeps nothing twice. No movement runs here:
// the delivery queues a run row per listen it fires, which the drainer runs.
//
// Mocked: the module (its arrivals), the door's keeping of a delivery, and
// the work queue.

import type { Arrival } from 'engine-contracts';

jest.mock('../../translation_graph/adapters/resolve', () => ({ resolveAdapter: jest.fn() }));
jest.mock('../../inbound/listen_door', () => ({ deliverArrivals: jest.fn() }));
jest.mock('../../work/drain', () => ({ registerWorkKinds: jest.fn(), notifyWork: jest.fn() }));
jest.mock('../../knowledge/mutation_outbox/worker', () => ({ drainOnce: jest.fn() }));
// The team's connection to its graph, as the credentials table answers it.
const connection: { row: { id: string } | undefined } = { row: { id: 'cred-kg' } };
jest.mock('../../../lib/kysely', () => {
  const query = {
    selectFrom: () => query,
    where: () => query,
    orderBy: () => query,
    select: () => query,
    executeTakeFirst: async () => connection.row,
  };
  return { getAutomationsQb: () => query };
});

import { kgManifest } from '@listen-fire/kg';

import { queueKnowledgeChange, registerKnowledgeChangeWork } from '../knowledge_changes';

const { resolveAdapter } = jest.requireMock('../../translation_graph/adapters/resolve') as { resolveAdapter: jest.Mock };
const { deliverArrivals } = jest.requireMock('../../inbound/listen_door') as { deliverArrivals: jest.Mock };
const { notifyWork, registerWorkKinds } = jest.requireMock('../../work/drain') as { notifyWork: jest.Mock; registerWorkKinds: jest.Mock };
const { drainOnce } = jest.requireMock('../../knowledge/mutation_outbox/worker') as { drainOnce: jest.Mock };

const TEAM = '00000000-0000-0000-0000-000000000010';
const CHANGE: Arrival = {
  edge: 'Changes',
  key: 'company:c1',
  identity: 'change-1',
  landing: { recordId: 'c1', recordType: 'Company Change', fields: { Kind: 'updated' } },
};
const ENVELOPE = { kind: 'node.updated', nodeId: 'c1' };

let arrivals: Arrival[];
const preprocessInbound = jest.fn(async (_input: { raw: unknown }) => ({ events: [], arrivals }));

beforeEach(() => {
  jest.clearAllMocks();
  connection.row = { id: 'cred-kg' };
  arrivals = [CHANGE];
  resolveAdapter.mockResolvedValue({ adapterType: 'kg', preprocessInbound });
  deliverArrivals.mockResolvedValue({ kept: { kept: true, arrivalMark: 1 }, deliveryId: 'd1', fires: [{ runId: 'r1' }] });
});

describe('queueKnowledgeChange: a graph change through the inbound path', () => {
  it("keeps the module's arrivals as one delivery of the graph's install, keyed on the outbox row", async () => {
    const result = await queueKnowledgeChange({ teamId: TEAM, envelope: ENVELOPE as never, outboxId: 'ob-1' });

    expect(result).toEqual({ queued: 1 });
    expect(resolveAdapter).toHaveBeenCalledWith({ adapterType: 'kg', teamId: TEAM, credentialsId: 'cred-kg' });
    expect(preprocessInbound).toHaveBeenCalledWith({ raw: ENVELOPE });
    expect(deliverArrivals).toHaveBeenCalledWith({
      teamId: TEAM,
      delivered: { adapterType: 'kg', credentialsId: null },
      subscriptionId: 'KG_MUTATION',
      externalId: 'knowledge_outbox:ob-1',
      source: 'emit',
      arrivals: [CHANGE],
      // The change as the graph wrote it, so a replay reads it again.
      request: expect.objectContaining({
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(ENVELOPE), 'utf8').toString('base64'),
      }),
    });
    expect(notifyWork).toHaveBeenCalledTimes(1);
  });

  it('a change on a team with no connection to its graph keeps nothing, and reads nothing', async () => {
    connection.row = undefined;

    expect(await queueKnowledgeChange({ teamId: TEAM, envelope: ENVELOPE as never, outboxId: 'ob-4' })).toEqual({ queued: 0 });
    expect(resolveAdapter).not.toHaveBeenCalled();
    expect(deliverArrivals).not.toHaveBeenCalled();
  });

  it('a change the module reports no arrival for keeps nothing', async () => {
    arrivals = [];

    expect(await queueKnowledgeChange({ teamId: TEAM, envelope: ENVELOPE as never, outboxId: 'ob-2' })).toEqual({ queued: 0 });
    expect(deliverArrivals).not.toHaveBeenCalled();
  });

  it('a redelivered outbox row keeps nothing twice, and pokes no drain', async () => {
    deliverArrivals.mockResolvedValue({ kept: { kept: false }, deliveryId: 'd2', fires: [] });

    expect(await queueKnowledgeChange({ teamId: TEAM, envelope: ENVELOPE as never, outboxId: 'ob-1' })).toEqual({ queued: 0 });
    expect(notifyWork).not.toHaveBeenCalled();
  });
});

describe('the periodic kind', () => {
  it('hands each outbox row the drain delivers to the inbound path', async () => {
    drainOnce.mockImplementation(async ({ deliverLocally }: { deliverLocally: (change: unknown) => Promise<void> }) =>
      deliverLocally({ teamId: TEAM, envelope: ENVELOPE, outboxId: 'ob-3' }),
    );
    registerKnowledgeChangeWork();
    const [[kinds]] = registerWorkKinds.mock.calls as [[Array<{ kind: string; handler: { run(): Promise<void> } }>]];
    expect(kinds.map((k) => k.kind)).toEqual(['knowledge_changes']);

    await kinds[0]!.handler.run();

    expect(deliverArrivals).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'knowledge_outbox:ob-3' }));
  });
});

describe('the module manifest the platform lists the graph by', () => {
  it('declares its subscription methods only where the store POSTs its events', () => {
    expect(kgManifest({ changeWebhooks: false }).methods).not.toContain('ensureEventSubscription');
    expect(kgManifest({ changeWebhooks: true }).methods).toContain('ensureEventSubscription');
  });
});
