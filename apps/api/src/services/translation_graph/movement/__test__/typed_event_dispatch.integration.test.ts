// Layer 3 — a change arrival, the DISPATCH path against the REAL DB. Drives
// `dispatchTriggerByIdEvent` (the in-process trigger entry: gates →
// runMovementFiring → runMovement → recorder → Postgres) with an Attio change
// arriving on a company's `Changes` edge and a movement that branches on the
// change's `Kind` and walks the change's `Company` edge. Proves the wiring
// author-time rigor can't catch: the arrival's landing becomes the seed, its
// `Kind` reads off it, and the `-[:Company]->` hop hydrates the live record —
// through the real firing + recorder, read back exactly as the agent surface
// does.
//
// The two NETWORK seams a bare test DB can't stand up are mocked (and ONLY
// those): the catalog's live adapter introspection (`runCatalogSnapshotForTeam`)
// and adapter I/O (`resolveAdapter`). Everything else — dispatch gates, the
// firing, the run recorder, the engine seed/branch/traverse — runs for real.

import { randomUUID } from 'node:crypto';

// ── Mocks: the two network seams (catalog introspection + adapter I/O) ───────

jest.mock('../catalog', () => {
  const actual = jest.requireActual('../catalog');
  return { ...actual, runCatalogSnapshotForTeam: jest.fn() };
});
jest.mock('../../adapters/resolve', () => {
  const actual = jest.requireActual('../../adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn() };
});

import { LANGUAGE_VERSION } from 'movement-lang';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { Adapter, RuntimeCapabilities } from 'movement-engine/public/adapter';
import type { CatalogSnapshot, InstanceSchema } from 'movement-lang';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { seedTeamCredential } from '../../../../test/harness/credentials';
import { dispatchTriggerByIdEvent } from '../../triggers/router';
import { inspectMovementRun, listMovementRuns } from '../run_now';
import {
  runCatalogSnapshotForTeam,
  snapshotOverManifests,
  staticCatalogFromManifests,
} from '../catalog';
import { resolveAdapter } from '../../adapters/resolve';
import { mintMovementVersionIfChanged } from '../version_store';
import {
  makeStablePosition,
  positionData,
} from 'engine-contracts/catalog';
import { containerAssociation } from 'movement-engine/public/adapter';


const mockedCatalog = runCatalogSnapshotForTeam as jest.Mock;
const mockedResolve = resolveAdapter as jest.Mock;

/** The one company Attio still has; a change to any other finds no live record. */
const LIVE_COMPANY = 'co-1';

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

// The Attio instance schema as the module describes it: a company's changes
// arrive on its `Changes` edge, landing on `CompanyChange`, whose `Company`
// edge reads the company as it is now.
const CHANGE_KINDS = ['created', 'updated', 'deleted'];
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    Companies: {
      properties: { Name: 'text' },
      edges: { Changes: { target: 'CompanyChange', readable: false, listenable: true } },
    },
    CompanyChange: {
      properties: { Id: 'text', Kind: { kind: 'enum', options: CHANGE_KINDS }, Record: 'text' },
      edges: { Company: { target: 'Companies', requiresLiveRecord: true } },
    },
  },
  collections: { Companies: { target: 'Companies' } },
  writableRoots: {},
};

function buildCatalog(): CatalogSnapshot {
  const base = staticCatalogFromManifests({
    credentials: {
      acme_main: { adapters: ['attio'] },
      acme_slack: { adapters: ['slack'] },
    },
  });
  return snapshotOverManifests({
    ...base,
    instantiate(name, args) {
      if (name === 'attio') return ATTIO_SCHEMA;
      return base.instantiate(name, args);
    },
  });
}

// Fake Attio SOURCE: the change's `-[:Company]->` edge hydrates the live
// record, which Attio has only for LIVE_COMPANY.
function makeAttioSourceFake(): Adapter {
  return {
    adapterType: 'attio',
    supportedTriggers: ['webhook'] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId] ?? null;
    },
    async getRelated({ position, fieldId }) {
      if (fieldId !== 'Company') return [];
      const data = positionData(position) as { Record?: string } | undefined;
      if (data?.Record !== LIVE_COMPANY) return [];
      return [
        {
          position: makeStablePosition({
            adapterType: 'attio',
            recordType: 'Companies',
            recordId: LIVE_COMPANY,
            data: { Name: 'Acme' },
          }),
        },
      ];
    },
    async createRecord() {
      throw new Error('test: attio is a source here');
    },
    async updateRecord() {
      throw new Error('test: attio is a source here');
    },
    async deleteRecord() {
      return {};
    },
  };
}

function makeSlackTargetFake(): { adapter: Adapter; creates: Record<string, unknown>[] } {
  const creates: Record<string, unknown>[] = [];
  const adapter: Adapter = {
    adapterType: 'slack',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push(input.fields);
      return { adapterType: 'slack', externalId: `msg-${creates.length}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: 'slack', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const NOTIFY_NEW_COMPANY = [
  'crm = connect `@lf/attio` using acme_main',
  'chat = connect `@lf/slack` using acme_slack',
  '',
  'function notify_new_company(change: <crm-[:CompanyChange]->>) {',
  '  if (change.`Kind` == "created") {',
  '    change-[co:Company]-> {',
  '      write chat-[:messages]-> {',
  '        channel: "#alerts"',
  '        text: co.`Name`',
  '      }',
  '    }',
  '  }',
  '}',
  '',
  'listen to crm-[:Companies]->-[:Changes]-> fire notify_new_company',
].join('\n');

async function seedMovementWithAttioTrigger(teamId: TeamId): Promise<{
  movementId: MovementId;
  triggerId: TriggerId;
}> {

  const movementId = randomUUID() as MovementId;
  await getAutomationsQb(['movement'])
    .insertInto('movement')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: movementId, team_id: teamId, name: 'Notify new company', source: NOTIFY_NEW_COMPANY, language_version: LANGUAGE_VERSION } as any)
    .execute();
  // Shipped: a firing runs the movement's current version.
  await mintMovementVersionIfChanged({ teamId, movementId, source: NOTIFY_NEW_COMPANY, languageVersion: LANGUAGE_VERSION });

  const triggerId = randomUUID() as TriggerId;
  await getAutomationsQb(['trigger'])
    .insertInto('trigger')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({
      id: triggerId,
      team_id: teamId,
      name: 'Attio record changes',
      kind: 'attio',
      movement_id: movementId,
      fired_movement_name: 'notify_new_company',
    } as any)
    .execute();

  return { movementId, triggerId };
}

/** What Attio's webhook becomes at the door: a change arriving on the
 *  company's `Changes` edge, carrying the company it is about. */
function changeArrival(input: { kind: 'created' | 'updated' | 'deleted'; company: string }): TriggerEvent {
  const id = `chg-${input.kind}-${input.company}`;
  return arrivalTriggerOf({
    pipelineInputId: 'trigger:test',
    adapterType: 'attio',
    arrival: {
      edge: 'Changes',
      key: input.company,
      identity: id,
      landing: { recordId: id, recordType: 'CompanyChange', fields: { Id: id, Kind: input.kind, Record: input.company } },
      parents: [{ recordId: input.company, recordType: 'Companies', fields: {} }],
      about: { recordType: 'Companies', externalId: input.company },
      occurredAt: new Date().toISOString(),
    },
    now: new Date(),
  });
}

describe('a change arrival — dispatch path (real DB)', () => {
  let teamId: TeamId;
  let credentialId: string;
  let slackCreates: Record<string, unknown>[];

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({
        id: teamId,
        name: `typed-ev-${teamId.slice(0, 8)}`,
      } as any)
      .execute();
    credentialId = await seedTeamCredential(teamId);

    // The catalog: hand-built (the live introspection seam is faked).
    const catalog = buildCatalog();
    mockedCatalog.mockResolvedValue({
      snapshot: catalog,
      credentialIds: Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, credentialId])),
      notes: [],
    });

    // Adapter I/O: a fake Attio source + a fake Slack target.
    const target = makeSlackTargetFake();
    slackCreates = target.creates;
    mockedResolve.mockImplementation(async ({ adapterType }: { adapterType: string }) => {
      if (adapterType === 'attio') return makeAttioSourceFake();
      if (adapterType === 'slack') return target.adapter;
      throw new Error(`test: no fake for '${adapterType}'`);
    });
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
    jest.clearAllMocks();
  });

  it('a company created → branches on Kind + traverses + hydrates a write carrying "Acme"', async () => {
    const { movementId, triggerId } = await seedMovementWithAttioTrigger(teamId);

    const result = await dispatchTriggerByIdEvent({
      triggerId,
      teamId,
      event: changeArrival({ kind: 'created', company: LIVE_COMPANY }),
    });

    // The firing applied exactly one write (the Kind branch taken, the traversal hydrated).
    expect(result.movementFirings).toEqual([
      { movementName: 'notify_new_company', writes: 1, dryRun: false },
    ]);
    // The committed write carries the HYDRATED field — not blank.
    expect(slackCreates).toEqual([{ channel: '#alerts', text: 'Acme' }]);

    // And it's recorded — readable back as the agent surface reads it.
    const [{ runId }] = await listMovementRuns({ teamId, movementId });
    const detail = await inspectMovementRun({ teamId, runId });
    if ('error' in detail) throw new Error(detail.error);
    expect(detail.status).toBe('success');
    expect(detail.writes).toHaveLength(1);
    expect(detail.writes[0].values).toMatchObject({ text: 'Acme' });
  });

  it('a company Attio no longer has → the Kind branch is taken but the Company hop is empty: zero writes', async () => {
    const { triggerId } = await seedMovementWithAttioTrigger(teamId);

    const result = await dispatchTriggerByIdEvent({
      triggerId,
      teamId,
      event: changeArrival({ kind: 'created', company: 'co-gone' }),
    });

    expect(result.movementFirings).toEqual([
      { movementName: 'notify_new_company', writes: 0, dryRun: false },
    ]);
    expect(slackCreates).toEqual([]);
  });

  it('a company deleted does not satisfy the created branch — the live-record hop is not walked: zero writes', async () => {
    const { triggerId } = await seedMovementWithAttioTrigger(teamId);

    const result = await dispatchTriggerByIdEvent({
      triggerId,
      teamId,
      event: changeArrival({ kind: 'deleted', company: LIVE_COMPANY }),
    });

    expect(result.movementFirings).toEqual([
      { movementName: 'notify_new_company', writes: 0, dryRun: false },
    ]);
    expect(slackCreates).toEqual([]);
  });
});
