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
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementId } from '../../../generated/kysely/automations/Movement';

import { getAutomationsQb } from '../../../lib/kysely';
import { triggerIdSchema } from '../../../lib/trigger_id';
import { carriedEdgeKeysOf, carriedListens, type CarriedListen } from '../../inbound/carried_listens';
import { listenConfigSchema, savedListens, type SavedListen } from '../../inbound/listen_door';
import { carriedFromSchema, earlierNamesOf, listenEdgeKeysOf, isPushed, namesReadBesides, placeFrom012, pollsAloneOf, type ListenEdgeKey, type PlaceNames } from '../../inbound/listen_edge';
import { pollSubscriptionId, takeOverEarlierPlace } from '../../poll_source/worker';

/** Where one polled key of a carried listen stood. */
export interface PlaceHeard {
  edge: string;
  scope: string | undefined;
  /** Its cursor; null for a key that had none, which polls nothing yet. */
  cursor: { cursor: unknown } | null;
  /** Every name its cursor may be kept under: its own, then its earlier ones
   *  (`earlierNamesOf`). */
  names: readonly string[];
}

/** Where an automation's carried listens stood, by trigger row, and the names
 *  the carried listens it leaves behind may still read a place from. */
export interface PlacesHeard {
  byRow: ReadonlyMap<string, readonly PlaceHeard[]>;
  readByOthers: ReadonlySet<string>;
}

/** Every name a carried listen's polls may read a place from, by key. */
function namesOf(listen: CarriedListen): Array<{ key: ListenEdgeKey; names: PlaceNames }> {
  return carriedEdgeKeysOf(listen, ['polled']).map(({ key, digest }) => ({ key, names: { own: pollSubscriptionId(digest), earlier: earlierNamesOf(key).map(pollSubscriptionId) } }));
}

const everyName = (names: PlaceNames): string[] => [names.own, ...names.earlier];

async function lockedCursor(teamId: TeamId, subscriptionId: string): Promise<{ cursor: unknown } | null> {
  const { rows } = await sql<{ checkpoint: unknown }>`
    select checkpoint from automations.inbound_checkpoint
    where team_id = ${teamId}::uuid and subscription_id = ${subscriptionId}::text
    for update`.execute(getAutomationsQb(['inbound_checkpoint']));
  const row = rows[0];
  return row === undefined ? null : { cursor: row.checkpoint };
}

/** Where the automation's carried listens stand, read before the upgrade
 *  touches their rows, each cursor row held until it commits. A key that has
 *  not polled under its own name since a release renamed it first takes over
 *  its earlier place, as its next poll would (`takeOverEarlierPlace`). A paused
 *  listen is read too: its place moves with it. Empty for an automation its
 *  version's lane does not read. */
export async function placesHeardOf(input: { teamId: TeamId; movementId: MovementId }): Promise<PlacesHeard> {
  const moving = await carriedListens({ teamId: input.teamId, movementId: input.movementId });
  if (moving.length === 0) return { byRow: new Map(), readByOthers: new Set() };
  const movingIds = new Set<string>(moving.map((listen) => listen.triggerId));
  const staying = (await carriedListens({ teamId: input.teamId })).filter((listen) => !movingIds.has(listen.triggerId)).flatMap((listen) => namesOf(listen).map(({ names }) => names));
  const current = (await savedListens({ teamId: input.teamId }))
    .filter((listen) => !movingIds.has(listen.triggerId))
    .flatMap((listen) => listenEdgeKeysOf(listen, ['polled']).map(({ digest }): PlaceNames => ({ own: pollSubscriptionId(digest), earlier: [] })));
  const keyed = moving.map((listen) => ({ triggerId: listen.triggerId, keys: namesOf(listen) }));
  // Every key that may read a place, this automation's own included.
  const everyKey = [...staying, ...current, ...keyed.flatMap(({ keys }) => keys.map(({ names }) => names))];
  const byRow = new Map<string, PlaceHeard[]>();
  for (const { triggerId, keys } of keyed) {
    const heard: PlaceHeard[] = [];
    for (const { key, names } of keys) {
      if ((await lockedCursor(input.teamId, names.own)) === null) {
        const readBesides = namesReadBesides({ taker: names.own, keys: everyKey });
        await takeOverEarlierPlace({ teamId: input.teamId, subscriptionId: names.own, earlier: names.earlier.map((name) => ({ subscriptionId: name, readElsewhere: readBesides.has(name) })) });
      }
      heard.push({ edge: key.edge, scope: key.scope, cursor: await lockedCursor(input.teamId, names.own), names: everyName(names) });
    }
    byRow.set(triggerId, heard);
  }
  return { byRow, readByOthers: new Set([...staying, ...current].flatMap(everyName)) };
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

const markedSchema = z.object({ listen: z.object({ carriedFrom: carriedFromSchema }) });

/** The new row's config, noting the move. `at` records when it was last
 *  carried, so a row carried from 0.12 and then from 0.15 says the later, and
 *  the door leaves a delivery kept before it to the version that read it then
 *  (inbound/listen_door.ts); `from012` says whether its place came from 0.12
 *  as its row already did. `broughtPlace`: it polls alone on the place it
 *  brought; otherwise it polls as its row already said. */
export function carriedConfig(config: Record<string, unknown>, carried: { movedAt: Date; broughtPlace: boolean }): Record<string, unknown> {
  const listen = config['listen'];
  if (typeof listen !== 'object' || listen === null) return config;
  const pollsAlone = carried.broughtPlace || pollsAloneOf(config);
  const before = markedSchema.safeParse(config);
  const from012 = before.success && placeFrom012(before.data.listen.carriedFrom);
  return { ...config, listen: { ...listen, carriedFrom: { at: carried.movedAt.toISOString(), ...(pollsAlone ? { pollsAlone: true } : {}), from012 } } };
}

/** Whether a planned row is a listen its module pushes to on some traversal. */
export function pushedListen(config: Record<string, unknown>): boolean {
  const parsed = listenConfigSchema.safeParse(config);
  return parsed.success && isPushed(parsed.data.listen);
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
  /** Names another listen may still read a place from (`PlacesHeard`). */
  readByOthers: ReadonlySet<string>;
}): Promise<string[]> {
  const db = getAutomationsQb(['inbound_checkpoint']);
  const notes: string[] = [];
  const written = new Set<string>();
  const left: PlaceHeard[] = [];
  for (const moved of input.moved) {
    const parsed = listenConfigSchema.safeParse(moved.config);
    if (!parsed.success) {
      notes.push(`${input.file}: ${moved.what} starts polling from its first poll: this release could not read its new row, so where it stood was not carried, and what arrived since its last poll is missed.`);
      continue;
    }
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
  // another current listen polls under an earlier name here.
  const polledNow = new Set((await savedListens({ teamId: input.teamId })).flatMap((listen) => listenEdgeKeysOf(listen, ['polled']).map(({ digest }) => pollSubscriptionId(digest))));
  for (const name of new Set(left.flatMap((place) => place.names))) {
    if (written.has(name) || polledNow.has(name) || input.readByOthers.has(name)) continue;
    await sql`delete from automations.inbound_checkpoint where team_id = ${input.teamId}::uuid and subscription_id = ${name}::text`.execute(db);
  }
  return notes;
}
