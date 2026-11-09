// A movement pinned to 0.12 is checked, and its editor answered, by 0.12's own
// checker and language service (`@listen-fire/lang-0.12`, through the registry),
// against the team as the platform knows it: never by this release's catalog,
// checker or parser. The same text under the current version is this
// release's, and reads otherwise.

jest.mock('../catalog', () => ({
  movementCatalogForTeam: jest.fn(),
  movementCatalogSnapshotForTeam: jest.fn(),
  loadCredentialRows: jest.fn(async () => [{ id: 'cred-1', name: 'acme_main', type: 'ATTIO' }]),
}));
jest.mock('../store', () => ({
  listMovementRows: jest.fn(async () => []),
  getMovementRow: jest.fn(),
  listDerivedTriggerRows: jest.fn(async () => []),
}));
jest.mock('../../adapters/remote/store', () => ({
  ...jest.requireActual('../../adapters/remote/store'),
  listRemoteAdapters: jest.fn(async () => []),
}));
// The team's stored credentials, which reading a connected system decrypts:
// none is readable here, so a connection is a gap.
jest.mock('../../../credentials/secrets_postgres', () => ({
  ...jest.requireActual('../../../credentials/secrets_postgres'),
  postgresSecrets: () => {
    throw new Error('no stored credential in this test');
  },
}));

import { LANGUAGE_VERSION, fromCatalogSnapshot, mockCatalogSnapshot } from 'movement-lang';

import { diagnoseMovementSource, validateMovementForTeam } from '../authoring';
import { teamFactsOncePerTeam } from '../carried_check';
import { movementCatalogForTeam } from '../catalog';
import { completeAt } from '../language_service';
import { projectStoryView } from '../story_view';
import { getMovementRow, listMovementRows, type MovementRow } from '../store';
import { unitInstanceSchema } from '../../adapters/unit_surface';
import { MANUAL_ADAPTER_TYPE, MANUAL_SURFACE } from '../../adapters/manual';

/** A manual listen as 0.12 spells it: the unit by name. */
const ECHO_012 = 'function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual fire echo\n';
/** The same listen as 0.13 and later spell it. */
const ECHO_015 = 'function echo(run: <manual-[:Invocation]->>) {\n  return run.Text\n}\nlisten to manual-[:Invocations]-> fire echo\n';

const TEAM = 'team-k4';

function row(over: Partial<MovementRow>): MovementRow {
  return {
    id: 'movement-1',
    teamId: TEAM,
    name: 'echo',
    source: ECHO_012,
    description: '',
    triggerId: null,
    currentVersionId: null,
    validityStatus: null,
    validityReason: null,
    validitySourceHash: null,
    validityCheckedAt: null,
    validityConsentedAt: null,
    validityCheckedAgainst: null,
    languageVersion: '0.12.13',
    upgradeDiagnostics: null,
    upgradeCheckedAgainst: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

const currentSnapshot = mockCatalogSnapshot({
  adapters: { manual: { constructionArgs: [], schema: unitInstanceSchema(MANUAL_ADAPTER_TYPE, MANUAL_SURFACE) } },
});

beforeEach(() => jest.clearAllMocks());

describe("a 0.12 pin's check", () => {
  it('reads 0.12 syntax clean under 0.12, and never assembles this release\'s catalog', async () => {
    const validation = await validateMovementForTeam({ audience: { for: 'run' }, teamId: TEAM, source: ECHO_012, languageVersion: '0.12.13' });
    expect(validation.diagnostics).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.firedMovements).toEqual(['echo']);
    expect(validation.gaps).toEqual([]);
    expect(movementCatalogForTeam).not.toHaveBeenCalled();
  });

  it('the same 0.12 text fails under the current version', () => {
    const validation = diagnoseMovementSource(ECHO_012, {
      catalog: fromCatalogSnapshot(currentSnapshot),
      snapshot: currentSnapshot,
      languageVersion: LANGUAGE_VERSION,
    });
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics.filter((d) => d.severity === 'error')).not.toEqual([]);
  });

  it("reports a construct only 0.13 and later read, by 0.12's checker", async () => {
    const validation = await validateMovementForTeam({ audience: { for: 'run' }, teamId: TEAM, source: ECHO_015, languageVersion: '0.12.13' });
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics).toEqual([
      expect.objectContaining({ code: 'MOV_PARSE', severity: 'error', message: expect.stringContaining("Expected 'fire' after 'listen to manual'") }),
    ]);
    // ...which the current version reads clean.
    const underCurrent = diagnoseMovementSource(ECHO_015, {
      catalog: fromCatalogSnapshot(currentSnapshot),
      snapshot: currentSnapshot,
      languageVersion: LANGUAGE_VERSION,
    });
    expect(underCurrent.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('a connected system 0.12 cannot read here is a gap, so the check is unverified, never clean', async () => {
    const source =
      'import { attio } from adapters\nimport { acme_main } from credentials\ncrm = connect attio using acme_main\n' +
      'function f(go: <manual-[:Invocation]->>) {\n  write crm-[:Companies]-> {\n    unique by (Name)\n    Name: go.Text\n  }\n}\nlisten to manual fire f\n';
    const validation = await validateMovementForTeam({ audience: { for: 'run' }, teamId: TEAM, source, languageVersion: '0.12.13' });
    expect(validation.ok).toBe(true);
    expect(validation.gaps).toEqual([{ adapter: 'attio', detail: expect.stringContaining('was checked') }]);
  });

  it('a library on another version is an error naming both pins', async () => {
    jest.mocked(listMovementRows).mockResolvedValueOnce([
      row({ id: 'lib', name: 'lib', source: 'export function shout(t: <text>) {\n  return t\n}\n', languageVersion: '0.15.1' }),
    ]);
    const importer = 'import { shout } from "lib"\n' + ECHO_012.replace('return run.Text', 'return shout(run.Text)');
    const validation = await validateMovementForTeam({ audience: { for: 'run' }, teamId: TEAM, source: importer, languageVersion: '0.12.13' });
    const across = validation.diagnostics.find((d) => d.code === 'MOV_IMPORT_LANGUAGE_VERSION');
    expect(across).toMatchObject({ severity: 'error', line: 1, sourceLine: 'import { shout } from "lib"' });
    expect(across?.message).toContain('0.12.13');
    expect(across?.message).toContain('0.15.1');
  });
});

describe("a deploy sweep's team facts", () => {
  it('are read once per team, however many automations it checks', async () => {
    const facts = teamFactsOncePerTeam();
    await Promise.all([facts('team-a'), facts('team-a'), facts('team-b')]);
    await facts('team-a');
    expect(jest.mocked(listMovementRows).mock.calls.map(([team]) => team)).toEqual(['team-a', 'team-b']);
  });

  it('do not keep a failed read', async () => {
    jest.mocked(listMovementRows).mockRejectedValueOnce(new Error('database away'));
    const facts = teamFactsOncePerTeam();
    await expect(facts('team-a')).rejects.toThrow('database away');
    await facts('team-a');
    expect(listMovementRows).toHaveBeenCalledTimes(2);
  });
});

describe("a 0.12 pin's editor", () => {
  it("completes from 0.12's language service, on the server", async () => {
    jest.mocked(getMovementRow).mockResolvedValue(row({}));
    const offset = ECHO_012.indexOf('run.Text') + 'run.'.length;
    const answer = await completeAt({ audience: { for: 'run' }, teamId: TEAM, id: 'movement-1', source: ECHO_012, offset });
    expect(answer.kind).toBe('answer');
    if (answer.kind !== 'answer') return;
    expect(answer.answer.items.map((item) => item.label)).toEqual(['Fired at', 'Run by (email)', 'Run by (name)', 'Text', 'Content']);
    expect(movementCatalogForTeam).not.toHaveBeenCalled();
  });
});

describe("a 0.12 pin's story", () => {
  const story = (source: string) =>
    projectStoryView({ id: 'movement-1', teamId: TEAM, name: 'echo', source, validityStatus: null, languageVersion: '0.12.13' });

  it("is drawn by 0.12's own analysis, in its systems' own words, with no current catalog", async () => {
    const result = await story(ECHO_012);
    if (!result.ok) throw new Error(`no picture: ${JSON.stringify(result.problems)}`);
    expect(result.view.movement).toMatchObject({ id: 'movement-1', name: 'echo', validity: { status: 'valid' } });
    expect(result.view.triggers).toEqual([expect.objectContaining({ system: expect.objectContaining({ key: 'manual', label: 'Run now' }), sentence: expect.any(String) })]);
    expect(result.view.flow.length).toBeGreaterThan(0);
    expect(movementCatalogForTeam).not.toHaveBeenCalled();
  });

  it("carries what 0.12's check found on the picture", async () => {
    const result = await story(ECHO_012.replace('run.Text', 'run.Textt'));
    if (!result.ok) throw new Error('a program that reads is drawn');
    expect(result.view.movement.validity.status).toBe('invalid');
    expect(result.view.movement.validity.problems.map((p) => p.code)).toEqual(['MOV_UNKNOWN_PROPERTY']);
  });

  it("carries the platform's stored ruling", async () => {
    const result = await projectStoryView({ id: 'movement-1', teamId: TEAM, name: 'echo', source: ECHO_012, validityStatus: 'unverified', languageVersion: '0.12.13' });
    if (!result.ok) throw new Error('a program that reads is drawn');
    expect(result.view.movement.validity.status).toBe('unverified');
  });

  it('a program 0.12 cannot read is unreadable, as any other', async () => {
    const result = await story(ECHO_015);
    expect(result).toMatchObject({ ok: false, reason: 'unreadable', problems: [expect.objectContaining({ code: 'MOV_PARSE' })] });
  });
});
