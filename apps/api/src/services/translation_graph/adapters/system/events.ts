// The platform's records of its own events, which `@lf/system` polls: the
// events no other table records — written here by whatever produces them (the
// deploy check; a run pausing at its cost limit) — and the failed runs, read
// from the run table.
//
// `Run Failed` is not stored here: the run table already records every failure
// from every writer, so the poll reads that. The other kinds happen once, in
// one place, and leave nothing else behind to read.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { SystemEventId } from '../../../../generated/kysely/automations/SystemEvent';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import type {
  FailedRun,
  RunFailedMark,
  StoredEventMark,
  StoredSystemEvent,
  SystemEventKind,
  SystemEventPayload,
  SystemRecords,
} from '@listen-fire/system';

import { getAutomationsQb } from '../../../../lib/kysely';
import { getEnvVar } from '../../../../lib/utils/environment';
import { teamIdSchema } from '../../../../lib/team_id';

export async function recordSystemEvent(input: {
  teamId: string;
  kind: SystemEventKind;
  payload: SystemEventPayload;
}): Promise<void> {
  await getAutomationsQb(['system_event'])
    .insertInto('system_event')
    .values({
      team_id: input.teamId,
      kind: input.kind.typeId,
      payload: input.payload,
      occurred_at: new Date(input.payload.at),
    })
    .execute();
}

/** The team's stored events of `kinds` strictly after `after`, no later than
 *  `until`, oldest first. */
async function readStoredSystemEvents({
  teamId,
  kinds,
  after,
  until,
  limit,
}: {
  teamId: TeamId;
  kinds: readonly string[];
  after: StoredEventMark;
  until: Date;
  limit: number;
}): Promise<StoredSystemEvent[]> {
  if (kinds.length === 0) return [];
  const afterAt = new Date(after.occurredAt);
  const rows = await getAutomationsQb(['system_event'])
    .selectFrom('system_event')
    .where('team_id', '=', teamId)
    .where('kind', 'in', [...kinds])
    .where('occurred_at', '<=', until)
    .where((eb) =>
      eb.or([
        eb('occurred_at', '>', afterAt),
        eb.and([eb('occurred_at', '=', afterAt), eb('id', '>', after.id as SystemEventId)]),
      ]),
    )
    .select(['id', 'kind', 'payload', 'occurred_at'])
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id as string,
    kind: row.kind,
    payload: row.payload as SystemEventPayload,
    occurredAt: row.occurred_at,
  }));
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

/** A run's aggregate errors, as the first message among them. */
function firstErrorMessage(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  for (const error of errors) {
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return undefined;
}

/** A run row's trigger id is engine-side text; only a uuid can name a trigger
 *  row, so anything else (a legacy or simulated run) has no automation. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The team's failed runs strictly after `after`, no later than `until`,
 *  oldest first, each with the automation it belongs to. */
async function readFailedRuns({
  teamId,
  after,
  until,
  limit,
}: {
  teamId: TeamId;
  after: RunFailedMark;
  until: Date;
  limit: number;
}): Promise<FailedRun[]> {
  const afterAt = new Date(after.failedAt);
  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('status', '=', 'failed')
    // A rehearsal failing is the author trying something, not an incident.
    .where('dry_run', '=', false)
    .where('failed_at', 'is not', null)
    .where('failed_at', '<=', until)
    .where((eb) =>
      eb.or([
        eb('failed_at', '>', afterAt),
        eb.and([eb('failed_at', '=', afterAt), eb('id', '>', after.runId as TriggerRunId)]),
      ]),
    )
    .select(['id', 'trigger_id', 'failed_at', 'failure_reason', 'errors'])
    .orderBy('failed_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  if (runs.length === 0) return [];

  const triggerIds = [...new Set(runs.map((r) => r.trigger_id).filter((id) => UUID.test(id)))];
  const triggers =
    triggerIds.length === 0
      ? []
      : await getAutomationsQb(['trigger'])
          .selectFrom('trigger')
          .where('team_id', '=', teamId)
          .where('id', 'in', triggerIds as TriggerId[])
          .where('movement_id', 'is not', null)
          .select(['id', 'movement_id'])
          .execute();
  const movementByTrigger = new Map(
    triggers.map((t) => [t.id as string, t.movement_id as string]),
  );

  const movementIds = [...new Set(movementByTrigger.values())];
  const movements =
    movementIds.length === 0
      ? []
      : await getAutomationsQb(['movement'])
          .selectFrom('movement')
          .where('team_id', '=', teamId)
          .where('id', 'in', movementIds as MovementId[])
          .select(['id', 'name'])
          .execute();
  const nameByMovement = new Map(movements.map((m) => [m.id as string, m.name]));

  return runs.flatMap((run) => {
    // Unreachable (the query requires it), but the column type cannot say so.
    if (run.failed_at === null) return [];
    const automationId = movementByTrigger.get(run.trigger_id);
    const name = automationId === undefined ? undefined : nameByMovement.get(automationId);
    return [
      {
        runId: run.id as string,
        automation:
          automationId !== undefined && name !== undefined ? { id: automationId, name } : null,
        reason:
          run.failure_reason ?? firstErrorMessage(run.errors) ?? 'The run failed without a recorded reason.',
        failedAt: run.failed_at,
      },
    ];
  });
}

/** What the platform hands `@lf/system`: its records of its own events, for
 *  the tenant the module is loaded for. */
export const platformSystemRecords: SystemRecords = {
  failedRuns: ({ tenant, ...rest }) => readFailedRuns({ teamId: teamIdSchema.parse(tenant), ...rest }),
  storedEvents: ({ tenant, ...rest }) => readStoredSystemEvents({ teamId: teamIdSchema.parse(tenant), ...rest }),
  webBaseUrl,
};
