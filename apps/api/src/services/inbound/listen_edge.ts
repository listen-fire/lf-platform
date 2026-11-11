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

import type { TeamId } from '../../generated/kysely/core/Team';
import type { ListenRow } from './listen_door';

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
}

/** How the module delivers a listen's last edge, as its saved listen keeps it. */
export type ListenDelivery = NonNullable<ListenRow['delivery']>['kind'];

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
 *  delivered and, for an edge pushed per scope, the records that scope is
 *  (its last resolve's): the listen's own, or, over a union, each member's
 *  (`memberPlans`). Each is how the one listen is watched, never a listen of
 *  its own. */
export function watchedTraversals(
  listen: ListenRow,
): Array<{ plan: ListenPlan; delivery: ListenRow['delivery']; scopes: readonly string[] | undefined }> {
  if (listen.plan.members === undefined) return [{ plan: listen.plan, delivery: listen.delivery, scopes: listen.watching?.heads }];
  return memberPlans(listen.plan).map((plan, member) => ({
    plan,
    delivery: listen.members?.[member]?.delivery,
    scopes: listen.watching?.members?.[member]?.heads,
  }));
}

/** The keys `listen` is delivered under where a traversal's last edge is
 *  delivered as `deliveries` names, each once with how it is delivered. An
 *  edge pushed per scope (`delivery.scopedBy`) is one key per record its
 *  scope hop landed on, so the records the listen's last resolve came to; a
 *  listen not yet resolved to any is watched under none. Two members of a
 *  union may share one key: the listen is one, so it is heard there once. */
export function listenEdgeKeysOf(
  listen: ListenRow,
  deliveries: readonly ListenDelivery[],
): Array<{ key: ListenEdgeKey; digest: string; delivery: NonNullable<ListenRow['delivery']> }> {
  const keys = new Map<string, { key: ListenEdgeKey; digest: string; delivery: NonNullable<ListenRow['delivery']> }>();
  const add = (key: ListenEdgeKey, delivery: NonNullable<ListenRow['delivery']>): void => {
    const digest = listenEdgeDigest(key);
    const seen = keys.get(digest);
    // Polled under one key by two members, it is polled at the sooner of their intervals.
    const sooner = seen !== undefined && (seen.delivery.pollEverySeconds ?? Infinity) <= (delivery.pollEverySeconds ?? Infinity) ? seen.delivery : delivery;
    keys.set(digest, { key, digest, delivery: sooner });
  };
  for (const { plan, delivery, scopes } of watchedTraversals(listen)) {
    const last = plan.hops.at(-1);
    if (last === undefined || delivery === undefined || !deliveries.includes(delivery.kind)) continue;
    const base: ListenEdgeKey = {
      teamId: listen.teamId,
      adapterType: listen.plan.adapter,
      credentialsId: listen.credentialsId,
      constructionArgs: listen.constructionArgs,
      edge: last.edge,
      taken: last.taken,
      ...(delivery.kind === 'polled' && listen.carriedFrom?.pollsAlone === true ? { alone: listen.triggerId } : {}),
    };
    if (delivery.scopedBy === undefined) {
      add(base, delivery);
      continue;
    }
    for (const scope of scopes ?? []) add({ ...base, scope }, delivery);
  }
  return [...keys.values()];
}
