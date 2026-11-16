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
import { libraryRefusal } from '../library_refusal';
import { saveMovement } from '../provision';
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

  it('a_connection_lists_the_libraries_it_is_shared_through, to those who may know of them', async () => {
    await file('helpers', LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(alice)] });
    await file('secret', LIBRARY, { read: [user(bob)], write: [user(bob)], use: [user(bob)] });
    await file('plain', IMPORTER, { read: [team], write: [team] });

    expect(await librariesSharingConnections(asUser(bob), teamId)).toEqual(new Map([[finance, ['helpers', 'secret']]]));
    // Alice may use `helpers` and so knows of it; she knows nothing of `secret`.
    expect(await librariesSharingConnections(asUser(alice), teamId)).toEqual(new Map([[finance, ['helpers']]]));
    expect(await librariesSharingConnections(asUser(carol), teamId)).toEqual(new Map());
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
});
