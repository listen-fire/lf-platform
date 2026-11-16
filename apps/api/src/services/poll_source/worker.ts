// Shared polls of listenable edges (adapter protocol 2.6). Every listen whose
// last edge is declared polled shares one poll with the listens of the same
// key (inbound/listen_edge.ts): one `poll_edge` work row, one cursor, one call
// to the module per interval. What a poll returns is kept as a delivery of its
// own (inbound/listen_door.ts), judged by the listens sharing the poll only. A
// schedule is such a poll too: the cron unit's `Ticks`, its schedule in the
// filter.
//
// A first poll only arms: its cursor is kept and nothing fires, since what
// was there before the listen is not news. The cursor advances with the
// delivery, in one write, so a poll whose delivery fails is polled again
// from the same cursor. A failed poll throws, and the drain retries that row
// alone with backoff. The periodic `poll_reconcile` keeps one row per key.
//
// A team whose engine is lf is not polled: a cloud lf polls for it. A switch
// back to the platform forgets its cursors (`forgetPollProgress`), so the
// next poll of each is a first poll and replays nothing lf already handled.

import { sql } from 'kysely';
import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { WorkHandler } from '../work/kinds';

import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { teamIdSchema } from '../../lib/team_id';
import { logger } from 'movement-engine/public/log';
import { currentListenOf, deliverArrivals, type SavedListen } from '../inbound/listen_door';
import { keptPage } from '../inbound/captured_request';
import { lfEngineTeams } from '../lf_engine/team_engine';
import { notifyWork, registerWorkHandler } from '../work/drain';
import { enqueueWork, listWorkByKind, removeWork } from '../work/store';
import { edgePollerOf } from './edge_poller';
import { listenEdgeKeysOf, type ListenEdgeKey } from '../inbound/listen_edge';

/** The interval of a polled edge that declares none. */
const DEFAULT_POLL_EVERY_SECONDS = 60;

/** The least time between two polls of one key, whatever its module
 *  answers: a `pollAgainAt` already past never has a key polled without
 *  pause. */
export const POLL_AGAIN_FLOOR_MS = SECOND;

/** When a key polled at `polledAt` is polled next: when its module said the
 *  edge is next worth polling (`pollAgainAt`, adapter protocol 2.7), if that
 *  is sooner than its interval and no sooner than the floor; else one
 *  interval on. listen-fire's `next_poll_at` (crates/lf/src/edge_polls.rs). */
export function nextPollAt(polledAt: Date, everyMs: number, pollAgainAt?: Date): Date {
  const usual = polledAt.getTime() + everyMs;
  if (pollAgainAt === undefined) return new Date(usual);
  return new Date(Math.min(Math.max(pollAgainAt.getTime(), polledAt.getTime() + POLL_AGAIN_FLOOR_MS), usual));
}

/** One key, the listens sharing it, and how often it is polled. */
export interface SharedPoll {
  key: ListenEdgeKey;
  digest: string;
  listens: SavedListen[];
  everyMs: number;
}

export function pollWorkKey(digest: string): string {
  return `poll_edge:${digest}`;
}

/** Where a shared poll's cursor is kept, and the subscription its
 *  deliveries are kept under. */
export function pollSubscriptionId(digest: string): string {
  return `edge-poll:${digest}`;
}

/** The listens on polled edges, of one team or of every team the platform
 *  polls for, grouped by the poll they share. */
export async function sharedPolls(input: { teamId?: TeamId } = {}): Promise<SharedPoll[]> {
  let query = getAutomationsQb(['trigger', 'movement'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .where('trigger.run_mode', '!=', 'off')
    // A listen polled on its own last edge, or over a union on some member's.
    .where(
      sql<boolean>`(trigger.config->'listen'->'delivery'->>'kind' = 'polled' or trigger.config->'listen'->'members' @> '[{"delivery":{"kind":"polled"}}]'::jsonb)`,
    );
  if (input.teamId !== undefined) query = query.where('trigger.team_id', '=', input.teamId);
  const [rows, lfTeams] = await Promise.all([
    query
      .select([
        'trigger.id as id',
        'trigger.team_id as teamId',
        'trigger.config as config',
        'trigger.credentials_id as credentialsId',
        'movement.name as file',
        'movement.language_version as pin',
      ])
      .execute(),
    lfEngineTeams(),
  ]);
  const polls = new Map<string, SharedPoll>();
  for (const row of rows) {
    if (lfTeams.has(row.teamId)) continue;
    const config = currentListenOf(row);
    if (config === null) continue;
    const listen: SavedListen = { ...config, triggerId: row.id, teamId: teamIdSchema.parse(row.teamId), file: row.file, credentialsId: row.credentialsId ?? null };
    for (const { key, digest, delivery } of listenEdgeKeysOf(listen, ['polled'])) {
      const everyMs = (delivery.pollEverySeconds ?? DEFAULT_POLL_EVERY_SECONDS) * SECOND;
      const shared = polls.get(digest);
      if (shared === undefined) polls.set(digest, { key, digest, listens: [listen], everyMs });
      else {
        shared.listens.push(listen);
        shared.everyMs = Math.min(shared.everyMs, everyMs);
      }
    }
  }
  return [...polls.values()];
}

async function cursorOf(teamId: TeamId, subscriptionId: string): Promise<{ cursor: unknown } | null> {
  const { rows } = await sql<{ checkpoint: unknown }>`
    select checkpoint from automations.inbound_checkpoint
    where team_id = ${teamId}::uuid and subscription_id = ${subscriptionId}::text`.execute(getAutomationsQb(['inbound_checkpoint']));
  const row = rows[0];
  return row === undefined ? null : { cursor: row.checkpoint };
}

async function keepCursor(teamId: TeamId, subscriptionId: string, cursor: unknown): Promise<void> {
  await sql`
    insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
    values (${teamId}::uuid, ${subscriptionId}::text, ${JSON.stringify(cursor ?? null)}::text::jsonb)
    on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint, updated_at = now()`.execute(
    getAutomationsQb(['inbound_checkpoint']),
  );
}

/** Poll one shared key once: a first poll arms; a later one keeps what
 *  arrived as a delivery judged by the key's listens, its cursor with it.
 *  `pollAgainAt`: when its module said the edge is next worth polling. */
export async function pollShared(poll: SharedPoll): Promise<{ arrivals: number; armed: boolean; pollAgainAt?: Date }> {
  const { key, digest } = poll;
  const subscriptionId = pollSubscriptionId(digest);
  const poller = await edgePollerOf({
    adapterType: key.adapterType,
    teamId: key.teamId,
    ...(key.credentialsId !== null ? { credentialsId: key.credentialsId } : {}),
    ...(key.constructionArgs !== undefined ? { constructionArgs: key.constructionArgs } : {}),
  });
  if (poller === null) throw new Error(`${key.adapterType} declares ${key.edge} polled, but answers no poll`);
  const before = await cursorOf(key.teamId, subscriptionId);
  const polled = await poller({
    edge: key.edge,
    ...(key.taken !== undefined ? { filter: key.taken } : {}),
    ...(before !== null && before.cursor !== null ? { cursor: before.cursor } : {}),
  });
  const again = polled.pollAgainAt !== undefined ? { pollAgainAt: polled.pollAgainAt } : {};
  if (before === null || polled.arrivals.length === 0) {
    await keepCursor(key.teamId, subscriptionId, polled.cursor);
    return { arrivals: 0, armed: before === null, ...again };
  }
  await deliverArrivals({
    teamId: key.teamId,
    delivered: { adapterType: key.adapterType, credentialsId: key.credentialsId },
    subscriptionId,
    externalId: null,
    source: 'poll',
    arrivals: polled.arrivals,
    checkpoint: polled.cursor ?? null,
    request: keptPage({ adapterType: key.adapterType, credentialsId: key.credentialsId, arrivals: polled.arrivals }),
    listens: poll.listens,
  });
  notifyWork();
  return { arrivals: polled.arrivals.length, armed: false, ...again };
}

const pollEdgePayloadSchema = z.object({ teamId: teamIdSchema, digest: z.string() });

async function armPoll(poll: SharedPoll, dueAt: Date): Promise<void> {
  await enqueueWork({ kind: 'poll_edge', key: pollWorkKey(poll.digest), teamId: poll.key.teamId, payload: { teamId: poll.key.teamId, digest: poll.digest }, dueAt });
}

/** Polls one key, then arms its row for its next poll: one interval on, or
 *  sooner when its module said so (a schedule's next tick). A key no listen
 *  shares any more is not re-armed (the reconcile removes its row). */
export const pollEdgeHandler: WorkHandler = {
  async run(payload, ctx) {
    const { teamId, digest } = pollEdgePayloadSchema.parse(payload);
    const poll = (await sharedPolls({ teamId })).find((shared) => shared.digest === digest);
    if (poll === undefined) return;
    const startedAt = Date.now();
    const { pollAgainAt } = await pollShared(poll);
    // Measured from when the poll ended, as listen-fire does: the drain's
    // clock (which a test may hold) moved on by the time the poll took.
    const polledAt = new Date(ctx.now.getTime() + (Date.now() - startedAt));
    await armPoll(poll, nextPollAt(polledAt, poll.everyMs, pollAgainAt));
  },
};

/** The periodic `poll_reconcile`: one `poll_edge` row per shared poll, and
 *  none for a key no listen shares any more. */
export const pollReconcileHandler: WorkHandler = {
  async run(_payload, ctx) {
    const [polls, rows] = await Promise.all([sharedPolls(), listWorkByKind('poll_edge')]);
    const armed = new Set(rows.map((row) => row.key));
    const active = new Set<string>();
    for (const poll of polls) {
      const key = pollWorkKey(poll.digest);
      active.add(key);
      // An armed row keeps its time: its handler arms it after each poll, and
      // a failed one holds its backoff.
      if (armed.has(key)) continue;
      try {
        await armPoll(poll, ctx.now);
      } catch (err) {
        logger.error('[EdgePolls] reconcile failed for a shared poll', {
          teamId: poll.key.teamId,
          adapterType: poll.key.adapterType,
          edge: poll.key.edge,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const row of rows) {
      if (!active.has(row.key)) await removeWork({ key: row.key });
    }
  },
};

export function registerPollWork(): void {
  registerWorkHandler('poll_edge', pollEdgeHandler);
  registerWorkHandler('poll_reconcile', pollReconcileHandler);
}

/** Forget the team's poll cursors, so the next poll of each is a first poll.
 *  Run when the team comes back from lf, which handled what arrived since. */
export async function forgetPollProgress(teamId: TeamId): Promise<void> {
  await sql`
    delete from automations.inbound_checkpoint
    where team_id = ${teamId}::uuid and subscription_id like 'edge-poll:%'`.execute(getAutomationsQb(['inbound_checkpoint']));
}

/**
 * Poll every key the listen `triggerId` shares NOW, past its interval: the
 * in-process entry `dev:inject` rides to make a polled source fire off its
 * schedule. The same `pollShared` the handler runs.
 */
export async function pollTriggerNow(input: { triggerId: string }): Promise<{ found: boolean; eventCount: number }> {
  const polls = (await sharedPolls()).filter((poll) => poll.listens.some((listen) => listen.triggerId === input.triggerId));
  let eventCount = 0;
  for (const poll of polls) eventCount += (await pollShared(poll)).arrivals;
  return { found: polls.length > 0, eventCount };
}
