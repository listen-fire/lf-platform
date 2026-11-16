// What the platform's listen upkeep asks of a 0.15 row, answered by 0.15: how
// each of its traversals is watched (the last edge, the part of its filter the
// module takes, how the edge is delivered, the hops the host lists), and the
// calls that upkeep makes of a module (a poll of an edge, a subscription made
// or withdrawn, a hop's members listed), made of 0.15's own modules and judged
// by 0.15's own judge. The platform keeps the cursors, the subscription rows
// and the listings, and shares them by key; it never reads a 0.15 plan itself.
// Production's listing at 0.15.3 (`inbound/listen_resolve.ts` before 0.16).

import { WirePollEdgeResult, memberPlans, type ListenPlan, type PlanArrival, type PlanHop } from '@listen-fire/engine-contracts';
import type { Adapter } from '@listen-fire/engine/public/adapter';
import { makeMetaPosition, type Position } from '@listen-fire/engine/public/catalog';
import { judgeArrival } from '@listen-fire/engine/public/inbound';

import { listenConfigSchema, type ListenConfig } from './listen';
import { moduleTable } from './modules';
import type { ModuleInstall, ModulePlatform } from './run_types';

type Delivery = NonNullable<ListenConfig['delivery']>;
type ResolvedHop = NonNullable<ListenConfig['resolvedHops']>[number];

/** One traversal a 0.15 listen is watched by: its own, or one member's of a
 *  union. */
export interface WatchedTraversal {
  /** Its place among the union's members; undefined for the listen's own. */
  member?: number;
  /** The traversal's last edge, the one its arrivals come on. */
  edge: string;
  /** The part of the last hop's filter the module takes. */
  taken?: unknown;
  /** How the module delivers the last edge, as it declares it. */
  delivery?: Delivery;
  /** Some earlier hop's members the host lists. */
  resolves: boolean;
  /** The shortest relist interval its listed hops declare. */
  relistEverySeconds?: number;
  /** The edges of its listed hops whose members' changes are pushed. */
  pushedParentEdges: string[];
}

/** How a 0.15 listen is watched, as plain data. */
export interface ListenWatch {
  pipeline: string;
  adapter: string;
  movement: string;
  constructionArgs?: Record<string, string>;
  traversals: WatchedTraversal[];
}

interface Traversal {
  member?: number;
  plan: ListenPlan;
  delivery: Delivery | undefined;
  resolvedHops: readonly ResolvedHop[];
}

function traversalsOf(listen: ListenConfig): Traversal[] {
  if (listen.plan.members === undefined) return [{ plan: listen.plan, delivery: listen.delivery, resolvedHops: listen.resolvedHops ?? [] }];
  return memberPlans(listen.plan).map((plan, member) => ({
    member,
    plan,
    delivery: listen.members?.[member]?.delivery,
    resolvedHops: listen.members?.[member]?.resolvedHops ?? [],
  }));
}

/** How a kept row is watched, when it is a 0.15 listen; null otherwise. */
export function watchOf(row: { config: unknown }): ListenWatch | null {
  const parsed = listenConfigSchema.safeParse(row.config);
  if (!parsed.success) return null;
  const { listen } = parsed.data;
  const traversals = traversalsOf(listen).flatMap((traversal): WatchedTraversal[] => {
    const last = traversal.plan.hops.at(-1);
    if (last === undefined) return [];
    const relist = traversal.resolvedHops.flatMap((hop) => (typeof hop.membersChange === 'object' ? [hop.membersChange.relistEverySeconds] : []));
    const pushed = traversal.resolvedHops.flatMap((hop) => {
      const edge = hop.membersChange === 'pushed' ? traversal.plan.hops[hop.hop]?.edge : undefined;
      return edge === undefined ? [] : [edge];
    });
    return [
      {
        ...(traversal.member !== undefined ? { member: traversal.member } : {}),
        edge: last.edge,
        ...(last.taken !== undefined ? { taken: last.taken } : {}),
        ...(traversal.delivery !== undefined ? { delivery: traversal.delivery } : {}),
        resolves: traversal.resolvedHops.length > 0,
        ...(relist.length > 0 ? { relistEverySeconds: Math.min(...relist) } : {}),
        pushedParentEdges: [...new Set(pushed)],
      },
    ];
  });
  return {
    pipeline: listen.pipeline,
    adapter: listen.plan.adapter,
    movement: listen.plan.movement,
    ...(listen.constructionArgs !== undefined ? { constructionArgs: listen.constructionArgs } : {}),
    traversals,
  };
}

/** The install of a module an edge is watched through. */
export interface EdgeInstall {
  teamId: string;
  adapterType: string;
  credentialsId: string | null;
  constructionArgs?: Record<string, string>;
}

/** The listened edge, the part of its filter the module takes, and the
 *  record an edge pushed per scope is watched under. */
export interface WatchedEdge {
  edge: string;
  filter?: unknown;
  scope?: string;
}

function installOf(request: EdgeInstall): ModuleInstall {
  return {
    teamId: request.teamId,
    ...(request.credentialsId !== null ? { credentialsId: request.credentialsId } : {}),
    ...(request.constructionArgs !== undefined ? { constructionArgs: request.constructionArgs } : {}),
  };
}

function edgeOf(request: WatchedEdge): WatchedEdge {
  return {
    edge: request.edge,
    ...(request.filter !== undefined ? { filter: request.filter } : {}),
    ...(request.scope !== undefined ? { scope: request.scope } : {}),
  };
}

/** One poll of an edge by 0.15's module: the page it answered (arrivals as
 *  plain data, which `judgePage` reads back), the next cursor, and when the
 *  module said the edge is next worth polling (an ISO instant). */
export interface PolledPage {
  page: unknown[];
  cursor?: unknown;
  pollAgainAt?: string;
}

/** A poll of one edge from `cursor`, by 0.15's own module. An answer 0.15 does
 *  not read throws, so its cursor is not kept and the platform polls again. */
export async function pollEdge(request: EdgeInstall & WatchedEdge & { cursor?: unknown }, modules: ModulePlatform): Promise<PolledPage> {
  const poll = await moduleTable(modules).poller(request.adapterType, installOf(request));
  if (poll === undefined) throw new Error(`${request.adapterType} under 0.15 declares ${request.edge} polled, but answers no poll`);
  const answer = await poll({ ...edgeOf(request), ...(request.cursor !== undefined ? { cursor: request.cursor } : {}) });
  const read = WirePollEdgeResult.safeParse(answer);
  if (!read.success) throw new Error(`${request.adapterType}: a poll's answer is not one 0.15 reads: ${read.error.issues[0]?.message ?? 'invalid'}`);
  return {
    page: read.data.arrivals,
    ...('cursor' in read.data ? { cursor: read.data.cursor } : {}),
    ...(read.data.pollAgainAt !== undefined ? { pollAgainAt: read.data.pollAgainAt } : {}),
  };
}

/** What registering an edge's subscription came to: the module answers none,
 *  or the source registered it (and what it issued). */
export type SubscribeOutcome = { kind: 'unanswered' } | { kind: 'registered'; externalId?: string; secret?: string };

/** An edge's subscription registered by 0.15's own module, at `callbackUrl`. */
export async function subscribeEdge(
  request: EdgeInstall & WatchedEdge & { callbackUrl: string; current?: { externalId: string } },
  modules: ModulePlatform,
): Promise<SubscribeOutcome> {
  const adapter = await moduleTable(modules).resolve(request.adapterType, installOf(request));
  if (adapter.ensureEventSubscription === undefined) return { kind: 'unanswered' };
  const registered = await adapter.ensureEventSubscription({
    ...edgeOf(request),
    callbackUrl: request.callbackUrl,
    ...(request.current !== undefined ? { current: request.current } : {}),
  });
  return {
    kind: 'registered',
    ...(registered?.externalId !== undefined ? { externalId: registered.externalId } : {}),
    ...(registered?.secret !== undefined ? { secret: registered.secret } : {}),
  };
}

/** An edge's subscription withdrawn at the source by 0.15's own module. */
export async function unsubscribeEdge(
  request: EdgeInstall & WatchedEdge & { callbackUrl: string; externalId?: string },
  modules: ModulePlatform,
): Promise<void> {
  const adapter = await moduleTable(modules).resolve(request.adapterType, installOf(request));
  await adapter.removeEventSubscription?.({
    ...edgeOf(request),
    callbackUrl: request.callbackUrl,
    ...(request.externalId !== undefined ? { externalId: request.externalId } : {}),
  });
}

/** What listing a 0.15 listen's members came to: the records each traversal's
 *  last edge is subscribed under (its scope hop's), or the record type a hop
 *  matched more of than the limit. */
export type ScopeListing = { kind: 'listed'; heads: string[]; members?: { heads: string[] }[] } | { kind: 'over-limit'; recordType: string };

class OverLimit extends Error {
  constructor(readonly recordType: string) {
    super('LISTEN_SCOPE_LIMIT');
  }
}

function recordIdOf(position: Position): string | undefined {
  return position.identity.kind === 'stable' ? position.identity.recordId : undefined;
}

function fieldsOf(position: Position): Record<string, unknown> {
  const data: unknown = position.identity.data;
  if (typeof data !== 'object' || data === null) return {};
  return Object.fromEntries(Object.entries(data));
}

/** Whether `record` fires `hop`'s WHERE, by 0.15's own judge: a one-hop
 *  arrival plan of the hop, the record its landing. One it cannot decide is
 *  not kept. */
function hopFires(plan: ListenPlan, hop: PlanHop, record: Position): boolean {
  if (hop.taken === undefined && hop.checked === undefined) return true;
  const single: ListenPlan = { movement: plan.movement, connection: plan.connection, adapter: plan.adapter, hops: [{ ...hop, from: '', judged: 'arrival' }] };
  const arrival: PlanArrival = { edge: hop.edge, landing: { recordType: hop.to, fields: fieldsOf(record) } };
  return 'fires' in judgeArrival(single, arrival, Date.now());
}

/** The records an edge pushed per scope is subscribed under for one
 *  traversal: its `scopedBy` hop's, walked from the root through 0.15's
 *  module's `getRelated`, each hop's members kept where its WHERE fires. */
async function scopeRecordsOf(input: {
  listen: ListenConfig;
  traversal: Traversal;
  resolve: () => Promise<Adapter>;
  limit: number;
}): Promise<string[]> {
  const scopedBy = input.traversal.delivery?.scopedBy;
  if (scopedBy === undefined) return [];
  const { plan } = input.traversal;
  const scopeHop = plan.hops.findIndex((hop) => hop.edge === scopedBy);
  if (scopeHop < 0) throw new Error(`${input.listen.plan.movement}: its last edge is scoped by '${scopedBy}', which no earlier hop walks`);
  const adapter = await input.resolve();
  let level: Position[] = [makeMetaPosition(input.listen.plan.adapter)];
  for (const hop of plan.hops.slice(0, scopeHop + 1)) {
    const next: Position[] = [];
    for (const from of level) {
      for (const { position } of await adapter.getRelated({ position: from, fieldId: hop.edge, direction: 'outgoing' })) {
        if (!hopFires(input.listen.plan, hop, position)) continue;
        next.push(position);
        if (next.length > input.limit) throw new OverLimit(hop.to);
      }
    }
    level = next;
  }
  return [...new Set(level.flatMap((position) => recordIdOf(position) ?? []))];
}

/** A 0.15 listen's members listed by 0.15's own module and judge, as its
 *  production listed them: only the records its scoped edges are subscribed
 *  under. A failed read throws; the platform keeps what it had. */
export async function listScope(
  request: { teamId: string; credentialsId: string | null; config: unknown; limit: number },
  modules: ModulePlatform,
): Promise<ScopeListing> {
  const parsed = listenConfigSchema.safeParse(request.config);
  if (!parsed.success) throw new Error('a row 0.15 lists the members of is not a 0.15 listen');
  const { listen } = parsed.data;
  let adapter: Promise<Adapter> | undefined;
  const resolve = () => {
    adapter ??= moduleTable(modules).resolve(
      listen.plan.adapter,
      installOf({ teamId: request.teamId, adapterType: listen.plan.adapter, credentialsId: request.credentialsId, ...(listen.constructionArgs !== undefined ? { constructionArgs: listen.constructionArgs } : {}) }),
    );
    return adapter;
  };
  try {
    if (listen.plan.members === undefined) {
      const [own] = traversalsOf(listen);
      return { kind: 'listed', heads: own === undefined ? [] : await scopeRecordsOf({ listen, traversal: own, resolve, limit: request.limit }) };
    }
    const members: { heads: string[] }[] = [];
    const heads: string[] = [];
    for (const traversal of traversalsOf(listen)) {
      const own = traversal.resolvedHops.length === 0 ? [] : await scopeRecordsOf({ listen, traversal, resolve, limit: request.limit });
      members.push({ heads: own });
      for (const id of own) if (!heads.includes(id)) heads.push(id);
    }
    return { kind: 'listed', heads, members };
  } catch (error) {
    if (error instanceof OverLimit) return { kind: 'over-limit', recordType: error.recordType };
    throw error;
  }
}
