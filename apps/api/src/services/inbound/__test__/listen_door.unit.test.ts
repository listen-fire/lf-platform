// The door's judging: each arrival of a delivery judged against every listen
// its team saved on the module, by the engine's judge, with what the platform
// adds around it: a connection's delivery is only its own listens', an
// undecided verdict is kept as a fact naming the module and what landed, and
// a listen whose landing node cannot be read runs nothing, said once. A
// filter that calls a host function asks it, and a listen whose host could
// not answer keeps that arrival, and every later one it would run, waiting.
//
// The plan and arrivals are listen-fire's own conformance cases (the lunch
// poll of `listen-arrivals.json`), so the verdicts are the engine's, not this
// file's.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { arrivalReceiptKey } from 'movement-engine/public/inbound';
import { listenArrivalCasesSchema } from 'engine-contracts/conformance/listen_arrivals';
import { listenPlanSchema } from 'engine-contracts';

import type { Arrival, PluginAnswers, PluginQuestion } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';

jest.mock('../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));
jest.mock('../../translation_graph/adapters/registry', () => ({ getAdapterManifest: jest.fn() }));
jest.mock('../../translation_graph/adapters/resolve', () => ({ resolveAdapter: jest.fn() }));
jest.mock('../../movement_engine/run_host_deliveries', () => ({ deliveryRowStore: jest.fn() }));
jest.mock('../platform_plugin_answers', () => ({ platformHostAnswers: jest.fn() }));
jest.mock('../../lf_store/records_door', () => ({ waitingListens: jest.fn() }));

import { judgeArrivals, WAITING_BEHIND, type JudgeHost, type SavedListen } from '../listen_door';
import { HostFunctionRefused } from '../plugin_answers';

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
  it('mints a run for each listen an arrival fires, under the arrival`s receipt', async () => {
    const saved = listen();
    const arrival = arrivalOf(FIRES);

    const judged = await judgeArrivals({ listens: [saved], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrival], now: NOW });

    expect(judged.minted).toEqual([
      { listen: saved, arrival, index: 0, runId: expect.stringMatching(/^[0-9a-f-]{36}$/), receipt: arrivalReceiptKey(arrival) },
    ]);
    expect(judged.unjudged).toEqual([]);
    expect(judged.lines).toEqual([]);
  });

  it('a delivery`s arrivals are judged by the filter alone: whoever sent what it takes starts a run', async () => {
    const saved = listen();
    const arrivals = [arrivalOf(FIRES, 'press-1'), arrivalOf(FIRES, 'press-2')];

    const judged = await judgeArrivals({ listens: [saved], delivery: { adapterType: 'chat', credentialsId: null }, arrivals, now: NOW });

    expect(judged.minted.map((run) => run.receipt)).toEqual(arrivals.map((arrival) => arrivalReceiptKey(arrival)));
    expect(judged).toMatchObject({ unjudged: [], lines: [] });
    expect(judged).not.toHaveProperty('refused');
  });

  it('runs nothing and says nothing for an arrival its filters skip', async () => {
    const judged = await judgeArrivals({ listens: [listen()], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrivalOf(SKIPS)], now: NOW });

    expect(judged).toEqual({ minted: [], unjudged: [], lines: [] });
  });

  it('keeps an undecided verdict as a fact naming the module and what landed, and runs nothing', async () => {
    const saved = listen();
    const arrival = arrivalOf(UNDECIDED);

    const judged = await judgeArrivals({ listens: [saved], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrival], now: NOW });

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
        waiting: false,
      },
    ]);
    expect(judged.lines).toEqual([
      "polls.lf:tally: an arrival on Interactions cannot be judged (the arrival carries no Messages record, which this listen's filter on it reads): it runs nothing",
    ]);
  });

  it('a replay`s facts carry its attempt', async () => {
    const judged = await judgeArrivals({ listens: [listen()], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrivalOf(UNDECIDED)], now: NOW, attempt: 2 });

    expect(judged.unjudged.map((u) => u.fact.attempt)).toEqual([2]);
  });

  it('a connection`s delivery is heard by its own listens and those of no connection, never another`s', async () => {
    const own = listen({ credentialsId: 'cred-a' });
    const other = listen({ credentialsId: 'cred-b' });
    const install = listen({ credentialsId: null });

    const judged = await judgeArrivals({ listens: [own, other, install], delivery: { adapterType: 'chat', credentialsId: 'cred-a' }, arrivals: [arrivalOf(FIRES)], now: NOW });

    expect(judged.minted.map((run) => run.listen)).toEqual([own, install]);
  });

  it('an install`s delivery is heard by every connection`s listens', async () => {
    const judged = await judgeArrivals({
      listens: [listen({ credentialsId: 'cred-a' }), listen({ credentialsId: 'cred-b' })],
      delivery: { adapterType: 'chat', credentialsId: null },
      arrivals: [arrivalOf(FIRES)],
      now: NOW,
    });

    expect(judged.minted).toHaveLength(2);
  });

  it('an arrival on another module is not the listen`s to judge', async () => {
    const judged = await judgeArrivals({ listens: [listen()], delivery: { adapterType: 'mail', credentialsId: null }, arrivals: [arrivalOf(FIRES)], now: NOW });

    expect(judged).toEqual({ minted: [], unjudged: [], lines: [] });
  });

  it('a gone record fires nothing, and each arrival keeps its place in the delivery', async () => {
    const arrival = arrivalOf(FIRES);
    const gone: Arrival = { edge: 'Interactions', key: 't0', gone: true };

    const judged = await judgeArrivals({ listens: [listen()], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [gone, arrival], now: NOW });

    expect(judged.minted.map((run) => run.index)).toEqual([1]);
  });

  it('a listen whose landing node cannot be read runs nothing, said once per delivery', async () => {
    const unread = listen({ landing: { unread: 'the node is imported from lib/polls' } });

    const judged = await judgeArrivals({
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

// A filter that calls `team.isMember` (the conformance corpus's `insiders`
// plan: `m.Channel == "C1" AND m.Name != "bot" AND team.isMember(m.`User
// Email`)`), its function named by the platform's catalog key.
describe('a filter that asks the team`s functions', () => {
  const IS_MEMBER = '@lf-platform/team/is_member';
  const insiders = listenPlanSchema.parse(JSON.parse(JSON.stringify(corpus.plans.insiders!.plan).replaceAll('@lf-platform/team/isMember', IS_MEMBER)));
  const team = randomUUID() as TeamId;
  const ask = (saved: SavedListen) => ({ listens: [saved], delivery: { adapterType: 'talk', credentialsId: null }, now: NOW });

  const insider = (overrides: Partial<SavedListen> = {}): SavedListen =>
    listen({ pipeline: 'listen:team.lf:greet:1f2e3d4c', plan: insiders, file: 'team.lf', teamId: team, ...overrides });

  function message(id: string, email: string, name = 'ann'): Exclude<Arrival, { gone: true }> {
    return { edge: 'Messages', identity: id, landing: { recordId: id, recordType: 'Message', fields: { Id: id, Channel: 'C1', Name: name, 'User Email': email } } };
  }

  /** A host whose members are `members`; `refuse` answers each question its way first. */
  function hostOf(input: { members?: string[]; waiting?: string[]; refuse?: Array<() => Error> } = {}) {
    const refusals = [...(input.refuse ?? [])];
    const answers = jest.fn(async (_team: TeamId, questions: PluginQuestion[]): Promise<PluginAnswers> => {
      const refusal = refusals.shift();
      if (refusal !== undefined) throw refusal();
      return questions.map((question) => ({ ...question, value: (input.members ?? []).includes(String(question.args[0])) }));
    });
    const waiting = jest.fn(async () => new Set(input.waiting ?? []));
    const host: JudgeHost = { answers, waiting };
    return { host, answers, waiting };
  }

  const unreachable = () => new Error('the change feed is not listening');

  it('a_member_sets_the_listen_off', async () => {
    const saved = insider();
    const { host, answers } = hostOf({ members: ['ada@acme.com'] });

    const judged = await judgeArrivals({ ...ask(saved), arrivals: [message('m1', 'ada@acme.com')], host });

    expect(judged.minted.map((run) => run.arrival.identity)).toEqual(['m1']);
    expect(judged).toMatchObject({ unjudged: [], lines: [] });
    expect(answers).toHaveBeenCalledWith(team, [{ plugin: IS_MEMBER, args: ['ada@acme.com'] }]);
  });

  it('a_stranger_does_not_and_nothing_is_kept_for_the_listen', async () => {
    const { host } = hostOf({ members: ['ada@acme.com'] });

    const judged = await judgeArrivals({ ...ask(insider()), arrivals: [message('m1', 'eve@elsewhere.com')], host });

    expect(judged).toEqual({ minted: [], unjudged: [], lines: [] });
  });

  it('a local term that fails asks the host nothing', async () => {
    const { host, answers } = hostOf({ members: ['ada@acme.com'] });

    const judged = await judgeArrivals({ ...ask(insider()), arrivals: [message('m1', 'ada@acme.com', 'bot')], host });

    expect(judged).toEqual({ minted: [], unjudged: [], lines: [] });
    expect(answers).not.toHaveBeenCalled();
  });

  it('an unreachable host keeps the arrival waiting, naming the function, and runs nothing', async () => {
    const saved = insider();
    const { host } = hostOf({ members: ['ada@acme.com'], refuse: [unreachable] });

    const judged = await judgeArrivals({ ...ask(saved), arrivals: [message('m1', 'ada@acme.com')], host });

    const reason = `the host could not answer ${IS_MEMBER} (the change feed is not listening), which this listen's filter on Messages calls`;
    expect(judged.minted).toEqual([]);
    expect(judged.unjudged.map((u) => u.fact)).toEqual([expect.objectContaining({ pipeline: saved.pipeline, reason, waiting: true, attempt: 0 })]);
    expect(judged.lines).toEqual([`team.lf:greet: an arrival on Messages waits for its host (${reason}): it runs nothing yet`]);
  });

  it('a module that answers an error leaves its arrival unjudged, not waiting, and holds nothing behind it', async () => {
    const { host } = hostOf({ members: ['ada@acme.com'], refuse: [() => new HostFunctionRefused(IS_MEMBER, 'a claim is text')] });

    const judged = await judgeArrivals({ ...ask(insider()), arrivals: [message('m1', 'ada@acme.com'), message('m2', 'ada@acme.com')], host });

    expect(judged.unjudged.map((u) => u.fact)).toEqual([
      expect.objectContaining({ reason: `${IS_MEMBER}, which this listen's filter calls, answered an error (a claim is text)`, waiting: false }),
    ]);
    expect(judged.minted.map((run) => run.arrival.identity)).toEqual(['m2']);
  });

  it('later_arrivals_wait_behind_an_unjudged_one', async () => {
    const saved = insider();
    const { host, answers } = hostOf({ members: ['ada@acme.com', 'bo@acme.com'], refuse: [unreachable] });
    const arrivals = [message('m1', 'ada@acme.com'), message('m2', 'bo@acme.com'), message('m3', 'cy@acme.com', 'bot'), message('m4', 'ada@acme.com')];

    const judged = await judgeArrivals({ ...ask(saved), arrivals, host });

    expect(judged.minted).toEqual([]);
    // The bot's message is skipped by a local term: it has no place to keep.
    expect(judged.unjudged.map((u) => [u.arrival.identity, u.fact.waiting, u.fact.reason === WAITING_BEHIND])).toEqual([
      ['m1', true, false],
      ['m2', true, true],
      ['m4', true, true],
    ]);
    expect(answers).toHaveBeenCalledTimes(1);
  });

  it('an arrival waits behind one an earlier delivery left waiting, asking nothing', async () => {
    const saved = insider();
    const { host, answers, waiting } = hostOf({ members: ['ada@acme.com'], waiting: [saved.pipeline] });

    const judged = await judgeArrivals({ ...ask(saved), arrivals: [message('m5', 'ada@acme.com')], host });

    expect(judged.unjudged.map((u) => [u.fact.reason, u.fact.waiting])).toEqual([[WAITING_BEHIND, true]]);
    expect(answers).not.toHaveBeenCalled();
    expect(waiting).toHaveBeenCalledWith(team, [saved.pipeline]);
  });

  it('a replay judges an arrival as it stands, never behind another', async () => {
    const saved = insider();
    const { host, waiting } = hostOf({ members: ['ada@acme.com'], waiting: [saved.pipeline] });

    const judged = await judgeArrivals({ ...ask(saved), arrivals: [message('m1', 'ada@acme.com')], host, replaying: true });

    expect(judged.minted.map((run) => run.arrival.identity)).toEqual(['m1']);
    expect(waiting).not.toHaveBeenCalled();
  });

  it('a listen whose filter asks nothing of its host reads no line', async () => {
    const { host, waiting } = hostOf();

    await judgeArrivals({ listens: [listen()], delivery: { adapterType: 'chat', credentialsId: null }, arrivals: [arrivalOf(FIRES)], now: NOW, host });

    expect(waiting).not.toHaveBeenCalled();
  });

  it('asks at most once per host call its filter holds, and judges once more', async () => {
    // A host that answers another question than it was asked: the judge asks again.
    const answers = jest.fn(async (_team: TeamId, questions: PluginQuestion[]): Promise<PluginAnswers> =>
      questions.map((question) => ({ ...question, args: ['someone@else.com'], value: true })),
    );
    const host: JudgeHost = { answers, waiting: async () => new Set() };

    const judged = await judgeArrivals({ ...ask(insider()), arrivals: [message('m1', 'ada@acme.com')], host });

    expect(answers).toHaveBeenCalledTimes(1);
    expect(judged.minted).toEqual([]);
    expect(judged.unjudged.map((u) => [u.fact.reason, u.fact.waiting])).toEqual([
      ['its filter still asks its host after 2 judgements, more than the 1 host calls it holds', false],
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

  it('fires under the base and table the listen names', async () => {
    const judged = await judgeArrivals({
      listens: [air()],
      delivery: { adapterType: 'air', credentialsId: null },
      arrivals: [change('a change carrying its base and table fires: a hop the host lists is judged on the record the arrival carries for it')],
      now: NOW,
    });
    expect(judged.minted).toHaveLength(1);
  });

  it('skips a change under another table', async () => {
    const judged = await judgeArrivals({
      listens: [air()],
      delivery: { adapterType: 'air', credentialsId: null },
      arrivals: [change('a change carrying a table of another name skips at Tables')],
      now: NOW,
    });
    expect(judged.minted).toEqual([]);
    expect(judged.lines).toEqual([]);
  });
});
