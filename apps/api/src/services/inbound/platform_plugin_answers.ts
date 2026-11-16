// The process's one answer cache for host functions, kept honest by the
// membership change feed: a change to who is on a team forgets the team's
// kept answers, and (when it is the membership itself) works out again which
// libraries of the team still stand. One listener serves both, so a change
// made anywhere (this instance, another, a script) reaches them.

import { logger } from 'movement-engine/public/log';

import type { UserId } from '../../generated/kysely/core/User';
import { getCoreQb } from '../../lib/kysely';
import { getDatabaseUrl } from '../../prisma';
import { recomputeLibraryStanding } from '../access/decide';
import { postgresTeamAnswerFeed, type TeamAnswerFeed } from '../lf_movements/team_answer_changes';
import { platformPluginModules } from '../translation_graph/adapters/builtin_modules';
import { platformPluginSpecNamed } from '../translation_graph/movement/plugin_specs';
import { PluginAnswerCache } from './plugin_answers';

async function teamsOf(userId: UserId): Promise<string[]> {
  const rows = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .where('user_id', '=', userId)
    .select('team_id')
    .execute();
  return rows.map((row) => row.team_id);
}

interface Wired {
  cache: PluginAnswerCache;
  feed: TeamAnswerFeed;
}

let wired: Wired | undefined;

function wire(): Wired {
  if (wired !== undefined) return wired;
  const { url } = getDatabaseUrl(false);
  // Boot requires DATABASE_URL (prisma/index.ts); this only narrows it.
  if (url === undefined) throw new Error('DATABASE_URL is unset');
  const feed: TeamAnswerFeed = postgresTeamAnswerFeed({
    connectionString: url,
    teamsOf,
    changed: async ({ teamId, why }) => {
      platformPluginAnswers().invalidateTeam(teamId);
      if (why !== 'membership') return;
      await recomputeLibraryStanding(teamId).catch((error: unknown) =>
        logger.warn('[team-answers] could not work out a team\'s library standing after its membership changed', {
          teamId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
    lost: () => platformPluginAnswers().invalidateAll(),
  });
  const cache = new PluginAnswerCache({
    maxAgeSeconds: (plugin) => platformPluginSpecNamed(plugin, { modules: platformPluginModules() })?.maxAgeSeconds,
    ready: () => feed.ready(),
  });
  wired = { cache, feed };
  return wired;
}

/** The platform's answers to host-function questions, for the judge. */
export function platformPluginAnswers(): PluginAnswerCache {
  return wire().cache;
}

/** Starts hearing membership changes now rather than at the first question
 *  (the library standing follows them whether or not a listen asks). Returns
 *  what ends it. */
export function startTeamAnswerFeed(): () => Promise<void> {
  const { feed } = wire();
  feed.ready().catch((error: unknown) =>
    logger.warn('[team-answers] could not listen for membership changes yet; the next question tries again', {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return () => feed.close();
}
