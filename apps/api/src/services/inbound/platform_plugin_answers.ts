// The process's one answer cache for host functions, kept honest by the
// membership change feed: a change to who is on a team forgets the team's
// kept answers, and (when it is the membership itself) works out again which
// libraries of the team still stand. One listener serves both, so a change
// made anywhere (this instance, another, a script) reaches them.

import { logger } from 'movement-engine/public/log';

import type { PluginAnswers, PluginQuestion } from 'engine-contracts';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb } from '../../lib/kysely';
import { getDatabaseUrl } from '../../prisma';
import { recomputeLibraryStanding } from '../access/decide';
import { postgresTeamAnswerFeed, type TeamAnswerFeed } from '../lf_movements/team_answer_changes';
import { builtinPluginModule, platformPluginModules } from '../translation_graph/adapters/builtin_modules';
import { platformPluginSpecNamed } from '../translation_graph/movement/plugin_specs';
import { askPluginModule, HostFunctionRefused, PluginAnswerCache, type PluginAnswer } from './plugin_answers';

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One question asked of the module that serves its plugin, in process
 *  (`askPluginModule`). A module that cannot be loaded could not be reached;
 *  a plugin no module of the platform serves is refused. */
async function askInProcess(teamId: TeamId, question: PluginQuestion): Promise<PluginAnswer> {
  const { plugin, args } = question;
  let loaded;
  try {
    loaded = builtinPluginModule(plugin, { teamId });
  } catch (error) {
    return { unreachable: `its module could not be loaded (${messageOf(error)})` };
  }
  const spec = platformPluginSpecNamed(plugin, { modules: platformPluginModules() });
  if (loaded === undefined || spec === undefined) throw new HostFunctionRefused(plugin, 'no module of this platform serves it');
  const module = loaded;
  return askPluginModule({ plugin, args, spec, invoke: (config) => module.invoke({ name: spec.name ?? plugin, config, extractedContext: {} }) });
}

/** The answers to a listen's questions for `teamId`, kept ones at no cost.
 *  Rejects with `HostFunctionRefused` when a module answered an error; any
 *  other rejection (the change feed is not listening) means none could be
 *  asked. */
export function platformHostAnswers(teamId: TeamId, questions: PluginQuestion[]): Promise<PluginAnswers> {
  return platformPluginAnswers().answers(teamId, questions, (question) => askInProcess(teamId, question));
}

/** The same questions asked of the platform's own modules now, past the kept
 *  answers and leaving none behind: what an explanation reports as of now. */
export async function freshHostAnswers(teamId: TeamId, questions: PluginQuestion[]): Promise<PluginAnswers> {
  return Promise.all(questions.map(async (question): Promise<PluginAnswers[number]> => ({ ...question, ...(await askInProcess(teamId, question)) })));
}
