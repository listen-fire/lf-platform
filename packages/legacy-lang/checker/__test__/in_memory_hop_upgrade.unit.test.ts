// A move up from a legacy id: the Rust check of the installed language joined
// with the TypeScript checker's upgrade warnings (`rustCheck`), which is what an
// upgrade from pins 1 to 4 really runs, so the installed language is the right
// reference here.

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang/language_version';
import { mockCatalog } from '../catalog';
import { checkProgram, diagnosticSeverity, type Diagnostic } from '../check';
import { parseProgram } from '../../parser/parse';
import { mockCatalogSnapshot } from 'movement-lang/service/snapshot';
import { rustCheck } from '../upgrade';

const spec: Parameters<typeof mockCatalog>[0] = {
  adapters: {
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: {
        positions: {
          company: { properties: { name: 'text' }, edges: { notes: { target: 'note', readable: true } } },
          note: { properties: { title: 'text' }, edges: {} },
        },
        collections: { companies: { target: 'company' } },
        writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
      },
    },
  },
  credentials: { crm_cred: { adapter: 'attio' } },
};
const catalog = mockCatalog(spec);
const snapshot = mockCatalogSnapshot(spec);

/** The pin the Rust checker is handed for one of the integers this file is written in. */
const pin = (version: number): LanguageVersion => (version === 5 ? LANGUAGE_VERSION : String(version));

const V4 = (body: string): string =>
  `import { attio } from adapters\nimport { crm_cred } from credentials\nimport { lookup } from plugins\ncrm = attio(credentials: crm_cred)\nmovement m(t: <text>, c: <crm-[:company]->>) {\n${body}\n}\n`;

type Said = { code: string; severity: string; message: string };
const said = (found: Diagnostic[]): Said[] =>
  found.filter((d) => d.code !== 'MOV_LISTEN_MISSING').map((d) => ({ code: d.code, severity: diagnosticSeverity(d), message: d.message }));

// ORDER BY and LIMIT on a hop over records the run already holds were ignored
// by both engines before 5 and are read from 5, so a move up says so.
describe('an in-memory hop with ORDER BY or LIMIT, on a move up across 5', () => {
  const upgrade = (body: string, options: { languageVersion: number; upgradingFrom?: number }): Said[] => {
    const ts = said(checkProgram(parseProgram(V4(body), { languageVersion: options.languageVersion }), catalog, options));
    // Below 5 the TypeScript checker alone answers; a move up from 4 is the
    // Rust check of 5 joined with the TypeScript checker's upgrade warnings
    // (rustCheck, ruling B).
    const rust = options.languageVersion >= 5 ? said(rustCheck({ snapshot, languageVersion: pin(options.languageVersion), ...(options.upgradingFrom !== undefined ? { upgradingFrom: pin(options.upgradingFrom) } : {}) })(V4(body))) : ts;
    expect(rust).toEqual(ts);
    return ts.filter((d) => d.code === 'MOV_IN_MEMORY_HOP_ORDER');
  };
  const GRAPH = '  g = graph { title: "t", parts: [{ label: "two", n: 2 }, { label: "one", n: 1 }] }\n';
  const NODE = '  d = node { title: "t", people: [node { name: "Cy", rank: 3 }, node { name: "Ann", rank: 1 }] }\n';

  it('warns a graph literal, a node literal and an expression hop', () => {
    const [d] = upgrade(`${GRAPH}  g-[p:parts ORDER BY p.n]-> {\n    x = p.label\n  }`, { languageVersion: 5, upgradingFrom: 4 });
    expect(d).toEqual({
      code: 'MOV_IN_MEMORY_HOP_ORDER',
      severity: 'warning',
      message: expect.stringContaining("the ORDER BY on '-[:parts]->' is read: the hop walks records the run already holds"),
    });
    expect(d?.message).toContain('Its result may change');
    const [both] = upgrade(`${NODE}  d-[p:people ORDER BY p.rank LIMIT 1]-> {\n    x = p.name\n  }`, { languageVersion: 5, upgradingFrom: 4 });
    expect(both?.message).toContain("the ORDER BY and LIMIT on '-[:people]->' are read");
    expect(upgrade(`${GRAPH}  xs = g-[p:parts LIMIT 1]->.label`, { languageVersion: 5, upgradingFrom: 4 })).toHaveLength(1);
    const extracted = '  x = extract from [t] {\n    node deals: "each deal" {\n      name: "the company name"\n    }\n  }\n';
    expect(upgrade(`${extracted}  x-[k:deals LIMIT 2]-> {\n    y = k.name\n  }`, { languageVersion: 5, upgradingFrom: 4 })).toHaveLength(1);
  });

  it('says nothing of a source hop, a hop without either, or a check that is no move up', () => {
    expect(upgrade('  c-[n:notes ORDER BY n.title]-> {\n    x = n.title\n  }', { languageVersion: 5, upgradingFrom: 4 })).toEqual([]);
    expect(upgrade(`${GRAPH}  g-[p:parts]-> {\n    x = p.label\n  }`, { languageVersion: 5, upgradingFrom: 4 })).toEqual([]);
    expect(upgrade(`${GRAPH}  g-[p:parts ORDER BY p.n]-> {\n    x = p.label\n  }`, { languageVersion: 4 })).toEqual([]);
    expect(upgrade(`${GRAPH}  g-[p:parts ORDER BY p.n]-> {\n    x = p.label\n  }`, { languageVersion: 5 })).toEqual([]);
  });
});
