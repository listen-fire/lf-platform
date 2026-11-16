// The platform's door onto listen-fire 0.13's listens. Every arrival a module
// reports (a webhook's, a poll's, an answer to an ask) is judged by the
// engine's judge against each listen its team saved on that module
// (`listenFires`, the records read by the names the program writes), a run is
// minted for each listen it fires, and the delivery is kept in one write with
// them: its arrivals logged (waking the waits parked on their records), a
// `fire_event` row per run and the waits each run opens on its trigger, and
// each listen that could not judge an arrival kept as an `Arrival Not Judged`
// fact. The `fire_event` row then starts its run under the listen's receipt.
//
// The sequence is @listen-fire/embed's `dispatch` (its order, not its
// package): the platform keeps its own run rows, catalogs and engine host.
// A saved listen is a trigger row (provision.ts): the projection of one
// planned listen, named by its pipeline `listen:<file>:<movement>:<digest>`.

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { z } from 'zod';
import { lastEdgeOf, listenPlanSchema, type Arrival, type AwaitHead, type AwaitLanding, type ListenPlan, type Verdict } from 'engine-contracts';
import {
  arrivalReceiptKey,
  arrivalTriggerOf,
  landingMisfits,
  listenFires,
  namedArrival,
  type DeclaredNode,
  type FieldIdsByType,
  type TriggerAwaits,
} from 'movement-engine/public/inbound';
import {
  DEFAULT_RESEND_WINDOW_MS,
  FIRE_EVENT_WORK_KIND,
  newArrivalsOf,
  type DeliverySource,
  type DeliveryWait,
  type KeptDelivery,
  type NewWorkRow,
} from 'movement-engine/public/run-host';
import { logger } from 'movement-engine/public/log';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { MovementId } from '../../generated/kysely/automations/Movement';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { UnjudgedArrival } from '../lf_store/records_door';
import type { Resolution } from '../lf_store/listens';

import { getAutomationsQb } from '../../lib/kysely';
import { getAdapterManifest } from '../translation_graph/adapters/registry';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { deliveryRowStore } from '../movement_engine/run_host_deliveries';
import { chainBefore, loopSettings } from './loop_breaker';
import { armResolveForArrivals, withWatching, withWatchingOne } from './listen_resolve';

// ── A saved listen, as its trigger row keeps it ─────────────────────────────

/** Where a listen's run reads the node its listen states its landing is, or
 *  why it cannot (a node the program imports from another file). */
const landingSchema = z.union([z.object({ declared: z.unknown() }), z.object({ unread: z.string() })]);

const deliveryKindSchema = z.enum(['connection', 'scope', 'polled']);

const listenDeliverySchema = z.object({
  kind: deliveryKindSchema,
  pollEverySeconds: z.number().positive().optional(),
  /** An edge pushed per scope whose subscription is made per record an
   *  earlier hop, this edge named, landed on (Airtable's `Changes`, per base:
   *  `Bases`), not per head. */
  scopedBy: z.string().optional(),
});

/** A hop of one traversal whose members the host lists (`judged:
 *  'resolved'`), by its place in the traversal, as its module declares its
 *  edge: how its members' changes are learnt, and how that edge's arrivals
 *  reach the host. */
const resolvedHopSchema = z.object({
  hop: z.number().int().nonnegative(),
  membersChange: z.union([z.literal('pushed'), z.object({ relistEverySeconds: z.number().positive() })]).optional(),
  delivery: deliveryKindSchema.optional(),
});

/** What provisioning keeps on a listen's trigger row (`trigger.config`): the
 *  plan the check made, its pipeline, its connection's construction, the
 *  edges its fired function awaits off what a delivery hands it, the field
 *  ids its records are read by, and the node it states its landing is. */
export const listenConfigSchema = z.object({
  listen: z.object({
    pipeline: z.string(),
    plan: listenPlanSchema,
    credentialName: z.string().optional(),
    constructionArgs: z.record(z.string(), z.string()).optional(),
    awaits: z.object({ own: z.array(z.string()), carried: z.record(z.string(), z.array(z.string()).readonly()).readonly() }),
    fieldIds: z.record(z.string(), z.record(z.string(), z.string())),
    landing: landingSchema.optional(),
    /** How its last edge's arrivals reach the host, as its module declares
     *  it: pushed to the connection or per scope, or polled every
     *  `pollEverySeconds` (poll_source/worker.ts). Absent when undeclared,
     *  and for a listen over a union, whose members say it each. */
    delivery: listenDeliverySchema.optional(),
    /** The hops of its own traversal whose members the host lists
     *  (listen_resolve.ts); absent for none, and for a listen over a union,
     *  whose members say it each. */
    resolvedHops: z.array(resolvedHopSchema).optional(),
    /** A listen over a union: how each member's last edge is delivered, off
     *  that member's record type, and the hops of it the host lists, in the
     *  order of its plan's `members`. */
    members: z.array(z.object({ delivery: listenDeliverySchema.optional(), resolvedHops: z.array(resolvedHopSchema).optional() })).optional(),
    /** The listen came up from a carried version by an upgrade: when (a delivery
     *  kept before it was that version's), and whether it polls on the cursor it
     *  brought rather than sharing a poll (inbound/listen_edge.ts). */
    carriedFrom: z.object({ at: z.string(), pollsAlone: z.boolean().optional() }).optional(),
  }),
});
export type ListenConfig = z.infer<typeof listenConfigSchema>['listen'];
export type ResolvedHop = z.infer<typeof resolvedHopSchema>;

/** One saved listen of a team: its trigger row and what it keeps. */
export interface SavedListen extends ListenConfig {
  triggerId: TriggerId;
  teamId: TeamId;
  /** The file (the movement row's name) the listen is in. */
  file: string;
  /** The connection's credential, as the team resolved its name at save. */
  credentialsId: string | null;
  /** A listen with a hop the host lists: what its last resolve came to, as
   *  the store keeps it (listen_resolve.ts). Absent for one never resolved,
   *  which is watched under no record, and for any other listen. */
  watching?: Resolution;
}

/** The listens `teamId` saved (on `adapterType`'s module, when it names one;
 *  in one file, when `movementId` does). A trigger row of another shape (a
 *  pin 1 to 4 listener) is not a listen and is skipped. */
export async function savedListens(input: { teamId: TeamId; adapterType?: string; movementId?: MovementId }): Promise<SavedListen[]> {
  let query = getAutomationsQb(['trigger', 'movement'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .where('trigger.team_id', '=', input.teamId);
  if (input.adapterType !== undefined) query = query.where('trigger.kind', '=', input.adapterType);
  if (input.movementId !== undefined) query = query.where('trigger.movement_id', '=', input.movementId);
  const rows = await query
    .select(['trigger.id as id', 'trigger.config as config', 'trigger.credentials_id as credentialsId', 'movement.name as file'])
    .execute();
  const listens = rows.flatMap((row) => {
    const parsed = listenConfigSchema.safeParse(row.config);
    if (!parsed.success) return [];
    return [{ ...parsed.data.listen, triggerId: row.id, teamId: input.teamId, file: row.file, credentialsId: row.credentialsId ?? null }];
  });
  return withWatching(listens);
}

/** The saved listen a trigger row is, or null when it is no listen. */
export async function savedListenOf(triggerId: TriggerId): Promise<SavedListen | null> {
  const row = await getAutomationsQb(['trigger', 'movement'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .where('trigger.id', '=', triggerId)
    .select(['trigger.id as id', 'trigger.team_id as teamId', 'trigger.config as config', 'trigger.credentials_id as credentialsId', 'movement.name as file'])
    .executeTakeFirst();
  if (row === undefined) return null;
  const parsed = listenConfigSchema.safeParse(row.config);
  if (!parsed.success) return null;
  // The row's team as the branded id the rest of the door carries (its boundary).
  return withWatchingOne({ ...parsed.data.listen, triggerId: row.id, teamId: row.teamId as TeamId, file: row.file, credentialsId: row.credentialsId ?? null });
}

// ── Judging a delivery's arrivals ───────────────────────────────────────────

/** A run an arrival fired: the listen, the arrival, its place in the
 *  delivery, the run's id and the receipt it runs under. */
export interface MintedRun {
  listen: SavedListen;
  arrival: Exclude<Arrival, { gone: true }>;
  index: number;
  runId: TriggerRunId;
  receipt: string;
}

/** Where a delivery came from: its module, and the connection it came for
 *  (null: the module's install, which serves every connection). */
export interface DeliveredBy {
  adapterType: string;
  credentialsId: string | null;
}

/** A listen that could not judge an arrival: the fact `unjudged.note` keeps
 *  (its delivery and the run that caused it are found as it is kept), and the
 *  listen and arrival that cause is found by. */
export interface Undecided {
  listen: SavedListen;
  arrival: Exclude<Arrival, { gone: true }>;
  fact: Omit<UnjudgedArrival, 'deliveryId' | 'cause'>;
}

export interface Judged {
  minted: MintedRun[];
  /** The listens that could not judge an arrival. */
  unjudged: Undecided[];
  /** What ran nothing, said once per delivery. */
  lines: string[];
}

/** What a vouched arrival is to a listen: it fires when it came on the listen's module and last edge, whatever its filter says. */
function vouchedVerdict(listen: SavedListen, arrival: Exclude<Arrival, { gone: true }>, adapterType: string): Verdict | null {
  return listen.plan.adapter === adapterType && lastEdgeOf(listen.plan) === arrival.edge ? { fires: true } : null;
}

/**
 * Each arrival judged against every listen of `listens` on its edge, in the
 * order the arrivals came. A listen on another connection than the delivery
 * names hears nothing of it. An undecided verdict runs nothing and is kept
 * as a fact; an arrival that does not fit the node its listen states runs
 * nothing, said when no other listen took it.
 */
export function judgeArrivals(input: {
  listens: readonly SavedListen[];
  delivery: DeliveredBy;
  arrivals: readonly Arrival[];
  now: Date;
  /** A replay judges by one listen alone, and its facts are this attempt. */
  attempt?: number;
  /** Someone with write on the automation vouches for the arrival: a listen
   *  on its edge fires without reading its filter, as a Run now's press does. */
  vouched?: boolean;
}): Judged {
  const { delivery, now } = input;
  const nowMs = now.getTime();
  const lines: string[] = [];
  const say = (line: string): void => {
    if (!lines.includes(line)) lines.push(line);
  };
  const minted: MintedRun[] = [];
  const unjudged: Judged['unjudged'] = [];
  for (const [index, arrival] of input.arrivals.entries()) {
    if ('gone' in arrival) continue;
    let taken = false;
    const misfitLines: string[] = [];
    for (const listen of input.listens) {
      // A connection's delivery is its own listens'; an install's is every one's.
      if (delivery.credentialsId !== null && listen.credentialsId !== null && listen.credentialsId !== delivery.credentialsId) continue;
      const heard = namedArrival(arrival, listen.fieldIds as FieldIdsByType);
      const verdict = input.vouched === true ? vouchedVerdict(listen, arrival, delivery.adapterType) : listenFires(
        { plan: listen.plan, pipeline: listen.pipeline, ...credentialOf(listen), ...(listen.constructionArgs !== undefined ? { constructionArgs: listen.constructionArgs } : {}) },
        heard,
        { adapterType: delivery.adapterType, ...credentialOf(listen) },
        nowMs,
      );
      if (verdict === null) continue;
      const named = `${listen.file}:${listen.plan.movement}`;
      if ('skips' in verdict) continue;
      if ('undecided' in verdict) {
        taken = true;
        say(`${named}: an arrival on ${arrival.edge} cannot be judged (${verdict.undecided}): it runs nothing`);
        unjudged.push({
          listen,
          arrival,
          fact: {
            pipeline: listen.pipeline,
            arrival: arrivalReceiptKey(arrival),
            file: listen.file,
            movement: listen.plan.movement,
            edge: arrival.edge,
            adapter: delivery.adapterType,
            recordId: arrival.landing.recordId ?? null,
            landing: arrival.landing,
            reason: verdict.undecided,
            at: now.toISOString(),
            attempt: input.attempt ?? 0,
          },
        });
        continue;
      }
      if (listen.landing !== undefined) {
        if ('unread' in listen.landing) {
          taken = true;
          say(`${named}: an arrival on ${arrival.edge} cannot be checked against the node its listen states (${listen.landing.unread}): it runs nothing`);
          continue;
        }
        const fit = landingMisfits({ ...(listen.landing as DeclaredNode), landing: heard.landing.fields });
        if (fit.misfits.length > 0) {
          misfitLines.push(`${named}: the arrival ${arrival.identity} on ${arrival.edge} is not a ${fit.node} (${fit.misfits.join('; ')}): it runs nothing`);
          continue;
        }
      }
      taken = true;
      minted.push({ listen, arrival, index, runId: randomUUID() as TriggerRunId, receipt: arrivalReceiptKey(arrival) });
    }
    if (!taken) for (const line of misfitLines) say(line);
  }
  return { minted, unjudged, lines };
}

/**
 * The facts of `undecided`, kept with the delivery `deliveryId`, each naming
 * the run whose write caused its arrival (the loop breaker's ledger, as a run
 * the arrival fired would continue that run's chain), else none. A ledger
 * that cannot answer fails the caller, so the delivery is tried again.
 */
export async function unjudgedFacts(input: {
  teamId: TeamId;
  undecided: readonly Undecided[];
  deliveryId: string;
  now: Date;
}): Promise<UnjudgedArrival[]> {
  const settings = loopSettings();
  const facts: UnjudgedArrival[] = [];
  for (const { listen, arrival, fact } of input.undecided) {
    const chain = await chainBefore({ teamId: input.teamId, listen, arrival, now: input.now, settings });
    facts.push({ ...fact, deliveryId: input.deliveryId, cause: chain.at(-1) ?? null });
  }
  return facts;
}

function credentialOf(listen: SavedListen): { credentialName?: string } {
  return listen.credentialName !== undefined ? { credentialName: listen.credentialName } : {};
}

// ── The waits a delivery opens for the runs it starts ───────────────────────

function headOf(landing: AwaitLanding | null | undefined): AwaitHead | undefined {
  if (landing === null || landing === undefined) return undefined;
  const { recordId, recordType, fields } = landing;
  if (recordId === undefined || recordId === '') return undefined;
  return { recordId, headData: fields, ...(recordType !== undefined && recordType !== '' ? { recordType } : {}) };
}

/**
 * The waits each minted run opens on the records a delivery hands it, as
 * listen-fire's door opens them: its trigger, on each edge its function
 * awaits off its parameter, and each record its arrival carries, on each
 * edge awaited off that record's type. Each keyed by the module's
 * `awaitKeys`, asked once per edge and connection. A wait on the trigger's
 * own edge and record has the trigger noted on it, so the arrival that
 * started a run never answers it.
 */
export async function deliveryWaitsOf(input: { teamId: TeamId; adapterType: string; minted: readonly MintedRun[] }): Promise<DeliveryWait[]> {
  const heads = new Map<string, AwaitHead>();
  const owed: Array<{ run: MintedRun; edge: string; credentialsId: string | null; head: string }> = [];
  for (const run of input.minted) {
    const awaits: TriggerAwaits = run.listen.awaits;
    const handed: Array<[string, AwaitHead | undefined, readonly string[]]> = [
      [`${run.index}`, headOf(run.arrival.landing), awaits.own],
      ...(run.arrival.parents ?? []).map((parent, place): [string, AwaitHead | undefined, readonly string[]] => [
        `${run.index}:${place}`,
        headOf(parent),
        (parent?.recordType !== undefined ? awaits.carried[parent.recordType] : undefined) ?? [],
      ]),
    ];
    for (const [at, head, edges] of handed) {
      if (head === undefined) continue;
      heads.set(at, head);
      for (const edge of edges) owed.push({ run, edge, credentialsId: run.listen.credentialsId, head: at });
    }
  }
  const groupOf = (credentialsId: string | null, edge: string) => JSON.stringify([credentialsId, edge]);
  type Asked = { credentialsId: string | null; edge: string; on: string[]; keys: Map<string, string | null> };
  const asked = new Map<string, Asked>();
  for (const { edge, credentialsId, head } of owed) {
    const group: Asked = asked.get(groupOf(credentialsId, edge)) ?? { credentialsId, edge, on: [], keys: new Map() };
    if (!group.on.includes(head)) group.on.push(head);
    asked.set(groupOf(credentialsId, edge), group);
  }
  for (const { credentialsId, edge, on, keys } of asked.values()) {
    const adapter = await resolveAdapter({
      adapterType: input.adapterType,
      teamId: input.teamId,
      ...(credentialsId !== null ? { credentialsId } : {}),
    });
    // A module that offers no `awaitKeys` opens no wait here.
    if (adapter.arrivals === undefined) continue;
    const answered = await adapter.arrivals.awaitKeys({ edge, heads: on.flatMap((head) => heads.get(head) ?? []) });
    if (answered.length !== on.length) throw new Error(`${input.adapterType}: awaitKeys answered ${answered.length} keys for ${on.length} heads`);
    on.forEach((head, i) => {
      const key = answered[i];
      keys.set(head, key === undefined || 'gone' in key ? null : key.key);
    });
  }
  const waits: DeliveryWait[] = [];
  for (const { run, edge, credentialsId, head } of owed) {
    const key = asked.get(groupOf(credentialsId, edge))?.keys.get(head);
    if (key === undefined) continue;
    if (waits.some((w) => w.runId === run.runId && w.edge === edge && w.key === key)) continue;
    const { arrival } = run;
    const own = key !== null && edge === arrival.edge && key === arrival.key;
    waits.push({
      runId: run.runId,
      edge,
      key,
      fireKey: fireKeyOf(run.runId),
      ...(own ? { preNoted: { identity: arrival.identity, version: arrival.version ?? null } } : {}),
    });
  }
  return waits;
}

// ── Keeping a judged delivery ───────────────────────────────────────────────

/** A `fire_event` row's payload: the run a delivery queued. */
export const fireRowSchema = z.object({
  teamId: z.string(),
  triggerId: z.string(),
  pipeline: z.string(),
  arrival: z.custom<Exclude<Arrival, { gone: true }>>((v) => typeof v === 'object' && v !== null && !('gone' in v)),
  runId: z.string(),
  receipt: z.string(),
  deliveryId: z.string(),
  /** Set by the store as it keeps the row: the mark before the delivery's arrivals. */
  arrivalMark: z.number().optional(),
  /** A replay forced past the listen's receipt runs under one of its own. */
  forced: z.boolean().optional(),
});
export type FireRow = z.infer<typeof fireRowSchema>;

export function fireKeyOf(runId: string): string {
  return `fire_event:${runId}`;
}

/**
 * Keep a delivery whose arrivals were judged, in one write: its receipt
 * (a redelivery under the same external id keeps nothing), its arrivals
 * logged under the module's re-send window, a `fire_event` row and the
 * trigger waits per minted run, and the facts of the listens that could not
 * judge it. A run's row is due at once: nothing on this host starts a run
 * inline (as listen-fire's door does, leaving its row as the fallback), so
 * the drain is the starter, and the row's lease is what takes it again from
 * a process that died holding it.
 */
export async function keepJudgedDelivery(input: {
  teamId: TeamId;
  subscriptionId: string;
  adapterType: string;
  externalId: string | null;
  source: DeliverySource;
  arrivals: readonly Arrival[];
  judged: Judged;
  checkpoint?: unknown;
  /** The request it was received as (redacted), for a replay. */
  request?: unknown;
  /** A replay of this delivery through one listen: its arrivals were logged
   *  with the delivery it replays, so none is logged again, and a listen
   *  that still cannot judge one is a fact of the delivery replayed. */
  replayOf?: string;
  /** A replay forced past its listen's receipt. */
  forced?: boolean;
  /** The row the door kept before reading it (carried_delivery.ts). */
  rawKeptId?: string;
  /** The connection it was kept for: a replay carries its original's. */
  credentialsId?: string | null;
  now: Date;
}): Promise<{ kept: KeptDelivery; deliveryId: string; fires: FireRow[] }> {
  const { teamId, judged, now } = input;
  const deliveryId = input.rawKeptId ?? randomUUID();
  const waits = await deliveryWaitsOf({ teamId, adapterType: input.adapterType, minted: judged.minted });
  const fires: FireRow[] = judged.minted.map((run) => ({
    teamId,
    triggerId: run.listen.triggerId,
    pipeline: run.listen.pipeline,
    arrival: run.arrival,
    runId: run.runId,
    receipt: run.receipt,
    deliveryId,
    ...(input.forced === true ? { forced: true } : {}),
  }));
  const resendSeconds = getAdapterManifest(input.adapterType)?.resendWindowSeconds;
  const kept = await deliveryRowStore({ host: 'platform', teamId }).keepDelivery({
    subscriptionId: input.subscriptionId,
    ...(input.rawKeptId !== undefined ? { rawKept: { id: input.rawKeptId } } : {}),
    credentialsId: input.credentialsId ?? null,
    ...('checkpoint' in input ? { checkpoint: input.checkpoint } : {}),
    delivery: {
      id: deliveryId,
      externalId: input.externalId,
      receivedAt: now.toISOString(),
      source: input.source,
      inline: false,
      events: [],
      ...(input.replayOf !== undefined ? { replayOf: input.replayOf } : {}),
      ...(input.request !== undefined ? { request: input.request } : {}),
    },
    work: fires.map((fire): NewWorkRow => ({ kind: FIRE_EVENT_WORK_KIND, key: fireKeyOf(fire.runId), payload: fire, teamId })),
    arrivals: {
      teamId,
      adapterType: input.adapterType,
      arrivals: input.replayOf !== undefined ? [] : newArrivalsOf(input.arrivals),
      at: now.toISOString(),
      resendWindowMs: resendSeconds !== undefined ? resendSeconds * 1000 : DEFAULT_RESEND_WINDOW_MS,
    },
    waits,
    unjudged: await unjudgedFacts({ teamId, undecided: judged.unjudged, deliveryId: input.replayOf ?? deliveryId, now }),
  });
  if (kept.kept) for (const line of judged.lines) logger.warn(`[ListenDoor] ${line}`);
  return { kept, deliveryId, fires };
}

// ── A queued run's receipt ──────────────────────────────────────────────────

/** How a `fire_event` row's run stands against its listen's receipt. */
export type ReceiptClaim =
  /** The receipt is this run's, and its row is queued: run it. */
  | { kind: 'run' }
  /** Another run of the listen ran the arrival before: run nothing. */
  | { kind: 'ran_before' }
  /** This run is in hand already (a row taken again after it started). */
  | { kind: 'in_hand' };

/** The receipt a run of `fire` runs under: a forced replay's is its own. */
function receiptKeyOf(fire: FireRow): string {
  return fire.forced === true ? `${fire.receipt}#${fire.runId}` : fire.receipt;
}

/**
 * The receipt `(team, listen, arrival)` and the run's queued row, as one
 * write: the first run of an arrival by a listen takes it, and a redelivery,
 * or a drain taking the row again, starts nothing twice. A row taken again
 * whose run never started (its process died after the write) runs it.
 * A forced replay runs under a receipt of its own, the run's id.
 */
export async function claimReceipt(input: {
  fire: FireRow;
  /** The queued run row the receipt is kept with: as the run recorder
   *  inserts a queued run (`running`, no heartbeat yet), which the firing
   *  then adopts by its id. */
  run: { triggerType: string; recordId: string | null; payload: unknown; movementVersionId: string | null };
  /** The runs before it in its chain of writes and arrivals (loop_breaker.ts). */
  chain: readonly string[];
}): Promise<ReceiptClaim> {
  const { fire, run } = input;
  const key = receiptKeyOf(fire);
  return getAutomationsQb(['event_receipt', 'trigger_run'])
    .transaction()
    .execute(async (trx): Promise<ReceiptClaim> => {
      const { rows } = await sql`
        insert into automations.event_receipt (team_id, listen, key) values (${fire.teamId}::uuid, ${fire.pipeline}::text, ${key}::text)
        on conflict do nothing returning 1`.execute(trx);
      const found = await sql<{ queued: boolean }>`
        select (status = 'running' and last_heartbeat_at is null) as queued from automations.trigger_run where id = ${fire.runId}::uuid`.execute(trx);
      const existing = found.rows[0];
      if (rows.length === 1) {
        if (existing === undefined) {
          await sql`
            insert into automations.trigger_run (id, team_id, trigger_id, trigger_type, status, record_id, movement_version_id, trigger_payload, started_at, last_heartbeat_at, delivery_id, chain)
            values (${fire.runId}::uuid, ${fire.teamId}::uuid, ${fire.triggerId}::text, ${run.triggerType}::text, 'running', ${run.recordId}::text,
                    ${run.movementVersionId}::uuid, ${JSON.stringify(run.payload)}::text::jsonb, now(), null, ${fire.deliveryId}::uuid, ${[...input.chain]}::text[])`.execute(trx);
        }
        return { kind: 'run' };
      }
      if (existing === undefined) return { kind: 'ran_before' };
      return existing.queued ? { kind: 'run' } : { kind: 'in_hand' };
    });
}

/**
 * The receipt `(team, listen, arrival)` taken with no run, for an arrival
 * its listen does not run (paused, or past the loop depth): a redelivery of
 * it is then neither counted twice nor taken for the start of a new chain.
 * `false` when a run of the listen took it before.
 */
export async function takeReceiptUnrun(fire: FireRow): Promise<boolean> {
  const { rows } = await sql`
    insert into automations.event_receipt (team_id, listen, key) values (${fire.teamId}::uuid, ${fire.pipeline}::text, ${receiptKeyOf(fire)}::text)
    on conflict do nothing returning 1`.execute(getAutomationsQb(['event_receipt']));
  return rows.length === 1;
}

export { arrivalTriggerOf };

// ── One door's delivery, whole ──────────────────────────────────────────────

/**
 * A delivery of `arrivals` from `delivered`'s module to `teamId`, as every
 * door takes one: judged by the team's listens on that module and kept in
 * one write, the drain poked to start its runs. `kept: false` for a
 * redelivery under the same external id.
 */
export async function deliverArrivals(input: {
  teamId: TeamId;
  delivered: DeliveredBy;
  subscriptionId: string;
  externalId: string | null;
  source: DeliverySource;
  arrivals: readonly Arrival[];
  checkpoint?: unknown;
  request?: unknown;
  /** The listens that judge it, when not every listen of the team on the
   *  module: a poll's are the listens sharing it, since an arrival its module
   *  says it filtered (`takenApplied`) is judged without the filter. */
  listens?: readonly SavedListen[];
  /** The row the door kept before reading it (carried_delivery.ts). */
  rawKeptId?: string;
  /** When that row was kept: a listen an upgrade moved here since was its earlier
   *  version's for this delivery, and that version read it. */
  keptAt?: Date;
}): Promise<{ kept: KeptDelivery; deliveryId: string; fires: FireRow[] }> {
  const now = new Date();
  const all = input.listens ?? (await savedListens({ teamId: input.teamId, adapterType: input.delivered.adapterType }));
  const { keptAt } = input;
  const listens = keptAt === undefined ? all : all.filter((listen) => listen.carriedFrom === undefined || Date.parse(listen.carriedFrom.at) <= keptAt.getTime());
  const judged = judgeArrivals({ listens, delivery: input.delivered, arrivals: input.arrivals, now });
  const result = await keepJudgedDelivery({
    teamId: input.teamId,
    subscriptionId: input.subscriptionId,
    adapterType: input.delivered.adapterType,
    externalId: input.externalId,
    source: input.source,
    arrivals: input.arrivals,
    judged,
    ...('checkpoint' in input ? { checkpoint: input.checkpoint } : {}),
    ...(input.request !== undefined ? { request: input.request } : {}),
    ...(input.rawKeptId !== undefined ? { rawKeptId: input.rawKeptId } : {}),
    credentialsId: input.delivered.credentialsId,
    now,
  });
  // A module that pushes its members' changes reports them as arrivals on the
  // members' own edge (Airtable's `Tables`): a listen the host lists those for
  // is listed again, so a base or table made, renamed or removed moves what it
  // watches.
  if (result.kept.kept) {
    const edges = [...new Set(input.arrivals.flatMap((arrival) => ('gone' in arrival ? [] : [arrival.edge])))];
    await armResolveForArrivals({ edges, listens });
  }
  return result;
}
