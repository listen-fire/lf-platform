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

/** The key `listen` is delivered under when its last edge is delivered as
 *  `deliveries` names; null otherwise. */
export function listenEdgeKeyOf(listen: SavedListen, deliveries: readonly ListenDelivery[]): ListenEdgeKey | null {
  const last = listen.plan.hops.at(-1);
  const delivery = listen.delivery?.kind;
  if (last === undefined || delivery === undefined || !deliveries.includes(delivery)) return null;
  return {
    teamId: listen.teamId,
    adapterType: listen.plan.adapter,
    credentialsId: listen.credentialsId,
    constructionArgs: listen.constructionArgs,
    edge: last.edge,
    taken: last.taken,
  };
}
