// Which automation owns a run, a listen or a question: the automation a route's
// decision is about when the route names one of these instead of the automation.
//
// Each answer comes from the rows the engine writes, never from what a caller
// supplied. Something that belongs to no automation (a listen whose movement is
// gone, a question a REST caller asked) has no statement, so only team
// membership decides it, as it did before statements existed.

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

/** Where something lives, and the automation it belongs to (null: none). */
type Owner = { teamId: string; automationId: string | null };

const uuid = z.string().uuid();

/** Postgres refuses a malformed uuid with an error; an id that is not one names nothing. */
function uuids(ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => uuid.safeParse(id).success);
}

/** What a queued run's work row says it runs. */
const queuedPayload = z.object({ runId: z.string(), triggerId: z.string().optional(), movementId: z.string().optional() });

/** What the engine records on a question it asks: info, so only ever narrowing who sees it. */
const askProvenance = z.object({ movementId: z.string().optional(), runId: z.string().optional() });

/** An lf run's trigger id names its file: `listen:<file>:<movement>`. */
function lfFileOf(triggerId: string): string | null {
  return /^listen:(.+):[^:]+$/.exec(triggerId)?.[1] ?? null;
}

/**
 * The automation each of these runs belongs to, for the runs that live in
 * these teams. A run missing from the answer is not in them. A run is its
 * pinned version's movement, else its listen's, else (a Run now of a carried
 * version, or an lf run) the movement its trigger id names.
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
    const automationId =
      (run.versionId !== null ? byVersion.get(run.versionId) : undefined) ??
      byListen.get(run.triggerId)?.automationId ??
      movements.get(`${run.teamId}:${run.triggerId}`) ??
      null;
    owners.set(run.runId, { teamId: run.teamId, automationId });
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

/**
 * The automation each of these questions belongs to, for the questions in
 * these teams: the run waiting on it, else the run or movement the engine
 * recorded on it when it asked.
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
  const waits = await getAutomationsQb(['wait_row'])
    .selectFrom('wait_row')
    .where('adapter_type', '=', ASK_ADAPTER_TYPE)
    .where('edge', '=', RESPONSE_EDGE_NAME)
    .where('key', 'in', askIds)
    .select(['key', 'run_id'])
    .execute();
  const waitingRun = new Map(waits.flatMap((wait) => (wait.key === null ? [] : [[wait.key, String(wait.run_id)] as const])));
  const recorded = new Map(
    asks.map((ask) => {
      const provenance = askProvenance.safeParse(ask.provenance);
      return [String(ask.id), provenance.success ? provenance.data : {}] as const;
    }),
  );
  const runOf = (askId: string) => waitingRun.get(askId) ?? recorded.get(askId)?.runId;
  const runOwners = await automationsOfRuns({
    runIds: askIds.flatMap((askId) => runOf(askId) ?? []),
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

  const owners = new Map<string, Owner>();
  for (const ask of asks) {
    const askId = String(ask.id);
    const run = runOf(askId);
    const movementId = recorded.get(askId)?.movementId;
    const automationId =
      (run !== undefined ? runOwners.get(run)?.automationId : undefined) ??
      (movementId !== undefined && movements.has(movementId) ? movementId : null);
    owners.set(askId, { teamId: ask.team_id, automationId });
  }
  return owners;
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
 * id names (a carried Run now's own id, an lf run's file).
 */
async function automationOfTriggerId(asked: { triggerId: string; teamIds: readonly string[] }): Promise<Owner | undefined> {
  const listen = (await automationsOfListens({ triggerIds: [asked.triggerId], teamIds: asked.teamIds })).get(asked.triggerId);
  if (listen !== undefined) return listen;
  const named = await movementsNamedBy(asked.teamIds.map((teamId) => ({ teamId, triggerId: asked.triggerId })));
  for (const teamId of asked.teamIds) {
    const automationId = named.get(`${teamId}:${asked.triggerId}`);
    if (automationId !== undefined) return { teamId, automationId };
  }
  return undefined;
}

const Whose = {
  automationOfTriggerId,
  automationsOfRuns,
  automationsOfListens,
  automationsOfAsks,
  automationOfRun,
  automationOfListen,
  automationOfAsk,
};

export { Whose, type Owner };
