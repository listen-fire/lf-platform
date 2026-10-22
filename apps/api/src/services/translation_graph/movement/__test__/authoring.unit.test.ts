// The authoring validation surface (`diagnoseMovementSource`) — the
// propose → typecheck → repair loop's feedback half, as the movement
// author agent consumes it:
//
//   1. parse errors surface as MOV_PARSE with a line/col + source line;
//   2. check diagnostics surface with codes, severities, spans;
//   3. on a current pin the wasm checker's verdict is the whole verdict:
//      no engine scan (a nested movement declaration is its refusal);
//   4. a clean file reports ok with its listener inventory;
//   5. unknown credentials/fields produce the named diagnostics the
//      repair loop keys on.
//
// The catalog is a hand-built `Catalog` object — no registry, no DB — and its
// run snapshot, which a current pin is checked against (by the wasm alone).

// Order-sensitive cycle guard (mirrors save.unit.test.ts): pre-require
// schemas.ts so `expressionSchema` resolves before any ES import pulls it
// transitively through ../../types.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('engine-contracts/expression/schemas');

// `authoring.ts` exposes the team wrapper too, which imports ../catalog
// (adapter registry + DB). This suite drives the pure core only.
jest.mock('../catalog', () => ({
  movementCatalogForTeam: jest.fn(async () => {
    throw new Error('test: movementCatalogForTeam must not be called');
  }),
}));

import { BridgeError, catalogSnapshotOf } from 'movement-lang';

import type { Catalog, InstanceSchema } from 'movement-lang';
import type { AuthoringDiagnostic } from '../authoring';

import { assessMovementValidity, diagnoseMovementSource, validateMovementForTeam } from '../authoring';
import { movementCatalogForTeam } from '../catalog';

const emailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { subject: 'text', sender: 'text', text: 'text' },
      edges: {},
    },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const attioSchema: InstanceSchema = {
  positions: {
    companies: {
      properties: { name: 'text', description: 'text' },
      edges: {},
    },
  },
  collections: { companies: { target: 'companies' } },
  writableRoots: {
    companies: {
      fields: { name: 'text', description: 'text' },
      resultShape: { externalId: 'text', url: 'text', name: 'text', description: 'text' },
    },
  },
};

const slackSchema: InstanceSchema = {
  positions: {},
  collections: { post_message: { target: 'post_message' } },
  writableRoots: {
    post_message: {
      fields: { channel: 'text', text: 'text' },
      resultShape: { externalId: 'text', channel: 'text', text: 'text' },
    },
  },
};

const catalog: Catalog = {
  adapter(name) {
    // `canFire` is explicit on a hand-built spec (mockCatalog defaults it on;
    // this fixture doesn't go through it). Email really does fire — its
    // manifest declares a webhook trigger — so a listen on it must check.
    if (name === 'email') return { constructionArgs: [{ name: 'credentials', kind: 'position', required: false }], canFire: true, triggerConfig: ['key'] };
    if (name === 'attio') {
      return { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]};
    }
    if (name === 'slack') {
      return { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]};
    }
    return undefined;
  },
  credential(name) {
    if (name === 'main_crm') return { adapters: ['attio'] };
    if (name === 'team_chat') return { adapters: ['slack'] };
    return undefined;
  },
  plugin() {
    return undefined;
  },
  instantiate(adapterName) {
    if (adapterName === 'email') return emailSchema;
    if (adapterName === 'attio') return attioSchema;
    if (adapterName === 'slack') return slackSchema;
    return undefined;
  },
};

// The run snapshot of the same catalog: a current pin is checked against it.
const snapshot = catalogSnapshotOf(catalog, { adapters: ['email', 'attio', 'slack'], credentials: ['main_crm', 'team_chat'] });

const CLEAN_SOURCE = `import { email, attio, slack } from adapters
import { main_crm, team_chat } from credentials

inbox = connect email
crm   = connect attio using main_crm
chat  = connect slack using team_chat

function intake(m: <inbox-[:message]->>) {
  co = write crm-[:companies]-> {
    unique by (\`name\`)
    name:        m.\`subject\`
    description: "Introduced by \${m.\`sender\`}"
  }
  write chat-[:post_message]-> {
    channel: "intake"
    text:    "New company (record \${co.\`externalId\`})"
  }
}

listen to inbox { key: "intake" } fire intake
`;

describe('diagnoseMovementSource', () => {
  it('a clean file validates ok with its listener inventory', () => {
    const result = diagnoseMovementSource(CLEAN_SOURCE, { catalog, snapshot });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.listenerCount).toBe(1);
    expect(result.firedMovements).toEqual(['intake']);
  });

  it('a parse error surfaces as MOV_PARSE with position and source line', () => {
    const source = 'movement broken( {\n';
    const result = diagnoseMovementSource(source, { catalog, snapshot });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0];
    expect(d.code).toBe('MOV_PARSE');
    expect(d.line).toBe(1);
    expect(d.sourceLine).toContain('movement broken(');
  });

  it('an unknown credential import is a named diagnostic with a span', () => {
    const source = CLEAN_SOURCE.replace(
      'import { main_crm, team_chat } from credentials',
      'import { not_a_credential, team_chat } from credentials',
    ).replace('credentials: main_crm', 'credentials: not_a_credential');
    const result = diagnoseMovementSource(source, { catalog, snapshot });
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('MOV_IMPORT_UNKNOWN');
    for (const d of result.diagnostics) {
      expect(d.line).toBeGreaterThan(0);
      expect(d.col).toBeGreaterThan(0);
    }
  });

  it('a write into an unknown field is reported by the typed check', () => {
    const source = CLEAN_SOURCE.replace('name:        m.`subject`', 'nam:         m.`subject`');
    const result = diagnoseMovementSource(source, { catalog, snapshot });
    expect(result.ok).toBe(false);
    const hit = result.diagnostics.find((d) => d.message.includes("'nam'"));
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('error');
    expect(hit?.sourceLine).toContain('nam:');
  });

  it('a nested movement declaration is the wasm checker\'s refusal, with no engine scan on a current pin', () => {
    const source = CLEAN_SOURCE.replace(
      'co = write crm-[:companies]-> {',
      'movement nested(x: <inbox-[:message]->>) {\n    y = x.`subject`\n  }\n  co = write crm-[:companies]-> {',
    );
    const result = diagnoseMovementSource(source, { catalog, snapshot });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).not.toContain('MOV_ENGINE_UNSUPPORTED');
    const refusal = result.diagnostics.find((d) => d.severity === 'error');
    expect(refusal?.message).toContain('a declaration is a `function`');
    expect(refusal?.sourceLine).toContain('movement nested(');
  });

  it('a diagnostic with an exact rewrite carries it as 1-based edits, and says it in the message', () => {
    const source = CLEAN_SOURCE.replace('import { email, attio, slack } from adapters', 'import { email, slack } from adapters');
    const result = diagnoseMovementSource(source, { catalog, snapshot });
    const unresolved = result.diagnostics.filter((d) => d.code === 'MOV_NAME_UNRESOLVED');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].message).toBe(
      "'attio' is not in scope — import it: add 'import { attio } from adapters' at the top of the file",
    );
    expect(unresolved[0].fix).toEqual({
      edits: [{ line: 1, col: 1, endLine: 1, endCol: 1, text: 'import { attio } from adapters\n' }],
    });
    const repaired = `import { attio } from adapters\n${source}`;
    expect(diagnoseMovementSource(repaired, { catalog, snapshot }).ok).toBe(true);
  });

  it('a library file (no listens) reports zero listeners and validates ok', () => {
    const source = CLEAN_SOURCE.replace(/listen to inbox.*\n/, '');
    const result = diagnoseMovementSource(source, { catalog, snapshot });
    expect(result.listenerCount).toBe(0);
    expect(result.firedMovements).toEqual([]);
    // The MOV_LISTEN_MISSING info may appear; nothing error-severity should.
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('validateMovementForTeam catalog-assembly guard', () => {
  const mock = movementCatalogForTeam as jest.Mock;
  const teamCatalogStub = {
    catalog,
    resolveCredentialId: () => undefined,
    resolveFile: () => undefined,
    notes: [] as string[],
    gaps: [],
    runSnapshot: () => snapshot,
  };
  afterEach(() => mock.mockClear());

  it('falls back to the whole-workspace catalog when scoped assembly throws a source error', async () => {
    mock
      .mockRejectedValueOnce(new BridgeError('Unexpected END', 0))
      .mockResolvedValueOnce(teamCatalogStub);

    const result = await validateMovementForTeam({ teamId: 'team-1', source: CLEAN_SOURCE });

    expect(result).toHaveProperty('diagnostics');
    expect(mock).toHaveBeenCalledTimes(2);
    // The retry describes NOTHING. Source that will not parse never reaches
    // type-checking, so no schema can inform the diagnostic — and fetching
    // every type of every connected system to report a missing bracket is the
    // whole-graph load this campaign exists to remove.
    expect(mock.mock.calls[1][1]).toEqual({ types: [] });
  });

  it('never answers a clean ok off the empty catalog — the fallback is UNVERIFIED', async () => {
    mock
      .mockRejectedValueOnce(new BridgeError('credential scan blew up', 0))
      .mockResolvedValueOnce(teamCatalogStub);

    const result = await validateMovementForTeam({ teamId: 'team-1', source: CLEAN_SOURCE });

    // The source itself is clean, so nothing error-severity fires — which is
    // exactly the case that used to come back a confident `ok` meaning only
    // "nothing was checked".
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].detail).toContain('nothing was checked against live schemas');
    expect(result.gaps[0].detail).toContain('credential scan blew up');
    // …and the note says the same thing, for the surfaces that render notes.
    expect(result.catalogNotes.join(' ')).toContain('nothing was checked against live schemas');
    expect(
      assessMovementValidity({ diagnostics: result.diagnostics, gaps: result.gaps }).status,
    ).toBe('unverified');
  });

  it('a scan that SUCCEEDS records no gap of its own', async () => {
    mock.mockResolvedValueOnce(teamCatalogStub);

    const result = await validateMovementForTeam({ teamId: 'team-1', source: CLEAN_SOURCE });

    expect(result.gaps).toEqual([]);
    expect(
      assessMovementValidity({ diagnostics: result.diagnostics, gaps: result.gaps }).status,
    ).toBe('valid');
  });

  it('rethrows a non-source (infra) error without falling back', async () => {
    mock.mockRejectedValueOnce(new Error('DB unreachable'));

    await expect(
      validateMovementForTeam({ teamId: 'team-1', source: CLEAN_SOURCE }),
    ).rejects.toThrow('DB unreachable');
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('assessMovementValidity (validity status derivation)', () => {
  const diag = (severity: AuthoringDiagnostic['severity']): AuthoringDiagnostic => ({
    code: 'MOV_X',
    message: 'boom',
    severity,
    line: 1,
    col: 1,
    endLine: 1,
    endCol: 2,
    sourceLine: 'x',
  });

  it('error diagnostics → invalid (precedence over gaps)', () => {
    const r = assessMovementValidity({
      diagnostics: [diag('error')],
      gaps: [{ adapter: 'acme_crm', detail: 'unreachable' }],
    });
    expect(r.status).toBe('invalid');
    expect(r.reason).toEqual({ diagnostics: [diag('error')] });
  });

  it('no errors but an introspection gap → unverified', () => {
    const r = assessMovementValidity({
      diagnostics: [diag('warning')],
      gaps: [{ adapter: 'acme_crm', detail: 'needs-secret' }],
    });
    expect(r.status).toBe('unverified');
    expect(r.reason).toEqual({ gaps: [{ adapter: 'acme_crm', detail: 'needs-secret' }] });
  });

  it('no errors, no gaps → valid with null reason', () => {
    const r = assessMovementValidity({ diagnostics: [diag('info')], gaps: [] });
    expect(r.status).toBe('valid');
    expect(r.reason).toBeNull();
  });
});
