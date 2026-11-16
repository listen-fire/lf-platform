// What the listens sharing one poll or one subscription share (adapter
// protocol 2.6): the connection (module, credential and construction), the
// listened edge, the part of its filter the module takes, and — for an edge
// pushed per scope (Airtable's `Changes`, one webhook per base) — the record
// that scope is. Two listens with the same key are one poll or one
// subscription, and an arrival it delivers is judged only by them: one their
// module filtered (`takenApplied`) is judged without the filter, so another
// listen on the edge must never hear it.
//
// A listen whose plan has a hop the host lists (`judged: 'resolved'`, Airtable
// narrowed by base or table) is watched once per record its scoped-by hop
// lands on (its base), the records its last resolve came to
// (listen_resolve.ts). It is watched nowhere until it is resolved.

import { createHash } from 'node:crypto';

import { memberPlans, type ListenPlan } from 'engine-contracts';
import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { SavedListen } from './listen_door';

export interface ListenEdgeKey {
  teamId: TeamId;
  adapterType: string;
  credentialsId: string | null;
  constructionArgs: Record<string, string> | undefined;
  edge: string;
  /** The part of the last hop's filter the module takes; undefined for none. */
  taken: unknown;
  /** The record an edge pushed per scope is subscribed under, by its id
   *  (Airtable's `Changes`, one webhook per base); undefined for an edge over
   *  the whole connection. */
  scope?: string;
  /** A listen that brought its own cursor from a carried version polls on it,
   *  alone: another listen on the key stands somewhere else in the same feed, so
   *  sharing would lose what lay between or hear it twice. Undefined for all
   *  others. */
  alone?: string;
  /** The compatibility key of the carried version whose listens share it:
   *  each version polls and subscribes through its own modules, so such a key
   *  is never shared across versions. Undefined for the current version's, and
   *  for a subscription to a whole connection's edge (`unnarrowed`). */
  version?: string;
}

/** Whether a key subscribes to its connection's whole edge: delivered by
 *  subscription, with no filter the module takes and no scope. Every version
 *  wants the same of the source there, and a module may register it account
 *  wide (Affinity's and the knowledge graph's take every change), so it is one
 *  subscription whichever versions' listens share it, each version reading
 *  what arrives there for its own listens. */
export function unnarrowed(key: Pick<ListenEdgeKey, 'taken' | 'scope'>, delivery: ListenDelivery): boolean {
  return delivery === 'connection' && key.taken === undefined && key.scope === undefined;
}

/** The platform's note on a listen that came up from a carried version by an
 *  upgrade: when, and whether it polls on the cursor it brought rather than
 *  sharing a poll. The platform keeps it, not the version, so it is read off a
 *  row whichever version plans it: the keys of a listen that polls alone name
 *  it (`alone`) whether its version is current or carried. `from012`: whether
 *  its place came from 0.12, by that move or an earlier one (`placeFrom012`). */
export const carriedFromSchema = z.object({ at: z.string(), pollsAlone: z.boolean().optional(), from012: z.boolean().optional() });

/** Whether a listen's place came from 0.12, so a webhook a 0.12 settings listen
 *  registered may be all it hears through until its own subscription is up.
 *  Every note says so from 0.16.1 on; one written before says nothing, and
 *  each of those was written by a move off 0.12, the only move that noted one. */
export function placeFrom012(carriedFrom: z.infer<typeof carriedFromSchema> | undefined): boolean {
  return carriedFrom !== undefined && (carriedFrom.from012 ?? true);
}

const rowCarriedFromSchema = z.object({ listen: z.object({ carriedFrom: carriedFromSchema }) });

/** Whether a trigger row's listen polls alone on a cursor it brought. */
export function pollsAloneOf(config: unknown): boolean {
  const read = rowCarriedFromSchema.safeParse(config);
  return read.success && read.data.listen.carriedFrom.pollsAlone === true;
}

const keptMarkSchema = z.object({ listen: z.object({ carriedFrom: z.unknown().optional() }) });
const listenRecordSchema = z.object({ listen: z.record(z.string(), z.unknown()) });

/** A re-save of a listen an upgrade moved from a carried version keeps the mark
 *  of the move, so its keys stay the ones it polls under. Read off the raw rows,
 *  never through a version's plan schema: a save under a carried version plans
 *  its listens in that version's shape, which this release's schema need not
 *  read, and dropping the mark there would change the key with no word said. A
 *  mark that cannot be read, or a planned row with no listen to keep it on,
 *  refuses the save, naming the listen (`what`). */
export function keepingCarriedFrom(input: { config: Record<string, unknown>; kept: unknown; what: string }): Record<string, unknown> {
  const before = keptMarkSchema.safeParse(input.kept);
  const mark = before.success ? before.data.listen.carriedFrom : undefined;
  if (mark === undefined) return input.config;
  const carriedFrom = carriedFromSchema.safeParse(mark);
  if (!carriedFrom.success) {
    throw new Error(`${input.what}: the mark of the upgrade that moved it cannot be read (${carriedFrom.error.message}), so saving it would change the key it polls under`);
  }
  const now = listenRecordSchema.safeParse(input.config);
  if (!now.success) throw new Error(`${input.what}: its planned row has no listen to keep the mark of the upgrade that moved it on, so saving it would change the key it polls under`);
  return { ...input.config, listen: { ...now.data.listen, carriedFrom: carriedFrom.data } };
}

/** How the module delivers a listen's last edge, as its saved listen keeps it. */
export type ListenDelivery = NonNullable<SavedListen['delivery']>['kind'];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 16 hex digits of the sha256 of the key: what its poll row, its cursor,
 *  its subscription and their deliveries are named by. */
export function listenEdgeDigest(key: ListenEdgeKey): string {
  return createHash('sha256').update(canonical(key)).digest('hex').slice(0, 16);
}

/** The names a carried key's cursor was kept under by earlier releases, most
 *  recent first, each unlike the key's own: v0.16.0's, its key with its
 *  version and without `alone`, since v0.16.0 never let a carried listen poll
 *  alone; then v0.15.3's, its key without its version, from while 0.15 was
 *  current, polling alone as `carriedFrom.pollsAlone` says. None for a current
 *  key. */
export function earlierNamesOf(key: ListenEdgeKey): string[] {
  if (key.version === undefined) return [];
  const names = [...(key.alone !== undefined ? [listenEdgeDigest({ ...key, alone: undefined })] : []), listenEdgeDigest({ ...key, version: undefined })];
  const own = listenEdgeDigest(key);
  return [...new Set(names)].filter((name) => name !== own);
}

/** What a key keeps its place under (its cursor, its subscription row): its own
 *  name, and the names earlier releases kept that place under, most recent
 *  first. */
export interface PlaceNames {
  own: string;
  earlier: readonly string[];
}

/**
 * The names keys other than `taker` may read a place from: each one's own and
 * each of its earlier ones, paused or firing. The one rule for taking over a
 * place kept under an earlier name, for a cursor and a subscription row alike:
 * copied when another key reads that name, moved when none does. Two listens a
 * release named apart may both read the one name they shared under the release
 * before; moved by the first, it is gone for the second, which falls back to an
 * older place and replays from it.
 */
export function namesReadBesides(input: { taker: string; keys: Iterable<PlaceNames> }): Set<string> {
  const names = new Set<string>();
  for (const { own, earlier } of input.keys) {
    if (own === input.taker) continue;
    names.add(own);
    for (const name of earlier) names.add(name);
  }
  return names;
}

/** One traversal a listen is watched by, with how its last edge is
 *  delivered and, for an edge pushed per scope, the records that scope is
 *  (its last resolve's): the listen's own, or, over a union, each member's
 *  (`memberPlans`). Each is how the one listen is watched, never a listen of
 *  its own. */
export function watchedTraversals(
  listen: Pick<SavedListen, 'plan' | 'delivery' | 'members' | 'watching'>,
): Array<{ plan: ListenPlan; delivery: SavedListen['delivery']; scopes: readonly string[] | undefined }> {
  if (listen.plan.members === undefined) return [{ plan: listen.plan, delivery: listen.delivery, scopes: listen.watching?.heads }];
  return memberPlans(listen.plan).map((plan, member) => ({
    plan,
    delivery: listen.members?.[member]?.delivery,
    scopes: listen.watching?.members?.[member]?.heads,
  }));
}

/** Whether a listen's module pushes it what arrives on some traversal: to its
 *  connection, or per scope. */
export function isPushed(listen: Pick<SavedListen, 'plan' | 'delivery' | 'members' | 'watching'>): boolean {
  return watchedTraversals(listen).some(({ delivery }) => delivery?.kind === 'connection' || delivery?.kind === 'scope');
}

/** A listen as its keys are made: its connection, and each traversal it is
 *  watched by (its last edge, the filter part its module takes, how the edge
 *  is delivered, and the records an edge pushed per scope is watched under),
 *  whichever version read its plan. */
export interface WatchedListen {
  teamId: TeamId;
  triggerId: string;
  adapter: string;
  credentialsId: string | null;
  constructionArgs: Record<string, string> | undefined;
  traversals: ReadonlyArray<{ edge: string; taken: unknown; delivery: SavedListen['delivery']; scopes: readonly string[] | undefined }>;
  /** It polls on a cursor it brought from a carried version, alone. */
  pollsAlone?: boolean;
  /** The carried version that reads it; undefined for the current version. */
  version?: string;
}

/** A current listen, as its keys are made. */
function watchedOf(listen: SavedListen): WatchedListen {
  return {
    teamId: listen.teamId,
    triggerId: listen.triggerId,
    adapter: listen.plan.adapter,
    credentialsId: listen.credentialsId,
    constructionArgs: listen.constructionArgs,
    traversals: watchedTraversals(listen).flatMap(({ plan, delivery, scopes }) => {
      const last = plan.hops.at(-1);
      return last === undefined ? [] : [{ edge: last.edge, taken: last.taken, delivery, scopes }];
    }),
    ...(listen.carriedFrom?.pollsAlone === true ? { pollsAlone: true } : {}),
  };
}

/** The keys `listen` is delivered under where a traversal's last edge is
 *  delivered as `deliveries` names, each once with how it is delivered. An
 *  edge pushed per scope (`delivery.scopedBy`) is one key per record its
 *  scope hop landed on, so the records the listen's last resolve came to; a
 *  listen not yet resolved to any is watched under none. Two members of a
 *  union may share one key: the listen is one, so it is heard there once. */
export function edgeKeysOf(
  listen: WatchedListen,
  deliveries: readonly ListenDelivery[],
): Array<{ key: ListenEdgeKey; digest: string; delivery: NonNullable<SavedListen['delivery']> }> {
  const keys = new Map<string, { key: ListenEdgeKey; digest: string; delivery: NonNullable<SavedListen['delivery']> }>();
  const add = (key: ListenEdgeKey, delivery: NonNullable<SavedListen['delivery']>): void => {
    const digest = listenEdgeDigest(key);
    const seen = keys.get(digest);
    // Polled under one key by two members, it is polled at the sooner of their intervals.
    const sooner = seen !== undefined && (seen.delivery.pollEverySeconds ?? Infinity) <= (delivery.pollEverySeconds ?? Infinity) ? seen.delivery : delivery;
    keys.set(digest, { key, digest, delivery: sooner });
  };
  for (const { edge, taken, delivery, scopes } of listen.traversals) {
    if (delivery === undefined || !deliveries.includes(delivery.kind)) continue;
    const base: ListenEdgeKey = {
      teamId: listen.teamId,
      adapterType: listen.adapter,
      credentialsId: listen.credentialsId,
      constructionArgs: listen.constructionArgs,
      edge,
      taken,
      ...(delivery.kind === 'polled' && listen.pollsAlone === true ? { alone: listen.triggerId } : {}),
      ...(listen.version !== undefined && !unnarrowed({ taken }, delivery.kind) ? { version: listen.version } : {}),
    };
    if (delivery.scopedBy === undefined) {
      add(base, delivery);
      continue;
    }
    for (const scope of scopes ?? []) add({ ...base, scope }, delivery);
  }
  return [...keys.values()];
}

/** A current listen's keys (`edgeKeysOf`). */
export function listenEdgeKeysOf(
  listen: SavedListen,
  deliveries: readonly ListenDelivery[],
): Array<{ key: ListenEdgeKey; digest: string; delivery: NonNullable<SavedListen['delivery']> }> {
  return edgeKeysOf(watchedOf(listen), deliveries);
}
