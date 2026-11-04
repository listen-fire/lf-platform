// Retention prune for trigger_run and the deliveries behind its runs.
// Disabled by default; enable by scheduling `pnpm tg:prune` (or the exported
// function) on a cron when volume warrants.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../../generated/kysely/automations/TriggerRun';

import { sql } from 'kysely';

import { getAutomationsQb } from '../../../lib/kysely';

export interface PruneTriggerRunsInput {
  /** Rows older than this many days are deleted. Defaults to 7. */
  olderThanDays?: number;
  /** Optional team scope — if omitted, prunes across all teams. */
  teamId?: TeamId;
}

export interface PruneTriggerRunsResult {
  deleted: number;
  cutoff: string;
  /**
   * The runs that went. Everything inside `automations` cascaded away with
   * them; anything OUTSIDE the schema that referenced them (the residual
   * `llm_usage` lines) has no constraint to act on any more (D3/D8) and is the
   * caller's to release — see `releaseLlmUsageRunReferences` (lib/llm_usage.ts).
   */
  deletedRunIds: TriggerRunId[];
  /** Deliveries received before the cutoff that went, their requests with
   *  them. A delivery a live run or a queued `fire_event` row still names
   *  stays, its request forgotten all the same. */
  deletedDeliveries: number;
}

export async function pruneTriggerRuns(
  input: PruneTriggerRunsInput = {},
): Promise<PruneTriggerRunsResult> {
  const days = input.olderThanDays ?? 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let q = getAutomationsQb(['trigger_run'])
    .deleteFrom('trigger_run')
    .where('created_at', '<', cutoff)
    // A live lf run is lf's; once settled it ages out like the platform's.
    .where((eb) => eb.or([eb('host', '=', 'platform'), eb('status', 'not in', ['running', 'parked'])]));
  if (input.teamId) {
    q = q.where('team_id', '=', input.teamId);
  }
  const deletedRuns = await q.returning('id').execute();
  const deletedDeliveries = await pruneDeliveries({ cutoff, teamId: input.teamId ?? null });
  return {
    deleted: deletedRuns.length,
    cutoff: cutoff.toISOString(),
    deletedRunIds: deletedRuns.map((r) => r.id),
    deletedDeliveries,
  };
}

/**
 * A delivery's kept request is forgotten at the same retention as the runs
 * (ruling 3), and the delivery with it once nothing still running needs it:
 * a run that is not settled, or a `fire_event` row yet to start one. A
 * `read_delivery` row a version gave up on keeps its delivery and its request:
 * the issue it left names the delivery, and an operator may need it.
 */
async function pruneDeliveries(input: { cutoff: Date; teamId: TeamId | null }): Promise<number> {
  const exec = getAutomationsQb(['delivery', 'trigger_run', 'work']);
  const { cutoff, teamId } = input;
  await sql`
    update automations.delivery d set request = null
    where d.received_at < ${cutoff} and d.request is not null
      and (${teamId}::uuid is null or d.team_id = ${teamId}::uuid)
      and not exists (select 1 from automations.work w
                      where w.team_id = d.team_id and w.kind = 'read_delivery' and w.dead_at is not null and w.payload->>'deliveryId' = d.id::text)`.execute(exec);
  const { rows } = await sql`
    delete from automations.delivery d
    where d.received_at < ${cutoff} and (${teamId}::uuid is null or d.team_id = ${teamId}::uuid)
      and not exists (select 1 from automations.trigger_run r
                      where r.team_id = d.team_id and r.delivery_id = d.id and r.status in ('running', 'parked'))
      and not exists (select 1 from automations.work w
                      where w.team_id = d.team_id and w.kind in ('fire_event', 'read_delivery') and w.payload->>'deliveryId' = d.id::text)
    returning 1`.execute(exec);
  return rows.length;
}
