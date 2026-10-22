// Whose rows a request reaches, and the few SQL pieces every family shares.
//
// One request is one tenant's: the team that owns the key it came with. Every
// statement is held to that team and to lf's rows (host = 'lf'): the tables are
// the platform's own, so a statement that forgot either would reach another
// tenant's runs or the platform's. Rows that carry no team of their own (a
// leaf, a join, a correlation's run) are reached through their run.
//
// The module keeps no state between requests: a cloud lf talks to it with
// `RpcStoreBackend(address)`, which never sends `store.open`, so the tenant is
// read off each request, never off an opened session.

import { sql, type QueryExecutorProvider, type RawBuilder } from 'kysely';
import { SlotRefusal } from 'module-runtime/module_wire/wire';

import { getAutomationsQb } from '../../lib/kysely';

/** The tenant a request acts in: its key owner's team id. */
export interface LfTenant {
  readonly tenant: string;
}

/** Anything a statement runs on: the pool, or one transaction. */
export type Exec = QueryExecutorProvider;

const TABLES = [
  'trigger_run',
  'parked_run',
  'join_pending',
  'join_branch_export',
  'adapter_await',
  'park_library_source',
  'work',
  'callback',
  'inbound_checkpoint',
  'event_receipt',
  'module_processes',
  'delivery',
] as const;

/** The pool, outside any transaction a request context might hold: the
 *  system router opens none, and a composite write opens its own. */
export function pool(): Exec {
  return getAutomationsQb(TABLES);
}

/** One write that is all of it or none. */
export function inTransaction<T>(body: (trx: Exec) => Promise<T>): Promise<T> {
  return getAutomationsQb(TABLES)
    .transaction()
    .execute((trx) => body(trx));
}

/** An instant as `Date.toISOString` writes it, by the database's clock
 *  (pg_store.rs `iso!`). `column` is always a constant of this module. */
export function iso(column: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.raw(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** The run named by `runIdColumn` is one of this tenant's lf runs. */
export function lfRunOf(scope: LfTenant, runIdColumn: string): RawBuilder<boolean> {
  return sql<boolean>`exists (select 1 from automations.trigger_run own
    where own.id = ${sql.raw(runIdColumn)} and own.team_id = ${scope.tenant}::uuid and own.host = 'lf')`;
}

/** A `trigger_run` row under `alias` is one of this tenant's lf runs. */
export function lfRunRow(scope: LfTenant, alias: string): RawBuilder<boolean> {
  return sql<boolean>`(${sql.raw(alias)}.team_id = ${scope.tenant}::uuid and ${sql.raw(alias)}.host = 'lf')`;
}

/** A team id a request names reaches only its own tenant's rows. A read
 *  naming another answers nothing; a write naming one is refused. */
export function namesTenant(scope: LfTenant, teamId: string): boolean {
  return teamId === scope.tenant;
}

export function refuseAnotherTenant(scope: LfTenant, teamId: string | null): void {
  if (teamId !== null && !namesTenant(scope, teamId)) {
    throw new SlotRefusal('bad_request', `teamId names another tenant's team: this key writes only its own (${scope.tenant})`);
  }
}

/** A write against a run the tenant has no lf run of. */
export function notThisTenantsRun(runId: string): SlotRefusal {
  return new SlotRefusal('bad_request', `run ${runId} is not one of this tenant's lf runs`);
}

/** A fenced write found the run's lease gone: lf treats it as losing the run. */
export function leaseLost(runId: string): SlotRefusal {
  return new SlotRefusal('run_lease_lost', 'run lease lost; another instance may hold the run', { runId });
}

/** Why a fenced write wrote nothing (pg_store.rs `not_written`): the lease is
 *  another's now, or, with no lease to fence by, the run has no row of this
 *  tenant's to write against. */
export function notWritten(runId: string, fence: string | null): Error {
  return fence !== null ? leaseLost(runId) : new Error(`run ${runId} has no trigger_run row to park on`);
}

/** The run is still leased under the token: compared as text, so a token that
 *  is not a uuid holds nothing rather than failing (pg_store.rs `LEASED_TO`). */
export function leasedTo(alias: string, token: string): RawBuilder<boolean> {
  return sql<boolean>`${sql.raw(alias)}.lease_token::text = ${token}`;
}
