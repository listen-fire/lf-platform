// A connection's recent deliveries, so an event that set nothing off can be
// found: the activity view lists what reached each automation, and an event
// no listen fired on reached none. Each is listed with when it came, how many
// events it brought, and which listens it set off when it arrived.
//
// - Listed only to whoever may see the delivery (`deliveryUnseen`: use on the
//   connection it was kept for).
// - A listen it fired is named only when the caller may read its automation.
// - The automations the caller may write that listen on its module and
//   connection are named, so one can be run with one of its events: a listen
//   a carried version judges as well as the current version's.
// - A run a carried version's receipt started is listed as fired, by the
//   delivery its receipt was judged from.
// - A replay or a run with an event is a delivery of its own, made by
//   someone: it is listed under the activity of what it ran, not here.

import { sql } from 'kysely';
import { currentPrincipal } from 'principal';
import { FIRE_EVENT_WORK_KIND } from 'movement-engine/public/run-host';

import type { TeamId } from '../../generated/kysely/core/Team';

import { refusalOn } from '../../interfaces/access_route';
import { deliveryUnseen } from '../../interfaces/delivery_access';
import { getAutomationsQb } from '../../lib/kysely';
import { readableIds } from '../access/decide';
import { deliveryOriginOf } from './delivery_origin';
import { savedListens } from './listen_door';
import { hearsConnection } from './carried_delivery';
import { carriedListens, kindsOf } from './carried_listens';

export interface FiredListen {
  automationId: string;
  automationName: string;
  /** The listen, as listArrivals names it. */
  listen: string;
}

export interface ConnectionDelivery {
  deliveryId: string;
  receivedAt: string;
  /** The events it brought, each judged again by its place (`arrivalIndex`); null when the kept request does not say. */
  eventCount: number | null;
  /** The listens it set off when it arrived, of automations the caller may read. */
  fired: FiredListen[];
  /** The automations the caller may write that listen on its module and connection: each may be run with one of its events. */
  runnable: Array<{ automationId: string; automationName: string }>;
}

/** How many deliveries are listed when the caller does not say. */
export const RECENT_DELIVERIES = 20;

/** The listens each of `deliveryIds` set off, by delivery: the runs it started, and the ones still queued to start. */
async function firedBy(teamId: TeamId, deliveryIds: readonly string[]): Promise<Map<string, FiredListen[]>> {
  const fired = new Map<string, FiredListen[]>();
  if (deliveryIds.length === 0) return fired;
  const ids = sql.join([...deliveryIds]);
  const { rows } = await sql<{ delivery_id: string; trigger_id: string; movement_id: string; name: string }>`
    select distinct f.delivery_id, t.id::text as trigger_id, m.id::text as movement_id, m.name
    from (
      select r.delivery_id::text as delivery_id, r.trigger_id::text as trigger_id
      from automations.trigger_run r
      where r.team_id = ${teamId}::uuid and r.delivery_id::text in (${ids})
      union
      select w.payload->>'deliveryId', w.payload->>'triggerId'
      from automations.work w
      where w.team_id = ${teamId}::uuid and w.kind = ${FIRE_EVENT_WORK_KIND} and w.payload->>'deliveryId' in (${ids})
    ) f
    join automations.trigger t on t.id::text = f.trigger_id and t.team_id = ${teamId}::uuid
    join automations.movement m on m.id = t.movement_id and m.team_id = t.team_id
    order by m.name`.execute(getAutomationsQb(['trigger_run', 'work', 'trigger', 'movement']));
  const readable = await readableIds(currentPrincipal(), { thing: 'automation', teamIds: [teamId] });
  for (const row of rows) {
    if (!readable.has(row.movement_id)) continue;
    const listed = fired.get(row.delivery_id) ?? [];
    listed.push({ automationId: row.movement_id, automationName: row.name, listen: row.trigger_id });
    fired.set(row.delivery_id, listed);
  }
  return fired;
}

/** The automations the caller may write with a listen on `adapterType` that
 *  hears `credentialsId`, as run-with-event takes them: those whose listens
 *  this release judges, and those a carried version judges, on its own. */
async function writableListening(input: { teamId: TeamId; adapterType: string; credentialsId: string | null }): Promise<ConnectionDelivery['runnable']> {
  const listens = [
    ...(await savedListens({ teamId: input.teamId, adapterType: input.adapterType })),
    ...(await carriedListens({ teamId: input.teamId, kinds: kindsOf({ adapterType: input.adapterType }) })),
  ].filter((listen) => hearsConnection(listen, input.credentialsId));
  if (listens.length === 0) return [];
  const rows = await getAutomationsQb(['trigger', 'movement'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .where('trigger.id', 'in', listens.map((listen) => listen.triggerId))
    .select(['movement.id as id', 'movement.name as name'])
    .distinct()
    .orderBy('movement.name')
    .execute();
  const writable: ConnectionDelivery['runnable'] = [];
  for (const row of rows) {
    if ((await refusalOn({ automationId: row.id, verb: 'write' })) === undefined) writable.push({ automationId: row.id, automationName: row.name });
  }
  return writable;
}

/** The latest deliveries kept for the connection `connectionId` of `teamId` that the caller may see, newest first. */
export async function recentDeliveriesOf(input: { teamId: TeamId; connectionId: string; limit?: number }): Promise<ConnectionDelivery[]> {
  const { teamId } = input;
  // The count is read off the kept request's shape alone: its body is read only by an explicit read of the delivery.
  const { rows } = await sql<{ id: string; received_at: Date; event_count: number | null }>`
    select d.id::text as id, d.received_at,
      case
        when jsonb_typeof(d.request->'arrivals') = 'array' then jsonb_array_length(d.request->'arrivals')
        when jsonb_typeof(d.request->'arrivalIds') = 'array' then jsonb_array_length(d.request->'arrivalIds')
        else null
      end as event_count
    from automations.delivery d
    where d.team_id = ${teamId}::uuid and d.credentials_id = ${input.connectionId}::uuid and d.replay_of is null
    order by d.received_at desc, d.id
    limit ${input.limit ?? RECENT_DELIVERIES}`.execute(getAutomationsQb(['delivery']));

  const seen: typeof rows = [];
  for (const row of rows) if (!(await deliveryUnseen({ teamId, deliveryId: row.id }))) seen.push(row);
  const fired = await firedBy(teamId, seen.map((row) => row.id));

  const runnableOn = new Map<string, Promise<ConnectionDelivery['runnable']>>();
  const listed: ConnectionDelivery[] = [];
  for (const row of seen) {
    const origin = await deliveryOriginOf({ teamId, deliveryId: row.id });
    const adapterType = origin?.adapterType ?? null;
    let runnable: ConnectionDelivery['runnable'] = [];
    if (adapterType !== null) {
      let pending = runnableOn.get(adapterType);
      if (pending === undefined) {
        pending = writableListening({ teamId, adapterType, credentialsId: input.connectionId });
        runnableOn.set(adapterType, pending);
      }
      runnable = await pending;
    }
    listed.push({
      deliveryId: row.id,
      receivedAt: row.received_at.toISOString(),
      eventCount: row.event_count,
      fired: fired.get(row.id) ?? [],
      runnable,
    });
  }
  return listed;
}
