// lf's run records on `automations.trigger_run` (runs.* and records.*),
// ported from lf's own Postgres store (crates/lf/src/pg_store.rs), whose shapes
// these are: `trigger_id` is the listen's pipeline (`listen:<file>:<movement>`),
// `trigger_payload` holds the file, the movement and the run's facts (their
// JSON text verbatim), `nodes_written` its writes, `failure_reason` its error,
// `returned` what its movement returned. The trace is a movement step per
// segment on `steps`, at `diagnostics.trace`, where the platform keeps its own.
//
// What differs from pg_store: the row is marked `host = 'lf'`, and that mark,
// not the shape of `trigger_payload`, is what makes a run lf's; every
// statement is held to the tenant; a fresh run's heartbeat is stamped, so no
// platform reader takes a live first firing for a dead one.

import { sql } from 'kysely';

import { revokeRunCallbacks } from './callbacks';
import { inTransaction, iso, lfRunRow, pool, type Exec, type LfTenant } from './scope';

/** The platform names a completed run `success`; lf names it `completed`.
 *  Every other status is the same word on both. */
function hostedStatus(status: string): string {
  return status === 'completed' ? 'success' : status;
}

export function lfStatus(status: string): string {
  return status === 'success' ? 'completed' : status;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface RunStart {
  id: string;
  file: string;
  movement: string;
  startedAt: string;
  input: string;
  deliveryId: string | null;
}

/** A run row as the store wire carries it (store_wire.rs `RunRow`). */
interface RunRow {
  id: string;
  file: string;
  movement: string;
  status: string;
  startedAt: string;
  input: string;
  outcome: string | null;
  deliveryId: string | null;
}

interface RunColumns {
  id: string;
  file: string | null;
  movement: string | null;
  status: string;
  started_at: string;
  facts: string | null;
  writes: number;
  failure_reason: string | null;
  returned: string | null;
  delivery_id: string | null;
}

const RUN_COLUMNS = sql`r.id::text as id, r.trigger_payload->>'file' as file, r.trigger_payload->>'movement' as movement,
  r.status, ${iso('r.started_at')} as started_at, r.trigger_payload->>'facts' as facts, r.nodes_written as writes,
  r.failure_reason, r.returned::text as returned, r.delivery_id::text as delivery_id`;

function runOf(row: RunColumns): RunRow {
  const lfField = (value: string | null, name: string): string => {
    if (value === null) throw new Error(`run ${row.id} is not one of lf's runs (its trigger_payload has no ${name})`);
    return value;
  };
  const status = lfStatus(row.status);
  // The outcome is written as lf wrote it, `returned` from its own column's
  // text: json, not jsonb, so the value's keys read back in their order.
  const outcome =
    status === 'failed'
      ? JSON.stringify({ error: row.failure_reason ?? '' })
      : row.returned === null
        ? JSON.stringify({ writes: row.writes })
        : `{"writes":${row.writes},"returned":${row.returned}}`;
  return {
    id: row.id,
    file: lfField(row.file, 'file'),
    movement: lfField(row.movement, 'movement'),
    status,
    startedAt: row.started_at,
    input: lfField(row.facts, 'facts'),
    outcome,
    deliveryId: row.delivery_id,
  };
}

export async function startRunRow(exec: Exec, scope: LfTenant, run: RunStart): Promise<void> {
  const trigger = `listen:${run.file}:${run.movement}`;
  await sql`
    insert into automations.trigger_run
      (id, team_id, host, trigger_id, trigger_type, status, started_at, last_heartbeat_at, trigger_payload, delivery_id)
    values (${run.id}::text::uuid, ${scope.tenant}::uuid, 'lf', ${trigger}::text, 'webhook', 'running', ${run.startedAt}::timestamptz, now(),
            jsonb_build_object('file', ${run.file}::text, 'movement', ${run.movement}::text, 'facts', ${run.input}::text), ${run.deliveryId}::uuid)`.execute(exec);
}

export async function startRun(scope: LfTenant, run: RunStart): Promise<null> {
  await startRunRow(pool(), scope, run);
  return null;
}

/** Runs still `running` whose lease lapsed or was never taken, started more
 *  than `staleMs` ago, oldest first, by the database's clock: lf fails them. */
export async function lapsedRuns(scope: LfTenant, input: { staleMs: number; limit: number }): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    select r.id::text as id from automations.trigger_run r
    where ${lfRunRow(scope, 'r')} and r.status = 'running'
      and (r.lease_until is null or r.lease_until < now()) and r.started_at < now() - ${input.staleMs}::int8 * interval '1 millisecond'
    order by r.started_at limit ${input.limit}::int8`.execute(pool());
  return rows.map((r) => r.id);
}

export async function settleRun(
  scope: LfTenant,
  input: { runId: string; status: string; outcome: unknown; at: string },
): Promise<null> {
  const status = hostedStatus(input.status);
  const outcome = input.outcome !== null && typeof input.outcome === 'object' && !Array.isArray(input.outcome) ? input.outcome : {};
  const writes = Reflect.get(outcome, 'writes');
  const error = Reflect.get(outcome, 'error');
  const returned = 'returned' in outcome ? JSON.stringify(Reflect.get(outcome, 'returned')) : null;
  await inTransaction(async (trx) => {
    await sql`
      update automations.trigger_run r set
        status = ${status}::text,
        nodes_written = coalesce(${Number.isInteger(writes) ? writes : null}::int, r.nodes_written),
        failure_reason = case when ${status}::text = 'failed' then ${typeof error === 'string' ? error : null}::text else r.failure_reason end,
        completed_at = case when ${status}::text = 'success' then ${input.at}::timestamptz else r.completed_at end,
        failed_at = case when ${status}::text = 'failed' then ${input.at}::timestamptz else r.failed_at end,
        returned = ${returned}::text::json
      where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(trx);
    if (status === 'success' || status === 'failed') await revokeRunCallbacks(trx, scope, input.runId);
  });
  return null;
}

export async function markParked(exec: Exec, scope: LfTenant, runId: string): Promise<null> {
  await sql`
    update automations.trigger_run r set status = 'parked'
    where r.id = ${runId}::uuid and ${lfRunRow(scope, 'r')} and r.status in ('running', 'parked')`.execute(exec);
  return null;
}

export async function markFailed(scope: LfTenant, input: { runId: string; message: string }): Promise<null> {
  await inTransaction(async (trx) => {
    await sql`
      update automations.trigger_run r set status = 'failed', failed_at = now(), failure_reason = ${input.message}::text
      where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')} and r.status in ('running', 'parked')`.execute(trx);
    await revokeRunCallbacks(trx, scope, input.runId);
  });
  return null;
}

export async function cancelRequest(scope: LfTenant, input: { runId: string }): Promise<{ reason: string | null } | null> {
  const { rows } = await sql<{ asked: boolean; reason: string | null }>`
    select r.cancel_requested_at is not null as asked, r.cancel_reason as reason from automations.trigger_run r
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(pool());
  const row = rows[0];
  return row?.asked === true ? { reason: row.reason } : null;
}

export async function requestCancel(scope: LfTenant, input: { runId: string; reason: string | null }): Promise<null> {
  await sql`
    update automations.trigger_run r set cancel_requested_at = now(), cancel_reason = ${input.reason}::text
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(pool());
  return null;
}

export async function getRun(scope: LfTenant, input: { runId: string }): Promise<RunRow | null> {
  if (!isUuid(input.runId)) return null;
  const { rows } = await sql<RunColumns>`
    select ${RUN_COLUMNS} from automations.trigger_run r where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(pool());
  const row = rows[0];
  return row === undefined ? null : runOf(row);
}

export async function listRuns(scope: LfTenant, input: { limit: number }): Promise<RunRow[]> {
  const { rows } = await sql<RunColumns>`
    select ${RUN_COLUMNS} from automations.trigger_run r where ${lfRunRow(scope, 'r')}
    order by r.started_at desc limit ${input.limit}::int8`.execute(pool());
  return rows.map(runOf);
}

/** The run's status, or `missing`: the contract suite's helper. */
export async function runStatus(scope: LfTenant, input: { runId: string }): Promise<string> {
  return (await getRun(scope, input))?.status ?? 'missing';
}

/** Each segment's entries in its own movement step on `steps`, at
 *  `diagnostics.trace`, so the platform's inspection reads lf's runs as its
 *  own. A segment's later entries extend its step, found by its `segmentId`. */
export async function appendTrace(scope: LfTenant, input: { runId: string; segmentId: string; entries: unknown[] }): Promise<null> {
  const entries = JSON.stringify(input.entries);
  await sql`
    update automations.trigger_run r set steps = case
      when r.steps -> -1 ->> 'segmentId' = ${input.segmentId}::text
        then jsonb_set(r.steps, array[(jsonb_array_length(r.steps) - 1)::text, 'diagnostics', 'trace'],
                       coalesce(r.steps -> -1 -> 'diagnostics' -> 'trace', '[]'::jsonb) || ${entries}::text::jsonb)
      else r.steps || jsonb_build_array(jsonb_build_object(
        'tgId', r.trigger_id, 'tgName', null, 'sourceAdapterType', null, 'targetAdapterType', null,
        'status', 'success', 'appliedActionPlans', '[]'::jsonb, 'errors', '[]'::jsonb, 'engine', 'interpreter',
        'diagnostics', jsonb_build_object('trace', ${entries}::text::jsonb), 'segmentId', ${input.segmentId}::text))
    end
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(pool());
  return null;
}

export async function traceLength(scope: LfTenant, input: { runId: string }): Promise<number> {
  const { rows } = await sql<{ length: number }>`
    select coalesce(sum(jsonb_array_length(step -> 'diagnostics' -> 'trace')), 0)::int as length
    from automations.trigger_run r, jsonb_array_elements(r.steps) as step
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')} and jsonb_typeof(step -> 'diagnostics' -> 'trace') = 'array'`.execute(pool());
  return rows[0]?.length ?? 0;
}

/** The platform's run total (`diagnostics.costMicrodollars`), less the cap's baseline. */
export async function runSpent(scope: LfTenant, input: { runId: string }): Promise<number> {
  const { rows } = await sql<{ spent: number }>`
    select (coalesce((r.diagnostics ->> 'costMicrodollars')::float8, (r.diagnostics ->> 'costUsd')::float8 * 1000000, 0)
            - r.cost_cap_baseline_microdollars)::float8 as spent
    from automations.trigger_run r where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(pool());
  return rows[0]?.spent ?? 0;
}

export async function addRunSpend(scope: LfTenant, input: { runId: string; microdollars: number }): Promise<null> {
  await sql`
    update automations.trigger_run r set diagnostics = r.diagnostics
      || jsonb_build_object('costMicrodollars', coalesce((r.diagnostics ->> 'costMicrodollars')::float8, 0) + ${input.microdollars}::float8)
      || jsonb_build_object('costUsd', (coalesce((r.diagnostics ->> 'costMicrodollars')::float8, 0) + ${input.microdollars}::float8) / 1000000)
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(pool());
  return null;
}

export async function resetSpendBaseline(scope: LfTenant, input: { runId: string }): Promise<null> {
  await sql`
    update automations.trigger_run r set cost_cap_baseline_microdollars = round(coalesce((r.diagnostics ->> 'costMicrodollars')::float8, 0))::int8
    where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}`.execute(pool());
  return null;
}
