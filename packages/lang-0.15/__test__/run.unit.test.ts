// A 0.15 program run by 0.15's own engine on the platform's run host: its
// parks go into the park family the platform hands it, and a segment resumed
// from what it parked runs on 0.15's engine again.

import { manualInvocationEvent, manualListens, readEvent, resumeSegment, runSegment } from '..';
import type { ModulePlatform, RunPlatform } from '../lane/run_types';
import type { TeamFacts } from '../lane/types';

const refused = async (): Promise<never> => {
  throw new Error('not part of this test');
};

const modules = (): ModulePlatform => ({
  hostFor: () => ({
    credential: { name: 'none', fields: refused, update: refused },
    kv: { get: refused, set: refused, delete: refused, list: refused, compareAndSet: refused },
    files: { put: refused, read: refused, expose: refused },
  }),
  parts: {
    askAnswerUrl: () => '',
    kgStore: () => {
      throw new Error('no kg');
    },
    kgChangeWebhooks: false,
    slackChat: refused,
    readFile: refused,
    whatsappNumber: null,
    isExposedFileUrl: () => false,
    systemRecords: () => ({
      failedRuns: refused,
      pausedRuns: refused,
      strandedWaits: refused,
      releases: refused,
      unjudgedArrivals: refused,
      webBaseUrl: async () => null,
    }),
    remoteInstall: refused,
    readDocument: refused,
  },
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  validateResults: false,
});

function team(): TeamFacts {
  return { credentials: [], files: [], connectOf: () => 'oauth', kgChangeWebhooks: false, mcpEnabled: false, whatsappNumber: null };
}

interface TimerPark {
  address: string;
  state: unknown;
  wakeAt: string;
}

/** The platform's services, with a park family that keeps the timer parks it
 *  is handed, as the run host's rows would. */
function platform(parked: TimerPark[], actingUser: RunPlatform['actingUser'] = async () => null): RunPlatform {
  return {
    modules: modules(),
    recordEngine: () => {},
    credentials: { belongsTo: () => true },
    llm: { client: { call: refused }, extractCall: { call: refused }, transforms: { invoke: refused }, arbitrateEntities: refused },
    files: { resolveFileText: refused, render: refused },
    withFileOwners: (_owners, call) => call(),
    bindings: { record: refused, findBoundCounterpart: refused, delete: refused },
    locks: { holder: () => { throw new Error('no locks in this test'); } },
    actingUser,
    control: { cancelled: async () => false, cancelledNow: async () => false, leaseLost: () => false },
    park: {
      sink: {
        recordJoin: refused,
        commitTimerPark: async ({ address, state, wakeAt }) => {
          parked.push({ address, state, wakeAt });
        },
        commitAwaitPark: refused,
        decrementJoin: refused,
        persistBranchExport: refused,
        collectBranchExports: refused,
        cancelSubtrees: refused,
      },
      wake: refused,
    },
  };
}

/** A 0.15 Run now program that waits, then answers who pressed it with
 *  `@user_email`, which 0.16 retired. */
const WAITS_015 =
  'function go(i: <manual-[:Invocations]->>) {\n  await sleep(1h)\n  return "pressed by ${@user_email}"\n}\n' +
  'listen to manual-[:Invocations]-> fire go\n';

const firedAt = '2026-11-16T09:00:00.000Z';
const event = manualInvocationEvent({ key: 'run-1', invocation: { firedAt, text: 'hello' } });

describe("a 0.15 segment on the platform's run host", () => {
  it('finds the movement its manual listen fires, by its own parser', () => {
    expect(manualListens({ source: WAITS_015, pin: '0.15.3' })).toEqual(['go']);
  });

  it("reads the Run now press with 0.15's own event schema", () => {
    expect(readEvent(event)).toEqual({ ok: true, record: expect.objectContaining({ adapterType: 'manual', pipelineInputId: 'trigger:run-1' }) });
    expect(readEvent({ adapterType: 'manual' })).toEqual({ ok: false, reason: expect.stringContaining('pipelineInputId') });
  });

  it('parks into the platform\'s park family, and resumes from what it parked on 0.15\'s engine', async () => {
    const parked: TimerPark[] = [];
    const common = { source: WAITS_015, pin: '0.15.3', movementName: 'go', event, teamId: 'team-1', firedAt, runId: 'run-1', team: team() };
    const first = await runSegment(common, platform(parked));
    expect(first).toEqual({ kind: 'ran', result: expect.objectContaining({ parked: true }) });
    expect(parked).toEqual([expect.objectContaining({ address: expect.any(String), wakeAt: expect.any(String) })]);
    expect(Date.parse(parked[0]?.wakeAt ?? '') - Date.now()).toBeGreaterThan(59 * 60 * 1000);

    const [timer] = parked;
    const asked: string[] = [];
    const resumed = await resumeSegment(
      { ...common, state: timer?.state },
      platform([], async ({ teamId }) => {
        asked.push(teamId);
        return { id: 'u1', email: 'ada@example.com' };
      }),
    );
    expect(resumed).toEqual({ kind: 'ran', result: expect.objectContaining({ movementName: 'go' }) });
    expect(resumed.kind === 'ran' ? resumed.result.parked : 'failed').toBeUndefined();
    expect(asked).toEqual(['team-1']);
  });

  it('answers a failure as plain data, with 0.15\'s code', async () => {
    const failed = await runSegment(
      { source: 'function go(i: <manual-[:Invocations]->>) {\n  fail("no")\n}\nlisten to manual-[:Invocations]-> fire go\n', pin: '0.15.3', event, teamId: 'team-1', firedAt, team: team() },
      platform([]),
    );
    expect(failed).toEqual({ kind: 'failed', code: 'MOVENG_ERROR', message: expect.stringContaining('no'), partial: expect.objectContaining({ movementName: 'go' }) });
  });

  it('refuses a callback body: 0.15 mints none', async () => {
    const refusedBody = await resumeSegment(
      { source: WAITS_015, pin: '0.15.3', event, teamId: 'team-1', firedAt, runId: 'run-1', team: team(), state: {}, callback: { values: {}, callIndex: 0 } },
      platform([]),
    );
    expect(refusedBody).toEqual({ kind: 'failed', code: 'MOVENG_UNSUPPORTED', message: expect.stringContaining('callback') });
  });
});
