// Which automation owns a run, a listen, a question or what a delivery reached:
// the automation a route's decision is about when the route names one of these
// instead of the automation.
//
// Each answer comes from the rows the engine and its host write, never from what
// a caller supplied. Some things belong to no automation, and only team
// membership decides them, as it did before statements existed: a listen whose
// movement is gone and every run it starts, and a question a REST caller
// asked. Anything else whose
// automation cannot be traced (a run whose listen and version are both gone, a
// question a run asked that no traced run or automation is recorded on) is left
// out of every answer, so a route refuses it as it refuses something missing.

import { sql } from 'kysely';
import { z } from 'zod';
import { ASK_ADAPTER_TYPE, RESPONSE_EDGE_NAME } from '@listen-fire/ask';

import type { AskId } from '../../generated/kysely/asks/Ask';
import type { MovementId } from '../../generated/kysely/automations/Movement';
import type { MovementVersionId } from '../../generated/kysely/automations/MovementVersion';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAsksQb, getAutomationsQb } from '../../lib/kysely';
import { QUEUED_RUN_WORK_KINDS } from '../work/kinds';

/** Where something lives, and the automation it belongs to (null: none, so team membership decides it). */
type Owner = { teamId: string; automationId: string | null };

const uuid = z.string().uuid();

/** Postgres refuses a malformed uuid with an error; an id that is not one names nothing. */
function uuids(ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => uuid.safeParse(id).success);
}

/** What a queued run's work row says it runs. */
const queuedPayload = z.object({ runId: z.string(), triggerId: z.string().optional(), movementId: z.string().optional() });

/**
 * Where a question was asked: what the ask module records from its write
 * (`AskProvenance`, at least the adapter its run fired on), and what the
 * platform's engine host adds as the question is raised (the run, and that
 * run's automation). A question a REST caller asked carries what the caller
 * sent instead, so all of it only ever narrows who sees the question.
 */
const askProvenance = z.object({
  movementId: z.string().optional(),
  runId: z.string().optional(),
  nodeId: z.string().optional(),
  adapterType: z.string().optional(),
});

type AskProvenance = z.infer<typeof askProvenance>;

/** A question a run asked records where; one a REST caller asked records none of it. */
function askedInARun(provenance: AskProvenance): boolean {
  return Object.values(provenance).some((value) => value !== undefined);
}

/** An lf run's trigger id names its file: `listen:<file>:<movement>`. */
function lfFileOf(triggerId: string): string | null {
  return /^listen:(.+):[^:]+$/.exec(triggerId)?.[1] ?? null;
}

/**
 * The automation each of these runs belongs to, for the runs that live in
 * these teams. A run missing from the answer is not in them, or its
 * automation cannot be traced. A run is its pinned version's movement, else
 * its listen's, else (a Run now of a carried version, or an lf run) the
 * movement its trigger id names.
 */
async function automationsOfRuns(asked: { runIds: readonly string[]; teamIds: readonly string[] }): Promise<Map<string, Owner>> {
  const runIds = uuids(asked.runIds);
  if (runIds.length === 0 || asked.teamIds.length === 0) return new Map();
  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', 'in', runIds as TriggerRunId[])
    .where('team_id', 'in', asked.teamIds)
    .select(['id', 'team_id', 'trigger_id', 'movement_version_id'])
    .execute();
  const recorded = runs.map((run) => ({
    runId: String(run.id),
    teamId: run.team_id,
    triggerId: run.trigger_id,
    versionId: run.movement_version_id === null ? null : String(run.movement_version_id),
  }));
  const seen = new Set(recorded.map((run) => run.runId));
  const queued = await queuedRuns({ runIds: runIds.filter((id) => !seen.has(id)), teamIds: asked.teamIds });
  const all = [...recorded, ...queued];

  const versionIds = uuids(all.flatMap((run) => (run.versionId === null ? [] : [run.versionId])));
  const byVersion = new Map(
    versionIds.length === 0
      ? []
      : (
          await getAutomationsQb(['movement_version'])
            .selectFrom('movement_version')
            .where('id', 'in', versionIds as MovementVersionId[])
            .select(['id', 'movement_id'])
            .execute()
        ).map((row) => [String(row.id), String(row.movement_id)] as const),
  );
  const byListen = await automationsOfListens({ triggerIds: all.map((run) => run.triggerId), teamIds: asked.teamIds });
  const movements = await movementsNamedBy(all);

  const owners = new Map<string, Owner>();
  for (const run of all) {
    const listen = byListen.get(run.triggerId);
    const automationId =
      (run.versionId !== null ? byVersion.get(run.versionId) : undefined) ??
      listen?.automationId ??
      movements.get(`${run.teamId}:${run.triggerId}`);
    if (automationId !== undefined) owners.set(run.runId, { teamId: run.teamId, automationId });
    // A run of a listen with no automation is the team's, as the listen is.
    else if (listen !== undefined) owners.set(run.runId, { teamId: run.teamId, automationId: null });
  }
  return owners;
}

/** A run its delivery queued and no worker has started: only its work row knows it. */
async function queuedRuns(asked: { runIds: string[]; teamIds: readonly string[] }) {
  if (asked.runIds.length === 0) return [];
  const rows = await getAutomationsQb(['work'])
    .selectFrom('work')
    .where('host', '=', 'platform')
    .where('kind', 'in', [...QUEUED_RUN_WORK_KINDS])
    .where('team_id', 'in', asked.teamIds)
    .where('dead_at', 'is', null)
    .where(sql<boolean>`payload->>'runId' in (${sql.join(asked.runIds)})`)
    .select(['team_id', 'payload'])
    .execute();
  return rows.flatMap((row) => {
    const payload = queuedPayload.safeParse(row.payload);
    if (!payload.success || row.team_id === null) return [];
    const { runId, triggerId, movementId } = payload.data;
    const named = triggerId ?? movementId;
    return named === undefined ? [] : [{ runId, teamId: row.team_id, triggerId: named, versionId: null }];
  });
}

/** The movements runs name by their trigger id, keyed `team:triggerId`: the movement's own id, or an lf run's file. */
async function movementsNamedBy(runs: readonly { teamId: string; triggerId: string }[]): Promise<Map<string, string>> {
  const teamIds = [...new Set(runs.map((run) => run.teamId))];
  if (teamIds.length === 0) return new Map();
  const ids = uuids(runs.map((run) => run.triggerId));
  const files = [...new Set(runs.flatMap((run) => lfFileOf(run.triggerId) ?? []))];
  if (ids.length === 0 && files.length === 0) return new Map();
  const rows = await getAutomationsQb(['movement'])
    .selectFrom('movement')
    .where('team_id', 'in', teamIds)
    .where((eb) =>
      eb.or([
        ...(ids.length > 0 ? [eb('id', 'in', ids as MovementId[])] : []),
        ...(files.length > 0 ? [eb('name', 'in', files)] : []),
      ]),
    )
    .select(['id', 'team_id', 'name'])
    .execute();
  const named = new Map<string, string>();
  for (const run of runs) {
    const file = lfFileOf(run.triggerId);
    const row = rows.find(
      (r) => r.team_id === run.teamId && (String(r.id) === run.triggerId || (file !== null && r.name === file)),
    );
    if (row !== undefined) named.set(`${run.teamId}:${run.triggerId}`, String(row.id));
  }
  return named;
}

/** The automation each of these listens belongs to, for the listens in these teams. */
async function automationsOfListens(asked: {
  triggerIds: readonly string[];
  teamIds: readonly string[];
}): Promise<Map<string, Owner>> {
  const triggerIds = uuids(asked.triggerIds);
  if (triggerIds.length === 0 || asked.teamIds.length === 0) return new Map();
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', 'in', triggerIds as TriggerId[])
    .where('team_id', 'in', asked.teamIds)
    .select(['id', 'team_id', 'movement_id'])
    .execute();
  return new Map(
    rows.map((row) => [
      String(row.id),
      { teamId: row.team_id, automationId: row.movement_id === null ? null : String(row.movement_id) },
    ]),
  );
}

/** The run parked on each of these questions: this release's wait, or a carried version's correlation. */
async function runsWaitingOn(askIds: readonly string[]): Promise<Map<string, string>> {
  const waits = await getAutomationsQb(['wait_row'])
    .selectFrom('wait_row')
    .where('adapter_type', '=', ASK_ADAPTER_TYPE)
    .where('edge', '=', RESPONSE_EDGE_NAME)
    .where('key', 'in', [...askIds])
    .select(['key', 'run_id'])
    .execute();
  const correlations = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', ASK_ADAPTER_TYPE)
    .where('correlation_key', 'in', [...askIds])
    .select(['correlation_key', 'run_id'])
    .execute();
  return new Map([
    ...waits.flatMap((wait) => (wait.key === null ? [] : [[wait.key, String(wait.run_id)] as const])),
    ...correlations.map((park) => [park.correlation_key, String(park.run_id)] as const),
  ]);
}

/**
 * The automation each of these questions belongs to, for the questions in
 * these teams: the run waiting on it, else the run or automation recorded on
 * it when it was asked. A question a run asked that none of those traces is
 * left out; a question a REST caller asked belongs to no automation.
 */
async function automationsOfAsks(asked: { askIds: readonly string[]; teamIds: readonly string[] }): Promise<Map<string, Owner>> {
  const askIds = uuids(asked.askIds);
  if (askIds.length === 0 || asked.teamIds.length === 0) return new Map();
  const asks = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('id', 'in', askIds as AskId[])
    .where('team_id', 'in', asked.teamIds)
    .select(['id', 'team_id', 'provenance'])
    .execute();
  const waitingRun = await runsWaitingOn(askIds);
  const recorded = new Map(
    asks.map((ask) => {
      const provenance = askProvenance.safeParse(ask.provenance);
      return [String(ask.id), provenance.success ? provenance.data : {}] as const;
    }),
  );
  const runOwners = await automationsOfRuns({
    runIds: askIds.flatMap((askId) => [waitingRun.get(askId), recorded.get(askId)?.runId].flatMap((run) => run ?? [])),
    teamIds: asked.teamIds,
  });
  const movementIds = uuids(asks.flatMap((ask) => recorded.get(String(ask.id))?.movementId ?? []));
  const movements = new Set(
    movementIds.length === 0
      ? []
      : (
          await getAutomationsQb(['movement'])
            .selectFrom('movement')
            .where('id', 'in', movementIds as MovementId[])
            .where('team_id', 'in', asked.teamIds)
            .select('id')
            .execute()
        ).map((row) => String(row.id)),
  );
  const ownerOfRun = (runId: string | undefined) => (runId === undefined ? undefined : runOwners.get(runId));

  const owners = new Map<string, Owner>();
  for (const ask of asks) {
    const askId = String(ask.id);
    const provenance = recorded.get(askId) ?? {};
    const movementId = provenance.movementId;
    const run = ownerOfRun(waitingRun.get(askId)) ?? ownerOfRun(provenance.runId);
    const automationId = run?.automationId ?? (movementId !== undefined && movements.has(movementId) ? movementId : undefined);
    if (automationId !== undefined && automationId !== null) owners.set(askId, { teamId: ask.team_id, automationId });
    // A question a team's run asked is the team's, as the run is.
    else if (run !== undefined || !askedInARun(provenance)) owners.set(askId, { teamId: ask.team_id, automationId: null });
  }
  return owners;
}

/**
 * The automations a delivery reached, for a delivery in these teams: each
 * run its arrivals started (a replay's runs included), each listen that
 * could not judge one of them, and each whose fire list refused one. `untraced`: one of those whose automation
 * cannot be traced, which no caller may read a delivery through. A listen
 * whose movement is gone belongs to no automation and adds none.
 */
async function automationsReachedBy(asked: {
  deliveryId: string;
  teamIds: readonly string[];
}): Promise<{ automationIds: Set<string>; untraced: boolean }> {
  const reached = { automationIds: new Set<string>(), untraced: false };
  if (!uuid.safeParse(asked.deliveryId).success || asked.teamIds.length === 0) return reached;
  const exec = getAutomationsQb(['trigger_run', 'delivery', 'arrival_unjudged', 'arrival_refused', 'trigger', 'movement']);
  const teams = sql.join(asked.teamIds);
  const { rows: runs } = await sql<{ id: string }>`
    select r.id::text as id
    from automations.trigger_run r
    left join automations.delivery d on d.id = r.delivery_id and d.team_id = r.team_id
    where r.team_id::text in (${teams}) and (r.delivery_id = ${asked.deliveryId}::uuid or d.replay_of = ${asked.deliveryId}::uuid)`.execute(exec);
  const runOwners = await automationsOfRuns({ runIds: runs.map((run) => run.id), teamIds: asked.teamIds });
  for (const run of runs) {
    const owner = runOwners.get(run.id);
    if (owner === undefined) reached.untraced = true;
    else if (owner.automationId !== null) reached.automationIds.add(owner.automationId);
  }
  // A listen edited since keeps its facts under the pipeline it had: its file names its automation.
  const { rows: facts } = await sql<{ listened: boolean; movement_id: string | null; named: string | null }>`
    select t.id is not null as listened, t.movement_id::text as movement_id, m.id::text as named
    from (select team_id, pipeline, file from automations.arrival_unjudged where team_id::text in (${teams}) and delivery_id = ${asked.deliveryId}::text
          union all
          select team_id, pipeline, file from automations.arrival_refused where team_id::text in (${teams}) and delivery_id = ${asked.deliveryId}::uuid) u
    left join automations.trigger t on t.team_id = u.team_id and t.config->'listen'->>'pipeline' = u.pipeline
    left join automations.movement m on m.team_id = u.team_id and m.name = u.file`.execute(exec);
  for (const fact of facts) {
    const automationId = fact.listened ? fact.movement_id : fact.named;
    if (automationId !== null) reached.automationIds.add(automationId);
    else if (!fact.listened) reached.untraced = true;
  }
  return reached;
}

async function automationOfRun(asked: { runId: string; teamIds: readonly string[] }): Promise<Owner | undefined> {
  return (await automationsOfRuns({ runIds: [asked.runId], teamIds: asked.teamIds })).get(asked.runId);
}

async function automationOfListen(asked: { triggerId: string; teamIds: readonly string[] }): Promise<Owner | undefined> {
  return (await automationsOfListens({ triggerIds: [asked.triggerId], teamIds: asked.teamIds })).get(asked.triggerId);
}

async function automationOfAsk(asked: { askId: string; teamIds: readonly string[] }): Promise<Owner | undefined> {
  return (await automationsOfAsks({ askIds: [asked.askId], teamIds: asked.teamIds })).get(asked.askId);
}

/**
 * The automation a firing belongs to by the trigger id its run records, for a
 * run whose row may not be written yet: its listen's, else the movement the
 * id names (a carried Run now's own id, an lf run's file). A firing is a run,
 * so one of a listen with no automation is the team's, as the listen is.
 */
async function automationOfTriggerId(asked: { triggerId: string; teamIds: readonly string[] }): Promise<Owner | undefined> {
  const listen = (await automationsOfListens({ triggerIds: [asked.triggerId], teamIds: asked.teamIds })).get(asked.triggerId);
  if (listen !== undefined && listen.automationId !== null) return listen;
  const named = await movementsNamedBy(asked.teamIds.map((teamId) => ({ teamId, triggerId: asked.triggerId })));
  for (const teamId of asked.teamIds) {
    const automationId = named.get(`${teamId}:${asked.triggerId}`);
    if (automationId !== undefined) return { teamId, automationId };
  }
  return listen;
}

const Whose = {
  automationOfTriggerId,
  automationsOfRuns,
  automationsOfListens,
  automationsOfAsks,
  automationsReachedBy,
  automationOfRun,
  automationOfListen,
  automationOfAsk,
};

export { Whose, type Owner };
