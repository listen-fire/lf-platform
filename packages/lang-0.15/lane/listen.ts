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
import { listenPlanSchema, memberPlans, triggerEventSchema, type ListenPlan, type PlanHop } from '@listen-fire/engine-contracts';
import {
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

/** A 0.15 file's listens as its own check plans them, each the config its
 *  trigger row keeps; one the platform would not fire as written is refused
 *  by name. A text 0.15 cannot read has its refusal instead. */
export async function planListens(
  request: CheckRequest & { file: string },
): Promise<{ ok: true; listens: ListenConfig[]; refused: string[] } | { ok: false; refused: string }> {
  const read = await readProgram(request);
  if (!read.readable) return { ok: false, refused: read.refusal.message };
  const { program, teamCatalog } = read;
  const snapshot = teamCatalog.snapshot;
  const answer = checkAnswerInRust(request.source, snapshot, { languageVersion: request.pin });
  const planned = plannedListensOf({ file: request.file, program, plans: listenPlansOf(answer) });
  const listens: ListenConfig[] = [];
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
    listens.push({
      pipeline: listen.pipeline,
      plan: listen.plan,
      ...(listen.credentialName !== undefined ? { credentialName: listen.credentialName } : {}),
      ...(listen.constructionArgs !== undefined ? { constructionArgs: listen.constructionArgs } : {}),
      awaits: triggerAwaitsOf({ program, stamps: answer.stamps, plan: listen.plan }),
      fieldIds: fieldIdsOf(schema),
      ...(landing !== undefined ? { landing } : {}),
      ...listenShapeOf(schema, listen.plan),
    });
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
   *  shape, as JSON. */
  receipts: { triggerId: string; event: Record<string, unknown> }[];
  /** 0.15 parks on waits, never on keys: always empty. */
  wakeKeys: string[];
  /** Why an arrival ran nothing, for the log. */
  lines: string[];
}

/** Reads what the door kept with 0.15's own module and judges each arrival
 *  with 0.15's own judge against the 0.15 rows handed in. A module's failure
 *  throws: the platform's row retries. */
export async function readDelivery(request: ReadDeliveryRequest, modules: ModulePlatform): Promise<ReadDeliveryOutcome> {
  const { teamId, adapterType, delivery } = request;
  const lines: string[] = [];
  const listens = request.listens.flatMap((row) => {
    const parsed = listenConfigSchema.safeParse(row.config);
    if (!parsed.success) return [];
    if (request.matchAnyCredential !== true && row.credentialsId !== null && row.credentialsId !== request.credentialsId) return [];
    return [{ row, listen: parsed.data.listen }];
  });
  if (listens.length === 0) return { receipts: [], wakeKeys: [], lines };
  const adapter = await moduleTable(modules).resolve(adapterType, { teamId, ...(request.credentialsId !== null ? { credentialsId: request.credentialsId } : {}) });
  if (adapter.preprocessInbound === undefined) {
    lines.push(`${adapterType} under 0.15 reads no delivery: nothing in it is judged under 0.15`);
    return { receipts: [], wakeKeys: [], lines };
  }
  const read = await adapter.preprocessInbound({ raw: bodyOf(delivery), ...(delivery.checkpoint !== undefined ? { checkpoint: delivery.checkpoint } : {}) });
  const now = new Date(request.now);
  const receipts: ReadDeliveryOutcome['receipts'] = [];
  for (const arrival of read.arrivals ?? []) {
    if ('gone' in arrival) continue;
    for (const { row, listen } of listens) {
      const named = namedArrival(arrival, listen.fieldIds);
      const verdict = listenFires(listen, named, { adapterType }, now.getTime());
      if (verdict === null) continue;
      if ('undecided' in verdict) {
        lines.push(`${listen.pipeline}: undecided under 0.15 (${verdict.undecided}): it runs nothing`);
        continue;
      }
      if (!('fires' in verdict)) continue;
      const event = arrivalTriggerOf({ pipelineInputId: listen.pipeline, adapterType, arrival, now });
      receipts.push({ triggerId: row.id, event: JSON.parse(JSON.stringify(event)) });
    }
  }
  return { receipts, wakeKeys: [], lines };
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
