// What fires is what shipped. A save that stops at `needsConfirmation` keeps
// its text on the movement row (the editor's draft) and mints no version; a
// firing runs the current version's text, pins that version on the run, and
// resolves its file imports to each imported file's current version too. The
// editor's test run is the one door that runs the draft: it exists to try the
// text being edited. A movement that never shipped does not fire.
//
// Real DB, real save path for the unconfirmed edits, real router and engine.
// Only the network seams are mocked, as pinned_resume.integration.test.ts
// does: the run's catalog snapshot and adapter I/O. The import half drives the
// real catalog assembly, which for a manual-only file touches no network.

import { randomUUID } from 'node:crypto';

jest.mock('../catalog', () => {
  const actual = jest.requireActual('../catalog');
  return { ...actual, runCatalogSnapshotForTeam: jest.fn(actual.runCatalogSnapshotForTeam) };
});
jest.mock('../../adapters/resolve', () => {
  const actual = jest.requireActual('../../adapters/resolve');
  return { ...actual, resolveAdapter: jest.fn() };
});

import { LANGUAGE_VERSION, fromCatalogSnapshot } from 'movement-lang';
import { eventAddressKey } from 'legacy-lang';
import { spelledFor } from 'legacy-lang/checker/__test__/surface_spelling';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { Adapter, RuntimeCapabilities } from 'movement-engine/public/adapter';
import type { CatalogSnapshot, InstanceSchema, PositionSchema } from 'movement-lang';
import type { TriggerEvent } from 'movement-engine/public/inbound';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { seedTeamCredential } from '../../../../test/harness/credentials';
import { dispatchTriggerByIdEvent } from '../../triggers/router';
import { runCatalogSnapshotForTeam, snapshotOverManifests, staticCatalogFromManifests } from '../catalog';
import { resolveAdapter } from '../../adapters/resolve';
import { mintMovementVersionIfChanged } from '../version_store';
import { saveMovement } from '../provision';
import { runMovementTestRun } from '../test_run';
import { positionData } from 'engine-contracts/catalog';
import { containerAssociation } from 'movement-engine/public/adapter';

const mockedCatalog = runCatalogSnapshotForTeam as jest.Mock;
const mockedResolve = resolveAdapter as jest.Mock;
const actualCatalog = (jest.requireActual('../catalog') as { runCatalogSnapshotForTeam: typeof runCatalogSnapshotForTeam })
  .runCatalogSnapshotForTeam;

function permissiveCaps(): RuntimeCapabilities {
  return { traversal: { incoming: true, edgeProperties: true }, resources: true };
}

const ACTIONS = ['record.created', 'record.updated', 'record.deleted'];
const EVENT = 'Webhook Event';
const graftPositions: Record<string, PositionSchema> = {};
const graftVariants: string[] = [];
for (const action of ACTIONS) {
  const key = eventAddressKey({ event: EVENT, narrowing: { action } });
  graftVariants.push(key);
  graftPositions[key] = { properties: { action: { kind: 'enum', options: ACTIONS } }, edges: {} };
}
const ATTIO_SCHEMA: InstanceSchema = {
  positions: {
    [EVENT]: { properties: { action: { kind: 'enum', options: ACTIONS } }, edges: {} },
    ...graftPositions,
  },
  collections: {},
  unions: { [EVENT]: graftVariants },
  writableRoots: {},
  eventPosition: EVENT,
  eventPositions: [{ position: EVENT }],
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
    async getRelated() {
      return [];
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

const ANNOUNCE = (marker: string) =>
  [
    'import { attio, slack } from adapters',
    'import { acme_main, acme_slack } from credentials',
    '',
    'crm = attio(credentials: acme_main)',
    'chat = slack(credentials: acme_slack)',
    '',
    'movement announce(ev: <crm-[:`Webhook Event`]->>) {',
    '  write chat-[:messages]-> {',
    '    channel: "#alerts"',
    `    text: "${marker}"`,
    '  }',
    '}',
    '',
    'listen to crm { events: ["record.created"] } fire announce',
  ].join('\n');

/** An edit that cannot be read: its save stops at `needsConfirmation`. */
const BROKEN_EDIT = (marker: string) => `${ANNOUNCE(marker)}\nmovement half_written(`;

function spelled(text: string): string {
  return spelledFor(LANGUAGE_VERSION, text, fromCatalogSnapshot(buildCatalog()));
}

function webhookEvent(): TriggerEvent {
  return {
    pipelineInputId: 'trigger:test',
    adapterType: 'attio',
    triggerType: 'webhook',
    payload: { event_type: 'record.created', action: 'record.created', id: { object_id: 'obj-x', record_id: 'co-1' } },
    changeType: 'create',
    rootRecordType: 'Companies',
    externalRecordRef: { adapterType: 'attio', externalId: 'co-1', recordType: 'Companies' },
    occurredAt: new Date().toISOString(),
  };
}

describe('a firing runs the shipped text, not a draft (real DB)', () => {
  let teamId: TeamId;
  let credentialId: string;
  let slackCreates: Record<string, unknown>[];

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `shipped-text-${teamId.slice(0, 8)}` } as any)
      .execute();
    credentialId = await seedTeamCredential(teamId);
    const catalog = buildCatalog();
    mockedCatalog.mockImplementation(async () => ({
      snapshot: catalog,
      credentialIds: Object.fromEntries(Object.keys(catalog.credentials).map((name) => [name, credentialId])),
      notes: [],
    }));
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

  /** A movement that shipped `text` (row + minted version), and its listener. */
  async function shipped(text: string): Promise<{ movementId: MovementId; triggerId: TriggerId; versionId: string }> {
    const movementId = randomUUID() as MovementId;
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: movementId, team_id: teamId, name: 'Announce', source: text, language_version: LANGUAGE_VERSION } as any)
      .execute();
    const { versionId } = await mintMovementVersionIfChanged({ teamId, movementId, source: text, languageVersion: LANGUAGE_VERSION });
    const triggerId = await listenerOf(movementId);
    return { movementId, triggerId, versionId };
  }

  async function listenerOf(movementId: MovementId): Promise<TriggerId> {
    const triggerId = randomUUID() as TriggerId;
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: triggerId, team_id: teamId, name: 'Attio record changes', kind: 'attio', movement_id: movementId, fired_movement_name: 'announce' } as any)
      .execute();
    return triggerId;
  }

  const runsOf = (triggerId: TriggerId) =>
    getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('trigger_id', '=', triggerId)
      .select(['status', 'movement_version_id'])
      .execute();

  it('an unconfirmed invalid edit of a shipped movement never changes what fires', async () => {
    const { triggerId, versionId } = await shipped(spelled(ANNOUNCE('SHIPPED')));

    const edit = await saveMovement({ teamId, source: BROKEN_EDIT('DRAFT'), name: 'Announce' });
    expect(edit).toMatchObject({ ok: false, needsConfirmation: true });
    const row = await getAutomationsQb(['movement'])
      .selectFrom('movement')
      .where('team_id', '=', teamId)
      .select(['source', 'current_version_id'])
      .executeTakeFirstOrThrow();
    // The draft is on the row; the shipped version is still current.
    expect(row.source).toBe(BROKEN_EDIT('DRAFT'));
    expect(row.current_version_id).toBe(versionId);

    const outcome = await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });

    expect(outcome.errors).toBeUndefined();
    expect(outcome.movementFirings).toEqual([{ movementName: 'announce', writes: 1, dryRun: false }]);
    expect(slackCreates).toEqual([{ channel: '#alerts', text: 'SHIPPED' }]);
    expect(await runsOf(triggerId)).toEqual([{ status: 'success', movement_version_id: versionId }]);
    // The run's catalog was assembled for the shipped text, its imports
    // resolved to their shipped versions.
    expect(mockedCatalog).toHaveBeenCalledWith(teamId, {
      source: spelled(ANNOUNCE('SHIPPED')),
      languageVersion: LANGUAGE_VERSION,
      imports: 'shipped',
    });
  });

  it('a movement that never shipped does not fire', async () => {
    const movementId = randomUUID() as MovementId;
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: movementId, team_id: teamId, name: 'Announce', source: spelled(ANNOUNCE('NEVER')), language_version: LANGUAGE_VERSION } as any)
      .execute();
    const triggerId = await listenerOf(movementId);

    const outcome = await dispatchTriggerByIdEvent({ triggerId, teamId, event: webhookEvent() });

    expect(outcome).toEqual({ evaluations: [], droppedReason: 'not_shipped' });
    expect(slackCreates).toEqual([]);
    expect(await runsOf(triggerId)).toEqual([]);
  });

  it("the editor's test run runs the live text the author is editing", async () => {
    const { triggerId } = await shipped(spelled(ANNOUNCE('SHIPPED')));
    await getAutomationsQb(['movement'])
      .updateTable('movement')
      .set({ source: spelled(ANNOUNCE('EDITING')) })
      .where('team_id', '=', teamId)
      .execute();

    const result = await runMovementTestRun({ teamId, triggerId, invent: async () => ({ action: 'record.created' }) });

    if (!result.ok) throw new Error(`test: the test run failed: ${result.error}`);
    expect(JSON.stringify(result.writes)).toContain('EDITING');
    expect(JSON.stringify(result.writes)).not.toContain('SHIPPED');
    expect(slackCreates).toEqual([]);
    expect(mockedCatalog).toHaveBeenCalledWith(teamId, {
      source: spelled(ANNOUNCE('EDITING')),
      languageVersion: LANGUAGE_VERSION,
      imports: 'live',
    });
  });
});

describe("a firing's file imports resolve to the imported file's shipped text (real DB)", () => {
  let teamId: TeamId;

  const LIBRARY = (marker: string) =>
    ['export function greeting(who: <text>) {', `  return CONCAT(who, "/${marker}")`, '}'].join('\n');

  const ROOT = [
    'import { manual } from adapters',
    'import { greeting } from "lib/words"',
    '',
    'runs = connect manual',
    '',
    'function noted(go: <runs-[:`Invocation`]->>) {',
    '  said = greeting("hi")',
    '}',
    '',
    'listen to runs {} fire noted',
  ].join('\n');

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `shipped-imports-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  async function library(): Promise<void> {
    const movementId = randomUUID() as MovementId;
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: movementId, team_id: teamId, name: 'lib/words', source: LIBRARY('SHIPPED'), language_version: LANGUAGE_VERSION } as any)
      .execute();
    await mintMovementVersionIfChanged({ teamId, movementId, source: LIBRARY('SHIPPED'), languageVersion: LANGUAGE_VERSION });
  }

  it('an import whose target has an unshipped edit resolves to the shipped text', async () => {
    await library();
    const edit = await saveMovement({ teamId, source: `${LIBRARY('DRAFT')}\nexport function half_written(`, name: 'lib/words' });
    expect(edit).toMatchObject({ ok: false, needsConfirmation: true });

    const firing = await actualCatalog(teamId, { source: ROOT, languageVersion: LANGUAGE_VERSION, imports: 'shipped' });
    expect(firing.snapshot.files?.['lib/words']?.source).toBe(LIBRARY('SHIPPED'));

    // The editor's test run reads the drafts, as the editor does.
    const editing = await actualCatalog(teamId, { source: ROOT, languageVersion: LANGUAGE_VERSION, imports: 'live' });
    expect(editing.snapshot.files?.['lib/words']?.source).toBe(`${LIBRARY('DRAFT')}\nexport function half_written(`);
  });

  it('an import of a file that never shipped does not resolve for a firing', async () => {
    await getAutomationsQb(['movement'])
      .insertInto('movement')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: randomUUID(), team_id: teamId, name: 'lib/words', source: LIBRARY('NEVER'), language_version: LANGUAGE_VERSION } as any)
      .execute();

    const firing = await actualCatalog(teamId, { source: ROOT, languageVersion: LANGUAGE_VERSION, imports: 'shipped' });
    expect(firing.snapshot.files?.['lib/words']).toBeUndefined();
  });
});
