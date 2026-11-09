// The nodes-then-per-node contract (2026-07-05): cachedAdapterInstance is an
// INCREMENTAL per-type accumulator. Pins:
//   - a scoped call describes ONLY the requested types (matched by typeId or
//     displayName) while the node list still enumerates everything;
//   - repeated scoped calls MERGE (no re-describe of already-described types);
//   - an unscoped call finishes the surface, reusing prior describes;
//   - per-type describe failures retry on the next request without poisoning
//     the entry list.

import type { TeamId } from '../../../../generated/kysely/core/Team';

const describeCalls: string[] = [];
let failOnce: string | null = null;
let unknownToAdapter: string | null = null;

jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: async () => ({
    listEntryPoints: async () => [
      { typeId: 'Companies', displayName: 'Companies', writable: true, readable: true },
      { typeId: 'People', displayName: 'People', writable: true, readable: true },
      { typeId: 'Notes', displayName: 'Notes', writable: true, readable: false },
    ],
    describe: async (typeId: string) => {
      describeCalls.push(typeId);
      if (failOnce === typeId) {
        failOnce = null;
        throw new Error(`flaky describe: ${typeId}`);
      }
      if (unknownToAdapter === typeId) return null;
      return {
        typeId,
        displayName: typeId,
        fields: [{ fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: false }],
        references: [],
      };
    },
  }),
}));

jest.mock('../../adapters/registry', () => ({
  getAdapterManifest: () => ({ methods: ['createRecord'] }),
}));

import { cachedAdapterInstance, clearIntrospectionCache } from '../instance_cache';

const base = { adapterType: 'attio', teamId: 'team-1' as TeamId, audience: { for: 'run' } as const };

beforeEach(() => {
  clearIntrospectionCache();
  describeCalls.length = 0;
  failOnce = null;
  unknownToAdapter = null;
});

// plans/2026-07-10-adapter-entry-positions/2_type_space.md — a type need not be
// published off the meta node to exist. Airtable's tables live behind their
// base and are reached by traversal; before this, `targets` could only ever
// narrow the entry list, so describe was never called for such a type and it
// was unreachable rather than merely undescribed.
describe('cachedAdapterInstance — types reached by traversal', () => {
  it('describes a requested type the meta node does not publish', async () => {
    const result = await cachedAdapterInstance({ ...base, types: ['CRM — Deals'] });

    // `__adapter_meta__` is the ROOT itself — the node the instance IS, and
    // where its collections declare what the source can do across them (D2).
    // It is not one of the surface's types, and it is described once.
    expect(describeCalls).toEqual(['__adapter_meta__', 'CRM — Deals']);
    expect(result.projection.schema.positions['CRM — Deals']).toBeDefined();
  });

  it('gives a traversed type a position but NO meta edge', async () => {
    const result = await cachedAdapterInstance({ ...base, types: ['CRM — Deals', 'Companies'] });

    // A published type is reachable off the root; a traversed one is reached
    // through its container, so claiming a collection would state a
    // reachability that doesn't exist.
    expect(result.projection.schema.collections.Companies).toEqual({ target: 'Companies' });
    expect(result.projection.schema.collections['CRM — Deals']).toBeUndefined();
  });

  it('never offers a traversed type as a top-level write root', async () => {
    const result = await cachedAdapterInstance({ ...base, types: ['CRM — Deals'] });

    // Writing one is the writable EDGE's business, not the meta root's.
    expect(result.projection.schema.writableRoots['CRM — Deals']).toBeUndefined();
  });

  it('leaves a name the adapter does not know simply absent', async () => {
    unknownToAdapter = 'Nonsense';
    const result = await cachedAdapterInstance({ ...base, types: ['Nonsense'] });

    expect(result.projection.schema.positions.Nonsense).toBeUndefined();
    // The node list is unharmed — an unknown name is not a broken instance.
    expect(result.entryPoints.map((e) => e.typeId)).toEqual(['Companies', 'People', 'Notes']);
  });

  it('still enumerates the full node list alongside a traversed type', async () => {
    const result = await cachedAdapterInstance({ ...base, types: ['CRM — Deals'] });

    expect(result.entryPoints.map((e) => e.typeId)).toEqual(['Companies', 'People', 'Notes']);
  });
});

describe('cachedAdapterInstance — scoped describes', () => {
  it('describes only the requested types; the node list stays complete', async () => {
    const result = await cachedAdapterInstance({ ...base, types: ['Companies'] });
    expect(describeCalls).toEqual(['__adapter_meta__', 'Companies']);
    expect(result.entryPoints.map((e) => e.typeId)).toEqual(['Companies', 'People', 'Notes']);
    expect([...result.introspection.descriptors.keys()]).toEqual(['Companies']);
  });

  it('merges across scoped calls and reuses prior describes for the full call', async () => {
    await cachedAdapterInstance({ ...base, types: ['Companies'] });
    await cachedAdapterInstance({ ...base, types: ['People'] });
    expect(describeCalls).toEqual(['__adapter_meta__', 'Companies', 'People']);

    const full = await cachedAdapterInstance(base);
    // Only the never-described type pays a new call.
    expect(describeCalls).toEqual(['__adapter_meta__', 'Companies', 'People', 'Notes']);
    expect([...full.introspection.descriptors.keys()].sort()).toEqual(['Companies', 'Notes', 'People']);
  });

  it('a failed per-type describe retries on the next request', async () => {
    failOnce = 'People';
    await expect(cachedAdapterInstance({ ...base, types: ['People'] })).rejects.toThrow(/flaky/);
    const retry = await cachedAdapterInstance({ ...base, types: ['People'] });
    expect([...retry.introspection.descriptors.keys()]).toEqual(['People']);
    expect(describeCalls).toEqual(['__adapter_meta__', 'People', 'People']);
  });
});
