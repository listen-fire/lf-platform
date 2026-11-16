// A run's kept answers of pure plugins (`llm.transforms.answer`), for a wait's
// WHERE that calls one (`await m-[x:Replies WHERE team.isMember(x.`User
// Email`)]->`), from the same answers the listen door asks (F3's cache), so a
// wait judges as its listen would.
//
// - A module that could not be reached answers `unreachable`. The engine then
//   leaves the wait's arrival unjudged, with the ones after it, and the run
//   stays parked. Nothing else would wake it (the arrival was logged already),
//   so each wait the run parks while its host is out of reach gets a wake a
//   retry interval on, as the door's waiting arrivals do, and is judged again
//   then, in order.
// - A module that answered an error of its own fails the run, as any plugin
//   call's error fails it: asking again would answer the same.

import { WAKE_AWAIT_WORK_KIND } from 'movement-engine/public/run-host';

import type { PluginAnswers, PluginQuestion } from 'engine-contracts';
import type { HostTransformInvoker } from 'movement-engine/public/host';
import type { ParkSink } from 'movement-engine/public/movement-engine';
import type { TeamId } from '../../generated/kysely/core/Team';

import { HostFunctionRefused, RETRY_UNJUDGED_EVERY_MS } from '../inbound/plugin_answers';

/** A wake row as the run host queues one (`wake_await`). */
export interface WaitWakeRow {
  kind: typeof WAKE_AWAIT_WORK_KIND;
  key: string;
  payload: { runId: string; waitId: string; address: string };
  teamId: string;
  dueAt: string;
}

export interface RunHostAnswers {
  answer: NonNullable<HostTransformInvoker['answer']>;
  /** `sink`, noting each wait it parks, so one parked while the host is out of
   *  reach is woken again. */
  noting(sink: ParkSink): ParkSink;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The key of the one retry wake a wait holds: a second unreachable answer
 *  while it is due moves no other. */
export function hostRetryWakeKey(waitId: string): string {
  return `${WAKE_AWAIT_WORK_KIND}:host:${waitId}`;
}

export function runHostAnswers(input: {
  teamId: TeamId;
  /** The run the waits are its; absent for a run that parks nothing (a test run). */
  runId?: string;
  answers: (teamId: TeamId, questions: PluginQuestion[]) => Promise<PluginAnswers>;
  queue: (row: WaitWakeRow) => Promise<void>;
  now?: () => number;
}): RunHostAnswers {
  const now = input.now ?? Date.now;
  let unreachable = false;
  const parked = new Map<string, string>();
  const woken = new Set<string>();
  const wakeParked = async (): Promise<void> => {
    const { runId } = input;
    if (!unreachable || runId === undefined) return;
    for (const [waitId, address] of parked) {
      if (woken.has(waitId)) continue;
      woken.add(waitId);
      await input.queue({
        kind: WAKE_AWAIT_WORK_KIND,
        key: hostRetryWakeKey(waitId),
        payload: { runId, waitId, address },
        teamId: input.teamId,
        dueAt: new Date(now() + RETRY_UNJUDGED_EVERY_MS).toISOString(),
      });
    }
  };
  return {
    async answer({ plugin, args }) {
      let answered: PluginAnswers;
      try {
        answered = await input.answers(input.teamId, [{ plugin, args }]);
      } catch (error) {
        if (error instanceof HostFunctionRefused) throw new Error(`${plugin}, which this wait's WHERE calls, answered an error (${error.message})`);
        answered = [{ plugin, args, unreachable: messageOf(error) }];
      }
      const [first] = answered;
      if (first === undefined) throw new Error(`${plugin}: the host answered no answer to its question`);
      if ('unreachable' in first) {
        unreachable = true;
        await wakeParked();
        return { unreachable: first.unreachable };
      }
      if (first.value === undefined) throw new Error(`${plugin}, which this wait's WHERE calls, answered no value`);
      return { value: first.value };
    },
    noting(sink) {
      return {
        ...sink,
        async commitAwaitPark(park) {
          await sink.commitAwaitPark(park);
          parked.set(park.waitId, park.address);
          // The engine may have asked before it parked (a wake judging again).
          await wakeParked();
        },
      };
    },
  };
}
