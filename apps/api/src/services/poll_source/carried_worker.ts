// A carried version's polled listens: production's poll worker at 0.12.13. Each
// row owns one `poll_source:<triggerId>` work row, due once `poll_last_at` is older
// than its interval. A pull runs from the row's own `poll_checkpoint` through the
// version's own module. Its events are kept as receipts and `dispatch_event` rows
// and the cursor moves with them, in one write under the row's lock: a pull that
// fails moves nothing, and a pull an upgrade overtook keeps nothing, since the
// current version polls from the cursor that upgrade carried.
//
// Rows and checkpoints are production's own, so a 0.12.13 service beside this one
// (a deploy's rollout) takes turns on them: a work row is held by one lease at a
// time, and a pull that finds the cursor moved under it keeps nothing.

import { isDeepStrictEqual } from 'node:util';

import { durationToMs, isValidDuration } from 'legacy-lang';
import { sql } from 'kysely';
import { z } from 'zod';

import { logger } from 'movement-engine/public/log';
import type { ListeningLane } from '@listen-fire/language-versions';

import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { WorkHandler } from '../work/kinds';

import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { currentContext } from '../context';
import { receiveJudgedEvent } from '../inbound/carried_delivery';
import { carriedListenRows, laneOfRow, lockCarriedListenRow, type CarriedListenRow } from '../inbound/carried_listen_rows';
import { resolveAdapterSlug } from '../translation_graph/adapters/registry';
import { modulePlatform } from '../translation_graph/movement/carried_run';
import { withTeamContext } from '../translation_graph/movement/firing_context';
import { notifyWork, registerWorkHandler } from '../work/drain';
import { enqueueWork, listWorkByKind, removeWork } from '../work/store';

const payloadSchema = z.object({ triggerId: z.custom<TriggerId>((value) => z.uuid().safeParse(value).success) });

/** One row per polled listen, due at its next poll. */
export function carriedPollWorkKey(triggerId: string): string {
  return `poll_source:${triggerId}`;
}

/** The listen's own interval, or its module's. 0.12 spells it `every: 5m`;
 *  versions 1 to 4 spelled it `pollIntervalSeconds: 300`. */
function intervalMsOf(config: unknown, moduleSeconds: number): number {
  const settings = (config ?? {}) as { every?: unknown; pollIntervalSeconds?: unknown };
  if (typeof settings.every === 'string' && isValidDuration(settings.every.trim())) {
    const ms = durationToMs(settings.every.trim());
    if (ms > 0) return ms;
  }
  const override = settings.pollIntervalSeconds;
  return (typeof override === 'number' && override > 0 ? override : moduleSeconds) * SECOND;
}

function pollIntervalMs(row: CarriedListenRow, lane: ListeningLane): number | null {
  const seconds = lane.pollSecondsOf(resolveAdapterSlug(row.kind), modulePlatform());
  return seconds === undefined ? null : intervalMsOf(row.config, seconds);
}

async function arm(row: CarriedListenRow, dueAt: Date): Promise<void> {
  await enqueueWork({ kind: 'poll_source', key: carriedPollWorkKey(row.id), teamId: row.teamId, payload: { triggerId: row.id }, dueAt });
}

/** One pull, then one write. `false` when the row was moved or polled under it. */
async function pollOne(row: CarriedListenRow, lane: ListeningLane, now: Date): Promise<{ kept: boolean; events: number }> {
  const pulled = await lane.pollListen(
    {
      teamId: row.teamId,
      triggerId: row.id,
      adapterType: resolveAdapterSlug(row.kind),
      credentialsId: row.credentialsId,
      movementId: row.movementId,
      config: row.config,
      checkpoint: row.pollCheckpoint,
      now: now.toISOString(),
    },
    modulePlatform(),
  );
  let kept = false;
  await withTeamContext(row.teamId, async () => {
    await currentContext().enterTransaction();
    const locked = await lockCarriedListenRow(row.id as TriggerId);
    if (locked === null || !isDeepStrictEqual(locked.pollCheckpoint, row.pollCheckpoint)) return;
    for (const event of pulled.events) await receiveJudgedEvent({ teamId: row.teamId, triggerId: row.id, event, lane });
    await sql`
      update automations.trigger set poll_checkpoint = ${JSON.stringify(pulled.checkpoint ?? null)}::text::jsonb, poll_last_at = ${now}::timestamptz
      where id = ${row.id}::uuid`.execute(getAutomationsQb(['trigger']));
    kept = true;
  });
  if (kept && pulled.events.length > 0) notifyWork();
  return { kept, events: pulled.events.length };
}

/** Polls one listen, then arms its row one interval later. */
export const pollSourceHandler: WorkHandler = {
  async run(payload, ctx) {
    const { triggerId } = payloadSchema.parse(payload);
    const row = (await carriedListenRows()).find((candidate) => candidate.id === triggerId);
    if (row === undefined) return;
    const lane = await laneOfRow(row);
    if (lane === undefined || !lane.polledKinds(modulePlatform()).includes(resolveAdapterSlug(row.kind))) return;
    const intervalMs = pollIntervalMs(row, lane);
    if (intervalMs === null) return;
    if (row.pollLastAt !== null && ctx.now.getTime() - row.pollLastAt.getTime() < intervalMs) {
      await arm(row, new Date(row.pollLastAt.getTime() + intervalMs));
      return;
    }
    const { kept } = await pollOne(row, lane, ctx.now);
    if (kept) await arm(row, new Date(ctx.now.getTime() + intervalMs));
  },
};

/** The carried half of the periodic `poll_reconcile`: one `poll_source` row per
 *  polled listen, and none for a listen paused, deleted or moved. */
export async function reconcileCarriedPolls(now: Date): Promise<void> {
  const [rows, work] = await Promise.all([carriedListenRows(), listWorkByKind('poll_source')]);
  if (rows.length === 0 && work.length === 0) return;
  const leased = new Set(work.filter((row) => row.leaseUntil !== null && row.leaseUntil > now).map((row) => row.key));
  const byKey = new Map(work.map((row) => [row.key, row]));
  const active = new Set<string>();
  const polled = new Map<string, Set<string>>();
  for (const row of rows) {
    const lane = await laneOfRow(row);
    if (lane === undefined) continue;
    let kinds = polled.get(row.pin);
    if (kinds === undefined) {
      kinds = new Set(lane.polledKinds(modulePlatform()));
      polled.set(row.pin, kinds);
    }
    if (!kinds.has(resolveAdapterSlug(row.kind))) continue;
    const key = carriedPollWorkKey(row.id);
    active.add(key);
    if (leased.has(key)) continue;
    try {
      const intervalMs = pollIntervalMs(row, lane);
      if (intervalMs === null) continue;
      const dueAt = row.pollLastAt !== null ? new Date(row.pollLastAt.getTime() + intervalMs) : now;
      // A row with attempts left over holds its backoff: `poll_last_at` does not
      // advance on a failure, so last poll plus interval would pull the retry
      // forward on every reconcile.
      const existing = byKey.get(key);
      await arm(row, existing !== undefined && existing.attempts > 0 && existing.dueAt > dueAt ? existing.dueAt : dueAt);
    } catch (err) {
      logger.error('[PollSource] the reconcile failed for a listen', { triggerId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const row of work) if (!active.has(row.key)) await removeWork({ key: row.key });
}

export function registerCarriedPollWork(): void {
  registerWorkHandler('poll_source', pollSourceHandler);
}

/** Forget how far the platform polled a team's carried listens, so the next poll
 *  of each is a first poll. Run when the team comes back from lf. */
export async function forgetCarriedPollProgress(teamId: string): Promise<void> {
  await sql`
    update automations.trigger set poll_checkpoint = null, poll_last_at = null
    where team_id = ${teamId}::uuid and movement_id is not null and not (config ? 'listen')`.execute(getAutomationsQb(['trigger']));
}
