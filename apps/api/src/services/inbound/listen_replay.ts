// A replay: one kept delivery put through one listen again, the way out of
// an `Arrival Not Judged` fact once the provider whose lookup failed answers
// again (listen-fire's `listens replay`; ruling 4: any team member may).
//
// - The delivery's kept request is read again by the listen's module, as it
//   was received, its lookups made afresh. Its signature is not checked: the
//   request is the platform's own capture. A module that checks its own
//   requests is told it is a replay.
// - A page made no request a module could read again (a poll's, a module's
//   push, a door that built its own arrivals): the arrivals it read are judged
//   again, the module asked nothing. A poll's, only by a listen that shared
//   the poll; any other, only by a listen on the module it came from.
// - Only the arrivals the delivery brought are judged, by the named listen
//   alone. Every other listen on the delivery is left as it is.
// - A run it fires is kept as a delivery's is, in one write: a replay
//   delivery of its own (`replay_of`), its `fire_event` row and its waits.
//   Its arrivals were logged with the delivery replayed, and are not again.
// - The listen's receipt holds: a listen that ran the arrival before runs
//   nothing and says so. `force` runs it again under a receipt of its own.
// - A listen that still cannot judge it is kept as the next attempt, its
//   delivery still the one replayed.
// - A listen of an automation pinned to a carried version is replayed by that
//   version: its own module reads the request again, its own judge judges it,
//   and each event its filter takes runs on its pin through dispatch, under
//   the version's own gate (carried_delivery.ts `replayThroughCarriedListen`).
// - It judges each arrival as it stands, never behind another the listen
//   waits on. One it judges, to run or not, the listen no longer waits on,
//   and nothing of that wait is kept; one it still cannot judge for a reason
//   no retry answers, it no longer waits on either.

import { sql } from 'kysely';
import type { Arrival } from 'engine-contracts';
import { arrivalReceiptKey, deliveryBody } from 'movement-engine/public/inbound';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';

import { getAutomationsQb } from '../../lib/kysely';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { forgetJudged, keepUnjudgedIn, stopWaiting } from '../lf_store/records_door';
import { inTransaction, type Exec } from '../lf_store/scope';
import { announceQueued, queueRow } from '../movement_engine/run_host_queue';
import { notifyWork } from '../work/drain';
import { pollSubscriptionId } from '../poll_source/worker';
import { readKeptRequest, type CapturedRequest } from './captured_request';
import { listenEdgeKeysOf } from './listen_edge';
import { judgeArrivals, keepJudgedDelivery, retryRowsFor, savedListenOf, unjudgedFacts, type Judged, type JudgeHost, type SavedListen } from './listen_door';
import { replayThroughCarriedListen } from './carried_delivery';
import { carriedListens, kindsOf } from './carried_listens';
import { deliveryOriginOf } from './delivery_origin';

/** What a replay did, said in lines a person reads. */
export type ReplayOutcome =
  /** It could not be replayed at all: no such listen or delivery, or no
   *  request kept. Nothing was judged. */
  | { outcome: 'refused'; reason: string }
  | {
      outcome: 'replayed';
      /** The runs it queued (their `fire_event` rows run them). */
      runIds: string[];
      /** The replay's own delivery, when it queued a run. */
      replayDeliveryId: string | null;
      /** The attempt the listen's facts were kept as. */
      attempt: number;
      /** Whether the listen still cannot judge an arrival it brought. */
      stillUndecided: boolean;
      lines: string[];
    };

export interface KeptDeliveryRow {
  id: string;
  subscriptionId: string;
  source: string;
  replayOf: string | null;
  request: unknown;
  /** The connection it was kept for, when it was recorded. */
  credentialsId: string | null;
}

export async function deliveryOf(teamId: TeamId, deliveryId: string): Promise<KeptDeliveryRow | null> {
  const { rows } = await sql<{ id: string; subscription_id: string; source: string; replay_of: string | null; request: unknown; credentials_id: string | null }>`
    select id::text as id, subscription_id, source, replay_of::text as replay_of, request, credentials_id::text as credentials_id
    from automations.delivery
    where team_id = ${teamId}::uuid and id::text = ${deliveryId}::text`.execute(getAutomationsQb(['delivery']));
  const row = rows[0];
  return row === undefined
    ? null
    : { id: row.id, subscriptionId: row.subscription_id, source: row.source, replayOf: row.replay_of, request: row.request, credentialsId: row.credentials_id };
}

export async function adapterTypeOf(triggerId: TriggerId): Promise<string | null> {
  const row = await getAutomationsQb(['trigger']).selectFrom('trigger').where('id', '=', triggerId).select('kind').executeTakeFirst();
  return row?.kind ?? null;
}

/** What a kept delivery brings a listen again, or why it cannot: its module
 *  refused to read it, or it is not the listen's to read. A module that
 *  could not be reached throws. */
export type KeptArrivals = { arrivals: Arrival[]; credentialsId: string | null } | { refused: string };

/** The kept request read again by the listen's module, with the listen's
 *  connection: a module that checks its own requests is told it is a replay;
 *  any other reads the body as its door handed it. Only the arrivals the
 *  delivery brought, when it named them. */
export async function reread(listen: SavedListen, adapterType: string, request: CapturedRequest): Promise<{ arrivals: Arrival[] } | { refused: string }> {
  const adapter = await resolveAdapter({
    adapterType,
    teamId: listen.teamId,
    ...(listen.credentialsId !== null ? { credentialsId: listen.credentialsId } : {}),
  });
  const checkpoint = request.checkpoint !== undefined ? { checkpoint: request.checkpoint } : {};
  let arrivals: Arrival[];
  if (adapter.preprocessInbound !== undefined) {
    const raw = deliveryBody(Buffer.from(request.body, 'base64'), request.headers);
    ({ arrivals = [] } = await adapter.preprocessInbound({ raw, ...checkpoint }));
  } else if (adapter.checkInbound !== undefined) {
    const { method, path, query, headers, body } = request;
    const checked = await adapter.checkInbound({ request: { method, path, query, headers, body }, ...checkpoint, replayed: true });
    if (checked.outcome !== 'accepted') return { refused: `${adapterType} did not accept its own kept request on replay (${checked.outcome})` };
    arrivals = checked.arrivals ?? [];
  } else {
    return { refused: `${adapterType} reads no inbound requests: its delivery cannot be read again` };
  }
  const brought = request.arrivalIds;
  if (brought === undefined) return { arrivals };
  return { arrivals: arrivals.filter((arrival) => !('gone' in arrival) && brought.includes(arrivalReceiptKey(arrival))) };
}

/** One more than the latest attempt kept for any of `arrivals` by the
 *  listen; the first replay is 1 (the delivery's own judging is 0). */
async function nextAttempt(teamId: TeamId, pipeline: string, arrivals: readonly Arrival[]): Promise<number> {
  return nextAttemptFor(teamId, pipeline, arrivals.flatMap((arrival) => ('gone' in arrival ? [] : [arrivalReceiptKey(arrival)])));
}

/** `nextAttempt` of the arrivals whose receipt keys are `keys`. */
export async function nextAttemptFor(teamId: TeamId, pipeline: string, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 1;
  const { rows } = await sql<{ latest: number | null }>`
    select max(attempt) as latest from automations.arrival_unjudged
    where team_id = ${teamId}::uuid and pipeline = ${pipeline}::text and arrival = any(${[...keys]}::text[])`.execute(getAutomationsQb(['arrival_unjudged']));
  const latest = rows[0]?.latest ?? null;
  return latest === null ? 1 : Math.max(latest + 1, 1);
}

export async function ranBefore(teamId: TeamId, pipeline: string, receipt: string): Promise<boolean> {
  const { rows } = await sql`
    select 1 from automations.event_receipt where team_id = ${teamId}::uuid and listen = ${pipeline}::text and key = ${receipt}::text`.execute(
    getAutomationsQb(['event_receipt']),
  );
  return rows.length > 0;
}

/** What the kept delivery `row` brings `listen` (on `adapterType`'s module)
 *  again: the page a door read, when the listen may read it, else its
 *  request read again by the module. */
export async function keptArrivalsFor(input: { listen: SavedListen; adapterType: string; row: KeptDeliveryRow }): Promise<KeptArrivals> {
  const { listen, adapterType, row } = input;
  const named = `${listen.file}:${listen.plan.movement}`;
  if (row.request === null) {
    return {
      refused:
        row.replayOf !== null
          ? `delivery ${row.id} is a replay of ${row.replayOf}: replay ${row.replayOf} itself`
          : `delivery ${row.id} kept no request (it was kept before deliveries kept theirs): it cannot be replayed`,
    };
  }
  const kept = readKeptRequest(row.request);
  if (kept === null) return { refused: `delivery ${row.id}'s kept request is not one the platform can read` };
  if ('page' in kept) {
    if (row.source === 'poll') {
      if (!listenEdgeKeysOf(listen, ['polled']).some(({ digest }) => pollSubscriptionId(digest) === row.subscriptionId)) {
        return {
          refused: `delivery ${row.id} is a poll's page, read for the listens that shared that poll: ${named} is not one of them (it may have been edited since, or its connection changed)`,
        };
      }
    } else if (kept.page.adapter !== adapterType) {
      return { refused: `delivery ${row.id} came from ${kept.page.adapter}: ${named} listens on ${adapterType}` };
    }
    return { arrivals: kept.page.arrivals, credentialsId: kept.page.credential ?? null };
  }
  const read = await reread(listen, adapterType, kept.request);
  return 'refused' in read ? read : { arrivals: read.arrivals, credentialsId: listen.credentialsId };
}

/** The arrivals of `judged` its listen settled, to run or not. */
export function settledArrivals(judged: Judged, arrivals: readonly Arrival[]): string[] {
  const unsettled = new Set(judged.unjudged.map((u) => u.fact.arrival));
  return arrivals.flatMap((arrival) => ('gone' in arrival ? [] : [arrivalReceiptKey(arrival)])).filter((key) => !unsettled.has(key));
}

/** What a replay's judging leaves of the listen's wait, in one write: the
 *  arrivals it settled forgotten (their facts with them, when it waited on
 *  them), and each it still cannot judge, for a reason no retry answers, no
 *  longer waited on. One its host still cannot reach keeps waiting. */
async function afterReplay(exec: Exec, input: { teamId: TeamId; pipeline: string; judged: Judged; arrivals: readonly Arrival[] }): Promise<void> {
  const scope = { tenant: input.teamId };
  await forgetJudged(exec, scope, { pipeline: input.pipeline, arrivals: settledArrivals(input.judged, input.arrivals) });
  const released = input.judged.unjudged.filter((u) => !u.fact.waiting).map((u) => u.fact.arrival);
  await stopWaiting(exec, scope, { pipeline: input.pipeline, arrivals: released });
}

/** What a replay through a listen that is not the team's answers. A route that
 *  may not show the caller the listen's automation answers the same. */
export function noSuchListen(triggerId: string): ReplayOutcome {
  return { outcome: 'refused', reason: `no listen ${triggerId} in this team` };
}

/** A replay through a listen a carried version judges: through that
 *  version's own lane, as dispatch reads its deliveries. */
async function replayCarried(input: { teamId: TeamId; triggerId: TriggerId; deliveryId: string; force: boolean }): Promise<ReplayOutcome> {
  const { teamId } = input;
  const [listen] = await carriedListens({ teamId, triggerId: input.triggerId });
  if (listen === undefined) return noSuchListen(input.triggerId);
  const row = await deliveryOf(teamId, input.deliveryId);
  if (row === null) return { outcome: 'refused', reason: `no delivery ${input.deliveryId} is kept for this team: a delivery past its retention is forgotten` };
  if (row.request === null) {
    return {
      outcome: 'refused',
      reason:
        row.replayOf !== null
          ? `delivery ${row.id} is a replay of ${row.replayOf}: replay ${row.replayOf} itself`
          : `delivery ${row.id} kept no request (it was kept before deliveries kept theirs): it cannot be replayed`,
    };
  }
  const kept = readKeptRequest(row.request);
  if (kept === null) return { outcome: 'refused', reason: `delivery ${row.id}'s kept request is not one the platform can read` };
  const origin = await deliveryOriginOf({ teamId, deliveryId: row.id });
  if (origin === null || origin.adapterType === null) {
    return { outcome: 'refused', reason: `delivery ${row.id} does not say which module delivered it: it cannot be replayed` };
  }
  const named = `${listen.file}:${listen.watch.movement}`;
  if (!kindsOf({ adapterType: origin.adapterType }).includes(listen.row.kind)) {
    return { outcome: 'refused', reason: `delivery ${row.id} came from ${origin.adapterType}: ${named} listens on ${listen.row.kind}` };
  }
  const credentialsId = origin.credentialsId ?? ('page' in kept ? kept.page.credential ?? null : null);
  return replayThroughCarriedListen({ teamId, listen, delivery: row, kept, origin: { adapterType: origin.adapterType, credentialsId }, force: input.force });
}

/**
 * Put the kept delivery `deliveryId` through the listen `triggerId` of
 * `teamId` again. Refused, judging nothing, when either is not the team's,
 * or the delivery kept no request.
 */
export async function replayThroughListen(input: {
  teamId: TeamId;
  triggerId: TriggerId;
  deliveryId: string;
  force?: boolean;
  now?: Date;
  host?: JudgeHost;
}): Promise<ReplayOutcome> {
  const { teamId, deliveryId } = input;
  const now = input.now ?? new Date();
  const force = input.force === true;
  const listen = await savedListenOf(input.triggerId);
  if (listen === null) return replayCarried({ teamId, triggerId: input.triggerId, deliveryId, force });
  if (listen.teamId !== teamId) return noSuchListen(input.triggerId);
  const adapterType = await adapterTypeOf(input.triggerId);
  if (adapterType === null) return noSuchListen(input.triggerId);
  const named = `${listen.file}:${listen.plan.movement}`;
  const row = await deliveryOf(teamId, deliveryId);
  if (row === null) return { outcome: 'refused', reason: `no delivery ${deliveryId} is kept for this team: a delivery past its retention is forgotten` };
  const brought = await keptArrivalsFor({ listen, adapterType, row });
  if ('refused' in brought) return { outcome: 'refused', reason: brought.refused };
  const { arrivals, credentialsId } = brought;

  const lines: string[] = [];
  const attempt = await nextAttempt(teamId, listen.pipeline, arrivals);
  const judged = await judgeArrivals({
    listens: [listen],
    delivery: { adapterType, credentialsId },
    arrivals,
    now,
    attempt,
    replaying: true,
    ...(input.host !== undefined ? { host: input.host } : {}),
  });
  for (const { fact } of judged.unjudged) {
    lines.push(`${named}: the arrival ${fact.arrival} on ${fact.edge} still cannot be judged (${fact.reason}): reported again, attempt ${attempt}`);
  }
  const stillUndecided = judged.unjudged.length > 0;
  if (!force) {
    const fresh = [];
    for (const run of judged.minted) {
      if (await ranBefore(teamId, listen.pipeline, run.receipt)) lines.push(`${named}: ran the arrival ${run.arrival.identity} before: nothing replayed (force runs it again)`);
      else fresh.push(run);
    }
    judged.minted = fresh;
  }
  if (judged.minted.length === 0) {
    if (judged.unjudged.length > 0) {
      const facts = await unjudgedFacts({ teamId, undecided: judged.unjudged, deliveryId: row.id, now });
      const queued = await inTransaction(async (trx) => {
        for (const fact of facts) await keepUnjudgedIn(trx, { tenant: teamId }, fact);
        await afterReplay(trx, { teamId, pipeline: listen.pipeline, judged, arrivals });
        const rows = [];
        for (const retry of retryRowsFor({ teamId, undecided: judged.unjudged, now })) rows.push(await queueRow(trx, { host: 'platform' }, retry));
        return rows;
      });
      await announceQueued(queued);
    } else {
      await afterReplay(getAutomationsQb(['arrival_unjudged']), { teamId, pipeline: listen.pipeline, judged, arrivals });
      if (lines.length === 0) lines.push(`${named}: its filter does not take what delivery ${row.id} brought: nothing to run`);
    }
    return { outcome: 'replayed', runIds: [], replayDeliveryId: null, attempt, stillUndecided, lines };
  }
  const replay = await keepJudgedDelivery({
    teamId,
    subscriptionId: row.subscriptionId,
    adapterType,
    externalId: null,
    source: 'cli',
    arrivals,
    judged,
    replayOf: row.id,
    credentialsId: row.credentialsId,
    ...(force ? { forced: true } : {}),
    now,
  });
  await afterReplay(getAutomationsQb(['arrival_unjudged']), { teamId, pipeline: listen.pipeline, judged, arrivals });
  notifyWork();
  const runIds = replay.fires.map((fire) => fire.runId);
  lines.push(`${named}: delivery ${row.id} replayed, ${runIds.length === 1 ? 'one run' : `${runIds.length} runs`} queued`);
  return { outcome: 'replayed', runIds, replayDeliveryId: replay.deliveryId, attempt, stillUndecided, lines };
}
