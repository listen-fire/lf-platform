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
// A listen pinned to a carried version is polled the same way, under keys of
// its version's own (listen_edge.ts): its version's module answers the poll,
// and its version's judge judges what it found (`judgePage`), each receipt
// queued as a kept delivery's are (inbound/carried_delivery.ts).
//
// A team whose engine is lf is not polled: a cloud lf polls for it. A switch
// back to the platform forgets its cursors (`forgetPollProgress`), so the
// next poll of each is a first poll and replays nothing lf already handled.

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

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
import { earlierNamesOf, listenEdgeKeysOf, type ListenEdgeKey } from '../inbound/listen_edge';
import { carriedEdgeKeysOf, carriedListens, carriedListensContained, type CarriedListen } from '../inbound/carried_listens';
import { inOneTransaction } from '../context/one_transaction';

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

/** One key, the listens sharing it, and how often it is polled. A key names
 *  its version (`key.version`): its listens are the current version's
 *  (`listens`) or that carried version's (`carried`), never both. */
export interface SharedPoll {
  key: ListenEdgeKey;
  digest: string;
  listens: SavedListen[];
  carried: CarriedListen[];
  everyMs: number;
  /** A carried key's names under earlier releases, most recent first
   *  (`earlierNamesOf`), each with whether a listen polls there now. */
  earlier?: Array<{ digest: string; polled: boolean }>;
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
  return (await readSharedPolls(input)).polls;
}

/** The shared polls, and the carried versions whose listens could not be read:
 *  those are left out, so the current version's polls run whatever a carried
 *  version does, and a caller must not take their polls for gone. */
async function readSharedPolls(input: { teamId?: TeamId }): Promise<{ polls: SharedPoll[]; carriedUnread: ReadonlySet<string> }> {
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
  const share = (keyed: { key: ListenEdgeKey; digest: string; delivery: { pollEverySeconds?: number } }, listen: { current: SavedListen } | { carried: CarriedListen }): void => {
    const everyMs = (keyed.delivery.pollEverySeconds ?? DEFAULT_POLL_EVERY_SECONDS) * SECOND;
    const shared = polls.get(keyed.digest) ?? { key: keyed.key, digest: keyed.digest, listens: [], carried: [], everyMs };
    if ('current' in listen) shared.listens.push(listen.current);
    else shared.carried.push(listen.carried);
    shared.everyMs = Math.min(shared.everyMs, everyMs);
    polls.set(keyed.digest, shared);
  };
  for (const row of rows) {
    if (lfTeams.has(row.teamId)) continue;
    const config = currentListenOf(row);
    if (config === null) continue;
    const listen: SavedListen = { ...config, triggerId: row.id, teamId: teamIdSchema.parse(row.teamId), file: row.file, credentialsId: row.credentialsId ?? null };
    for (const keyed of listenEdgeKeysOf(listen, ['polled'])) share(keyed, { current: listen });
  }
  // A carried row is read by its version alone, so it is not narrowed by its
  // plan here: its version says how it is watched.
  const carried = await carriedListensContained({ ...(input.teamId !== undefined ? { teamId: input.teamId } : {}), firing: true });
  for (const listen of carried.listens) {
    if (lfTeams.has(listen.teamId)) continue;
    for (const keyed of carriedEdgeKeysOf(listen, ['polled'])) share(keyed, { carried: listen });
  }
  for (const poll of polls.values()) {
    if (poll.key.version === undefined) continue;
    // Any listen polling under an earlier name is another key's: this one's is its own.
    poll.earlier = earlierNamesOf(poll.key).map((digest) => {
      const there = polls.get(digest);
      return { digest, polled: there !== undefined && there.listens.length + there.carried.length > 0 };
    });
  }
  return { polls: [...polls.values()], carriedUnread: carried.unread };
}

async function cursorOf(teamId: TeamId, subscriptionId: string): Promise<{ cursor: unknown } | null> {
  const { rows } = await sql<{ checkpoint: unknown }>`
    select checkpoint from automations.inbound_checkpoint
    where team_id = ${teamId}::uuid and subscription_id = ${subscriptionId}::text`.execute(getAutomationsQb(['inbound_checkpoint']));
  const row = rows[0];
  return row === undefined ? null : { cursor: row.checkpoint };
}

/** A carried key's cursor: its own, else the one it had under an earlier
 *  release (`takeOverEarlierPlace`). A version becomes carried at an upgrade,
 *  and a release can rename a carried key, so taking that cursor over keeps what
 *  arrived between the last poll under the old name and the first under the new
 *  one, which a first poll would arm past. Its own row, once kept, always wins. */
async function carriedCursorOf(poll: SharedPoll, subscriptionId: string): Promise<{ cursor: unknown } | null> {
  const { teamId } = poll.key;
  const own = await cursorOf(teamId, subscriptionId);
  if (own !== null || poll.earlier === undefined) return own;
  await takeOverEarlierPlace({ teamId, subscriptionId, earlier: poll.earlier.map(({ digest, polled }) => ({ subscriptionId: pollSubscriptionId(digest), polled })) });
  return cursorOf(teamId, subscriptionId);
}

/**
 * Takes over, for a carried key with no cursor of its own, the first cursor
 * kept under one of its earlier names (`earlierNamesOf`, most recent first): it
 * is where the key stood. It is moved when nothing else polls there: left
 * behind, it would be found again later (an upgrade of these listens, or another
 * listen saved on that key) and replay what this key already heard. It is copied
 * when something does, which goes on polling from it. Written before the poll,
 * so a poll that fails after it polls again from the cursor taken over.
 */
export async function takeOverEarlierPlace(input: { teamId: TeamId; subscriptionId: string; earlier: ReadonlyArray<{ subscriptionId: string; polled: boolean }> }): Promise<void> {
  const { teamId, subscriptionId } = input;
  const db = getAutomationsQb(['inbound_checkpoint']);
  for (const { subscriptionId: from, polled } of input.earlier) {
    if ((await cursorOf(teamId, from)) === null) continue;
    if (polled) {
      await sql`
        insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
        select team_id, ${subscriptionId}::text, checkpoint from automations.inbound_checkpoint
        where team_id = ${teamId}::uuid and subscription_id = ${from}::text
        on conflict (team_id, subscription_id) do nothing`.execute(db);
    } else {
      await sql`
        with moved as (
          delete from automations.inbound_checkpoint
          where team_id = ${teamId}::uuid and subscription_id = ${from}::text
          returning team_id, checkpoint
        )
        insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
        select team_id, ${subscriptionId}::text, checkpoint from moved
        on conflict (team_id, subscription_id) do nothing`.execute(db);
    }
    return;
  }
}

async function lockedCursorOf(teamId: TeamId, subscriptionId: string): Promise<{ cursor: unknown } | null> {
  const { rows } = await sql<{ checkpoint: unknown }>`
    select checkpoint from automations.inbound_checkpoint
    where team_id = ${teamId}::uuid and subscription_id = ${subscriptionId}::text
    for update`.execute(getAutomationsQb(['inbound_checkpoint']));
  const row = rows[0];
  return row === undefined ? null : { cursor: row.checkpoint };
}

/** The key's carried listens still on it and firing, their rows held: taken
 *  in id order, as an upgrade takes its automations' rows, before the cursor's
 *  row, as the upgrade takes it. */
async function listensStillOn(poll: SharedPoll): Promise<CarriedListen[]> {
  const ids = poll.carried.map((listen): string => listen.triggerId);
  await sql`select id from automations.trigger where id = any(${ids}::uuid[]) order by id for update`.execute(getAutomationsQb(['trigger']));
  const now = await carriedListens({ teamId: poll.key.teamId, firing: true });
  return now.filter((listen) => ids.includes(listen.triggerId) && carriedEdgeKeysOf(listen, ['polled']).some(({ digest }) => digest === poll.digest));
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
  if (poll.key.version !== undefined) return pollCarried(poll);
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

/** A carried version's key polled once by its own module: a first poll arms;
 *  a later one's page is judged by the key's listens with that version's own
 *  judge, its receipts and its cursor kept in one write, so a poll that fails
 *  before it is polled again from the same cursor. */
async function pollCarried(poll: SharedPoll): Promise<{ arrivals: number; armed: boolean; pollAgainAt?: Date }> {
  const { key, digest } = poll;
  const [first] = poll.carried;
  if (first === undefined) return { arrivals: 0, armed: false };
  const { lane } = first;
  // Loaded when a carried key is polled: the carried run host reaches the catalog, which reaches this worker.
  const [{ modulePlatform }, { judgeCarriedPage }] = await Promise.all([import('../translation_graph/movement/carried_run'), import('../inbound/carried_delivery')]);
  const subscriptionId = pollSubscriptionId(digest);
  const before = await carriedCursorOf(poll, subscriptionId);
  const polled = await lane.pollEdge(
    {
      teamId: key.teamId,
      adapterType: key.adapterType,
      credentialsId: key.credentialsId,
      ...(key.constructionArgs !== undefined ? { constructionArgs: key.constructionArgs } : {}),
      edge: key.edge,
      ...(key.taken !== undefined ? { filter: key.taken } : {}),
      ...(key.scope !== undefined ? { scope: key.scope } : {}),
      ...(before !== null && before.cursor !== null ? { cursor: before.cursor } : {}),
    },
    modulePlatform(),
  );
  const pollAgainAt = polled.pollAgainAt !== undefined ? new Date(polled.pollAgainAt) : undefined;
  if (pollAgainAt !== undefined && Number.isNaN(pollAgainAt.getTime())) throw new Error(`${key.adapterType}: a poll answered pollAgainAt ${JSON.stringify(polled.pollAgainAt)}: expected an instant`);
  const again = pollAgainAt !== undefined ? { pollAgainAt } : {};
  const judging = before !== null && polled.page.length > 0;
  // Kept as the 0.12 worker kept a pull (`pollOne` in poll_source/carried_worker.ts
  // at 0.12.13, deleted in abbb3ac3): in one write, under the listens' rows and
  // the cursor's, and only while the cursor is still the one polled from. An
  // upgrade that committed meanwhile carried the place to its listens' new keys,
  // which poll on from it: the page is theirs, and is dropped here, so nothing
  // fires twice. Of the listens, only those still on this key judge it.
  const kept = await inOneTransaction(async () => {
    const listens = await listensStillOn(poll);
    if (listens.length === 0 || !isDeepStrictEqual(await lockedCursorOf(key.teamId, subscriptionId), before)) return false;
    if (judging) {
      await judgeCarriedPage({
        teamId: key.teamId,
        adapterType: key.adapterType,
        credentialsId: key.credentialsId,
        page: polled.page,
        // The cursor it was polled from names the page: polled again from it, it is the same page.
        stableKey: `${subscriptionId}:${createHash('sha256').update(JSON.stringify(before.cursor ?? null)).digest('hex').slice(0, 16)}`,
        listens,
      });
    }
    await keepCursor(key.teamId, subscriptionId, polled.cursor);
    return true;
  });
  if (!kept) return { arrivals: 0, armed: false, ...again };
  if (judging) notifyWork();
  return { arrivals: before === null ? 0 : polled.page.length, armed: before === null, ...again };
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
    const { polls, carriedUnread } = await readSharedPolls({ teamId });
    const poll = polls.find((shared) => shared.digest === digest);
    if (poll === undefined) {
      // It may be an unread version's: retried with backoff, never dropped for it.
      if (carriedUnread.size > 0) throw new Error(`poll ${digest} is not among the polls read, and the listens of ${[...carriedUnread].join(', ')} could not be read`);
      return;
    }
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
    const [{ polls, carriedUnread }, rows] = await Promise.all([readSharedPolls({}), listWorkByKind('poll_edge')]);
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
    // An unread version's polls are not known gone: none is removed until its
    // listens are read again.
    if (carriedUnread.size > 0) return;
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
