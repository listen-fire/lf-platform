// The platform's records of its own events, which `@lf/system` polls, one
// tenant's at a time (docs/contracts/system-events.md in listen-fire,
// "Adopting it elsewhere").
//
// Most facts are read where their writers already leave them: failed runs from
// the run table, stranded waits from the waits, unjudged arrivals from the
// facts the listen door keeps. Only what leaves nothing else behind is written
// here (`system_event`): a run pausing at its cost limit, each release the
// deploy check applies to a team, and what it found of each saved program (a
// `Validation Issue`, a `Deprecated Version`).
//
// The run table holds lf's runs too (`host = 'lf'`, written through the store
// slot), so a failed lf run is reported like any other: named by the file and
// movement it ran, linked to the movement's page here when the team keeps one
// by the file's name. Arrivals and waits are per team whichever host heard or
// parked them (ruling 13), so both hosts' are read.
//
// Every instant is compared at the millisecond its ISO text carries: a mark
// handed back from a poll names a row by that text, and a row kept at a finer
// instant would otherwise read as after its own mark and be reported twice.

import type { ModuleContext } from 'module-kit';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type {
  Automation,
  NoticeMark,
  ProgramNotice,
  Release,
  ReleaseMark,
  RunMark,
  SettledRun,
  StrandedWait,
  SystemEventKind,
  SystemRecords,
  UnjudgedArrival,
  UnjudgedMark,
  WaitMark,
} from '@listen-fire/system';

import { sql } from 'kysely';
import { z } from 'zod';
import { DEPRECATED_VERSION, RELEASE_APPLIED, RUN_PAUSED, VALIDATION_ISSUE } from '@listen-fire/system';

import { getAutomationsQb } from '../../../../lib/kysely';
import { getEnvVar } from '../../../../lib/utils/environment';
import { teamIdSchema } from '../../../../lib/team_id';
import { unjudged } from '../../../lf_store/records_door';

/** What a `system_event` row keeps: the one shape every kind written here
 *  shares. */
export interface SystemEventPayload {
  automation: string;
  automationId: string;
  /** Empty when the event concerns no run. */
  runId: string;
  /** Empty when the event concerns no release. */
  version: string;
  reason: string;
  url: string;
  /** ISO 8601. */
  at: string;
}

const storedPayload = z.object({
  automation: z.string(),
  automationId: z.string(),
  runId: z.string(),
  version: z.string(),
  reason: z.string(),
  url: z.string(),
  at: z.string(),
});

export async function recordSystemEvent(input: {
  teamId: string;
  kind: SystemEventKind;
  payload: SystemEventPayload;
}): Promise<void> {
  await getAutomationsQb(['system_event'])
    .insertInto('system_event')
    .values({
      team_id: input.teamId,
      kind: input.kind.id,
      payload: input.payload,
      occurred_at: new Date(input.payload.at),
    })
    .execute();
}

export function webBaseUrl(): string {
  return getEnvVar('WEB_BASE_URL', { devDefault: 'http://localhost:3003' }).replace(/\/$/, '');
}

/** The automation's own page — where its version and its diagnostics show. */
export function automationUrl(automationId: string): string {
  return `${webBaseUrl()}/movements/${encodeURIComponent(automationId)}`;
}

/** The automations list. */
export function automationsUrl(): string {
  return `${webBaseUrl()}/automations`;
}

function db() {
  return getAutomationsQb(['trigger_run', 'system_event', 'wait_row', 'trigger', 'movement']);
}

/** An instant as `Date.toISOString` writes it (`column` is always a constant here). */
function iso(column: string) {
  return sql<string>`to_char(date_trunc('milliseconds', ${sql.raw(column)}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** `column` at its millisecond, then `id`, strictly after the mark. The bare
 *  lower bound lets an index find the range. (`column` and `id` are always
 *  constants here.) */
function afterMark(column: string, id: string, mark: { at: string; id: string }) {
  return sql<boolean>`${sql.raw(column)} >= ${mark.at}::timestamptz
    and (date_trunc('milliseconds', ${sql.raw(column)}), ${sql.raw(id)}) > (${mark.at}::timestamptz, ${mark.id})`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Who a run belongs to ─────────────────────────────────────────────────────

interface RunRow {
  id: string;
  host: string;
  trigger_id: string;
  trigger_payload: unknown;
  dry_run: boolean;
}

interface RunOwner {
  automation: Automation | null;
  /** The listen whose arrival started it, by its pipeline. */
  listen: string | null;
  rehearsal: boolean;
  url?: string;
}

const NO_OWNER: RunOwner = { automation: null, listen: null, rehearsal: false };

/** A platform run's trigger payload is its arrival's trigger event
 *  (`arrivalTriggerOf`), which names its listen. */
const platformRunPayload = z.object({ pipelineInputId: z.string() });

/** What an lf run row's payload says it ran (lf_store/runs.ts writes it); its
 *  facts name the listen as listen-fire's run facts do. */
const lfRunPayload = z.object({ file: z.string(), movement: z.string(), facts: z.string() });
const lfRunFacts = z.object({
  event: z.object({ pipelineInputId: z.string().optional() }).optional(),
  dryRun: z.boolean().optional(),
});

function lfFactsOf(text: string): z.infer<typeof lfRunFacts> {
  try {
    const parsed = lfRunFacts.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The team's movements by name: lf names a run and a fact by its file, which
 *  the team may keep a movement of. */
async function movementsNamed(teamId: TeamId, names: readonly string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const rows = await db()
    .selectFrom('movement')
    .where('team_id', '=', teamId)
    .where('name', 'in', [...new Set(names)])
    .select(['id', 'name'])
    .execute();
  return new Map(rows.map((m) => [m.name, m.id as string]));
}

/** Each run's automation, listen and rehearsal flag. */
async function ownersOf(teamId: TeamId, runs: readonly RunRow[]): Promise<Map<string, RunOwner>> {
  const platform = runs.filter((run) => run.host !== 'lf');
  const lf = runs.flatMap((run) => {
    if (run.host !== 'lf') return [];
    const payload = lfRunPayload.safeParse(run.trigger_payload);
    return payload.success ? [{ run, ...payload.data }] : [];
  });

  // A run row's trigger id is engine-side text; only a uuid names a trigger row.
  const triggerIds = [...new Set(platform.map((r) => r.trigger_id).filter((id) => UUID.test(id)))];
  const triggers =
    triggerIds.length === 0
      ? []
      : await db()
          .selectFrom('trigger')
          .innerJoin('movement', 'movement.id', 'trigger.movement_id')
          .where('trigger.team_id', '=', teamId)
          .where('trigger.id', 'in', triggerIds as TriggerId[])
          .select(['trigger.id as id', 'movement.id as movementId', 'movement.name as name'])
          .execute();
  const automationByTrigger = new Map(
    triggers.map((t): [string, Automation] => [t.id as string, { id: t.movementId as string, name: t.name }]),
  );
  const movementByName = await movementsNamed(teamId, lf.map((r) => r.file));

  const owners = new Map<string, RunOwner>();
  for (const run of platform) {
    const payload = platformRunPayload.safeParse(run.trigger_payload);
    owners.set(run.id, {
      automation: automationByTrigger.get(run.trigger_id) ?? null,
      listen: payload.success ? payload.data.pipelineInputId : null,
      rehearsal: run.dry_run,
    });
  }
  for (const { run, file, movement, facts } of lf) {
    const read = lfFactsOf(facts);
    const movementId = movementByName.get(file);
    owners.set(run.id, {
      automation: { id: `${file}:${movement}`, name: movement },
      listen: read.event?.pipelineInputId ?? null,
      rehearsal: run.dry_run || read.dryRun === true,
      url: movementId === undefined ? automationsUrl() : automationUrl(movementId),
    });
  }
  return owners;
}

async function runRows(teamId: TeamId, ids: readonly string[]): Promise<RunRow[]> {
  const uuids = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (uuids.length === 0) return [];
  const { rows } = await sql<RunRow>`
    select r.id::text as id, r.host, r.trigger_id, r.trigger_payload, r.dry_run
    from automations.trigger_run r
    where r.team_id = ${teamId}::uuid and r.id = any(${uuids}::uuid[])`.execute(db());
  return rows;
}

// ── Failed runs ──────────────────────────────────────────────────────────────

/** A run's aggregate errors, as the first message among them. */
function firstErrorMessage(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  for (const error of errors) {
    const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return undefined;
}

async function failedRuns(teamId: TeamId, input: { after: RunMark; until: string; limit: number }): Promise<SettledRun[]> {
  const { rows } = await sql<RunRow & { failure_reason: string | null; errors: unknown; at: string }>`
    select r.id::text as id, r.host, r.trigger_id, r.trigger_payload, r.dry_run, r.failure_reason, r.errors, ${iso('r.failed_at')} as at
    from automations.trigger_run r
    where r.team_id = ${teamId}::uuid and r.status = 'failed' and r.failed_at is not null
      and date_trunc('milliseconds', r.failed_at) <= ${input.until}::timestamptz
      and ${afterMark('r.failed_at', 'r.id', { at: input.after.at, id: input.after.runId })}
    order by date_trunc('milliseconds', r.failed_at), r.id
    limit ${input.limit}::int8`.execute(db());
  const owners = await ownersOf(teamId, rows);
  return rows.map((row) => ({
    runId: row.id,
    ...(owners.get(row.id) ?? NO_OWNER),
    reason: row.failure_reason ?? firstErrorMessage(row.errors) ?? 'The run failed without a recorded reason.',
    at: row.at,
  }));
}

// ── Kept here: paused runs, releases ─────────────────────────────────────────

/** The team's `kind` rows after the mark (their instant, then the payload's
 *  `field`), no later than `until` when given, oldest first. */
async function storedEvents(
  teamId: TeamId,
  input: { kind: SystemEventKind; field: 'runId' | 'version' | 'automationId'; after: { at: string; id: string }; until?: string; limit: number },
): Promise<Array<{ payload: SystemEventPayload; at: string }>> {
  const { rows } = await sql<{ payload: unknown; at: string }>`
    select e.payload, ${iso('e.occurred_at')} as at
    from automations.system_event e
    where e.team_id = ${teamId}::uuid and e.kind = ${input.kind.id}
      ${input.until === undefined ? sql`` : sql`and date_trunc('milliseconds', e.occurred_at) <= ${input.until}::timestamptz`}
      and ${afterMark('e.occurred_at', `(e.payload->>'${input.field}')`, input.after)}
    order by date_trunc('milliseconds', e.occurred_at), e.payload->>${input.field}
    limit ${input.limit}::int8`.execute(db());
  return rows.flatMap((row) => {
    const payload = storedPayload.safeParse(row.payload);
    return payload.success ? [{ payload: payload.data, at: row.at }] : [];
  });
}

async function pausedRuns(teamId: TeamId, input: { after: RunMark; until: string; limit: number }): Promise<SettledRun[]> {
  const events = await storedEvents(teamId, {
    kind: RUN_PAUSED,
    field: 'runId',
    after: { at: input.after.at, id: input.after.runId },
    until: input.until,
    limit: input.limit,
  });
  const owners = await ownersOf(teamId, await runRows(teamId, events.map((e) => e.payload.runId)));
  return events.map(({ payload, at }) => {
    const owner = owners.get(payload.runId) ?? NO_OWNER;
    return {
      runId: payload.runId,
      automation: payload.automationId === '' ? owner.automation : { id: payload.automationId, name: payload.automation },
      listen: owner.listen,
      rehearsal: owner.rehearsal,
      reason: payload.reason,
      at,
      ...(payload.url !== '' ? { url: payload.url } : {}),
    };
  });
}

async function releases(teamId: TeamId, input: { after: ReleaseMark; limit: number }): Promise<Release[]> {
  const events = await storedEvents(teamId, {
    kind: RELEASE_APPLIED,
    field: 'version',
    after: { at: input.after.at, id: input.after.version },
    limit: input.limit,
  });
  return events.map(({ payload, at }) => ({ version: payload.version, at }));
}

// ── Program notices the deploy check leaves ──────────────────────────────────

/** A saved program the deploy check found not to validate under the running
 *  release (`Validation Issue`), or pinned to a deprecated language version
 *  (`Deprecated Version`), as it recorded it (language_upgrade.ts). */
async function programNotices(teamId: TeamId, kind: SystemEventKind, input: { after: NoticeMark; limit: number }): Promise<ProgramNotice[]> {
  const events = await storedEvents(teamId, {
    kind,
    field: 'automationId',
    after: { at: input.after.at, id: input.after.automationId },
    limit: input.limit,
  });
  return events.map(({ payload, at }) => ({
    automation: { id: payload.automationId, name: payload.automation },
    version: payload.version,
    reason: payload.reason,
    at,
    ...(payload.url !== '' ? { url: payload.url } : {}),
  }));
}

// ── Stranded waits ───────────────────────────────────────────────────────────

async function strandedWaits(teamId: TeamId, input: { after: WaitMark; limit: number }): Promise<StrandedWait[]> {
  const { rows } = await sql<{ wait_id: string; run_id: string; adapter_type: string; edge: string; record_id: string | null; at: string }>`
    select w.id::text as wait_id, w.run_id::text as run_id, w.adapter_type, w.edge, w.record_id, ${iso('w.stranded_at')} as at
    from automations.wait_row w
    where w.team_id = ${teamId}::uuid and w.stranded_at is not null
      and ${afterMark('w.stranded_at', 'w.id', { at: input.after.at, id: input.after.waitId })}
    order by date_trunc('milliseconds', w.stranded_at), w.id
    limit ${input.limit}::int8`.execute(db());
  const owners = await ownersOf(teamId, await runRows(teamId, rows.map((r) => r.run_id)));
  return rows.map((row) => {
    const owner = owners.get(row.run_id) ?? NO_OWNER;
    return {
      waitId: row.wait_id,
      runId: row.run_id,
      automation: owner.automation,
      listen: owner.listen,
      adapter: row.adapter_type,
      edge: row.edge,
      recordId: row.record_id,
      at: row.at,
    };
  });
}

// ── Arrivals a listen could not judge ────────────────────────────────────────

async function unjudgedArrivals(teamId: TeamId, input: { after: UnjudgedMark; limit: number }): Promise<UnjudgedArrival[]> {
  const facts = await unjudged(
    { tenant: teamId },
    {
      after: { at: input.after.at, pipeline: input.after.listen, arrival: input.after.arrival, attempt: input.after.attempt ?? 0 },
      pipeline: null,
      limit: input.limit,
    },
  );
  // The platform's listen door names a fact's file by its movement row's
  // name; lf by its own file, which the team may keep a movement of.
  const movementByName = await movementsNamed(teamId, facts.map((f) => f.file));
  return facts.map((fact) => {
    const movementId = movementByName.get(fact.file);
    return {
      listen: fact.pipeline,
      arrival: fact.arrival,
      automation: movementId === undefined ? { id: `${fact.file}:${fact.movement}`, name: fact.movement } : { id: movementId, name: fact.file },
      deliveryId: fact.deliveryId,
      edge: fact.edge,
      adapter: fact.adapter,
      recordId: fact.recordId,
      landing: fact.landing,
      reason: fact.reason,
      cause: fact.cause,
      at: fact.at,
      attempt: fact.attempt,
    };
  });
}

/** One tenant's records, as `@lf/system` reads them. */
export function systemRecordsFor(tenant: string): SystemRecords {
  const teamId = teamIdSchema.parse(tenant);
  return {
    failedRuns: (input) => failedRuns(teamId, input),
    pausedRuns: (input) => pausedRuns(teamId, input),
    strandedWaits: (input) => strandedWaits(teamId, input),
    releases: (input) => releases(teamId, input),
    unjudgedArrivals: (input) => unjudgedArrivals(teamId, input),
    validationIssues: (input) => programNotices(teamId, VALIDATION_ISSUE, input),
    deprecatedVersions: (input) => programNotices(teamId, DEPRECATED_VERSION, input),
    webBaseUrl: async () => webBaseUrl(),
  };
}

/** What `systemModuleWith` takes: the records of the tenant a call's module is loaded for. */
export function platformSystemRecords(ctx: ModuleContext): SystemRecords {
  return systemRecordsFor(ctx.config.tenant);
}
