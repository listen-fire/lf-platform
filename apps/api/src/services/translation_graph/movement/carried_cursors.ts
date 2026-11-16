// Where a carried version's polled listen stood, carried to the current version
// when its automation moves, so an upgrade replays nothing and loses nothing.
// The design the upgrade off 0.12 had, for 0.15's cursors.
//
// A 0.15 listen polls under its key naming version 0.15 (inbound/listen_edge.ts),
// its cursor kept under that key's digest, as the current version's are. Moved
// to the current version its key loses the version, which names another row:
// the cursor v0.15.3 left frozen there, one a current listen polls from, or
// none. Read there, the first poll would replay what the carried key already
// heard, or arm past what arrived since. So the upgrade, in its transaction,
// writes the cursor the listen stood at under the key it polls under now, and
// that listen polls on it alone (`alone`): a current listen on the same key
// stands somewhere else in the same feed.
//
// The cursor is carried as it is: every module a 0.15 listen polls through
// writes the cursor 0.16's reads. @lf/system, the cron unit, Gmail, Dealroom
// and Evertrace are the same code in both; Granola 0.14 changes only the
// owner it names on a note. A remote install is the same service either way.

import { sql } from 'kysely';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { getAutomationsQb } from '../../../lib/kysely';
import { triggerIdSchema } from '../../../lib/trigger_id';
import { carriedEdgeKeysOf, carriedListens } from '../../inbound/carried_listens';
import { listenConfigSchema, savedListens, type SavedListen } from '../../inbound/listen_door';
import { listenEdgeDigest, listenEdgeKeysOf } from '../../inbound/listen_edge';
import { pollSubscriptionId } from '../../poll_source/worker';

/** Where one polled key of a carried listen stood. */
export interface PlaceHeard {
  edge: string;
  scope: string | undefined;
  /** Its cursor; null for a key that had none, which polls nothing yet. */
  cursor: { cursor: unknown } | null;
  /** Where its version keeps it, and the same key without the version, where
   *  it was kept while its version was current. */
  versioned: string;
  unversioned: string;
  /** Whether it was found only under `unversioned`: a carried key that has not
   *  polled since its version became carried takes that one over on its first
   *  poll (poll_source/worker.ts `carriedCursorOf`), so it is where it stands. */
  unpolledSince: boolean;
  /** Whether a carried listen of another automation polls under `versioned`
   *  too: the row is its as well, so the place is copied, not moved. */
  shared: boolean;
}

/** Where each of an automation's carried listens stood, by trigger row. */
export type PlacesHeard = ReadonlyMap<string, readonly PlaceHeard[]>;

async function lockedCursor(teamId: TeamId, subscriptionId: string): Promise<{ cursor: unknown } | null> {
  const { rows } = await sql<{ checkpoint: unknown }>`
    select checkpoint from automations.inbound_checkpoint
    where team_id = ${teamId}::uuid and subscription_id = ${subscriptionId}::text
    for update`.execute(getAutomationsQb(['inbound_checkpoint']));
  const row = rows[0];
  return row === undefined ? null : { cursor: row.checkpoint };
}

/** Where the automation's carried listens stand, read before the upgrade
 *  touches their rows, each cursor row held until it commits. A paused listen
 *  is read too: its place moves with it. Empty for an automation its version's
 *  lane does not read. */
export async function placesHeardOf(input: { teamId: TeamId; movementId: MovementId }): Promise<PlacesHeard> {
  const moving = await carriedListens({ teamId: input.teamId, movementId: input.movementId });
  if (moving.length === 0) return new Map();
  const movingIds = new Set<string>(moving.map((listen) => listen.triggerId));
  const staying = new Set(
    (await carriedListens({ teamId: input.teamId })).filter((listen) => !movingIds.has(listen.triggerId)).flatMap((listen) => carriedEdgeKeysOf(listen, ['polled']).map(({ digest }) => digest)),
  );
  const places = new Map<string, PlaceHeard[]>();
  for (const listen of moving) {
    const heard: PlaceHeard[] = [];
    for (const { key, digest } of carriedEdgeKeysOf(listen, ['polled'])) {
      const versioned = pollSubscriptionId(digest);
      const unversioned = pollSubscriptionId(listenEdgeDigest({ ...key, version: undefined }));
      const own = await lockedCursor(input.teamId, versioned);
      const before = own ?? (await lockedCursor(input.teamId, unversioned));
      heard.push({ edge: key.edge, scope: key.scope, cursor: before, versioned, unversioned, unpolledSince: own === null && before !== null, shared: staying.has(digest) });
    }
    places.set(listen.triggerId, heard);
  }
  return places;
}

/** Whether a listen stood anywhere: one that never polled loses nothing by
 *  starting as a new listen does. */
export function heardAnything(places: readonly PlaceHeard[] | undefined): places is readonly PlaceHeard[] {
  return places !== undefined && places.some((place) => place.cursor !== null);
}

/** The row each new listen came from: its own row when the upgrade kept it,
 *  else the one row it retires with the same identity (movement, module and
 *  credential), when just one new listen has that identity too. `unsure`: the
 *  rows it may have come from, when more than one is left alike. */
export function predecessorsOf(input: {
  fresh: ReadonlyArray<{ kept: string | undefined; identity: string | null }>;
  retired: ReadonlyArray<{ id: string; identity: string | null }>;
}): Array<{ row: string } | { unsure: string[] } | null> {
  return input.fresh.map(({ kept, identity }) => {
    if (kept !== undefined) return { row: kept };
    if (identity === null) return null;
    const alike = input.retired.filter((row) => row.identity === identity);
    const peers = input.fresh.filter((other) => other.kept === undefined && other.identity === identity).length;
    if (alike.length === 1 && peers === 1) return { row: alike[0]!.id };
    return alike.length > 0 ? { unsure: alike.map((row) => row.id) } : null;
  });
}

/** The new row's config, noting the move: it polls on the place it brought. */
export function carriedConfig(config: Record<string, unknown>, movedAt: Date): Record<string, unknown> {
  const listen = config['listen'];
  if (typeof listen !== 'object' || listen === null) return config;
  return { ...config, listen: { ...listen, carriedFrom: { at: movedAt.toISOString(), pollsAlone: true } } };
}

/** A listen the upgrade moved, as its new row is written, with where its
 *  predecessor stood. `what` names it to the author. */
export interface MovedListen {
  triggerId: string;
  credentialsId: string | null;
  config: Record<string, unknown>;
  places: readonly PlaceHeard[];
  what: string;
}

/**
 * Writes each moved listen's places under the keys it polls under now,
 * replacing whatever row was there, then clears the rows nothing polls from any
 * more: a frozen cursor left under a current key would be read by the next
 * listen saved on it, and replay. A row another listen still polls from stays.
 * Answers the keys whose place could not be told, which start from their first
 * poll.
 */
export async function keepCarriedPlaces(input: {
  teamId: TeamId;
  file: string;
  moved: readonly MovedListen[];
}): Promise<string[]> {
  const db = getAutomationsQb(['inbound_checkpoint']);
  const notes: string[] = [];
  const written = new Set<string>();
  const left: PlaceHeard[] = [];
  for (const moved of input.moved) {
    const parsed = listenConfigSchema.safeParse(moved.config);
    if (!parsed.success) continue;
    const listen: SavedListen = { ...parsed.data.listen, triggerId: triggerIdSchema.parse(moved.triggerId), teamId: input.teamId, file: input.file, credentialsId: moved.credentialsId };
    for (const { key, digest } of listenEdgeKeysOf(listen, ['polled'])) {
      const subscriptionId = pollSubscriptionId(digest);
      const alike = moved.places.filter((place) => place.edge === key.edge && place.scope === key.scope);
      const cursors = new Set(alike.map((place) => JSON.stringify(place.cursor?.cursor ?? null)));
      const place = cursors.size === 1 ? alike[0] : undefined;
      if (alike.length > 0 && place === undefined) {
        notes.push(`${input.file}: ${moved.what} starts polling ${key.edge} from its first poll: it stood at more than one place there before the upgrade, and which to carry on from could not be told, so what arrived since its last poll is missed.`);
      }
      written.add(subscriptionId);
      if (place === undefined || place.cursor === null) {
        // Its own key: a row there is nothing it stood at.
        await sql`delete from automations.inbound_checkpoint where team_id = ${input.teamId}::uuid and subscription_id = ${subscriptionId}::text`.execute(db);
        continue;
      }
      await sql`
        insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
        values (${input.teamId}::uuid, ${subscriptionId}::text, ${JSON.stringify(place.cursor.cursor ?? null)}::text::jsonb)
        on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint, updated_at = now()`.execute(db);
    }
    left.push(...moved.places);
  }
  if (left.length === 0) return notes;
  // Read after the moved rows are written: their keys poll alone, so only
  // another current listen polls under an unversioned key here.
  const polledNow = new Set((await savedListens({ teamId: input.teamId })).flatMap((listen) => listenEdgeKeysOf(listen, ['polled']).map(({ digest }) => pollSubscriptionId(digest))));
  for (const place of left) {
    // Another carried listen polls from the versioned row, or takes the
    // unversioned one over on its first poll when it has none.
    if (place.shared) {
      if (place.unpolledSince) continue;
    } else {
      await sql`delete from automations.inbound_checkpoint where team_id = ${input.teamId}::uuid and subscription_id = ${place.versioned}::text`.execute(db);
    }
    if (written.has(place.unversioned) || polledNow.has(place.unversioned)) continue;
    await sql`delete from automations.inbound_checkpoint where team_id = ${input.teamId}::uuid and subscription_id = ${place.unversioned}::text`.execute(db);
  }
  return notes;
}
