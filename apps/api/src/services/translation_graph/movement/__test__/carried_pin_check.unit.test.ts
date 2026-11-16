// A movement pinned to 0.12, whose engine this platform no longer carries, is
// checked by legacy-lang's frozen parser and checker in their dialect of the
// 0.12 surface, against the team's catalog, as a legacy id is: so it can be
// judged and upgraded. Nothing presents it: its editor answers nothing and its
// story is unreadable, with the installed language's refusal. The same text
// under the current version is this release's, and reads otherwise.

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
  beforeEach(() => {
    jest.mocked(movementCatalogForTeam).mockResolvedValue({ catalog: fromCatalogSnapshot(currentSnapshot), notes: [], gaps: [] } as never);
  });

  it('reads 0.12 syntax clean under 0.12, in the frozen dialect of its surface', async () => {
    const validation = await validateMovementForTeam({ audience: { for: 'run' }, teamId: TEAM, source: ECHO_012, languageVersion: '0.12.13' });
    expect(validation.diagnostics).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.firedMovements).toEqual(['echo']);
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
});

/** The same listen as 0.15 spells it, reading who acted (`@user_email`, which
 *  0.16 retired). */
const ECHO_015 = 'function echo(run: <manual-[:Invocation]->>) {\n  who = @user_email\n  return run.Text\n}\nlisten to manual-[:Invocations]-> fire echo\n';

describe("a 0.15 pin's check", () => {
  it("is 0.15's own checker's, against the units 0.15 describes", async () => {
    const validation = await validateMovementForTeam({ audience: { for: 'run' }, teamId: TEAM, source: ECHO_015, languageVersion: '0.15.3' });
    expect(validation.diagnostics).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.firedMovements).toEqual(['echo']);
    expect(movementCatalogForTeam).not.toHaveBeenCalled();
  });

  it("names a field 0.15's unit does not have, by 0.15's checker", async () => {
    const validation = await validateMovementForTeam({ audience: { for: 'run' }, teamId: TEAM, source: ECHO_015.replace('run.Text', 'run.Textt'), languageVersion: '0.15.3' });
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('Textt') })]);
  });

  it('the same 0.15 text is refused under the current version', () => {
    const validation = diagnoseMovementSource(ECHO_015, { catalog: fromCatalogSnapshot(currentSnapshot), snapshot: currentSnapshot, languageVersion: LANGUAGE_VERSION });
    expect(validation.ok).toBe(false);
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
  it('answers nothing: nothing presents a version this platform dropped', async () => {
    jest.mocked(getMovementRow).mockResolvedValue(row({}));
    const offset = ECHO_012.indexOf('run.Text') + 'run.'.length;
    const answer = await completeAt({ audience: { for: 'run' }, teamId: TEAM, id: 'movement-1', source: ECHO_012, offset });
    expect(answer.kind).toBe('answer');
    if (answer.kind !== 'answer') return;
    expect(answer.answer.items).toEqual([]);
    expect(movementCatalogForTeam).not.toHaveBeenCalled();
  });
});

describe("a 0.12 pin's story", () => {
  it("is unreadable, with the installed language's refusal of the pin", async () => {
    const result = await projectStoryView({ id: 'movement-1', teamId: TEAM, name: 'echo', source: ECHO_012, validityStatus: null, languageVersion: '0.12.13' });
    expect(result).toMatchObject({ ok: false, reason: 'unreadable', problems: [expect.objectContaining({ message: expect.stringContaining('0.12.13') })] });
    expect(movementCatalogForTeam).not.toHaveBeenCalled();
  });
});
