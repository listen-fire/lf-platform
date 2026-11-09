// A module installed from a package is connected by its package's name
// (``connect `@lf/attio` ``), as the handbook teaches; the platform's own
// modules by `#` and their key (`connect #kg`). The team's catalog says which
// is which, and the compile path finds a packaged connection's schema by it,
// so a misspelled field is refused rather than left untyped.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { LANGUAGE_VERSION } from 'movement-lang';

import { resolveAdapter } from '../../adapters/resolve';
import { createManualAdapter } from '../../adapters/manual';
import { clearIntrospectionCache } from '../instance_cache';
import { movementCatalogForTeam, staticCatalogSnapshot } from '../catalog';
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

const reading = (connect: string, field: string) =>
  `crm = ${connect} using acme_main\nfunction tidy(go: <manual-[:Invocations]->>) {\n  crm-[c:Companies]-> {\n    write c { ${field}: go.Text }\n  }\n}\nlisten to manual-[:Invocations]-> fire tidy\n`;

async function verdictOf(source: string) {
  const team = await movementCatalogForTeam(TEAM, { audience: { for: 'run' }, source, languageVersion: LANGUAGE_VERSION });
  return diagnoseMovementSource(source, {
    catalog: team.catalog,
    resolveCredentialId: team.resolveCredentialId,
    resolveFile: team.resolveFile,
    ...(team.runSnapshot !== undefined ? { snapshot: team.runSnapshot() } : {}),
    languageVersion: LANGUAGE_VERSION,
  });
}

describe('how connect names a module', () => {
  it('names each packaged module by its package, and none of the platform\'s own', () => {
    const adapters = staticCatalogSnapshot().adapters;
    expect(adapters.attio?.package).toBe('@lf/attio');
    expect(adapters.google_sheets?.package).toBe('@lf/google-sheets');
    expect(adapters.ask?.package).toBe('@lf/ask');
    expect(adapters.kg?.package).toBeUndefined();
    expect(adapters['native-valuations']?.package).toBeUndefined();
    expect(adapters.manual?.package).toBeUndefined();
  });

  it('validates a packaged connect, typed by its connection', async () => {
    const verdict = await verdictOf(reading('connect `@lf/attio`', 'Name'));
    expect(verdict.diagnostics).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("refuses a misspelled field through a packaged connect: the connection's schema was found", async () => {
    const verdict = await verdictOf(reading('connect `@lf/attio`', 'Nmae'));
    expect(verdict.ok).toBe(false);
    expect(verdict.diagnostics.map((d) => d.message).join('\n')).toContain('Nmae');
  });

  it('refuses the short name, with the package as the fix', async () => {
    const verdict = await verdictOf(reading('connect attio', 'Name'));
    expect(verdict.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('connect `@lf/attio` using acme_main'),
    ]);
  });
});
