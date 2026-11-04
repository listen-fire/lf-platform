// The run-path snapshot (what one firing checks and runs against) beside the
// editor's: the run carries only the program's import closure and hands the
// host its credential ids; the editor lists every saved file the program may
// import and never sees an id. An import is allowed only between files on the
// same version (a legacy id is on 0.12's), so neither carries a file on
// another. DB / registry / adapter seams mocked.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { listMovementRows } from '../store';
import {
  movementCatalogForTeam,
  movementCatalogSnapshotForTeam,
  runCatalogSnapshotForTeam,
  type TeamCatalogSnapshot,
} from '../catalog';

jest.mock('../../../../lib/kysely', () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    external_service_credentials: [
      { id: 'cred-attio-1', name: 'Dev Loop Attio', type: 'ATTIO', created_at: new Date(1) },
    ],
  };
  function builder(table: string) {
    const api = {
      where: () => api,
      select: () => api,
      selectAll: () => api,
      orderBy: () => api,
      execute: async () => tables[table] ?? [],
    };
    return api;
  }
  return {
    getQb: () => ({ selectFrom: builder }),
    getCoreQb: () => ({ selectFrom: builder }),
    getKnowledgeQb: () => ({ selectFrom: builder }),
    getAutomationsQb: () => ({ selectFrom: builder }),
  };
});

jest.mock('../../adapters/registry', () => ({
  listAdapterManifests: () => [
    { adapterType: 'attio', requiredCredentialType: 'ATTIO' },
    { adapterType: 'email' },
  ],
  getAdapterManifest: () => ({ methods: [] }),
  indexManifestsByName: (manifests: Array<{ adapterType: string }>) =>
    new Map(manifests.map((m) => [m.adapterType, m])),
}));

jest.mock('../../adapters/remote/store', () => ({ listRemoteAdapters: async () => [] }));

jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));

jest.mock('../store', () => {
  const library = (name: string) =>
    [`export movement ${name}(f: <Files>) {`, '  return node { label: f.`name` }', '}'].join('\n');
  const rows = [
    { name: 'helpers', source: library('tidy'), languageVersion: '2' },
    { name: 'unrelated', source: library('other'), languageVersion: '2' },
    { name: 'on_012', source: library('older'), languageVersion: '0.12.13' },
    {
      name: 'current_helpers',
      source: 'export function tidy(t: <text>) {\n  return t\n}\n',
      languageVersion: jest.requireActual<typeof import('movement-lang')>('movement-lang').LANGUAGE_VERSION,
    },
  ];
  return {
    rows,
    getMovementRowByName: jest.fn(
      async ({ name }: { name: string }) => rows.find((r) => r.name === name) ?? null,
    ),
    listMovementRows: jest.fn(async () => rows),
  };
});

const { rows: savedRows } = jest.requireMock<{ rows: Array<{ name: string; source: string }> }>(
  '../store',
);
const LIBRARY = savedRows.find((r) => r.name === 'helpers')?.source;

const TEAM = 'team-1' as TeamId;

beforeEach(() => jest.clearAllMocks());

/** A program on the legacy id 2, as its libraries are. */
const PROGRAM = ['import { tidy } from "helpers"', 'movement intake(f: <Files>) {', '  y = f.`name`', '}'].join('\n');
const LEGACY = { languageVersion: '2' } as const;

describe('runCatalogSnapshotForTeam', () => {
  it('carries exactly the import closure, not every saved movement', async () => {
    const { snapshot } = await runCatalogSnapshotForTeam(TEAM, { source: PROGRAM, ...LEGACY, imports: 'live' });

    expect(snapshot.files).toEqual({ helpers: { source: LIBRARY } });
    expect(listMovementRows).not.toHaveBeenCalled();
  });

  it('carries no library on another version: a current program importing a legacy library resolves nothing', async () => {
    const { snapshot } = await runCatalogSnapshotForTeam(TEAM, { source: PROGRAM, imports: 'live' });

    expect(snapshot.files).toEqual({});
  });

  it('hands the host the credential ids by import name', async () => {
    const { snapshot, credentialIds } = await runCatalogSnapshotForTeam(TEAM, { source: PROGRAM, ...LEGACY, imports: 'live' });

    expect(credentialIds).toEqual({ 'Dev Loop Attio': 'cred-attio-1' });
    expect(Object.keys(snapshot.credentials)).toEqual(['Dev Loop Attio']);
  });
});

describe('a check for a move up', () => {
  const CURRENT = jest.requireActual<typeof import('movement-lang')>('movement-lang').LANGUAGE_VERSION;

  it('an ordinary check under the current version refuses the legacy library, naming its pin', async () => {
    const catalog = await movementCatalogForTeam(TEAM, { source: PROGRAM, languageVersion: CURRENT });

    expect(catalog.importsAcrossVersions).toEqual(new Map([['helpers', '2']]));
    expect(catalog.runSnapshot?.().files).toEqual({});
  });

  it("reads a library on the movement's own version under the target: the upgrade moves them together", async () => {
    const catalog = await movementCatalogForTeam(TEAM, { source: PROGRAM, languageVersion: CURRENT, upgradingFrom: '2' });

    expect(catalog.importsAcrossVersions).toBeUndefined();
    expect(catalog.runSnapshot?.().files).toEqual({ helpers: { source: LIBRARY } });
  });

  it("resolves a group member to its text as moved, not the saved one", async () => {
    const moved = 'export function tidy(t: <text>) {\n  return t\n}\n';
    const catalog = await movementCatalogForTeam(TEAM, {
      source: PROGRAM,
      languageVersion: CURRENT,
      upgradingFrom: '2',
      movingWith: new Map([['helpers', { source: moved, languageVersion: CURRENT }]]),
    });

    expect(catalog.runSnapshot?.().files).toEqual({ helpers: { source: moved } });
  });
});

describe('movementCatalogSnapshotForTeam (the editor form)', () => {
  it('lists every saved movement on its version and carries no credential ids', async () => {
    const editor = await movementCatalogSnapshotForTeam(TEAM, { source: PROGRAM, ...LEGACY });

    // A legacy id is on 0.12's version, so a 0.12 library is offered; a
    // current one is not.
    expect(Object.keys(editor.snapshot.files ?? {}).sort()).toEqual(['helpers', 'on_012', 'unrelated']);
    expect('credentialIds' in editor).toBe(false);
  });

  it('offers a current program only the current files', async () => {
    const editor = await movementCatalogSnapshotForTeam(TEAM, {});

    expect(Object.keys(editor.snapshot.files ?? {})).toEqual(['current_helpers']);
  });

  it('has no credential-id field at the type level', () => {
    type NoIds = 'credentialIds' extends keyof TeamCatalogSnapshot ? false : true;
    const noIds: NoIds = true;
    expect(noIds).toBe(true);
  });
});
