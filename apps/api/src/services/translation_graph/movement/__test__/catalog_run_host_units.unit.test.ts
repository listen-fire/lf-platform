// The run host's units (`manual`, `cron`) are in scope in every file on the
// installed language, already connected: `listen to manual fire go` reads its
// `Invocation` with no import and no `connect`. A team's run snapshot must
// describe them as the handbook's catalog does, or a bare listen whose movement
// reads `go.Text` is refused at the read. The real manifests, the real manual
// adapter and the real assembly run; the database and the CRM are faked.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { LANGUAGE_VERSION } from 'movement-lang';

import { resolveAdapter } from '../../adapters/resolve';
import { createManualAdapter } from '../../adapters/manual';
import { MANUAL_HANDBOOK_SECTION } from '../../adapters/manual/handbook_section';
import { clearIntrospectionCache } from '../instance_cache';
import { movementCatalogForTeam } from '../catalog';
import { diagnoseMovementSource } from '../authoring';

jest.mock('../../../../lib/kysely', () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    external_service_credentials: [
      { id: 'cred-attio-1', name: 'acme_main', type: 'ATTIO', created_at: new Date(1) },
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

jest.mock('../../adapters/remote/store', () => ({ listRemoteAdapters: async () => [] }));

jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));

const TEAM = 'team-1' as TeamId;

function fakeCrm() {
  const companies = {
    typeId: 'companies',
    displayName: 'Companies',
    writable: true,
    readable: true,
  };
  return {
    listEntryPoints: async () => [companies],
    describe: async (typeRef: string) =>
      typeRef === 'companies' || typeRef === 'Companies'
        ? {
            typeId: 'companies',
            displayName: 'Companies',
            supportsFuzzyResolution: ['name'],
            fields: [
              { fieldId: 'name', displayName: 'Name', kind: 'string', writable: true, required: false },
              { fieldId: 'domains', displayName: 'Domains', kind: 'string', writable: true, required: false },
            ],
            references: [],
          }
        : null,
  };
}

beforeEach(() => {
  clearIntrospectionCache();
  (resolveAdapter as jest.Mock).mockImplementation(async ({ adapterType }: { adapterType: string }) =>
    adapterType === 'manual' ? createManualAdapter({ teamId: TEAM }) : fakeCrm(),
  );
});

const SECTION_EXAMPLE = /```[^\n]*\n([\s\S]*?)```/.exec(MANUAL_HANDBOOK_SECTION.content)?.[1] ?? '';

const BARE_READING_TEXT =
  'function echo(go: <manual-[:Invocation]->>) {\n  return go.Text\n}\nlisten to manual fire echo\n';

const CONNECT_READING_TEXT =
  'import { manual } from adapters\nruns = connect manual\nfunction echo(go: <runs-[:Invocation]->>) {\n  return go.Text\n}\nlisten to runs fire echo\n';

async function verdictOf(source: string) {
  const team = await movementCatalogForTeam(TEAM, { source, languageVersion: LANGUAGE_VERSION });
  return diagnoseMovementSource(source, {
    catalog: team.catalog,
    resolveCredentialId: team.resolveCredentialId,
    resolveFile: team.resolveFile,
    ...(team.runSnapshot !== undefined ? { snapshot: team.runSnapshot() } : {}),
    languageVersion: LANGUAGE_VERSION,
  });
}

describe("a team's run snapshot and the run host's units", () => {
  it("validates the handbook's system:manual example", async () => {
    expect(SECTION_EXAMPLE).toContain('listen as "Import companies" to manual fire');
    const verdict = await verdictOf(SECTION_EXAMPLE);
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('validates a bare manual listen whose movement reads the invocation text', async () => {
    const verdict = await verdictOf(BARE_READING_TEXT);
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('still validates the connect-first form', async () => {
    const verdict = await verdictOf(CONNECT_READING_TEXT);
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("describes manual's Invocation in the snapshot as the handbook's catalog does", async () => {
    const team = await movementCatalogForTeam(TEAM, {
      source: BARE_READING_TEXT,
      languageVersion: LANGUAGE_VERSION,
    });
    const invocation = team.runSnapshot?.().adapters.manual?.schemas['']?.positions.Invocation;
    expect(invocation?.properties).toMatchObject({ Text: 'text' });
    expect(invocation?.edges).toMatchObject({ Files: { target: 'File' } });
  });
});
