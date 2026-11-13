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
// The team's context runs what it is given; the group's transaction is a
// context transaction, entered and nothing more here (its rollback is proved
// on Postgres: upgrade_group_transaction.integration.test.ts).
jest.mock('../firing_context', () => ({ withTeamContext: jest.fn((_teamId: string, fn: () => Promise<unknown>) => fn()) }));
const enterTransaction = jest.fn(async () => undefined);
jest.mock('../../../context', () => ({
  currentContext: () => ({ enterTransaction }),
  unsafeCurrentContext: () => undefined,
}));
jest.mock('../store', () => ({
  getMovementRow: jest.fn(),
  lockMovementRow: jest.fn(),
  listAllMovementRows: jest.fn(),
  // The team's files: none besides the movement itself unless a case says so,
  // so an upgrade's import group is the movement alone.
  listMovementRows: jest.fn(async () => []),
  recordUpgradeCheck: jest.fn(),
  recordValidityOutcome: jest.fn(),
}));
jest.mock('../version_store', () => ({ movementSourceHash: () => 'hash' }));
jest.mock('../provision', () => ({ saveMovement: jest.fn() }));
jest.mock('../upgrade_holds', () => ({ holdsOnMoving: jest.fn(async () => []), eventsInFlight: jest.fn(async () => []) }));
jest.mock('../../../movement_engine/run_host_deliveries', () => ({ holdDoorsAlone: jest.fn(async () => new Date(0)) }));
jest.mock('../listens_up', () => ({ bringUpListensLater: jest.fn(async () => undefined) }));
// The real authoring core is loaded by one case below; its team wrapper's
// catalog assembly is never reached.
jest.mock('../catalog', () => ({ movementCatalogForTeam: jest.fn() }));
// A person's upgrade is decided: write on every member, and under applyAllFixes
// use on every connection the rewritten texts name. Nobody asks unless a case
// says who is upgrading.
jest.mock('../../../access/decide', () => ({ accessTo: jest.fn(async () => true) }));
jest.mock('../save_access', () => ({
  connectionsNamed: jest.fn(async () => []),
  unusableConnections: jest.fn(async () => []),
  connectionsRefusal: async (_saver: unknown, unusable: { file: string }[]) => ({ message: `names connections you may not use (in ${unusable.map((u) => u.file).join(', ')})` }),
}));

import { LANGUAGE_VERSION, fromCatalogSnapshot, mockCatalog, mockCatalogSnapshot, type LanguageVersion, type PluginOutput, type PluginSpec, type ResolveFile } from 'movement-lang';
import { checkProgram, isLegacyLanguageVersion } from 'legacy-lang';
import { parseProgram } from 'legacy-lang';

import { assessMovementValidity, type AuthoringDiagnostic } from '../authoring';

import { getMovementRow, listMovementRows, lockMovementRow, recordUpgradeCheck, type MovementRow } from '../store';
import { saveMovement } from '../provision';
import { bringUpListensLater } from '../listens_up';
import { accessTo } from '../../../access/decide';
import { holdsOnMoving } from '../upgrade_holds';
import { connectionsNamed, unusableConnections } from '../save_access';
import {
  runDeployCheck,
  upgradeMovement,
  changedLines,
  upgradeChanges,
  type DeployCheckDeps,
  type DeployCheckSummary,
  type PlatformLanguageRelease,
  type ValidateUnder,
} from '../language_upgrade';
import { DEPRECATED_VERSION, RELEASE_APPLIED, VALIDATION_ISSUE } from '@listen-fire/system';
import { NEWER_LINE, OLDER_LINE, SAME_LINE } from '../../../../test/language_lines';

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
    currentVersionId: 'version-1',
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
  const unprovisioned: string[] = [];

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
      events.push({ teamId, kind: kind.id, reason: payload.reason, version: payload.version });
    },
    unprovision: async (m) => {
      unprovisioned.push(m.id);
    },
    recordRun: async (run) => {
      runs.push(run);
    },
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  };
  return { deps, upgradeDiagnostics, validity, events, runs, validations, unprovisioned };
}

/** The check has no seam that moves a pin; this proves it reached for no
 *  other way to move one either. */
function expectNoPinMoved(): void {
  expect(saveMovement).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  // The row read again inside the transaction is the one that was checked.
  jest.mocked(lockMovementRow).mockImplementation(async ({ id }) => movement({ id }));
});

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
    expect(store.events.map((e) => e.kind)).toEqual([RELEASE_APPLIED.id]);
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
    expect(store.events.map((e) => e.kind)).toEqual([RELEASE_APPLIED.id]);
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
    const issue = store.events.find((e) => e.kind === VALIDATION_ISSUE.id);
    expect(issue).toEqual(
      // The release it fails to validate under; its reason names its pin.
      expect.objectContaining({ version: CUR, teamId: 'team-1', reason: expect.stringContaining('Stays on legacy 1') }),
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
    expect(store.events.map((e) => e.kind)).toEqual([VALIDATION_ISSUE.id, RELEASE_APPLIED.id]);
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

    const applied = store.events.filter((e) => e.kind === RELEASE_APPLIED.id);
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

    expect(store.events.map((e) => e.kind)).toContain(DEPRECATED_VERSION.id);
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
  it('a legacy id takes the legacy path; a release pin is current when the installed language reads it, stopped when older, refused when newer', async () => {
    const store = fakeStore({
      movements: [
        movement({ id: 'legacy', languageVersion: '4' }),
        movement({ id: 'same-line', languageVersion: SAME_LINE }),
        movement({ id: 'older-line', languageVersion: OLDER_LINE }),
        movement({ id: 'newer', languageVersion: NEWER_LINE }),
      ],
      verdicts: {},
    });

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    expect(summary?.automations.map((a) => [a.name, a.outcome])).toEqual([
      ['legacy', 'upgradable'],
      ['same-line', 'current'],
      ['older-line', 'stopped'],
      ['newer', 'refused'],
    ]);
    const unread = summary?.automations.filter((a) => a.outcome === 'refused' || a.outcome === 'stopped') ?? [];
    for (const entry of unread) expect(entry.detail).toContain(entry.from.version);
    // Only the older line's listens are removed: it fires nothing until upgraded.
    expect(store.unprovisioned).toEqual(['older-line']);
    // Its team is told, by name, that it stopped firing.
    const applied = store.events.filter((e) => e.kind === RELEASE_APPLIED.id).map((e) => e.reason);
    expect(applied).toEqual([expect.stringContaining('Stopped firing until you upgrade them, written for an earlier release: older-line.')]);
    // A pin the installed language does not read is never validated.
    expect(store.validations.map((v) => v.movement.id)).toEqual(['legacy', 'legacy', 'same-line']);
    // Each names the running release; its reason names the pin.
    const issues = store.events.filter((e) => e.kind === VALIDATION_ISSUE.id);
    expect(issues.map((e) => e.version)).toEqual([CUR, CUR]);
    expect(issues.map((e) => e.reason)).toEqual([expect.stringContaining(OLDER_LINE), expect.stringContaining(NEWER_LINE)]);
  });

  it('a 0.12 pin, whose engine this platform dropped, is judged as a legacy id is: stopped first, then validated under its own pin and under the installed language', async () => {
    const store = fakeStore({
      movements: [
        movement({ id: 'clean-012', languageVersion: '0.12.13' }),
        movement({ id: 'broken-012', languageVersion: '0.12.4' }),
      ],
      verdicts: { 'broken-012': { '0.12.4': [diagnostic('error', 'no field Textt')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expectNoPinMoved();
    expect(store.unprovisioned).toEqual(['clean-012', 'broken-012']);
    expect(store.validations.map((v) => [v.movement.id, v.languageVersion, v.upgradingFrom])).toEqual([
      ['clean-012', '0.12.13', undefined],
      ['clean-012', CUR, '0.12.13'],
      ['broken-012', '0.12.4', undefined],
    ]);
    expect(store.validity.get('clean-012')).toBe('0.12.13');
    expect(store.validity.get('broken-012')).toBe('0.12.4');
    expect(summary?.automations.map((a) => [a.name, a.outcome])).toEqual([
      ['clean-012', 'upgradable'],
      ['broken-012', 'refused'],
    ]);
    expect(summary?.legacyStopped?.map((entry) => [entry.name, entry.pin, entry.remedy])).toEqual([
      ['clean-012', '0.12.13', `this release starts no new run on version 0.12.13: upgrade it to ${CUR}`],
      ['broken-012', '0.12.4', `this release starts no new run on version 0.12.4: upgrade it to ${CUR}`],
    ]);
  });

  it('a 0.12 pin whose check throws has already stopped: a check that cannot run leaves nothing firing', async () => {
    const store = fakeStore({ movements: [movement({ id: 'unreadable-012', languageVersion: '0.12.13' })], verdicts: {} });
    const order: string[] = [];
    const unprovision = store.deps.unprovision;
    store.deps.unprovision = async (m) => {
      order.push('unprovision');
      await unprovision(m);
    };
    store.deps.validate = async () => {
      order.push('validate');
      throw new Error('the frozen parser failed to load');
    };

    const summary = await runDeployCheck(store.deps);

    expect(order).toEqual(['unprovision', 'validate']);
    expect(summary?.automations.map((a) => [a.name, a.outcome])).toEqual([['unreadable-012', 'unverified']]);
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
        return async () => ({ ok: true });
      },
    });

    expect(result).toEqual(
      expect.objectContaining({ status: 'upgraded', from: { version: '4', name: '4' }, to: { version: CUR, name: CUR } }),
    );
    expect(validations.map((v) => [v.languageVersion, v.upgradingFrom])).toEqual([[CUR, '4']]);
    expect(advanced).toEqual([CUR]);
  });

  it('from an older line: validated under the installed language as a move from its pin, and moved there', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'older', languageVersion: '0.12.0' }));
    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    const { validations, validate } = recorded();
    const advanced: Array<{ to: LanguageVersion; source: string }> = [];

    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'older',
      acknowledge: true,
      validate,
      advance: async ({ to, source }) => {
        advanced.push({ to, source });
        return async () => ({ ok: true });
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: 'upgraded', from: { version: '0.12.0', name: '0.12.0' } }));
    expect(validations.map((v) => [v.languageVersion, v.upgradingFrom, v.source])).toEqual([[CUR, '0.12.0', undefined]]);
    // Its text did not change: it is still a save, under the new pin, so its
    // listens are provisioned there.
    expect(advanced).toEqual([{ to: CUR, source: 'source of older' }]);
  });

  it('a pin on the installed line is already current', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'now', languageVersion: SAME_LINE }));
    const { validations, validate } = recorded();
    const result = await upgradeMovement({ teamId: 'team-1', id: 'now', acknowledge: true, validate });
    expect(result.status).toBe('already_current');
    expect(validations).toEqual([]);
  });

  it('a newer release has nothing to move to: blocked with the rule\'s text', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'newer', languageVersion: NEWER_LINE }));
    const { validations, validate } = recorded();
    const result = await upgradeMovement({ teamId: 'team-1', id: 'newer', acknowledge: true, validate });
    expect(result).toEqual(
      expect.objectContaining({
        status: 'blocked',
        diagnostics: [expect.objectContaining({ code: 'MOV_LANGUAGE_VERSION_UNSUPPORTED' })],
      }),
    );
    expect(validations).toEqual([]);
    });
});

describe('an upgrade moves the whole import group, or nothing', () => {
  // An import is allowed only between files on the same version, so moving one
  // member alone would break its imports with the rest and stop an importer.
  const LIBRARY = 'export function shout(t: <text>) {\n  return t\n}\n';
  const importing = (name: string) => `import { shout } from "lib"\nfunction ${name}(t: <text>) {\n  return shout(t)\n}\n`;
  const rows = [
    movement({ id: 'lib', languageVersion: '0.12.13', source: LIBRARY }),
    movement({ id: 'app', languageVersion: '0.12.13', source: importing('app') }),
    // A legacy id is on 0.12's version, so it is in the group too.
    movement({ id: 'old-app', languageVersion: '4', source: importing('old_app') }),
    // On the version but connected to nothing: stays.
    movement({ id: 'loner', languageVersion: '0.12.13', source: LIBRARY }),
    // Already on the installed version: nothing to move.
    movement({ id: 'current-app', languageVersion: CUR, source: importing('current_app') }),
  ];
  const groupOf = (verdicts: Partial<Record<string, AuthoringDiagnostic[]>>) => {
    const validations: Array<Parameters<ValidateUnder>[0]> = [];
    const validate: ValidateUnder = async (validation) => {
      validations.push(validation);
      return { diagnostics: verdicts[validation.movement.id] ?? [], gaps: [] };
    };
    const advanced: Array<{ id: string; to: LanguageVersion }> = [];
    const advance = async ({ movement: m, to }: { movement: MovementRow; to: LanguageVersion }) => {
      advanced.push({ id: m.id, to });
      return async () => ({ ok: true as const });
    };
    return { validations, validate, advanced, advance };
  };

  it('upgrading an importer moves the library and every other importer with it, libraries first', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { validations, validate, advanced, advance } = groupOf({});

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, validate, advance });

    expect(result).toEqual(expect.objectContaining({ status: 'upgraded' }));
    expect(advanced).toEqual([
      { id: 'lib', to: CUR },
      { id: 'app', to: CUR },
      { id: 'old-app', to: CUR },
    ]);
    if (result.status === 'not_found') throw new Error('unreachable');
    expect(result.movesWith?.map((m) => m.automation.id)).toEqual(['lib', 'old-app']);
    // Each importer is checked against the library as it will be once moved.
    const app = validations.find((v) => v.movement.id === 'app');
    expect(app?.movingWith?.get('lib')).toEqual({ source: LIBRARY, languageVersion: CUR });
    expect(validations.find((v) => v.movement.id === 'lib')?.movingWith).toBeUndefined();
  });

  it('upgrading the library moves its importers with it', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[0]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { validate, advanced, advance } = groupOf({});

    const result = await upgradeMovement({ teamId: 'team-1', id: 'lib', acknowledge: true, validate, advance });

    expect(result.status).toBe('upgraded');
    expect(advanced.map((a) => a.id)).toEqual(['lib', 'app', 'old-app']);
  });

  it('a group with one member that cannot move is refused, naming it, and nothing moves', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    const { validate, advanced, advance } = groupOf({ 'old-app': [diagnostic('error', 'no field Textt')] });

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, validate, advance });

    expect(advanced).toEqual([]);
      expect(saveMovement).not.toHaveBeenCalled();
    if (result.status === 'not_found') throw new Error('unreachable');
    expect(result.status).toBe('blocked');
    expect(result.diagnostics).toEqual([]);
    expect(result.heldBy).toEqual([
      expect.objectContaining({ automation: { id: 'old-app', name: 'old-app' }, unverified: false, diagnostics: [expect.objectContaining({ message: 'no field Textt' })] }),
    ]);
    expect(result.detail).toContain('old-app (line 3: no field Textt)');
    // Each member's own check is still recorded against the target.
    expect(jest.mocked(recordUpgradeCheck).mock.calls.map(([call]) => call.id)).toEqual(['lib', 'app', 'old-app']);
  });

  it('a group moves in one transaction: a member whose save fails rolls back the members before it', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { validate } = groupOf({});
    const moved: string[] = [];
    const outcomes: Array<'committed' | 'rolled back'> = [];
    const together = async (_teamId: string, moves: () => Promise<void>) => {
      try {
        await moves();
        outcomes.push('committed');
      } catch (err) {
        outcomes.push('rolled back');
        throw err;
      }
    };
    const advance = async ({ movement: m }: { movement: { name: string } }) => async () => {
      if (m.name === 'app') return { ok: false as const, detail: 'the rewritten text did not ship' };
      moved.push(m.name);
      return { ok: true as const };
    };

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, validate, advance, together });

    expect(moved).toEqual(['lib']);
    expect(outcomes).toEqual(['rolled back']);
    expect(result).toEqual(expect.objectContaining({ status: 'unverified', detail: 'app: the rewritten text did not ship; nothing moved' }));
  });

  it('the default group move enters one context transaction and moves every member inside it', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { validate, advanced, advance } = groupOf({});
    enterTransaction.mockClear();

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, validate, advance });

    expect(result.status).toBe('upgraded');
    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(advanced.map((a) => a.id)).toEqual(['lib', 'app', 'old-app']);
  });

  it('each member is prepared before the transaction opens, and what is owed a provider is one work row inside it', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { validate } = groupOf({});
    const events: string[] = [];
    enterTransaction.mockClear();
    enterTransaction.mockImplementationOnce(async () => {
      events.push('transaction opened');
    });
    jest.mocked(bringUpListensLater).mockImplementationOnce(async ({ movementIds }) => {
      events.push(`owed the providers: ${movementIds.join(', ')}`);
    });
    const advance = async ({ movement: m }: { movement: { name: string } }) => {
      events.push(`prepared ${m.name}`);
      return async () => {
        events.push(`saved ${m.name}`);
        return { ok: true as const };
      };
    };

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, validate, advance });

    expect(result.status).toBe('upgraded');
    expect(events).toEqual([
      'prepared lib',
      'prepared app',
      'prepared old-app',
      'transaction opened',
      'saved lib',
      'saved app',
      'saved old-app',
      'owed the providers: lib, app, old-app',
    ]);
  });

  it('a group that stops owes the providers nothing', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { validate } = groupOf({});
    jest.mocked(bringUpListensLater).mockClear();
    const advance = async ({ movement: m }: { movement: { name: string } }) => async () => {
      if (m.name === 'app') return { ok: false as const, detail: 'the rewritten text did not ship' };
      return { ok: true as const };
    };

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, validate, advance });

    expect(result).toEqual(expect.objectContaining({ status: 'unverified' }));
    expect(bringUpListensLater).not.toHaveBeenCalled();
  });

  it('without acknowledge, a clean group is reported and nothing moves', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    const { validate, advanced, advance } = groupOf({});

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: false, validate, advance });

    expect(result.status).toBe('needs_acknowledgement');
    expect(advanced).toEqual([]);
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

describe('an explicit upgrade: errors block, meaning-changed warnings hold the pin until checked', () => {
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

  it('a meaning-changed warning holds the pin, even acknowledged, as `listen-fire upgrade` does', async () => {
    const warning = meaningChanged('changed meaning');
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate: async () => ({ diagnostics: [warning, diagnostic('warning', 'a cost note')], gaps: [] }),
    });
    expect(result).toEqual(expect.objectContaining({ status: 'blocked', diagnostics: [warning] }));
  });

  it('a meaning-changed warning, once checked, is listed and awaits acknowledgement when every fix is asked for', async () => {
    const warning = meaningChanged('changed meaning');
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: false,
      applyAllFixes: true,
      validate: async () => ({ diagnostics: [warning], gaps: [] }),
    });
    expect(result).toEqual(expect.objectContaining({ status: 'needs_acknowledgement', diagnostics: [warning] }));
  });

  it('a meaning-changed warning moves up once checked and acknowledged (`--all`)', async () => {
    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    jest.mocked(saveMovement).mockResolvedValueOnce({ ok: true } as never);
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      applyAllFixes: true,
      validate: async () => ({ diagnostics: [meaningChanged('changed meaning')], gaps: [] }),
    });
    expect(result.status).toBe('upgraded');
    // The text did not change: the move is still a save, joining the group's
    // transaction, so the listens are provisioned under the new pin.
    expect(saveMovement).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'old', source: 'source of old', languageUpgrade: expect.objectContaining({ to: CUR }), inTransaction: expect.anything() }),
    );
  });

  it('a stopped move says what stopped: a text it rewrote, or a text it left alone', async () => {
    const stopped = async (rewrote: boolean) => {
      jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
      jest.mocked(saveMovement).mockResolvedValueOnce({ ok: false, errors: ['the plan was refused'] } as never);
      const edit = { line: 1, col: 1, endLine: 1, endCol: 7, text: 'SOURCE' };
      return upgradeMovement({
        teamId: 'team-1',
        id: 'old',
        acknowledge: true,
        validate: async ({ source }) => ({
          diagnostics: rewrote && source === undefined ? [{ ...diagnostic('warning', 'old spelling'), upgrade: true as const, line: 1, col: 1, endLine: 1, endCol: 7, fix: { edits: [edit], safe: true as const } }] : [],
          gaps: [],
        }),
      });
    };

    expect(await stopped(false)).toEqual(expect.objectContaining({ status: 'unverified', detail: expect.stringMatching(/^it did not ship under .*: the plan was refused$/) }));
    expect(await stopped(true)).toEqual(expect.objectContaining({ status: 'unverified', detail: 'the rewritten text did not ship: the plan was refused' }));
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
    const issue = store.events.find((e) => e.kind === VALIDATION_ISSUE.id);
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
    const advanced: Array<{ to: LanguageVersion; source: string }> = [];
    const done = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate: underFive(),
      advance: async ({ to, source }) => {
        advanced.push({ to, source });
        return async () => ({ ok: true });
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
      advance: async () => async () => ({ ok: false, detail: 'the rewritten text did not ship: a system could not be read' }),
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

  // The TypeScript checker stands in for the installed one here, reading the
  // installed release as its dialect '5'.
  const dialectOf = (pin: LanguageVersion): LanguageVersion => (isLegacyLanguageVersion(pin) ? pin : '5');
  const checkWithLibrary: ValidateUnder = async ({ movement: m, languageVersion, upgradingFrom }) => ({
    diagnostics: checkProgram(parseProgram(m.source, { languageVersion: dialectOf(languageVersion) }), catalog, {
      languageVersion: dialectOf(languageVersion),
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
        schema: {
          positions: { message: { properties: { Subject: 'text' }, edges: {} } },
          collections: { message: { target: 'message', readable: false, listenable: true } },
          writableRoots: {},
        },
      },
      manual: {
        constructionArgs: [],
        canFire: true,
        schema: {
          positions: { Invocation: { properties: { Text: 'text' }, edges: {} } },
          collections: { Invocations: { target: 'Invocation', readable: false, listenable: true } },
          writableRoots: {},
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

  it('a legacy id is warned, a manual listen on the installed language is current, a newer line is refused', async () => {
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
          source: 'function echo(run: <manual-[:Invocations]->>) {\n  return 1\n}\nlisten to manual-[:Invocations]-> fire echo\n',
        }),
        movement({ id: 'newer', languageVersion: NEWER_LINE, source: 'listen to manual-[:Invocations]-> fire echo\n' }),
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

describe('an upgrade from an older release line, over the installed checker', () => {
  // `listen-fire upgrade`'s loop: the text is checked under the installed
  // language as a move up from its 0.12 pin, each safe fix is applied, the
  // rest are listed, and every fix is applied when asked. The settings listen
  // becomes a traversal by the module's own `listenSettingsBecome`; the
  // retired `await first(x)` becomes `await x`.
  const snapshot = mockCatalogSnapshot({
    adapters: {
      gh: {
        constructionArgs: [],
        canFire: true,
        listenSettingsBecome: {
          path: ['Notifications'],
          aliases: ['n'],
          paramFrom: 'Notification',
          keys: { events: { hop: 0, field: 'Reason', op: 'in' } },
        },
        schema: {
          positions: { Notification: { properties: { Reason: 'text' }, edges: {} } },
          collections: {
            Notifications: { target: 'Notification', listenable: true, identity: 'Id', delivery: 'polled', pollEverySeconds: 60 },
          },
          writableRoots: {},
        },
      },
      mail: {
        constructionArgs: [],
        schema: {
          positions: {
            Message: {
              properties: { To: 'text', From: 'text', Sent: 'text' },
              edges: { Replies: { target: 'Message', listenable: true, sequenced: 'chronological', identity: 'Sent' } },
            },
          },
          collections: { Messages: { target: 'Message' } },
          writableRoots: { Message: { fields: { To: 'text' }, resultShape: { externalId: 'text' } } },
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
  const advanceSpy = () => {
    const advanced: Array<{ to: LanguageVersion; source: string }> = [];
    const advance = async ({ to, source }: { to: LanguageVersion; source: string }) => {
      advanced.push({ to, source });
      return async () => ({ ok: true as const });
    };
    return { advanced, advance };
  };

  const PINNED_0_12 = [
    'import { gh as gh_module, mail as mail_module } from adapters',
    'gh = connect gh_module',
    'mail = connect mail_module',
    'function triage(n: <gh-[:Notification]->>) {',
    '  m = write mail-[:Messages]-> { To: n.Reason }',
    '  r = await first(m-[:Replies]->)',
    '}',
    '',
    'listen to gh { events: ["mention", "assign"] } fire triage',
    '',
  ].join('\n');
  const UPGRADED = PINNED_0_12.replace('<gh-[:Notification]->>', '<gh-[:Notifications]->>')
    .replace('await first(m-[:Replies]->)', 'await m-[:Replies]->')
    .replace('listen to gh { events: ["mention", "assign"] } fire triage', 'listen to gh-[n:Notifications WHERE n.Reason IN ["mention", "assign"]]-> fire triage');

  it('applies the safe rewrites, holds the pin on the note with nothing to rewrite, and moves it once checked and acknowledged', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(movement({ id: 'triage', languageVersion: '0.12.13', source: PINNED_0_12 }));
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { advanced, advance } = advanceSpy();

    const held = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: true, validate: realValidate, advance });
    expect(held.status).toBe('blocked');
    if (held.status === 'not_found') throw new Error('unreachable');
    expect(held.upgradedSource).toBe(UPGRADED);
    // A wait no `sleep` races may never resolve: said, nothing to rewrite,
    // holding the pin until the author has checked it.
    expect(held.diagnostics.map((d) => [d.code, d.upgrade, d.fix])).toEqual([['MOV_AWAIT_MAY_HANG', true, undefined]]);
    expect(advanced).toEqual([]);

    const moved = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: true, applyAllFixes: true, validate: realValidate, advance });
    expect(moved.status).toBe('upgraded');
    expect(advanced).toEqual([{ to: CUR, source: UPGRADED }]);
  });

  it('holds the pin on a rewrite not proved to keep the meaning, and applies it when every fix is asked for', async () => {
    const changesMeaning = PINNED_0_12.replace('["mention", "assign"] }', '["mention", "assign"], suppress_self: true }');
    jest.mocked(getMovementRow).mockResolvedValue(movement({ id: 'triage', languageVersion: '0.12.13', source: changesMeaning }));
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { advanced, advance } = advanceSpy();

    const held = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: true, validate: realValidate, advance });
    expect(held.status).toBe('blocked');
    if (held.status === 'not_found') throw new Error('unreachable');
    const retired = held.diagnostics.filter((d) => d.code === 'MOV_LISTEN_SETTINGS_RETIRED');
    expect(retired).toHaveLength(1);
    expect(retired[0]!.fix?.safe).toBeUndefined();
    // The safe rewrite elsewhere in the text is still applied and shown.
    expect(held.upgradedSource).toContain('r = await m-[:Replies]->');
    expect(held.upgradedSource).toContain('suppress_self: true');
    expect(advanced).toEqual([]);

    const all = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: true, applyAllFixes: true, validate: realValidate, advance });
    expect(all.status).toBe('upgraded');
    expect(advanced).toEqual([{ to: CUR, source: UPGRADED }]);
  });

  it('runs every later release\'s safe rewrite in one move from 0.12: the settings listen, `.` to `?.`, and a walk word to its everyday spelling', async () => {
    const pinned = [
      'import { gh as gh_module, mail as mail_module } from adapters',
      'gh = connect gh_module',
      'mail = connect mail_module',
      'function triage(n: <gh-[:Notification]->>) {',
      '  mention = only(gh-[o:Notifications WHERE LOWER(o.Reason) == "mention"]->)',
      '  write mail-[:Messages]-> { To: coalesce(mention.Reason, "none") }',
      '}',
      '',
      'listen to gh { events: ["mention", "assign"] } fire triage',
      '',
    ].join('\n');
    const upgraded = pinned
      .replace('<gh-[:Notification]->>', '<gh-[:Notifications]->>')
      .replace('LOWER(o.Reason)', 'Text.lower(o.Reason)')
      .replace('mention.Reason', 'mention?.Reason')
      .replace('listen to gh { events: ["mention", "assign"] } fire triage', 'listen to gh-[n:Notifications WHERE n.Reason IN ["mention", "assign"]]-> fire triage');
    jest.mocked(getMovementRow).mockResolvedValue(movement({ id: 'triage', languageVersion: '0.12.13', source: pinned }));
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { advanced, advance } = advanceSpy();

    const result = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: true, validate: realValidate, advance });

    expect(result.status).toBe('upgraded');
    expect(advanced).toEqual([{ to: CUR, source: upgraded }]);
  });

  it('a 0.12 pin upgrades through the frozen parser: the deploy check reads it in the frozen dialect of 0.12 and offers the rewrite, and the upgrade moves it', async () => {
    const pinned = [
      'import { gh as gh_module, mail as mail_module } from adapters',
      'gh = connect gh_module',
      'mail = connect mail_module',
      'function triage(n: <gh-[:Notification]->>) {',
      '  write mail-[:Messages]-> { To: n.Reason }',
      '}',
      '',
      'listen to gh { events: ["mention", "assign"] } fire triage',
      '',
    ].join('\n');
    const upgraded = pinned
      .replace('<gh-[:Notification]->>', '<gh-[:Notifications]->>')
      .replace('listen to gh { events: ["mention", "assign"] } fire triage', 'listen to gh-[n:Notifications WHERE n.Reason IN ["mention", "assign"]]-> fire triage');
    const row = movement({ id: 'triage', languageVersion: '0.12.13', source: pinned });
    const store = fakeStore({ movements: [row], verdicts: {} });
    store.deps.validate = async (validation) => {
      store.validations.push(validation);
      return realValidate(validation);
    };

    const summary = await runDeployCheck(store.deps);

    // The text reads clean under its own pin, as the frozen parser reads it...
    expect(store.validity.get('triage')).toBe('0.12.13');
    expect((await realValidate({ movement: row, languageVersion: '0.12.13' })).diagnostics).toEqual([]);
    // ...and the upgraded text under it is read with 0.12's meaning: the
    // parameter names a position type there, not a collection.
    expect((await realValidate({ movement: { ...row, source: upgraded }, languageVersion: '0.12.13' })).diagnostics).toEqual([
      expect.objectContaining({ code: 'MOV_UNKNOWN_POSITION', severity: 'error', message: expect.stringContaining('it has: Notification') }),
    ]);
    expect(store.unprovisioned).toEqual(['triage']);
    expect(summary?.automations).toEqual([
      expect.objectContaining({ name: 'triage', outcome: 'warned', from: { version: '0.12.13', name: '0.12.13' } }),
    ]);
    expect(store.events.find((e) => e.kind === VALIDATION_ISSUE.id)?.reason).toContain('Upgrading the automation rewrites what the checker can fix');
    expect(summary?.legacyStopped?.map((entry) => entry.name)).toEqual(['triage']);

    jest.mocked(getMovementRow).mockResolvedValue(row);
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { advanced, advance } = advanceSpy();
    const result = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: true, validate: realValidate, advance });

    expect(result).toMatchObject({ status: 'upgraded', from: { version: '0.12.13' }, to: { version: CUR } });
    expect(advanced).toEqual([{ to: CUR, source: upgraded }]);
  });

  it('holds the pin on `lazy`, which no rewrite replaces, even when every fix is asked for', async () => {
    const pinned = PINNED_0_12.replace('  m = write', '  later = lazy gh-[:Notifications]->\n  m = write');
    jest.mocked(getMovementRow).mockResolvedValue(movement({ id: 'triage', languageVersion: '0.12.13', source: pinned }));
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const { advanced, advance } = advanceSpy();

    const held = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: true, applyAllFixes: true, validate: realValidate, advance });

    expect(held.status).toBe('blocked');
    if (held.status === 'not_found') throw new Error('unreachable');
    expect(held.diagnostics.filter((d) => d.code === 'MOV_LAZY_RETIRED').map((d) => [d.severity, d.fix])).toEqual([['error', undefined]]);
    expect(held.upgradedSource).toContain('later = lazy gh-[:Notifications]->');
    expect(advanced).toEqual([]);
  });
});

describe('an upgrade over the real checkers, with a library the movement imports', () => {
  // The validation seam is the real `diagnoseMovementSource` against a run
  // snapshot carrying the team's saved files, so an import resolves as it does
  // in production: the wasm checker for the installed release, legacy-lang for
  // what changed meaning on the move from the legacy id.
  const SLACK = {
    adapters: {
      slack: {
        constructionArgs: [],
        schema: {
          positions: {
            channel: { properties: { Name: 'text' }, edges: {} },
            message: { properties: { Text: 'text' }, edges: {} },
            note: { properties: { Body: 'text' }, edges: {} },
          },
          collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
          writableRoots: { note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} } },
        },
      },
    },
  } satisfies Parameters<typeof mockCatalogSnapshot>[0];
  // Already upgraded, and holding a refusal whose fix is a place in ITS text
  // (line 8): `found.summary` may be absent where the write needs a value.
  const LIBRARY = [
    'import { slack } from adapters',
    'chat = connect slack',
    'node FoundShape: "the relevant information" {',
    '  summary: <text> "a summary"',
    '}',
    'export function summarise(c: <chat-[:channel]->>) {',
    '  found = extractOne([c.Name], FoundShape, { tier: "careful" })',
    '  write chat-[:note]-> { Body: found.summary }',
    '}',
    '',
  ].join('\n');
  // Line 8 of the importer is its prompt, where the library's fix points.
  const IMPORTER = [
    'import { summarise } from "lib/summary"',
    'import { slack } from adapters',
    'chat = slack()',
    'movement recap(c: <chat-[:channel]->>) {',
    '  a = 1',
    '  b = 2',
    '  c2 = 3',
    '  prompt = "Write the weekly recap of this channel for the team"',
    '  write chat-[:note]-> { Body: prompt }',
    '}',
    '',
  ].join('\n');
  const snapshot = { ...mockCatalogSnapshot(SLACK), files: { 'lib/summary': { source: LIBRARY } } };
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
  const advanceSpy = () => {
    const advanced: Array<{ to: LanguageVersion; source: string }> = [];
    const advance = async ({ to, source }: { to: LanguageVersion; source: string }) => {
      advanced.push({ to, source });
      return async () => ({ ok: true as const });
    };
    return { advanced, advance };
  };

  it("rewrites only the importer's own old spellings: the library's fix never lands in the importer's text", async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'recap', languageVersion: '4', source: IMPORTER }));
    const { advanced, advance } = advanceSpy();

    const result = await upgradeMovement({ teamId: 'team-1', id: 'recap', acknowledge: true, applyAllFixes: true, validate: realValidate, advance });

    expect(result.status).toBe('blocked');
    if (result.status === 'not_found') throw new Error('unreachable');
    expect(result.upgradedSource).toBe(IMPORTER.replace('chat = slack()', 'chat = connect slack').replace('movement recap', 'function recap'));
    // The library's refusal is still reported, on the import, without a fix.
    const fromLibrary = result.diagnostics.filter((d) => d.message.startsWith('"lib/summary" line 8'));
    expect(fromLibrary.map((d) => [d.code, d.line, d.fix])).toEqual([['MOV_ABSENT_REQUIRED', 1, undefined]]);
    expect(advanced).toEqual([]);
  });

  it('every text it saves is the one the installed checker validated clean', async () => {
    const clean = { ...snapshot, files: { 'lib/summary': { source: LIBRARY.replace('Body: found.summary', 'Body: coalesce(found?.summary, "")') } } };
    const validated: Array<{ source: string; clean: boolean; languageVersion: LanguageVersion }> = [];
    const validate: ValidateUnder = async ({ movement: m, languageVersion, upgradingFrom, source }) => {
      const text = source ?? m.source;
      const { diagnostics } = diagnoseMovementSource(text, {
        catalog: fromCatalogSnapshot(clean),
        snapshot: clean,
        languageVersion,
        ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
      });
      validated.push({ source: text, clean: diagnostics.every((d) => d.severity !== 'error'), languageVersion });
      return { diagnostics, gaps: [] };
    };
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'recap', languageVersion: '4', source: IMPORTER }));
    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    const { advanced, advance } = advanceSpy();

    const result = await upgradeMovement({ teamId: 'team-1', id: 'recap', acknowledge: true, applyAllFixes: true, validate, advance });

    expect(result.status).toBe('upgraded');
    expect(advanced).toHaveLength(1);
    expect(validated.at(-1)).toEqual({ source: advanced[0]?.source, clean: true, languageVersion: CUR });
  });

  // The old extraction with a field typed by a name that needs backticks.
  const EXTRACTION = [
    'import { slack } from adapters',
    'chat = slack()',
    'movement triage(c: <chat-[:channel]->>) {',
    '  found = extract "careful" from [c.Name] {',
    '    reason: <`Pass Reason`> "why it passed"',
    '  }',
    '  write chat-[:note]-> { Body: "seen" }',
    '}',
    '',
  ].join('\n');

  it('an upgrade whose rewrite does not check is refused with the diagnostics, and nothing is saved', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'triage', languageVersion: '4', source: EXTRACTION }));
    const { advanced, advance } = advanceSpy();

    const result = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: true, applyAllFixes: true, validate: realValidate, advance });

    expect(result.status).toBe('blocked');
    if (result.status === 'not_found') throw new Error('unreachable');
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(advanced).toEqual([]);
  });

  it("the installed language's rewrite of the extraction keyword keeps a type name's backticks", async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'triage', languageVersion: '4', source: EXTRACTION }));

    const result = await upgradeMovement({ teamId: 'team-1', id: 'triage', acknowledge: false, applyAllFixes: true, validate: realValidate });

    if (result.status === 'not_found') throw new Error('unreachable');
    expect(result.upgradedSource).toContain('reason: <`Pass Reason`> "why it passed"');
    expect(result.diagnostics.filter((d) => d.code === 'MOV_PARSE')).toEqual([]);
  });
});

describe("an upgrade from 0.12 of a listen on the manual unit (Run now)", () => {
  // 0.12 named the manual unit's event `Invocation`; 0.13 names its listenable
  // edge `Invocations`. The settings listen becomes a traversal, and the
  // trigger's type with it, by the unit's own `listenSettingsBecome`.
  const snapshot = mockCatalogSnapshot({
    adapters: {
      manual: {
        constructionArgs: [],
        canFire: true,
        listenSettingsBecome: { path: ['Invocations'], aliases: ['i'], paramFrom: 'Invocation', keys: {} },
        schema: {
          positions: { Invocation: { properties: { Text: 'text' }, edges: {} } },
          collections: { Invocations: { target: 'Invocation', listenable: true, identity: 'Id' } },
          writableRoots: {},
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
  const PINNED_0_12 = ['function backfill(go: <manual-[:Invocation]->>) {', '  return go.Text', '}', '', 'listen to manual {} fire backfill', ''].join('\n');

  it('rewrites the trigger type and the listen onto Invocations', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(movement({ id: 'backfill', languageVersion: '0.12.13', source: PINNED_0_12 }));
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
    const advanced: Array<{ to: LanguageVersion; source: string }> = [];
    const advance = async ({ to, source }: { to: LanguageVersion; source: string }) => {
      advanced.push({ to, source });
      return async () => ({ ok: true as const });
    };

    const result = await upgradeMovement({ teamId: 'team-1', id: 'backfill', acknowledge: true, validate: realValidate, advance });

    if (result.status === 'not_found') throw new Error('unreachable');
    expect(result.upgradedSource).toBe(
      ['function backfill(go: <manual-[:Invocations]->>) {', '  return go.Text', '}', '', 'listen to manual-[:Invocations]-> fire backfill', ''].join('\n'),
    );
    expect(result.status).toBe('upgraded');
  });
});

describe('what an upgrade says it changes', () => {
  it('lists each line the rewrite changes, in the saved text\'s numbering', () => {
    const before = 'a\nlisten to manual fire echo\nb\nc\n';
    const after = 'a\nlisten to manual-[:Invocations]-> fire echo\nb\nc\nd\n';
    expect(changedLines(before, after)).toEqual([
      { line: 2, was: ['listen to manual fire echo'], becomes: ['listen to manual-[:Invocations]-> fire echo'] },
      { line: 5, was: [], becomes: ['d'] },
    ]);
  });

  it('an unchanged text has no line to list', () => {
    expect(changedLines('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('a line removed between kept ones is its own change', () => {
    expect(changedLines('a\nb\nc\n', 'a\nc\n')).toEqual([{ line: 2, was: ['b'], becomes: [] }]);
  });

  it('says runs, help and checking move, and that listens start only where they did not fire', () => {
    const changesFrom = (languageVersion: string, currentVersionId: string | null) =>
      upgradeChanges({ movement: { languageVersion, source: 'a', currentVersionId }, rewritten: 'a', to: '0.15.1' });
    const dropped = changesFrom('0.12.13', 'v1');
    expect(dropped.text).toEqual([]);
    expect(dropped.behaviour.join(' ')).toContain('Help moves with it');
    // This platform no longer fires 0.12's listens: moving starts them.
    expect(dropped.behaviour[0]).toContain('Its listens start firing under 0.15.1');
    expect(changesFrom('0.14.0', 'v1').behaviour[0]).toContain('Its listens start firing under 0.15.1');
    expect(changesFrom('0.14.0', null).behaviour.join(' ')).not.toContain('listens start firing');
  });

  it('a move on offer carries it', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'older', languageVersion: '0.12.0', source: 'old text' }));
    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'older',
      acknowledge: false,
      validate: async () => ({ diagnostics: [], gaps: [] }) as never,
    });
    if (result.status === 'not_found') throw new Error('it is there');
    expect(result.status).toBe('needs_acknowledgement');
    expect(result.changes?.behaviour.join(' ')).toContain('New runs use');
  });
});

describe('a person upgrading needs write on what moves', () => {
  const LIBRARY = 'export function shout(t: <text>) {\n  return t\n}\n';
  const rows = [
    movement({ id: 'lib', languageVersion: '0.12.13', source: LIBRARY }),
    movement({ id: 'app', languageVersion: '0.12.13', source: 'import { shout } from "lib"\nfunction app(t: <text>) {\n  return shout(t)\n}\n' }),
  ];
  const by = { teamId: 'team-1', userId: 'u1', access: 'write' as const, scopes: ['*'], pinnedTeamId: null };
  const validate: ValidateUnder = async () => ({ diagnostics: [], gaps: [] });
  const advance = jest.fn(async () => async () => ({ ok: true as const }));

  beforeEach(() => {
    advance.mockClear();
    jest.mocked(accessTo).mockReset().mockResolvedValue(true);
    jest.mocked(holdsOnMoving).mockReset().mockResolvedValue([]);
    jest.mocked(connectionsNamed).mockClear();
    jest.mocked(unusableConnections).mockReset().mockResolvedValue([]);
    jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
  });

  it('moves nothing when a member it moves with may not be changed by them, naming no member', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    jest.mocked(accessTo).mockImplementation(async (_principal, asked) => asked.target.id !== 'lib');

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, by, validate, advance });

    expect(result).toEqual(expect.objectContaining({ status: 'blocked', detail: expect.stringContaining('that you may not change') }));
    expect(JSON.stringify(result)).not.toContain('"lib"');
    expect(advance).not.toHaveBeenCalled();
  });

  it('names no member in a hold either, when one it moves with may not be changed by them', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    jest.mocked(accessTo).mockImplementation(async (_principal, asked) => asked.target.id !== 'lib');
    jest.mocked(holdsOnMoving).mockResolvedValue(['a run is in flight on lib']);

    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, by, validate, advance });

    expect(result).toEqual(expect.objectContaining({ status: 'blocked', detail: expect.stringContaining('that you may not change') }));
    expect(result).not.toHaveProperty('movesWith');
    expect(JSON.stringify(result)).not.toContain('"lib"');
    expect(JSON.stringify(result)).not.toContain('in flight');
    expect(holdsOnMoving).not.toHaveBeenCalled();
  });

  it('needs write alone for its own rewrites, and use on the connections the texts name under applyAllFixes', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValue(rows);
    jest.mocked(unusableConnections).mockResolvedValue([{ file: 'app', reach: { connection: 'Finance' }, id: undefined }] as never);

    const safe = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, by, validate, advance });
    expect(safe.status).toBe('upgraded');
    expect(connectionsNamed).not.toHaveBeenCalled();

    advance.mockClear();
    const all = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, applyAllFixes: true, by, validate, advance });
    expect(all).toEqual(expect.objectContaining({ status: 'blocked', detail: expect.stringContaining('names connections you may not use') }));
    expect(advance).not.toHaveBeenCalled();
    jest.mocked(getMovementRow).mockReset();
    jest.mocked(listMovementRows).mockReset().mockResolvedValue([]);
  });

  it('asks nothing of a run, which upgrades for nobody', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(rows[1]);
    jest.mocked(listMovementRows).mockResolvedValueOnce(rows);
    const result = await upgradeMovement({ teamId: 'team-1', id: 'app', acknowledge: true, applyAllFixes: true, validate, advance });
    expect(result.status).toBe('upgraded');
    expect(accessTo).not.toHaveBeenCalled();
  });
});
