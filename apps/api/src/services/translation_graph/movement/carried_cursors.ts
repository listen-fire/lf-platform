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
// movement_scheduler/worker.ts). A place that cannot be carried is never guessed at
// and never lost in silence: the upgrade's answer names the listen.

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
import { listenConfigSchema, type ListenRow } from '../../inbound/listen_door';
import { listenEdgeKeysOf } from '../../inbound/listen_edge';
import { resolveAdapterSlug } from '../adapters/registry';
import { listenIdentityOf } from './carried_pauses';
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

/** Whether a listen's row says it had heard anything: if not, a first poll under
 *  the new version loses nothing. */
export function heardAnything(heard: HeardRow | undefined): boolean {
  if (heard === undefined) return false;
  if (heard.cronLastFiredAt !== null) return true;
  const cursor = heard.pollCheckpoint;
  if (cursor === null || cursor === undefined) return false;
  return typeof cursor !== 'object' || Object.keys(cursor).length > 0;
}

interface Predecessor {
  id: string;
  firedMovementName: string | null;
  kind: string;
  credentialsId: string | null;
  config: unknown;
}

const sameModule = (a: string, b: string): boolean => resolveAdapterSlug(a) === resolveAdapterSlug(b);

/**
 * The row each new listen came from. First statement by statement, since a rewrite
 * keeps the file's order and each statement's config is what its row kept. Then,
 * for a row whose config is not what the statement derives, or a text with another
 * number of listens, by what identifies a listen (the same movement, module and
 * credential, as the pause matching does), when just one row and one listen are
 * left with that identity. Several left alike cannot be told apart, and a cursor
 * from the wrong one would miss events or repeat them, so none of them takes one.
 * `null` for a listen with no such row: it starts as a new listen does. `unmatched`
 * is every row no listen came from.
 */
export function predecessorsOf(input: {
  desired: ReadonlyArray<{ movementName: string; adapter: string; credentialsId: string | null }>;
  rows: readonly Predecessor[];
  statements: readonly CarriedFileListener[] | null;
}): { predecessors: Array<Predecessor | null>; unmatched: Predecessor[] } {
  const { desired, statements } = input;
  const unmatched = [...input.rows];
  const predecessors = desired.map((): Predecessor | null => null);
  const take = (index: number, row: Predecessor): void => {
    unmatched.splice(unmatched.indexOf(row), 1);
    predecessors[index] = row;
  };
  if (statements !== null && statements.length === desired.length) {
    statements.forEach((statement, index) => {
      const row = unmatched.find((candidate) => sameModule(candidate.kind, statement.adapter) && candidate.firedMovementName === statement.movementName && isDeepStrictEqual(candidate.config, statement.config));
      if (row !== undefined) take(index, row);
    });
  }
  const identityOfListen = (index: number): string | null => {
    const { movementName, adapter, credentialsId } = desired[index]!;
    return listenIdentityOf({ movementName, kind: resolveAdapterSlug(adapter), credentialsId });
  };
  const identityOfRow = (row: Predecessor): string | null => listenIdentityOf({ movementName: row.firedMovementName, kind: resolveAdapterSlug(row.kind), credentialsId: row.credentialsId });
  const waiting = desired.flatMap((_, index) => (predecessors[index] === null ? [index] : []));
  for (const index of waiting) {
    const identity = identityOfListen(index);
    const peers = waiting.filter((other) => identityOfListen(other) === identity);
    const alike = unmatched.filter((row) => identityOfRow(row) === identity);
    if (peers.length === 1 && alike.length === 1) take(index, alike[0]!);
  }
  return { predecessors, unmatched };
}

export interface CarriedListen {
  /** The row's config, naming the move and, when it brought a cursor, its poll. */
  config: Record<string, unknown>;
  /** The cursors its polls start from, by the subscription id each is kept under. */
  cursors: Array<{ subscriptionId: string; cursor: unknown }>;
  /** It had heard something, and none of that could be carried to this version. */
  notCarried: boolean;
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
  if (!parsed.success) return { config: input.config, cursors: [], notCarried: heardAnything(heard) };
  const at = carrying.movedAt.toISOString();
  const listenOf = (pollsAlone: boolean): ListenRow => ({
    ...parsed.data.listen,
    ...input.listen,
    carriedFrom: { at, ...(pollsAlone ? { pollsAlone: true } : {}) },
  });
  const moved = { ...input.config, listen: { ...(input.config.listen as Record<string, unknown>), carriedFrom: { at } } };
  if (heard === undefined) return { config: moved, cursors: [], notCarried: false };
  const found = listenEdgeKeysOf(listenOf(false), ['polled']).map(({ key }) => ({
    edge: key.edge,
    carried: carrying.lane.cursorOnCurrent({
      adapterType: key.adapterType,
      edge: key.edge,
      pollCheckpoint: heard.pollCheckpoint,
      cronLastFiredAt: heard.cronLastFiredAt === null ? null : heard.cronLastFiredAt.toISOString(),
    }),
  }));
  if (!found.some(({ carried }) => carried !== undefined)) return { config: moved, cursors: [], notCarried: heardAnything(heard) };
  const cursors = listenEdgeKeysOf(listenOf(true), ['polled']).flatMap(({ key, digest }) => {
    const carried = found.find(({ edge }) => edge === key.edge)?.carried;
    return carried === undefined ? [] : [{ subscriptionId: input.pollSubscriptionId(digest), cursor: carried.cursor }];
  });
  return { config: { ...input.config, listen: { ...(input.config.listen as Record<string, unknown>), carriedFrom: { at, pollsAlone: true } } }, cursors, notCarried: false };
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
