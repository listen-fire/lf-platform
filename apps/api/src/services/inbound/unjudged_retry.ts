// A `retry_unjudged` row: what one listen waits on, judged again. A listen
// whose filter asks a host function the host could not reach keeps the
// arrival waiting (listen_door.ts), and each later arrival it would run waits
// behind it. Its row, one per listen, is due a retry interval after the
// arrival was kept, and judges the line oldest first:
//
// - Each arrival is read again from its kept delivery, as a replay reads it,
//   and judged as it stands. A run it fires is queued as a replay's is (a
//   replay delivery of its own), under the arrival's own receipt, so a run
//   that already ran it, or a retry taken twice, runs nothing more. Once it
//   is judged, to run or not, its facts are forgotten: the team sees its run,
//   or nothing.
// - One its host still cannot answer ends the listen's turn: the row is due
//   again a retry interval on, and no new attempt is noted, so `@lf/system`
//   reports each arrival once, not once per retry.
// - One whose delivery can no longer be read again (forgotten, refused by its
//   module, no longer bringing it), or that its listen still cannot judge for
//   another reason, is let go: noted once more with the reason, not waiting,
//   and the line moves on. One whose module is out of reach keeps waiting.
// - A listen edited or removed since waits on nothing: its new version judges
//   what comes next.

import { arrivalReceiptKey } from 'movement-engine/public/inbound';
import { logger } from 'movement-engine/public/log';
import { neverAsAny } from 'movement-engine/public/types';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { WorkHandler } from '../work/kinds';
import type { UnjudgedArrival } from '../lf_store/records_door';

import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { forgetJudged, keepUnjudgedIn, stopWaiting, waitingLine } from '../lf_store/records_door';
import { inTransaction } from '../lf_store/scope';
import { enqueueWork } from '../work/store';
import { notifyWork, registerWorkHandler } from '../work/drain';
import {
  judgeArrivals,
  keepJudgedDelivery,
  RETRY_UNJUDGED_EVERY_MS,
  RETRY_UNJUDGED_WORK_KIND,
  retryRowOf,
  retryRowSchema,
  savedListenOf,
  unjudgedFacts,
  type JudgeHost,
  type SavedListen,
} from './listen_door';
import { adapterTypeOf, deliveryOf, keptArrivalsFor, nextAttemptFor, ranBefore } from './listen_replay';

/** How a turn through a listen's line ended. */
export type RetryOutcome =
  /** Its host still cannot answer the arrival at its head: due again. */
  | { kind: 'still_waiting'; arrival: string }
  /** The turn judged all it may: the rest is the next turn's, due now. */
  | { kind: 'more' }
  /** It waits on nothing. */
  | { kind: 'done' };

/** How much one turn judges, so a long line never outlasts the row's lease
 *  (a minute, kept alive by its heartbeat): a hundred arrivals, or half a
 *  minute, whichever comes first. The next turn goes on from the head. */
export const RETRY_TURN_ARRIVALS = 100;
export const RETRY_TURN_MS = 30 * SECOND;

/** How one arrival of the line came out. */
type Step = 'settled' | 'still_waiting';

interface Retrying {
  teamId: TeamId;
  listen: SavedListen;
  adapterType: string;
  fact: UnjudgedArrival;
  now: Date;
  host?: JudgeHost;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The arrival let go: noted once more with why, and no longer waited on. */
async function letGo(input: Retrying, reason: string): Promise<Step> {
  const { teamId, listen, fact, now } = input;
  const attempt = await nextAttemptFor(teamId, listen.pipeline, [fact.arrival]);
  const kept: UnjudgedArrival = { ...fact, reason, attempt, at: now.toISOString(), waiting: false };
  await inTransaction(async (trx) => {
    await keepUnjudgedIn(trx, { tenant: teamId }, kept);
    await stopWaiting(trx, { tenant: teamId }, { pipeline: listen.pipeline, arrivals: [fact.arrival] });
  });
  logger.warn(`[RetryUnjudged] ${listen.file}:${listen.plan.movement}: the arrival ${fact.arrival} is let go: ${reason}`);
  return 'settled';
}

/** The arrival judged, to run or not: nothing of its wait is kept. */
async function settle(input: Retrying): Promise<Step> {
  await forgetJudged(getAutomationsQb(['arrival_unjudged']), { tenant: input.teamId }, { pipeline: input.listen.pipeline, arrivals: [input.fact.arrival] });
  return 'settled';
}

/** The arrival at the head of the line, judged again. */
async function retryOne(input: Retrying): Promise<Step> {
  const { teamId, listen, adapterType, fact, now } = input;
  const named = `${listen.file}:${listen.plan.movement}`;
  const row = fact.deliveryId === null ? null : await deliveryOf(teamId, fact.deliveryId);
  if (row === null) return letGo(input, 'its delivery is no longer kept, so it cannot be read again');
  let brought;
  try {
    brought = await keptArrivalsFor({ listen, adapterType, row });
  } catch (error) {
    logger.warn(`[RetryUnjudged] ${named}: the arrival ${fact.arrival} still waits: ${adapterType} could not be reached to read delivery ${row.id} again (${messageOf(error)})`);
    return 'still_waiting';
  }
  if ('refused' in brought) return letGo(input, brought.refused);
  const arrival = brought.arrivals.find((candidate) => !('gone' in candidate) && arrivalReceiptKey(candidate) === fact.arrival);
  if (arrival === undefined || 'gone' in arrival) return letGo(input, `delivery ${row.id} no longer brings it`);
  const judged = await judgeArrivals({
    listens: [listen],
    delivery: { adapterType, credentialsId: brought.credentialsId },
    arrivals: [arrival],
    now,
    attempt: await nextAttemptFor(teamId, listen.pipeline, [fact.arrival]),
    replaying: true,
    ...(input.host !== undefined ? { host: input.host } : {}),
  });
  const undecided = judged.unjudged[0];
  if (undecided !== undefined) {
    if (undecided.fact.waiting) {
      logger.warn(`[RetryUnjudged] ${named}: the arrival ${fact.arrival} still waits: ${undecided.fact.reason}`);
      return 'still_waiting';
    }
    const facts = await unjudgedFacts({ teamId, undecided: judged.unjudged, deliveryId: row.id, now });
    await inTransaction(async (trx) => {
      for (const kept of facts) await keepUnjudgedIn(trx, { tenant: teamId }, kept);
      await stopWaiting(trx, { tenant: teamId }, { pipeline: listen.pipeline, arrivals: [fact.arrival] });
    });
    logger.warn(`[RetryUnjudged] ${named}: the arrival ${fact.arrival} is let go: ${undecided.fact.reason}`);
    return 'settled';
  }
  const run = judged.minted[0];
  if (run === undefined) return settle(input);
  if (await ranBefore(teamId, listen.pipeline, run.receipt)) {
    logger.warn(`[RetryUnjudged] ${named}: ran the arrival ${arrival.identity} before: nothing runs again`);
    return settle(input);
  }
  await keepJudgedDelivery({
    teamId,
    subscriptionId: row.subscriptionId,
    adapterType,
    externalId: null,
    source: 'cli',
    arrivals: [arrival],
    judged,
    replayOf: row.id,
    credentialsId: row.credentialsId,
    now,
  });
  notifyWork();
  return settle(input);
}

/**
 * Judge again, oldest first, what the listen `pipeline` (the trigger
 * `triggerId` of `teamId`) waits on, until its line is empty or its host
 * still cannot answer the arrival at its head. Arrivals that join the line
 * meanwhile are judged in the same turn.
 */
export async function retryWaitingLine(input: {
  teamId: TeamId;
  triggerId: TriggerId;
  pipeline: string;
  now?: Date;
  host?: JudgeHost;
  /** At most this many arrivals this turn (`RETRY_TURN_ARRIVALS`). */
  turnArrivals?: number;
}): Promise<RetryOutcome> {
  const { teamId, pipeline } = input;
  const startedMs = Date.now();
  const turnArrivals = input.turnArrivals ?? RETRY_TURN_ARRIVALS;
  let judged = 0;
  const scope = { tenant: teamId };
  const listen = await savedListenOf(input.triggerId);
  const adapterType = listen === null ? null : await adapterTypeOf(input.triggerId);
  if (listen === null || adapterType === null || listen.teamId !== teamId || listen.pipeline !== pipeline) {
    await stopWaiting(getAutomationsQb(['arrival_unjudged']), scope, { pipeline });
    logger.warn(`[RetryUnjudged] the listen ${pipeline} changed or went since its arrivals were kept waiting: it waits on nothing`);
    return { kind: 'done' };
  }
  for (let line = await waitingLine(scope, pipeline); line.length > 0; line = await waitingLine(scope, pipeline)) {
    for (const fact of line) {
      if (judged >= turnArrivals || Date.now() - startedMs >= RETRY_TURN_MS) return { kind: 'more' };
      judged += 1;
      const now = input.now ?? new Date();
      const step = await retryOne({ teamId, listen, adapterType, fact, now, ...(input.host !== undefined ? { host: input.host } : {}) });
      if (step === 'still_waiting') return { kind: 'still_waiting', arrival: fact.arrival };
    }
  }
  return { kind: 'done' };
}

async function runRetryRow(payload: unknown): Promise<void> {
  const { teamId, triggerId, pipeline } = retryRowSchema.parse(payload);
  const outcome = await retryWaitingLine({ teamId, triggerId, pipeline });
  switch (outcome.kind) {
    case 'done':
      return;
    case 'more': {
      // Re-armed due now, under its lease: the next turn goes on.
      const again = retryRowOf({ teamId, listen: { triggerId, pipeline }, now: new Date() });
      await enqueueWork({ kind: RETRY_UNJUDGED_WORK_KIND, key: again.key, payload: again.payload, teamId, dueAt: new Date() });
      return;
    }
    case 'still_waiting': {
      // Re-armed under its lease, the row is kept when this run completes.
      const again = retryRowOf({ teamId, listen: { triggerId, pipeline }, now: new Date() });
      await enqueueWork({ kind: RETRY_UNJUDGED_WORK_KIND, key: again.key, payload: again.payload, teamId, dueAt: new Date(Date.now() + RETRY_UNJUDGED_EVERY_MS) });
      return;
    }
    default:
      return neverAsAny(outcome);
  }
}

export const retryUnjudgedHandler: WorkHandler = { run: runRetryRow, recover: runRetryRow };

export function registerRetryUnjudgedWork(): void {
  registerWorkHandler(RETRY_UNJUDGED_WORK_KIND, retryUnjudgedHandler);
}
