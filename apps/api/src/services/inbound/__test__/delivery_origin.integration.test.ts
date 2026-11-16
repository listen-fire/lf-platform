// Where a kept webhook delivery came from, read from the rows the door writes:
// the subscription stores its provider key (`SLACK`), a listen is filed under
// its module (`slack`), so the module is what the door resolves the key to —
// a built-in's through the registry's kinds, a remote install's by the key it
// mints — and a listen of that module is found on it.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { WebhookSubscriptionId } from '../../../generated/kysely/automations/WebhookSubscription';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { insertTestListen } from '../../../test/harness/listens';
import { upsertRemoteAdapter } from '../../translation_graph/adapters/remote/store';
import { MOVEMENT_LISTEN_PROVISIONER } from '../../translation_graph/movement/carried_subscriptions';
import { capturedRequest } from '../captured_request';
import { keepForEveryVersion } from '../carried_delivery';
import { deliveryOriginOf } from '../delivery_origin';
import { savedListens } from '../listen_door';

let teamId: TeamId;

/** A subscription row as listen provisioning writes it. */
async function subscriptionFor(providerKey: string): Promise<string> {
  const id = randomUUID();
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      id: id as WebhookSubscriptionId,
      team_id: teamId,
      provider: providerKey,
      credentials_id: null,
      webhook_secret: 'secret',
      subscriptions: JSON.stringify([]),
      status: 'active',
      provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
    })
    .execute();
  return id;
}

/** A delivery kept as the door keeps one, before any version reads it. */
async function keptThrough(input: { subscriptionId: string; adapterType: string; providerKey: string }): Promise<string> {
  const kept = await keepForEveryVersion({
    origin: { teamId, adapterType: input.adapterType, providerKey: input.providerKey, credentialsId: null },
    subscriptionId: input.subscriptionId,
    externalId: null,
    source: 'webhook',
    request: capturedRequest({ keeping: undefined, headers: { 'content-type': 'application/json' }, rawBody: Buffer.from('{}', 'utf8'), arrivals: [] }),
  });
  if (kept.kind !== 'read') throw new Error('the delivery was not kept');
  return kept.deliveryId;
}

beforeEach(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `origin-${teamId.slice(0, 8)}` }).execute();
});

afterEach(async () => {
  for (const table of ['work', 'delivery', 'webhook_subscription', 'remote_adapter', 'trigger'] as const) {
    await sql`delete from ${sql.table(`automations.${table}`)} where team_id = ${teamId}::uuid`.execute(getAutomationsQb([table]));
  }
  await cleanupTeam(teamId);
});

describe('a kept webhook delivery names the module its provider key is read by', () => {
  it('reads a built-in provider key as its module, and finds the listen filed under it', async () => {
    const movementId = randomUUID() as MovementId;
    await getAutomationsQb(['movement']).insertInto('movement').values({ id: movementId, team_id: teamId, name: 'team_only', source: '' }).execute();
    const listen = await insertTestListen({ teamId, movementId, adapterType: 'slack', edge: 'Messages', delivery: 'connection' });
    const subscriptionId = await subscriptionFor('SLACK');
    const deliveryId = await keptThrough({ subscriptionId, adapterType: 'slack', providerKey: 'SLACK' });

    const origin = await deliveryOriginOf({ teamId, deliveryId });

    expect(origin).toEqual({ adapterType: 'slack', credentialsId: null });
    const heard = await savedListens({ teamId, adapterType: origin?.adapterType ?? '' });
    expect(heard.map((entry) => entry.triggerId)).toEqual([listen]);
  });

  it('reads a provider key that is not its module spelled in capitals (INBOUND_WHATSAPP) as that module', async () => {
    const subscriptionId = await subscriptionFor('INBOUND_WHATSAPP');
    const deliveryId = await keptThrough({ subscriptionId, adapterType: 'whatsapp', providerKey: 'INBOUND_WHATSAPP' });
    expect(await deliveryOriginOf({ teamId, deliveryId })).toEqual({ adapterType: 'whatsapp', credentialsId: null });
  });

  it('reads a door that keeps under its provider key, with no subscription row (the Slack app), as that module', async () => {
    const deliveryId = await keptThrough({ subscriptionId: 'SLACK', adapterType: 'slack', providerKey: 'SLACK' });
    expect(await deliveryOriginOf({ teamId, deliveryId })).toEqual({ adapterType: 'slack', credentialsId: null });
  });

  it('reads a remote install’s provider key as the install’s module', async () => {
    await upsertRemoteAdapter({
      teamId,
      manifest: {
        protocolVersion: 2,
        adapterType: 'origin_crm',
        baseUrl: 'https://adapter.example.com/rpc',
        authStrategy: { kind: 'bearer' },
        supportedTriggers: ['event'],
        runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
        methods: ['manifest', 'resolveEntity'],
      },
    });
    const subscriptionId = await subscriptionFor('ORIGIN_CRM');
    const deliveryId = await keptThrough({ subscriptionId, adapterType: 'origin_crm', providerKey: 'ORIGIN_CRM' });
    expect(await deliveryOriginOf({ teamId, deliveryId })).toEqual({ adapterType: 'origin_crm', credentialsId: null });
  });

  it('names no module for a provider key no door reads', async () => {
    const subscriptionId = await subscriptionFor('NOBODY_READS_THIS');
    const deliveryId = await keptThrough({ subscriptionId, adapterType: 'nobody', providerKey: 'NOBODY_READS_THIS' });
    expect(await deliveryOriginOf({ teamId, deliveryId })).toEqual({ adapterType: null, credentialsId: null });
  });
});
