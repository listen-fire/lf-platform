// The deploy check's sweep, over a fake movement store: it moves no pin (only
// an explicit upgrade does); which movements are offered the upgrade, which
// have their diagnostics stored and a Validation Issue emitted, which are
// refused (a preservation failure, or a release pin the installed language
// does not read), and that a second run on the same release does nothing.

jest.mock('../../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));
jest.mock('../authoring', () => ({
  validateMovementForTeam: jest.fn(),
  assessMovementValidity: jest.fn(),
  toAuthoringDiagnostic: (d: { code: string; message: string }) => ({
    code: d.code,
    message: d.message,
    severity: 'error',
    line: 1,
    col: 1,
    endLine: 1,
    endCol: 1,
    sourceLine: '',
  }),
}));
jest.mock('../firing_context', () => ({ withTeamContext: jest.fn() }));
jest.mock('../store', () => ({
  advanceMovementLanguageVersion: jest.fn(),
  getMovementRow: jest.fn(),
  listAllMovementRows: jest.fn(),
  recordUpgradeCheck: jest.fn(),
  recordValidityOutcome: jest.fn(),
}));
jest.mock('../version_store', () => ({ movementSourceHash: () => 'hash' }));
jest.mock('../provision', () => ({ saveMovement: jest.fn() }));
// The real authoring core is loaded by one case below; its team wrapper's
// catalog assembly is never reached.
jest.mock('../catalog', () => ({ movementCatalogForTeam: jest.fn() }));

import { LANGUAGE_VERSION, fromCatalogSnapshot, mockCatalog, mockCatalogSnapshot, type LanguageVersion, type PluginOutput, type PluginSpec, type ResolveFile } from 'movement-lang';
import { checkProgram } from 'legacy-lang';
import { parseProgram } from 'legacy-lang';

import { assessMovementValidity, type AuthoringDiagnostic } from '../authoring';

import { advanceMovementLanguageVersion, getMovementRow, type MovementRow } from '../store';
import { saveMovement } from '../provision';
import {
  runDeployCheck,
  upgradeMovement,
  type DeployCheckDeps,
  type DeployCheckSummary,
  type PlatformLanguageRelease,
  type ValidateUnder,
} from '../language_upgrade';
import { DEPRECATED_VERSION, RELEASE_APPLIED, VALIDATION_ISSUE } from '@listen-fire/system';

/** The installed language. */
const CUR = LANGUAGE_VERSION;

const RELEASE: PlatformLanguageRelease = {
  current: CUR,
  legacy: new Set(['1', '2', '3', '4']),
  deprecated: new Set<LanguageVersion>(),
};

function movement(over: Partial<MovementRow> & { id: string }): MovementRow {
  return {
    teamId: 'team-1',
    name: over.id,
    source: `source of ${over.id}`,
    description: '',
    triggerId: null,
    currentVersionId: null,
    validityStatus: null,
    validityReason: null,
    validitySourceHash: null,
    validityCheckedAt: null,
    validityConsentedAt: null,
    validityCheckedAgainst: null,
    languageVersion: '1',
    upgradeDiagnostics: null,
    upgradeCheckedAgainst: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function diagnostic(severity: AuthoringDiagnostic['severity'], message: string): AuthoringDiagnostic {
  return { code: 'X', message, severity, line: 3, col: 1, endLine: 3, endCol: 2, sourceLine: '' };
}

/** A warning the checker raised because the check is a move up: a construct
 *  whose meaning changed between the versions. */
function meaningChanged(message: string): AuthoringDiagnostic {
  return { ...diagnostic('warning', message), code: 'MOV_PLUGIN_OUTPUT_CHANGED', upgrade: true };
}

/** What each movement validates to, under each version. */
type Verdicts = Record<string, Partial<Record<LanguageVersion, AuthoringDiagnostic[]>>>;

/** An in-memory movement store behind the check's seams. */
function fakeStore(input: {
  movements: MovementRow[];
  verdicts: Verdicts;
  release?: PlatformLanguageRelease;
}) {
  const upgradeDiagnostics = new Map<string, AuthoringDiagnostic[]>();
  const validity = new Map<string, LanguageVersion>();
  const events: Array<{ teamId: string; kind: string; reason: string; version: string }> = [];
  const runs: Array<{ tag: string; languageRelease: string; summary: DeployCheckSummary }> = [];
  const validations: Array<Parameters<ValidateUnder>[0]> = [];

  const deps: DeployCheckDeps = {
    release: { tag: 'v0.8.0', language: input.release ?? RELEASE },
    alreadyRan: async ({ tag, languageRelease }) =>
      runs.some((r) => r.tag === tag && r.languageRelease === languageRelease),
    listMovements: async () => input.movements,
    sourceHash: (source) => `hash:${source}`,
    validate: async (validation) => {
      validations.push(validation);
      return {
        diagnostics: input.verdicts[validation.movement.id]?.[validation.languageVersion] ?? [],
        gaps: [],
      };
    },
    recordValidity: async ({ movement: m, checkedAgainst }) => {
      validity.set(m.id, checkedAgainst);
    },
    recordUpgradeCheck: async ({ movement: m, diagnostics }) => {
      upgradeDiagnostics.set(m.id, diagnostics);
    },
    emit: async ({ teamId, kind, payload }) => {
      events.push({ teamId, kind: kind.typeId, reason: payload.reason, version: payload.version });
    },
    recordRun: async (run) => {
      runs.push(run);
    },
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  };
  return { deps, upgradeDiagnostics, validity, events, runs, validations };
}

/** The check has no seam that moves a pin; this proves it reached for no
 *  other way to move one either. */
function expectNoPinMoved(): void {
  expect(advanceMovementLanguageVersion).not.toHaveBeenCalled();
  expect(saveMovement).not.toHaveBeenCalled();
}

beforeEach(() => jest.clearAllMocks());

describe('the deploy check', () => {
  it('offers the upgrade to a movement clean under the current version, and keeps its pin', async () => {
    const store = fakeStore({ movements: [movement({ id: 'clean' })], verdicts: {} });

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    expect(store.validity.get('clean')).toBe('1');
    expect(store.upgradeDiagnostics.get('clean')).toEqual([]);
    expect(summary?.automations).toEqual([
      expect.objectContaining({
        name: 'clean',
        outcome: 'upgradable',
        from: { version: '1', name: '1' },
        to: { version: CUR, name: CUR },
      }),
    ]);
    expect(store.events.map((e) => e.kind)).toEqual([RELEASE_APPLIED.typeId]);
  });

  it('offers the upgrade when the only warning is a cost note, and prints the note', async () => {
    const note = {
      ...diagnostic('warning', "WHERE on 'Searches' runs here, not at the source"),
      code: 'MOV_HOP_WHERE_ENGINE',
    };
    const store = fakeStore({ movements: [movement({ id: 'noted' })], verdicts: { noted: { [CUR]: [note] } } });

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    expect(store.upgradeDiagnostics.get('noted')).toEqual([]);
    expect(store.events.map((e) => e.kind)).toEqual([RELEASE_APPLIED.typeId]);
    expect(summary?.automations[0]).toEqual(
      expect.objectContaining({
        outcome: 'upgradable',
        notes: "line 3: WHERE on 'Searches' runs here, not at the source",
      }),
    );
  });

  it('stores a meaning-changed warning as standing in the way, and emits a Validation Issue', async () => {
    const warning = meaningChanged('extracted text is never null under this version');
    const note = diagnostic('warning', "ORDER BY on 'Messages' runs here");
    const store = fakeStore({
      movements: [movement({ id: 'warns' })],
      verdicts: { warns: { [CUR]: [warning, note, diagnostic('info', 'just advice')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    // Only what blocks the move is stored — the cost note and the info say
    // nothing about it.
    expect(store.upgradeDiagnostics.get('warns')).toEqual([warning]);
    expect(summary?.automations[0]?.notes).toBe("line 3: ORDER BY on 'Messages' runs here");
    expect(summary?.counts).toEqual(
      expect.objectContaining({ upgradable: 0, warned: 1, refused: 0 }),
    );
    const issue = store.events.find((e) => e.kind === VALIDATION_ISSUE.typeId);
    expect(issue).toEqual(
      expect.objectContaining({ version: '1', teamId: 'team-1' }),
    );
    expect(issue?.reason).toContain('line 3: extracted text is never null under this version');
  });

  it('refuses a movement that fails under its own pin: logs and stores it', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'broken' })],
      verdicts: { broken: { 1: [diagnostic('error', 'unknown field')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    expect(store.validity.get('broken')).toBe('1');
    expect(summary?.automations[0]).toEqual(
      expect.objectContaining({ outcome: 'refused', detail: 'line 3: unknown field' }),
    );
    expect(store.events.map((e) => e.kind)).toEqual([VALIDATION_ISSUE.typeId, RELEASE_APPLIED.typeId]);
  });

  it('says so when a refused movement was already failing under its pin before the release', async () => {
    const store = fakeStore({
      movements: [
        movement({
          id: 'was-broken',
          validityStatus: 'invalid',
          validityCheckedAgainst: '1',
          validitySourceHash: 'hash:source of was-broken',
        }),
      ],
      verdicts: { 'was-broken': { 1: [diagnostic('error', 'unknown field')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations[0]).toEqual(
      expect.objectContaining({
        outcome: 'refused',
        detail: 'already failing before this release: line 3: unknown field',
      }),
    );
  });

  it('leaves a movement already on the current version alone', async () => {
    const store = fakeStore({ movements: [movement({ id: 'now', languageVersion: CUR })], verdicts: {} });

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations[0]?.outcome).toBe('current');
    expect(store.upgradeDiagnostics.has('now')).toBe(false);
  });

  it('does nothing the second time on the same release', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'clean' }), movement({ id: 'warns' })],
      verdicts: { warns: { [CUR]: [meaningChanged('changed meaning')] } },
    });

    expect(await runDeployCheck(store.deps)).not.toBeNull();
    const eventsAfterFirst = store.events.length;

    expect(await runDeployCheck(store.deps)).toBeNull();
    expect(store.runs).toHaveLength(1);
    expect(store.events).toHaveLength(eventsAfterFirst);
  });

  it('emits one Release Applied per workspace, carrying the release and that workspace\'s counts', async () => {
    const store = fakeStore({
      movements: [
        movement({ id: 'a' }),
        movement({ id: 'b', teamId: 'team-2' }),
        movement({ id: 'c', teamId: 'team-2' }),
      ],
      verdicts: { c: { [CUR]: [meaningChanged('changed meaning')] } },
    });

    await runDeployCheck(store.deps);

    const applied = store.events.filter((e) => e.kind === RELEASE_APPLIED.typeId);
    expect(applied.map((e) => e.teamId)).toEqual(['team-1', 'team-2']);
    expect(applied[1]?.reason).toContain('Release v0.8.0 applied');
    expect(applied[1]?.reason).toContain(`Clean under ${CUR}, upgraded when you ask: 1`);
    expect(applied[1]?.reason).toContain('Not clean under it: 1');
  });

  it('tells a movement left on a deprecated version so', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'old' })],
      verdicts: { old: { [CUR]: [diagnostic('error', 'retired spelling')] } },
      release: { ...RELEASE, deprecated: new Set(['1']) },
    });

    const summary = await runDeployCheck(store.deps);

    expect(store.events.map((e) => e.kind)).toContain(DEPRECATED_VERSION.typeId);
    expect(summary?.automations[0]).toEqual(expect.objectContaining({ outcome: 'warned', deprecated: true }));
  });

  it('marks a movement it could not check unverified and carries on', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'flaky' }), movement({ id: 'clean' })],
      verdicts: {},
    });
    const validate = store.deps.validate;
    store.deps.validate = async (input) => {
      if (input.movement.id === 'flaky') throw new Error('catalog unreachable');
      return validate(input);
    };

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations.map((a) => [a.name, a.outcome])).toEqual([
      ['flaky', 'unverified'],
      ['clean', 'upgradable'],
    ]);
    expectNoPinMoved();
  });
});

describe('a pin by the compatibility rule', () => {
  it('a legacy id takes the legacy path; a release pin is current when the installed language reads it, refused otherwise', async () => {
    const store = fakeStore({
      movements: [
        movement({ id: 'legacy', languageVersion: '4' }),
        movement({ id: 'same-line', languageVersion: '0.12.0' }),
        movement({ id: 'older-line', languageVersion: '0.11.0' }),
        movement({ id: 'newer', languageVersion: '0.13.0' }),
      ],
      verdicts: {},
    });

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    expect(summary?.automations.map((a) => [a.name, a.outcome])).toEqual([
      ['legacy', 'upgradable'],
      ['same-line', 'current'],
      ['older-line', 'refused'],
      ['newer', 'refused'],
    ]);
    const refused = summary?.automations.filter((a) => a.outcome === 'refused') ?? [];
    for (const entry of refused) expect(entry.detail).toContain(entry.from.version);
    // A pin the installed language does not read is never validated.
    expect(store.validations.map((v) => v.movement.id)).toEqual(['legacy', 'legacy', 'same-line']);
    expect(store.events.filter((e) => e.kind === VALIDATION_ISSUE.typeId).map((e) => e.version)).toEqual([
      '0.11.0',
      '0.13.0',
    ]);
  });

  it('keys the release by the installed language and the legacy ids', async () => {
    const store = fakeStore({ movements: [], verdicts: {} });
    await runDeployCheck(store.deps);
    expect(store.runs.map((r) => r.languageRelease)).toEqual([`current=${CUR};legacy=1,2,3,4`]);
  });
});

describe('an explicit upgrade by the compatibility rule', () => {
  const recorded = () => {
    const validations: Array<Parameters<ValidateUnder>[0]> = [];
    const validate: ValidateUnder = async (validation) => {
      validations.push(validation);
      return { diagnostics: [], gaps: [] };
    };
    return { validations, validate };
  };

  it('from a legacy id: validated under the installed language as a move from the id, and moved there', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old', languageVersion: '4' }));
    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    const { validations, validate } = recorded();
    const advanced: LanguageVersion[] = [];

    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate,
      advance: async ({ to }) => {
        advanced.push(to);
        return { ok: true };
      },
    });

    expect(result).toEqual(
      expect.objectContaining({ status: 'upgraded', from: { version: '4', name: '4' }, to: { version: CUR, name: CUR } }),
    );
    expect(validations.map((v) => [v.languageVersion, v.upgradingFrom])).toEqual([[CUR, '4']]);
    expect(advanced).toEqual([CUR]);
  });

  it('from an older line: validated as written under the installed language, as a move from its pin, and moved there', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'older', languageVersion: '0.11.0' }));
    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    const { validations, validate } = recorded();
    const advanced: Array<{ to: LanguageVersion; source?: string }> = [];

    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'older',
      acknowledge: true,
      validate,
      advance: async ({ to, source }) => {
        advanced.push({ to, ...(source !== undefined ? { source } : {}) });
        return { ok: true };
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: 'upgraded', from: { version: '0.11.0', name: '0.11.0' } }));
    expect(validations.map((v) => [v.languageVersion, v.upgradingFrom, v.source])).toEqual([[CUR, '0.11.0', undefined]]);
    expect(advanced).toEqual([{ to: CUR }]);
  });

  it('a pin on the installed line is already current', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'now', languageVersion: '0.12.0' }));
    const { validations, validate } = recorded();
    const result = await upgradeMovement({ teamId: 'team-1', id: 'now', acknowledge: true, validate });
    expect(result.status).toBe('already_current');
    expect(validations).toEqual([]);
  });

  it('a newer release has nothing to move to: blocked with the rule\'s text', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'newer', languageVersion: '0.13.0' }));
    const { validations, validate } = recorded();
    const result = await upgradeMovement({ teamId: 'team-1', id: 'newer', acknowledge: true, validate });
    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked',
        diagnostics: [expect.objectContaining({ code: 'MOV_LANGUAGE_VERSION_UNSUPPORTED' })],
      }),
    );
    expect(validations).toEqual([]);
    expect(advanceMovementLanguageVersion).not.toHaveBeenCalled();
  });
});

describe('which checks are upgrade checks', () => {
  const told = (validations: Array<Parameters<ValidateUnder>[0]>) =>
    validations.map((v) => [v.movement.id, v.languageVersion, v.upgradingFrom]);

  it('the sweep tells the checker the pin when checking under the newer version, and only then', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'old' }), movement({ id: 'now', languageVersion: CUR })],
      verdicts: {},
    });

    await runDeployCheck(store.deps);

    expect(told(store.validations)).toEqual([
      ['old', '1', undefined],
      ['old', CUR, '1'],
      ['now', CUR, undefined],
    ]);
  });

  it('an explicit upgrade tells the checker the pin it is moving from', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    const validations: Array<Parameters<ValidateUnder>[0]> = [];

    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: false,
      validate: async (validation) => {
        validations.push(validation);
        return { diagnostics: [], gaps: [] };
      },
    });

    expect(result.status).toBe('needs_acknowledgement');
    expect(told(validations)).toEqual([['old', CUR, '1']]);
  });
});

describe('an explicit upgrade: errors block, meaning-changed warnings are acknowledged', () => {
  const upgradeWith = async (diagnostics: AuthoringDiagnostic[]) => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    return upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: false,
      validate: async () => ({ diagnostics, gaps: [] }),
    });
  };

  it('a cost note alone is clean', async () => {
    const result = await upgradeWith([diagnostic('warning', "ORDER BY on 'Messages' runs here")]);
    expect(result).toEqual(expect.objectContaining({ status: 'needs_acknowledgement', diagnostics: [] }));
  });

  it('a meaning-changed warning is listed and awaits acknowledgement', async () => {
    const warning = meaningChanged('changed meaning');
    const result = await upgradeWith([warning, diagnostic('warning', 'a cost note')]);
    expect(result).toEqual(
      expect.objectContaining({ status: 'needs_acknowledgement', diagnostics: [warning] }),
    );
  });

  it('a meaning-changed warning moves up once acknowledged', async () => {
    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate: async () => ({ diagnostics: [meaningChanged('changed meaning')], gaps: [] }),
    });
    expect(result.status).toBe('upgraded');
  });

  it('an error blocks even when acknowledged', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    const error = diagnostic('error', 'refused');
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate: async () => ({ diagnostics: [error, meaningChanged('changed meaning')], gaps: [] }),
    });
    expect(result.status).toBe('blocked');
  });
});

describe('the upgrade rewrites the text by its fixes first', () => {
  // A validation that refuses each old spelling with its rewrite, as the
  // checker does under 5 (`MOV_V5_SPELLING`), and anything else it is told.
  const OLD = 'chat = slack()\nmovement go() {\n  x = UPPER("a")\n}';
  const NEW = 'chat = connect slack\nfunction go() {\n  x = Text.upper("a")\n}';
  const spelling = (line: number, from: string, to: string, source: string): AuthoringDiagnostic[] => {
    const text = source.split('\n')[line - 1] ?? '';
    const col = text.indexOf(from) + 1;
    if (col === 0) return [];
    return [
      {
        ...diagnostic('error', `\`${from}\` is written \`${to}\``),
        code: 'MOV_V5_SPELLING',
        line,
        col,
        endLine: line,
        endCol: col + from.length,
        fix: { edits: [{ line, col, endLine: line, endCol: col + from.length, text: to }], safe: true },
      },
    ];
  };
  const underFive =
    (extra: AuthoringDiagnostic[] = []): ValidateUnder =>
    async ({ movement: m, languageVersion, source }) => {
      const text = source ?? m.source;
      if (languageVersion !== CUR) return { diagnostics: [], gaps: [] };
      return {
        diagnostics: [
          ...spelling(1, 'slack()', 'connect slack', text),
          ...spelling(2, 'movement', 'function', text),
          ...spelling(3, 'UPPER', 'Text.upper', text),
          ...extra,
        ],
        gaps: [],
      };
    };
  const FIVE = RELEASE;

  it('the deploy check never rewrites: a movement in the old spelling keeps its text and its pin, and is told an upgrade rewrites it', async () => {
    const store = fakeStore({ movements: [movement({ id: 'old', languageVersion: '4', source: OLD })], verdicts: {}, release: FIVE });
    store.deps.validate = underFive();
    const summary = await runDeployCheck(store.deps);
    expect(summary?.automations.map((a) => a.outcome)).toEqual(['warned']);
    expectNoPinMoved();
    expect(store.upgradeDiagnostics.get('old')?.map((d) => d.code)).toEqual(['MOV_V5_SPELLING', 'MOV_V5_SPELLING', 'MOV_V5_SPELLING']);
    const issue = store.events.find((e) => e.kind === VALIDATION_ISSUE.typeId);
    expect(issue?.reason).toContain('Upgrading the automation rewrites what the checker can fix');
  });

  it('the deploy check never rewrites, even where an error is left beside the old spellings', async () => {
    const left = diagnostic('error', 'no field Nope on note');
    const store = fakeStore({ movements: [movement({ id: 'old', languageVersion: '4', source: OLD })], verdicts: {}, release: FIVE });
    store.deps.validate = underFive([left]);
    const summary = await runDeployCheck(store.deps);
    expect(summary?.automations.map((a) => a.outcome)).toEqual(['warned']);
    expectNoPinMoved();
  });

  it('a movement already in the new spelling is offered the upgrade, its pin and text untouched', async () => {
    const store = fakeStore({ movements: [movement({ id: 'new', languageVersion: '4', source: NEW })], verdicts: {}, release: FIVE });
    store.deps.validate = underFive();
    const summary = await runDeployCheck(store.deps);
    expect(summary?.automations.map((a) => a.outcome)).toEqual(['upgradable']);
    expectNoPinMoved();
  });

  it('an explicit upgrade shows the rewrite, and saves it with the pin once acknowledged', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(movement({ id: 'old', languageVersion: '4', source: OLD }));
    const shown = await upgradeMovement({ teamId: 'team-1', id: 'old', acknowledge: false, validate: underFive() });
    expect(shown).toEqual(expect.objectContaining({ status: 'needs_acknowledgement', upgradedSource: NEW, diagnostics: [] }));

    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    const advanced: Array<{ to: LanguageVersion; source?: string }> = [];
    const done = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate: underFive(),
      advance: async ({ to, source }) => {
        advanced.push({ to, ...(source !== undefined ? { source } : {}) });
        return { ok: true };
      },
    });
    expect(done.status).toBe('upgraded');
    expect(advanced).toEqual([{ to: CUR, source: NEW }]);
    jest.mocked(getMovementRow).mockReset();
  });

  it('an acknowledged move whose save does not ship is unverified, with why', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old', languageVersion: '4', source: OLD }));
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate: underFive(),
      advance: async () => ({ ok: false, detail: 'the rewritten text did not ship: a system could not be read' }),
    });
    expect(result).toEqual(
      expect.objectContaining({ status: 'unverified', detail: 'the rewritten text did not ship: a system could not be read' }),
    );
  });
});

describe('a meaning-changed construct inside an imported library', () => {
  // The real checker behind the validation seam: the movement is clean itself,
  // and only the library it imports uses a plugin whose output changed at 2.
  // The legacy checker still reads a plugin's older output shapes, which the
  // language's catalog type no longer declares (legacy-lang \`earlierOutputsOf\`).
  const SCAN_WEB = {
    args: ['url'],
    priced: false,
    effects: { reads: ['the web'], ai: true },
    output: { kind: 'records', fields: { url: 'text', text: 'text' } },
    earlierOutputs: [{ before: 2, output: { kind: 'value', type: 'text' } }],
  } satisfies PluginSpec & { earlierOutputs: Array<{ before: number; output: PluginOutput }> };
  const catalog = mockCatalog({
    adapters: {
      slack: {
        constructionArgs: [],
        schema: {
          positions: {
            channel: { properties: { Name: 'text' }, edges: {} },
            note: { properties: { Body: 'text' }, edges: {} },
          },
          collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
          writableRoots: {
            note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
          },
        },
      },
    },
    plugins: { scan_web: SCAN_WEB },
  });
  const LIBRARY = [
    'import { slack } from adapters',
    'import { scan_web } from plugins',
    'chat = slack()',
    'export movement scan_channel(c: <chat-[:channel]->>) {',
    '  pages = scan_web(url: c.`Name`)',
    '  first = FIRST(pages)',
    '  write chat-[:note]-> { Body: first.text }',
    '}',
  ].join('\n');
  const resolveFile: ResolveFile = (path) => (path === 'lib/scan' ? { source: LIBRARY } : undefined);

  const checkWithLibrary: ValidateUnder = async ({ movement: m, languageVersion, upgradingFrom }) => ({
    diagnostics: checkProgram(parseProgram(m.source, { languageVersion }), catalog, {
      languageVersion,
      resolveFile,
      ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
    }).map((d) => ({
      code: d.code,
      message: d.message,
      severity: d.severity ?? 'error',
      ...(d.upgrade === true ? { upgrade: true as const } : {}),
      line: d.span.start.line,
      col: d.span.start.col,
      endLine: d.span.end.line,
      endCol: d.span.end.col,
      sourceLine: '',
    })),
    gaps: [],
  });

  it('keeps the importer on its pin and stores the warning', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'importer', source: 'import { scan_channel } from "lib/scan"\n' })],
      verdicts: {},
    });
    store.deps.validate = checkWithLibrary;

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    expect(summary?.automations[0]?.outcome).toBe('warned');
    // Under the installed language the library's old spellings block too
    // (MOV_V5_SPELLING); the meaning-changed warning is stored beside them.
    expect(store.upgradeDiagnostics.get('importer')).toContainEqual(
      expect.objectContaining({
        code: 'MOV_PLUGIN_OUTPUT_CHANGED',
        severity: 'warning',
        upgrade: true,
        message: expect.stringContaining('"lib/scan" line'),
      }),
    );
  });
});

describe('the deploy check over the real authoring core', () => {
  // The validation seam is the real `diagnoseMovementSource` against a run
  // snapshot: a legacy id by legacy-lang, a current pin by the wasm alone.
  const snapshot = mockCatalogSnapshot({
    adapters: {
      email: {
        constructionArgs: [{ name: 'credentials', kind: 'position', required: false }],
        triggerConfig: ['key'],
        schema: {
          positions: { message: { properties: { Subject: 'text' }, edges: {} } },
          collections: {},
          writableRoots: {},
          eventPosition: 'message',
        },
      },
    },
  });
  const catalog = fromCatalogSnapshot(snapshot);
  const { diagnoseMovementSource } = jest.requireActual<typeof import('../authoring')>('../authoring');
  const realValidate: ValidateUnder = async ({ movement: m, languageVersion, upgradingFrom, source }) => ({
    diagnostics: diagnoseMovementSource(source ?? m.source, {
      catalog,
      snapshot,
      languageVersion,
      ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
    }).diagnostics,
    gaps: [],
  });

  it('a legacy id is warned, a bare manual listen on the installed language is current, a newer line is refused', async () => {
    const store = fakeStore({
      movements: [
        movement({
          id: 'v4',
          languageVersion: '4',
          source: 'import { email } from adapters\ninbox = email()\nmovement intake(m: <inbox-[:message]->>) {\n  x = 1\n}\nlisten to inbox { key: "deals" } fire intake\n',
        }),
        movement({
          id: 'manual',
          languageVersion: CUR,
          source: 'function echo(run: <manual-[:Invocation]->>) {\n  return 1\n}\nlisten to manual fire echo\n',
        }),
        movement({ id: 'newer', languageVersion: '0.13.0', source: 'listen to manual fire echo\n' }),
      ],
      verdicts: {},
    });
    store.deps.validate = realValidate;

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    expect(summary?.automations.map((a) => [a.name, a.outcome])).toEqual([
      ['v4', 'warned'],
      ['manual', 'current'],
      ['newer', 'refused'],
    ]);
  });
});
