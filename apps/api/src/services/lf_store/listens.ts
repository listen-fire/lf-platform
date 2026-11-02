// What lf keeps per listen and per record write, ported from pg_store.rs over
// automations.listen_state and write_ledger, one tenant's rows each:
//   listens.*  what a listen whose earlier hops lf resolves was last resolved
//              to, why its last resolve failed and why it is paused, under a
//              hold that lets one process resolve it at a time; how many
//              arrivals it held while paused
//   writes.*   the loop breaker's ledger: each record write a run sent, with
//              its place in its chain of writes and arrivals
// A resolve never writes `paused` or `held`; a pause never writes the rest.

import { sql } from 'kysely';
import { z } from 'zod';

import { inTransaction, pool, type LfTenant } from './scope';

// ── Listen states ───────────────────────────────────────────────────────────

/** What a listen's last resolve came to, as lf saves it. */
export interface Resolution {
  heads: string[];
  resolvedAt: string | null;
  failure: string | null;
  /** By the hop's edge, the records it is watched under; absent: none. */
  parents?: Record<string, string[]>;
}

const StoredState = z.object({
  heads: z.array(z.string()),
  resolvedAt: z.string().nullable(),
  failure: z.string().nullable(),
  parents: z.record(z.string(), z.array(z.string())).nullish(),
  paused: z.string().nullish(),
  // A state kept before the count holds none: no arrival held.
  held: z.number().int().nullish(),
});

/** A listen's state as the wire carries it: `parents` only when it has some. */
function stateOf(stored: unknown) {
  const state = StoredState.parse(stored);
  const parents = state.parents ?? {};
  return {
    heads: state.heads,
    resolvedAt: state.resolvedAt,
    failure: state.failure,
    paused: state.paused ?? null,
    held: state.held ?? 0,
    ...(Object.keys(parents).length > 0 ? { parents } : {}),
  };
}

/** A listen never resolved, nothing held: what a first hold or pause keeps. */
function freshState(paused: string | null): string {
  return JSON.stringify({ heads: [], resolvedAt: null, failure: null, paused, held: 0 });
}

/** One member per listen named that has a state. */
export async function states(scope: LfTenant, input: { pipelines: string[] }): Promise<Record<string, ReturnType<typeof stateOf>>> {
  const { rows } = await sql<{ pipeline: string; state: unknown }>`
    select pipeline, state from automations.listen_state
    where team_id = ${scope.tenant}::uuid and pipeline = any(${input.pipelines}::text[])`.execute(pool());
  return Object.fromEntries(rows.map((row) => [row.pipeline, stateOf(row.state)]));
}

/** Holds the listen's resolve for `ttlMs` while no other hold is live; a
 *  listen with no state gets one, never resolved. */
export async function claimResolve(scope: LfTenant, input: { pipeline: string; ttlMs: number }): Promise<{ token: string } | null> {
  const { rows } = await sql<{ token: string }>`
    insert into automations.listen_state as listen_state (team_id, pipeline, state, lease_token, lease_until)
    values (${scope.tenant}::uuid, ${input.pipeline}::text, ${freshState(null)}::text::jsonb, gen_random_uuid(),
            now() + ${input.ttlMs}::int8 * interval '1 millisecond')
    on conflict (team_id, pipeline) do update set lease_token = excluded.lease_token, lease_until = excluded.lease_until, updated_at = now()
    where listen_state.lease_until is null or listen_state.lease_until < now()
    returning lease_token::text as token`.execute(pool());
  const claimed = rows[0];
  return claimed === undefined ? null : { token: claimed.token };
}

/** The resolution replaces the state but for `paused` and `held`, and the hold
 *  is let go; `false`, nothing written, when the hold lapsed and was taken since. */
export async function saveResolution(scope: LfTenant, input: { pipeline: string; token: string; resolution: Resolution }): Promise<boolean> {
  const { heads, resolvedAt, failure, parents } = input.resolution;
  const resolution = JSON.stringify({ heads, resolvedAt, failure, ...(parents !== undefined ? { parents } : {}) });
  const { rows } = await sql`
    update automations.listen_state set
      state = ${resolution}::text::jsonb || jsonb_build_object('paused', state->'paused', 'held', coalesce(state->'held', '0'::jsonb)),
      lease_token = null, lease_until = null, updated_at = now()
    where team_id = ${scope.tenant}::uuid and pipeline = ${input.pipeline}::text and lease_token::text = ${input.token}::text
    returning 1`.execute(pool());
  return rows.length > 0;
}

/** Sets why the listen is paused (`null`: not paused), the rest kept. A resume
 *  clears `held`; a pause of a paused listen keeps it. */
export async function setPaused(scope: LfTenant, input: { pipeline: string; paused: string | null }): Promise<null> {
  await sql`
    insert into automations.listen_state as listen_state (team_id, pipeline, state) values (${scope.tenant}::uuid, ${input.pipeline}::text, ${freshState(input.paused)}::text::jsonb)
    on conflict (team_id, pipeline) do update set
      state = listen_state.state || jsonb_build_object('paused', ${input.paused}::text,
        'held', case when ${input.paused}::text is null then 0 else coalesce((listen_state.state->>'held')::int, 0) end),
      updated_at = now()`.execute(pool());
  return null;
}

/** One more arrival held, as one write whatever others add; a listen not
 *  paused (resumed meanwhile), or with no state, is left as it is. */
export async function hold(scope: LfTenant, input: { pipeline: string }): Promise<null> {
  await sql`
    update automations.listen_state set state = state || jsonb_build_object('held', coalesce((state->>'held')::int, 0) + 1), updated_at = now()
    where team_id = ${scope.tenant}::uuid and pipeline = ${input.pipeline}::text and state->>'paused' is not null`.execute(pool());
  return null;
}

// ── The write ledger ────────────────────────────────────────────────────────

export interface LedgerWrite {
  adapter: string;
  recordType: string;
  externalId: string;
  runId: string;
  depth: number;
  at: string;
}

/** One write: the writes sent before `forgetBefore` forgotten, the run's
 *  earlier write of the record replaced, and this one kept. */
export async function recordWrite(scope: LfTenant, input: LedgerWrite & { forgetBefore: string }): Promise<null> {
  await inTransaction(async (trx) => {
    await sql`delete from automations.write_ledger where team_id = ${scope.tenant}::uuid and at < ${input.forgetBefore}::timestamptz`.execute(trx);
    await sql`
      delete from automations.write_ledger
      where team_id = ${scope.tenant}::uuid and adapter = ${input.adapter}::text and record_type = ${input.recordType}::text
        and external_id = ${input.externalId}::text and run_id = ${input.runId}::text`.execute(trx);
    await sql`
      insert into automations.write_ledger (team_id, adapter, record_type, external_id, run_id, depth, at)
      values (${scope.tenant}::uuid, ${input.adapter}::text, ${input.recordType}::text, ${input.externalId}::text, ${input.runId}::text,
              ${input.depth}::int4, ${input.at}::timestamptz)`.execute(trx);
  });
  return null;
}

/** The deepest write of the record sent at or after `since` (the latest of
 *  those as deep), or `null`. */
export async function writeDepth(
  scope: LfTenant,
  input: { adapter: string; recordType: string; externalId: string; since: string },
): Promise<{ runId: string; depth: number } | null> {
  const { rows } = await sql<{ run_id: string; depth: number }>`
    select run_id, depth from automations.write_ledger
    where team_id = ${scope.tenant}::uuid and adapter = ${input.adapter}::text and record_type = ${input.recordType}::text
      and external_id = ${input.externalId}::text and at >= ${input.since}::timestamptz
    order by depth desc, at desc limit 1`.execute(pool());
  const row = rows[0];
  return row === undefined ? null : { runId: row.run_id, depth: Math.max(row.depth, 0) };
}
