// The rows a carried version's schedules and polls run from: a trigger row no
// listen plan owns, on an automation pinned to that version. Nothing here loads a
// version: a drain with no such rows never reads its package.

import { sql } from 'kysely';

import { versionOf, type ListeningLane } from '@listen-fire/language-versions';

import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb } from '../../lib/kysely';
import { lfEngineTeams } from '../lf_engine/team_engine';

export interface CarriedListenRow {
  id: string;
  teamId: TeamId;
  name: string;
  kind: string;
  config: unknown;
  credentialsId: string | null;
  movementId: string;
  runMode: string;
  pin: string;
  pollCheckpoint: unknown;
  pollLastAt: Date | null;
  cronLastFiredAt: Date | null;
}

interface Raw {
  id: string;
  team_id: string;
  name: string;
  kind: string;
  config: unknown;
  credentials_id: string | null;
  movement_id: string;
  run_mode: string;
  language_version: string;
  poll_checkpoint: unknown;
  poll_last_at: Date | null;
  cron_last_fired_at: Date | null;
}

/** A row that fires as a carried version's listen: a leftover a run keeps fires
 *  nothing, and a row with a listen plan is the current version's. */
function asCarried(raw: Raw): CarriedListenRow | null {
  const config = (raw.config ?? {}) as Record<string, unknown>;
  if ('listen' in config || config.leftoverForUnfinishedRuns === true) return null;
  if (versionOf(raw.language_version)?.listenRows === undefined) return null;
  return {
    id: raw.id,
    teamId: raw.team_id as TeamId,
    name: raw.name,
    kind: raw.kind,
    config: raw.config,
    credentialsId: raw.credentials_id,
    movementId: raw.movement_id,
    runMode: raw.run_mode,
    pin: raw.language_version,
    pollCheckpoint: raw.poll_checkpoint,
    pollLastAt: raw.poll_last_at,
    cronLastFiredAt: raw.cron_last_fired_at,
  };
}

function rowQuery() {
  return getAutomationsQb(['trigger', 'movement'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .select([
      'trigger.id as id',
      'trigger.team_id as team_id',
      'trigger.name as name',
      'trigger.kind as kind',
      'trigger.config as config',
      'trigger.credentials_id as credentials_id',
      'trigger.movement_id as movement_id',
      'trigger.run_mode as run_mode',
      'movement.language_version as language_version',
      'trigger.poll_checkpoint as poll_checkpoint',
      'trigger.poll_last_at as poll_last_at',
      'trigger.cron_last_fired_at as cron_last_fired_at',
    ]);
}

/** The active rows of a carried version, of one kind or of every kind. A team
 *  whose engine is lf is not fired for: a cloud lf runs its listens. */
export async function carriedListenRows(input: { kind?: string } = {}): Promise<CarriedListenRow[]> {
  let query = rowQuery().where('trigger.run_mode', '!=', 'off').where(sql<boolean>`not (trigger.config ? 'listen')`);
  if (input.kind !== undefined) query = query.where('trigger.kind', '=', input.kind);
  const [rows, lfTeams] = await Promise.all([query.execute(), lfEngineTeams()]);
  return rows.flatMap((raw) => {
    if (lfTeams.has(raw.team_id)) return [];
    const row = asCarried(raw as Raw);
    return row === null ? [] : [row];
  });
}

/**
 * The row, locked for the caller's open transaction, when it still is a carried
 * version's listen. An upgrade writes the row in its own transaction, so a turn on
 * the row and a move happen one after the other: a turn that waited for a move
 * finds a current listen, and leaves it. Null for that, or a row gone.
 *
 * It does not ask whether the team's engine is lf: that read goes to the shared
 * pool, and a caller holding its transaction's connection while it waits there
 * hangs for good once enough turns do. A turn asks (`isLfEngineTeam`) before it
 * opens its transaction.
 */
export async function lockCarriedListenRow(id: TriggerId): Promise<CarriedListenRow | null> {
  const raw = await rowQuery().where('trigger.id', '=', id).forUpdate('trigger').executeTakeFirst();
  if (raw === undefined) return null;
  return asCarried(raw as Raw);
}

/** The lane that reads a row: loaded only now, for a row it has to read. */
export async function laneOfRow(row: Pick<CarriedListenRow, 'pin'>): Promise<ListeningLane | undefined> {
  return versionOf(row.pin)?.listenRows?.();
}
