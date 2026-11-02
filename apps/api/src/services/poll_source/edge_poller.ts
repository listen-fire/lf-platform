// Who answers a poll of one listenable edge (adapter protocol 2.6's
// `poll({ edge, filter?, scope?, cursor? }) → { arrivals, cursor? }`): a
// built-in on a module line answers through its module; a remote install, or
// an in-process adapter that polls (the cron unit), through its adapter.
// Whatever answers, the answer is read at this boundary: an answer in the
// settings poll's retired shape (`{ events, checkpoint }`) is refused by name.

import { WirePollEdgeResult, type Arrival } from 'engine-contracts';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { PollEdgeAnswer, PollEdgeInput } from 'module-kit';

import { builtinModulePoll } from '../translation_graph/adapters/builtin_modules';
import { resolveAdapter } from '../translation_graph/adapters/resolve';

/** One poll of an edge: what arrived since the cursor, and the next cursor. */
export interface EdgePolled {
  arrivals: Arrival[];
  cursor?: unknown;
}

export type EdgePoller = (input: PollEdgeInput) => Promise<EdgePolled>;

interface Polls {
  poll(input: PollEdgeInput): Promise<PollEdgeAnswer>;
}

function polls(adapter: object): adapter is Polls {
  return 'poll' in adapter && typeof adapter.poll === 'function';
}

/** The answer as the protocol has it, or why it is not one. */
export function readPollAnswer(adapterType: string, answer: unknown): EdgePolled {
  if (typeof answer === 'object' && answer !== null && 'events' in answer && !('arrivals' in answer)) {
    throw new Error(`${adapterType}: a poll answered events with a checkpoint, the settings poll retired in listen-fire 0.13; a polled edge answers { arrivals, cursor }`);
  }
  const parsed = WirePollEdgeResult.safeParse(answer);
  if (!parsed.success) throw new Error(`${adapterType}: a poll's answer is not { arrivals, cursor }: ${parsed.error.message}`);
  return { arrivals: parsed.data.arrivals, ...('cursor' in parsed.data ? { cursor: parsed.data.cursor } : {}) };
}

/** What polls `adapterType`'s edges for one connection; null for a module
 *  that polls none. */
export async function edgePollerOf(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  constructionArgs?: Record<string, string>;
}): Promise<EdgePoller | null> {
  const install = {
    teamId: input.teamId,
    ...(input.credentialsId !== undefined ? { credentialsId: input.credentialsId } : {}),
    ...(input.constructionArgs !== undefined ? { constructionArgs: input.constructionArgs } : {}),
  };
  const modulePoll = builtinModulePoll(input.adapterType, install);
  if (modulePoll !== undefined) return async (poll) => readPollAnswer(input.adapterType, await modulePoll(poll));
  const adapter = await resolveAdapter({ adapterType: input.adapterType, ...install });
  if (!polls(adapter)) return null;
  return async (poll) => readPollAnswer(input.adapterType, await adapter.poll(poll));
}
