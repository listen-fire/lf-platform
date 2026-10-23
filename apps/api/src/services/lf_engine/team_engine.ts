// Which engine runs a team's automations: the platform (the default) or a cloud
// lf. A per-team setting in `automations.team_engine`, switched from the team's
// settings page or the operator CLI (`switch.ts` does the switching). For an
// lf-engined team the movements slot serves the team's movements to lf and the
// platform's dispatch drops every live firing; for any other team the reverse,
// so the two never both run one team's listeners.
//
// Dispatch reads the setting on every firing, so it reads it through a
// process-wide copy of the set of lf-engined teams that lives
// `LF_ENGINE_COPY_LIFETIME_MS`: at most one small query per process per lifetime,
// and none at all for a process that dispatches nothing. A switch is seen at
// once by the process that made it and within the lifetime by every other one,
// which is why a switch to lf waits that long before lf may start.

import { z } from 'zod';

import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';

export const TEAM_ENGINES = ['platform', 'lf'] as const;
export type TeamEngine = (typeof TEAM_ENGINES)[number];

const teamEngineSchema = z.enum(TEAM_ENGINES);

export interface TeamEngineSetting {
  engine: TeamEngine;
  /** When the team was last switched; null when it never was. */
  changedAt: Date | null;
  /** The user who last switched it; null for the operator CLI or never. */
  changedBy: string | null;
}

/** The team's setting, read now (not through the dispatch copy). */
export async function readTeamEngine(teamId: string): Promise<TeamEngineSetting> {
  const row = await getAutomationsQb(['team_engine'])
    .selectFrom('team_engine')
    .where('team_id', '=', teamId)
    .select(['engine', 'changed_at', 'changed_by'])
    .executeTakeFirst();
  if (row === undefined) return { engine: 'platform', changedAt: null, changedBy: null };
  return { engine: teamEngineSchema.parse(row.engine), changedAt: row.changed_at, changedBy: row.changed_by };
}

/**
 * Store the team's engine. Only a change writes, so the audit trail holds one
 * entry per switch rather than one per click. Forgets this process's copy, so
 * its next dispatch reads the new setting.
 */
export async function writeTeamEngine(
  teamId: string,
  change: { engine: TeamEngine; changedBy: string | null },
): Promise<{ previous: TeamEngine }> {
  const { engine: previous } = await readTeamEngine(teamId);
  if (previous !== change.engine) {
    const changedAt = new Date();
    await getAutomationsQb(['team_engine'])
      .insertInto('team_engine')
      .values({ team_id: teamId, engine: change.engine, changed_at: changedAt, changed_by: change.changedBy })
      .onConflict((oc) =>
        oc.column('team_id').doUpdateSet({ engine: change.engine, changed_at: changedAt, changed_by: change.changedBy }),
      )
      .execute();
  }
  forgetLfEngineTeams();
  return { previous };
}

/** How long a process trusts its copy of the set of lf-engined teams. */
export const LF_ENGINE_COPY_LIFETIME_MS = 5 * SECOND;

let copy: { teams: ReadonlySet<string>; readAt: number } | undefined;
let pending: Promise<ReadonlySet<string>> | undefined;
// Bumped by every forget, so a read that began before a switch never stores
// what it read as the current copy.
let generation = 0;

async function readLfEngineTeams(): Promise<ReadonlySet<string>> {
  const startedAt = Date.now();
  const startedIn = generation;
  const rows = await getAutomationsQb(['team_engine'])
    .selectFrom('team_engine')
    .where('engine', '=', 'lf')
    .select('team_id')
    .execute();
  const teams = new Set(rows.map((row) => row.team_id));
  if (startedIn === generation) copy = { teams, readAt: startedAt };
  return teams;
}

/** The lf-engined teams, as this process last read them (at most
 *  `LF_ENGINE_COPY_LIFETIME_MS` ago). Concurrent callers share one read. */
export async function lfEngineTeams(): Promise<ReadonlySet<string>> {
  if (copy !== undefined && Date.now() - copy.readAt < LF_ENGINE_COPY_LIFETIME_MS) return copy.teams;
  if (pending === undefined) {
    const read = readLfEngineTeams().finally(() => {
      if (pending === read) pending = undefined;
    });
    pending = read;
  }
  return pending;
}

export async function isLfEngineTeam(teamId: string): Promise<boolean> {
  return (await lfEngineTeams()).has(teamId);
}

/** Drop this process's copy; the next caller reads the table. */
export function forgetLfEngineTeams(): void {
  generation += 1;
  copy = undefined;
  pending = undefined;
}

/**
 * Boot check. Before the setting, the engine switch was the LF_ENGINE_TEAMS
 * environment list (0.12.0-rc.11). A deployment upgraded with it still set
 * would silently hand its listed teams back to the platform while their cloud
 * lf still runs them, so it refuses to boot, naming the variable and the
 * remedy.
 */
export function assertLfEngineTeamsRetired(env: Record<string, string | undefined> = process.env): void {
  if ((env.LF_ENGINE_TEAMS ?? '').trim() === '') return;
  throw new Error(
    "LF_ENGINE_TEAMS is retired: a team's engine is now a setting. Switch each listed team with " +
      '`pnpm cli team-engine --team <id> --set lf` (or on its team settings page), then unset LF_ENGINE_TEAMS.',
  );
}
