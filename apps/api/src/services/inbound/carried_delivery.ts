// One door, every version. The door answers its provider once and keeps the
// delivery once, before any version reads it (`keepForEveryVersion`). The
// current version then reads it as it always has. Each carried version that has
// something riding on the delivery gets one `read_delivery` row in the same
// write: its own module reads what was kept, its own rules judge the automations
// pinned to it, and the row queues their receipts. No version translates for
// another, and no drain loads a version it has no work for.
//
// A door that builds its own arrivals (an email, a WhatsApp message, a remote
// module's push, an ask's answer, a page a carried poll answered) keeps no
// request a module reads again: each carried version with listens on its module
// judges the page itself, with its own judge (`judgeCarriedPage`).
//
// What rides on a delivery, for a version: a listen pinned to it on that module,
// when its listens fire. A carried version's runs park on the run host's waits,
// as the current version's do, never on a module's keys, so a reply to one is
// the current reading's to wake.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { z } from 'zod';
import { logger } from 'movement-engine/public/log';
import type { DeliverySource, NewWorkRow } from 'movement-engine/public/run-host';
import { carriedVersions, versionOf, type CarriedEvent, type CarriedKeptDelivery, type CarriedVersion, type ListenRow, type ListeningLane } from '@listen-fire/language-versions';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { WorkContext, WorkHandler } from '../work/kinds';
import type { TriggerEventId } from '../../generated/kysely/automations/TriggerEvent';

import { getAutomationsQb } from '../../lib/kysely';
import { teamIdSchema } from '../../lib/team_id';
import { WAITING_KEY_PREFIX, deliveryRowStore, withDoorsHeld } from '../movement_engine/run_host_deliveries';
import { stillHoldingDoors } from '../movement_engine/doors_hold';
import type { StoreDb } from '../movement_engine/run_host_queue';
import { WorkGivesUp, notifyWork, registerWorkHandler } from '../work/drain';
import { enqueueWork } from '../work/store';
import { modulePlatform } from '../translation_graph/movement/carried_run';
import { MOVEMENT_LISTEN_PROVISIONER, edgeSubscriptionOf } from '../translation_graph/movement/listen_subscriptions';
import { dispatchWorkKey } from '../translation_graph/triggers/dispatch_event';
import { storeTriggerEvent } from '../translation_graph/triggers/event_store';
import { recordMovementFailureIssue } from '../translation_graph/movement/issues';
import { readKeptRequest } from './captured_request';
import { unnarrowed } from './listen_edge';
import { anyCarriedPin, carriedEdgeKeysOf, carriedListens, kindsOf, type CarriedListen } from './carried_listens';
import { armCarriedForArrivals } from './listen_resolve';

/** What a door says of a delivery, for the versions that read it after it. */
export interface DeliveryOrigin {
  teamId: TeamId;
  adapterType: string;
  /** The subscription's provider key: a listen's kind may be either. */
  providerKey?: string;
  credentialsId: string | null;
  matchAnyCredential?: boolean;
}

const READ_DELIVERY = 'read_delivery';

/** The attempts a reading gets before it is given up on (the drain backs off
 *  between them, to five minutes), and an operator is told. */
export const READ_DELIVERY_ATTEMPTS = 10;

const readDeliveryRowSchema = z.object({
  teamId: teamIdSchema,
  /** The compatibility key of the version that reads it. */
  version: z.string(),
  adapterType: z.string(),
  providerKey: z.string().optional(),
  credentialsId: z.string().nullable(),
  matchAnyCredential: z.boolean().optional(),
  deliveryId: z.string(),
  /** It arrived at a subscription of this version's own: the digest its
   *  listens share it by. */
  digest: z.string().optional(),
});
type ReadDeliveryRow = z.infer<typeof readDeliveryRowSchema>;

/** Who reads a delivery where it arrived. Each version registers its own
 *  narrowed subscriptions (a filter its module takes, or a scope): a delivery
 *  at one is read by the version whose subscription it is (`version`
 *  undefined: the current one's), by the listens sharing it (`digest`). One
 *  subscription to a whole connection's edge serves every version: a delivery
 *  there is read by each version with listens on the module, by its listens
 *  sharing it (`shared`). One that arrived anywhere else (a module's one door,
 *  as Slack's app, or a row no listen provisioned) is read by every version
 *  with listens on its module. */
async function readersWhereArrived(
  db: StoreDb,
  origin: DeliveryOrigin,
  subscriptionId: string,
): Promise<{ every: true } | { shared: string } | { version: string | undefined; digest: string }> {
  if (origin.providerKey === undefined) return { every: true };
  // Found among the provider's rows, not by id: a subscription id need not be a row's.
  const rows = await db
    .selectFrom('webhook_subscription')
    .where('team_id', '=', origin.teamId)
    .where('provider', '=', origin.providerKey)
    .where('deleted_at', 'is', null)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .select(['id', 'subscriptions'])
    .execute();
  const here = rows.find((row) => row.id === subscriptionId);
  const held = here === undefined ? null : edgeSubscriptionOf(here.subscriptions);
  if (held === null) return { every: true };
  if (unnarrowed({ taken: held.filter, scope: held.scope }, 'connection')) return { shared: held.digest };
  return { version: held.version, digest: held.digest };
}

/** The carried versions something rides on this delivery for, by key, with the
 *  digest the listens it is judged by share, read on the keep's own
 *  transaction. */
async function versionsConcerned(db: StoreDb, origin: DeliveryOrigin, subscriptionId: string): Promise<Array<{ version: string; digest?: string }>> {
  const carried = carriedVersions().filter((version) => version.provides.listen.kind === 'carried');
  if (carried.length === 0) return [];
  const readers = await readersWhereArrived(db, origin, subscriptionId);
  if ('version' in readers) return readers.version !== undefined && carried.some((version) => version.key === readers.version) ? [{ version: readers.version, digest: readers.digest }] : [];
  const pins = await db
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .where('trigger.team_id', '=', origin.teamId)
    .where('trigger.kind', 'in', kindsOf(origin))
    .where('trigger.run_mode', '!=', 'off')
    .select('movement.language_version')
    .distinct()
    .execute();
  const listening = new Set(
    pins.flatMap((row) => {
      const version = versionOf(row.language_version);
      return version !== undefined && version.provides.listen.kind === 'carried' ? [version.key] : [];
    }),
  );
  const sharing = 'shared' in readers ? { digest: readers.shared } : {};
  return carried.filter((version) => listening.has(version.key)).map((version) => ({ version: version.key, ...sharing }));
}

function readingRows(origin: DeliveryOrigin, deliveryId: string, versions: ReadonlyArray<{ version: string; digest?: string }>): NewWorkRow[] {
  return versions.map(({ version, digest }) => {
    const row: ReadDeliveryRow = {
      teamId: origin.teamId,
      version,
      adapterType: origin.adapterType,
      ...(origin.providerKey !== undefined ? { providerKey: origin.providerKey } : {}),
      credentialsId: origin.credentialsId,
      ...(origin.matchAnyCredential === true ? { matchAnyCredential: true } : {}),
      deliveryId,
      ...(digest !== undefined ? { digest } : {}),
    };
    return { kind: READ_DELIVERY, key: `${READ_DELIVERY}:${version}:${deliveryId}`, payload: row, teamId: origin.teamId };
  });
}

export type KeptFirst = { kind: 'read'; deliveryId: string; keptAt: Date } | { kind: 'duplicate' };

/** What a delivery is named by while it waits for the current version to judge
 *  it: a provider's retry of it carries the same request, and sends no id every
 *  version could read. */
export function waitingKeyOf(request: { rawBody: Buffer; query?: string }): string {
  return `${WAITING_KEY_PREFIX}${createHash('sha256').update(request.query ?? '').update('\0').update(request.rawBody).digest('hex')}`;
}

/**
 * The delivery as it arrived (redacted: captured_request.ts), kept before any
 * version reads it, with one reading row per carried version it concerns.
 * `duplicate`: its external id was kept and judged before. A retry of one kept
 * but not yet judged is read again by the current version; its carried rows
 * were queued with the first keep, so no carried version reads it twice.
 */
export async function keepForEveryVersion(input: {
  origin: DeliveryOrigin;
  subscriptionId: string;
  externalId: string | null;
  source: DeliverySource;
  request: unknown;
}): Promise<KeptFirst> {
  const { origin } = input;
  const id = randomUUID();
  const kept = await deliveryRowStore({ host: 'platform', teamId: origin.teamId }).keepRawDelivery({
    delivery: {
      id,
      subscriptionId: input.subscriptionId,
      externalId: input.externalId,
      receivedAt: new Date().toISOString(),
      source: input.source,
      request: input.request,
      credentialsId: origin.credentialsId,
    },
    work: async (trx) => readingRows(origin, id, await versionsConcerned(trx, origin, input.subscriptionId)),
  });
  if (kept.alreadyKept && kept.judged) return { kind: 'duplicate' };
  return { kind: 'read', deliveryId: kept.id, keptAt: kept.keptAt };
}

export { withDoorsHeld };

/** The current version read a kept delivery and found nothing in it. */
export async function judgedEmpty(input: { teamId: string; id: string }): Promise<void> {
  await deliveryRowStore({ host: 'platform', teamId: input.teamId }).judgedEmpty({ id: input.id });
}

/** The listens of `row`'s module pinned to its version that read as listens
 *  under its own plan schema: the only rows it judges. A delivery that arrived
 *  at a subscription of the version's own is judged by the listens sharing it
 *  only (`digest`), as the current version judges one of its own. */
async function listensFor(input: { row: ReadDeliveryRow; version: CarriedVersion }): Promise<CarriedListen[]> {
  const { row, version } = input;
  if (version.provides.listen.kind !== 'carried') return [];
  const listens = await carriedListens({ teamId: row.teamId, kinds: kindsOf(row), version: version.key });
  return row.digest === undefined ? listens : listens.filter((listen) => carriedEdgeKeysOf(listen, ['connection', 'scope']).some(({ digest }) => digest === row.digest));
}

async function keptDeliveryOf(row: ReadDeliveryRow): Promise<CarriedKeptDelivery | null> {
  const { rows } = await sql<{ request: unknown }>`
    select request from automations.delivery where team_id = ${row.teamId}::uuid and id = ${row.deliveryId}::uuid`.execute(getAutomationsQb(['delivery']));
  const kept = rows[0] === undefined ? null : readKeptRequest(rows[0].request);
  if (kept === null || !('request' in kept)) return null;
  const { body, checkpoint, headers } = kept.request;
  const contentType = headers['content-type'];
  return { body, ...(contentType !== undefined ? { contentType } : {}), ...(checkpoint !== undefined ? { checkpoint } : {}) };
}

/** A receipt and its row, for one listen the version judged: a redelivery of a
 *  receipt still waiting queues it again, as its row may have been lost.
 *  `stableKey`: what names the event when its source gave it no id, so a reading
 *  taken again keeps one receipt. Answers whether the receipt is new. */
export async function receiveJudgedEvent(input: { teamId: TeamId; triggerId: string; event: CarriedEvent; lane: Pick<ListeningLane, 'readEvent'>; stableKey?: string }): Promise<{ fresh: boolean }> {
  stillHoldingDoors();
  const read = input.lane.readEvent(input.event);
  if (!read.ok) throw new Error(`a judged event could not be read by its own version: ${read.reason}`);
  const idempotencyKey = read.record.idempotencyKey ?? input.stableKey;
  const record = idempotencyKey !== undefined ? { ...read.record, idempotencyKey } : read.record;
  const stored = await storeTriggerEvent({ teamId: input.teamId, triggerId: input.triggerId, event: { json: input.event, record } });
  if (stored.duplicate && (await receiptStatus(stored.id)) !== 'received') return { fresh: false };
  await enqueueWork({
    kind: 'dispatch_event',
    key: dispatchWorkKey(stored.id),
    teamId: input.teamId,
    payload: { triggerId: input.triggerId, teamId: input.teamId, triggerEvent: input.event, storedEventId: stored.id, duplicate: false },
  });
  return { fresh: !stored.duplicate };
}

async function receiptStatus(id: TriggerEventId): Promise<string | undefined> {
  const row = await getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('id', '=', id).select('status').executeTakeFirst();
  return row?.status;
}

/** A page a door built, judged by each carried version with listens on its
 *  module, by its own judge, each receipt queued to start its run. Answers how
 *  many new receipts it kept: a page told again fires nothing new. `stableKey` names the page (its external id, or what the
 *  door names it by), so a page judged again keeps one receipt per arrival.
 *  `listens`: the listens that judge it, when not every carried listen of the
 *  team on the module (a carried poll's are the listens sharing it). */
export async function judgeCarriedPage(input: {
  teamId: TeamId;
  adapterType: string;
  /** The subscription's provider key, when a listen's kind may be it. */
  providerKey?: string;
  credentialsId: string | null;
  /** Plain data each version reads with its own arrival schema. */
  page: readonly unknown[];
  stableKey: string;
  listens?: readonly CarriedListen[];
}): Promise<number> {
  let listens = input.listens;
  if (listens === undefined) {
    const kinds = kindsOf(input);
    listens = (await anyCarriedPin({ teamId: input.teamId, kinds })) ? await carriedListens({ teamId: input.teamId, kinds }) : [];
  }
  const byVersion = new Map<string, { lane: ListeningLane; listens: CarriedListen[] }>();
  for (const listen of listens) {
    const held = byVersion.get(listen.version.key) ?? { lane: listen.lane, listens: [] };
    held.listens.push(listen);
    byVersion.set(listen.version.key, held);
  }
  let fresh = 0;
  for (const { lane, listens: ofVersion } of byVersion.values()) {
    const rows: ListenRow[] = ofVersion.map((listen) => listen.row);
    const judged = lane.judgePage({ teamId: input.teamId, adapterType: input.adapterType, credentialsId: input.credentialsId, page: input.page, listens: rows, now: new Date().toISOString() });
    for (const line of judged.lines) logger.warn(`[CarriedPage] ${line}`);
    for (const receipt of judged.receipts) {
      const kept = await receiveJudgedEvent({ teamId: input.teamId, triggerId: receipt.triggerId, event: receipt.event, lane, stableKey: `${input.stableKey}:${receipt.arrivalKey}` });
      if (kept.fresh) fresh += 1;
    }
    await armCarriedForArrivals({ edges: judged.edges, listens: ofVersion });
  }
  return fresh;
}

/** The automations a delivery was owed to under a version: those with a listen
 *  it might have fired. */
async function ownersOfDelivery(row: ReadDeliveryRow, version: CarriedVersion): Promise<Array<{ movementId: string; movementName: string; triggerName: string }>> {
  const listens = (await listensFor({ row, version })).map((listen) => listen.triggerId);
  if (listens.length === 0) return [];
  return getAutomationsQb(['trigger', 'movement'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .where('trigger.id', 'in', listens)
    .select(['movement.id as movementId', 'movement.name as movementName', 'trigger.name as triggerName'])
    .execute();
}

/** A reading given up on is no silent loss: each automation it was owed to has
 *  an issue naming the delivery, which stays as it was received. */
async function tellOwnersOfLostReading(row: ReadDeliveryRow, input: { attempts: number; error: unknown }): Promise<void> {
  const version = carriedVersions().find((candidate) => candidate.key === row.version);
  const reason = input.error instanceof Error ? input.error.message : String(input.error);
  const message = `delivery ${row.deliveryId} could not be read under language version ${row.version} after ${input.attempts} attempts, so the event it carried ran nothing under it: ${reason}. The delivery is kept as it was received`;
  for (const owner of version === undefined ? [] : await ownersOfDelivery(row, version)) {
    await recordMovementFailureIssue({ teamId: row.teamId, ...owner, message });
  }
  logger.error(`[ReadDelivery] ${message}`);
}

async function runReadDelivery(payload: unknown, ctx: WorkContext): Promise<void> {
  const row = readDeliveryRowSchema.parse(payload);
  try {
    await readKeptDelivery(row);
  } catch (error) {
    if (ctx.attempts < READ_DELIVERY_ATTEMPTS) throw error;
    await tellOwnersOfLostReading(row, { attempts: ctx.attempts, error });
    throw new WorkGivesUp(`delivery ${row.deliveryId} could not be read under ${row.version} after ${ctx.attempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readKeptDelivery(row: ReadDeliveryRow): Promise<void> {
  const version = carriedVersions().find((candidate) => candidate.key === row.version);
  const laneOf = version?.listenRows;
  if (version === undefined || laneOf === undefined) {
    logger.warn(`[ReadDelivery] delivery ${row.deliveryId} was queued for version ${row.version}, which this release does not read: it reads nothing`);
    return;
  }
  const delivery = await keptDeliveryOf(row);
  if (delivery === null) {
    // A delivery past its retention, or a page: nothing a version can read.
    logger.warn(`[ReadDelivery] delivery ${row.deliveryId} kept no request version ${row.version} can read: it reads nothing`);
    return;
  }
  const lane = await laneOf();
  const listens = await listensFor({ row, version });
  const read = await lane.readDelivery(
    {
      teamId: row.teamId,
      adapterType: row.adapterType,
      credentialsId: row.credentialsId,
      ...(row.matchAnyCredential === true ? { matchAnyCredential: true } : {}),
      delivery,
      listens: listens.map((listen) => listen.row),
      now: new Date().toISOString(),
    },
    modulePlatform(),
  );
  for (const line of read.lines) logger.warn(`[ReadDelivery] ${line}`);
  for (const [index, receipt] of read.receipts.entries()) {
    await receiveJudgedEvent({ teamId: row.teamId, triggerId: receipt.triggerId, event: receipt.event, lane, stableKey: `delivery:${row.deliveryId}:${index}` });
  }
  await armCarriedForArrivals({ edges: read.edges, listens });
  notifyWork();
}

export const readDeliveryHandler: WorkHandler = { run: runReadDelivery, recover: runReadDelivery };

export function registerReadDeliveryWork(): void {
  registerWorkHandler(READ_DELIVERY, readDeliveryHandler);
}

