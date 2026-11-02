// What the listens sharing one poll or one subscription share (adapter
// protocol 2.6): the connection (module, credential and construction), the
// listened edge, and the part of its filter the module takes. Two listens with
// the same key are one poll or one subscription, and an arrival it delivers is
// judged only by them: one their module filtered (`takenApplied`) is judged
// without the filter, so another listen on the edge must never hear it.
//
// The platform's listens are never resolved (a `resolved` hop is refused at
// save), so no key is scoped by a record an earlier hop landed on.

import { createHash } from 'node:crypto';

import { memberPlans, type ListenPlan } from 'engine-contracts';

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

/** One traversal a listen is watched by, with how its last edge is
 *  delivered: the listen's own, or, over a union, each member's
 *  (`memberPlans`). Each is how the one listen is watched, never a listen of
 *  its own. */
export function watchedTraversals(listen: SavedListen): Array<{ plan: ListenPlan; delivery: SavedListen['delivery'] }> {
  if (listen.plan.members === undefined) return [{ plan: listen.plan, delivery: listen.delivery }];
  return memberPlans(listen.plan).map((plan, member) => ({ plan, delivery: listen.members?.[member]?.delivery }));
}

/** The keys `listen` is delivered under where a traversal's last edge is
 *  delivered as `deliveries` names, each once with how it is delivered. Two
 *  members of a union may share one key: the listen is one, so it is heard
 *  there once. */
export function listenEdgeKeysOf(
  listen: SavedListen,
  deliveries: readonly ListenDelivery[],
): Array<{ key: ListenEdgeKey; digest: string; delivery: NonNullable<SavedListen['delivery']> }> {
  const keys = new Map<string, { key: ListenEdgeKey; digest: string; delivery: NonNullable<SavedListen['delivery']> }>();
  for (const { plan, delivery } of watchedTraversals(listen)) {
    const last = plan.hops.at(-1);
    if (last === undefined || delivery === undefined || !deliveries.includes(delivery.kind)) continue;
    const key: ListenEdgeKey = {
      teamId: listen.teamId,
      adapterType: listen.plan.adapter,
      credentialsId: listen.credentialsId,
      constructionArgs: listen.constructionArgs,
      edge: last.edge,
      taken: last.taken,
    };
    const digest = listenEdgeDigest(key);
    const seen = keys.get(digest);
    // Polled under one key by two members, it is polled at the sooner of their intervals.
    const sooner = seen !== undefined && (seen.delivery.pollEverySeconds ?? Infinity) <= (delivery.pollEverySeconds ?? Infinity) ? seen.delivery : delivery;
    keys.set(digest, { key, digest, delivery: sooner });
  }
  return [...keys.values()];
}
