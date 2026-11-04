// The callback store — one row per `callback(…)` mint, and the CAS that makes a
// fire exactly-once (callback-primitive layer 2).
//
// The `id` IS the payload every platform button, tap and BYO webhook carries,
// and IS the authorization. It carries the `cb_` namespace prefix so every door
// picks it out with ONE prefix COMPARISON and never parses it — a discriminant,
// not a structure (movement-lang/CLAUDE.md: compared-only ⇒ an identity).
//
// The claim is a single UPDATE. That is the whole race story: two concurrent
// taps of a single-use callback both run `WHERE status = 'live'`, exactly one
// row-locks and transitions, the loser sees zero rows and reads back `closed`.
// The call APPEND rides the same statement, so a repeatable callback's ledger
// can never accumulate a call that the claim didn't authorise (and no
// transaction has to straddle two tables — which is why the ledger is jsonb on
// the row rather than a child table).
//
// TTL is LAZY (the plan's ruling): expiry is a predicate on the claim, not a
// sweeper. A janitor would be hygiene only, and correctness never waits on one.
//
// This is the callback family a run parked under 0.12 reaches
// (`@listen-fire/language-versions`, `CarriedCallbackStore`), restored from
// production at 0.12.13: `callback(…)` was retired in listen-fire 0.13, so only a
// version that still mints one writes here. The rules over it (validation, what a
// recorded call may still do) are that version's own.

import { randomBytes } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { CallbackId } from '../../generated/kysely/automations/Callback';
import type AutomationsSchema from '../../generated/kysely/automations/AutomationsSchema';
import type { CarriedCallbackClaim, CarriedCallbackRecord, CarriedCallbackStore } from '@listen-fire/language-versions';

import { getAutomationsQb } from '../../lib/kysely';
import { apiBaseUrl } from '../../lib/api_base_url';
import { enqueueWork } from '../work/store';
import { announceWork } from '../work/wake';

// ── The id namespace ───────────────────────────────────────────────────────

/** Every callback id carries this namespace prefix: a door tells one apart by
 *  one comparison and never parses it. */
const CALLBACK_ID_PREFIX = 'cb_';

export function isCallbackId(value: string): boolean {
  return value.startsWith(CALLBACK_ID_PREFIX);
}

/** The id is the authorization, so it must not be guessable. */
function mintCallbackId(): CallbackId {
  return `${CALLBACK_ID_PREFIX}${randomBytes(24).toString('base64url')}` as CallbackId;
}

function callbackBaseUrl(): string {
  return apiBaseUrl();
}

/** The human link — what `callback(…).url` reads. GET renders a confirm page;
 *  only POST fires (the GET-never-writes rule). */
export function callbackUrl(id: string): string {
  return `${callbackBaseUrl()}/api/cb/${id}`;
}

// ── The record ─────────────────────────────────────────────────────────────

/** One parameter of a callback's signature, as the version that minted it wrote
 *  it. */
export interface CallbackParamSpec {
  name: string;
  type: string;
}

export interface CallbackCall {
  at: string;
  values: Record<string, unknown>;
}

const paramsSchema = z.array(z.object({ name: z.string(), type: z.string() }));

/** A call as the ledger keeps it: the call itself, and when its body started.
 *  The mark is written BEFORE the body runs, so a body runs at most once
 *  after it starts, across a crash too: a queued retry of a call whose body
 *  started never runs it again. The trade-off is deliberate — a crash mid-body
 *  leaves a callback whose body never completes rather than one whose writes
 *  land twice. The mark is also when the call LANDS: until its body has
 *  started, the call is on the ledger but no reader sees it (`readCallbackCalls`,
 *  and the awaits it resolves), so an `await cb-[:Called]->` never runs ahead
 *  of the body it fired. `bodyStartedAt` is the host's bookkeeping; the
 *  engine's `Called` landing never sees it. */
export interface LedgerCall extends CallbackCall {
  bodyStartedAt?: string;
}

/** The ledger as the row holds it, checked where it is read: jsonb the
 *  database hands back is not a type until it is validated. */
const ledgerSchema = z.array(
  z.object({
    at: z.string(),
    values: z.record(z.string(), z.unknown()),
    bodyStartedAt: z.string().optional(),
  }),
);

/** A call is seen (read as `Called`, resolving an await) once its body has
 *  started. */
function hasLanded(call: LedgerCall): boolean {
  return call.bodyStartedAt !== undefined;
}

/** `live` is the only non-terminal state. `fired` is a single-use claim; a
 *  repeatable callback stays `live` and accumulates calls until revoked. */
export type CallbackStatus = 'live' | 'fired' | 'revoked';

export interface CallbackRecord {
  id: CallbackId;
  teamId: TeamId;
  runId: TriggerRunId;
  /** The callback expression's canonical lexical address in the run's PINNED
   *  movement version — the entry point a fire resumes at. */
  address: string;
  params: CallbackParamSpec[];
  /** The captured closure, as the minting version's engine wrote it. */
  state: unknown;
  calls: LedgerCall[];
  singleUse: boolean;
  expiresAt: Date | null;
  status: CallbackStatus;
  createdAt: Date;
  firedAt: Date | null;
  revokedAt: Date | null;
}

interface CallbackRow {
  id: CallbackId;
  team_id: TeamId;
  run_id: TriggerRunId;
  address: string;
  params: unknown;
  state: unknown;
  calls: unknown;
  single_use: boolean;
  expires_at: Date | null;
  status: string;
  created_at: Date;
  fired_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = [
  'id', 'team_id', 'run_id', 'address', 'params', 'state', 'calls',
  'single_use', 'expires_at', 'status', 'created_at', 'fired_at', 'revoked_at',
] as const;

function toRecord(row: CallbackRow): CallbackRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    runId: row.run_id,
    address: row.address,
    params: row.params === null ? [] : paramsSchema.parse(row.params),
    state: row.state,
    calls: ledgerOf(row),
    singleUse: row.single_use,
    expiresAt: row.expires_at,
    status: row.status as CallbackStatus,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    revokedAt: row.revoked_at,
  };
}

function ledgerOf(row: CallbackRow): LedgerCall[] {
  if (row.calls === null) return [];
  const parsed = ledgerSchema.safeParse(row.calls);
  if (!parsed.success) {
    throw new Error(`callback ${row.id} has a malformed call ledger: ${parsed.error.message}`);
  }
  return parsed.data.map(({ at, values, bodyStartedAt }) => ({
    at,
    values,
    ...(bodyStartedAt !== undefined ? { bodyStartedAt } : {}),
  }));
}

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

/** The database's clock as an ISO 8601 instant, spelled as JavaScript spells
 *  one, for the instants the ledger records. */
const ISO_NOW = sql<string>`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ── Mint ───────────────────────────────────────────────────────────────────

export interface MintCallbackInput {
  teamId: TeamId;
  runId: TriggerRunId;
  address: string;
  params: CallbackParamSpec[];
  /** The captured closure, stored as the engine handed it. */
  state: unknown;
  /** `once` — defaults TRUE. The DEFAULT is the engine's, deliberately not the
   *  AST's (chunk 1), so it lives here and nowhere else. */
  singleUse?: boolean;
  /** `ttl` resolved to an absolute instant at mint. */
  expiresAt?: Date;
}

export async function mintCallback(input: MintCallbackInput): Promise<CallbackRecord> {
  const id = mintCallbackId();
  const row = await getAutomationsQb(['callback'])
    .insertInto('callback')
    .values({
      id,
      team_id: input.teamId,
      run_id: input.runId,
      address: input.address,
      params: jsonb(input.params) as never,
      state: jsonb(input.state) as never,
      calls: jsonb([]) as never,
      single_use: input.singleUse ?? true,
      expires_at: input.expiresAt ?? null,
      status: 'live',
    })
    .returning([...COLUMNS])
    .executeTakeFirstOrThrow();
  return toRecord(row as unknown as CallbackRow);
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** What a callback query runs on: the pool, or a caller's transaction. */
export type CallbackDb = Kysely<Pick<AutomationsSchema, 'callback'>>;

export async function getCallback(id: string, opts: { db?: CallbackDb } = {}): Promise<CallbackRecord | null> {
  // The prefix guard keeps a foreign payload from ever reaching a query — the
  // doors hand us whatever the platform sent.
  if (!isCallbackId(id)) return null;
  const row = await (opts.db ?? getAutomationsQb(['callback']))
    .selectFrom('callback')
    .where('id', '=', id as CallbackId)
    .select([...COLUMNS])
    .executeTakeFirst();
  return row ? toRecord(row as unknown as CallbackRow) : null;
}

/** The LIVE ledger read — what `cb-[:Called]->` returns and what a re-entered
 *  `await cb-[:Called]->` re-checks. Never served from the parked scope blob:
 *  the calls arrive AFTER the scope was captured. Only calls whose body has
 *  started are seen (`LedgerCall`). */
export async function readCallbackCalls(id: string): Promise<CallbackCall[]> {
  const record = await getCallback(id);
  return (record?.calls ?? []).filter(hasLanded).map(({ at, values }) => ({ at, values }));
}

/** Record on the ledger that call `callIndex`'s body is starting. Given the
 *  run lease the body runs under, only while the run is still leased to it:
 *  false when it is not, and nothing was marked, so a holder whose lease
 *  lapsed never marks a body it will not run. */
export async function markCallbackBodyStarted(input: {
  id: string;
  callIndex: number;
  lease?: { token: string };
}): Promise<boolean> {
  let mark = getAutomationsQb(['callback', 'trigger_run'])
    .updateTable('callback')
    .set({
      calls: sql`jsonb_set(calls, ${`{${input.callIndex}}`}::text[], (calls -> ${input.callIndex}::int) || jsonb_build_object('bodyStartedAt', ${ISO_NOW}))`,
      updated_at: new Date(),
    })
    .where('id', '=', input.id as CallbackId);
  if (input.lease !== undefined) {
    const { token } = input.lease;
    mark = mark.where((eb) =>
      eb.exists(
        eb
          .selectFrom('trigger_run')
          .select('trigger_run.id')
          .whereRef('trigger_run.id', '=', 'callback.run_id')
          .where('trigger_run.lease_token', '=', token),
      ),
    );
  }
  const marked = await mark.executeTakeFirst();
  return Number(marked.numUpdatedRows) > 0;
}

// ── The claim (the whole race story) ───────────────────────────────────────

export type CallbackClaim =
  | { kind: 'recorded'; callback: CallbackRecord; call: CallbackCall }
  | { kind: 'not_found' }
  /** Revoked (its run settled / was cancelled / its movement was deleted) or
   *  already fired (single-use). The closed-request-wins ack. */
  | { kind: 'closed'; callback: CallbackRecord }
  | { kind: 'expired'; callback: CallbackRecord };

/**
 * Claim a fire and record its call in ONE statement. Single-use flips
 * `live → fired`; a repeatable callback stays `live` and appends. The zero-row
 * result IS the "someone else got there first / it is closed / it expired"
 * signal — read back to say WHICH, never to decide (the decision already
 * happened, atomically).
 *
 * `values` must already be validated against the signature: a parameter
 * mismatch is a LOUD refusal BEFORE the claim, so a bad payload never consumes
 * a single-use callback.
 */
export async function claimCallbackFire(
  input: { id: string; values: Record<string, unknown> },
  /** Run the claim inside a caller's transaction: what the caller writes with
   *  it commits or rolls back together with the call. */
  opts: { db?: CallbackDb } = {},
): Promise<CallbackClaim> {
  if (!isCallbackId(input.id)) return { kind: 'not_found' };
  const db = opts.db ?? getAutomationsQb(['callback']);
  const id = input.id as CallbackId;
  // One clock decides: expiry, `fired_at` and the call's `At` all read the
  // database's, and so does the read-back that says which refusal it was.
  const claimed = await db
    .updateTable('callback')
    .set({
      status: sql<string>`CASE WHEN single_use THEN 'fired' ELSE status END`,
      fired_at: sql<Date | null>`CASE WHEN single_use THEN now() ELSE fired_at END`,
      calls: sql`calls || jsonb_build_array(jsonb_build_object('at', ${ISO_NOW}, 'values', ${JSON.stringify(input.values)}::jsonb))`,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', id)
    .where('status', '=', 'live')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .returning([...COLUMNS])
    .executeTakeFirst();
  if (claimed !== undefined) {
    const callback = toRecord(claimed as unknown as CallbackRow);
    const recorded = callback.calls[callback.calls.length - 1];
    if (recorded === undefined) throw new Error(`callback ${id} recorded a call its ledger does not hold`);
    return { kind: 'recorded', callback, call: { at: recorded.at, values: recorded.values } };
  }

  const existing = await db
    .selectFrom('callback')
    .where('id', '=', id)
    .select([...COLUMNS, sql<Date>`now()`.as('database_now')])
    .executeTakeFirst();
  if (existing === undefined) return { kind: 'not_found' };
  const callback = toRecord(existing as unknown as CallbackRow);
  return {
    kind: newCallRefusal(callback, existing.database_now) ?? 'closed',
    callback,
  };
}

/** Why a new call is refused, or null when it is taken: revoked, already fired,
 *  or past its window. What a call already recorded may still do is the minting
 *  version's rule. */
function newCallRefusal(callback: CallbackRecord, now: Date): 'closed' | 'expired' | null {
  if (callback.status !== 'live') return 'closed';
  if (callback.expiresAt !== null && callback.expiresAt.getTime() <= now.getTime()) return 'expired';
  return null;
}

/**
 * Claim a call and queue its body's `fire_callback` row in one transaction:
 * once a call is on the ledger, its body is durable work, whatever the
 * process does next. A refusal queues nothing.
 */
export async function claimCallbackFireWithBody(input: {
  id: string;
  values: Record<string, unknown>;
  bodyDueAt: Date;
}): Promise<CallbackClaim> {
  let bodyKind: string | undefined;
  const claimed = await getAutomationsQb(['callback'])
    .transaction()
    .execute(async (trx) => {
      const claim = await claimCallbackFire({ id: input.id, values: input.values }, { db: trx });
      if (claim.kind === 'recorded') {
        bodyKind = await enqueueCallbackBody(
          { callback: claim.callback, callIndex: claim.callback.calls.length - 1 },
          { dueAt: input.bodyDueAt, db: trx },
        );
      }
      return claim;
    });
  // Announced after commit: a drain the wake starts must find the row.
  if (claimed.kind === 'recorded' && bodyKind !== undefined) await announceWork(bodyKind, input.bodyDueAt);
  return claimed;
}

/** The work kind a recorded call's body waits under. */
export const CALLBACK_BODY_WORK_KIND = 'fire_callback';

/** One recorded call's body as a work row, keyed by the call as production keyed
 *  it, so a call is queued once however often this is reached; an earlier due
 *  time wins. Answers the row's kind, for a caller that announces it after its
 *  transaction commits. */
export async function enqueueCallbackBody(
  input: { callback: Pick<CallbackRecord, 'id' | 'teamId'>; callIndex: number },
  opts: { dueAt: Date; db?: CallbackDb },
): Promise<string> {
  await enqueueWork(
    {
      kind: CALLBACK_BODY_WORK_KIND,
      key: `${CALLBACK_BODY_WORK_KIND}:${input.callback.id}:${input.callIndex}`,
      teamId: input.callback.teamId,
      payload: { callbackId: input.callback.id, teamId: input.callback.teamId, callIndex: input.callIndex },
      dueAt: opts.dueAt,
    },
    opts.db !== undefined ? { db: opts.db } : {},
  );
  return CALLBACK_BODY_WORK_KIND;
}

// ── Revocation (the run's lifecycle drives it; there is no sweeper) ────────

/**
 * Ruling (b): a run that reaches ANY terminal state — success, partial, failed,
 * cancelled — revokes its outstanding callbacks. Callbacks are ephemeral by
 * definition: strictly things the current run can still react to. An author who
 * wants buttons to stay live keeps the run alive by awaiting `Called`.
 *
 * Idempotent, and only ever touches `live` rows — a fired single-use keeps its
 * `fired` state (and its `fired_at`) so the inspector can still tell the two
 * endings apart.
 */
export async function revokeRunCallbacks(runId: TriggerRunId): Promise<number> {
  return revokeCallbacksForRuns([runId]);
}

export async function revokeCallbacksForRuns(runIds: TriggerRunId[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const result = await getAutomationsQb(['callback'])
    .updateTable('callback')
    .set({ status: 'revoked', revoked_at: new Date(), updated_at: new Date() })
    .where('run_id', 'in', runIds)
    .where('status', '=', 'live')
    .executeTakeFirst();
  return Number(result?.numUpdatedRows ?? 0);
}

// ── The carried callback family, over Postgres ─────────────────────────────

function coreRecordOf(record: CallbackRecord): CarriedCallbackRecord {
  return {
    id: record.id,
    teamId: record.teamId,
    runId: record.runId,
    address: record.address,
    params: record.params,
    state: record.state,
    calls: record.calls,
    singleUse: record.singleUse,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    status: record.status,
  };
}

function coreClaimOf(claim: CallbackClaim): CarriedCallbackClaim {
  switch (claim.kind) {
    case 'recorded':
      return { kind: 'recorded', callback: coreRecordOf(claim.callback), callIndex: claim.callback.calls.length - 1 };
    case 'not_found':
      return claim;
    case 'closed':
    case 'expired':
      return { kind: claim.kind, callback: coreRecordOf(claim.callback) };
  }
}

/** The plain text the core hands in, as the row's branded ids. */
const teamIdOf = (id: string) => id as TeamId;
const runIdOf = (id: string) => id as TriggerRunId;

export const postgresCallbackStore: CarriedCallbackStore = {
  async mint({ teamId, runId, address, params, state, singleUse, expiresAt }) {
    const record = await mintCallback({
      teamId: teamIdOf(teamId),
      runId: runIdOf(runId),
      address,
      params,
      state,
      singleUse,
      ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt) } : {}),
    });
    return { id: record.id };
  },
  async get({ id }) {
    const record = await getCallback(id);
    return record === null ? null : coreRecordOf(record);
  },
  async record({ id, values, bodyDueAt }) {
    return coreClaimOf(await claimCallbackFireWithBody({ id, values, bodyDueAt: new Date(bodyDueAt) }));
  },
  markBodyStarted: ({ id, callIndex, fence }) =>
    markCallbackBodyStarted({ id, callIndex, ...(fence !== undefined ? { lease: { token: fence } } : {}) }),
  async landed({ ids }) {
    const callbackIds = ids.filter(isCallbackId) as CallbackId[];
    if (callbackIds.length === 0) return [];
    const rows = await getAutomationsQb(['callback'])
      .selectFrom('callback')
      .where('id', 'in', callbackIds)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM jsonb_array_elements(calls) AS call WHERE call ? 'bodyStartedAt')`)
      .select('id')
      .execute();
    const landed = new Set<string>(rows.map((r) => r.id));
    return ids.filter((id) => landed.has(id));
  },
  async revokeRun({ runId }) {
    await revokeRunCallbacks(runIdOf(runId));
  },
};
