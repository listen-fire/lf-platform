// The door's judging: each arrival of a delivery judged against every listen
// its team saved on the module, by the engine's judge, with what the platform
// adds around it: a connection's delivery is only its own listens', an
// undecided verdict is kept as a fact naming the module and what landed, and
// a listen whose landing node cannot be read runs nothing, said once.
//
// The plan and arrivals are listen-fire's own conformance cases (the lunch
// poll of `listen-arrivals.json`), so the verdicts are the engine's, not this
// file's.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { arrivalReceiptKey } from 'movement-engine/public/inbound';
import { listenArrivalCasesSchema } from 'engine-contracts/conformance/listen_arrivals';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

jest.mock('../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));
jest.mock('../../translation_graph/adapters/registry', () => ({ getAdapterManifest: jest.fn() }));
jest.mock('../../translation_graph/adapters/resolve', () => ({ resolveAdapter: jest.fn() }));
jest.mock('../../movement_engine/run_host_deliveries', () => ({ deliveryRowStore: jest.fn() }));

import { judgeArrivals, type SavedListen } from '../listen_door';

const corpusPath = join(dirname(require.resolve('engine-contracts/package.json')), 'dist/conformance/listen-arrivals.json');
const corpus = listenArrivalCasesSchema.parse(JSON.parse(readFileSync(corpusPath, 'utf-8')));
const lunch = corpus.plans.lunch!.plan;
const NOW = new Date('2026-10-31T10:00:00Z');

function listen(overrides: Partial<SavedListen> = {}): SavedListen {
  return {
    pipeline: 'listen:polls.lf:tally:0a1b2c3d',
    plan: lunch,
    awaits: { own: [], carried: {} },
    fieldIds: {},
    triggerId: randomUUID() as TriggerId,
    teamId: randomUUID() as TeamId,
    file: 'polls.lf',
    credentialsId: null,
    ...overrides,
  };
}

/** A conformance case's arrival, as a module reports it: with its identity. */
function arrivalOf(caseName: string, identity = 'press-1'): Exclude<Arrival, { gone: true }> {
  const found = corpus.cases.find((c) => c.case === caseName);
  if (found === undefined) throw new Error(`no conformance case '${caseName}'`);
  return { ...found.arrival, identity } as Exclude<Arrival, { gone: true }>;
}

const FIRES = 'a press on a lunch poll fires';
const SKIPS = 'a press on a poll older than 3d skips at Messages';
const UNDECIDED = 'a press carrying no message is undecided';

describe('judgeArrivals', () => {
  it('mints a run for each listen an arrival fires, under the arrival`s receipt', () => {
    const saved = listen();
    const arrival = arrivalOf(FIRES);

    const judged = judgeArrivals({ listens: [saved], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrival], now: NOW });

    expect(judged.minted).toEqual([
      { listen: saved, arrival, index: 0, runId: expect.stringMatching(/^[0-9a-f-]{36}$/), receipt: arrivalReceiptKey(arrival) },
    ]);
    expect(judged.unjudged).toEqual([]);
    expect(judged.lines).toEqual([]);
  });

  it('a delivery`s arrivals are judged by the filter alone: whoever sent what it takes starts a run', () => {
    const saved = listen();
    const arrivals = [arrivalOf(FIRES, 'press-1'), arrivalOf(FIRES, 'press-2')];

    const judged = judgeArrivals({ listens: [saved], delivery: { adapterType: 'chat', credentialsId: null }, arrivals, now: NOW });

    expect(judged.minted.map((run) => run.receipt)).toEqual(arrivals.map((arrival) => arrivalReceiptKey(arrival)));
    expect(judged).toMatchObject({ unjudged: [], lines: [] });
    expect(judged).not.toHaveProperty('refused');
  });

  it('runs nothing and says nothing for an arrival its filters skip', () => {
    const judged = judgeArrivals({ listens: [listen()], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrivalOf(SKIPS)], now: NOW });

    expect(judged).toEqual({ minted: [], unjudged: [], lines: [] });
  });

  it('keeps an undecided verdict as a fact naming the module and what landed, and runs nothing', () => {
    const saved = listen();
    const arrival = arrivalOf(UNDECIDED);

    const judged = judgeArrivals({ listens: [saved], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrival], now: NOW });

    expect(judged.minted).toEqual([]);
    expect(judged.unjudged.map((u) => u.listen)).toEqual([saved]);
    expect(judged.unjudged.map((u) => u.arrival)).toEqual([arrival]);
    expect(judged.unjudged.map((u) => u.fact)).toEqual([
      {
        pipeline: saved.pipeline,
        arrival: arrivalReceiptKey(arrival),
        file: 'polls.lf',
        movement: 'tally',
        edge: 'Interactions',
        adapter: 'chat',
        recordId: null,
        landing: arrival.landing,
        reason: "the arrival carries no Messages record, which this listen's filter on it reads",
        at: NOW.toISOString(),
        attempt: 0,
      },
    ]);
    expect(judged.lines).toEqual([
      "polls.lf:tally: an arrival on Interactions cannot be judged (the arrival carries no Messages record, which this listen's filter on it reads): it runs nothing",
    ]);
  });

  it('keeps an arrival whose filter asks a host function as an unjudged fact with the reason, and runs nothing', () => {
    const found = corpus.cases.find((c) => c.plan === 'insiders' && 'asks' in c.verdict);
    if (found === undefined) throw new Error('no conformance case where the insiders plan asks the host');
    const saved = listen({ plan: corpus.plans.insiders!.plan });
    const arrival = { ...found.arrival, identity: 'press-1' } as Exclude<Arrival, { gone: true }>;
    const reason = 'its filter asks the host function @lf-platform/team/isMember, which this platform does not answer yet';

    const judged = judgeArrivals({ listens: [saved], delivery: { adapterType: 'talk', credentialsId: null }, arrivals: [arrival], now: NOW });

    expect(judged.minted).toEqual([]);
    expect(judged.unjudged.map((u) => u.fact.reason)).toEqual([reason]);
    expect(judged.unjudged).toHaveLength(1);
    expect(judged.lines).toEqual([`polls.lf:${saved.plan.movement}: an arrival on ${arrival.edge} cannot be judged (${reason}): it runs nothing`]);
  });

  it('a replay`s facts carry its attempt', () => {
    const judged = judgeArrivals({ listens: [listen()], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrivalOf(UNDECIDED)], now: NOW, attempt: 2 });

    expect(judged.unjudged.map((u) => u.fact.attempt)).toEqual([2]);
  });

  it('a connection`s delivery is heard by its own listens and those of no connection, never another`s', () => {
    const own = listen({ credentialsId: 'cred-a' });
    const other = listen({ credentialsId: 'cred-b' });
    const install = listen({ credentialsId: null });

    const judged = judgeArrivals({ listens: [own, other, install], delivery: { adapterType: 'chat', credentialsId: 'cred-a' }, arrivals: [arrivalOf(FIRES)], now: NOW });

    expect(judged.minted.map((run) => run.listen)).toEqual([own, install]);
  });

  it('an install`s delivery is heard by every connection`s listens', () => {
    const judged = judgeArrivals({
      listens: [listen({ credentialsId: 'cred-a' }), listen({ credentialsId: 'cred-b' })],
      delivery: { adapterType: 'chat', credentialsId: null },
      arrivals: [arrivalOf(FIRES)],
      now: NOW,
    });

    expect(judged.minted).toHaveLength(2);
  });

  it('an arrival on another module is not the listen`s to judge', () => {
    const judged = judgeArrivals({ listens: [listen()], delivery: { adapterType: 'mail', credentialsId: null }, arrivals: [arrivalOf(FIRES)], now: NOW });

    expect(judged).toEqual({ minted: [], unjudged: [], lines: [] });
  });

  it('a gone record fires nothing, and each arrival keeps its place in the delivery', () => {
    const arrival = arrivalOf(FIRES);
    const gone: Arrival = { edge: 'Interactions', key: 't0', gone: true };

    const judged = judgeArrivals({ listens: [listen()], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [gone, arrival], now: NOW });

    expect(judged.minted.map((run) => run.index)).toEqual([1]);
  });

  it('a listen whose landing node cannot be read runs nothing, said once per delivery', () => {
    const unread = listen({ landing: { unread: 'the node is imported from lib/polls' } });

    const judged = judgeArrivals({
      listens: [unread],
      delivery: { adapterType: 'chat', credentialsId: null },
      arrivals: [arrivalOf(FIRES, 'press-1'), arrivalOf(FIRES, 'press-2')],
      now: NOW,
    });

    expect(judged.minted).toEqual([]);
    expect(judged.lines).toEqual([
      'polls.lf:tally: an arrival on Interactions cannot be checked against the node its listen states (the node is imported from lib/polls): it runs nothing',
    ]);
  });
});

// A listen narrowed by base and table (`at-[b:Bases WHERE b.Name == "Hiring"]
// ->-[t:Tables WHERE t.Name == "Deals"]->-[x:Changes]->`): its base and table
// hops are listed to subscribe per base (listen_resolve.ts), but the judge
// fires each arrival from the base and table it carries. The door needs no
// knowledge of the resolution to fire — the engine's `carries` does it.
describe('a base-and-table-narrowed Airtable listen is judged from what the arrival carries', () => {
  const carried = corpus.plans.carried!.plan;
  const air = (): SavedListen => listen({ pipeline: 'listen:crm.lf:changed:00', plan: carried, file: 'crm.lf' });
  const change = (caseName: string): Exclude<Arrival, { gone: true }> => {
    const found = corpus.cases.find((c) => c.plan === 'carried' && c.case === caseName);
    if (found === undefined) throw new Error(`no carried conformance case '${caseName}'`);
    return { ...found.arrival, identity: 'c1' } as Exclude<Arrival, { gone: true }>;
  };

  it('fires under the base and table the listen names', () => {
    const judged = judgeArrivals({
      listens: [air()],
      delivery: { adapterType: 'air', credentialsId: null },
      arrivals: [change('a change carrying its base and table fires: a hop the host lists is judged on the record the arrival carries for it')],
      now: NOW,
    });
    expect(judged.minted).toHaveLength(1);
  });

  it('skips a change under another table', () => {
    const judged = judgeArrivals({
      listens: [air()],
      delivery: { adapterType: 'air', credentialsId: null },
      arrivals: [change('a change carrying a table of another name skips at Tables')],
      now: NOW,
    });
    expect(judged.minted).toEqual([]);
    expect(judged.lines).toEqual([]);
  });
});
