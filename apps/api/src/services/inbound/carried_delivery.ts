// One door, every version. The door answers its provider once and keeps the
// delivery once, before any version reads it (`keepForEveryVersion`). The
// current version then reads it as it always has. Each carried version that has
// something riding on the delivery gets one `read_delivery` row in the same
// write: its own module reads what was kept, its own rules judge the automations
// pinned to it, and the row queues their receipts and any wakes. No version
// translates for another, and no drain loads a version it has no work for.
//
// What rides on a delivery, for a version: a listen pinned to it on that module,
// when its listens fire; or a run it parked on that module's keys, whose reply
// this may be.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { z } from 'zod';
import { logger } from 'movement-engine/public/log';
import type { DeliverySource, NewWorkRow } from 'movement-engine/public/run-host';
import { isLegacyLanguageVersion } from 'legacy-lang';
import { carriedVersions, versionOf, versionOfLegacyId, type CarriedEvent, type CarriedKeptDelivery, type CarriedVersion, type ListenRow, type ListeningLane } from '@listen-fire/language-versions';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { WorkContext, WorkHandler } from '../work/kinds';
import type { TriggerEventId } from '../../generated/kysely/automations/TriggerEvent';

import { getAutomationsQb } from '../../lib/kysely';
import { teamIdSchema } from '../../lib/team_id';
import { queueAwaitWakesOf } from '../movement_engine/carried_correlations';
import { WAITING_KEY_PREFIX, deliveryRowStore, withDoorsHeld } from '../movement_engine/run_host_deliveries';
import { WorkGivesUp, notifyWork, registerWorkHandler } from '../work/drain';
import { enqueueWork } from '../work/store';
import { modulePlatform } from '../translation_graph/movement/carried_run';
import { MOVEMENT_LISTEN_PROVISIONER } from '../translation_graph/movement/carried_subscriptions';
import { edgeSubscriptionOf } from '../translation_graph/movement/listen_subscriptions';
import { siblingKindsForAdapter } from '../translation_graph/adapters/registry';
import { dispatchWorkKey } from '../translation_graph/triggers/dispatch_event';
import { storeTriggerEvent } from '../translation_graph/triggers/event_store';
import { recordMovementFailureIssue } from '../translation_graph/movement/issues';
import { readKeptRequest } from './captured_request';

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
});
type ReadDeliveryRow = z.infer<typeof readDeliveryRowSchema>;

/** The version a trigger row's pin reads under: a legacy id's rows were written
 *  by the release it ran beside, and refused by name when they match. */
function versionOfRow(pin: string): CarriedVersion | undefined {
  return isLegacyLanguageVersion(pin) ? versionOfLegacyId(pin) : versionOf(pin);
}

/** The kinds a listen on this origin's module may be filed under. */
function kindsOf(origin: Pick<DeliveryOrigin, 'adapterType' | 'providerKey'>): string[] {
  return [...new Set([origin.adapterType, ...(origin.providerKey !== undefined ? [origin.providerKey] : []), ...siblingKindsForAdapter(origin.adapterType)])];
}

/** Whether a carried version hears this delivery where it arrived. Each version
 *  registers its own webhook, so a source with both posts each event to both: a
 *  version with a webhook of its own on this channel reads only that one's. A row
 *  a current listen holds carries what it filtered for, and a version without a
 *  webhook here (a module with no subscriptions, or one a source refused) reads it
 *  as the door's one delivery. */
async function arrivedWhereCarriedHears(origin: DeliveryOrigin, subscriptionId: string): Promise<boolean> {
  if (origin.providerKey === undefined) return true;
  const rows = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', origin.teamId)
    .where('provider', '=', origin.providerKey)
    .where('deleted_at', 'is', null)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('status', '=', 'active')
    .select(['id', 'credentials_id', 'subscriptions'])
    .execute();
  const here = rows.find((row) => row.id === subscriptionId);
  if (here === undefined || edgeSubscriptionOf(here.subscriptions) === null) return true;
  return !rows.some((row) => edgeSubscriptionOf(row.subscriptions) === null && ((row.credentials_id as string | null) ?? null) === origin.credentialsId);
}

/** The keys of the carried versions something rides on this delivery for. */
async function versionsConcerned(origin: DeliveryOrigin, subscriptionId: string): Promise<string[]> {
  const carried = carriedVersions().filter((version) => version.provides.listen.kind === 'carried' || version.provides.resume.kind === 'carried');
  if (carried.length === 0) return [];
  if (!(await arrivedWhereCarriedHears(origin, subscriptionId))) return [];
  const pins = await getAutomationsQb(['trigger', 'movement'])
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
      const version = versionOfRow(row.language_version);
      return version !== undefined && version.provides.listen.kind === 'carried' ? [version.key] : [];
    }),
  );
  const parked = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('team_id', '=', origin.teamId)
    .where('adapter_type', '=', origin.adapterType)
    .select('id')
    .limit(1)
    .executeTakeFirst();
  return carried.filter((version) => listening.has(version.key) || (parked !== undefined && version.provides.resume.kind === 'carried')).map((version) => version.key);
}

function readingRows(origin: DeliveryOrigin, deliveryId: string, versions: readonly string[]): NewWorkRow[] {
  return versions.map((version) => {
    const row: ReadDeliveryRow = {
      teamId: origin.teamId,
      version,
      adapterType: origin.adapterType,
      ...(origin.providerKey !== undefined ? { providerKey: origin.providerKey } : {}),
      credentialsId: origin.credentialsId,
      ...(origin.matchAnyCredential === true ? { matchAnyCredential: true } : {}),
      deliveryId,
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
    },
    work: async () => readingRows(origin, id, await versionsConcerned(origin, input.subscriptionId)),
  });
  if (kept.alreadyKept && kept.judged) return { kind: 'duplicate' };
  return { kind: 'read', deliveryId: kept.id, keptAt: kept.keptAt };
}

export { withDoorsHeld };

/** The current version read a kept delivery and found nothing in it. */
export async function judgedEmpty(input: { teamId: string; id: string }): Promise<void> {
  await deliveryRowStore({ host: 'platform', teamId: input.teamId }).judgedEmpty({ id: input.id });
}

/** The listens on a module pinned to a carried version whose listens fire, for
 *  the doors that build a version's event themselves (WhatsApp's media, email's
 *  routing key): production's doors at 0.12.13 built it, and no module reads a
 *  request there. */
export async function carriedListensOn(origin: Pick<DeliveryOrigin, 'teamId' | 'adapterType' | 'providerKey'>): Promise<Array<ListenRow & { lane: () => Promise<ListeningLane> }>> {
  const listening = carriedVersions().filter((version) => version.provides.listen.kind === 'carried');
  if (listening.length === 0) return [];
  const rows = await shippedListenRows(origin);
  const live = await Promise.all(
    rows.map(async (row) => {
      const version = listening.find((candidate) => candidate.key === versionOfRow(row.pin)?.key);
      if (version?.listenRows === undefined) return [];
      return (await version.listenRows()).isListenRow(row) ? [{ ...row, lane: version.listenRows }] : [];
    }),
  );
  return live.flat();
}

/** Every row of the origin's module, each with the text its automation shipped. */
async function shippedListenRows(origin: Pick<DeliveryOrigin, 'teamId' | 'adapterType' | 'providerKey'>): Promise<ListenRow[]> {
  const rows = await getAutomationsQb(['trigger', 'movement', 'movement_version'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .innerJoin('movement_version', 'movement_version.id', 'movement.current_version_id')
    .where('trigger.team_id', '=', origin.teamId)
    .where('trigger.kind', 'in', kindsOf(origin))
    .select([
      'trigger.id as id',
      'trigger.kind as kind',
      'trigger.credentials_id as credentialsId',
      'trigger.config as config',
      'trigger.fired_movement_name as firedMovementName',
      'movement_version.source as source',
      'movement_version.language_version as pin',
    ])
    .execute();
  return rows.map((row) => ({ ...row, credentialsId: row.credentialsId ?? null }));
}

/** The rows of `row`'s module pinned to its version: a legacy id's among them,
 *  whose firing is refused by name. */
async function listenRowsFor(row: ReadDeliveryRow, version: CarriedVersion): Promise<ListenRow[]> {
  if (version.provides.listen.kind !== 'carried') return [];
  return (await shippedListenRows(row)).filter((listen) => versionOfRow(listen.pin)?.key === version.key);
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
 *  taken again keeps one receipt. */
export async function receiveJudgedEvent(input: { teamId: TeamId; triggerId: string; event: CarriedEvent; lane: Pick<ListeningLane, 'readEvent'>; stableKey?: string }): Promise<void> {
  const read = input.lane.readEvent(input.event);
  if (!read.ok) throw new Error(`a judged event could not be read by its own version: ${read.reason}`);
  const idempotencyKey = read.record.idempotencyKey ?? input.stableKey;
  const record = idempotencyKey !== undefined ? { ...read.record, idempotencyKey } : read.record;
  const stored = await storeTriggerEvent({ teamId: input.teamId, triggerId: input.triggerId, event: { json: input.event, record } });
  if (stored.duplicate && (await receiptStatus(stored.id)) !== 'received') return;
  await enqueueWork({
    kind: 'dispatch_event',
    key: dispatchWorkKey(stored.id),
    teamId: input.teamId,
    payload: { triggerId: input.triggerId, teamId: input.teamId, triggerEvent: input.event, storedEventId: stored.id, duplicate: false },
  });
}

async function receiptStatus(id: TriggerEventId): Promise<string | undefined> {
  const row = await getAutomationsQb(['trigger_event']).selectFrom('trigger_event').where('id', '=', id).select('status').executeTakeFirst();
  return row?.status;
}

/** The automations a delivery was owed to under a version: those with a listen
 *  it might have fired, and those with a run parked on the module's keys, whose
 *  reply it might have been. */
async function ownersOfDelivery(row: ReadDeliveryRow, version: CarriedVersion): Promise<Array<{ movementId: string; movementName: string; triggerName: string }>> {
  const listens = (await listenRowsFor(row, version)).map((listen) => listen.id);
  const heard =
    listens.length === 0
      ? []
      : await getAutomationsQb(['trigger', 'movement'])
          .selectFrom('trigger')
          .innerJoin('movement', 'movement.id', 'trigger.movement_id')
          .where('trigger.id', 'in', listens as never[])
          .select(['movement.id as movementId', 'movement.name as movementName', 'trigger.name as triggerName'])
          .execute();
  const parked =
    version.provides.resume.kind !== 'carried'
      ? []
      : await getAutomationsQb(['adapter_await', 'trigger_run', 'movement_version', 'movement'])
          .selectFrom('adapter_await')
          .innerJoin('trigger_run', 'trigger_run.id', 'adapter_await.run_id')
          .innerJoin('movement_version', 'movement_version.id', 'trigger_run.movement_version_id')
          .innerJoin('movement', 'movement.id', 'movement_version.movement_id')
          .where('adapter_await.team_id', '=', row.teamId)
          .where('adapter_await.adapter_type', '=', row.adapterType)
          .select(['movement.id as movementId', 'movement.name as movementName'])
          .distinct()
          .execute();
  return [...heard, ...parked.map((owner) => ({ ...owner, triggerName: row.adapterType }))];
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
  const listens = await listenRowsFor(row, version);
  const lane = await laneOf();
  const read = await lane.readDelivery(
    {
      teamId: row.teamId,
      adapterType: row.adapterType,
      credentialsId: row.credentialsId,
      ...(row.matchAnyCredential === true ? { matchAnyCredential: true } : {}),
      delivery,
      listens,
      now: new Date().toISOString(),
    },
    modulePlatform(),
  );
  for (const line of read.lines) logger.warn(`[ReadDelivery] ${line}`);
  for (const [index, receipt] of read.receipts.entries()) {
    await receiveJudgedEvent({ teamId: row.teamId, triggerId: receipt.triggerId, event: receipt.event, lane, stableKey: `delivery:${row.deliveryId}:${index}` });
  }
  await queueAwaitWakesOf({ adapterType: row.adapterType, teamId: row.teamId, keys: read.wakeKeys });
  notifyWork();
}

export const readDeliveryHandler: WorkHandler = { run: runReadDelivery, recover: runReadDelivery };

export function registerReadDeliveryWork(): void {
  registerWorkHandler(READ_DELIVERY, readDeliveryHandler);
}

