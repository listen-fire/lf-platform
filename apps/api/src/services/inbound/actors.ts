// `Actor`: who acted on what lands, as the platform offers it (listen-fire's
// docs/contracts/actor-field.md, plus the platform's `Member` and `User`). The
// language names none of it: to a filter and a run it is an ordinary record
// field that may be absent. The catalog offers it on each landing of a module
// that reports who acted (`graftActorField`), and the door writes it into each
// arrival before the arrival is judged or logged (`withActors`), so a filter,
// a run and a wait read one answer.

import { isDeepStrictEqual } from 'node:util';

import { memberPlans, normalisedActor, type ActorCandidate, type ActorIdentity, type Arrival, type AwaitLanding, type NormalisedActor } from 'engine-contracts';
import { arrivalTriggerOf } from 'movement-engine/public/inbound';
import { logger } from 'movement-engine/public/log';

import type { Adapter } from 'movement-engine/public/adapter';
import type { InstanceSchema, PositionSchema, ResolveFile, SchemaFieldType } from 'movement-lang';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { DeliveredBy, SavedListen } from './listen_door';

import { getAutomationsQb } from '../../lib/kysely';
import { originatorTeamUser } from '../translation_graph/adapters/acting_user/resolve';
import { getAdapterManifest } from '../translation_graph/adapters/registry';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { importedFilesMention } from '../translation_graph/movement/files';

/** The field a landing gains. */
export const ACTOR = 'Actor';

/** The record type that field holds. Not `Actor`, so a module's own type of
 *  that name (an Attio object) keeps it, as on `lf`. */
export const ACTOR_TYPE = 'ListenFireActor';

/** What the platform writes: `normalisedActor`'s fields, then whether the
 *  source system vouched for a team member and, when it did, which user. */
export type PlatformActor = NormalisedActor & { Member: boolean; User?: string };

const said = new Set<string>();

/** Said once per process for each module and type, as `lf` says it once when
 *  it describes a module. The catalog and the door both name the type by its
 *  position, so the two cannot say it twice. */
function sayKept(adapterType: string, type: string): void {
  const key = JSON.stringify([adapterType, type]);
  if (said.has(key)) return;
  said.add(key);
  logger.warn(`[Actor] ${adapterType}: '${type}' has its own '${ACTOR}', so the platform offers no ${ACTOR} on it. What a filter reads is the source system's.`);
}

function sayTypeTaken(adapterType: string): void {
  const key = JSON.stringify([adapterType]);
  if (said.has(key)) return;
  said.add(key);
  logger.warn(`[Actor] ${adapterType}: it has a type named '${ACTOR_TYPE}', so the platform offers no ${ACTOR} on it.`);
}

// ── The catalog ─────────────────────────────────────────────────────────────

const text: SchemaFieldType = { kind: 'maybeAbsent', of: 'text' };

const ACTOR_POSITION: PositionSchema = {
  properties: { Id: 'text', Email: text, Domain: text, Phone: text, Name: text, Proven: 'boolean', Member: 'boolean', User: text },
  edges: {},
  description: 'Who acted, as the platform offers it on what lands.',
  fieldDocs: {
    Id: "The module's own id for them.",
    Email: 'Their address, lower case.',
    Domain: 'The part of Email after its last @.',
    Phone: 'Digits only, country code first.',
    Name: 'As the source system reports it.',
    Proven: 'True when the module checked that the source system vouches for them.',
    Member: 'True only for a team member the source system vouched for: an address nobody vouched for, as an email sender is, never sets it.',
    User: "The member's user id, when Member is true.",
  },
};

const ACTOR_PROPERTY: SchemaFieldType = { kind: 'maybeAbsent', of: { kind: 'record', position: { kind: 'position', position: ACTOR_TYPE } } };

/** Whether a module listing `methods` reports who acted. */
export function reportsWhoActed(methods: readonly string[]): boolean {
  return methods.includes('getActorCandidates') || methods.includes('extractActor');
}

/** The positions a listenable edge lands on: a listenable root collection's,
 *  and each listenable edge's, every member of a union one. */
function landingPositions(schema: InstanceSchema): Set<string> {
  const targets = [
    ...Object.values(schema.collections).flatMap((collection) => (collection.listenable === true ? [collection.target] : [])),
    ...Object.values(schema.positions).flatMap((position) => Object.values(position.edges).flatMap((edge) => (edge.listenable === true ? [edge.target] : []))),
  ];
  return new Set(targets.flatMap((target) => schema.unions?.[target] ?? [target]));
}

function isOffered(type: SchemaFieldType | undefined): boolean {
  return isDeepStrictEqual(type, ACTOR_PROPERTY);
}

function isOfferedType(position: PositionSchema): boolean {
  return isDeepStrictEqual(position, ACTOR_POSITION);
}

/** A field, an edge, or a field of another name keyed by the id `Actor`: a
 *  name in a source system is its customer's, so it is never refused. */
function declaresOwnActor(position: PositionSchema): boolean {
  const property = position.properties[ACTOR];
  return (
    (property !== undefined && !isOffered(property)) ||
    position.edges[ACTOR] !== undefined ||
    (position.writeOnlyProperties ?? []).includes(ACTOR) ||
    Object.entries(position.fieldIds ?? {}).some(([name, id]) => id === ACTOR && name !== ACTOR)
  );
}

/**
 * `schema` with `Actor` on each position a listenable edge lands on, copy on
 * write (the input is shared cache state). Its field id is named as itself,
 * which no projection writes: a saved listen whose field ids name it was
 * planned over this offer, and the door reads that. A position nobody has
 * described is left alone, since nothing says it has no `Actor` of its own.
 */
export function graftActorField(input: { adapterType: string; methods: readonly string[]; schema: InstanceSchema }): InstanceSchema {
  const { schema } = input;
  if (!reportsWhoActed(input.methods)) return schema;
  const named = schema.positions[ACTOR_TYPE];
  if (named !== undefined && !isOfferedType(named)) {
    sayTypeTaken(input.adapterType);
    return schema;
  }
  let positions = schema.positions;
  for (const name of landingPositions(schema)) {
    const position = positions[name];
    if (position === undefined || position.undescribed === true || position.pending === true) continue;
    if (isOffered(position.properties[ACTOR])) continue;
    if (declaresOwnActor(position)) {
      sayKept(input.adapterType, name);
      continue;
    }
    positions = {
      ...positions,
      [name]: { ...position, properties: { ...position.properties, [ACTOR]: ACTOR_PROPERTY }, fieldIds: { ...position.fieldIds, [ACTOR]: ACTOR } },
    };
  }
  if (positions === schema.positions) return schema;
  return { ...schema, positions: { ...positions, [ACTOR_TYPE]: ACTOR_POSITION } };
}

// ── The door ────────────────────────────────────────────────────────────────

/**
 * What `withActors` decided for one arrival, in the arrivals' order. The fire
 * judgement reads this, never a field keyed `Actor`, which a module or a
 * body could have filled.
 * - `written`: the platform wrote `actor` as `Actor`. `addressMatch` is the
 *   team member the arrival's address belongs to, whether or not the source
 *   system vouched for it (`actor` names a member only when it did), so a
 *   rule that accepts an unvouched address reads it here.
 * - `unknown`: the lookup failed, so who acted is undecided.
 * - `nobody`: it was needed, and the arrival named no one.
 * - `module`: the module declared its own `Actor`; the platform wrote nothing.
 * - `unneeded`: nothing reads it; the arrival is as it came.
 */
export type ActorDecision =
  | { kind: 'written'; actor: PlatformActor; addressMatch?: AddressMatch }
  | { kind: 'unknown' }
  | { kind: 'nobody' }
  | { kind: 'module' }
  | { kind: 'unneeded' };

/** The team member an address belongs to, and whether the source system
 *  vouched for the person at that address. */
export interface AddressMatch {
  user: string;
  vouched: boolean;
}

/** Whether any listen's automation has a fire list without anyone, which is
 *  judged from `Actor`. Nothing stated is not anyone. */
function fireStatementNeedsActor(listens: readonly SavedListen[]): boolean {
  return listens.some((listen) => !listen.fire.some((grantee) => grantee.kind === 'anyone'));
}

/**
 * Whether an automation reads `Actor`: its text, or the text of a file it
 * imports, transitively, says it, as `lf` decides it over every file of a
 * project. Matching too much costs a lookup and misses no read; nothing in the
 * check says what a fired function or its waits read. A save records it on the
 * automation, since a run any of its triggers started may wait on a press.
 */
export async function automationReadsActor(input: { source: string; resolveFile: ResolveFile }): Promise<boolean> {
  return input.source.includes(ACTOR) || importedFilesMention({ rootSource: input.source, resolveFile: input.resolveFile, needle: ACTOR });
}

/** The edges of `edges` a run waits on whose automation reads `Actor`, so the
 *  arrival it wakes on must carry who acted. Reached by the version the run
 *  pins, which every run that can wait has, not by the trigger that started it. */
async function edgesWaitedOnForActor(input: { team: TeamId; adapterType: string; edges: readonly string[] }): Promise<Set<string>> {
  if (input.edges.length === 0) return new Set();
  const rows = await getAutomationsQb(['wait_row', 'trigger_run', 'movement_version', 'movement'])
    .selectFrom('wait_row')
    .innerJoin('trigger_run', 'trigger_run.id', 'wait_row.run_id')
    .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
    .innerJoin('movement', 'movement.id', 'movement_version.movement_id')
    .select('wait_row.edge')
    .distinct()
    .where('wait_row.team_id', '=', input.team)
    .where('wait_row.adapter_type', '=', input.adapterType)
    .where('wait_row.edge', 'in', [...input.edges])
    .where('movement.reads_actor', '=', true)
    .execute();
  return new Set(rows.map((row) => row.edge));
}

/**
 * Whether the module declared its own `Actor` on what landed, as the field ids
 * of the listens on that connection say: one planned over the offer says it
 * did not, one planned over a catalog that kept the module's say so says it
 * did. With neither, nothing says the module declared one, so a value keyed
 * `Actor` is a body's and is removed, as `lf` removes it.
 */
function moduleOwnsActor(listens: readonly SavedListen[], landing: AwaitLanding): boolean {
  const { recordType } = landing;
  if (recordType === undefined) return false;
  const described = listens.flatMap((listen): Record<string, string>[] => {
    const ids = listen.fieldIds[recordType];
    return ids === undefined ? [] : [ids];
  });
  if (described.some(isOfferedActor)) return false;
  return described.some(declaresActorOf);
}

/** Field ids planned over the platform's offer of `Actor`. */
function isOfferedActor(ids: Record<string, string>): boolean {
  return ids[ACTOR] === ACTOR;
}

/** Field ids that name an `Actor` of the module's own. */
function declaresActorOf(ids: Record<string, string>): boolean {
  return !isOfferedActor(ids) && (ids[ACTOR] !== undefined || Object.values(ids).includes(ACTOR));
}

/**
 * Whether a saved listen lands on a record whose module keeps its own
 * `Actor`, as its field ids say: the door then looks nobody up for it, so a
 * fire list cannot be applied to it and the save says so.
 */
export function landsOnModuleActor(listen: Pick<SavedListen, 'plan' | 'fieldIds'>): boolean {
  return memberPlans(listen.plan).some((member) => {
    const landing = member.hops.at(-1)?.to;
    const ids = landing === undefined ? undefined : listen.fieldIds[landing];
    return ids !== undefined && declaresActorOf(ids);
  });
}

/** What the module said of who acted, when asked: its candidates, or why it
 *  could not say. */
type Asked = { candidates: ActorCandidate[] } | { failed: string };

async function ask(module: () => Promise<Adapter>, adapterType: string, arrival: Exclude<Arrival, { gone: true }>): Promise<Asked> {
  try {
    const adapter = await module();
    if (adapter.getActorCandidates === undefined) return { candidates: [] };
    const event = arrivalTriggerOf({ pipelineInputId: '', adapterType, arrival, now: new Date() });
    return { candidates: await adapter.getActorCandidates({ event }) };
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether `candidate` names the same person as `named`: the same id, from
 *  the same module when both say which. */
function samePerson(named: ActorIdentity, candidate: ActorIdentity): boolean {
  if (named.identifier !== candidate.identifier) return false;
  return named.adapterType === undefined || candidate.adapterType === undefined || named.adapterType === candidate.adapterType;
}

/** Who acted, and the identity their membership is looked up by. The arrival's
 *  `Id` and `Proven` stand, since they say whom the source system vouched for;
 *  only the address comes from the module's originator for that same person.
 *  An arrival that named nobody is who the first originator is. */
function identityOf(named: ActorIdentity | undefined, candidates: readonly ActorCandidate[]): { written: ActorIdentity; lookedUp: ActorIdentity } | undefined {
  const originators = candidates.filter((candidate) => candidate.source === 'originator').map((candidate) => candidate.identity);
  if (named === undefined) {
    const first = originators[0];
    return first === undefined ? undefined : { written: first, lookedUp: first };
  }
  const same = originators.find((identity) => samePerson(named, identity));
  const address = same === undefined ? undefined : normalisedActor(same)?.Email;
  return { written: address === undefined ? named : { ...named, email: address }, lookedUp: same ?? named };
}

/** Who acted on one arrival, as written and as decided. */
interface Answer {
  actor: PlatformActor | undefined;
  addressMatch?: AddressMatch;
  failed: boolean;
}

async function answerFor(
  arrival: Exclude<Arrival, { gone: true }>,
  input: { team: TeamId; adapterType: string; module: () => Promise<Adapter> },
): Promise<Answer> {
  const asked = await ask(input.module, input.adapterType, arrival);
  if ('failed' in asked) logger.warn(`[Actor] ${input.adapterType}: who acted on ${arrival.edge} could not be looked up: ${asked.failed}`);
  const identity = identityOf(arrival.actor, 'candidates' in asked ? asked.candidates : []);
  const normalised = identity === undefined ? null : normalisedActor(identity.written);
  if (identity === undefined || normalised === null) return { actor: undefined, failed: 'failed' in asked };
  const user = await originatorTeamUser({ teamId: input.team, candidates: [{ identity: identity.lookedUp, source: 'originator' }] });
  if (user === null) return { actor: { ...normalised, Member: false }, failed: 'failed' in asked };
  // Naming a user and calling them a member share one condition, so no
  // reader sees `User` beside a `Member` that is false.
  const actor: PlatformActor = normalised.Proven ? { ...normalised, Member: true, User: user.id } : { ...normalised, Member: false };
  return { actor, addressMatch: { user: user.id, vouched: normalised.Proven }, failed: 'failed' in asked };
}

function written(arrival: Exclude<Arrival, { gone: true }>, answer: Answer): { arrival: Arrival; decision: ActorDecision } {
  // Only what the platform wrote is who acted: an `Actor` a body passed
  // through is text anyone could have sent.
  const { [ACTOR]: _carried, ...fields } = arrival.landing.fields;
  // A lookup that failed writes what it has and names `Actor` unread, so a
  // filter reading it lands as `Arrival Not Judged` rather than as a non
  // match, and a listen with no such filter still fires.
  const unknown = answer.failed ? [...new Set([...(arrival.landing.unknown ?? []), ACTOR])] : arrival.landing.unknown;
  const decision: ActorDecision = answer.failed ? { kind: 'unknown' } : answer.actor !== undefined ? { kind: 'written', actor: answer.actor, ...(answer.addressMatch !== undefined ? { addressMatch: answer.addressMatch } : {}) } : { kind: 'nobody' };
  return {
    arrival: {
      ...arrival,
      landing: {
        ...arrival.landing,
        fields: answer.actor !== undefined ? { ...fields, [ACTOR]: answer.actor } : fields,
        ...(unknown !== undefined ? { unknown } : {}),
      },
    },
    decision,
  };
}

/** The key one person's answer is kept under for a delivery, so a page they
 *  wrote all of asks the module and the team's users once. */
function personKey(arrival: Exclude<Arrival, { gone: true }>): string | undefined {
  return arrival.actor === undefined ? undefined : JSON.stringify([arrival.actor.adapterType ?? null, arrival.actor.identifier]);
}

/**
 * Each arrival of a delivery from `adapter`'s module with `Actor` written
 * into its landing's fields, before it is judged, and what was decided for
 * it: the one step every door, a replay and a Run now take, since judging is
 * synchronous. Nothing is asked of anyone for a module that reports nobody,
 * nor unless a listen on the delivery's connection was saved from a text that
 * says `Actor`, its automation's fire statement is not anyone, or a run whose
 * automation's text says `Actor` waits on the arrival's edge. A database that
 * cannot answer fails the caller, so the delivery is tried again.
 */
export async function withActors(
  arrivals: readonly Arrival[],
  input: { team: TeamId; listens: readonly SavedListen[]; adapter: DeliveredBy },
): Promise<{ arrivals: Arrival[]; actors: ActorDecision[] }> {
  const { team, adapter } = input;
  const unchanged = { arrivals: [...arrivals], actors: arrivals.map((): ActorDecision => ({ kind: 'unneeded' })) };
  // A module the platform knows of that reports nobody is never asked; one
  // installed remotely is known only by asking it.
  const methods = getAdapterManifest(adapter.adapterType)?.methods;
  if (methods !== undefined && !reportsWhoActed(methods)) return unchanged;
  const live = arrivals.flatMap((arrival) => ('gone' in arrival ? [] : [arrival]));
  if (live.length === 0) return unchanged;
  // A connection's delivery is its own listens', as the judge hears it.
  const listens = input.listens.filter((listen) => adapter.credentialsId === null || listen.credentialsId === null || listen.credentialsId === adapter.credentialsId);
  const everyArrival = listens.some((listen) => listen.readsActor === true) || fireStatementNeedsActor(listens);
  const waited = everyArrival ? new Set<string>() : await edgesWaitedOnForActor({ team, adapterType: adapter.adapterType, edges: [...new Set(live.map((arrival) => arrival.edge))] });
  if (!everyArrival && waited.size === 0) return unchanged;

  let resolved: Promise<Adapter> | undefined;
  const module = () =>
    (resolved ??= resolveAdapter({ adapterType: adapter.adapterType, teamId: team, ...(adapter.credentialsId !== null ? { credentialsId: adapter.credentialsId } : {}) }));
  const answers = new Map<string, Promise<Answer>>();
  const out: Arrival[] = [];
  const actors: ActorDecision[] = [];
  for (const arrival of arrivals) {
    if ('gone' in arrival || (!everyArrival && !waited.has(arrival.edge))) {
      out.push(arrival);
      actors.push({ kind: 'unneeded' });
      continue;
    }
    if (moduleOwnsActor(listens, arrival.landing)) {
      sayKept(adapter.adapterType, arrival.landing.recordType ?? arrival.edge);
      out.push(arrival);
      actors.push({ kind: 'module' });
      continue;
    }
    const key = personKey(arrival);
    let answer = key === undefined ? undefined : answers.get(key);
    if (answer === undefined) {
      answer = answerFor(arrival, { team, adapterType: adapter.adapterType, module });
      if (key !== undefined) answers.set(key, answer);
    }
    const done = written(arrival, await answer);
    out.push(done.arrival);
    actors.push(done.decision);
  }
  return { arrivals: out, actors };
}
