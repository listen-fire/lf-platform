// The engine/host seam, pinned on the platform's side: the host's round trip
// carries plain data only. The engine's own purity is pinned by the engine
// package's tests (it is the language's; this app installs it).

import { Readable } from 'node:stream';

import { LANGUAGE_VERSION, mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { CapturedWrite } from 'movement-engine/public/adapter';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { MovementTraceEntry } from 'movement-engine/public/trace';
import type { ParkedScopeState } from 'engine-contracts';

import {
  iterateRelatedPages,
  containerAssociation,
  type Adapter,
  type ExternalRecordRef,
  type GetRelatedInput,
  type RelatedPage,
  type RelatedResult,
} from 'movement-engine/public/adapter';
import { createEmailAdapter } from '../../translation_graph/adapters/email';
import { createManualAdapter } from '../../translation_graph/adapters/manual';
import { adapterErrorOf } from 'movement-engine/public/host';
import { staticCatalogSnapshot } from '../../translation_graph/movement/catalog';
import { productionEngineHost } from '../../translation_graph/movement/engine_host';
import { inMemoryRawTextStore } from '../../translation_graph/movement/raw_text_store';
import { makeStablePosition, makeUnstablePosition, positionData } from 'engine-contracts/catalog';
import { InMemoryWriteLocks } from 'movement-engine/public/write-locks';
import {
  HOST_FAMILIES,
  hostMethodPaths,
  type EngineHost,
  type RenderFile,
  type ResolveFileText,
} from 'movement-engine/public/host';
import { resumeMovement, runMovement } from '../dispatch/dispatch';
import { MovementRunFailed, type ParkSink, type ResumeMovementInput, type RunLimitPause, type RunMovementInput } from 'movement-engine/public/movement-engine';
import { makeFakeParkSink, makeMemoryParkSources, makeTestHost, type TestHostOverrides } from 'movement-engine/public/testing';
import { methodPaths, notJsonAt, roundTripHost } from './round_trip_host';
import { HOST_FAMILIES_VERSION, type LoggedArrival } from 'engine-contracts';
import { tenantOfTeam } from '../../translation_graph/movement/tenant';

describe('the engine/host seam carries data', () => {
  // A file crosses as its descriptor: FILE() asks the host to render and gets
  // a descriptor back; READ() hands that descriptor over and gets text back.
  // No bytes, and no closure, in either direction. The segment the run opened
  // and closed around them, the budget in and the cost out, are data too.
  it('a file render and a file read pass plain data only', async () => {
    const teamId = '00000000-0000-0000-0000-000000000043' as TeamId;
    const calls: Array<{ call: string; input: unknown; output: unknown }> = [];
    const render: RenderFile = async (input) => {
      const output = {
        __brand: 'FileRef' as const,
        name: 'movement-artifact.txt',
        contentType: 'text/plain',
        source: { store: 'document' as const, objectUri: 'mem://rendered/1' },
      };
      calls.push({ call: 'render', input, output });
      return output;
    };
    const resolveFileText: ResolveFileText = async (input) => {
      const output = {
        text: 'the digest',
        rawTextId: 'rt-1',
        cost: [{ source: 'model:ocr', microdollars: 120 }],
      };
      calls.push({ call: 'resolveFileText', input, output });
      return output;
    };
    const segment: EngineHost['segment'] = {
      open: async (input) => {
        const output = { segmentId: 'seg-1' };
        calls.push({ call: 'segment.open', input, output });
        return output;
      },
      close: async (input) => {
        const output = { cost: [] };
        calls.push({ call: 'segment.close', input, output });
        return output;
      },
    };
    const manual = createManualAdapter({ teamId });
    const result = await runMovement({
      source: [
          '',
        'function m(go: <manual-[:`Invocation`]->>) {',
        '  f = File.from("the digest", "text")',
        '  t = File.read(f)',
        '}',
        'listen to manual-[:Invocations]-> fire m',
      ].join('\n'),
      event: {
        pipelineInputId: 'trigger:manual-files',
        adapterType: 'manual',
        triggerType: 'webhook',
        payload: { firedAt: '2026-10-07T09:00:00.000Z' },
        occurredAt: '2026-10-07T09:00:00.000Z',
      },
      teamId: tenantOfTeam(teamId),
      catalog: staticCatalogSnapshot({ credentials: {} }),
      host: makeTestHost({
        segment,
        adapters: {
          resolve: (input) => {
            calls.push({ call: 'adapters.resolve', input, output: 'an adapter' });
            return manual;
          },
        },
        files: { render, resolveFileText },
      }),
      dryRun: true,
    });

    expect(result.trace.filter((entry) => entry.kind === 'warning')).toEqual([]);
    const made = calls.filter((c) => c.call !== 'adapters.resolve');
    expect(made.map((c) => c.call)).toEqual([
      'segment.open',
      'render',
      'resolveFileText',
      'segment.close',
    ]);
    expect(made[0]?.input).toEqual({ teamId, languageVersion: LANGUAGE_VERSION, hostFamiliesVersion: HOST_FAMILIES_VERSION });
    // Every call names the segment the run opened.
    expect(made[1]?.input).toEqual({ segmentId: 'seg-1', content: 'the digest', type: 'text' });
    // A priced call: the run's budget in (no cap here), what it spent out —
    // and the run charged it.
    expect(made[2]?.input).toEqual({
      segmentId: 'seg-1',
      file: made[1]?.output,
      budget: { remainingMicrodollars: null },
    });
    expect(result.spentBySource).toEqual({ 'model:ocr': 120 });
    expect(made[3]?.input).toEqual({ segmentId: 'seg-1' });
    // Every adapter is resolved for the segment, by its id.
    const resolutions = calls.filter((c) => c.call === 'adapters.resolve');
    expect(resolutions.length).toBeGreaterThan(0);
    for (const resolved of resolutions) {
      expect(resolved.input).toMatchObject({ segmentId: 'seg-1' });
    }
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });

  // The engine never holds a live adapter: it resolves an instance to data
  // and an opaque id, and calls it by method name with one JSON argument.
  it('adapter instances are resolved and called with plain data only', async () => {
    const teamId = '00000000-0000-0000-0000-000000000044' as TeamId;
    const calls: Array<{ call: string; method?: string; input: unknown; output: unknown }> = [];
    const manual = createManualAdapter({ teamId });
    const kg: Adapter = {
      adapterType: 'kg',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: () => ({
        traversal: { incoming: false, edgeProperties: false },
        resources: false,
      }),
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async () => null,
      getRelated: async () => [],
      createRecord: async () => ({ adapterType: 'kg', externalId: 'note-1', data: {} }),
      updateRecord: async (input) => ({
        adapterType: 'kg',
        externalId: input.externalId,
        data: {},
        association: 'none',
      }),
      deleteRecord: async () => ({}),
    };
    const inner = makeTestHost({
      adapters: { resolve: ({ adapterType }) => (adapterType === 'kg' ? kg : manual) },
    });
    const host: EngineHost = {
      ...inner,
      adapters: {
        resolve: async (input) => {
          const output = await inner.adapters.resolve(input);
          calls.push({ call: 'adapters.resolve', input, output });
          return output;
        },
        call: async (input) => {
          const output = await inner.adapters.call(input);
          calls.push({ call: 'adapters.call', method: input.method, input, output });
          return output;
        },
      },
    };
    const result = await runMovement({
      source: [
        'import { kg } from adapters',
        'import { kg_cred } from credentials',
          'graph = connect kg using kg_cred',
        '',
        'function m(go: <manual-[:`Invocation`]->>) {',
        '  write graph-[:note]-> { unique by (`body`) body: "hello" }',
        '}',
        'listen to manual-[:Invocations]-> fire m',
      ].join('\n'),
      event: {
        pipelineInputId: 'trigger:manual-adapters',
        adapterType: 'manual',
        triggerType: 'webhook',
        payload: { firedAt: '2026-10-07T09:00:00.000Z' },
        occurredAt: '2026-10-07T09:00:00.000Z',
      },
      teamId: tenantOfTeam(teamId),
      catalog: staticCatalogSnapshot({
        credentials: { kg_cred: { adapters: ['kg'] } },
        instanceSchemas: {
          kg: {
            positions: { note: { properties: { body: 'text' }, edges: {} } },
            collections: { note: { target: 'note' } },
            writableRoots: {
              note: { fields: { body: 'text' }, resultShape: { externalId: 'text' } },
            },
          },
        },
      }),
      credentialIds: { kg_cred: 'cred-kg' },
      host,
    });

    expect(result.writes).toHaveLength(1);
    const methods = calls.filter((c) => c.call === 'adapters.call').map((c) => c.method);
    expect(methods).toEqual(expect.arrayContaining(['resolveEntity', 'createRecord']));
    expect(calls.filter((c) => c.call === 'adapters.resolve').map((c) => c.input)).toContainEqual(
      expect.objectContaining({ adapterType: 'kg', credentialsId: 'cred-kg', role: 'target' }),
    );
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });

  // The rest of the host's families, as one run uses them: the acting-user
  // lookup names the source instance and the event (the host asks the source
  // itself), a timer carries its instant as an ISO string, the
  // write's cross-run locks go by token, and the trace is appended as data.
  it('the lookup, timers, locks and trace pass plain data only', async () => {
    const teamId = '00000000-0000-0000-0000-000000000045' as TeamId;
    const calls: Array<{ call: string; input: unknown; output: unknown }> = [];
    const record = async <T>(call: string, input: unknown, answer: Promise<T>): Promise<T> => {
      const output = await answer;
      calls.push({ call, input, output: output ?? null });
      return output;
    };
    const manual = createManualAdapter({ teamId });
    const kg: Adapter = {
      adapterType: 'kg',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: () => ({
        traversal: { incoming: false, edgeProperties: false },
        resources: false,
      }),
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async () => null,
      getRelated: async () => [],
      createRecord: async () => ({ adapterType: 'kg', externalId: 'note-1', data: {} }),
      updateRecord: async (input) => ({
        adapterType: 'kg',
        externalId: input.externalId,
        data: {},
        association: 'none',
      }),
      deleteRecord: async () => ({}),
    };
    const parks = makeFakeParkSink();
    const appended: unknown[] = [];
    const inner = makeTestHost({
      adapters: { resolve: ({ adapterType }) => (adapterType === 'kg' ? kg : manual) },
      park: { sink: parks.sink },
      lookup: {
        resolveActingUser: async () => ({ id: 'user-1', email: 'amy@acme.dev', name: 'Amy' }),
      },
      trace: [],
    });
    const sink = inner.park.sink!;
    const appendTrace = inner.trace!;
    const host: EngineHost = {
      ...inner,
      park: {
        ...inner.park,
        sink: {
          ...sink,
          commitTimerPark: (input) =>
            record('park.sink.commitTimerPark', input, sink.commitTimerPark(input)),
        },
      },
      lookup: {
        resolveActingUser: (input) =>
          record('lookup.resolveActingUser', input, inner.lookup.resolveActingUser(input)),
      },
      locks: {
        acquire: (input) => record('locks.acquire', input, inner.locks.acquire(input)),
        release: (input) => record('locks.release', input, inner.locks.release(input)),
      },
      trace: {
        append: (input) => {
          appended.push(...input.entries);
          return record('trace.append', input, appendTrace.append(input));
        },
      },
    };
    const result = await runMovement({
      source: [
        'import { kg } from adapters',
        'import { kg_cred } from credentials',
          'graph = connect kg using kg_cred',
        '',
        'function m(go: <manual-[:`Invocation`]->>) {',
        '  write graph-[:note]-> { unique by (`body`) body: "by ${@user_email}" }',
        '  await sleep(1d)',
        '}',
        'listen to manual-[:Invocations]-> fire m',
      ].join('\n'),
      event: {
        pipelineInputId: 'trigger:manual-families',
        adapterType: 'manual',
        triggerType: 'webhook',
        payload: { firedAt: '2026-10-07T09:00:00.000Z' },
        occurredAt: '2026-10-07T09:00:00.000Z',
      },
      teamId: tenantOfTeam(teamId),
      firedAt: '2026-10-07T09:00:00.000Z',
      catalog: staticCatalogSnapshot({
        credentials: { kg_cred: { adapters: ['kg'] } },
        instanceSchemas: {
          kg: {
            positions: { note: { properties: { body: 'text' }, edges: {} } },
            collections: { note: { target: 'note' } },
            writableRoots: {
              note: { fields: { body: 'text' }, resultShape: { externalId: 'text' } },
            },
          },
        },
      }),
      host,
    });

    expect(result.parked).toBe(true);
    expect(result.writes[0]?.writtenValues).toEqual({ body: 'by amy@acme.dev' });
    const made = new Set(calls.map((c) => c.call));
    expect([...made].sort()).toEqual([
      'locks.acquire',
      'locks.release',
      'lookup.resolveActingUser',
      'park.sink.commitTimerPark',
      'trace.append',
    ]);
    const lookup = calls.find((c) => c.call === 'lookup.resolveActingUser');
    // The lookup names its segment and the source instance; the team is the
    // segment's, so it is not repeated.
    expect(lookup?.input).toMatchObject({
      segmentId: expect.any(String),
      instance: expect.any(String),
    });
    expect(lookup?.input).not.toHaveProperty('teamId');
    expect(calls.find((c) => c.call === 'park.sink.commitTimerPark')?.input).toMatchObject({
      segmentId: expect.any(String),
      wakeAt: expect.any(String),
    });
    // Every call of the segment names the one segment it opened.
    const segmentIds = new Set(
      calls.map((c) => (typeof c.input === 'object' && c.input !== null ? Reflect.get(c.input, 'segmentId') : undefined)),
    );
    expect([...segmentIds]).toEqual([expect.any(String)]);
    // What the host was handed of the trace is the run's whole trace.
    expect(appended).toEqual(result.trace);
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });
});

// ── Every family, round-tripped ─────────────────────────────────────────────
//
// The tests above pin particular shapes. These prove the general claim: every
// method of every family takes and answers JSON. The host each run is handed
// is wrapped so each request and each answer is serialised and parsed on the
// way across (`round_trip_host.ts`), and fails naming the method and the path
// of anything JSON cannot carry. The wrapper walks the host object, so a
// method added to any family is wrapped without being listed; the manifest
// (`HOST_FAMILIES`) is what the doc and this test agree the host is, and the
// runs below reach every method on it.

/** Each method path the family suite's runs reached; only that suite's
 *  runs add to it, and only that suite asserts it. */
const REACHED = new Set<string>();
const ROUND_TRIP_TEAM = '00000000-0000-0000-0000-000000000046' as TeamId;

/** A CRM whose companies resolve by similarity, with notes beside them. */
const CRM_SCHEMA: InstanceSchema = {
  supportsInPlaceUpdate: true,
  positions: {
    company: { properties: { name: 'text', summary: 'text' }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: {
      fields: { name: 'text', summary: 'text' },
      resultShape: { externalId: 'text', name: 'text', summary: 'text' },
      fuzzyResolution: true,
    },
    note: { fields: { title: 'text' }, resultShape: { externalId: 'text', title: 'text' } },
  },
};
const roundTripCatalog = staticCatalogSnapshot({
  credentials: { acme_main: { adapters: ['attio'] } },
  instanceSchemas: { attio: CRM_SCHEMA },
});

const ROUND_TRIP_PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'import { fetchUrl as fetch_url } from plugins',
  '',
  'inbox = connect email',
  'crm = connect attio using acme_main',
  '',
  'node Detail: "more about the company" {',
  '  summary: <text> "one line on what it does"',
  '}',
  '',
].join('\n');

interface FakeCrm {
  adapter: Adapter;
  creates: Array<{ recordType: string; fields: Record<string, unknown> }>;
}

/** A CRM fake: finds `candidates` for a company, creates with fresh ids, and
 *  answers an update by id as not found when `updatesFind` is false. */
function fakeCrm(
  options: { candidates?: ExternalRecordRef[]; updatesFind?: boolean; createFails?: Error } = {},
): FakeCrm {
  const creates: FakeCrm['creates'] = [];
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: true, edgeProperties: true },
      resources: true,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async ({ recordType }) => ({
      candidates: recordType === 'company' ? options.candidates ?? [] : [],
    }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = positionData(position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, fieldId) ?? null : null;
    },
    getRelated: async () => [],
    createRecord: async (input) => {
      if (options.createFails !== undefined) throw options.createFails;
      creates.push({ recordType: input.recordType, fields: input.fields });
      return {
        adapterType: 'attio',
        externalId: `co-new-${creates.length}`,
        data: { ...input.fields },
      };
    },
    updateRecord: async (input) =>
      options.updatesFind === false
        ? { notFound: true }
        : {
            adapterType: 'attio',
            externalId: input.externalId,
            data: {},
            association: containerAssociation(input),
          },
    deleteRecord: async () => ({}),
  };
  return { adapter, creates };
}

/** The inbound email as a source fake that pages its attachments: two pages,
 *  the second asked for by a cursor that is a JSON object. */
function pagedInbox(): { adapter: Adapter; cursors: unknown[] } {
  const cursors: unknown[] = [];
  const attachment = (name: string): RelatedResult => ({
    position: makeUnstablePosition({
      adapterType: 'email',
      recordType: 'attachment',
      data: { filename: name },
    }),
  });
  const page = async (_input: GetRelatedInput, cursor?: unknown): Promise<RelatedPage> => {
    cursors.push(cursor ?? null);
    return cursor === undefined
      ? { items: [attachment('deck.pdf')], nextCursor: { after: 'deck.pdf', page: 2 } }
      : { items: [attachment('cap-table.xlsx')] };
  };
  const adapter: Adapter = {
    adapterType: 'email',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: true,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = positionData(position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, fieldId) ?? null : null;
    },
    getRelated: async () => [],
    iterateRelated: (input) => iterateRelatedPages((cursor) => page(input, cursor)),
    iterateRelatedPage: page,
    getActorCandidates: async () => [{ identity: { identifier: 'amy@acme.dev', scheme: 'email' }, source: 'originator' }],
    createRecord: async () => {
      throw new Error('test: email is a source');
    },
    updateRecord: async () => {
      throw new Error('test: email is a source');
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, cursors };
}

type ParkKind = 'timer' | 'await' | 'suspension';

/** An in-memory park sink with the durable join semantics of the real one. */
function joiningParkSink() {
  const parks = new Map<string, { kind: ParkKind; state: ParkedScopeState }>();
  const joins = new Map<
    string,
    { pending: number; closedBy: string | null; decremented: Set<string> }
  >();
  const exports = new Map<string, Map<string, { branchIndex: number; exports: unknown }>>();
  const pauses: RunLimitPause[] = [];
  const cancelled: Array<{ subtreeAddresses: string[]; excludeLeaf?: string }> = [];
  const keep = (kind: ParkKind, address: string, state: unknown): void => {
    parks.set(address, { kind, state: JSON.parse(JSON.stringify(state)) as ParkedScopeState });
  };
  const sink: ParkSink = {
    async recordJoin(input) {
      const existing = joins.get(input.frameAddress);
      joins.set(input.frameAddress, {
        pending: input.parkedChildren,
        closedBy: existing?.closedBy ?? null,
        decremented: existing?.decremented ?? new Set(),
      });
    },
    async commitTimerPark(input) {
      keep('timer', input.address, input.state);
    },
    async commitAwaitPark(input) {
      keep('await', input.address, input.state);
    },
    async commitSuspension(input) {
      keep('suspension', input.address, input.state);
    },
    async commitLimitPause({ limit, capMicrodollars, spentMicrodollars }) {
      pauses.push({ limit, capMicrodollars, spentMicrodollars });
    },
    async decrementJoin(input) {
      const frame = joins.get(input.frameAddress);
      if (frame === undefined) return { closed: false };
      if (frame.decremented.has(input.branchAddress))
        return { closed: frame.closedBy === input.leafAddress };
      frame.decremented.add(input.branchAddress);
      if (frame.pending === 0) return { closed: frame.closedBy === input.leafAddress };
      frame.pending -= 1;
      if (frame.pending > 0) return { closed: false };
      frame.closedBy = input.leafAddress;
      return { closed: true };
    },
    async persistBranchExport(input) {
      const byBranch = exports.get(input.frameAddress) ?? new Map();
      byBranch.set(input.branchAddress, { branchIndex: input.branchIndex, exports: input.exports });
      exports.set(input.frameAddress, byBranch);
    },
    async collectBranchExports(input) {
      return [...(exports.get(input.frameAddress) ?? new Map()).entries()]
        .map(([branchAddress, row]) => ({
          branchAddress,
          branchIndex: row.branchIndex,
          exports: row.exports,
        }))
        .sort((a, b) => a.branchIndex - b.branchIndex);
    },
    async cancelSubtrees(input) {
      cancelled.push(input);
      for (const address of [...parks.keys()]) {
        const under = input.subtreeAddresses.some(
          (prefix) => address === prefix || address.startsWith(`${prefix}.`),
        );
        if (under && address !== input.excludeLeaf) parks.delete(address);
      }
    },
  };
  return { sink, parks, pauses, cancelled };
}

function roundTripEvent(
  payload: Record<string, unknown> = { subject: 'Acme intro', text: 'https://acme.example' },
): TriggerEvent {
  return {
    pipelineInputId: 'pi-round-trip',
    adapterType: 'email',
    triggerType: 'webhook',
    payload,
  };
}

/** One run through a round-tripped test host, and resumes of whatever it
 *  parked. */
function roundTrip(
  body: string[],
  overrides: TestHostOverrides & { crm?: FakeCrm; inbox?: Adapter } = {},
  options: { imports?: string[] } = {},
) {
  const crm = overrides.crm ?? fakeCrm();
  const inbox = overrides.inbox ?? pagedInbox().adapter;
  const { crm: _crm, inbox: _inbox, ...hostOverrides } = overrides;
  const input = () => ({
    source: [
      ROUND_TRIP_PRELUDE,
      ...(options.imports ?? []),
      'function intake(m: <inbox-[:message]->>) {',
      ...body,
      '}',
    ].join('\n'),
    movementName: 'intake',
    event: roundTripEvent(),
    teamId: tenantOfTeam(ROUND_TRIP_TEAM),
    catalog: roundTripCatalog,
    credentialIds: { acme_main: 'cred-attio-1' },
    firedAt: '2026-10-07T09:00:00.000Z',
    host: roundTripHost(
      makeTestHost({
        ...hostOverrides,
        adapters: {
          ...hostOverrides.adapters,
          resolve: ({ adapterType }) => (adapterType === 'email' ? inbox : crm.adapter),
        },
      }),
      REACHED,
    ),
    dryRun: false,
  });
  return {
    crm,
    run: (extra: Partial<RunMovementInput> = {}) => runMovement({ ...input(), ...extra }),
    resume: (state: ParkedScopeState, extra: Partial<ResumeMovementInput> = {}) =>
      resumeMovement({ ...input(), state, ...extra }),
  };
}

/** Methods the manifest still declares that only a program of versions 1 to 4
 *  reached (`write … bind`, the extraction keyword's minted ids), and this
 *  platform no longer runs one. */
const REACHED_BY_NO_PROGRAM = (method: string): boolean => method.startsWith('park.bindings.') || method === 'ids.mint';

describe('the round trip', () => {
  it('names the method and the path of whatever JSON cannot carry', async () => {
    class Money {
      constructor(readonly cents: number) {}
    }
    const refused: Array<[unknown, string]> = [
      [() => 1, 'a function'],
      [new Money(5), 'an instance of Money'],
      [new Date('2026-10-07T09:00:00.000Z'), 'an instance of Date'],
      [new Map([['a', 1]]), 'an instance of Map'],
      [new Set([1]), 'an instance of Set'],
      [Readable.from(['bytes']), 'an instance of Readable'],
      [[1, undefined], 'undefined'],
      [BigInt(1), 'a BigInt'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [-0, '-0'],
    ];
    for (const [value, what] of refused) {
      const host = roundTripHost(
        makeTestHost({
          files: { resolveFileText: async () => ({ text: 'ok', nested: { value } }) as never },
        }),
      );
      await expect(
        host.files.resolveFileText({
          segmentId: 'seg-1',
          file: { __brand: 'FileRef', name: 'x', source: { store: 'document', objectUri: 'u' } },
          budget: { remainingMicrodollars: null },
        }),
      ).rejects.toThrow(
        `files.resolveFileText: answer.nested.value${Array.isArray(value) ? '[1]' : ''} is ${what}`,
      );
    }
    // The request is checked too, and a method that answers without a promise
    // could not cross a wire.
    const host = roundTripHost(makeTestHost());
    expect(() => host.locks.release({ segmentId: 'seg-1', token: new Date() as never })).toThrow(
      'locks.release: request[0].token is an instance of Date',
    );
    const sync = roundTripHost({
      ...makeTestHost(),
      lookup: { resolveActingUser: (() => null) as never },
    });
    expect(() => sync.lookup.resolveActingUser({} as never)).toThrow(
      'lookup.resolveActingUser: answer is answered synchronously',
    );
    // An undefined field is an absent one on the far side.
    expect(notJsonAt({ a: undefined, b: [null, { c: 'x' }] }, 'value')).toBeUndefined();
    // A value that contains itself is named, not recursed into; the same
    // object twice side by side is no cycle.
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.inner = { back: loop };
    expect(notJsonAt({ loop }, 'answer')).toEqual({
      path: 'answer.loop.inner.back',
      what: 'a cycle back to answer.loop',
    });
    const shared = { x: 1 };
    expect(notJsonAt({ a: shared, b: shared }, 'answer')).toBeUndefined();
    expect(notJsonAt('a whole pair \uD83D\uDE00', 'answer')).toBeUndefined();
    // A lone half crosses as the escape `JSON.stringify` writes, and reads back.
    expect(notJsonAt('half a pair \uD83D', 'answer')).toBeUndefined();
    expect(JSON.parse(JSON.stringify('half a pair \uD83D'))).toBe('half a pair \uD83D');
  });

  it('only a void method may answer nothing', async () => {
    const silent = roundTripHost({
      ...makeTestHost(),
      lookup: { resolveActingUser: async () => undefined as never },
    });
    await expect(silent.lookup.resolveActingUser({} as never)).rejects.toThrow(
      'lookup.resolveActingUser: answer is undefined',
    );
    const chatty = roundTripHost({
      ...makeTestHost(),
      locks: { ...makeTestHost().locks, release: async () => ({ released: true }) as never },
    });
    await expect(chatty.locks.release({ segmentId: 'seg-1', token: 't' })).rejects.toThrow(
      'locks.release: answer is a value from a void method',
    );
    const quiet = roundTripHost({
      ...makeTestHost(),
      locks: { ...makeTestHost().locks, release: async () => {} },
    });
    await expect(quiet.locks.release({ segmentId: 'seg-1', token: 't' })).resolves.toBeUndefined();
  });

  it('wraps every method of every family, which are the manifest’s', () => {
    const { sink } = joiningParkSink();
    const host = makeTestHost({
      park: {
        sink,
        sources: makeMemoryParkSources().sources,
        waits: {
          mark: async () => ({ mark: 0 }),
          open: async () => ({ waitId: 'wait-1' }),
          arrivals: async () => ({ arrivals: [] }),
          note: async () => ({ counts: false }),
        },
      },
      trace: [],
    });
    expect(methodPaths(roundTripHost(host)).sort()).toEqual(hostMethodPaths().sort());
  });

});

describe('every family crosses as JSON', () => {
  // The manifest check below holds only over a whole run of this suite: a
  // filtered run (`-t`) reaches a subset, which proves nothing either way.
  const declared = new Set<string>();
  const ran = new Set<string>();
  const familyRun = (name: string, fn: () => Promise<void>): void => {
    declared.add(name);
    it(name, async () => {
      ran.add(name);
      await fn();
    });
  };

  familyRun('models and plugins: AI(), extract(…), a plugin, and the judge', async () => {
    const h = roundTrip(
      [
        '  page = fetch_url(m.`text`)',
        '  found = extract([m.`subject`], Detail)',
        '  co = match crm-[:companies]-> { unique by (FUZZY `name`)',
        '    name: "Acme"',
        '  }',
        '  write crm-[:notes]-> { title: "${ai(m.`subject`)} ${coalesce(page, "")} ${coalesce(first(found)?.summary, "")}" }',
      ],
      {
        crm: fakeCrm({
          candidates: [
            { adapterType: 'attio', externalId: 'co-1', data: { name: 'Acme Inc', summary: 's' } },
          ],
        }),
        llm: {
          client: {
            call: async () => ({
              parsedJson: { value: 'ACME', has_value: true },
              cost: [{ source: 'model:test', microdollars: 3 }],
            }),
          },
          extractCall: {
            call: async () => ({
              parsedJson: {
                records: [
                  { summary: { value: 'builds infra', evidence: { item: 0, quote: 'Acme' } } },
                ],
              },
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
            }),
          },
          transforms: { invoke: async () => ({ text: 'raised a seed' }) },
          arbitrateEntities: async () => ({ index: 0 }),
        },
      },
    );
    await h.run();
    expect(h.crm.creates).toEqual([
      { recordType: 'note', fields: { title: 'ACME raised a seed builds infra' } },
    ]);
  });

  familyRun('parks: an all join, a race settled', async () => {
    const parks = joiningParkSink();
    const h = roundTrip(
      [
        '  r = all(',
        '    () => { await sleep(1h)',
        '      return "a" },',
        '    () => { await sleep(2h)',
        '      return "b" },',
        '  )',
        '  w = race(',
        '    () => { await sleep(1h)',
        '      return "first" },',
        '    () => { await sleep(30d) },',
        '  )',
        '  write crm-[:notes]-> { title: "${r[0]}${r[1]} ${w[0]}" }',
      ],
      { park: { sink: parks.sink } },
    );
    const wake = async (): Promise<void> => {
      while (parks.parks.size > 0) {
        const [address, park] = [...parks.parks.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )[0]!;
        parks.parks.delete(address);
        await h.resume(park.state);
      }
    };
    expect((await h.run()).parked).toBe(true);
    await wake();
    expect(h.crm.creates.map((c) => c.fields.title)).toEqual(['ab first']);
    expect(parks.cancelled.length).toBeGreaterThan(0);
  });

  familyRun('park sources: a park pins its library by hash, and its resume reads the text back', async () => {
    const parks = joiningParkSink();
    const { sources, texts } = makeMemoryParkSources();
    const catalog = { ...roundTripCatalog, files: { 'lib/notes': { source: 'export function noted(t: <text>) {\n  return Text.concat(t, "!")\n}' } } };
    const h = roundTrip(
      ['  await sleep(1h)', '  write crm-[:notes]-> { title: noted("slept") }'],
      { park: { sink: parks.sink, sources } },
      { imports: ['import { noted } from "lib/notes"'] },
    );
    // Only the Rust engine (version 5 on) pins libraries (park state version 2).
    expect((await h.run({ catalog })).parked).toBe(true);
    expect([...texts.values()]).toEqual([catalog.files['lib/notes'].source]);
    for (const [address, park] of [...parks.parks.entries()]) {
      parks.parks.delete(address);
      await h.resume(park.state, { catalog });
    }
    expect(h.crm.creates.map((c) => c.fields.title)).toEqual(['slept!']);
  });

  familyRun('a limit pause: a priced call refused past the budget suspends the run', async () => {
    const parks = joiningParkSink();
    let invocations = 0;
    const h = roundTrip(
      [
        '  a = fetch_url("a")',
        '  b = fetch_url("b")',
        '  write crm-[:notes]-> { title: "${a}${b}" }',
      ],
      {
        park: { sink: parks.sink },
        llm: {
          transforms: {
            invoke: async () =>
              ++invocations === 1
                ? { text: 'got', cost: [{ source: 'plugin:fetch_url', microdollars: 900 }] }
                : {
                    error: { kind: 'budget', message: 'run budget spent' },
                    cost: [{ source: 'plugin:fetch_url', microdollars: 200 }],
                  },
          },
        },
      },
    );
    const result = await h.run({ costCapMicrodollars: 1000 });
    expect(result.parked).toBe(true);
    expect(parks.pauses).toEqual([
      { limit: 'cost', capMicrodollars: 1000, spentMicrodollars: 1100 },
    ]);
    expect([...parks.parks.values()].map((p) => p.kind)).toEqual(['suspension']);
  });

  familyRun('adapters, the lookup, locks and the trace: a paged traversal, an identity write, the acting user', async () => {
    const inbox = pagedInbox();
    const trace: MovementTraceEntry[] = [];
    const h = roundTrip(
      [
        '  m-[a:files]-> {',
        '    write crm-[:companies]-> { unique by (`name`) name: a.`filename`, summary: @user_email }',
        '  }',
      ],
      {
        inbox: inbox.adapter,
        trace,
        lookup: {
          resolveActingUser: async ({ getCandidates }) => {
            const [candidate] = await getCandidates();
            return { id: 'user-1', email: candidate?.identity.identifier ?? 'nobody', name: 'Amy' };
          },
        },
      },
    );
    const result = await h.run();
    expect(inbox.cursors).toEqual([null, { after: 'deck.pdf', page: 2 }]);
    expect(h.crm.creates.map((c) => c.fields)).toEqual([
      { name: 'deck.pdf', summary: 'amy@acme.dev' },
      { name: 'cap-table.xlsx', summary: 'amy@acme.dev' },
    ]);
    expect(trace).toEqual(result.trace);
  });

  familyRun('an adapter failure: its message, name and detail, as data', async () => {
    class CrmApiError extends Error {
      readonly status = 409;
      readonly code = 'conflict';
      constructor() {
        super('attio: 409 Conflict');
        this.name = 'CrmApiError';
      }
    }
    const h = roundTrip(['  write crm-[:notes]-> { title: "x" }'], {
      crm: fakeCrm({ createFails: new CrmApiError() }),
    });
    const failure: unknown = await h.run().catch((error: unknown) => error);
    if (!(failure instanceof MovementRunFailed)) throw failure;
    expect(failure.cause).toMatchObject({
      message: 'attio: 409 Conflict',
      name: 'CrmApiError',
      detail: { status: 409, code: 'conflict' },
    });
  });

  familyRun('the call ceiling: answered as data, raised as the engine’s own', async () => {
    const h = roundTrip(['  write crm-[:notes]-> { title: "x" }'], {
      crm: fakeCrm({ createFails: new Error('ceiling') }),
      adapters: {
        classify: (error) =>
          error instanceof Error && error.message === 'ceiling'
            ? { kind: 'call_ceiling', message: 'Affinity call ceiling reached' }
            : adapterErrorOf(error),
      },
    });
    await expect(h.run()).rejects.toMatchObject({
      name: 'AdapterCallCeilingExceeded',
      message: 'Affinity call ceiling reached',
    });
  });

  familyRun('files: a FILE() rendered and READ', async () => {
    const h = roundTrip(
      [
        '  f = File.from("the digest", "text")',
        '  write crm-[:notes]-> { title: coalesce(File.read(f), "unread") }',
      ],
      {
        files: { resolveFileText: async () => ({ text: 'the digest', rawTextId: 'rt-1' }) },
      },
    );
    await h.run();
    expect(h.crm.creates).toEqual([{ recordType: 'note', fields: { title: 'the digest' } }]);
  });

  // Waits (host families version 2): an await on a listenable edge reads the
  // wait the record opened as it entered, binds what counts, and otherwise
  // parks on the wait, woken by what arrived while it parked.
  const chat: InstanceSchema = {
    positions: {
      Message: {
        properties: { Text: 'text', Timestamp: 'text' },
        edges: { Replies: { target: 'Message', listenable: true, sequenced: 'chronological', identity: 'Timestamp' } },
      },
    },
    collections: { messages: { target: 'Message' } },
    writableRoots: {},
  };
  const chatCatalog = mockCatalogSnapshot({ adapters: { chat: { constructionArgs: [], schema: chat } } });
  const chatSource = [
    'import { chat } from adapters',
    'c = connect chat',
    'function m(e: <c-[:messages]->>) {',
    '  msg = only(c-[:messages]->)',
    '  if (msg != null) {',
    '    r = await msg-[:Replies]->',
    '    if (exists(r)) { said = r.Text }',
    '  }',
    '}',
  ].join('\n');
  const reply: LoggedArrival = { seq: 42, identity: '1.5', landing: { recordId: 'r-1', recordType: 'Message', fields: { Text: 'hi', Timestamp: '1.5' } } };
  const quietChat: Adapter = {
    adapterType: 'chat',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async (read) =>
      read.fieldId === 'messages' ? [{ position: makeStablePosition({ adapterType: 'chat', recordType: 'Message', recordId: 'm-1' }) }] : [],
    createRecord: async () => ({ adapterType: 'chat', externalId: 'x', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'chat', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
    arrivals: { awaitKeys: async ({ heads }) => heads.map((head) => ({ key: `thread:${head.recordId}` })) },
  };
  const waitsReading = (arrivals: () => LoggedArrival[]): NonNullable<TestHostOverrides['park']>['waits'] => ({
    mark: async () => ({ mark: 41 }),
    open: async (input) => ({ waitId: 'key' in input ? `wait:${input.key}` : 'wait:gone' }),
    arrivals: async () => ({ arrivals: arrivals() }),
    note: async (input) => ({ counts: input.matched }),
  });
  const chatRun = (park: NonNullable<TestHostOverrides['park']>) =>
    runMovement({
      source: chatSource,
      movementName: 'm',
      event: { pipelineInputId: 'pi-waits', adapterType: 'chat', triggerType: 'webhook', payload: { Text: 'hello' }, recordId: 'm-0' },
      teamId: tenantOfTeam(ROUND_TRIP_TEAM),
      catalog: chatCatalog,
      host: roundTripHost(makeTestHost({ adapters: { resolve: () => quietChat }, park }), REACHED),
    });

  familyRun('waits: an await binds the arrival its wait counts', async () => {
    const parks = makeFakeParkSink();
    const result = await chatRun({ sink: parks.sink, waits: waitsReading(() => [reply]) });
    expect(result.parked).not.toBe(true);
    expect(parks.awaitParks).toEqual([]);
  });

  familyRun('waits: an await parks on its wait, and is woken by what arrived as it parked', async () => {
    const parks = makeFakeParkSink();
    const result = await chatRun({ sink: parks.sink, waits: waitsReading(() => (parks.awaitParks.length > 0 ? [reply] : [])) });
    expect(result.parked).toBe(true);
    expect(parks.awaitParks.map((parked) => parked.waitId)).toEqual(['wait:thread:m-1']);
  });

  it('reached every method on the manifest', () => {
    const skipped = [...declared].filter((name) => !ran.has(name));
    if (skipped.length > 0) return;
    expect([...REACHED].sort()).toEqual(hostMethodPaths().filter((method) => !REACHED_BY_NO_PROGRAM(method)).sort());
  });
});

// Production results are JSON too: a conformance-style run against the real
// built-in email adapter, through the production host, wrapped the same way.
describe('the production host crosses as JSON', () => {
  // The email instance as the adapter describes itself (its natural names),
  // where the static catalog's stand-in carries a test's own spelling.
  const manifestCatalog = staticCatalogSnapshot({
    credentials: { acme_main: { adapters: ['attio'] } },
    instanceSchemas: {
      attio: CRM_SCHEMA,
      email: {
        positions: {
          Email: { properties: { Subject: 'text', From: 'text', Body: 'text' }, edges: { Attachments: { target: 'Attachment' } } },
          Attachment: { properties: { Name: 'text', 'Content Type': 'text', File: 'file' }, edges: {} },
        },
        collections: { message: { target: 'Email' } },
        writableRoots: {},
      },
    },
  });

  it('reads a real email and walks its attachments', async () => {
    const writes: CapturedWrite[] = [];
    const reached = new Set<string>();
    const host = roundTripHost(
      productionEngineHost({
        teamId: ROUND_TRIP_TEAM,
        resolveLive: ({ adapterType }) =>
          adapterType === 'email'
            ? createEmailAdapter({ teamId: ROUND_TRIP_TEAM })
            : fakeCrm().adapter,
        // The fakes' credential ids name no vault row.
        credentials: { belongsTo: () => true },
        writeSink: (write) => writes.push(write),
        locks: new InMemoryWriteLocks(),
        rawText: inMemoryRawTextStore(),
      }),
      reached,
    );
    const result = await runMovement({
      source: [
        'import { email, attio } from adapters',
        'import { acme_main } from credentials',
        'inbox = connect email',
        'crm = connect attio using acme_main',
        '',
        'function intake(m: <inbox-[:Email]->>) {',
        '  m-[a:Attachments]-> {',
        '    write crm-[:notes]-> { title: "${m.`Subject`} from ${m.`From`}: ${a.`Name`}" }',
        '  }',
        '}',
      ].join('\n'),
      movementName: 'intake',
      event: roundTripEvent({
        messageId: '<msg-001@sender.example>',
        subject: 'Series A deck',
        sender: 'jane@acme.example',
        attachments: [
          { key: 'att-deck-1', filename: 'deck.pdf', contentType: 'application/pdf', size: 12345 },
          {
            key: 'att-cap-2',
            filename: 'cap-table.xlsx',
            contentType: 'application/vnd.ms-excel',
            size: 6789,
          },
        ],
      }),
      teamId: tenantOfTeam(ROUND_TRIP_TEAM),
      catalog: manifestCatalog,
      credentialIds: { acme_main: 'cred-attio-1' },
      host,
      dryRun: true,
    });
    expect(writes.map((write) => write.fields)).toEqual([
      { title: 'Series A deck from jane@acme.example: deck.pdf' },
      { title: 'Series A deck from jane@acme.example: cap-table.xlsx' },
    ]);
    expect(result.trace.filter((entry) => entry.kind === 'warning')).toEqual([]);
    expect(reached).toEqual(
      new Set([
        'segment.open',
        // No firing instant was handed in: the segment pins the host's clock.
        'clock.now',
        'adapters.resolve',
        'adapters.call',
        'control.cancel.cancelled',
        'control.cancel.cancelledNow',
        'segment.close',
      ]),
    );
  });
});
