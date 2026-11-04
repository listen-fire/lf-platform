// Airtable's webhooks expire unless refreshed: a listens' subscription whose
// window is due is refreshed as the edge it serves, and its window advanced;
// a webhook a 0.12 settings listen registered is never refreshed (the
// subscription retry removes it).

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

const refreshEventSubscription = jest.fn(async () => ({ expiresAt: '2026-11-09T00:00:00.000Z' }));
const resolveAdapter = jest.fn(async () => ({ refreshEventSubscription }));
jest.mock('../../translation_graph/adapters/resolve', () => ({ resolveAdapter }));

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { MOVEMENT_LISTEN_PROVISIONER } from '../../translation_graph/movement/listen_subscriptions';
import { refreshDueAirtableWebhooks } from '../worker';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const STALE = new Date('2026-10-26T12:00:00.000Z');
const CREDENTIAL = randomUUID() as ExternalServiceCredentialsId;
const FILTER = { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Table' }, right: { type: 'static', value: 'Deals' } };

let teamId: TeamId;

async function subscription(input: { externalId: string; subscriptions: unknown }): Promise<void> {
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      team_id: teamId,
      provider: 'AIRTABLE',
      credentials_id: CREDENTIAL,
      external_webhook_id: input.externalId,
      webhook_secret: 'secret',
      subscriptions: JSON.stringify(input.subscriptions),
      status: 'active',
      provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
      updated_at: STALE,
    })
    .execute();
}

const windowOf = async (externalId: string) =>
  (
    await getAutomationsQb(['webhook_subscription'])
      .selectFrom('webhook_subscription')
      .where('team_id', '=', teamId)
      .where('external_webhook_id', '=', externalId)
      .select('updated_at')
      .executeTakeFirstOrThrow()
  ).updated_at;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team']).insertInto('team').values({ id: teamId, name: `airtable-${teamId.slice(0, 8)}` }).execute();
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({ id: CREDENTIAL, team_id: teamId, type: ExternalServiceType.AIRTABLE, name: 'airtable', credentials: Buffer.from('x') })
    .execute();
});

afterAll(async () => {
  await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['external_service_credentials']).deleteFrom('external_service_credentials').where('id', '=', CREDENTIAL).execute();
  await cleanupTeam(teamId);
});

it("refreshes a listens' subscription as its edge, and a 0.12 webhook through 0.12's own module", async () => {
  await subscription({ externalId: 'ach-edge', subscriptions: { digest: 'd1', edge: 'Changes', filter: FILTER, constructionArgs: { base: 'app1' } } });
  await subscription({ externalId: 'ach-legacy', subscriptions: ['record.created'] });

  await refreshDueAirtableWebhooks(NOW);

  expect(resolveAdapter).toHaveBeenCalledWith({ adapterType: 'airtable', teamId, credentialsId: CREDENTIAL, constructionArgs: { base: 'app1' } });
  expect(refreshEventSubscription).toHaveBeenCalledTimes(1);
  expect(refreshEventSubscription).toHaveBeenCalledWith({ edge: 'Changes', filter: FILTER, externalId: 'ach-edge' });
  expect(await windowOf('ach-edge')).toEqual(NOW);
  expect(refreshEventSubscription).toHaveBeenCalledTimes(1);
  expect(await windowOf('ach-legacy')).toEqual(NOW);
});
