// The platform host lists the members of a listen's earlier hops, as
// listen-fire does (crates/lf/src/resolve.rs): a listen whose plan has a hop
// the host lists (`judged: 'resolved'`, Airtable narrowed by base or table) is
// watched once per record its last edge is subscribed under — its base, the
// record its `scopedBy` hop lands on. The judge then fires each arrival from
// the base and table it carries (listen_door.ts, the engine's `carries`), so
// the host lists the bases only to subscribe `Changes` once per base.
//
// Listing, faithful to listen-fire within the platform's reach:
//   - at save, and again on the shortest `relistEverySeconds` its resolved
//     hops declare (Airtable's `Bases`, so a base made or renamed is seen),
//     and again when a member's change is pushed (a `resolve_listen` work row);
//   - one process lists a listen at a time, under the store's hold
//     (`claimResolve`/`saveResolution`, automations.listen_state — the same
//     rows a cloud listen-fire keeps, never a second store);
//   - a listen matching more records than the scope limit is suspended,
//     watched nowhere, until it matches fewer; a failed read keeps the records
//     it had.
//
// The platform cannot reach the engine's `walk` entry (its embed API runs only
// whole movements), so it lists a hop's members by calling the module's
// `getRelated` for the hop's edge and keeping those its WHERE fires, judged by
// the same engine judge the door fires arrivals with — never a filter of this
// host's own. It lists only the records it subscribes by (the `scopedBy`
// hop's, a base), not every hop listen-fire lists (a base's tables), because
// the judge filters the table per arrival; the firing is identical and the
// listing far cheaper. See docs question for Henry.

import { z } from 'zod';

import { makeMetaPosition, type Position } from 'movement-engine/public/catalog';
import { judgeArrival } from 'movement-engine/public/inbound';
import { logger } from 'movement-engine/public/log';
import { memberPlans, type ListenPlan, type PlanArrival, type PlanHop } from 'engine-contracts';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { WorkHandler } from '../work/kinds';

import { enqueueWork } from '../work/store';
import { registerWorkKinds, type WorkKindRegistration } from '../work/drain';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { claimResolve, saveResolution, states, type Resolution, type MemberResolution } from '../lf_store/listens';
import { savedListenOf, type ListenConfig, type ResolvedHop, type SavedListen } from './listen_door';

/** The records a listen's earlier hops may match before it is suspended: no
 *  lf.yaml here, so listen-fire's default (`DEFAULT_LISTEN_SCOPE_LIMIT`),
 *  un-overridable on the platform. */
const LISTEN_SCOPE_LIMIT = 500;

/** How long one list holds a listen, so two processes never list it at once:
 *  past it a hold not kept is taken over (`RUN_LEASE_TTL_MS`). */
const RESOLVE_HOLD_MS = 60_000;

export const RESOLVE_WORK_KIND = 'resolve_listen';

declare module '../work/kinds' {
  interface UnitWorkKinds {
    resolve_listen: true;
  }
}

/** Whether the listen has a hop the host lists (Airtable narrowed by base or
 *  table): over a union, when some member's traversal has one. */
export function resolvesListen(listen: Pick<ListenConfig, 'resolvedHops' | 'members'>): boolean {
  return (listen.resolvedHops?.length ?? 0) > 0 || (listen.members ?? []).some((member) => (member.resolvedHops?.length ?? 0) > 0);
}

/** A resolution as the door reads it (`SavedListen.watching`): what the store
 *  keeps, without the pause and held-count a resolve never writes. */
function resolutionOf(state: { heads: string[]; resolvedAt: string | null; failure: string | null; parents?: Record<string, string[]>; members?: MemberResolution[] }): Resolution {
  return {
    heads: state.heads,
    resolvedAt: state.resolvedAt,
    failure: state.failure,
    ...(state.parents !== undefined ? { parents: state.parents } : {}),
    ...(state.members !== undefined ? { members: state.members } : {}),
  };
}

/** `listens` with what each resolved listen's last resolve came to attached
 *  (`watching`): a listen never resolved keeps none, and is watched nowhere.
 *  One store read per team. */
export async function withWatching(listens: SavedListen[]): Promise<SavedListen[]> {
  const resolving = listens.filter((listen) => resolvesListen(listen));
  if (resolving.length === 0) return listens;
  const byTeam = new Map<TeamId, string[]>();
  for (const listen of resolving) {
    const pipelines = byTeam.get(listen.teamId) ?? [];
    pipelines.push(listen.pipeline);
    byTeam.set(listen.teamId, pipelines);
  }
  const watching = new Map<string, Resolution>();
  for (const [teamId, pipelines] of byTeam) {
    const found = await states({ tenant: teamId }, { pipelines });
    for (const [pipeline, state] of Object.entries(found)) watching.set(`${teamId}:${pipeline}`, resolutionOf(state));
  }
  return listens.map((listen) => {
    const kept = resolvesListen(listen) ? watching.get(`${listen.teamId}:${listen.pipeline}`) : undefined;
    return kept !== undefined ? { ...listen, watching: kept } : listen;
  });
}

/** `listen` with its resolution attached, for one saved listen. */
export async function withWatchingOne(listen: SavedListen): Promise<SavedListen> {
  const [one] = await withWatching([listen]);
  return one ?? listen;
}

/** A hop matching more records than the scope limit: the listen is suspended,
 *  watched nowhere, until it matches fewer. */
class OverLimit extends Error {
  constructor(readonly position: string) {
    super('LISTEN_SCOPE_LIMIT');
  }
  line(listen: SavedListen): string {
    return `LISTEN_SCOPE_LIMIT: ${listen.file}:${listen.plan.movement} matched more ${this.position}s than its limit of ${LISTEN_SCOPE_LIMIT}; it is suspended until its filter matches fewer`;
  }
}

/** One traversal of a listen the host lists (its own, or one member's), with
 *  how its last edge is delivered and the hops of it the host lists. */
interface Traversal {
  plan: ListenPlan;
  resolvedHops: readonly ResolvedHop[];
  scopedBy: string | undefined;
}

function traversalsOf(listen: SavedListen): Traversal[] {
  if (listen.plan.members === undefined) {
    return [{ plan: listen.plan, resolvedHops: listen.resolvedHops ?? [], scopedBy: listen.delivery?.scopedBy }];
  }
  return memberPlans(listen.plan).map((plan, member) => ({
    plan,
    resolvedHops: listen.members?.[member]?.resolvedHops ?? [],
    scopedBy: listen.members?.[member]?.delivery?.scopedBy,
  }));
}

function recordIdOf(position: Position): string | undefined {
  return position.identity.kind === 'stable' ? position.identity.recordId : undefined;
}

function fieldsOf(position: Position): Record<string, unknown> {
  const data = position.identity.data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

/** Whether `record` fires `hop`'s WHERE, judged by the engine's own judge: a
 *  one-hop arrival plan of the hop, the record its landing. A record the judge
 *  cannot decide (a field its module could not read) is not kept, as a
 *  listen-fire resolve keeps only records it confirms. */
function hopFires(listen: SavedListen, hop: PlanHop, record: Position): boolean {
  if (hop.taken === undefined && hop.checked === undefined) return true;
  const plan: ListenPlan = {
    movement: listen.plan.movement,
    connection: listen.plan.connection,
    adapter: listen.plan.adapter,
    hops: [{ ...hop, from: '', judged: 'arrival' }],
  };
  const arrival: PlanArrival = { edge: hop.edge, landing: { recordType: hop.to, fields: fieldsOf(record) } };
  return 'fires' in judgeArrival(plan, arrival, Date.now());
}

/** The records one traversal's last edge is subscribed under: the records its
 *  `scopedBy` hop lands on (Airtable's base), the earlier hops walked from the
 *  root through the module's `getRelated`, each hop's members kept where its
 *  WHERE fires. Empty for a traversal whose last edge is not scoped (delivered
 *  to the whole connection), which needs no listing. */
async function scopeRecordsOf(listen: SavedListen, traversal: Traversal): Promise<string[]> {
  const { scopedBy } = traversal;
  if (scopedBy === undefined) return [];
  const scopeHop = traversal.plan.hops.findIndex((hop) => hop.edge === scopedBy);
  if (scopeHop < 0) {
    throw new Error(`${listen.file}:${listen.plan.movement}: its last edge is scoped by '${scopedBy}', which no earlier hop walks`);
  }
  const adapter = await resolveAdapter({
    adapterType: listen.plan.adapter,
    teamId: listen.teamId,
    ...(listen.credentialsId !== null ? { credentialsId: listen.credentialsId } : {}),
    ...(listen.constructionArgs !== undefined ? { constructionArgs: listen.constructionArgs } : {}),
  });
  let level: Position[] = [makeMetaPosition(listen.plan.adapter)];
  for (let i = 0; i <= scopeHop; i++) {
    const hop = traversal.plan.hops[i]!;
    const next: Position[] = [];
    for (const from of level) {
      const related = await adapter.getRelated({ position: from, fieldId: hop.edge, direction: 'outgoing' });
      for (const { position } of related) {
        if (!hopFires(listen, hop, position)) continue;
        next.push(position);
        if (next.length > LISTEN_SCOPE_LIMIT) throw new OverLimit(hop.to);
      }
    }
    level = next;
  }
  const ids: string[] = [];
  for (const position of level) {
    const id = recordIdOf(position);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** What listing the listen's members now comes to. */
async function listMembers(listen: SavedListen): Promise<Resolution> {
  const resolvedAt = new Date().toISOString();
  if (listen.plan.members === undefined) {
    return { heads: await scopeRecordsOf(listen, traversalsOf(listen)[0]!), resolvedAt, failure: null };
  }
  const members: MemberResolution[] = [];
  const heads: string[] = [];
  for (const traversal of traversalsOf(listen)) {
    if (traversal.resolvedHops.length === 0) {
      members.push({ heads: [] });
      continue;
    }
    const own = await scopeRecordsOf(listen, traversal);
    members.push({ heads: own });
    for (const id of own) if (!heads.includes(id)) heads.push(id);
  }
  return { heads, resolvedAt, failure: null, members };
}

/** What a listing answers when another process holds the listen's resolve claim:
 *  how that listing comes out is not known yet. */
export const HELD_ELSEWHERE = Symbol('another process is listing this listen');

/** List the listen's members and keep what it comes to, under the store's
 *  hold: over the scope limit it is suspended, watched nowhere; a failed read
 *  keeps the records it had, with the new failure. Another process's live hold
 *  leaves it to that process. Answers the failure listing again may mend, if
 *  any: a suspension is kept in the store and lifts on the listen's own relist
 *  once its filter matches fewer, so it is not one to retry. */
export async function resolveListen(listen: SavedListen): Promise<string | null | typeof HELD_ELSEWHERE> {
  const scope = { tenant: listen.teamId };
  const held = await claimResolve(scope, { pipeline: listen.pipeline, ttlMs: RESOLVE_HOLD_MS });
  if (held === null) return HELD_ELSEWHERE;
  const before = (await states(scope, { pipelines: [listen.pipeline] }))[listen.pipeline];
  let resolution: Resolution;
  let suspended = false;
  try {
    resolution = await listMembers(listen);
  } catch (err) {
    if (err instanceof OverLimit) {
      suspended = true;
      resolution = { heads: [], resolvedAt: new Date().toISOString(), failure: err.line(listen) };
    } else {
      const why = err instanceof Error ? err.message : String(err);
      resolution = {
        heads: before?.heads ?? [],
        resolvedAt: before?.resolvedAt ?? null,
        failure: `LISTEN_RESOLVE_FAILED: ${listen.file}:${listen.plan.movement} could not list the records it watches: ${why}`,
        ...(before?.parents !== undefined ? { parents: before.parents } : {}),
        ...(before?.members !== undefined ? { members: before.members } : {}),
      };
    }
  }
  const saved = await saveResolution(scope, { pipeline: listen.pipeline, token: held.token, resolution });
  if (!saved) return HELD_ELSEWHERE;
  if (resolution.failure !== null) logger.warn('[ListenResolve] a listen could not be resolved', { pipeline: listen.pipeline, failure: resolution.failure });
  return suspended ? null : resolution.failure;
}

/** The shortest `relistEverySeconds` the listen's resolved hops declare, in
 *  milliseconds: when it is listed again on a clock. Undefined when none
 *  declares one (its members' changes are pushed, or it has no resolved hop):
 *  it is listed at save, and again only when a change is pushed. */
export function relistIntervalMs(listen: SavedListen): number | undefined {
  const seconds = traversalsOf(listen)
    .flatMap((traversal) => traversal.resolvedHops)
    .flatMap((hop) => (typeof hop.membersChange === 'object' ? [hop.membersChange.relistEverySeconds] : []));
  return seconds.length > 0 ? Math.min(...seconds) * 1000 : undefined;
}

/** The edges of the listen's resolved hops whose module pushes their members'
 *  changes (`membersChange: 'pushed'`): an arrival on one lists the listen
 *  again. */
export function pushedParentEdgesOf(listen: SavedListen): string[] {
  const edges: string[] = [];
  for (const traversal of traversalsOf(listen)) {
    for (const hop of traversal.resolvedHops) {
      if (hop.membersChange !== 'pushed') continue;
      const edge = traversal.plan.hops[hop.hop]?.edge;
      if (edge !== undefined && !edges.includes(edge)) edges.push(edge);
    }
  }
  return edges;
}

function resolveWorkKey(pipeline: string): string {
  return `${RESOLVE_WORK_KIND}:${pipeline}`;
}

const resolvePayloadSchema = z.object({ teamId: z.string(), triggerId: z.string() });

/** Arm the listen's next list `inMs` from now (now by default): its one work
 *  row, so a clock relist and a pushed one share it, the sooner winning. */
export async function armResolve(listen: SavedListen, inMs = 0): Promise<void> {
  await enqueueWork({
    kind: RESOLVE_WORK_KIND,
    key: resolveWorkKey(listen.pipeline),
    teamId: listen.teamId,
    payload: { teamId: listen.teamId, triggerId: listen.triggerId },
    dueAt: new Date(Date.now() + inMs),
  });
}

/** List now, synchronously, and arm the next clock relist: run at save so the
 *  first subscription sync sees the records the listen is subscribed under. */
export async function resolveAndArm(listen: SavedListen): Promise<string | null | typeof HELD_ELSEWHERE> {
  const failure = await resolveListen(listen);
  const everyMs = relistIntervalMs(listen);
  if (everyMs !== undefined) await armResolve(listen, everyMs);
  return failure;
}

/** Each of `listens` whose change was pushed on one of its resolved hops'
 *  edges listed again: the delivery that carried the change arms it
 *  (listen_door.ts), off the listens it was already judged against, so no
 *  listen is re-read on the delivery path. */
export async function armResolveForArrivals(input: { edges: readonly string[]; listens: readonly SavedListen[] }): Promise<void> {
  if (input.edges.length === 0) return;
  for (const listen of input.listens) {
    if (!resolvesListen(listen)) continue;
    if (pushedParentEdgesOf(listen).some((edge) => input.edges.includes(edge))) await armResolve(listen);
  }
}

const resolveListenHandler: WorkHandler = {
  async run(payload) {
    const { triggerId } = resolvePayloadSchema.parse(payload);
    const listen = await savedListenOf(triggerId as TriggerId);
    if (listen === null || !resolvesListen(listen)) return;
    await resolveAndArm(listen);
  },
};

export const LISTEN_RESOLVE_WORK_KINDS: readonly WorkKindRegistration[] = [{ kind: RESOLVE_WORK_KIND, handler: resolveListenHandler }];

export function registerListenResolveWork(): void {
  registerWorkKinds(LISTEN_RESOLVE_WORK_KINDS);
}
