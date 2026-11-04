// How far a carried version's listen heard, carried to the current version when
// its automation moves, so an upgrade misses nothing and fires nothing twice.
//
// A 0.12 listen keeps its own place: `trigger.poll_checkpoint` per row, and
// `trigger.cron_last_fired_at` for a schedule. The current version keeps one cursor
// per poll key in `inbound_checkpoint`, shared by the listens on that key. The map
// between the two cursors is the carried version's (`cursorOnCurrent`), and a moved
// listen that brought one polls on it alone (listen_edge.ts `alone`): another
// listen on the same key stands somewhere else in the same feed.
//
// All of it happens in the upgrade's transaction, holding the listen's row: a pull
// or a tick under 0.12 either committed first, and is read here, or finds the row
// moved and keeps nothing (poll_source/carried_worker.ts,
// movement_scheduler/worker.ts).

import { isDeepStrictEqual } from 'node:util';

import { sql } from 'kysely';

import type { CarriedFileListener, ListeningLane } from '@listen-fire/language-versions';
import type { LanguageVersion } from 'movement-lang';
import type { MovementId } from '../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../generated/kysely/automations/Trigger';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { MovementRow } from './store';

import { isCurrent, versionOf, versionOfLegacyId } from '@listen-fire/language-versions';
import { isLegacyLanguageVersion } from 'legacy-lang';

import { getAutomationsQb } from '../../../lib/kysely';
import { listenConfigSchema, type SavedListen } from '../../inbound/listen_door';
import { listenEdgeKeysOf } from '../../inbound/listen_edge';
import { loadPinnedVersion } from './version_store';

export interface CarryingFrom {
  lane: ListeningLane;
  /** The carried text's listens, in file order: a rewrite keeps the order. */
  statements: readonly CarriedFileListener[] | null;
  /** The database's clock with the team's doors held: a delivery kept before
   *  this was the carried version's. */
  movedAt: Date;
}

/** What an upgrade of `row` carries from, when it moves from a carried version. */
export async function carryingFromShipped(row: Pick<MovementRow, 'currentVersionId'>, movedAt: Date): Promise<CarryingFrom | undefined> {
  if (row.currentVersionId === null) return undefined;
  const shipped = await loadPinnedVersion(row.currentVersionId);
  if (shipped === null || isCurrent(shipped.languageVersion)) return undefined;
  const pin: LanguageVersion = shipped.languageVersion;
  const load = (isLegacyLanguageVersion(pin) ? versionOfLegacyId(pin) : versionOf(pin))?.listenRows;
  if (load === undefined) return undefined;
  const lane = await load();
  let statements: readonly CarriedFileListener[] | null = null;
  try {
    statements = lane.listenersOf({ source: shipped.source, pin });
  } catch {
    // A text its version no longer parses: its rows are told apart by what they fire.
  }
  return { lane, statements, movedAt };
}

/** Where a listen stood, read with its row held. */
export interface HeardRow {
  pollCheckpoint: unknown;
  cronLastFiredAt: Date | null;
}

export async function heardSoFarOf(movementId: string): Promise<Map<string, HeardRow>> {
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', '=', movementId as MovementId)
    .select(['id', 'poll_checkpoint', 'cron_last_fired_at'])
    .forUpdate()
    .execute();
  return new Map(rows.map((row) => [row.id as string, { pollCheckpoint: row.poll_checkpoint, cronLastFiredAt: row.cron_last_fired_at }]));
}

interface Predecessor {
  id: string;
  firedMovementName: string | null;
  kind: string;
  credentialsId: string | null;
  config: unknown;
}

/**
 * The row each new listen came from. Statement by statement, since a rewrite keeps
 * the file's order and each statement's config is what its row kept; else, when a
 * text has another number of listens, by what the row fires, when only one row
 * fires it through that module and credential. `null` for a listen with no such
 * row: it starts as a new listen does.
 */
export function predecessorsOf(input: {
  desired: ReadonlyArray<{ movementName: string; adapter: string; credentialsId: string | null }>;
  rows: readonly Predecessor[];
  statements: readonly CarriedFileListener[] | null;
}): Array<Predecessor | null> {
  const { desired, rows, statements } = input;
  const left = [...rows];
  const take = (row: Predecessor | undefined): Predecessor | null => {
    if (row === undefined) return null;
    left.splice(left.indexOf(row), 1);
    return row;
  };
  if (statements !== null && statements.length === desired.length) {
    return statements.map((statement) => take(left.find((row) => row.kind === statement.adapter && row.firedMovementName === statement.movementName && isDeepStrictEqual(row.config, statement.config))));
  }
  return desired.map((listen) => {
    const alike = left.filter((row) => row.kind === listen.adapter && row.firedMovementName === listen.movementName && row.credentialsId === listen.credentialsId);
    return alike.length === 1 ? take(alike[0]) : null;
  });
}

export interface CarriedListen {
  /** The row's config, naming the move and, when it brought a cursor, its poll. */
  config: Record<string, unknown>;
  /** The cursors its polls start from, by the subscription id each is kept under. */
  cursors: Array<{ subscriptionId: string; cursor: unknown }>;
}

/** The moved listen's config and cursors. */
export function carriedListen(input: {
  carrying: CarryingFrom;
  config: Record<string, unknown>;
  listen: { triggerId: TriggerId; teamId: TeamId; file: string; credentialsId: string | null };
  heard: HeardRow | undefined;
  pollSubscriptionId: (digest: string) => string;
}): CarriedListen {
  const { carrying, heard } = input;
  const parsed = listenConfigSchema.safeParse(input.config);
  if (!parsed.success) return { config: input.config, cursors: [] };
  const at = carrying.movedAt.toISOString();
  const listenOf = (pollsAlone: boolean): SavedListen => ({
    ...parsed.data.listen,
    ...input.listen,
    carriedFrom: { at, ...(pollsAlone ? { pollsAlone: true } : {}) },
  });
  const moved = { ...input.config, listen: { ...(input.config.listen as Record<string, unknown>), carriedFrom: { at } } };
  if (heard === undefined) return { config: moved, cursors: [] };
  const found = listenEdgeKeysOf(listenOf(false), ['polled']).map(({ key }) => ({
    edge: key.edge,
    carried: carrying.lane.cursorOnCurrent({
      adapterType: key.adapterType,
      edge: key.edge,
      pollCheckpoint: heard.pollCheckpoint,
      cronLastFiredAt: heard.cronLastFiredAt === null ? null : heard.cronLastFiredAt.toISOString(),
    }),
  }));
  if (!found.some(({ carried }) => carried !== undefined)) return { config: moved, cursors: [] };
  const cursors = listenEdgeKeysOf(listenOf(true), ['polled']).flatMap(({ key, digest }) => {
    const carried = found.find(({ edge }) => edge === key.edge)?.carried;
    return carried === undefined ? [] : [{ subscriptionId: input.pollSubscriptionId(digest), cursor: carried.cursor }];
  });
  return { config: { ...input.config, listen: { ...(input.config.listen as Record<string, unknown>), carriedFrom: { at, pollsAlone: true } } }, cursors };
}

/** A re-save of a moved listen keeps its poll and so its cursor. */
export function keepingCarriedFrom(config: Record<string, unknown>, kept: unknown): Record<string, unknown> {
  const before = listenConfigSchema.safeParse(kept);
  const carriedFrom = before.success ? before.data.listen.carriedFrom : undefined;
  if (carriedFrom === undefined || !listenConfigSchema.safeParse(config).success) return config;
  return { ...config, listen: { ...(config.listen as Record<string, unknown>), carriedFrom } };
}

export async function keepCarriedCursors(teamId: TeamId, cursors: CarriedListen['cursors']): Promise<void> {
  for (const { subscriptionId, cursor } of cursors) {
    await sql`
      insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
      values (${teamId}::uuid, ${subscriptionId}::text, ${JSON.stringify(cursor)}::text::jsonb)
      on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint, updated_at = now()`.execute(getAutomationsQb(['inbound_checkpoint']));
  }
}
