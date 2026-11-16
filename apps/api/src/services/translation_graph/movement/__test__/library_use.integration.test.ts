// Use on a library, against a REAL database: a library is a file that exports,
// and use on it lets someone import it and call what it exports without reading
// its source. Use on a library covers the connections it names; it keeps that
// power only while one of its writers holds use on each of them, checked when a
// run starts.

import { randomUUID } from 'node:crypto';

import { LANGUAGE_VERSION } from 'movement-lang';
import { runWithPrincipal } from 'principal';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb, getCoreQb } from '../../../../lib/kysely';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import { accessTo, recomputeLibraryStanding, setStatement, StatementRefusedError } from '../../../access/decide';
import { librariesSharingConnections } from '../../../access/library_sharing';
import { StatementStore, type Grantee } from '../../../access/statement';
import { userPrincipal } from '../../../principal';
import { ProvisioningService } from '../../../provisioning';
import { TeamMembershipService } from '../../../team_membership';
import { validateMovementForTeam } from '../authoring';
import { movementCatalogForTeam } from '../catalog';
import { encryptToken } from '../../../../lib/credentials';
import { deleteCredential } from '../../../credentials/delete_credential';
import { persistCredential, updateStoredCredential } from '../../../credentials/persist_credential';
import { libraryRefusal } from '../library_refusal';
import { runMovementTestRun } from '../test_run';
import { saveMovement } from '../provision';
import { assessMovementValidity } from '../authoring';
import { defineAt, hoverAt } from '../language_service';
import { liveDeployCheckDeps, thisDeployCheckRelease, upgradeMovement, validationUnder, type ValidateUnder } from '../language_upgrade';
import { getMovementRow } from '../store';
import { dispatchTriggerByIdEvent } from '../../triggers/router';
import { mintMovementVersionIfChanged } from '../version_store';
import type { TriggerEvent } from 'movement-engine/public/inbound';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';

jest.mock('../../../credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));
jest.mock('../../../../lib/slack', () => ({ sendSlackNotification: async () => undefined }));

const team: Grantee = { kind: 'team' };
const user = (userId: string): Grantee => ({ kind: 'user', userId });

const LIBRARY = [
  'import { attio } from adapters',
  'import { finance_chat } from credentials',
  '',
  'chat = connect attio using finance_chat',
  '',
  'export function tally(t: <text>) {',
  '  return t',
  '}',
  '',
].join('\n');

const BROKEN_LIBRARY = 'export function tally(t: <text>) {\n  return nosuch\n}\n';

const IMPORTER = [
  'import { tally } from "helpers"',
  '',
  'function go(run: <manual-[:Invocations]->>) {',
  '  x = tally(run.Text)',
  '}',
  '',
  'listen to manual-[:Invocations]-> fire go',
  '',
].join('\n');

describe('use on a library (real Postgres)', () => {
  let teamId: TeamId;
  let alice: UserId;
  let bob: UserId;
  let carol: UserId;
  let admin: UserId;
  let finance: ExternalServiceCredentialsId;

  const asUser = (userId: UserId, access: 'write' | 'admin' = 'write') => userPrincipal({ userId, teamId, access });

  async function member(label: string, access: 'write' | 'admin' = 'write'): Promise<UserId> {
    return (await ProvisioningService.provisionUser({ teamId, email: `${label}-${randomUUID().slice(0, 8)}@example.com`, access })).userId;
  }

  async function file(name: string, source: string, lists: { read: Grantee[]; write: Grantee[]; use?: Grantee[] }): Promise<string> {
    const id = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id, team_id: teamId, name, source, description: '', language_version: LANGUAGE_VERSION }).execute();
    const target = { thing: 'automation', id } as const;
    await StatementStore.replaceGrants(target, { teamId, verb: 'write', grantees: lists.write });
    await StatementStore.replaceGrants(target, { teamId, verb: 'read', grantees: lists.read });
    if (lists.use !== undefined) await StatementStore.replaceGrants(target, { teamId, verb: 'use', grantees: lists.use });
    return id;
  }

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `library-use-${teamId.slice(0, 8)}` }).execute();
    [alice, bob, carol] = [await member('alice'), await member('bob'), await member('carol')];
    admin = await member('admin', 'admin');
    finance = randomUUID() as ExternalServiceCredentialsId;
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: finance, team_id: teamId, type: ExternalServiceType.ATTIO, name: 'finance_chat', credentials: null, user_id: null })
      .execute();
    // Only Bob may use the finance connection.
    await StatementStore.replaceGrants({ thing: 'connection', id: finance }, { teamId, verb: 'use', grantees: [user(bob)] });
  });

  afterEach(async () => {
    await getAutomationsQb(['access_statement']).deleteFrom('access_statement').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['movement_version']).deleteFrom('movement_version').where('team_id', '=', teamId).execute();
    await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
    await cleanupTeam(teamId);
  });

  const saveAs = (userId: UserId, source: string, name: string) => {
    const principal = asUser(userId);
    return runWithPrincipal(principal, () =>
      saveMovement({
        teamId,
        source,
        name,
        audience: { for: principal },
        userId,
        intent: 'create',
        acknowledgeErrors: true,
        statements: { read: [team], write: [user(userId)] },
      }),
    );
  };

  it('use_on_a_library_covers_its_connections: use on the library is all a saver needs, and naming the connection themselves is still refused', async () => {
    await file('helpers', LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(alice)] });
    expect(await accessTo(asUser(alice), { target: { thing: 'connection', id: finance }, verb: 'use' })).toBe(false);

    expect(await saveAs(alice, IMPORTER, 'sales')).toMatchObject({ ok: true });

    const direct = LIBRARY.replace(/export function[\s\S]*$/, '') + 'function go(run: <manual-[:Invocations]->>) {\n}\nlisten to manual-[:Invocations]-> fire go\n';
    expect(await saveAs(alice, direct, 'direct')).toMatchObject({ ok: false, refused: { kind: 'connections' } });
  });

  it('a_file_naming_a_library_without_use_is_refused, naming the library and storing nothing', async () => {
    await file('helpers', LIBRARY, { read: [team], write: [user(bob)], use: [user(alice)] });
    const refused = await saveAs(carol, IMPORTER, 'sales');
    expect(refused).toMatchObject({ ok: false, refused: { kind: 'libraries', libraries: ['helpers'] } });
    const stored = await getAutomationsQb(['movement']).selectFrom('movement').select('name').where('team_id', '=', teamId).execute();
    expect(stored.map((row) => row.name)).toEqual(['helpers']);
  });

  it('use_without_read_sees_no_source: a fault inside the library names the library, not its lines', async () => {
    await file('helpers', BROKEN_LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(alice)] });
    const asReader = await validateMovementForTeam({ teamId, source: IMPORTER, audience: { for: asUser(bob) } });
    expect(asReader.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('Unknown name \'nosuch\'')]);

    const asUser_ = await validateMovementForTeam({ teamId, source: IMPORTER, audience: { for: asUser(alice) } });
    expect(asUser_.diagnostics).toHaveLength(1);
    const [shown] = asUser_.diagnostics;
    expect(shown?.message).toContain('"helpers"');
    expect(shown?.message).toContain('you may use it but not read it');
    expect(JSON.stringify(shown)).not.toContain('nosuch');
    expect(shown?.message).not.toMatch(/line \d/);
  });

  it('checks an importer’s library against the library’s own connections, which its importer may not use', async () => {
    await file('helpers', LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(alice)] });
    const validation = await validateMovementForTeam({ teamId, source: IMPORTER, audience: { for: asUser(alice) } });
    expect(validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('setting_a_library_use_list_needs_use_on_what_it_names: an admin without it is refused until they add themselves to the connection’s list', async () => {
    const helpers = await file('helpers', LIBRARY, { read: [team], write: [user(bob)], use: [team] });
    const target = { thing: 'automation', id: helpers } as const;
    const refused = await runWithPrincipal(asUser(admin, 'admin'), () =>
      setStatement(asUser(admin, 'admin'), { target, verb: 'use', grantees: [user(bob)] }),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StatementRefusedError);
    expect(refused).toMatchObject({ refusal: 'needs_use_on_names' });
    expect(await StatementStore.grantsOf(target, { teamId, verb: 'use' })).toEqual([team]);

    const adminPrincipal = asUser(admin, 'admin');
    await runWithPrincipal(adminPrincipal, async () => {
      await setStatement(adminPrincipal, { target: { thing: 'connection', id: finance }, verb: 'use', grantees: [user(bob), user(admin)] });
      await setStatement(adminPrincipal, { target, verb: 'use', grantees: [user(bob)] });
    });
    expect(await StatementStore.grantsOf(target, { teamId, verb: 'use' })).toEqual([user(bob)]);
  });

  it('stands while a writer holds the connection, stops when none does, and stands again with a new writer', async () => {
    const helpers = await file('helpers', LIBRARY, { read: [team], write: [user(bob)], use: [team] });
    const standing = async () => (await StatementStore.standingsOf([helpers])).get(helpers)?.lostConnectionId;

    await recomputeLibraryStanding(teamId);
    expect(await standing()).toBeNull();

    // Bob hands the connection to Carol alone; Bob still writes the library but no longer holds what it names.
    const bobPrincipal = asUser(bob);
    await runWithPrincipal(bobPrincipal, () => setStatement(bobPrincipal, { target: { thing: 'connection', id: finance }, verb: 'use', grantees: [user(carol)] }));
    expect(await standing()).toBe(finance);

    await runWithPrincipal(asUser(admin, 'admin'), () =>
      setStatement(asUser(admin, 'admin'), { target: { thing: 'automation', id: helpers }, verb: 'write', grantees: [user(bob), user(carol)] }),
    );
    expect(await standing()).toBeNull();
  });

  it('a_library_whose_writers_lost_the_connection_refuses_new_runs, naming the library and the connection', async () => {
    await file('helpers', LIBRARY, { read: [team], write: [user(bob)], use: [team] });
    expect(await libraryRefusal({ teamId, source: IMPORTER })).toBeUndefined();

    const bobPrincipal = asUser(bob);
    await runWithPrincipal(bobPrincipal, () => setStatement(bobPrincipal, { target: { thing: 'connection', id: finance }, verb: 'use', grantees: [user(carol)] }));

    const refusal = await libraryRefusal({ teamId, source: IMPORTER });
    expect(refusal).toContain('"helpers"');
    expect(refusal).toContain('"finance_chat"');
  });

  it('works out a standing nobody has recorded yet, when a run first imports the library', async () => {
    await file('helpers', LIBRARY, { read: [team], write: [user(carol)], use: [team] });
    expect(await libraryRefusal({ teamId, source: IMPORTER })).toContain('"finance_chat"');
  });

  it('is worked out again when the last writer who held the connection leaves the team', async () => {
    const helpers = await file('helpers', LIBRARY, { read: [team], write: [user(bob), user(carol)], use: [team] });
    await recomputeLibraryStanding(teamId);
    expect((await StatementStore.standingsOf([helpers])).get(helpers)?.lostConnectionId).toBeNull();

    await TeamMembershipService.removeMember({ teamId, userId: bob });
    expect((await StatementStore.standingsOf([helpers])).get(helpers)?.lostConnectionId).toBe(finance);
    expect(await libraryRefusal({ teamId, source: IMPORTER })).toContain('"finance_chat"');
  });

  it('a_connection_lists_the_libraries_it_is_shared_through, by name, to anyone who may see the connection', async () => {
    await file('helpers', LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(alice)] });
    await file('secret', LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(bob)] });
    await file('plain', IMPORTER, { read: [team], write: [team] });

    // Only names: a library nobody here may read or use is still named, so the holders of the connection learn where it is shared.
    expect(await librariesSharingConnections(teamId)).toEqual(new Map([[finance, ['helpers', 'secret']]]));
  });

  it('refuses a run at its start, recorded failed and naming the library and the connection, through the real dispatch path', async () => {
    await file('helpers', LIBRARY, { read: [team], write: [user(carol)], use: [team] });
    const movementId = await file('sales', IMPORTER, { read: [team], write: [team] });
    await mintMovementVersionIfChanged({ teamId, movementId, source: IMPORTER, languageVersion: LANGUAGE_VERSION });
    const triggerId = randomUUID();
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({
        id: triggerId as TriggerId,
        team_id: teamId,
        name: 'movement/sales/go',
        kind: 'manual',
        config: {} as never,
        movement_id: movementId as MovementId,
        fired_movement_name: 'go',
        run_mode: 'live',
        provisioned_by_setup_agent: false,
      } as never)
      .execute();
    const event: TriggerEvent = {
      pipelineInputId: `trigger:${triggerId}`,
      adapterType: 'manual',
      triggerType: 'webhook',
      payload: { firedAt: new Date().toISOString(), text: 'hello' },
    };

    await dispatchTriggerByIdEvent({ teamId, triggerId, event });

    const runs = await getAutomationsQb(['trigger_run'])
      .selectFrom('trigger_run')
      .where('team_id', '=', teamId)
      .where('trigger_id', '=', triggerId)
      .select(['status', 'failure_reason'])
      .execute();
    expect(runs).toEqual([{ status: 'failed', failure_reason: expect.stringContaining('The library "helpers" no longer stands') }]);
    expect(runs[0]?.failure_reason).toContain('"finance_chat"');
  });

  describe('a library that names a connection which does not resolve', () => {
    const GHOST_LIBRARY = LIBRARY.replace(/finance_chat/g, 'ghost_chat');
    const ghost = (use: Grantee[], options: { replaceExisting?: boolean } = {}) =>
      runWithPrincipal(asUser(carol), () =>
        persistCredential({ teamId, userId: carol, name: 'ghost_chat', use, type: ExternalServiceType.ATTIO, credentials: { apiKey: 'k' }, ...options }),
      );
    const standingOf = async (id: string) => (await StatementStore.standingsOf([id])).get(id);

    it('does not stand on a name that resolves to nothing', async () => {
      const helpers = await file('helpers', GHOST_LIBRARY, { read: [team], write: [user(bob)], use: [team] });
      await recomputeLibraryStanding(teamId);
      expect(await standingOf(helpers)).toMatchObject({ lostConnectionId: null, unresolvedName: 'ghost_chat' });
      expect(await libraryRefusal({ teamId, source: IMPORTER })).toContain('"ghost_chat"');
    });

    it('a connection created later under the name is not reached by a library whose writers may not use it', async () => {
      const helpers = await file('helpers', GHOST_LIBRARY, { read: [team], write: [user(bob)], use: [team] });
      await recomputeLibraryStanding(teamId);

      const created = await ghost([user(carol)]);
      expect(await standingOf(helpers)).toEqual({ lostConnectionId: created, unresolvedName: null });
      expect(await libraryRefusal({ teamId, source: IMPORTER })).toContain('"ghost_chat"');
    });

    it('stands once a writer may use the connection created under the name', async () => {
      const helpers = await file('helpers', GHOST_LIBRARY, { read: [team], write: [user(bob)], use: [team] });
      await recomputeLibraryStanding(teamId);
      await ghost([user(bob)]);
      expect(await standingOf(helpers)).toEqual({ lostConnectionId: null, unresolvedName: null });
      expect(await libraryRefusal({ teamId, source: IMPORTER })).toBeUndefined();
    });

    it('a reconnect under the same name is worked out again', async () => {
      const helpers = await file('helpers', GHOST_LIBRARY, { read: [team], write: [user(bob)], use: [team] });
      await ghost([user(bob)]);
      expect((await standingOf(helpers))?.lostConnectionId).toBeNull();

      // The reconnect keeps the old row's use list (Bob); the standing stays, and points at the new row only if it were lost.
      await ghost([user(carol)], { replaceExisting: true });
      expect(await standingOf(helpers)).toEqual({ lostConnectionId: null, unresolvedName: null });
    });

    it('deleting the connection a library stands on stops it standing, and recreating it for others does not restore it', async () => {
      const helpers = await file('helpers', LIBRARY, { read: [team], write: [user(bob)], use: [team] });
      await recomputeLibraryStanding(teamId);
      expect((await standingOf(helpers))?.lostConnectionId).toBeNull();

      await deleteCredential({ teamId, id: finance });
      expect(await libraryRefusal({ teamId, source: IMPORTER })).toContain('"finance_chat"');

      await runWithPrincipal(asUser(carol), () =>
        persistCredential({ teamId, userId: carol, name: 'finance_chat', use: [user(carol)], type: ExternalServiceType.ATTIO, credentials: { apiKey: 'k' } }),
      );
      expect(await libraryRefusal({ teamId, source: IMPORTER })).toContain('"finance_chat"');
    });

    it('deleting the connection a recorded loss points at is still a loss at the next run start', async () => {
      const helpers = await file('helpers', LIBRARY, { read: [team], write: [user(carol)], use: [team] });
      await recomputeLibraryStanding(teamId);
      expect((await standingOf(helpers))?.lostConnectionId).toBe(finance);

      await deleteCredential({ teamId, id: finance });
      expect(await libraryRefusal({ teamId, source: IMPORTER })).toContain('"finance_chat"');
    });

    it('renaming a connection moves what a library’s names resolve to', async () => {
      const helpers = await file('helpers', LIBRARY, { read: [team], write: [user(bob)], use: [team] });
      await recomputeLibraryStanding(teamId);
      expect((await standingOf(helpers))?.lostConnectionId).toBeNull();

      await updateStoredCredential({ teamId, id: finance, name: 'finance_chat_2', encrypted: await encryptToken('{"apiKey":"k"}', finance), identifier: null });
      expect(await standingOf(helpers)).toMatchObject({ unresolvedName: 'finance_chat' });
    });
  });

  describe('the catalog a person checks a file against', () => {
    const OUTER = 'import { tally } from "helpers"\n\nexport function wrap(t: <text>) {\n  return tally(t)\n}\n';
    const throughOuter = IMPORTER.replace('{ tally } from "helpers"', '{ wrap } from "outer"').replace('tally(', 'wrap(');
    const seenBy = async (userId: UserId, source: string) =>
      Object.keys((await movementCatalogForTeam(teamId, { audience: { for: asUser(userId) }, source })).credentialsByName);

    it('holds the connections of libraries they may use, and none of a library they may not use', async () => {
      await file('helpers', LIBRARY, { read: [team], write: [user(bob)], use: [user(alice)] });
      expect(await seenBy(alice, IMPORTER)).toContain('finance_chat');
      expect(await seenBy(carol, IMPORTER)).not.toContain('finance_chat');
    });

    it('holds the connections of a library reached only through a library they may use', async () => {
      await file('helpers', LIBRARY, { read: [team], write: [user(bob)], use: [user(bob)] });
      await file('outer', OUTER, { read: [team], write: [user(bob)], use: [user(alice)] });
      expect(await seenBy(alice, throughOuter)).toContain('finance_chat');
      expect(await seenBy(carol, throughOuter)).not.toContain('finance_chat');
    });
  });

  describe('use_without_read_sees_no_source, on every path that reports a check to a person', () => {
    const saveUnconfirmed = (userId: UserId, source: string, name: string) => {
      const principal = asUser(userId);
      return runWithPrincipal(principal, () =>
        saveMovement({ teamId, source, name, audience: { for: principal }, userId, intent: 'create', statements: { read: [team], write: [user(userId)] } }),
      );
    };

    it('a save reports the fault without the library’s lines, and stores the same', async () => {
      await file('helpers', BROKEN_LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(alice)] });
      const result = await saveUnconfirmed(alice, IMPORTER, 'sales');
      expect(result).toMatchObject({ ok: false, needsConfirmation: true });
      const shown = JSON.stringify(result);
      expect(shown).toContain('helpers');
      expect(shown).not.toContain('nosuch');
      expect(shown).not.toMatch(/helpers\\?" line \d/);
      const stored = await getAutomationsQb(['movement'])
        .selectFrom('movement')
        .select('validity_reason')
        .where('team_id', '=', teamId)
        .where('name', '=', 'sales')
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(stored.validity_reason)).not.toContain('nosuch');
    });

    it('a fault two levels down names only the unreadable library, to a reader of the outer one', async () => {
      const OUTER = 'import { tally } from "inner"\n\nexport function wrap(t: <text>) {\n  return tally(t)\n}\n';
      const importer = IMPORTER.replace('{ tally } from "helpers"', '{ wrap } from "outer"').replace('tally(', 'wrap(');
      await file('inner', BROKEN_LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(bob), user(alice)] });
      await file('outer', OUTER, { read: [team], write: [user(bob)], use: [user(alice)] });

      const validation = await validateMovementForTeam({ teamId, source: importer, audience: { for: asUser(alice) } });
      const shown = JSON.stringify(validation.diagnostics);
      expect(shown).toContain('inner');
      expect(shown).not.toContain('nosuch');
      expect(shown).not.toMatch(/inner\\?" line \d/);

      expect(JSON.stringify(await saveUnconfirmed(alice, importer, 'sales'))).not.toContain('nosuch');
    });
  });

  it('a_test_run_is_refused_like_a_live_one, before anything is read through the library’s connection', async () => {
    await file('helpers', LIBRARY, { read: [team], write: [user(carol)], use: [team] });
    const movementId = await file('sales', IMPORTER, { read: [team], write: [team] });
    const triggerId = randomUUID();
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({
        id: triggerId as TriggerId,
        team_id: teamId,
        name: 'movement/sales/go',
        kind: 'manual',
        config: {} as never,
        movement_id: movementId as MovementId,
        fired_movement_name: 'go',
        run_mode: 'live',
        provisioned_by_setup_agent: false,
      } as never)
      .execute();
    const invent = jest.fn(async () => ({ Text: 'hello' }));

    const result = await runMovementTestRun({ teamId, audience: { for: asUser(alice) }, triggerId, invent });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('The library "helpers" no longer stands') });
    expect(invent).not.toHaveBeenCalled();
  });

  it('a_run_failure_inside_a_library_shows_its_importer’s_readers_no_library_lines', async () => {
    const helpers = await file('helpers', BROKEN_LIBRARY, { read: [user(bob)], write: [user(bob)], use: [team] });
    await mintMovementVersionIfChanged({ teamId, movementId: helpers, source: BROKEN_LIBRARY, languageVersion: LANGUAGE_VERSION });
    const importer = IMPORTER.replace('tally(run.Text)', 'tally("hello")');
    const movementId = await file('sales', importer, { read: [team], write: [team] });
    await mintMovementVersionIfChanged({ teamId, movementId, source: importer, languageVersion: LANGUAGE_VERSION });
    const triggerId = randomUUID();
    await getAutomationsQb(['trigger'])
      .insertInto('trigger')
      .values({
        id: triggerId as TriggerId,
        team_id: teamId,
        name: 'movement/sales/go',
        kind: 'manual',
        config: {} as never,
        movement_id: movementId as MovementId,
        fired_movement_name: 'go',
        run_mode: 'live',
        provisioned_by_setup_agent: false,
      } as never)
      .execute();
    const event: TriggerEvent = {
      pipelineInputId: `trigger:${triggerId}`,
      adapterType: 'manual',
      triggerType: 'webhook',
      payload: { firedAt: new Date().toISOString(), text: 'hello' },
    };

    await dispatchTriggerByIdEvent({ teamId, triggerId, event });

    const [run] = await getAutomationsQb(['trigger_run']).selectFrom('trigger_run').where('team_id', '=', teamId).selectAll().execute();
    expect(run?.status).toBe('failed');
    // Everything a reader of the importer is shown of the run: the reason, the steps' errors.
    const recorded = JSON.stringify([run?.failure_reason, run?.steps, run?.errors]);
    expect(recorded).toContain('helpers');
    expect(recorded).not.toContain('nosuch');
    expect(recorded).not.toMatch(/helpers\\?" line \d/);
  });
  describe('use_without_read_sees_no_source, once a diagnostic is stored or handed on', () => {
    const FAULT = '"helpers" line 2: Unknown name \'nosuch\'';
    const inLibrary: ValidateUnder = async () => ({
      ok: false,
      diagnostics: [{ code: 'MOV_NAME_UNRESOLVED', message: FAULT, severity: 'error', line: 1, col: 1, endLine: 1, endCol: 2, sourceLine: '' }],
      listenerCount: 0,
      firedMovements: [],
      catalogNotes: [],
      gaps: [],
    });
    const OLD = '0.12.8';

    async function oldGroup(): Promise<{ importer: string; helpers: string }> {
      const helpers = await file('helpers', LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(alice)] });
      const importer = await file('sales', IMPORTER, { read: [team], write: [user(bob), user(alice)] });
      await getAutomationsQb(['movement']).updateTable('movement').set({ language_version: OLD }).where('team_id', '=', teamId).execute();
      return { importer, helpers };
    }

    it('an upgrade stores the fault without the library’s lines, and shows its writer, who may read the library, the fault', async () => {
      const { importer } = await oldGroup();
      const result = await upgradeMovement({ teamId, id: importer, acknowledge: false, by: asUser(bob), validate: inLibrary });
      expect(result).toMatchObject({ status: 'blocked' });
      expect(JSON.stringify(result)).toContain('nosuch');

      const row = await getMovementRow({ teamId, id: importer });
      expect(JSON.stringify(row?.upgradeDiagnostics)).toContain('helpers');
      expect(JSON.stringify(row?.upgradeDiagnostics)).not.toContain('nosuch');
    });

    it('an upgrade by someone who may use the library but not read it is refused before any fault is shown', async () => {
      const { importer } = await oldGroup();
      const result = await upgradeMovement({ teamId, id: importer, acknowledge: false, by: asUser(alice), validate: inLibrary });
      expect(result).toMatchObject({ status: 'blocked' });
      expect(JSON.stringify(result)).not.toContain('nosuch');
    });

    it('the deploy check’s validation, which reaches system events and the stored report, names the library without its lines', async () => {
      const { importer } = await oldGroup();
      await getAutomationsQb(['movement']).updateTable('movement').set({ source: BROKEN_LIBRARY }).where('team_id', '=', teamId).where('name', '=', 'helpers').execute();
      const movement = await getMovementRow({ teamId, id: importer });
      if (movement === null) throw new Error('importer missing');
      const { validate } = liveDeployCheckDeps(thisDeployCheckRelease('test'));
      const validation = await validate(validationUnder(movement, LANGUAGE_VERSION));
      const shown = JSON.stringify(validation.diagnostics);
      expect(shown).toContain('helpers');
      expect(shown).not.toContain('nosuch');
    });

    it('a stored validity reason carries the library’s name and no lines, whoever checked', () => {
      const assessed = assessMovementValidity({
        diagnostics: [{ code: 'MOV_NAME_UNRESOLVED', message: FAULT, severity: 'error', line: 1, col: 1, endLine: 1, endCol: 2, sourceLine: '' }],
        gaps: [],
      });
      expect(assessed.status).toBe('invalid');
      expect(JSON.stringify(assessed.reason)).toContain('helpers');
      expect(JSON.stringify(assessed.reason)).not.toContain('nosuch');
    });

    it('hover and go to definition on a library’s function give a use-only person nothing of its body', async () => {
      const body = 'export function tally(t: <text>) {\n  return "needle_in_the_body"\n}\n';
      await file('helpers', body, { read: [user(bob)], write: [user(bob)], use: [user(alice)] });
      const offset = IMPORTER.indexOf('tally(run');
      const asked = { teamId, audience: { for: asUser(alice) }, source: IMPORTER, offset: offset + 1 };
      const hover = await hoverAt(asked);
      const defined = await defineAt(asked);
      expect(JSON.stringify([hover, defined])).not.toContain('needle_in_the_body');
      expect(defined).toEqual({ kind: 'answer', answer: null });

      const asReader = await defineAt({ ...asked, audience: { for: asUser(bob) } });
      expect(asReader).toMatchObject({ answer: { file: 'helpers' } });
    });
  });
});
