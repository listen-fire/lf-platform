// Where a kept delivery came from: the connection recorded when it was kept,
// and the module that delivered it. A delivery outlives the subscription it
// arrived through, so the connection is a column of the delivery, never read
// back from anything else; the module is the kept page's, or what the
// subscription still says. A delivery of no recorded connection (older rows,
// the mail door, a hook, an emit) is decided by the team's reading, not by use.

import { sql } from 'kysely';

import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../lib/kysely';
import { readKeptRequest } from './captured_request';

export interface DeliveryOrigin {
  /** The module that delivered it, when the delivery says. */
  adapterType: string | null;
  /** The connection it was kept for; null when none was recorded. */
  credentialsId: string | null;
}

/** The origin of the delivery `deliveryId` of `teamId`; null when the team keeps no such delivery. */
export async function deliveryOriginOf(input: { teamId: TeamId; deliveryId: string }): Promise<DeliveryOrigin | null> {
  const { rows } = await sql<{ request: unknown; provider: string | null; credentials_id: string | null }>`
    select d.request, w.provider, d.credentials_id::text as credentials_id
    from automations.delivery d
    left join automations.webhook_subscription w on w.id::text = d.subscription_id and w.team_id = d.team_id
    where d.team_id = ${input.teamId}::uuid and d.id::text = ${input.deliveryId}::text`.execute(
    getAutomationsQb(['delivery', 'webhook_subscription']),
  );
  const row = rows[0];
  if (row === undefined) return null;
  const kept = row.request === null ? null : readKeptRequest(row.request);
  const adapterType = kept !== null && 'page' in kept ? kept.page.adapter : row.provider;
  return { adapterType, credentialsId: row.credentials_id };
}
