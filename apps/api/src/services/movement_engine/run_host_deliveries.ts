// A kept delivery's one write and the rows it queues (listen-fire 0.13's
// `DeliveryRowStore`: `inbound.keepDelivery`, `work.bury`,
// `work.completeKey`, `inbound.forgetDeliveryId`), over automations.delivery,
// inbound_checkpoint, work and the waits tables. Ported from
// @lf/postgres-store (crates/lf/src/pg_store.rs). One store is one team's
// deliveries, kept for one host: the platform's door, or a cloud lf through
// the store module.

import { sql } from 'kysely';

import { logger } from 'movement-engine/public/log';
import type { DeliveryRowStore, KeepDelivery, NewWorkRow, WaitWake } from 'movement-engine/public/run-host';

import { DOOR_WAIT_MS, doorsLockPool } from '../../lib/kysely';
import { isWorkKind } from '../work/kinds';
import { inOneTransaction } from '../context/one_transaction';
import { DoorsTryAgain, heldDoors, stillHoldingDoors, underDoorsHold, type DoorsHold, type LockConnection } from './doors_hold';
import {
  announceQueued,
  inStoreTransaction,
  queueRow,
  queueWake,
  storeDb,
  workClaimOf,
  type Exec,
  type Host,
  type Queued,
  type StoreDb,
} from './run_host_queue';
import { arrivalMark, dropUnstartedWaits, logArrivalsIn, openDeliveryWaits } from './run_host_waits';
import { keepUnjudgedIn, type UnjudgedArrival } from '../lf_store/records_door';

/** `inbound.keepDelivery`'s input as the platform's door sends it: with the
 *  listens that could not judge the delivery's arrivals, kept in its write. */
export interface PlatformKeepDelivery extends KeepDelivery {
  unjudged?: readonly UnjudgedArrival[];
  /** The door kept this delivery before reading it (`keepRawDelivery`): this
   *  write is its judging. `kept: false` when it was judged before. */
  rawKept?: { id: string };
  /** The connection the delivery was kept for (null: none, or the module's install). */
  credentialsId?: string | null;
  /** What a carried version keeps with the delivery in its one write (a
   *  replay's receipts, their queued runs and their rows); the rows it queues
   *  are announced with the delivery's. */
  alongside?: (trx: StoreDb) => Promise<readonly Queued[]>;
}

/** The row a door keeps before any version reads the delivery. */
export interface RawDelivery {
  id: string;
  subscriptionId: string;
  externalId: string | null;
  receivedAt: string;
  source: KeepDelivery['delivery']['source'];
  request: unknown;
  /** The connection it came for; null for a module's install, or none. */
  credentialsId: string | null;
}

export interface PlatformDeliveryRowStore extends DeliveryRowStore {
  keepDelivery(input: PlatformKeepDelivery): ReturnType<DeliveryRowStore['keepDelivery']>;
  /** The delivery as it arrived, and the rows owed by it in the same write,
   *  under the team's doors lock (`work` is asked inside it, and reads through the
   *  transaction it is given, so what it reads is settled against any upgrade and
   *  needs no second connection): `alreadyKept` when its external id was kept
   *  before. Then its id is that delivery's, `judged` says whether the platform's
   *  version read it, and nothing is written. `keptAt` is the database's clock
   *  at the keep. */
  keepRawDelivery(input: { delivery: RawDelivery; work: (trx: StoreDb) => Promise<readonly NewWorkRow[]> }): Promise<{ id: string; alreadyKept: boolean; judged: boolean; keptAt: Date }>;
  /** A kept delivery the platform's version read and found nothing in. */
  judgedEmpty(input: { id: string }): Promise<void>;
}

const FIRE_EVENT = 'fire_event';

/** A kept delivery the platform's version has not judged yet is named by what
 *  it carries, so a provider's retry of it finds it. The key goes with the
 *  judging: an identical delivery after that is a new one. */
export const WAITING_KEY_PREFIX = 'waiting:';

/** The doors of a team hold this shared while a delivery is kept and what it owes
 *  each version is read; an upgrade holds it alone (`holdDoorsAlone`). So a
 *  delivery is on one side of a move: its keep sees the move, or the move sees
 *  what it queued. A request behind an upgrade's waits, and everything shared
 *  queues behind that request, so only the upgrade waits holding the main pool. */
function doorsLockName(teamId: string) {
  return `doors:${teamId}`;
}

/**
 * How long an upgrade waits for the doors: seconds fewer than a door will
 * (`DOOR_WAIT_MS`), since every door of the team queues behind its request, and a
 * door behind it should get through when it gives up. It holds a main connection
 * while it waits, so enough upgrades at once would stop the door they wait for
 * until this ends. Far under the 30 seconds an upgrade gives what is in flight:
 * that time is spent between looks, holding nothing, and an upgrade answered
 * "try again" costs far less than doors standing still.
 */
const UPGRADE_DOORS_WAIT_MS = 3_000;

/**
 * How long a keep waits for a row lock, as on a delivery id another process's
 * open transaction holds. A hung process would otherwise stop the keep with a
 * connection of the doors' two held for it, and so every team's doors. Normally
 * such a wait is a duplicate's commit, milliseconds. Under a door's wait
 * (`DOOR_WAIT_MS`), so a door queued behind stuck keeps gets its turn.
 */
const KEEP_ROW_WAIT_MS = 3_000;

const LOCK_NOT_AVAILABLE = '55P03';

function isLockTimeout(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === LOCK_NOT_AVAILABLE;
}

/** `work`, whose waits for a lock end after `ms`. Only `work`'s: the transaction it
 *  runs in may go on, as an upgrade's does, with moves of no such limit. */
async function boundingLockWaits<T>(exec: Exec, wait: { what: string; ms: number }, work: () => Promise<T>): Promise<T> {
  const { rows } = await sql<{ prior: string }>`select current_setting('lock_timeout') as prior`.execute(exec);
  const prior = rows[0]?.prior;
  if (prior === undefined) throw new Error('the database answered no lock_timeout');
  await sql`select set_config('lock_timeout', ${`${wait.ms}ms`}, true)`.execute(exec);
  try {
    const answer = await work();
    await sql`select set_config('lock_timeout', ${prior}, true)`.execute(exec);
    return answer;
  } catch (error) {
    if (isLockTimeout(error)) throw new DoorsTryAgain(`${wait.what} waited ${wait.ms} ms for a lock`, { cause: error });
    throw error;
  }
}

/** One keep's write. A door that times out here fails with nothing kept. */
function inKeepTransaction<T>(body: (trx: StoreDb) => Promise<T>): Promise<T> {
  return inStoreTransaction((trx) => boundingLockWaits(trx, { what: 'a keep', ms: KEEP_ROW_WAIT_MS }, () => body(trx)));
}

/** `body`, done under the team's doors, in one context transaction (the
 *  caller's open one, as an upgrade's, else its own) whose waits for a lock end
 *  as a keep's do: stuck behind a row lock, it would hold the doors, and every
 *  door of the team queued behind an upgrade waiting for them. It fails with
 *  `DoorsTryAgain`, as a keep does, and with its own transaction it commits
 *  nothing once the doors' lock is lost (`stillHoldingDoors`). `what` names it
 *  in that failure. */
export function boundedUnderDoors<T>(what: string, body: () => Promise<T>): Promise<T> {
  return inOneTransaction(async () => {
    const answer = await boundingLockWaits(storeDb(), { what, ms: KEEP_ROW_WAIT_MS }, body);
    stillHoldingDoors();
    return answer;
  });
}

/** `body` with the team's doors held shared: for a door that reads a delivery's
 *  listens version by version itself, so an upgrade is not between its reads.
 *  The lock's transaction only holds the lock, on a connection of its own
 *  (`doorsLockPool`): `body` writes as it always does, through the main pool. So a
 *  door waiting behind an upgrade holds nothing of the main pool, and the door
 *  that upgrade waits for can always get on. Inside a transaction, as an
 *  upgrade's own, the lock joins it, since a second session would wait for it.
 *
 *  A door waits `DOOR_WAIT_MS` at most, and then fails with nothing kept, so its
 *  retry is no second delivery even with no id to dedupe on. If the lock's
 *  connection goes during `body`, what it has not committed does not commit
 *  (`stillHoldingDoors`) and the door fails. It answers success only when the
 *  lock's own commit says the lock lived through all of `body`: what `body` read
 *  after losing it cannot be trusted, and a retry dedupes what it did keep. */
export async function withDoorsHeld<T>(teamId: string, body: () => Promise<T>): Promise<T> {
  const open = storeDb();
  if (open.isTransaction) {
    await sql`select pg_advisory_xact_lock_shared(hashtextextended(${doorsLockName(teamId)}::text, 0))`.execute(open);
    return body();
  }
  return onLockConnection(
    {
      teamId,
      held: "the team's doors",
      take: (lock) => lock.query('select pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))', [doorsLockName(teamId)]).then(() => undefined),
    },
    body,
  );
}

/** What a listen whose filter asks its host is judged under: one delivery at
 *  a time reads what it waits on and keeps what it could not judge, so a
 *  second can never read an empty line before the first keeps its arrival
 *  waiting, and run ahead of it. */
function judgingLockName(teamId: string, pipeline: string) {
  return `judging:${teamId}:${pipeline}`;
}

/** `body` with each of `pipelines` judged by this door alone (in one order,
 *  so two doors never wait on each other). Under a door that holds the team's
 *  doors, the locks join that hold's connection, as a door holds one at most;
 *  inside a transaction, they join it; else they are held on a connection of
 *  their own, as the doors are. A door that cannot have them soon fails with
 *  nothing kept (`DoorsTryAgain`), and its provider retries. */
export async function withListensJudgedAlone<T>(teamId: string, pipelines: readonly string[], body: () => Promise<T>): Promise<T> {
  const names = [...new Set(pipelines)].sort().map((pipeline) => judgingLockName(teamId, pipeline));
  if (names.length === 0) return body();
  const open = storeDb();
  if (open.isTransaction) {
    for (const name of names) await sql`select pg_advisory_xact_lock(hashtextextended(${name}::text, 0))`.execute(open);
    return body();
  }
  const take = async (lock: LockConnection) => {
    for (const name of names) await lock.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [name]);
  };
  const doors = heldDoors();
  if (doors?.lock !== undefined) {
    try {
      await take(doors.lock);
    } catch (cause) {
      throw new DoorsTryAgain(`a door could not judge its listens alone within ${DOOR_WAIT_MS} ms`, { cause });
    }
    return body();
  }
  return onLockConnection({ teamId, held: 'its listens to judge alone', take }, body);
}

/** `body` with what `take` locks held on a connection of the lock pool, for
 *  the length of `body`, as `withDoorsHeld` says. */
async function onLockConnection<T>(input: { teamId: string; held: string; take: (lock: LockConnection) => Promise<void> }, body: () => Promise<T>): Promise<T> {
  const { teamId, held } = input;
  const asked = Date.now();
  const lock = await doorsLockPool.connect().catch((cause: unknown) => {
    throw new DoorsTryAgain(`a door waited ${DOOR_WAIT_MS} ms for a connection to hold ${held}`, { cause });
  });
  const hold: DoorsHold = { lost: false, lock };
  // Checked out, the pool does not hear this connection, and an unheard `error`
  // ends the process. A connection that failed keeps this listener as it is
  // destroyed: ending a dead socket can raise another.
  const heard = (error: Error) => {
    hold.lost = true;
    logger.warn(`[doors] the connection holding ${held} failed during a door`, { teamId, cause: error.message });
  };
  lock.on('error', heard);
  let healthy = false;
  try {
    try {
      await lock.query('begin');
      const left = Math.max(1, DOOR_WAIT_MS - (Date.now() - asked));
      await lock.query("select set_config('lock_timeout', $1, true)", [`${left}ms`]);
      await input.take(lock);
    } catch (cause) {
      throw new DoorsTryAgain(`a door could not hold ${held} within ${DOOR_WAIT_MS} ms`, { cause });
    }
    let answer: T;
    try {
      answer = await underDoorsHold(hold, body);
    } catch (error) {
      if (hold.lost && !(error instanceof DoorsTryAgain)) throw new DoorsTryAgain(`the connection holding ${held} was lost during this door`, { cause: error });
      throw error;
    }
    try {
      await lock.query('commit');
    } catch (cause) {
      throw new DoorsTryAgain(`the connection holding ${held} was lost during this door`, { cause });
    }
    healthy = true;
    return answer;
  } finally {
    if (!healthy && !hold.lost) {
      // A body that failed, or a lock not granted, on a live connection: the pool can
      // have it back once it has let go.
      healthy = await lock.query('rollback').then(
        () => true,
        () => false,
      );
    }
    if (healthy) lock.removeListener('error', heard);
    lock.release(!healthy);
  }
}

/** Holds the team's doors for the rest of the open transaction, or fails with
 *  `DoorsTryAgain` when it cannot soon, as the doors would stand still behind it.
 *  Answers the database's clock once it has them, the instant a move is on the far
 *  side of. */
export async function holdDoorsAlone(exec: Exec, teamId: string): Promise<Date> {
  await boundingLockWaits(exec, { what: 'an upgrade', ms: UPGRADE_DOORS_WAIT_MS }, () => sql`select pg_advisory_xact_lock(hashtextextended(${doorsLockName(teamId)}::text, 0))`.execute(exec));
  const { rows } = await sql<{ at: Date }>`select clock_timestamp() as at`.execute(exec);
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('the database answered no clock');
  return at;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `fire_event` row's payload gains the mark before its delivery's
 *  arrivals: a run it starts reads its trigger's waits from there. */
export function markedPayload(kind: string, payload: unknown, mark: number): unknown {
  if (kind !== FIRE_EVENT || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  return { ...payload, arrivalMark: mark };
}

async function saveCheckpointIn(exec: Exec, input: { teamId: string; subscriptionId: string; checkpoint: unknown }): Promise<void> {
  await sql`
    insert into automations.inbound_checkpoint (team_id, subscription_id, checkpoint)
    values (${input.teamId}::uuid, ${input.subscriptionId}::text, ${JSON.stringify(input.checkpoint ?? null)}::text::jsonb)
    on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint, updated_at = now()`.execute(exec);
}

/** The team's deliveries, kept for `host`. */
export function deliveryRowStore(owner: { host: Host; teamId: string }): PlatformDeliveryRowStore {
  return {
    /**
     * The receipt first: a duplicate (its id, or its external id kept at its
     * subscription before, even by a transaction still open, which the unique
     * index waits on) writes nothing and answers `kept: false`. Then the
     * cursor, the waits of the runs it queues (from the mark before its
     * arrivals), its arrivals and the wakes they answer, and its rows.
     */
    async keepDelivery(input: PlatformKeepDelivery) {
      const { subscriptionId, delivery, arrivals } = input;
      const waits = input.waits ?? [];
      if (arrivals === undefined && waits.length > 0) {
        throw new Error("inbound.keepDelivery: `waits` came without `arrivals`; a delivery's waits are opened with its arrivals, under their team and adapter");
      }
      if (owner.host === 'platform') {
        for (const row of input.work) if (!isWorkKind(row.kind)) throw new Error(`'${row.kind}' is not a work kind this process knows`);
      }
      const written = await inKeepTransaction(async (trx) => {
        const { rows } =
          input.rawKept !== undefined
            ? await sql<{ id: string }>`
                update automations.delivery
                set judged_at = now(), external_id = case when external_id like ${WAITING_KEY_PREFIX + '%'} then null else external_id end, events = ${JSON.stringify(delivery.events)}::text::jsonb, event_count = ${delivery.events.length}::int,
                    request = coalesce(${delivery.request === undefined ? null : JSON.stringify(delivery.request)}::text::jsonb, request)
                where id = ${input.rawKept.id}::uuid and team_id = ${owner.teamId}::uuid and judged_at is null
                returning id::text as id`.execute(trx)
            : await sql<{ id: string }>`
                insert into automations.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, replay_of, events, event_count, request, judged_at, credentials_id)
                values (${delivery.id}::uuid, ${owner.teamId}::uuid, ${subscriptionId}::text, ${delivery.externalId ?? null}::text,
                        ${delivery.receivedAt}::timestamptz, ${delivery.source}::text, ${delivery.inline}::bool, ${delivery.replayOf ?? null}::uuid,
                        ${JSON.stringify(delivery.events)}::text::jsonb, ${delivery.events.length}::int,
                        ${delivery.request === undefined ? null : JSON.stringify(delivery.request)}::text::jsonb, now(), ${input.credentialsId ?? null}::uuid)
                on conflict do nothing returning id::text as id`.execute(trx);
        if (rows.length === 0) return null;
        if ('checkpoint' in input) await saveCheckpointIn(trx, { teamId: owner.teamId, subscriptionId, checkpoint: input.checkpoint });
        const mark = await arrivalMark(trx);
        let wakes: WaitWake[] | undefined;
        const queued: Queued[] = [];
        if (arrivals !== undefined) {
          await openDeliveryWaits(trx, { teamId: arrivals.teamId, adapterType: arrivals.adapterType, waits, since: mark });
          wakes = (await logArrivalsIn(trx, arrivals)).wakes;
        }
        for (const row of input.work) {
          queued.push(await queueRow(trx, { host: owner.host }, { ...row, payload: markedPayload(row.kind, row.payload, mark), teamId: row.teamId ?? owner.teamId }));
        }
        for (const wake of wakes ?? []) queued.push(await queueWake(trx, arrivals?.teamId ?? owner.teamId, wake));
        for (const fact of input.unjudged ?? []) await keepUnjudgedIn(trx, { tenant: owner.teamId }, fact);
        if (input.alongside !== undefined) queued.push(...(await input.alongside(trx)));
        return { mark, wakes, queued };
      });
      if (written === null) return { kept: false };
      await announceQueued(written.queued);
      return written.wakes === undefined
        ? { kept: true, arrivalMark: written.mark }
        : { kept: true, arrivalMark: written.mark, wakes: written.wakes };
    },

    async keepRawDelivery({ delivery, work }) {
      // The lock first, off the main pool: a keep waiting behind an upgrade holds
      // none of it, or enough of them would stop the door that upgrade waits for.
      // It is let go after the write commits, so the move sees what this queued.
      const written = await withDoorsHeld(owner.teamId, () => inKeepTransaction(async (trx) => {
        // A waiting key names a delivery only for as long as a provider retries.
        if (delivery.externalId !== null && delivery.externalId.startsWith(WAITING_KEY_PREFIX)) {
          await sql`
            update automations.delivery set external_id = null
            where team_id = ${owner.teamId}::uuid and subscription_id = ${delivery.subscriptionId}::text and external_id = ${delivery.externalId}::text
              and received_at < now() - interval '1 day'`.execute(trx);
        }
        const { rows } = await sql<{ id: string; received_at: Date }>`
          insert into automations.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, events, event_count, request, credentials_id)
          values (${delivery.id}::uuid, ${owner.teamId}::uuid, ${delivery.subscriptionId}::text, ${delivery.externalId}::text,
                  clock_timestamp(), ${delivery.source}::text, false, '[]'::jsonb, 0, ${JSON.stringify(delivery.request)}::text::jsonb, ${delivery.credentialsId}::uuid)
          on conflict do nothing returning id::text as id, received_at`.execute(trx);
        const first = rows[0];
        if (first === undefined) {
          const before = await sql<{ id: string; judged: boolean; received_at: Date }>`
            select id::text as id, judged_at is not null as judged, received_at from automations.delivery
            where team_id = ${owner.teamId}::uuid and subscription_id = ${delivery.subscriptionId}::text and external_id = ${delivery.externalId}::text`.execute(trx);
          const kept = before.rows[0];
          if (kept === undefined) throw new Error(`delivery ${delivery.id} conflicted with no kept delivery`);
          return { id: kept.id, alreadyKept: true, judged: kept.judged, keptAt: kept.received_at, queued: [] };
        }
        const queued: Queued[] = [];
        for (const row of await work(trx)) queued.push(await queueRow(trx, { host: owner.host }, { ...row, teamId: row.teamId ?? owner.teamId }));
        return { id: delivery.id, alreadyKept: false, judged: false, keptAt: first.received_at, queued };
      }));
      await announceQueued(written.queued);
      return { id: written.id, alreadyKept: written.alreadyKept, judged: written.judged, keptAt: written.keptAt };
    },

    async judgedEmpty({ id }) {
      await sql`
        update automations.delivery
        set judged_at = now(), external_id = case when external_id like ${WAITING_KEY_PREFIX + '%'} then null else external_id end
        where id = ${id}::uuid and team_id = ${owner.teamId}::uuid and judged_at is null`.execute(storeDb());
    },

    /** The row gave up: kept dead with its reason, never claimed again,
     *  unless re-armed since the claim (then only unleased). Burying a
     *  `fire_event` row drops the waits it opened for runs that never started. */
    async bury(work) {
      const claim = workClaimOf(work);
      await inStoreTransaction(async (trx) => {
        const { rows } = await sql<{ key: string }>`
          update automations.work set dead_at = now(), dead_reason = ${work.reason}::text
          where id = ${claim.id}::uuid and lease_token::text = ${claim.leaseToken}::text and updated_at = ${claim.claimedUpdatedAt}
          returning key`.execute(trx);
        await sql`
          update automations.work set lease_owner = null, lease_until = null, lease_token = null
          where id = ${claim.id}::uuid and lease_token::text = ${claim.leaseToken}::text`.execute(trx);
        const buried = rows[0];
        if (buried !== undefined) await dropUnstartedWaits(trx, buried.key);
      });
    },

    /** A row its caller queued a lease out and ran itself, done: deleted
     *  unless a live claim holds it, with the waits it opened for runs that
     *  never started. */
    async completeKey({ key }) {
      return inStoreTransaction(async (trx) => {
        const result = await sql`
          delete from automations.work
          where host = ${owner.host}::text and key = ${key}::text and dead_at is null and (lease_until is null or lease_until < now())`.execute(trx);
        const done = Number(result.numAffectedRows ?? 0) > 0;
        if (done) await dropUnstartedWaits(trx, key);
        return done;
      });
    },

    /** The kept delivery's external id cleared, its receipt kept: a sender's
     *  retry under that id is kept as a delivery of its own. */
    async forgetDeliveryId({ id }) {
      if (!UUID.test(id)) return;
      await sql`
        update automations.delivery set external_id = null where id = ${id}::uuid and team_id = ${owner.teamId}::uuid`.execute(storeDb());
    },
  };
}
