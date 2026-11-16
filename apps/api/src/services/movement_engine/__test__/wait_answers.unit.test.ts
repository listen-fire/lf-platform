// A wait whose WHERE calls the team's function, on the real engine: it asks the
// platform's kept answers (`llm.transforms.answer`). While they cannot be
// reached the wait's arrival is left unjudged and the run stays parked, woken
// again a retry interval on; once they answer, the wake judges it and the run
// goes on. A module's own error fails the run.

jest.mock('../../inbound/platform_plugin_answers', () => ({ platformHostAnswers: jest.fn() }));

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { makeStablePosition } from 'engine-contracts/catalog';
import { makeFakeParkSink, makeTestHost, type TestHostOverrides } from 'movement-engine/public/testing';
import { containerAssociation, type Adapter } from 'movement-engine/public/adapter';

import type { LoggedArrival, PluginAnswers, PluginQuestion } from 'engine-contracts';
import type { ParkedScopeState } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';

import { platformPluginModules } from '../../translation_graph/adapters/builtin_modules';
import { platformPluginSpecs, snapshotPluginSpecs } from '../../translation_graph/movement/plugin_specs';
import { tenantOfTeam } from '../../translation_graph/movement/tenant';
import { HostFunctionRefused, RETRY_UNJUDGED_EVERY_MS } from '../../inbound/plugin_answers';
import { resumeMovement, runMovement } from '../dispatch/dispatch';
import { hostRetryWakeKey, runHostAnswers, type WaitWakeRow } from '../host_answers';

const TEAM = '00000000-0000-0000-0000-0000000000f4' as TeamId;
const RUN_ID = 'run-f4';
const NOW = Date.parse('2026-11-13T10:00:00.000Z');
const IS_MEMBER = '@lf-platform/team/is_member';

const chat: InstanceSchema = {
  positions: {
    Message: {
      properties: { Id: 'text', Text: 'text', 'User Email': { kind: 'branded', of: 'text', brands: ['claim:email/address'] } },
      edges: { Replies: { target: 'Message', listenable: true, sequenced: 'chronological', identity: 'Id' } },
    },
  },
  collections: { messages: { target: 'Message' } },
  writableRoots: {},
};
const catalog = mockCatalogSnapshot({
  adapters: { chat: { constructionArgs: [], schema: chat } },
  plugins: snapshotPluginSpecs(platformPluginSpecs({ modules: platformPluginModules() })),
});
const SOURCE = [
  'import { chat } from adapters',
  'import { `@lf-platform/team` as team } from plugins',
  'c = connect chat',
  'function waiter(e: <c-[:messages]->>) {',
  '  msg = only(c-[:messages]->)',
  '  if (msg != null) {',
  '    r = await msg-[x:Replies WHERE team.isMember(x.`User Email`)]->',
  '    return r.Id',
  '  }',
  '}',
].join('\n');

const REPLY_FIELDS: Record<string, unknown> = { Id: 'r1', Text: 'hi', 'User Email': 'carol@acme.com' };
const reply: LoggedArrival = { seq: 42, identity: 'r1', landing: { recordId: 'r1', recordType: 'Message', fields: REPLY_FIELDS } };

const quietChat: Adapter = {
  adapterType: 'chat',
  supportedTriggers: [],
  runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
  listEntryPoints: async () => [],
  describe: async () => null,
  resolveEntity: async () => ({ candidates: [] }),
  // The one record whose fields are read is the reply that landed.
  getFieldValue: async ({ fieldId }) => REPLY_FIELDS[fieldId] ?? null,
  getRelated: async (read) =>
    read.fieldId === 'messages' ? [{ position: makeStablePosition({ adapterType: 'chat', recordType: 'Message', recordId: 'm-1' }) }] : [],
  createRecord: async () => ({ adapterType: 'chat', externalId: 'x', data: {} }),
  updateRecord: async (input) => ({ adapterType: 'chat', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
  deleteRecord: async () => ({}),
  arrivals: { awaitKeys: async ({ heads }) => heads.map((head) => ({ key: `thread:${head.recordId}` })) },
};

/** The team's answers: out of reach while `down`, refused while `refusing`. */
function teamAnswers(state: { down: boolean; refusing?: boolean; members: string[] }) {
  const asked: PluginQuestion[][] = [];
  const answers = async (_team: TeamId, questions: PluginQuestion[]): Promise<PluginAnswers> => {
    asked.push(questions);
    if (state.refusing === true) throw new HostFunctionRefused(IS_MEMBER, 'the directory refused this address');
    if (state.down) throw new Error('the change feed is not listening');
    return questions.map((question) => ({ ...question, value: state.members.includes(String(question.args[0])) }));
  };
  return { asked, answers };
}

/** One run step's host, as the production host builds one: the answers and
 *  the parks it notes, over a fake sink and the wait's logged arrivals. */
function stepHost(answers: ReturnType<typeof teamAnswers>['answers']) {
  const queued: WaitWakeRow[] = [];
  const noted: Array<{ identity: string; matched: boolean }> = [];
  const parks = makeFakeParkSink();
  const answering = runHostAnswers({ teamId: TEAM, runId: RUN_ID, answers, queue: async (row) => void queued.push(row), now: () => NOW });
  const plain = makeTestHost();
  const park: NonNullable<TestHostOverrides['park']> = {
    sink: answering.noting(parks.sink),
    waits: {
      mark: async () => ({ mark: 41 }),
      open: async (input) => ({ waitId: 'key' in input ? `wait:${input.key}` : 'wait:gone' }),
      arrivals: async () => ({ arrivals: [reply] }),
      note: async (input) => {
        noted.push({ identity: input.identity, matched: input.matched });
        return { counts: input.matched };
      },
    },
  };
  const host = makeTestHost({
    adapters: { resolve: () => quietChat },
    llm: { ...plain.llm, transforms: { ...plain.llm.transforms, answer: answering.answer } },
    park,
  });
  return { host, queued, noted, parks };
}

const runInput = {
  source: SOURCE,
  movementName: 'waiter',
  teamId: tenantOfTeam(TEAM),
  catalog,
  event: { pipelineInputId: 'pi-wait', adapterType: 'chat', triggerType: 'webhook', payload: { Text: 'q' }, recordId: 'm-0' },
} as const;

describe('a wait whose WHERE asks the team`s function', () => {
  it('a_wait_stays_parked_while_the_team`s_function_is_unreachable', async () => {
    const team = teamAnswers({ down: true, members: ['carol@acme.com'] });
    const step = stepHost(team.answers);

    const result = await runMovement({ ...runInput, host: step.host });

    expect(result.parked).toBe(true);
    // Asked (as it judged, and again as it parked), and the arrival left
    // unjudged: nothing noted, so it is judged again.
    expect(new Set(team.asked.map((questions) => JSON.stringify(questions)))).toEqual(new Set([JSON.stringify([{ plugin: IS_MEMBER, args: ['carol@acme.com'] }])]));
    expect(step.noted).toEqual([]);
    expect(step.parks.awaitParks.map((parked) => parked.waitId)).toEqual(['wait:thread:m-1']);
    expect(step.queued).toEqual([
      {
        kind: 'wake_await',
        key: hostRetryWakeKey('wait:thread:m-1'),
        payload: { runId: RUN_ID, waitId: 'wait:thread:m-1', address: step.parks.awaitParks[0]?.address },
        teamId: TEAM,
        dueAt: new Date(NOW + RETRY_UNJUDGED_EVERY_MS).toISOString(),
      },
    ]);
  });

  it('it_wakes_once_it_answers', async () => {
    const state = { down: true, members: ['carol@acme.com'] };
    const team = teamAnswers(state);
    const parkedStep = stepHost(team.answers);
    await runMovement({ ...runInput, host: parkedStep.host });
    const [parked] = parkedStep.parks.awaitParks;
    if (parked === undefined) throw new Error('test: the run did not park');

    // Its retry wake, a while on, still out of reach: parked again, woken again.
    const stillDown = stepHost(team.answers);
    const again = await resumeMovement({ ...runInput, host: stillDown.host, state: parked.state as ParkedScopeState, reenter: true });
    expect(again.parked).toBe(true);
    expect(stillDown.noted).toEqual([]);
    expect(stillDown.queued.map((row) => row.key)).toEqual([hostRetryWakeKey(parked.waitId)]);

    // The next, once it answers: the arrival is judged and the run goes on.
    state.down = false;
    const answered = stepHost(team.answers);
    const result = await resumeMovement({ ...runInput, host: answered.host, state: parked.state as ParkedScopeState, reenter: true });
    expect(result.parked).not.toBe(true);
    expect(answered.noted).toEqual([{ identity: 'r1', matched: true }]);
    expect(answered.queued).toEqual([]);
  });

  it('a module`s own error answering it fails the run', async () => {
    const team = teamAnswers({ down: false, refusing: true, members: [] });
    const step = stepHost(team.answers);

    const failed = await runMovement({ ...runInput, host: step.host }).then(
      () => 'it did not fail',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failed).toContain('the directory refused this address');
    expect(step.queued).toEqual([]);
  });
});
