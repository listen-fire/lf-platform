// lf's callbacks on `automations.callback` (callbacks.* and records.closeRun),
// ported from pg_store.rs. The id is minted the platform's way (`cb_`), but an
// lf run's callback is not the platform door's: its URL is lf's, and the
// platform's door reads it as unknown. Here only the tenant's lf callbacks are
// reached.

import { sql } from 'kysely';

import { isCallbackId } from 'movement-engine/public/run-host';
import { mintCallbackId } from '../movement_engine/callback_store';
import { enqueueRow } from './work';
import {
  inTransaction,
  iso,
  lfRunOf,
  lfRunRow,
  notThisTenantsRun,
  pool,
  refuseAnotherTenant,
  type Exec,
  type LfTenant,
} from './scope';

/** A callback row as the store wire carries it (store_wire.rs `CallbackRecord`). */
interface CallbackRow {
  id: string;
  teamId: string;
  runId: string;
  address: string;
  params: unknown;
  state: unknown;
  calls: unknown;
  singleUse: boolean;
  expiresAt: string | null;
  status: string;
}

interface CallbackColumns {
  id: string;
  team_id: string;
  run_id: string;
  address: string;
  params: unknown;
  state: unknown;
  calls: unknown;
  single_use: boolean;
  expires_at: string | null;
  status: string;
}

const CALLBACK_COLUMNS = sql`c.id, c.team_id::text as team_id, c.run_id::text as run_id, c.address, c.params, c.state, c.calls,
  c.single_use, ${iso('c.expires_at')} as expires_at, c.status`;

function callbackOf(row: CallbackColumns): CallbackRow {
  return {
    id: row.id,
    teamId: row.team_id,
    runId: row.run_id,
    address: row.address,
    params: row.params,
    state: row.state,
    calls: row.calls,
    singleUse: row.single_use,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

/** The tenant's lf callbacks only. */
function ownCallback(scope: LfTenant) {
  return sql`(c.team_id = ${scope.tenant}::uuid and ${lfRunOf(scope, 'c.run_id')})`;
}

export async function mint(
  scope: LfTenant,
  input: { teamId: string; runId: string; address: string; params: unknown; state: unknown; singleUse: boolean; expiresAt: string | null },
): Promise<{ id: string }> {
  refuseAnotherTenant(scope, input.teamId);
  const id = mintCallbackId();
  const { rows } = await sql<{ id: string }>`
    insert into automations.callback (id, team_id, run_id, address, params, state, calls, single_use, expires_at, status)
    select ${id}::text, ${input.teamId}::uuid, r.id, ${input.address}::text, ${JSON.stringify(input.params)}::text::jsonb,
           ${JSON.stringify(input.state)}::text::jsonb, '[]'::jsonb, ${input.singleUse}::bool, ${input.expiresAt}::timestamptz, 'live'
    from automations.trigger_run r where r.id = ${input.runId}::uuid and ${lfRunRow(scope, 'r')}
    returning id`.execute(pool());
  if (rows.length === 0) throw notThisTenantsRun(input.runId);
  return { id };
}

export async function get(scope: LfTenant, input: { id: string }): Promise<CallbackRow | null> {
  // The prefix guard keeps a foreign payload from ever reaching a query.
  if (!isCallbackId(input.id)) return null;
  const { rows } = await sql<CallbackColumns>`
    select ${CALLBACK_COLUMNS} from automations.callback c where c.id = ${input.id}::text and ${ownCallback(scope)}`.execute(pool());
  const row = rows[0];
  return row === undefined ? null : callbackOf(row);
}

type CallbackClaim =
  | { kind: 'recorded'; callback: CallbackRow; callIndex: number }
  | { kind: 'not_found' }
  | { kind: 'closed'; callback: CallbackRow }
  | { kind: 'expired'; callback: CallbackRow };

/** The claim is one statement: single-use flips live → fired, a repeatable
 *  one appends, and its body's work row commits with it. One clock decides
 *  expiry and the call's instant: the database's. */
export async function record(scope: LfTenant, input: { id: string; values: unknown; bodyDueAt: string }): Promise<CallbackClaim> {
  if (!isCallbackId(input.id)) return { kind: 'not_found' };
  const values = JSON.stringify(input.values);
  return inTransaction(async (trx) => {
    const { rows: claimed } = await sql<CallbackColumns>`
      update automations.callback c set
        status = case when c.single_use then 'fired' else c.status end,
        fired_at = case when c.single_use then now() else c.fired_at end,
        calls = c.calls || jsonb_build_array(jsonb_build_object('at', ${iso('now()')}, 'values', ${values}::text::jsonb)),
        updated_at = now()
      where c.id = ${input.id}::text and ${ownCallback(scope)} and c.status = 'live' and (c.expires_at is null or c.expires_at > now())
      returning ${CALLBACK_COLUMNS}`.execute(trx);
    const row = claimed[0];
    if (row !== undefined) {
      const callback = callbackOf(row);
      const callIndex = (Array.isArray(callback.calls) ? callback.calls.length : 0) - 1;
      if (callIndex < 0) throw new Error(`callback ${input.id} recorded a call its ledger does not hold`);
      // The body's row (`callbackBodyWork`).
      await enqueueRow(trx, {
        kind: 'fire_callback',
        key: `fire_callback:${input.id}:${callIndex}`,
        payload: { callbackId: input.id, teamId: callback.teamId, callIndex },
        dueAt: input.bodyDueAt,
        teamId: callback.teamId,
      });
      return { kind: 'recorded', callback, callIndex };
    }
    const { rows: found } = await sql<CallbackColumns & { expired: boolean | null }>`
      select ${CALLBACK_COLUMNS}, c.expires_at <= now() as expired from automations.callback c
      where c.id = ${input.id}::text and ${ownCallback(scope)}`.execute(trx);
    const existing = found[0];
    if (existing === undefined) return { kind: 'not_found' };
    const callback = callbackOf(existing);
    // A new call: revoked or fired is closed; past its window, expired.
    return callback.status === 'live' && existing.expired === true ? { kind: 'expired', callback } : { kind: 'closed', callback };
  });
}

export async function markBodyStarted(scope: LfTenant, input: { id: string; callIndex: number; fence: string | null }): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    update automations.callback c set
      calls = jsonb_set(c.calls, array[${input.callIndex}::int8::text], (c.calls -> (${input.callIndex}::int8)::int4) || jsonb_build_object('bodyStartedAt', ${iso('now()')})),
      updated_at = now()
    where c.id = ${input.id}::text and ${ownCallback(scope)}
      and (${input.fence}::text is null or exists (select 1 from automations.trigger_run r where r.id = c.run_id and r.lease_token::text = ${input.fence}::text))
    returning c.id`.execute(pool());
  return rows.length > 0;
}

/** Those of `ids` with at least one call whose body started, in their order. */
export async function landed(scope: LfTenant, input: { ids: string[] }): Promise<string[]> {
  const ids = input.ids.filter(isCallbackId);
  if (ids.length === 0) return [];
  const { rows } = await sql<{ id: string }>`
    select c.id from automations.callback c
    where c.id = any(${ids}::text[]) and ${ownCallback(scope)}
      and exists (select 1 from jsonb_array_elements(c.calls) as call where call ? 'bodyStartedAt')`.execute(pool());
  const found = new Set(rows.map((r) => r.id));
  return ids.filter((id) => found.has(id));
}

/** Only ever touches live rows: a fired single-use keeps its `fired`. */
export async function revokeRunCallbacks(exec: Exec, scope: LfTenant, runId: string): Promise<null> {
  await sql`
    update automations.callback c set status = 'revoked', revoked_at = now(), updated_at = now()
    where c.run_id = ${runId}::uuid and ${ownCallback(scope)} and c.status = 'live'`.execute(exec);
  return null;
}
