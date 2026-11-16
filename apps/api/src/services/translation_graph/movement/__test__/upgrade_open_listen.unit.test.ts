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
  connectionsRefusal: (unusable: { file: string }[]) => ({ message: `names connections you may not use (in ${unusable.map((u) => u.file).join(', ')})` }),
  librariesNamed: jest.fn(async () => []),
  unusableLibraries: jest.fn(async () => []),
  hideUnreadableLibraries: jest.fn(async (diagnostics: unknown[]) => diagnostics),
  librariesRefusal: (unusable: { name: string }[]) => ({ message: `imports libraries you may not use (${unusable.map((u) => u.name).join(', ')})` }),
}));

import { LANGUAGE_VERSION, fromCatalogSnapshot, mockCatalogSnapshot, type LanguageVersion } from 'movement-lang';

import { assessMovementValidity } from '../authoring';
import { getMovementRow, lockMovementRow, type MovementRow } from '../store';
import { saveMovement } from '../provision';
import { upgradeMovement, type ValidateUnder } from '../language_upgrade';
import { inboundActorGateEnabled } from '../../triggers/actor_gate';
import { TEAM_MEMBERSHIP_CHECK } from '../../adapters/team/membership_check';

const EMAIL = { kind: 'branded' as const, of: 'text' as const, brands: ['claim:email/address'] };

// Slack as 0.15.3 left it and the platform serves it now: a message carries its
// sender's address as a claim and says whether the app sent it itself.
function snapshotWith(plugin: { name: string }) {
  return mockCatalogSnapshot({
    adapters: {
      slack: {
        constructionArgs: [],
        canFire: true,
        listensLimitedBefore: '0.16.0',
        schema: {
          positions: {
            Message: {
              properties: {
                Channel: 'text',
                Text: 'text',
                'User Email': { kind: 'maybeAbsent', of: EMAIL },
                'Sent By This App': 'boolean',
              },
              edges: {},
            },
          },
          collections: { Messages: { target: 'Message', listenable: true, delivery: 'connection' } },
          writableRoots: {},
        },
      },
    },
    plugins: {
      [TEAM_MEMBERSHIP_CHECK]: {
        args: ['claim'],
        priced: false,
        requiredArgs: ['claim'],
        argTypes: { claim: EMAIL },
        effects: {},
        output: { kind: 'value', type: 'boolean' },
        package: '@lf-platform/team',
        name: plugin.name,
        pure: true,
        maxAgeSeconds: 60,
      },
    },
  });
}

const { diagnoseMovementSource } = jest.requireActual<typeof import('../authoring')>('../authoring');
function validatingOver(snapshot: ReturnType<typeof snapshotWith>): ValidateUnder {
  const catalog = fromCatalogSnapshot(snapshot);
  return async ({ movement: m, languageVersion, upgradingFrom, source }) => ({
    diagnostics: diagnoseMovementSource(source ?? m.source, {
      catalog,
      snapshot,
      languageVersion,
      ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
    }).diagnostics,
    gaps: [],
  });
}

// The spec's name as a program writes it (`team.isMember`), which is what the
// checker's fix spells; the platform's own spec names the plugin `is_member`
// (see the failing case at the end).
const validate = validatingOver(snapshotWith({ name: 'isMember' }));

const PREAMBLE = ['import { slack as slack_module } from adapters', 'slack = connect slack_module', 'function intake(m: <slack-[:Message]->>) { return m.Text }', 'function alert(m: <slack-[:Message]->>) { return m.Text }', ''];
const ONE_OPEN = [...PREAMBLE, 'listen to slack-[m:Messages WHERE m.Channel == "C0DEALS"]-> fire intake', ''].join('\n');
const TWO_OPEN = [
  ...PREAMBLE,
  'listen to slack-[m:Messages WHERE m.Channel == "C0DEALS"]-> fire intake',
  'listen to slack-[m:Messages WHERE m.Channel == "C0ALERTS"]-> fire alert',
  '',
].join('\n');

function row(source: string): MovementRow {
  return {
    id: 'deals',
    teamId: 'team-1',
    name: 'deals',
    source,
    description: '',
    triggerId: null,
    currentVersionId: 'version-1',
    validityStatus: null,
    validityReason: null,
    validitySourceHash: null,
    validityCheckedAt: null,
    validityConsentedAt: null,
    validityCheckedAgainst: null,
    languageVersion: '0.15.3',
    upgradeDiagnostics: null,
    upgradeCheckedAgainst: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function spy() {
  const advanced: Array<{ to: LanguageVersion; source: string }> = [];
  const advance = async ({ to, source }: { to: LanguageVersion; source: string }) => {
    advanced.push({ to, source });
    return async () => ({ ok: true as const });
  };
  return { advanced, advance };
}

function upgrading(source: string, over: { applyAllFixes?: boolean; validate?: ValidateUnder } = {}) {
  jest.mocked(getMovementRow).mockResolvedValue(row(source));
  jest.mocked(assessMovementValidity).mockReturnValue({ status: 'valid', reason: null } as never);
  const { advanced, advance } = spy();
  return {
    advanced,
    run: () => upgradeMovement({ teamId: 'team-1', id: 'deals', acknowledge: true, validate, advance, ...over }),
  };
}

const IMPORT = 'import { `@lf-platform/team` as team } from plugins';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(lockMovementRow).mockImplementation(async ({ id }) => ({ ...row(ONE_OPEN), id }));
});

describe('an open Slack listen, upgraded from an older key', () => {
  it('upgrading_an_open_slack_listen_holds_the_pin_and_offers_the_fix', async () => {
    const { advanced, run } = upgrading(ONE_OPEN);
    const held = await run();

    expect(held.status).toBe('blocked');
    if (held.status === 'not_found') throw new Error('unreachable');
    const open = held.diagnostics.filter((d) => d.code === 'MOV_LISTEN_NOW_OPEN');
    expect(open).toHaveLength(1);
    // Offered, never applied unreviewed: the fix changes who sets the listen off.
    expect(open[0]!.fix?.safe).toBeFalsy();
    expect(open[0]!.fix?.edits.map((e) => e.text).join('')).toContain('team.isMember(m.`User Email`)');
    expect(held.upgradedSource ?? ONE_OPEN).toBe(ONE_OPEN);
    expect(advanced).toEqual([]);
    expect(saveMovement).not.toHaveBeenCalled();
  });

  it('accepting_the_fix_inserts_the_team_check', async () => {
    const { advanced, run } = upgrading(ONE_OPEN, { applyAllFixes: true });
    const moved = await run();

    expect(moved.status).toBe('upgraded');
    expect(advanced).toHaveLength(1);
    const { source } = advanced[0]!;
    expect(source).toContain(IMPORT);
    expect(source).toContain(
      'listen to slack-[m:Messages WHERE m.Channel == "C0DEALS" AND m.`User Email` != null AND team.isMember(m.`User Email`) AND NOT m.`Sent By This App`]-> fire intake',
    );
  });

  it('two open listens in one file take the import once, and each takes its check', async () => {
    const { advanced, run } = upgrading(TWO_OPEN, { applyAllFixes: true });
    const moved = await run();

    expect(moved.status).toBe('upgraded');
    const { source } = advanced[0]!;
    expect(source.split(IMPORT).length - 1).toBe(1);
    expect(source.split('team.isMember(m.`User Email`)').length - 1).toBe(2);
    expect(source).toContain('C0DEALS" AND m.`User Email` != null');
    expect(source).toContain('C0ALERTS" AND m.`User Email` != null');
  });

  it('a_0_15_pin_left_alone_keeps_the_old_gate', async () => {
    const { advanced, run } = upgrading(ONE_OPEN);
    await run();

    // Nothing moved the pin, so the platform still gates the listen as it did.
    expect(advanced).toEqual([]);
    expect(saveMovement).not.toHaveBeenCalled();
    expect(row(ONE_OPEN).languageVersion).toBe('0.15.3');
    expect(inboundActorGateEnabled('slack', '0.15.3')).toBe(true);
    expect(inboundActorGateEnabled('slack', LANGUAGE_VERSION)).toBe(false);
  });
});

// KNOWN DEFECT in the 0.16.0 checker, not in this platform: the fix spells the
// call with the spec's name as it stands (`team.is_member`), where a program
// writes the camel case form (`team.isMember`), so the rewritten filter is
// refused as MOV_LISTEN_IMPURE_WHERE. The platform's own spec names the plugin
// `is_member`. Flips red when listen-fire spells the member as a program does;
// then this becomes an ordinary case and the stand-in name above goes.
describe('the platform’s own spelling of the team check', () => {
  it.failing('accepting the fix writes a call the checker resolves', async () => {
    const { advanced, run } = upgrading(ONE_OPEN, { applyAllFixes: true, validate: validatingOver(snapshotWith({ name: 'is_member' })) });
    const moved = await run();
    expect(moved.status).toBe('upgraded');
    expect(advanced[0]!.source).toContain('team.isMember(m.`User Email`)');
  });
});
