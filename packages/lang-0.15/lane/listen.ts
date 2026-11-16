// 0.15's half of a listen: how its check plans one (the trigger row the
// platform keeps for it is that plan, in 0.15's own listen-config shape), and
// how a delivery the one door kept is read by 0.15's own module and judged by
// 0.15's own judge against the rows pinned to 0.15. The planning is
// production's at 0.15.3 (`movement/listen_plans.ts` before 0.16), on 0.15's
// packages. A row's plan is read only with 0.15's own plan schema: a plan of
// another release is not a 0.15 listen.
//
// The door verified the delivery and kept it whole; 0.15's module reads it
// again here, so its arrivals carry what 0.15's module says of them (who
// acted, among it), which the old Slack gate asks.

import { z } from 'zod';
import { WireArrival, listenPlanSchema, memberPlans, triggerEventSchema, type Arrival, type ListenPlan, type PlanHop, type Verdict } from '@listen-fire/engine-contracts';
import {
  arrivalReceiptKey,
  arrivalTriggerOf,
  fieldIdsOf,
  landingNode,
  listenFires,
  listenPlansOf,
  listenSchemaOf,
  namedArrival,
  plannedListensOf,
  triggerAwaitsOf,
} from '@listen-fire/engine/public/inbound';
import { checkAnswerInRust, type EdgeListening, type InstanceSchema } from '@listen-fire/movement-lang';

import { readProgram } from './check';
import { movementWriteRunMode } from './run_mode';
import { manifestsOf } from './manifests';
import { moduleTable } from './modules';
import type { ModulePlatform } from './run_types';
import type { CheckRequest } from './types';

const landingSchema = z.union([z.object({ declared: z.unknown() }), z.object({ unread: z.string() })]);
const deliveryKindSchema = z.enum(['connection', 'scope', 'polled']);
const listenDeliverySchema = z.object({
  kind: deliveryKindSchema,
  pollEverySeconds: z.number().positive().optional(),
  scopedBy: z.string().optional(),
});
const resolvedHopSchema = z.object({
  hop: z.number().int().nonnegative(),
  membersChange: z.union([z.literal('pushed'), z.object({ relistEverySeconds: z.number().positive() })]).optional(),
  delivery: deliveryKindSchema.optional(),
});

/** What the platform keeps on a 0.15 listen's trigger row (`trigger.config`),
 *  as production kept it at 0.15.3: the plan 0.15's check made, its pipeline,
 *  its connection's construction, the edges its fired function awaits, the
 *  field ids its records are read by, the node it states its landing is, and
 *  how its last edge is delivered. */
export const listenConfigSchema = z.object({
  listen: z.object({
    pipeline: z.string(),
    plan: listenPlanSchema,
    credentialName: z.string().optional(),
    constructionArgs: z.record(z.string(), z.string()).optional(),
    awaits: z.object({ own: z.array(z.string()), carried: z.record(z.string(), z.array(z.string()).readonly()).readonly() }),
    fieldIds: z.record(z.string(), z.record(z.string(), z.string())),
    landing: landingSchema.optional(),
    delivery: listenDeliverySchema.optional(),
    resolvedHops: z.array(resolvedHopSchema).optional(),
    members: z.array(z.object({ delivery: listenDeliverySchema.optional(), resolvedHops: z.array(resolvedHopSchema).optional() })).optional(),
  }),
});
export type ListenConfig = z.infer<typeof listenConfigSchema>['listen'];
type ResolvedHop = z.infer<typeof resolvedHopSchema>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why the platform would not fire `plan` as written: a hop the host lists the
 *  members of, whose edge the traversal's last edge does not carry. */
function unfiredHere(plan: ListenPlan): string | null {
  const unlisted = memberPlans(plan).flatMap((traversal) =>
    traversal.hops.filter((hop) => hop.judged === 'resolved' && !(traversal.carries ?? []).includes(hop.edge)).map((hop) => `\`${hop.edge}\``),
  );
  if (unlisted.length === 0) return null;
  return `the listen that fires ${plan.movement} filters ${[...new Set(unlisted)].join(', ')} by a WHERE its module's arrivals do not carry the record for: this host cannot judge it, and would fire under every one. Filter that hop on the landing's fields instead`;
}

function declaredEdge(schema: InstanceSchema | undefined, hop: PlanHop): EdgeListening | undefined {
  if (schema === undefined) return undefined;
  return hop.from === '' ? schema.collections[hop.edge] : schema.positions[hop.from]?.edges[hop.edge];
}

function deliveryOf(schema: InstanceSchema | undefined, traversal: ListenPlan): ListenConfig['delivery'] {
  const last = traversal.hops.at(-1);
  if (last === undefined) return undefined;
  const declared = declaredEdge(schema, last);
  if (declared?.delivery === undefined) return undefined;
  return {
    kind: declared.delivery,
    ...(declared.pollEverySeconds !== undefined ? { pollEverySeconds: declared.pollEverySeconds } : {}),
    ...(declared.scopedBy !== undefined ? { scopedBy: declared.scopedBy } : {}),
  };
}

function resolvedHopsOf(schema: InstanceSchema | undefined, traversal: ListenPlan): ResolvedHop[] {
  return traversal.hops.flatMap((hop, index): ResolvedHop[] => {
    if (hop.judged !== 'resolved') return [];
    const declared = declaredEdge(schema, hop);
    return [
      {
        hop: index,
        ...(declared?.membersChange !== undefined ? { membersChange: declared.membersChange } : {}),
        ...(declared?.delivery !== undefined ? { delivery: declared.delivery } : {}),
      },
    ];
  });
}

function listenShapeOf(schema: InstanceSchema | undefined, plan: ListenPlan): Pick<ListenConfig, 'delivery' | 'resolvedHops' | 'members'> {
  const shapeOf = (traversal: ListenPlan): { delivery?: ListenConfig['delivery']; resolvedHops?: ResolvedHop[] } => {
    const delivery = deliveryOf(schema, traversal);
    const resolvedHops = resolvedHopsOf(schema, traversal);
    return { ...(delivery !== undefined ? { delivery } : {}), ...(resolvedHops.length > 0 ? { resolvedHops } : {}) };
  };
  if (plan.members === undefined) return shapeOf(plan);
  return { members: memberPlans(plan).map(shapeOf) };
}

/** One listen as 0.15's check plans it: the config its trigger row keeps, and
 *  the dry_run⇄live axis its fired function's writes imply. */
export interface PlannedListen {
  listen: ListenConfig;
  textRunMode: 'live' | 'dry_run';
}

/** A file's listens as 0.15 plans them, or the refusal of a text it cannot
 *  read. */
export type PlannedListens = { ok: true; listens: PlannedListen[]; refused: string[] } | { ok: false; refused: string };

/** A 0.15 file's listens as its own check plans them; one the platform would
 *  not fire as written is refused by name. A text 0.15 cannot read has its
 *  refusal instead. */
export async function planListens(request: CheckRequest & { file: string }): Promise<PlannedListens> {
  const read = await readProgram(request);
  if (!read.readable) return { ok: false, refused: read.refusal.message };
  const { program, teamCatalog } = read;
  const snapshot = teamCatalog.snapshot;
  const answer = checkAnswerInRust(request.source, snapshot, { languageVersion: request.pin });
  const planned = plannedListensOf({ file: request.file, program, plans: listenPlansOf(answer) });
  // A movement whose writes are mixed runs live: the engine takes one switch.
  const textRunModeOf = (movement: string): PlannedListen['textRunMode'] =>
    movementWriteRunMode({ program, movement, pin: request.pin }).mode === 'dry_run' ? 'dry_run' : 'live';
  const listens: PlannedListen[] = [];
  const refused: string[] = [];
  for (const listen of planned) {
    const why = unfiredHere(listen.plan);
    if (why !== null) {
      refused.push(why);
      continue;
    }
    const { landing: node } = listen.plan;
    let landing: ListenConfig['landing'];
    if (node !== undefined) {
      try {
        landing = landingNode({ source: request.source, node });
      } catch (error) {
        landing = { unread: messageOf(error) };
      }
    }
    const schema = listenSchemaOf(snapshot.adapters[listen.plan.adapter], listen);
    const config: ListenConfig = {
      pipeline: listen.pipeline,
      plan: listen.plan,
      ...(listen.credentialName !== undefined ? { credentialName: listen.credentialName } : {}),
      ...(listen.constructionArgs !== undefined ? { constructionArgs: listen.constructionArgs } : {}),
      awaits: triggerAwaitsOf({ program, stamps: answer.stamps, plan: listen.plan }),
      fieldIds: fieldIdsOf(schema),
      ...(landing !== undefined ? { landing } : {}),
      ...listenShapeOf(schema, listen.plan),
    };
    listens.push({ listen: config, textRunMode: textRunModeOf(listen.plan.movement) });
  }
  return { ok: true, listens, refused };
}

/** Whether a kept row is a 0.15 listen: its config reads as 0.15's own. */
export function isListenRow(row: { config: unknown }): boolean {
  return listenConfigSchema.safeParse(row.config).success;
}

/** The body as the door read it: a form's fields (a field sent more than once
 *  is the list of its values), else JSON. */
function bodyOf(delivery: { body: string; contentType?: string }): unknown {
  const text = Buffer.from(delivery.body, 'base64').toString('utf-8');
  if (delivery.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return JSON.parse(text);
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(text)) {
    const held = fields[name];
    fields[name] = held === undefined ? value : Array.isArray(held) ? [...held, value] : [held, value];
  }
  return fields;
}

export interface ListenRow {
  id: string;
  credentialsId: string | null;
  config: unknown;
}

export interface ReadDeliveryRequest {
  teamId: string;
  adapterType: string;
  credentialsId: string | null;
  /** A shared bot hears every team's messages: a listen's own credential is
   *  what it sends with, not a gate on what it hears. */
  matchAnyCredential?: boolean;
  delivery: { body: string; contentType?: string; checkpoint?: unknown };
  listens: readonly ListenRow[];
  now: string;
}

export interface ReadDeliveryOutcome {
  /** One per listen an arrival fired: the event its run is handed, in 0.15's
   *  shape, as JSON, and what names the arrival it fired on (its edge,
   *  identity and version), so a page judged again keeps one receipt. */
  receipts: { triggerId: string; event: Record<string, unknown>; arrivalKey: string }[];
  /** Why an arrival ran nothing, for the log. */
  lines: string[];
  /** The edges of the arrivals it read, fired or not: an arrival on a listed
   *  hop's edge whose members' changes are pushed lists its listen again. */
  edges: string[];
}

/** The rows handed in that are 0.15 listens on the delivery's connection.
 *  `installHeard`: a delivery for no connection is the module's install's,
 *  which serves every connection (a page a door built). */
function listensHearing(
  request: Pick<ReadDeliveryRequest, 'listens' | 'credentialsId' | 'matchAnyCredential'>,
  options: { installHeard: boolean },
): { row: ListenRow; listen: ListenConfig }[] {
  const everyConnection = request.matchAnyCredential === true || (options.installHeard && request.credentialsId === null);
  return request.listens.flatMap((row) => {
    const parsed = listenConfigSchema.safeParse(row.config);
    if (!parsed.success) return [];
    if (!everyConnection && row.credentialsId !== null && row.credentialsId !== request.credentialsId) return [];
    return [{ row, listen: parsed.data.listen }];
  });
}

/** Each arrival judged by 0.15's own judge against each listen, in the order
 *  they came. */
function judged(input: { listens: readonly { row: ListenRow; listen: ListenConfig }[]; arrivals: readonly Arrival[]; adapterType: string; now: Date }): ReadDeliveryOutcome {
  const { adapterType, now } = input;
  const lines: string[] = [];
  const receipts: ReadDeliveryOutcome['receipts'] = [];
  const edges = new Set<string>();
  for (const arrival of input.arrivals) {
    if ('gone' in arrival) continue;
    edges.add(arrival.edge);
    for (const { row, listen } of input.listens) {
      const named = namedArrival(arrival, listen.fieldIds);
      const verdict = listenFires(listen, named, { adapterType }, now.getTime());
      if (verdict === null) continue;
      if ('undecided' in verdict) {
        lines.push(`${listen.pipeline}: undecided under 0.15 (${verdict.undecided}): it runs nothing`);
        continue;
      }
      if (!('fires' in verdict)) continue;
      const event = arrivalTriggerOf({ pipelineInputId: listen.pipeline, adapterType, arrival, now });
      receipts.push({ triggerId: row.id, event: JSON.parse(JSON.stringify(event)), arrivalKey: arrivalReceiptKey(arrival) });
    }
  }
  return { receipts, lines, edges: [...edges] };
}

/** What the door kept, read again by 0.15's own module; a module that reads
 *  no delivery says so. A module's failure throws. */
async function arrivalsOfDelivery(
  request: Pick<ReadDeliveryRequest, 'teamId' | 'adapterType' | 'credentialsId' | 'delivery'>,
  modules: ModulePlatform,
): Promise<{ arrivals: readonly Arrival[] } | { unread: string }> {
  const { teamId, adapterType, delivery } = request;
  const adapter = await moduleTable(modules).resolve(adapterType, { teamId, ...(request.credentialsId !== null ? { credentialsId: request.credentialsId } : {}) });
  if (adapter.preprocessInbound === undefined) return { unread: `${adapterType} under 0.15 reads no delivery` };
  const read = await adapter.preprocessInbound({ raw: bodyOf(delivery), ...(delivery.checkpoint !== undefined ? { checkpoint: delivery.checkpoint } : {}) });
  return { arrivals: read.arrivals ?? [] };
}

/** Reads what the door kept with 0.15's own module and judges each arrival
 *  with 0.15's own judge against the 0.15 rows handed in. A module's failure
 *  throws: the platform's row retries. */
export async function readDelivery(request: ReadDeliveryRequest, modules: ModulePlatform): Promise<ReadDeliveryOutcome> {
  const listens = listensHearing(request, { installHeard: false });
  if (listens.length === 0) return { receipts: [], lines: [], edges: [] };
  const read = await arrivalsOfDelivery(request, modules);
  if ('unread' in read) return { receipts: [], lines: [`${read.unread}: nothing in it is judged under 0.15`], edges: [] };
  return judged({ listens, arrivals: read.arrivals, adapterType: request.adapterType, now: new Date(request.now) });
}

export interface JudgePageRequest extends Omit<ReadDeliveryRequest, 'delivery'> {
  /** The arrivals a door built itself (an email, a WhatsApp message, an ask's
   *  answer, a remote module's push, a poll 0.15's module answered), as plain
   *  data: 0.15 reads each with its own arrival schema. */
  page: readonly unknown[];
}

/** A page of arrivals the platform's door built, each read with 0.15's own
 *  arrival schema and judged by 0.15's own judge against the 0.15 rows handed
 *  in. One 0.15 cannot read runs nothing, said by line. */
export function judgePage(request: JudgePageRequest): ReadDeliveryOutcome {
  const listens = listensHearing(request, { installHeard: true });
  if (listens.length === 0) return { receipts: [], lines: [], edges: [] };
  const lines: string[] = [];
  const arrivals = request.page.flatMap((element): Arrival[] => {
    const read = WireArrival.safeParse(element);
    if (read.success) return [read.data];
    lines.push(`${request.adapterType}: an arrival 0.15 does not read runs nothing under 0.15 (${read.error.issues[0]?.message ?? 'invalid'})`);
    return [];
  });
  const outcome = judged({ listens, arrivals, adapterType: request.adapterType, now: new Date(request.now) });
  return { ...outcome, lines: [...lines, ...outcome.lines] };
}

/** One event of a kept delivery or of a page a door built. `arrivalIndex`
 *  counts among the arrivals 0.15's own module reads from the delivery, in the
 *  order it reads them (a page's, as the door built it): 0.15 reads the
 *  delivery itself, never the current release's reading of it. `brought`: the
 *  receipt keys of the events the delivery was kept with, in the order the
 *  person counting them sees (a page counts its own). */
export interface JudgeEventRequest extends Omit<ReadDeliveryRequest, 'delivery'> {
  kept: { delivery: ReadDeliveryRequest['delivery']; brought?: readonly string[] } | { page: readonly unknown[] };
  arrivalIndex: number;
}

/** An arrival that brought a record, not word that one went. */
type PresentArrival = Exclude<Arrival, { gone: true }>;

/** The arrival at `arrivalIndex` of those 0.15's module read, when it is
 *  surely the event the delivery was kept with at that place: the two count
 *  as many, and, of several, the one there has that place's receipt key. 0.15
 *  never reads another release's events, so a delivery it reads otherwise
 *  than it was kept is refused, never guessed at. */
export function eventAt(input: { present: readonly Arrival[]; brought?: readonly string[]; arrivalIndex: number }): { arrival: PresentArrival } | { refused: string } {
  const { present, brought, arrivalIndex } = input;
  if (brought !== undefined && brought.length !== present.length) {
    return { refused: `the delivery was kept with ${brought.length} events and 0.15's module reads ${present.length} from it: which is event ${arrivalIndex} cannot be told under 0.15` };
  }
  const arrival = present[arrivalIndex];
  if (arrival === undefined || 'gone' in arrival) {
    return { refused: `the delivery brought no event at ${arrivalIndex} that 0.15 can judge (0.15's module reads ${present.length} from it)` };
  }
  if (brought !== undefined && present.length > 1 && arrivalReceiptKey(arrival) !== brought[arrivalIndex]) {
    return { refused: `0.15's module reads another event at ${arrivalIndex} than the one the delivery was kept with there: it cannot be told under 0.15` };
  }
  return { arrival };
}

/** What 0.15's judge makes of an event for one listen: it fires; it fails the
 *  filter of a hop (on `edge`), or, with a `reason`, the record it carries
 *  there is of another type; or it cannot tell, and says why. */
export type EventVerdict = { kind: 'fires' } | { kind: 'skips'; edge?: string; reason?: string } | { kind: 'undecided'; reason: string };

/** One row's part in an event: not its to judge (another edge, another
 *  connection), or its judge's verdict and the event its run is handed, in
 *  0.15's shape, as JSON. */
export type JudgedListen = { triggerId: string; heard: false } | { triggerId: string; heard: true; verdict: EventVerdict; event: Record<string, unknown> };

export type JudgedEvent = { ok: true; edge: string; listens: JudgedListen[] } | { ok: false; refused: string };

function verdictOf(plan: ListenPlan, verdict: Verdict): EventVerdict {
  if ('fires' in verdict) return { kind: 'fires' };
  if ('skips' in verdict) {
    const edge = plan.hops[verdict.skips]?.edge;
    return { kind: 'skips', ...(edge !== undefined ? { edge } : {}), ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) };
  }
  return { kind: 'undecided', reason: verdict.undecided };
}

/** One event read again by 0.15's own module (a page's, with 0.15's own
 *  arrival schema) and judged by 0.15's own judge against each 0.15 row handed
 *  in, as a reading of the delivery judged it: what a person asking why it did
 *  not fire is told, and what a run vouched for is handed. A row that is not a
 *  0.15 listen is left out. A module's failure throws. */
export async function judgeEvent(request: JudgeEventRequest, modules: ModulePlatform): Promise<JudgedEvent> {
  const { adapterType, arrivalIndex, kept } = request;
  let found: PresentArrival;
  if ('page' in kept) {
    const element = kept.page[arrivalIndex];
    const read = element === undefined ? undefined : WireArrival.safeParse(element);
    if (read !== undefined && !read.success) return { ok: false, refused: `event ${arrivalIndex} is not an arrival 0.15 reads (${read.error.issues[0]?.message ?? 'invalid'})` };
    if (read === undefined || 'gone' in read.data) return { ok: false, refused: `the page brought no event at ${arrivalIndex} that 0.15 can judge (it brought ${kept.page.length})` };
    found = read.data;
  } else {
    const read = await arrivalsOfDelivery({ ...request, delivery: kept.delivery }, modules);
    if ('unread' in read) return { ok: false, refused: `${read.unread}: its events cannot be judged under 0.15` };
    const at = eventAt({ present: read.arrivals.filter((candidate) => !('gone' in candidate)), ...(kept.brought !== undefined ? { brought: kept.brought } : {}), arrivalIndex });
    if ('refused' in at) return { ok: false, refused: at.refused };
    found = at.arrival;
  }
  const now = new Date(request.now);
  const hearing = new Map(listensHearing(request, { installHeard: 'page' in kept }).map((heard) => [heard.row.id, heard.listen]));
  const listens = request.listens.flatMap((row): JudgedListen[] => {
    if (!isListenRow(row)) return [];
    const listen = hearing.get(row.id);
    const verdict = listen === undefined ? null : listenFires(listen, namedArrival(found, listen.fieldIds), { adapterType }, now.getTime());
    if (listen === undefined || verdict === null) return [{ triggerId: row.id, heard: false }];
    const event: Record<string, unknown> = JSON.parse(JSON.stringify(arrivalTriggerOf({ pipelineInputId: listen.pipeline, adapterType, arrival: found, now })));
    return [{ triggerId: row.id, heard: true, verdict: verdictOf(listen.plan, verdict), event }];
  });
  return { ok: true, edge: found.edge, listens };
}

/** What the source module says of a firing before it runs: the old ownership
 *  gate, which 0.15's modules ask for in their manifests
 *  (`inboundRequiresRegisteredActor`), answered from who 0.15's module says
 *  sent the event. */
export type GateAnswer = { kind: 'suppress'; reason: string } | { kind: 'proceed' } | { kind: 'needs-actor'; candidates: unknown };

export async function gateFiring(
  request: { teamId: string; adapterType: string; credentialsId: string | null; config: unknown; event: Readonly<Record<string, unknown>> },
  modules: ModulePlatform,
): Promise<GateAnswer> {
  const { kgChangeWebhooks, whatsappNumber } = modules.parts;
  const manifest = manifestsOf({ kgChangeWebhooks, whatsappNumber, mcpEnabled: true }).find((candidate) => candidate.adapterType === request.adapterType);
  if (manifest?.inboundRequiresRegisteredActor !== true) return { kind: 'proceed' };
  const adapter = await moduleTable(modules).resolve(request.adapterType, {
    teamId: request.teamId,
    ...(request.credentialsId !== null ? { credentialsId: request.credentialsId } : {}),
  });
  if (adapter.getActorCandidates === undefined) return { kind: 'needs-actor', candidates: [] };
  return { kind: 'needs-actor', candidates: await adapter.getActorCandidates({ event: triggerEventSchema.parse(request.event) }) };
}
