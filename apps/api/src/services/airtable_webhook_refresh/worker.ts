// Airtable webhook refresh worker — keeps movement-derived Airtable webhooks
// alive past Airtable's 7-day expiry.
//
// Airtable disables a webhook 7 days after its last activity. An inbound
// delivery already extends that window (we pull the payload feed, which Airtable
// counts as activity), so a busy webhook never needs help — only QUIET ones do.
// `webhook_subscription.updated_at` advances on every checkpoint write (i.e.
// every pull) and on an explicit refresh here, so it tracks "last time the
// window was extended". This worker refreshes any Airtable subscription whose
// window is older than REFRESH_AFTER, well before the 7-day cliff.
//
// A periodic work row (`airtable_webhook_refresh`) on the automations drain;
// the row's lease is what keeps a second instance from scanning at the same
// time. Failures are contained per row — one bad credential never starves the
// rest.

import type { WorkHandler } from '../work/kinds';
import type { WorkKindRegistration } from '../work/drain';
import type { RefreshEdgeSubscriptionInput } from 'engine-contracts';
import type { WebhookSubscriptionId } from '../../generated/kysely/automations/WebhookSubscription';

import { logger } from 'movement-engine/public/log';
import { getAutomationsQb } from '../../lib/kysely';
import { HOUR } from '../../constants';
import { teamIdSchema } from '../../lib/team_id';
import { MOVEMENT_LISTEN_PROVISIONER, edgeSubscriptionOf } from '../translation_graph/movement/listen_subscriptions';
import { resolveAdapter } from '../translation_graph/adapters/resolve';

/** The webhook_subscription.provider key for Airtable (the uppercase trigger
 *  kind; see webhook_sync/providers/index.ts). */
const AIRTABLE_PROVIDER_KEY = 'AIRTABLE';

export const AIRTABLE_WEBHOOK_SCAN_INTERVAL = HOUR;
/** Refresh once a webhook's window is older than this — 1 day of headroom
 *  before Airtable's 7-day expiry. */
const REFRESH_AFTER = 6 * 24 * HOUR;

/**
 * Refresh each of the listens' Airtable subscriptions whose window is due, as
 * the edge it serves (`refreshEventSubscription({ edge, filter, externalId })`,
 * adapter protocol 2.6). A webhook a 0.12 settings listen registered is never
 * refreshed: the subscription retry removes it (listen_subscriptions.ts).
 */
export async function refreshDueAirtableWebhooks(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - REFRESH_AFTER);
  const rows = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('provider', '=', AIRTABLE_PROVIDER_KEY)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .where('status', '=', 'active')
    .where('external_webhook_id', 'is not', null)
    .where('updated_at', '<', cutoff)
    .select(['id', 'team_id', 'credentials_id', 'external_webhook_id', 'subscriptions'])
    .execute();

  for (const row of rows) {
    try {
      if (row.credentials_id === null || row.external_webhook_id === null) continue;
      const held = edgeSubscriptionOf(row.subscriptions);
      if (held === null) continue;
      const adapter = await resolveAdapter({
        adapterType: 'airtable',
        teamId: teamIdSchema.parse(row.team_id),
        credentialsId: row.credentials_id,
        ...(held.constructionArgs !== undefined ? { constructionArgs: held.constructionArgs } : {}),
      });
      if (adapter.refreshEventSubscription === undefined) {
        throw new Error('the Airtable module cannot refresh a webhook subscription');
      }
      // An edge's refresh, told from a 0.12 webhook's by naming the edge; a
      // `Changes` webhook names the base it is for (`scope`).
      const refresh: RefreshEdgeSubscriptionInput = {
        edge: held.edge,
        ...(held.filter !== undefined ? { filter: held.filter } : {}),
        ...(held.scope !== undefined ? { scope: held.scope } : {}),
        externalId: row.external_webhook_id,
      };
      await adapter.refreshEventSubscription(refresh);

      // Advance the window mark so it isn't re-refreshed until the next cycle.
      await getAutomationsQb(['webhook_subscription'])
        .updateTable('webhook_subscription')
        .set({ updated_at: now })
        .where('id', '=', row.id as WebhookSubscriptionId)
        .execute();

      logger.info('[AirtableWebhookRefresh] refreshed webhook', {
        subscriptionId: row.id,
        webhookId: row.external_webhook_id,
        edge: held.edge,
      });
    } catch (err) {
      logger.error('[AirtableWebhookRefresh] refresh failed for subscription', {
        subscriptionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const airtableWebhookRefreshHandler: WorkHandler = {
  async run(_payload, ctx) {
    await refreshDueAirtableWebhooks(ctx.now);
  },
};

// The Airtable adapter's own periodic kind: its webhook subscriptions expire
// unless refreshed. The adapter registry hands it to the process that drains
// (`adapterWorkKinds`).

declare module '../work/kinds' {
  interface UnitWorkKinds {
    airtable_webhook_refresh: true;
  }
}

export const AIRTABLE_WORK_KINDS: readonly WorkKindRegistration[] = [
  { kind: 'airtable_webhook_refresh', handler: airtableWebhookRefreshHandler, intervalMs: AIRTABLE_WEBHOOK_SCAN_INTERVAL },
];
