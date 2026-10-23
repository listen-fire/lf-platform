// `movements.watch` over the team's served set (rows.ts). The platform keeps no
// log of events: a cursor names a LISTING, the paths and versions the team was
// served when the cursor was answered, stored in
// `automations.lf_movements_listing`. The cursor is a hash of the team and that
// listing, so every api instance mints the same cursor for the same listing and
// answers one another minted. The events after a cursor are the difference
// between its listing and the team's listing now:
//
//   * a path in both at another version is `changed`;
//   * a path only now served is `added`, and one no longer served is `removed`,
//     whatever the reason (a ship or a delete, a pause or a resume, a
//     credential connected or no longer served).
//
// A cursor this table does not hold for the team (never minted, minted for
// another team, or unseen for a day and deleted) is `resync`.
//
// With nothing to report the request is held: the module LISTENs on the team's
// channel (team_changes.ts), re-lists on each notification, and answers as soon
// as the listing differs, or with no events when the hold runs out. The hold
// is the smaller of the caller's `waitMs` and `WATCH_HOLD_MS`, which sits below
// every request timeout the deployment guides put in front of the api
// (SELF_HOSTING.md). At most `WATCH_HELD_PER_TEAM` watches of one team are held
// at once in one process; another is answered at once with no events, and lf
// asks again after its pause.

import { createHash } from 'node:crypto';

import { sql } from 'kysely';
import { logger } from 'movement-engine/public/log';

import type { MovementsChangeShape, MovementsWatchAnswerShape, WatchRequestShape } from 'engine-contracts/slots';
import type { TeamChangeSubscription, TeamChanges } from './team_changes';

import { getAutomationsQb } from '../../lib/kysely';
import { servedMovements, type ServedMovementsTenant } from './rows';

/** The longest a watch is held. lf asks for 30 s and gives up after 40 s; the
 *  protocol caps a hold at 30 s; the margin keeps the answer, which follows one
 *  more listing, inside the cap with room for a slow scan. */
export const WATCH_HOLD_MS = 25_000;

/** The most watches of one team held at once in one process. */
export const WATCH_HELD_PER_TEAM = 4;

/** A listing row unseen this long is deleted when the team's next listing is stored. */
const LISTING_UNSEEN_DAYS = 1;

interface Listed {
  path: string;
  version: string;
}

export interface MovementsWatcherOptions {
  changes: TeamChanges;
  holdMs?: number;
  heldPerTeam?: number;
}

export interface MovementsWatcher {
  watch(scope: ServedMovementsTenant, request: WatchRequestShape): Promise<MovementsWatchAnswerShape>;
}

/** The listing in one order, so one set of files always hashes the same. */
async function listingNow(tenant: string): Promise<Listed[]> {
  return (await servedMovements({ tenant }))
    .map(({ path, version }) => ({ path, version }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function cursorOf(tenant: string, listing: Listed[]): string {
  return createHash('sha256').update(`${tenant}\n${JSON.stringify(listing)}`).digest('hex');
}

// The listing table's columns are written as SQL: its generated row type
// brands `team_id` and `cursor` as the table's own keys, which a team id and a
// hash are not (lf_secrets/lease.ts does the same for its lease).
const listingDb = () => getAutomationsQb(['lf_movements_listing']);

/** Stores `listing` under its cursor (or marks it seen) and returns the cursor. */
async function stored(tenant: string, listing: Listed[]): Promise<string> {
  const cursor = cursorOf(tenant, listing);
  await sql`
    INSERT INTO automations.lf_movements_listing (team_id, cursor, listing)
    VALUES (${tenant}, ${cursor}, ${JSON.stringify(listing)}::jsonb)
    ON CONFLICT (team_id, cursor) DO UPDATE SET seen_at = now()`.execute(listingDb());
  await sql`
    DELETE FROM automations.lf_movements_listing
    WHERE team_id = ${tenant} AND seen_at < now() - make_interval(days => ${LISTING_UNSEEN_DAYS})`.execute(listingDb());
  return cursor;
}

/** The listing a cursor names for this team, marked seen; null when there is none. */
async function listingAt(tenant: string, cursor: string): Promise<Listed[] | null> {
  const { rows } = await sql<{ listing: unknown }>`
    UPDATE automations.lf_movements_listing SET seen_at = now()
    WHERE team_id = ${tenant} AND cursor = ${cursor}
    RETURNING listing`.execute(listingDb());
  const row = rows[0];
  if (row === undefined) return null;
  const listing: unknown = row.listing;
  if (!Array.isArray(listing)) return null;
  return listing.flatMap((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'path' in entry && 'version' in entry && typeof entry.path === 'string' && typeof entry.version === 'string'
      ? [{ path: entry.path, version: entry.version }]
      : [],
  );
}

/** What changed from `from` to `to`, in path order. */
export function listingChanges(from: Listed[], to: Listed[]): MovementsChangeShape[] {
  const before = new Map(from.map((file) => [file.path, file.version]));
  const after = new Map(to.map((file) => [file.path, file.version]));
  const events: MovementsChangeShape[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(path);
    const now = after.get(path);
    if (now === undefined) events.push({ kind: 'removed', path });
    else if (was === undefined) events.push({ kind: 'added', path, version: now });
    else if (was !== now) events.push({ kind: 'changed', path, version: now });
  }
  return events;
}

function counts(events: MovementsChangeShape[]) {
  return {
    added: events.filter((event) => event.kind === 'added').length,
    changed: events.filter((event) => event.kind === 'changed').length,
    removed: events.filter((event) => event.kind === 'removed').length,
  };
}

export function movementsWatcher(options: MovementsWatcherOptions): MovementsWatcher {
  const holdMs = options.holdMs ?? WATCH_HOLD_MS;
  const heldPerTeam = options.heldPerTeam ?? WATCH_HELD_PER_TEAM;
  const held = new Map<string, number>();

  async function answered(tenant: string, listing: Listed[], events: MovementsChangeShape[]): Promise<MovementsWatchAnswerShape> {
    const cursor = await stored(tenant, listing);
    if (events.length > 0) logger.info('[lf-movements] watch: changes', { team: tenant, ...counts(events) });
    return { cursor, events };
  }

  /** Holds until the listing moves from `from` or `until` passes. */
  async function hold(tenant: string, from: Listed[], until: number): Promise<MovementsWatchAnswerShape> {
    let subscription: TeamChangeSubscription | null = null;
    try {
      for (;;) {
        subscription ??= await options.changes.subscribe(tenant);
        // Listed after subscribing, so a write committed in between is seen
        // either here or as a notification.
        const listing = await listingNow(tenant);
        const events = listingChanges(from, listing);
        if (events.length > 0) return await answered(tenant, listing, events);
        const wake = await subscription.next(until - Date.now());
        if (wake === 'quiet') return await answered(tenant, listing, []);
        // A change re-lists; a lost connection subscribes again first. Past
        // `until`, the next wait answers quiet at once after that listing.
        if (wake === 'lost') {
          await subscription.close();
          subscription = null;
        }
      }
    } finally {
      await subscription?.close();
    }
  }

  return {
    async watch({ tenant }, request) {
      const listing = await listingNow(tenant);
      if (request.cursor === undefined) return answered(tenant, listing, []);

      const from = await listingAt(tenant, request.cursor);
      if (from === null) {
        logger.info('[lf-movements] watch: resync', { team: tenant });
        return { resync: true };
      }
      const events = listingChanges(from, listing);
      const waitMs = Math.min(request.waitMs, holdMs);
      if (events.length > 0 || waitMs === 0) return answered(tenant, listing, events);

      const holding = held.get(tenant) ?? 0;
      if (holding >= heldPerTeam) {
        logger.info('[lf-movements] watch: answered at once, the team already has its held watches', { team: tenant, held: holding });
        return answered(tenant, listing, []);
      }
      held.set(tenant, holding + 1);
      try {
        return await hold(tenant, from, Date.now() + waitMs);
      } finally {
        const left = (held.get(tenant) ?? 1) - 1;
        if (left > 0) held.set(tenant, left);
        else held.delete(tenant);
      }
    },
  };
}
