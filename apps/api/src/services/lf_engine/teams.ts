// Which teams run their automations in lf rather than on the platform: a
// deployment act, named in the environment as LF_ENGINE_TEAMS (a
// comma-separated list of team ids). For a listed team the platform's dispatch
// drops every live firing and the movements slot serves the team's movements
// to lf; for any other team the reverse, so the two never both run one
// team's listener. An environment variable rather than a table so that an
// installation that leaves it unset adds no query to any dispatch.

import { z } from 'zod';

export const LF_ENGINE_TEAMS_VARIABLE = 'LF_ENGINE_TEAMS';

type Env = Record<string, string | undefined>;

// guid, not uuid: the dev loop's pinned team ids are not RFC 4122 variants.
const teamId = z.guid();

let memo: { raw: string; teams: ReadonlySet<string> } | undefined;

/** The lf-engined teams; an entry that is not a team id throws, naming the variable. */
export function lfEngineTeams(env: Env = process.env): ReadonlySet<string> {
  const raw = env[LF_ENGINE_TEAMS_VARIABLE] ?? '';
  if (memo?.raw === raw) return memo.teams;
  const teams = new Set<string>();
  for (const entry of raw.split(',')) {
    const id = entry.trim();
    if (id === '') continue;
    if (!teamId.safeParse(id).success) {
      throw new Error(`${LF_ENGINE_TEAMS_VARIABLE}: "${id}" is not a team id (a comma-separated list of team ids).`);
    }
    teams.add(id);
  }
  memo = { raw, teams };
  return teams;
}

export function isLfEngineTeam(teamId: string, env: Env = process.env): boolean {
  return lfEngineTeams(env).has(teamId);
}

/** Boot check: a value that is not a list of team ids fails the deployment,
 *  naming the variable, rather than the first dispatch. */
export function assertLfEngineTeamsConfigured(env: Env = process.env): void {
  lfEngineTeams(env);
}
