// The work rows the run-host store queues inside its own writes: a timer's
// `resume_timer`, a race's `settle_race`, a wait's `wake_await` and a kept
// delivery's rows. Each lands in the caller's transaction, so a crash leaves
// the row and what it is the work of, or neither; the platform's drain is told
// once the write commits (`announceQueued`).
//
// A run's rows are its host's ('platform' or 'lf': whichever drain steps it),
// read off the run in the same statement; a delivery's rows are the host's
// that kept it.

import { randomUUID } from 'node:crypto';

import { sql, type QueryExecutorProvider } from 'kysely';
import { WAKE_AWAIT_WORK_KIND, type ClaimedWork, type WaitWake } from 'movement-engine/public/run-host';
import { z } from 'zod';

import { getAutomationsQb } from '../../lib/kysely';
import { announceWork } from '../work/wake';

// The engine's own rows the store queues in its writes: a race a run owes,
// and the runs a kept delivery queues. Claimed by the process that registers
// their handlers (the run host's drain); until one does, they wait.
declare module '../work/kinds' {
  interface UnitWorkKinds {
    settle_race: true;
    fire_event: true;
  }
}

/** Anything a statement runs on: the pool, or one transaction. */
export type Exec = QueryExecutorProvider;

/** Whose drain claims a row. */
export type Host = 'platform' | 'lf';

/** The tables the store's typed statements touch; raw statements name theirs. */
const TABLES = ['trigger_run', 'parked_run', 'join_pending', 'join_branch_export', 'work'] as const;

export function storeDb() {
  return getAutomationsQb(TABLES);
}

/** One write that is all of it or none. */
export function inStoreTransaction<T>(body: (trx: ReturnType<typeof storeDb>) => Promise<T>): Promise<T> {
  return storeDb()
    .transaction()
    .execute((trx) => body(trx));
}

export interface QueuedRow {
  kind: string;
  key: string;
  payload: unknown;
  /** Absent or null: due now. */
  dueAt?: string | null;
  teamId?: string | null;
}

/** A row queued in a write, for the drain to be told of once it commits. */
export interface Queued {
  host: Host;
  kind: string;
  dueAt: Date;
}

/** Whose row it is: a run's (its host's), or a host's own. */
export type RowOwner = { runId: string } | { host: Host };

function hostOf(owner: RowOwner) {
  return 'runId' in owner
    ? sql<Host>`(select r.host from automations.trigger_run r where r.id = ${owner.runId}::uuid)`
    : sql<Host>`${owner.host}::text`;
}

const HOSTS: ReadonlySet<string> = new Set<Host>(['platform', 'lf']);

function isHost(value: string): value is Host {
  return HOSTS.has(value);
}

/**
 * Queue by key, as `work.enqueue` does. Against a row whose lease is live the
 * new due time wins (a re-arm during the run); against an unleased one the
 * earliest. A dead row comes back, its attempts from nought. The row's
 * version moves, so a claim taken before the re-arm completes nothing.
 */
export async function queueRow(exec: Exec, owner: RowOwner, row: QueuedRow): Promise<Queued> {
  const { rows } = await sql<{ host: string; due_at: Date }>`
    insert into automations.work (host, kind, key, team_id, payload, due_at, updated_at)
    values (${hostOf(owner)}, ${row.kind}::text, ${row.key}::text, ${row.teamId ?? null}::uuid,
            ${JSON.stringify(row.payload ?? {})}::text::jsonb, coalesce(${row.dueAt ?? null}::timestamptz, now()),
            date_trunc('milliseconds', clock_timestamp()))
    on conflict (host, key) do update set
      due_at = case when work.dead_at is not null then excluded.due_at
                    when work.lease_until > now() then excluded.due_at else least(work.due_at, excluded.due_at) end,
      payload = excluded.payload,
      attempts = case when work.dead_at is null then work.attempts else 0 end,
      dead_at = null,
      dead_reason = null,
      team_id = coalesce(excluded.team_id, work.team_id),
      updated_at = greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', work.updated_at) + interval '1 millisecond')
    returning host, due_at`.execute(exec);
  const queued = rows[0];
  if (queued === undefined || !isHost(queued.host)) throw new Error(`work row ${row.key} was not queued`);
  return { host: queued.host, kind: row.kind, dueAt: queued.due_at };
}

/** One wait's `wake_await` row, due now and never coalesced: its run re-enters
 *  the await parked at the wait's address, which reads the wait's arrivals. */
export function queueWake(exec: Exec, teamId: string, wake: WaitWake): Promise<Queued> {
  return queueRow(exec, { runId: wake.runId }, {
    kind: WAKE_AWAIT_WORK_KIND,
    key: `${WAKE_AWAIT_WORK_KIND}:${randomUUID()}`,
    payload: { waitId: wake.waitId, runId: wake.runId, address: wake.address },
    teamId,
  });
}

/** A work claim's handle: the lease it took and the row version it saw, which
 *  is what tells a completion that the row was re-armed since. */
const WorkClaim = z.object({ leaseToken: z.string(), claimedUpdatedAt: z.iso.datetime() });

export function workClaimOf(work: ClaimedWork): { id: string; leaseToken: string; claimedUpdatedAt: Date } {
  const claim = WorkClaim.parse(JSON.parse(work.claim));
  return { id: work.id, leaseToken: claim.leaseToken, claimedUpdatedAt: new Date(claim.claimedUpdatedAt) };
}

/** Tell the platform's drain of the rows a committed write queued. A wake is
 *  a latency hint: the rows are in the table whether or not it is told. */
export async function announceQueued(queued: readonly Queued[]): Promise<void> {
  for (const row of queued) if (row.host === 'platform') await announceWork(row.kind, row.dueAt);
}
