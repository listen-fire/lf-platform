// Who answers a poll of one listenable edge (adapter protocol 2.6's
// `poll({ edge, filter?, scope?, cursor? }) → { arrivals, cursor? }`, which
// 2.7 lets say when the edge is next worth polling, `pollAgainAt`): a
// built-in on a module line answers through its module; a remote install, or
// an in-process adapter that polls (the cron unit), through its adapter.
// Whatever answers, the answer is read at this boundary: an answer in the
// settings poll's retired shape (`{ events, checkpoint }`) is refused by name.

import { WirePollEdgeResult, type Arrival } from 'engine-contracts';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { PollEdgeAnswer, PollEdgeInput } from 'module-kit';

import { builtinModulePoll } from '../translation_graph/adapters/builtin_modules';
import { resolveAdapter } from '../translation_graph/adapters/resolve';

/** One poll of an edge: what arrived since the cursor, the next cursor, and
 *  when the module said the edge is next worth polling. */
export interface EdgePolled {
  arrivals: Arrival[];
  cursor?: unknown;
  pollAgainAt?: Date;
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
  // Read first, so an answer whose `pollAgainAt` is no instant is refused by
  // that name rather than as a malformed answer.
  const pollAgainAt = pollAgainAtOf(adapterType, answer);
  const parsed = WirePollEdgeResult.safeParse(answer);
  if (!parsed.success) throw new Error(`${adapterType}: a poll's answer is not { arrivals, cursor }: ${parsed.error.message}`);
  return {
    arrivals: parsed.data.arrivals,
    ...('cursor' in parsed.data ? { cursor: parsed.data.cursor } : {}),
    ...(pollAgainAt !== undefined ? { pollAgainAt } : {}),
  };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** The answer's `pollAgainAt` (adapter protocol 2.7), read here because the
 *  0.13.0 wire schema predates it. One that is not an instant refuses the
 *  whole answer, by name, so its cursor is not kept and the next poll reads
 *  the same page. */
function pollAgainAtOf(adapterType: string, answer: unknown): Date | undefined {
  if (typeof answer !== 'object' || answer === null || !('pollAgainAt' in answer) || answer.pollAgainAt === undefined) return undefined;
  const at = answer.pollAgainAt;
  const instant = typeof at === 'string' && ISO_INSTANT.test(at) ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(instant)) throw new Error(`${adapterType}: a poll answered pollAgainAt ${JSON.stringify(at)}: expected an instant (ISO 8601)`);
  return new Date(instant);
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
