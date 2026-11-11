// A movement's arrival ledger: what reached its listens, as the activity list
// and the automations connector show it (ruling 4). It names each delivery
// and listen a replay takes, never the request a delivery kept (ruling 3).

import { sql } from 'kysely';

import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../lib/kysely';

/** How an arrival reached one of a movement's listens: a run it started, an
 *  `Arrival Not Judged` fact (the listen could not tell), or a refusal (the
 *  automation's fire list did not let who acted start a run). */
export type MovementEventStatus = 'ran' | 'run_failed' | 'not_judged' | 'refused';

export type MovementEventItem = {
  id: string;
  /** The lane (trigger name) of the listen it reached. */
  lane: string;
  /** The listen, and the kept delivery it came in: what a replay names. */
  triggerId: string;
  deliveryId: string | null;
  /** The module it came from. */
  adapterType: string;
  status: MovementEventStatus;
  failureReason: string | null;
  /** For a not judged fact, which attempt (0 as delivered, one more per replay). */
  attempt: number | null;
  occurredAt: Date;
  createdAt: Date;
};

/**
 * The arrival ledger for a movement's listens, newest first: each run an
 * arrival started (with the delivery it came in), each arrival a listen
 * could not judge, and each its fire list refused (ruling 4: each with its
 * replay). A listen edited since keeps its facts under the pipeline it had,
 * so they are not shown here.
 */
export async function movementEventsImpl(params: { teamId: TeamId; movementId: string }): Promise<MovementEventItem[]> {
  const { teamId, movementId } = params;
  const exec = getAutomationsQb(['trigger', 'trigger_run', 'arrival_unjudged', 'arrival_refused', 'delivery']);
  const { rows: runs } = await sql<{
    id: string;
    trigger_id: string;
    lane: string;
    kind: string;
    delivery_id: string;
    status: string;
    failure_reason: string | null;
    created_at: Date;
  }>`
    select r.id::text as id, t.id::text as trigger_id, t.name as lane, t.kind,
           coalesce(d.replay_of, r.delivery_id)::text as delivery_id, r.status, r.failure_reason, r.created_at
    from automations.trigger t
    join automations.trigger_run r on r.trigger_id = t.id::text and r.team_id = t.team_id
    -- A run a replay started names the replay's delivery; a replay is of the delivery replayed.
    left join automations.delivery d on d.id = r.delivery_id and d.team_id = r.team_id
    where t.team_id = ${teamId}::uuid and t.movement_id = ${movementId}::uuid and r.delivery_id is not null
    order by r.created_at desc limit 50`.execute(exec);
  const { rows: facts } = await sql<{
    trigger_id: string;
    lane: string;
    kind: string;
    pipeline: string;
    arrival: string;
    attempt: number;
    delivery_id: string | null;
    reason: string;
    noted_at: Date;
  }>`
    select t.id::text as trigger_id, t.name as lane, t.kind, u.pipeline, u.arrival, u.attempt, u.delivery_id, u.reason, u.noted_at
    from automations.trigger t
    join automations.arrival_unjudged u on u.team_id = t.team_id and u.pipeline = t.config->'listen'->>'pipeline'
    where t.team_id = ${teamId}::uuid and t.movement_id = ${movementId}::uuid
    order by u.noted_at desc limit 50`.execute(exec);
  const { rows: refused } = await sql<{
    trigger_id: string;
    lane: string;
    kind: string;
    pipeline: string;
    arrival: string;
    delivery_id: string;
    reason: string;
    noted_at: Date;
  }>`
    select t.id::text as trigger_id, t.name as lane, t.kind, f.pipeline, f.arrival, f.delivery_id::text as delivery_id, f.reason, f.noted_at
    from automations.trigger t
    join automations.arrival_refused f on f.team_id = t.team_id and f.pipeline = t.config->'listen'->>'pipeline'
    where t.team_id = ${teamId}::uuid and t.movement_id = ${movementId}::uuid
    order by f.noted_at desc limit 50`.execute(exec);
  const items: MovementEventItem[] = [
    ...runs.map((run): MovementEventItem => ({
      id: run.id,
      lane: run.lane,
      triggerId: run.trigger_id,
      deliveryId: run.delivery_id,
      adapterType: run.kind,
      status: run.status === 'failed' ? 'run_failed' : 'ran',
      failureReason: run.failure_reason,
      attempt: null,
      occurredAt: run.created_at,
      createdAt: run.created_at,
    })),
    ...facts.map((fact): MovementEventItem => ({
      id: `${fact.pipeline}|${fact.arrival}|${fact.attempt}`,
      lane: fact.lane,
      triggerId: fact.trigger_id,
      deliveryId: fact.delivery_id,
      adapterType: fact.kind,
      status: 'not_judged',
      failureReason: fact.reason,
      attempt: fact.attempt,
      occurredAt: fact.noted_at,
      createdAt: fact.noted_at,
    })),
    ...refused.map((fact): MovementEventItem => ({
      id: `refused|${fact.pipeline}|${fact.arrival}|${fact.delivery_id}`,
      lane: fact.lane,
      triggerId: fact.trigger_id,
      deliveryId: fact.delivery_id,
      adapterType: fact.kind,
      status: 'refused',
      failureReason: fact.reason,
      attempt: null,
      occurredAt: fact.noted_at,
      createdAt: fact.noted_at,
    })),
  ];
  return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 50);
}
