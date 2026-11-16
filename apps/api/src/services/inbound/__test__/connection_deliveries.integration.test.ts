// A connection's recent deliveries against a real database: an event that set
// nothing off is listed beside one that did, newest first; a listen it fired is
// named only to whoever may read its automation; the automations the caller may
// write that listen there are offered to run with it; a replay is not listed;
// and someone who may not use the connection is shown none of it.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { LANGUAGE_VERSION } from 'movement-lang';
import { runWithPrincipal } from 'principal';

import type { Arrival } from 'engine-contracts';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen, takenEquals } from '../../../test/harness/listens';
import { setStatement } from '../../access/decide';
import type { Grantee } from '../../access/statement';
import { userPrincipal } from '../../principal';
import { ProvisioningService } from '../../provisioning';
import { runWithEvent } from '../../translation_graph/movement/run_now';
import { keptPage } from '../captured_request';
import { recentDeliveriesOf } from '../connection_deliveries';
import { deliverArrivals } from '../listen_door';

jest.mock('../../credentials/credential_lifecycle', () => ({ credentialLifecycle: () => undefined }));

const ADAPTER = 'deliveries_test';
const TABLES = ['work', 'trigger_run', 'event_receipt', 'arrival', 'arrival_identity', 'arrival_unjudged', 'delivery', 'access_statement'] as const;

let teamId: TeamId;
let admin: UserId;
let alice: UserId;
let bob: UserId;
let carol: UserId;
let finance: ExternalServiceCredentialsId;
let other: ExternalServiceCredentialsId;
let openOnly: MovementId;
let closedOnly: MovementId;
let secret: MovementId;

const as = (userId: UserId) => userPrincipal({ userId, teamId, access: userId === admin ? 'admin' : 'write' });
const user = (userId: UserId): Grantee => ({ kind: 'user', userId });

const event = (status: string): Arrival => ({
  edge: 'Things',
  identity: `thing-${status}-${randomUUID().slice(0, 8)}`,
  landing: { recordId: `thing-${status}`, recordType: 'Thing', fields: { status } },
});

async function connection(name: string): Promise<ExternalServiceCredentialsId> {
  const id = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({ id, team_id: teamId, type: ExternalServiceType.ATTIO, name, credentials: null, user_id: null })
    .execute();
  return id;
}

async function automation(name: string, statements: { read: Grantee[]; write: Grantee[] }): Promise<MovementId> {
  const id = randomUUID() as MovementId;
  await getAutomationsQb(['movement']).insertInto('movement').values({ id, team_id: teamId, name, source: '', language_version: LANGUAGE_VERSION }).execute();
  await runWithPrincipal(as(admin), async () => {
    await setStatement(as(admin), { target: { thing: 'automation', id }, verb: 'read', grantees: statements.read });
    await setStatement(as(admin), { target: { thing: 'automation', id }, verb: 'write', grantees: statements.write });
  });
  return id;
}

/** One event kept for `credentialsId` as a webhook delivery, said to have come at `at`. */
async function deliver(arrival: Arrival, credentialsId: string, at: string): Promise<string> {
  const { deliveryId } = await deliverArrivals({
    teamId,
    delivered: { adapterType: ADAPTER, credentialsId },
    subscriptionId: ADAPTER,
    externalId: null,
    source: 'webhook',
    arrivals: [arrival],
    request: keptPage({ adapterType: ADAPTER, credentialsId, arrivals: [arrival] }),
  });
  await sql`update automations.delivery set received_at = ${at}::timestamptz where id = ${deliveryId}::uuid`.execute(getAutomationsQb(['delivery']));
  return deliveryId;
}

const listedAs = (userId: UserId, connectionId: string) => runWithPrincipal(as(userId), () => recentDeliveriesOf({ teamId, connectionId }));

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `deliveries-${teamId.slice(0, 8)}` }).execute();
  const member = async (access: 'admin' | 'write') =>
    (await ProvisioningService.provisionUser({ teamId, email: `deliveries-${randomUUID().slice(0, 8)}@acme.test`, access })).userId;
  admin = await member('admin');
  alice = await member('write');
  bob = await member('write');
  carol = await member('write');
  finance = await connection('Finance');
  other = await connection('Other');
  await runWithPrincipal(as(admin), async () => {
    await setStatement(as(admin), { target: { thing: 'connection', id: finance }, verb: 'use', grantees: [user(alice), user(bob)] });
    await setStatement(as(admin), { target: { thing: 'connection', id: other }, verb: 'use', grantees: [user(alice)] });
  });
  openOnly = await automation('open-only', { read: [{ kind: 'team' }], write: [user(alice)] });
  closedOnly = await automation('closed-only', { read: [{ kind: 'team' }], write: [{ kind: 'team' }] });
  secret = await automation('secret', { read: [user(bob)], write: [user(bob)] });
  for (const [movementId, status] of [
    [openOnly, 'open'],
    [closedOnly, 'closed'],
    [secret, 'open'],
  ] as const) {
    await insertTestListen({ teamId, movementId, adapterType: ADAPTER, edge: 'Things', delivery: 'connection', movement: `${status}-${movementId.slice(0, 4)}`, taken: takenEquals('status', status), credentialsId: finance });
  }
});

afterEach(async () => {
  for (const table of TABLES) {
    await sql`delete from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
  }
  await getAutomationsQb(['trigger']).deleteFrom('trigger').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['movement']).deleteFrom('movement').where('team_id', '=', teamId).execute();
  await cleanupTeam(teamId);
});

describe('a connection lists its recent deliveries', () => {
  it('lists an event that set nothing off beside one that did, newest first, naming only the listens the caller may read', async () => {
    const fired = await deliver(event('open'), finance, '2026-11-14T10:00:00Z');
    const nothing = await deliver(event('pending'), finance, '2026-11-14T11:00:00Z');
    await deliver(event('open'), other, '2026-11-14T12:00:00Z');

    const listed = await listedAs(alice, finance);

    expect(listed.map((delivery) => delivery.deliveryId)).toEqual([nothing, fired]);
    const [none, some] = listed;
    expect(none).toMatchObject({ receivedAt: '2026-11-14T11:00:00.000Z', eventCount: 1, fired: [] });
    expect(some?.fired.map((listen) => listen.automationName)).toEqual(['open-only']);
    expect(some?.fired[0]?.automationId).toBe(openOnly);
    // bob reads `secret` and is told it fired; alice is not.
    const asBob = await listedAs(bob, finance);
    expect(asBob.find((delivery) => delivery.deliveryId === fired)?.fired.map((listen) => listen.automationName)).toEqual(['open-only', 'secret']);
  });

  it('offers to run with it only the listening automations the caller may write', async () => {
    await deliver(event('pending'), finance, '2026-11-14T11:00:00Z');
    const [asAlice] = await listedAs(alice, finance);
    expect(asAlice?.runnable).toEqual([
      { automationId: closedOnly, automationName: 'closed-only' },
      { automationId: openOnly, automationName: 'open-only' },
    ]);
    const [asBob] = await listedAs(bob, finance);
    expect(asBob?.runnable.map((entry) => entry.automationName)).toEqual(['closed-only', 'secret']);
  });

  it('does not list a run with one of its events as a delivery of its own', async () => {
    const original = await deliver(event('pending'), finance, '2026-11-14T11:00:00Z');
    const started = await runWithPrincipal(as(alice), () => runWithEvent({ teamId, automationId: closedOnly, deliveryId: original, arrivalIndex: 0, by: { userId: alice } }));
    if (!started.ok) throw new Error(started.errors.join('; '));
    expect((await listedAs(alice, finance)).map((delivery) => delivery.deliveryId)).toEqual([original]);
  });

  it('shows someone who may not use the connection none of its deliveries', async () => {
    await deliver(event('open'), finance, '2026-11-14T10:00:00Z');
    expect(await listedAs(carol, finance)).toEqual([]);
  });
});
