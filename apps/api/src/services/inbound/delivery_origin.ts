// Where a kept delivery came from: the module that delivered it and the
// connection it came for. A delivery keeps neither as a column; a page a door
// read itself names both, and a webhook's subscription names them. A delivery
// of neither (a Run now's, a replay's, the mail door's) came from no
// connection, which only team membership decides.

import { sql } from 'kysely';

import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../lib/kysely';
import { readKeptRequest } from './captured_request';

export interface DeliveryOrigin {
  /** The module that delivered it, when the delivery says. */
  adapterType: string | null;
  /** The connection it came for; null for a module's install, or none. */
  credentialsId: string | null;
}

/** The origin of the delivery `deliveryId` of `teamId`; null when the team keeps no such delivery. */
export async function deliveryOriginOf(input: { teamId: TeamId; deliveryId: string }): Promise<DeliveryOrigin | null> {
  const { rows } = await sql<{ request: unknown; provider: string | null; credentials_id: string | null }>`
    select d.request, w.provider, w.credentials_id::text as credentials_id
    from automations.delivery d
    left join automations.webhook_subscription w on w.id::text = d.subscription_id and w.team_id = d.team_id
    where d.team_id = ${input.teamId}::uuid and d.id::text = ${input.deliveryId}::text`.execute(
    getAutomationsQb(['delivery', 'webhook_subscription']),
  );
  const row = rows[0];
  if (row === undefined) return null;
  const kept = row.request === null ? null : readKeptRequest(row.request);
  if (kept !== null && 'page' in kept) return { adapterType: kept.page.adapter, credentialsId: kept.page.credential ?? null };
  return { adapterType: row.provider, credentialsId: row.credentials_id };
}
