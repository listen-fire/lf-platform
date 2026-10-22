// lf's work rows on `automations.work` (work.*), ported from pg_store.rs. A
// row of lf's is marked `host = 'lf'`: the platform's drain never claims it,
// and this module never claims the platform's. Leases and due times are judged
// by the database's clock; a claim is the lease token and the row version it
// saw, so a completion can tell that the row was re-armed since.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { sql } from 'kysely';

import { inTransaction, iso, pool, refuseAnotherTenant, type Exec, type LfTenant } from './scope';

/** lf's work kinds (crates/lf/src/store.rs `WORK_KINDS`). */
export const LF_WORK_KINDS = ['resume_timer', 'wake_await', 'fire_event', 'fire_callback', 'poll_listen'] as const;

function isLfWorkKind(kind: string): boolean {
  return (LF_WORK_KINDS as readonly string[]).includes(kind);
}

/** Who holds a work lease this process took: informational (the token fences). */
const LEASE_OWNER = `lf-store:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** The row's next version: millisecond-exact, strictly increasing however
 *  close two writes land (pg_store.rs `NEXT_VERSION_OF_WORK`). */
const NEXT_VERSION_OF_WORK = sql`greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', work.updated_at) + interval '1 millisecond')`;
const NEXT_VERSION_OF_W = sql`greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', w.updated_at) + interval '1 millisecond')`;

/** The rows of this tenant's that are lf's. */
function lfWorkOf(scope: LfTenant, alias: string) {
  return sql`(${sql.raw(alias)}.host = 'lf' and ${sql.raw(alias)}.team_id = ${scope.tenant}::uuid)`;
}

export interface NewWorkRow {
  kind: string;
  key: string;
  payload: unknown;
  dueAt: string | null;
  /** Resolved by the caller: the tenant, or a team id it has checked is the tenant. */
  teamId: string;
}

/**
 * Queues a row, or re-arms the row of its key: against a held row the new due
 * time wins (its holder's completion leaves the row for the re-arm), and a
 * dead row queued again is new work, its attempts from nought. The key is
 * unique per host, not per team, so a key another tenant's row holds is
 * refused rather than taken over.
 */
export async function enqueueRow(exec: Exec, row: NewWorkRow): Promise<void> {
  if (!isLfWorkKind(row.kind)) throw new Error(`not a work kind: ${row.kind}`);
  const { rows } = await sql<{ id: string }>`
    insert into automations.work as work (host, kind, key, team_id, payload, due_at, updated_at)
    values ('lf', ${row.kind}::text, ${row.key}::text, ${row.teamId}::uuid, ${JSON.stringify(row.payload ?? null)}::text::jsonb,
            coalesce(${row.dueAt}::timestamptz, now()), date_trunc('milliseconds', clock_timestamp()))
    on conflict (host, key) do update set
      due_at = case when work.dead_at is not null then excluded.due_at
                    when work.lease_until > now() then excluded.due_at else least(work.due_at, excluded.due_at) end,
      payload = excluded.payload,
      attempts = case when work.dead_at is null then work.attempts else 0 end,
      dead_at = null,
      dead_reason = null,
      updated_at = ${NEXT_VERSION_OF_WORK}
    where work.team_id = excluded.team_id
    returning work.id::text as id`.execute(exec);
  if (rows.length === 0) throw new Error(`work key ${row.key} is held by another tenant's row`);
}

/** `work.enqueue`: an absent team is the tenant's; another team's is refused. */
export async function enqueue(scope: LfTenant, input: Omit<NewWorkRow, 'teamId'> & { teamId: string | null }): Promise<null> {
  refuseAnotherTenant(scope, input.teamId);
  await enqueueRow(pool(), { ...input, teamId: input.teamId ?? scope.tenant });
  return null;
}

/** The kinds a claim takes: the ones named, every one of lf's when none are. */
function kindsOf(kinds: readonly string[] | null): readonly string[] {
  if (kinds === null) return LF_WORK_KINDS;
  const other = kinds.find((kind) => !isLfWorkKind(kind));
  if (other !== undefined) throw new Error(`not a work kind: ${other} (the kinds: ${LF_WORK_KINDS.join(', ')})`);
  return kinds;
}

/** One statement, so two drainers cannot race: SKIP LOCKED hands each a
 *  disjoint set, and MATERIALIZED fixes the selection before the update. */
export async function claimDue(
  scope: LfTenant,
  input: { limit: number; leaseMs: number; dueBy: string | null; kinds: readonly string[] | null },
): Promise<{ id: string; kind: string; key: string; payload: unknown; claim: string; attempts: number }[]> {
  const kinds = kindsOf(input.kinds);
  const { rows } = await sql<{ id: string; kind: string; key: string; payload: unknown; lease_token: string; version: string; attempts: number }>`
    with c as materialized (
      select work.id from automations.work work
      where work.due_at <= coalesce(${input.dueBy}::timestamptz, now()) and (work.lease_until is null or work.lease_until < now())
        and work.dead_at is null and work.kind = any(${[...kinds]}::text[]) and ${lfWorkOf(scope, 'work')}
      order by work.due_at
      limit ${input.limit}::int8
      for update skip locked
    )
    update automations.work w
    set lease_owner = ${LEASE_OWNER}::text, lease_until = now() + ${input.leaseMs}::int8 * interval '1 millisecond', lease_token = gen_random_uuid(),
        attempts = w.attempts + 1, updated_at = ${NEXT_VERSION_OF_W}
    from c where w.id = c.id
    returning w.id::text as id, w.kind, w.key, w.payload, w.lease_token::text as lease_token, ${iso('w.updated_at')} as version, w.attempts`.execute(pool());
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    key: r.key,
    payload: r.payload,
    claim: JSON.stringify({ leaseToken: r.lease_token, claimedUpdatedAt: r.version }),
    attempts: r.attempts,
  }));
}

/** A work claim's handle, as claimDue wrote it. */
function workClaim(claim: string): { token: string; version: string } {
  const not = () => new Error(`not a work claim: ${claim}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(claim);
  } catch {
    throw not();
  }
  if (parsed === null || typeof parsed !== 'object') throw not();
  const token = Reflect.get(parsed, 'leaseToken');
  const version = Reflect.get(parsed, 'claimedUpdatedAt');
  if (typeof token !== 'string' || typeof version !== 'string') throw not();
  return { token, version };
}

function held(scope: LfTenant, id: string, token: string) {
  return sql`(work.id = ${id}::uuid and work.lease_token::text = ${token} and ${lfWorkOf(scope, 'work')})`;
}

/** Deleted unless re-armed since the claim (its version moved): then its
 *  lease clears and it runs again at its due time. */
export async function complete(scope: LfTenant, input: { id: string; claim: string }): Promise<null> {
  const { token, version } = workClaim(input.claim);
  const exec = pool();
  await sql`
    delete from automations.work work
    where ${held(scope, input.id, token)} and work.interval_ms is null and work.updated_at = ${version}::timestamptz`.execute(exec);
  await sql`
    update automations.work work set lease_owner = null, lease_until = null, lease_token = null, attempts = 0, deferrals = 0,
      due_at = case when work.interval_ms is null then work.due_at else now() + work.interval_ms * interval '1 millisecond' end
    where ${held(scope, input.id, token)}`.execute(exec);
  return null;
}

/** Why a row goes back: an attempt that failed, a run busy elsewhere (the
 *  attempt is given back), or done and due again (the attempts start over). */
function attemptsAfter(why: string | null) {
  switch (why) {
    case null:
    case 'failed':
      return sql`work.attempts`;
    case 'busy':
      return sql`greatest(work.attempts - 1, 0), deferrals = work.deferrals + 1`;
    case 'rescheduled':
      return sql`0, deferrals = 0`;
    default:
      throw new Error(`not a release: ${why} (failed, busy or rescheduled)`);
  }
}

/** Unleased for a retry at `dueAt`, unless re-armed since the claim. */
export async function release(scope: LfTenant, input: { id: string; claim: string; dueAt: string | null; why: string | null }): Promise<null> {
  const { token, version } = workClaim(input.claim);
  const attempts = attemptsAfter(input.why);
  await sql`
    update automations.work work set lease_owner = null, lease_until = null, lease_token = null, attempts = ${attempts},
      due_at = case when work.updated_at = ${version}::timestamptz then coalesce(${input.dueAt}::timestamptz, work.due_at) else work.due_at end
    where ${held(scope, input.id, token)}`.execute(pool());
  return null;
}

/** The row gave up: kept dead with why, never claimed again; unless it was
 *  re-armed since the claim, when it is only unleased. */
export async function bury(scope: LfTenant, input: { id: string; claim: string; reason: string }): Promise<null> {
  const { token, version } = workClaim(input.claim);
  await inTransaction(async (trx) => {
    await sql`
      update automations.work work set dead_at = now(), dead_reason = ${input.reason}::text
      where ${held(scope, input.id, token)} and work.updated_at = ${version}::timestamptz`.execute(trx);
    await sql`
      update automations.work work set lease_owner = null, lease_until = null, lease_token = null
      where ${held(scope, input.id, token)}`.execute(trx);
  });
  return null;
}
