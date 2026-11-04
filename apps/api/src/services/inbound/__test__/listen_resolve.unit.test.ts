// The platform host lists a listen's base members by its WHERE and keeps them
// (the records its `Changes` is subscribed under), re-lists on a clock or a
// pushed change, suspends over the scope limit, and keeps the records it had
// when a list fails — as listen-fire does (crates/lf/src/resolve.rs), judged
// by the engine's own judge.
//
// The plan is listen-fire's own `carried` conformance plan (a listen narrowed
// by base and table), so what fires a base is the engine's, not this file's.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { listenArrivalCasesSchema } from 'engine-contracts/conformance/listen_arrivals';
import { makeStablePosition } from 'movement-engine/public/catalog';

import type { ListenPlan } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { Resolution } from '../../lf_store/listens';
import type { SavedListen } from '../listen_door';

jest.mock('../../lf_store/listens', () => ({ claimResolve: jest.fn(), saveResolution: jest.fn(), states: jest.fn() }));
jest.mock('../../translation_graph/adapters/resolve', () => ({ resolveAdapter: jest.fn() }));
jest.mock('../../work/store', () => ({ enqueueWork: jest.fn() }));
jest.mock('../../work/drain', () => ({ registerWorkKinds: jest.fn() }));
jest.mock('../listen_door', () => ({ savedListenOf: jest.fn() }));

import { claimResolve as claimResolveImport, saveResolution as saveResolutionImport, states as statesImport } from '../../lf_store/listens';
import { resolveAdapter as resolveAdapterImport } from '../../translation_graph/adapters/resolve';
import { enqueueWork as enqueueWorkImport } from '../../work/store';
import { armResolveForArrivals, relistIntervalMs, resolveListen, resolvesListen } from '../listen_resolve';

const claimResolve = claimResolveImport as jest.Mock;
const saveResolution = saveResolutionImport as jest.Mock;
const states = statesImport as jest.Mock;
const resolveAdapter = resolveAdapterImport as jest.Mock;
const enqueueWork = enqueueWorkImport as jest.Mock;
const getRelated = jest.fn();

const corpusPath = join(dirname(require.resolve('engine-contracts/package.json')), 'dist/conformance/listen-arrivals.json');
const corpus = listenArrivalCasesSchema.parse(JSON.parse(readFileSync(corpusPath, 'utf-8')));
const CARRIED = corpus.plans.carried!.plan;

/** The `Bases` relist the Airtable module declares (`AIRTABLE_BASES_RELIST_SECONDS`). */
const BASES_RELIST_SECONDS = 3600;

function airtableListen(overrides: Partial<SavedListen> = {}): SavedListen {
  return {
    pipeline: 'listen:crm.lf:changed:0a1b2c3d',
    plan: CARRIED,
    awaits: { own: [], carried: {} },
    fieldIds: {},
    triggerId: 'trigger-air' as TriggerId,
    teamId: 'team-air' as TeamId,
    file: 'crm.lf',
    credentialsId: 'cred-air',
    delivery: { kind: 'scope', scopedBy: 'Bases' },
    resolvedHops: [
      { hop: 0, membersChange: { relistEverySeconds: BASES_RELIST_SECONDS }, delivery: undefined },
      { hop: 1, membersChange: 'pushed', delivery: 'scope' },
    ],
    ...overrides,
  };
}

/** A base as the module lists it off the root `Bases` edge. */
function base(id: string, name: string) {
  return { position: makeStablePosition({ adapterType: CARRIED.adapter, recordType: 'Base', recordId: id, data: { Name: name, Id: id } }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  claimResolve.mockResolvedValue({ token: 'hold-1' });
  saveResolution.mockResolvedValue(true);
  states.mockResolvedValue({});
  resolveAdapter.mockResolvedValue({ getRelated });
  enqueueWork.mockResolvedValue(undefined);
});

const savedResolution = (): Resolution => saveResolution.mock.calls[0]![1].resolution;

describe('listing a listen`s base members by its WHERE', () => {
  it('keeps the bases its WHERE fires, not the others, as the records it is subscribed under', async () => {
    getRelated.mockResolvedValue([base('appHiring', 'Hiring'), base('appFinance', 'Finance')]);

    await resolveListen(airtableListen());

    // The `carried` plan's Bases hop is `b.Name == "Hiring"`.
    expect(getRelated).toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'Bases', direction: 'outgoing' }));
    expect(savedResolution()).toMatchObject({ heads: ['appHiring'], failure: null });
    expect(savedResolution().resolvedAt).not.toBeNull();
  });

  it('holds the listen while it lists, so one process lists it at a time', async () => {
    claimResolve.mockResolvedValue(null);

    await resolveListen(airtableListen());

    expect(getRelated).not.toHaveBeenCalled();
    expect(saveResolution).not.toHaveBeenCalled();
  });

  it('suspends the listen by name when it matches more bases than the scope limit', async () => {
    // A base hop with no WHERE fires every base, so 501 overflow the limit of 500.
    const unnarrowed: ListenPlan = { ...CARRIED, hops: CARRIED.hops.map((hop, i) => (i === 0 ? { ...hop, taken: undefined, checked: undefined } : hop)) };
    getRelated.mockResolvedValue(Array.from({ length: 501 }, (_, i) => base(`app${i}`, `Base ${i}`)));

    await resolveListen(airtableListen({ plan: unnarrowed }));

    expect(savedResolution().heads).toEqual([]);
    expect(savedResolution().failure).toMatch(/^LISTEN_SCOPE_LIMIT: crm\.lf:changed matched more Bases than its limit of 500/);
  });

  it('keeps the bases it had when a list fails', async () => {
    states.mockResolvedValue({ 'listen:crm.lf:changed:0a1b2c3d': { heads: ['appOld'], resolvedAt: '2026-10-31T09:00:00.000Z', failure: null, paused: null, held: 0 } });
    getRelated.mockRejectedValue(new Error('Airtable is down'));

    await resolveListen(airtableListen());

    expect(savedResolution()).toMatchObject({ heads: ['appOld'], resolvedAt: '2026-10-31T09:00:00.000Z' });
    expect(savedResolution().failure).toBe('LISTEN_RESOLVE_FAILED: crm.lf:changed could not list the records it watches: Airtable is down');
  });

  it('writes nothing when the hold lapsed and was taken since', async () => {
    getRelated.mockResolvedValue([base('appHiring', 'Hiring')]);
    saveResolution.mockResolvedValue(false);

    await expect(resolveListen(airtableListen())).resolves.toBeNull();
  });
});

describe('when a listen is listed again', () => {
  it('names the clock interval as the shortest relistEverySeconds its resolved hops declare', () => {
    expect(relistIntervalMs(airtableListen())).toBe(BASES_RELIST_SECONDS * 1000);
  });

  it('has no clock interval when no resolved hop declares one (its changes are pushed)', () => {
    const pushedOnly = airtableListen({ resolvedHops: [{ hop: 0, membersChange: 'pushed' }] });
    expect(relistIntervalMs(pushedOnly)).toBeUndefined();
  });

  it('is listed again when a change is pushed on a resolved hop`s own edge', async () => {
    await armResolveForArrivals({ edges: ['Tables'], listens: [airtableListen()] });

    expect(enqueueWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'resolve_listen', key: 'resolve_listen:listen:crm.lf:changed:0a1b2c3d', teamId: 'team-air' }),
    );
  });

  it('is not listed again by an arrival on its own last edge (a row change, not a member change)', async () => {
    await armResolveForArrivals({ edges: ['Changes'], listens: [airtableListen()] });

    expect(enqueueWork).not.toHaveBeenCalled();
  });
});

describe('resolvesListen', () => {
  it('is true for a listen with a resolved hop, false for one with none', () => {
    expect(resolvesListen(airtableListen())).toBe(true);
    expect(resolvesListen({ resolvedHops: [] })).toBe(false);
    expect(resolvesListen({ members: [{ resolvedHops: [{ hop: 0 }] }] })).toBe(true);
  });
});
