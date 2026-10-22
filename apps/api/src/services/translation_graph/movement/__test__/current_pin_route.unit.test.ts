// A movement on a pin the installed language reads is judged by the wasm
// checker alone, against the run snapshot: neither legacy-lang's TypeScript
// checker nor legacy-engine's interpretability scan is asked. A legacy id
// keeps both. A pin the installed language does not read is its version
// diagnostic alone, nothing asked.

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

const counters = { rust: 0, ts: 0, scan: 0 };

jest.mock('movement-lang', () => {
  const actual = jest.requireActual('movement-lang');
  return {
    ...actual,
    checkSourceInRust: (...args: unknown[]) => {
      counters.rust += 1;
      return actual.checkSourceInRust(...args);
    },
  };
});

jest.mock('legacy-lang', () => {
  const actual = jest.requireActual('legacy-lang');
  return {
    ...actual,
    checkProgram: (...args: unknown[]) => {
      counters.ts += 1;
      return actual.checkProgram(...args);
    },
  };
});

jest.mock('@listen-fire/legacy-engine/services/movement_engine/interpretable', () => {
  const actual = jest.requireActual('@listen-fire/legacy-engine/services/movement_engine/interpretable');
  return {
    ...actual,
    listUnsupportedConstructs: (...args: unknown[]) => {
      counters.scan += 1;
      return actual.listUnsupportedConstructs(...args);
    },
  };
});

jest.mock('../catalog', () => ({ movementCatalogForTeam: jest.fn() }));

import { LANGUAGE_VERSION, fromCatalogSnapshot, mockCatalogSnapshot, type LanguageVersion } from 'movement-lang';

import { diagnoseMovementSource } from '../authoring';
import { routeOf } from '../language_route';

const BARE_MANUAL = 'function echo(run: <manual-[:Invocation]->>) {\n  return 1\n}\nlisten to manual fire echo\n';

const IMPORT_COMPANIES = `import { attio } from adapters
import { acme_main } from credentials

crm = connect attio using acme_main

function \`Import Companies\`(go: <manual-[:Invocation]->>) {
  write crm-[:Companies]-> {
    unique by (Name)
    Name: go.Text
  }
}

listen as "Import companies" to manual fire \`Import Companies\`
`;

const snapshot = mockCatalogSnapshot({
  adapters: {
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: {
        positions: { Companies: { properties: { Name: 'text' }, edges: {} } },
        collections: { Companies: { target: 'Companies' } },
        writableRoots: { Companies: { fields: { Name: 'text' }, resultShape: { externalId: 'text', Name: 'text' } } },
      },
    },
  },
  credentials: { acme_main: { adapters: ['attio'] } },
});
const catalog = fromCatalogSnapshot(snapshot);

function diagnose(source: string, languageVersion: LanguageVersion) {
  counters.rust = 0;
  counters.ts = 0;
  counters.scan = 0;
  const validation = diagnoseMovementSource(source, { catalog, snapshot, languageVersion });
  return { validation, counters: { ...counters } };
}

describe('a current pin is checked by the wasm only', () => {
  it('a bare manual listen validates, the wasm asked once and nothing else', () => {
    const { validation, counters: asked } = diagnose(BARE_MANUAL, LANGUAGE_VERSION);
    expect(validation.diagnostics.map((d) => d.code)).not.toContain('MOV_ENGINE_UNSUPPORTED');
    expect(validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.firedMovements).toEqual(['echo']);
    expect(asked).toEqual({ rust: 1, ts: 0, scan: 0 });
  });

  it('a named manual listen beside a constructed system validates the same way', () => {
    const { validation, counters: asked } = diagnose(IMPORT_COMPANIES, LANGUAGE_VERSION);
    expect(validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.firedMovements).toEqual(['Import Companies']);
    expect(asked).toEqual({ rust: 1, ts: 0, scan: 0 });
  });

  it('the same bare text pinned to a legacy id keeps the scan, which refuses it', () => {
    const { validation, counters: asked } = diagnose(BARE_MANUAL, '4');
    expect(validation.ok).toBe(false);
    const unsupported = validation.diagnostics.find((d) => d.code === 'MOV_ENGINE_UNSUPPORTED');
    expect(unsupported?.message).toContain("a movement seeded from 'manual'");
    expect(asked).toEqual({ rust: 0, ts: 1, scan: 1 });
  });

  it('a pin from a newer line is its version diagnostic alone, nothing asked', () => {
    const { validation, counters: asked } = diagnose(BARE_MANUAL, '0.13.0');
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics).toHaveLength(1);
    expect(validation.diagnostics[0]?.code).toMatch(/^MOV_LANGUAGE_VERSION_/);
    expect(validation.diagnostics[0]?.message).toContain('0.13.0');
    expect(asked).toEqual({ rust: 0, ts: 0, scan: 0 });
  });

  it('throws without the run snapshot', () => {
    expect(() => diagnoseMovementSource(BARE_MANUAL, { catalog, languageVersion: LANGUAGE_VERSION })).toThrow(
      'a release pin is checked against its run snapshot',
    );
  });
});

describe('routeOf', () => {
  it('reads a legacy id as legacy, the installed line as installed, and refuses any other line', () => {
    expect(routeOf('4')).toEqual({ kind: 'legacy', pin: '4' });
    expect(routeOf(LANGUAGE_VERSION)).toEqual({ kind: 'installed', pin: LANGUAGE_VERSION });
    expect(routeOf('0.12.0')).toEqual({ kind: 'installed', pin: '0.12.0' });
    for (const pin of ['0.11.0', '0.13.0']) {
      const route = routeOf(pin);
      expect(route.kind).toBe('refused');
      if (route.kind !== 'refused') continue;
      expect(route.diagnostic.code).toMatch(/^MOV_LANGUAGE_VERSION_/);
      expect(route.diagnostic.message).toContain(pin);
    }
  });
});
