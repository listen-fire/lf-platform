// A carried version's schedules: production's movement scheduler at 0.12.13. A
// `listen to timer { schedule: … }` row owns one `fire_cron:<triggerId>` work row
// due at its next occurrence, and the periodic `cron_reconcile` keeps exactly one
// per active row. The current version's schedules are polls of the cron unit's
// `Ticks` (poll_source/worker.ts); these are the rows no listen plan owns.
//
// The checkpoint is `trigger.cron_last_fired_at`. First sight sets it without
// firing. After that, any occurrence due since the mark fires once, and missed
// occurrences collapse into one tick. The due time is always recomputed from the
// checkpoint, never trusted from the row, so a stale or duplicated row fires
// nothing twice.
//
// Row and checkpoint are production's own, so a 0.12.13 service beside this one
// (a deploy's rollout) takes turns on them: a row is held by one lease at a time,
// whichever drain claims it, and the mark says what has fired.
//
// One write moves the mark and queues the tick (a receipt and its `dispatch_event`
// row), under the listen's row lock, so an upgrade in between either finds the
// tick queued (and waits for it) or takes the mark and fires it as the current
// version.

import { sql } from 'kysely';
import { z } from 'zod';

import { CronParseError, nextCronOccurrence, parseCron, type CronSchedule } from 'legacy-lang/cron';
import { logger } from 'movement-engine/public/log';

import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { WorkHandler } from '../work/kinds';

import { getAutomationsQb } from '../../lib/kysely';
import { teamIdSchema } from '../../lib/team_id';
import { currentContext } from '../context';
import { receiveJudgedEvent } from '../inbound/carried_delivery';
import { carriedListenRows, laneOfRow, lockCarriedListenRow, type CarriedListenRow } from '../inbound/carried_listen_rows';
import { isLfEngineTeam } from '../lf_engine/team_engine';
import { withTeamContext } from '../translation_graph/movement/firing_context';
import { notifyWork, registerWorkHandler } from '../work/drain';
import { enqueueWork, listWorkByKind, removeWork } from '../work/store';

const CRON_KIND = 'cron';

/** One row per schedule, due at its next occurrence. */
export function cronWorkKey(triggerId: string): string {
  return `fire_cron:${triggerId}`;
}

const fireCronPayloadSchema = z.object({ triggerId: z.custom<TriggerId>((value) => z.uuid().safeParse(value).success) });

interface ParsedSchedule {
  expression: string;
  cron: CronSchedule;
}

/** Null when the listen can never fire. Logged rather than thrown: a throw would
 *  retry forever, while an edit to the schedule is picked up by the next
 *  reconcile. */
function scheduleOf(row: CarriedListenRow): ParsedSchedule | null {
  const config = (row.config ?? {}) as { schedule?: unknown; timezone?: unknown };
  if (typeof config.schedule !== 'string') {
    logger.warn('[MovementScheduler] a schedule row has no schedule in its config', { triggerId: row.id });
    return null;
  }
  try {
    return { expression: config.schedule, cron: parseCron(config.schedule, typeof config.timezone === 'string' ? { timezone: config.timezone } : {}) };
  } catch (err) {
    if (!(err instanceof CronParseError)) throw err;
    logger.warn('[MovementScheduler] an invalid schedule on a schedule row', { triggerId: row.id, schedule: config.schedule, error: err.message });
    return null;
  }
}

async function advanceCheckpoint(triggerId: string, to: Date): Promise<void> {
  await getAutomationsQb(['trigger'])
    .updateTable('trigger')
    .set({ cron_last_fired_at: to })
    .where('id', '=', triggerId as TriggerId)
    .execute();
}

async function armOccurrenceAfter(input: { row: CarriedListenRow; schedule: ParsedSchedule; after: Date }): Promise<void> {
  const due = nextCronOccurrence(input.schedule.cron, input.after);
  if (due === null) return;
  await enqueueWork({ kind: 'fire_cron', key: cronWorkKey(input.row.id), teamId: input.row.teamId, payload: { triggerId: input.row.id }, dueAt: due });
}

/** One schedule's turn, in one write: fire the occurrence due since the mark, if
 *  any, and arm the next. Nothing happens to a row a move took meanwhile. */
async function fireOne(triggerId: TriggerId, teamId: TeamId, now: Date): Promise<void> {
  // Before the transaction: the answer may wait for a connection, and a turn
  // holding one while it waits starves every other turn of the pool.
  if (await isLfEngineTeam(teamId)) return;
  let queued = false;
  await withTeamContext(teamId, async () => {
    await currentContext().enterTransaction();
    const row = await lockCarriedListenRow(triggerId);
    if (row === null || row.runMode === 'off') return;
    const schedule = scheduleOf(row);
    if (schedule === null) return;
    if (row.cronLastFiredAt === null) {
      await advanceCheckpoint(row.id, now);
      await armOccurrenceAfter({ row, schedule, after: now });
      return;
    }
    // From the checkpoint, not the row's due time: an early or duplicate row fires nothing.
    const due = nextCronOccurrence(schedule.cron, row.cronLastFiredAt);
    if (due === null) return;
    if (due.getTime() > now.getTime()) {
      await armOccurrenceAfter({ row, schedule, after: row.cronLastFiredAt });
      return;
    }
    await advanceCheckpoint(row.id, now);
    await armOccurrenceAfter({ row, schedule, after: now });
    const lane = await laneOfRow(row);
    if (lane === undefined) return;
    const event = lane.tickEvent({ triggerId: row.id, due: due.toISOString(), schedule: schedule.expression });
    await receiveJudgedEvent({ teamId, triggerId: row.id, event, lane });
    queued = true;
  });
  if (queued) notifyWork();
}

export const fireCronHandler: WorkHandler = {
  async run(payload, ctx) {
    const { triggerId } = fireCronPayloadSchema.parse(payload);
    const owner = await getAutomationsQb(['trigger']).selectFrom('trigger').where('id', '=', triggerId).select('team_id').executeTakeFirst();
    if (owner === undefined) return;
    await fireOne(triggerId, teamIdSchema.parse(owner.team_id), ctx.now);
  },
};

/** The periodic `cron_reconcile`: one `fire_cron` row per active schedule, and
 *  none for a listen paused, deleted or moved. Contained per listen: one broken
 *  schedule never starves the rest. */
export const cronReconcileHandler: WorkHandler = {
  async run(_payload, ctx) {
    const { now } = ctx;
    const [rows, work] = await Promise.all([carriedListenRows({ kind: CRON_KIND }), listWorkByKind('fire_cron')]);
    // A leased row's handler re-arms it from the checkpoint it just moved; an
    // enqueue now would replace that time with a stale one.
    const leased = new Set(work.filter((row) => row.leaseUntil !== null && row.leaseUntil > now).map((row) => row.key));
    const active = new Set<string>();
    for (const row of rows) {
      const key = cronWorkKey(row.id);
      active.add(key);
      if (leased.has(key)) continue;
      try {
        const schedule = scheduleOf(row);
        if (schedule === null) continue;
        if (row.cronLastFiredAt === null) {
          // Taken where a turn on the row would find it, so the mark moves once.
          await sql`update automations.trigger set cron_last_fired_at = ${now}::timestamptz where id = ${row.id}::uuid and cron_last_fired_at is null`.execute(getAutomationsQb(['trigger']));
          await armOccurrenceAfter({ row, schedule, after: now });
        } else {
          await armOccurrenceAfter({ row, schedule, after: row.cronLastFiredAt });
        }
      } catch (err) {
        logger.error('[MovementScheduler] the reconcile failed for a schedule', { triggerId: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const row of work) if (!active.has(row.key)) await removeWork({ key: row.key });
  },
};

export function registerCronWork(): void {
  registerWorkHandler('fire_cron', fireCronHandler);
  registerWorkHandler('cron_reconcile', cronReconcileHandler);
}
