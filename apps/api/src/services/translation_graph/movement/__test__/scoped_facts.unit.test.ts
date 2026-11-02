// Progressive describe must never STATE different facts than the full
// describe — only fewer (prod agent report, 2026-07-05). Two regressions:
//
//   1. eventPosition: scoped-to-Companies used to recompute the
//      single-readable heuristic over the scoped set of one and report
//      eventPosition: "Companies" — teaching an agent to type a listener
//      parameter (rec: <crm-[:Companies]->>) against the real event union.
//   2. Out-of-scope edge targets used to miss the displayName lookup and
//      leak raw internal ids ('attio:note') next to natural names —
//      unreadable and scope-dependent. Names are the program currency;
//      they never vary with scope.

import type { TeamId } from '../../../../generated/kysely/core/Team';

jest.mock('../../adapters/resolve', () => ({
  resolveAdapter: async () => ({
    listEntryPoints: async () => [
      { typeId: 'obj-companies', displayName: 'Companies', writable: true, readable: true },
      { typeId: 'obj-people', displayName: 'People', writable: true, readable: true },
      { typeId: 'attio:note', displayName: 'Note', writable: true, readable: false },
      {
        typeId: 'attio:webhook-event',
        displayName: 'Webhook Event',
        writable: false,
        readable: true,
        fires: true,
      },
    ],
    describe: async (typeId: string) => ({
      typeId,
      displayName: typeId === 'obj-companies' ? 'Companies' : typeId,
      fields: [
        { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: false },
      ],
      references:
        typeId === 'obj-companies'
          ? [
              { fieldId: 'people', targetTypeId: 'obj-people', cardinality: 'many', name: 'People' },
              { fieldId: 'notes', targetTypeId: 'attio:note', cardinality: 'many', name: 'notes' },
            ]
          : [],
    }),
  }),
}));

jest.mock('../../adapters/registry', () => ({
  getAdapterManifest: () => ({ methods: ['createRecord'] }),
}));

import { cachedAdapterInstance, clearIntrospectionCache } from '../instance_cache';

const base = { adapterType: 'attio', teamId: 'team-1' as TeamId };

beforeEach(() => clearIntrospectionCache());

describe('scoped describes state the same facts as full describes', () => {
  it('out-of-scope edge targets resolve to natural names, exactly as in the full describe', async () => {
    const scoped = await cachedAdapterInstance({ ...base, types: ['Companies'] });
    const edges = scoped.projection.schema.positions['Companies'].edges;
    // 'attio:note' (internal id ≠ natural name) and 'obj-people' both render
    // their displayNames despite neither being described in this scope.
    expect(edges['notes'].target).toBe('Note');
    expect(edges['People'].target).toBe('People');
  });

  it('the scoped response stays NARROW — fewer facts, never different ones', async () => {
    const scoped = await cachedAdapterInstance({ ...base, types: ['Companies'] });
    expect(Object.keys(scoped.projection.schema.positions)).toEqual(['Companies']);
  });
});
