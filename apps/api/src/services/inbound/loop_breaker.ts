// The loop breaker (listen-fire 0.13; ruling 6): a run's writes can cause
// arrivals that fire more runs (a two-way sync, or two automations feeding
// each other). Each record write a run sends is kept in the write ledger with
// the run's place in its chain. An arrival on a record a run wrote within the
// loop window was caused by that run: the run it fires is the next in its
// chain. A chain may be `depth` runs long; the listen whose arrival would
// start the next is paused, by name (`LISTEN_LOOP`), until a person resumes
// it. A paused listen's arrivals run nothing, and are counted.
//
// "Within the window" runs from the write to when the arrival happened at its
// provider (`occurredAt`), else to when the platform takes it, so an echo a
// poll finds minutes later is still caught. Only the window's start bounds
// the writes matched: a provider's clock a little behind ours errs toward a
// longer chain, never toward a loop that runs on.
//
// The ledger and the listens' pauses are the store's (lf_store/listens.ts),
// per team, so a cloud listen-fire on the same team reads the same chains.
// The sequence is crates/lf/src/loop_breaker.rs's.

import { sql } from 'kysely';
import { z } from 'zod';

import type { Arrival } from 'engine-contracts';
import type {
  AdapterCall,
  AdapterCallAnswer,
  AdapterMethod,
  HostAdapters,
  ResolvedAdapter,
  Scoped,
  AdapterResolution,
} from 'movement-engine/public/host';
import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../lib/kysely';
import { recordWrite, writeDepth } from '../lf_store/listens';
import type { SavedListen } from './listen_door';

// ── Settings ────────────────────────────────────────────────────────────────

export interface LoopSettings {
  /** How long after a write an arrival on its record counts as its echo. */
  windowMs: number;
  /** The runs one chain may be before the listen that would start the next
   *  is paused. */
  depth: number;
}

const DEFAULT_LOOP_WINDOW_SECONDS = 20;
const DEFAULT_LOOP_DEPTH = 10;

/** The deployment's loop window and depth (listen-fire's `loopWindow` and
 *  `loopDepth`): `LOOP_WINDOW_SECONDS` and `LOOP_DEPTH`, whole numbers of at
 *  least 1, else listen-fire's defaults. */
export function loopSettings(env: NodeJS.ProcessEnv = process.env): LoopSettings {
  return {
    windowMs: wholeAtLeastOne(env, 'LOOP_WINDOW_SECONDS', DEFAULT_LOOP_WINDOW_SECONDS) * 1000,
    depth: wholeAtLeastOne(env, 'LOOP_DEPTH', DEFAULT_LOOP_DEPTH),
  };
}

function wholeAtLeastOne(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name}: expected a whole number, at least 1, not ${JSON.stringify(raw)}`);
  return value;
}

// ── The arrival side: which chain a run continues ───────────────────────────

/** A record, as the ledger keys a write of it. */
interface LedgerRecord {
  adapter: string;
  recordType: string;
  externalId: string;
}

type HeardArrival = Exclude<Arrival, { gone: true }>;

/** The records an arrival is matched to writes by: the record it is about,
 *  and its landing (by the landing's record type, else the type the listened
 *  edge lands on). */
export function recordsOf(adapter: string, arrival: HeardArrival, landingType: string): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  if (arrival.about !== undefined) records.push({ adapter, recordType: arrival.about.recordType, externalId: arrival.about.externalId });
  const { recordId, recordType } = arrival.landing;
  if (recordId !== undefined && recordId !== '') records.push({ adapter, recordType: recordType ?? landingType, externalId: recordId });
  return records;
}

/** The earliest write that can have caused `arrival`. */
export function sinceOf(arrival: HeardArrival, windowMs: number, now: Date): Date {
  const occurred = arrival.occurredAt !== undefined ? Date.parse(arrival.occurredAt) : Number.NaN;
  return new Date((Number.isNaN(occurred) ? now.getTime() : occurred) - windowMs);
}

const lfFacts = z.object({ chain: z.array(z.string()).optional() });

/** The chain the run `runId` is in, and that run: the platform host keeps it
 *  on the run's row, a cloud listen-fire in the run's facts. */
async function chainThrough(teamId: TeamId, runId: string): Promise<string[]> {
  const { rows } = await sql<{ host: string; chain: string[]; facts: string | null }>`
    select host, chain, trigger_payload->>'facts' as facts from automations.trigger_run
    where id::text = ${runId}::text and team_id = ${teamId}::uuid`.execute(getAutomationsQb(['trigger_run']));
  const row = rows[0];
  if (row === undefined) throw new Error(`the write ledger names run ${runId}, which the team holds no row of`);
  const before = row.host === 'lf' ? (lfFacts.parse(JSON.parse(row.facts ?? '{}')).chain ?? []) : row.chain;
  return [...before, runId];
}

/**
 * The runs before the run `arrival` would fire through `listen`, oldest
 * first: the chain of the run whose write of a record the arrival names is
 * deepest within the window, and that run. None: a chain of its own. A
 * ledger that cannot answer fails the caller, so the arrival is tried again:
 * a loop breaker silently off is worse than a delayed run.
 */
export async function chainBefore(input: {
  teamId: TeamId;
  listen: SavedListen;
  arrival: HeardArrival;
  now: Date;
  settings: LoopSettings;
}): Promise<string[]> {
  const { teamId, listen, arrival } = input;
  const landingType = listen.plan.hops[listen.plan.hops.length - 1]?.to ?? '';
  const records = recordsOf(listen.plan.adapter, arrival, landingType);
  if (records.length === 0) return [];
  const since = sinceOf(arrival, input.settings.windowMs, input.now).toISOString();
  let deepest: { runId: string; depth: number } | null = null;
  for (const record of records) {
    const found = await writeDepth({ tenant: teamId }, { ...record, since });
    if (found !== null && (deepest === null || found.depth > deepest.depth)) deepest = found;
  }
  return deepest === null ? [] : chainThrough(teamId, deepest.runId);
}

/** Why a listen is paused when `chain`'s next run would be past the depth. */
export function loopLine(named: string, chain: readonly string[]): string {
  return (
    `LISTEN_LOOP: ${named} is paused: this arrival would start run ${chain.length + 1} of a chain of writes and arrivals ` +
    `(${chain.join(', ')}); resume the automation once the loop is broken`
  );
}

// ── The write side: each record write a run sends, kept ─────────────────────

const WRITE_METHODS: ReadonlySet<AdapterMethod> = new Set<AdapterMethod>(['createRecord', 'updateRecord', 'deleteRecord']);

/** A polled edge that declares no interval is polled this often (poll_source/worker.ts). */
const DEFAULT_POLL_EVERY_SECONDS = 60;

/** How long a team's writes are kept: the loop window, and as long again as
 *  its slowest poll may take to find an echo. */
async function keptMsOf(teamId: TeamId, windowMs: number): Promise<number> {
  const { rows } = await sql<{ slowest: number | null }>`
    select max(coalesce((config->'listen'->'delivery'->>'pollEverySeconds')::numeric, ${DEFAULT_POLL_EVERY_SECONDS}::numeric))::float8 as slowest
    from automations.trigger
    where team_id = ${teamId}::uuid and config->'listen'->'delivery'->>'kind' = 'polled'`.execute(getAutomationsQb(['trigger']));
  return windowMs + (rows[0]?.slowest ?? 0) * 1000;
}

/** The depth a run's writes are kept at: how many runs came before it. */
async function depthOf(teamId: TeamId, runId: string): Promise<number> {
  const { rows } = await sql<{ depth: number }>`
    select cardinality(chain) as depth from automations.trigger_run
    where id::text = ${runId}::text and team_id = ${teamId}::uuid`.execute(getAutomationsQb(['trigger_run']));
  return rows[0]?.depth ?? 0;
}

/** What a write answered: the record it wrote, or that the record it named
 *  was not found (nothing written). */
function writtenRef(answer: unknown): { externalId?: string } | 'not_found' {
  if (answer === null || typeof answer !== 'object') return {};
  if ('notFound' in answer) return 'not_found';
  return 'externalId' in answer && typeof answer.externalId === 'string' ? { externalId: answer.externalId } : {};
}

/** The record a write named. */
function sentRef(args: unknown): { recordType?: string; externalId?: string } {
  if (args === null || typeof args !== 'object') return {};
  return {
    ...('recordType' in args && typeof args.recordType === 'string' ? { recordType: args.recordType } : {}),
    ...('externalId' in args && typeof args.externalId === 'string' ? { externalId: args.externalId } : {}),
  };
}

/**
 * `adapters`, keeping each record write the run `runId` sends in the write
 * ledger the moment its module answers it, before the run goes on (so an
 * echo the provider sends right after finds it). A rehearsed instance's
 * writes are never sent, so none is kept. A write the ledger cannot keep
 * fails the call after the write was sent: a write the ledger does not know
 * would let its echo start a chain of its own.
 */
export function ledgeredAdapters(adapters: HostAdapters, run: { teamId: TeamId; runId: string; settings?: LoopSettings }): HostAdapters {
  const instances = new Map<string, { adapterType: string; rehearsed: boolean }>();
  let kept: Promise<{ depth: number; keptMs: number }> | undefined;
  const ledger = () => {
    kept ??= (async () => {
      const settings = run.settings ?? loopSettings();
      const [depth, keptMs] = await Promise.all([depthOf(run.teamId, run.runId), keptMsOf(run.teamId, settings.windowMs)]);
      return { depth, keptMs };
    })();
    return kept;
  };
  return {
    async resolve(resolution: Scoped<AdapterResolution>): Promise<ResolvedAdapter> {
      const resolved = await adapters.resolve(resolution);
      instances.set(`${resolution.segmentId}:${resolved.instance}`, { adapterType: resolved.adapterType, rehearsed: resolution.dryRun === true });
      return resolved;
    },
    async call<M extends AdapterMethod>(call: AdapterCall<M>): Promise<AdapterCallAnswer<M>> {
      const sentAt = new Date();
      const answer = await adapters.call(call);
      const instance = instances.get(`${call.segmentId}:${call.instance}`);
      if (!WRITE_METHODS.has(call.method) || 'error' in answer || instance === undefined || instance.rehearsed) return answer;
      const written = writtenRef(answer.result);
      if (written === 'not_found') return answer;
      const sent = sentRef(call.args);
      const externalId = written.externalId ?? sent.externalId;
      if (sent.recordType === undefined || externalId === undefined) return answer;
      try {
        const { depth, keptMs } = await ledger();
        await recordWrite(
          { tenant: run.teamId },
          {
            adapter: instance.adapterType,
            recordType: sent.recordType,
            externalId,
            runId: run.runId,
            depth,
            at: sentAt.toISOString(),
            forgetBefore: new Date(Date.now() - keptMs).toISOString(),
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: {
            kind: 'adapter_error',
            message: `keeping run ${run.runId}'s write of ${sent.recordType} ${externalId} in the write ledger failed after the write was sent: ${message}`,
          },
        };
      }
      return answer;
    },
  };
}
