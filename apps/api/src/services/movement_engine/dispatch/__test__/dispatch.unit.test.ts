// A run goes to this release's engine (the Rust engine) when its pin is the
// current version's, with no fallback: a run the Rust engine refuses fails
// loudly. A legacy id ('1'..'4') is refused with the remedy, since this
// platform no longer carries the TypeScript engine that ran them, and so is a
// pin no entry carries. A release-pinned run the TypeScript engine parked
// (under the retired MOVEMENT_ENGINE_V5_ON_TS) fails its resume. The engine
// settings that once chose otherwise are refused at boot.

import { LANGUAGE_VERSION, mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { refusalOf } from '@listen-fire/language-versions';
import { tenantIdOf, type ParkedScopeState } from 'engine-contracts';

import type { Adapter } from 'movement-engine/public/adapter';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import { containerAssociation } from 'movement-engine/public/adapter';
import { positionData } from 'engine-contracts/catalog';
import { MovementEngineError } from 'movement-engine/public/errors';
import {
  assertEngineConfigured,
  resetRustRunStats,
  rustRunStats,
  setRunEngineRecorder,
  type ParkSink,
  type RunEngineRecord,
  type RunMovementInput,
} from 'movement-engine/public/movement-engine';
import { credentialIdsFor, makeTestHost } from 'movement-engine/public/testing';

import { heldRunRefusal, refuseHeldRun, resumeMovement, runMovement } from '../dispatch';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000e5');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema } },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const program = (...body: string[]) =>
  [
    'import { email } from adapters',
    'import { dealflow_inbox } from credentials',
    'inbox = connect email using dealflow_inbox',
    'function m(msg: <inbox-[:message]->>) {',
    ...body,
    '}',
  ].join('\n');

const ADMITTED = program('  subject = msg.subject', '  return Text.upper(subject)');
/** Parks on a timer, and returns once woken. */
const SLEEPS = program('  subject = msg.subject', '  await sleep(1h)', '  return Text.upper(subject)');

const event: TriggerEvent = { pipelineInputId: 'pi-dispatch', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'hi' } };
/** Declined at the wire whatever the program says (a `Map` does not cross as itself). */
const UNWIREABLE_EVENT: TriggerEvent = { ...event, payload: { subject: 'Acme', text: 'hi', seen: new Map() } };

function fakeEmail(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async (input) => {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

/** An in-memory park sink keeping each timer park's state to wake. */
function timerSink() {
  const timers: ParkedScopeState[] = [];
  const sink: ParkSink = {
    async recordJoin() {},
    async commitTimerPark(input) {
      timers.push(JSON.parse(JSON.stringify(input.state)));
    },
    async commitAwaitPark() {
      throw new Error('test: no await parks expected');
    },
    async decrementJoin() {
      return { closed: true };
    },
    async persistBranchExport() {},
    async collectBranchExports() {
      return [];
    },
    async cancelSubtrees() {},
  };
  return { sink, timers };
}

function inputOf(source: string, languageVersion: LanguageVersion, runId: string, sink?: ParkSink): RunMovementInput {
  return {
    source,
    languageVersion,
    event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    host: makeTestHost({ adapters: { resolve: () => fakeEmail() }, ...(sink !== undefined ? { park: { sink } } : {}) }),
    runId,
    firedAt: '2026-10-14T09:00:00.000Z',
  };
}

const recorded: RunEngineRecord[] = [];

beforeEach(() => {
  resetRustRunStats();
  recorded.length = 0;
  setRunEngineRecorder((record) => recorded.push(record));
});

afterEach(() => setRunEngineRecorder(undefined));

describe('a pin this release does not run', () => {
  it('a legacy id is refused before any segment opens, with the remedy: upgrade it', async () => {
    for (const pin of ['1', '2', '3', '4']) {
      expect(heldRunRefusal(pin)).toBe(`this automation is pinned to language version ${pin}, and this release starts no new run on versions 1 to 4: upgrade it to ${LANGUAGE_VERSION}`);
      expect(() => refuseHeldRun(pin)).toThrow(MovementEngineError);
    }
    const failure = await runMovement(inputOf(ADMITTED, '4', 'run-v4')).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MOVENG_LANGUAGE_VERSION' });
    expect(String(failure)).toContain('upgrade it');
    expect(rustRunStats.segments).toBe(0);
    expect(recorded).toEqual([]);
  });

  it("a legacy id's parked run is refused its resume, with the remedy: cancel it, then upgrade", async () => {
    const parks = timerSink();
    await runMovement(inputOf(SLEEPS, LANGUAGE_VERSION, 'run-park', parks.sink));
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    resetRustRunStats();
    const failure = await resumeMovement({ ...inputOf(SLEEPS, '4', 'run-v4-park', parks.sink), state, parkedOnEngine: 'rust' }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MOVENG_LANGUAGE_VERSION' });
    expect(String(failure)).toContain('cancel it, then upgrade the automation');
    expect(rustRunStats.segments).toBe(0);
  });

  it("a key no entry carries, 0.12 among them, is refused in the registry's text", async () => {
    for (const pin of ['0.12.13', '0.14.0', '0.16.0']) {
      expect(heldRunRefusal(pin)).toBe(refusalOf(pin, 'run'));
      expect(heldRunRefusal(pin, 'resume')).toBe(refusalOf(pin, 'resume'));
    }
    const failure = await runMovement(inputOf(ADMITTED, '0.12.13', 'run-012')).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MOVENG_LANGUAGE_VERSION' });
    expect(rustRunStats.segments).toBe(0);
  });
});

describe('a run on the current version', () => {
  it('runs on Rust, recorded so', async () => {
    const result = await runMovement(inputOf(ADMITTED, LANGUAGE_VERSION, 'run-current'));
    expect(result.movementName).toBe('m');
    expect(rustRunStats).toMatchObject({ segments: 1, unsupported: {} });
    expect(recorded).toEqual([{ runId: 'run-current', engine: 'rust' }]);
  });

  it('fails a run the Rust engine refuses, loudly, with the reason', async () => {
    const failure = await runMovement({ ...inputOf(ADMITTED, LANGUAGE_VERSION, 'run-refused'), event: UNWIREABLE_EVENT }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MovementEngineError);
    expect(failure).toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason: 'event_does_not_cross' } });
  });

  it('parked on Rust, resumes on Rust', async () => {
    const parks = timerSink();
    const parked = await runMovement(inputOf(SLEEPS, LANGUAGE_VERSION, 'run-rust-park', parks.sink));
    expect(parked.parked).toBe(true);
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    const resumed = await resumeMovement({ ...inputOf(SLEEPS, LANGUAGE_VERSION, 'run-rust-park', parks.sink), state, parkedOnEngine: 'rust' });
    expect(resumed.parked).toBeUndefined();
    expect(rustRunStats.segments).toBe(2);
  });

  it('recorded as parked by TypeScript, fails its resume before any segment opens', async () => {
    const parks = timerSink();
    await runMovement(inputOf(SLEEPS, LANGUAGE_VERSION, 'run-ts-park', parks.sink));
    const [state] = parks.timers;
    if (state === undefined) throw new Error('test: the run parked no timer');
    resetRustRunStats();
    const failure = await resumeMovement({ ...inputOf(SLEEPS, LANGUAGE_VERSION, 'run-ts-park', parks.sink), state, parkedOnEngine: 'ts' }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MOVENG_UNSUPPORTED', details: { reason: 'parked_on_typescript' } });
    expect(rustRunStats.segments).toBe(0);
  });

  it("a park state this release does not read is refused by this release's reader", async () => {
    const resume = { ...inputOf(SLEEPS, LANGUAGE_VERSION, 'run-current-v2'), state: { version: 2 } as unknown as ParkedScopeState, parkedOnEngine: 'rust' as const };
    await expect(resumeMovement(resume)).rejects.toThrow(/park state version 2, which this release does not read/);
  });
});

describe('the engine settings, checked at boot', () => {
  it('refuses each retired setting, whatever its value', () => {
    expect(() => assertEngineConfigured({})).not.toThrow();
    for (const name of ['MOVEMENT_ENGINE', 'MOVEMENT_ENGINE_FALLBACK', 'MOVEMENT_ENGINE_DRY_RUN_EVERY', 'MOVEMENT_ENGINE_V5_ON_TS']) {
      expect(() => assertEngineConfigured({ [name]: 'by-version' })).toThrow(`${name} is retired: a run's engine follows its pinned language version`);
    }
  });
});
