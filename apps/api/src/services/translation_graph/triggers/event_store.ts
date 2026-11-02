// The trigger-event receipts of the retired capture path: every inbound
// event a trigger matched before listens were judged by their plans
// (inbound/listen_door.ts). Nothing writes them now; they are read as the
// trigger's history until the activity list reads deliveries instead.

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../../lib/kysely';

/** The stored events for one trigger, newest first. */
export async function listTriggerEvents(input: {
  teamId: TeamId;
  triggerId: string;
  limit?: number;
}) {
  return getAutomationsQb(['trigger_event'])
    .selectFrom('trigger_event')
    .where('team_id', '=', input.teamId)
    .where('trigger_id', '=', input.triggerId)
    .select([
      'id',
      'trigger_id',
      'adapter_type',
      'trigger_type',
      'status',
      'dispatched_at',
      'failure_reason',
      'occurred_at',
      'created_at',
    ])
    .orderBy('created_at', 'desc')
    .limit(Math.min(input.limit ?? 25, 100))
    .execute();
}
