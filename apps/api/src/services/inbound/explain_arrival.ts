// "Why didn't this fire?": one event of a kept delivery judged again against
// each listen on the delivery's connection that the asker may read, saying for
// each what the judge makes of it and the first term of its filter that failed.
//
// - Only listens of automations the asker may read are listed; the others are
//   not mentioned, as the rest of the platform leaves out what is not readable.
// - A filter that calls a host function asks its host now (through the kept
//   answers), so what it says is as of the question, not as of the event's
//   arrival, and the answer says so.
// - Nothing is kept: no run, no fact, no row. Only the host's answer cache,
//   which the door itself fills, may hold what the host said.

import type { Arrival, ArrivedRecord, PlanArrival, PluginAnswers, Verdict } from 'engine-contracts';
import { explainArrival, landingMisfits, listenFires, namedArrival, type DeclaredNode, type FieldIdsByType } from 'movement-engine/public/inbound';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';

import { unseen } from '../../interfaces/access_route';
import { getAutomationsQb } from '../../lib/kysely';
import { noSuchEvent, inBroughtOrder } from '../translation_graph/movement/run_now';
import { readKeptRequest } from './captured_request';
import { deliveryOriginOf } from './delivery_origin';
import { savedListens, type SavedListen } from './listen_door';
import { deliveryOf, reread } from './listen_replay';
import { platformHostAnswers } from './platform_plugin_answers';
import { HostFunctionRefused } from './plugin_answers';

/** What the judge makes of the event for one listen, in words a person reads. */
export type ExplainedVerdict = 'fires' | 'does_not_fire' | 'cannot_tell' | 'not_heard';

export interface ExplainedListen {
  automationId: string;
  automationName: string;
  /** The listen, as listArrivals names it. */
  listen: string;
  verdict: ExplainedVerdict;
  /** The first term of the filter that failed, as the filter is normalised from the program (a host function by its catalog key). */
  firstFailed?: string;
  /** Why, when the term alone does not say. */
  reason?: string;
  /** Whether the host was asked to judge it; the answers are as of the question. */
  hostAnswers: { used: false } | { used: true; asOf: string; note: string };
}

export interface ExplainedArrival {
  ok: true;
  deliveryId: string;
  arrivalIndex: number;
  /** The edge the event arrived on. */
  edge: string;
  listens: ExplainedListen[];
}

export type ExplainArrivalResult = ExplainedArrival | { ok: false; errors: string[] };

const AS_OF_NOW = 'a host function was asked now: its answer is as of this question, not as of when the event arrived';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The automation each of `triggerIds` belongs to. */
async function automationsOf(triggerIds: readonly TriggerId[]): Promise<Map<string, string>> {
  if (triggerIds.length === 0) return new Map();
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('id', 'in', [...triggerIds])
    .select(['id', 'movement_id'])
    .execute();
  return new Map(rows.flatMap((row): [string, string][] => (row.movement_id === null ? [] : [[row.id, row.movement_id]])));
}

/** A record as the judge reads it: its fields, not its id. */
function arrivedRecord(record: { recordType?: string; fields: Record<string, unknown>; unknown?: string[] }): ArrivedRecord {
  return {
    ...(record.recordType !== undefined ? { recordType: record.recordType } : {}),
    fields: record.fields,
    ...(record.unknown !== undefined && record.unknown.length > 0 ? { unknown: record.unknown } : {}),
  };
}

/** The listen's filter judged against `heard`, asking its host as often as the judge asks. */
async function explained(input: {
  listen: SavedListen;
  heard: ReturnType<typeof namedArrival>;
  nowMs: number;
}): Promise<{ verdict: Verdict; firstFailed?: string; asked: boolean }> {
  const { listen, heard, nowMs } = input;
  if ('gone' in heard) return { verdict: { undecided: 'the event is gone' }, asked: false };
  const planArrival: PlanArrival = {
    edge: heard.edge,
    ...(heard.key !== undefined ? { key: heard.key } : {}),
    landing: arrivedRecord(heard.landing),
    ...(heard.parents !== undefined ? { parents: heard.parents.map((parent) => (parent === null ? null : arrivedRecord(parent))) } : {}),
    ...(heard.takenApplied === true ? { takenApplied: true } : {}),
  };
  const answers: PluginAnswers = [];
  let asked = false;
  let first = explainArrival(listen.plan, planArrival, { nowMs });
  // One more judgement than the filter has host calls always reaches a verdict.
  for (let judgements = 0; 'asks' in first.verdict; judgements++) {
    if (judgements > 16) return { verdict: { undecided: 'its filter keeps asking its host' }, asked };
    asked = true;
    let answered: PluginAnswers;
    try {
      answered = await platformHostAnswers(listen.teamId, first.verdict.asks);
    } catch (error) {
      if (error instanceof HostFunctionRefused) return { verdict: { undecided: `${error.plugin}, which this listen's filter calls, answered an error (${error.message})` }, asked };
      answered = first.verdict.asks.map((question) => ({ ...question, unreachable: messageOf(error) }));
    }
    const empty = answered.find((answer) => !('unreachable' in answer) && answer.value === undefined);
    if (empty !== undefined) return { verdict: { undecided: `${empty.plugin}, which this listen's filter calls, answered no value` }, asked };
    answers.push(...answered);
    first = explainArrival(listen.plan, planArrival, { nowMs, answers });
  }
  const { verdict } = first;
  if ('asks' in verdict) return { verdict: { undecided: 'its filter keeps asking its host' }, asked };
  return { verdict, ...(first.firstFailed !== undefined ? { firstFailed: first.firstFailed } : {}), asked };
}

function verdictLine(verdict: Verdict): { verdict: ExplainedVerdict; reason?: string } {
  if ('fires' in verdict) return { verdict: 'fires' };
  if ('skips' in verdict) return { verdict: 'does_not_fire', ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) };
  return { verdict: 'cannot_tell', reason: verdict.undecided };
}

/**
 * Event `arrivalIndex` of the kept delivery `deliveryId` of `teamId`, judged
 * against each listen on its connection in an automation the asker may read. The
 * caller has decided the asker may see the delivery; this decides which
 * listens they may be told of.
 */
export async function explainDeliveryArrival(input: { teamId: string; deliveryId: string; arrivalIndex: number }): Promise<ExplainArrivalResult> {
  const teamId = input.teamId as TeamId;
  const row = await deliveryOf(teamId, input.deliveryId);
  if (row === null) return noSuchEvent(input.deliveryId);
  if (row.request === null) {
    return { ok: false, errors: [`delivery ${row.id} kept no request (it was kept before deliveries kept theirs): its events cannot be judged again`] };
  }
  const kept = readKeptRequest(row.request);
  if (kept === null) return { ok: false, errors: [`delivery ${row.id}'s kept request is not one the platform can read`] };
  const origin = await deliveryOriginOf({ teamId, deliveryId: row.id });
  if (origin === null || origin.adapterType === null) {
    return { ok: false, errors: [`delivery ${row.id} does not say which module delivered it: its events cannot be judged again`] };
  }
  const { adapterType } = origin;
  const credentialsId = origin.credentialsId ?? ('page' in kept ? kept.page.credential ?? null : null);

  const onConnection = (await savedListens({ teamId, adapterType })).filter(
    (listen) => credentialsId === null || listen.credentialsId === null || listen.credentialsId === credentialsId,
  );
  const automationOf = await automationsOf(onConnection.map((listen) => listen.triggerId));
  const readable: SavedListen[] = [];
  for (const listen of onConnection) {
    const automationId = automationOf.get(listen.triggerId);
    if (automationId !== undefined && !(await unseen(automationId))) readable.push(listen);
  }
  const [first] = readable;

  let arrivals: Arrival[];
  if (first === undefined) arrivals = 'page' in kept ? kept.page.arrivals : [];
  else {
    try {
      if ('page' in kept) arrivals = kept.page.arrivals;
      else {
        const read = await reread(first, adapterType, kept.request);
        if ('refused' in read) return { ok: false, errors: [read.refused] };
        arrivals = inBroughtOrder(read.arrivals, kept.request.arrivalIds);
      }
    } catch (error) {
      return { ok: false, errors: [messageOf(error)] };
    }
  }
  const arrival = arrivals[input.arrivalIndex];
  if (arrival === undefined || 'gone' in arrival) {
    return { ok: false, errors: [`delivery ${row.id} brought no event at ${input.arrivalIndex} that can be judged (it brought ${arrivals.length})`] };
  }

  const now = new Date();
  const listens: ExplainedListen[] = [];
  for (const listen of readable) {
    const automationId = automationOf.get(listen.triggerId);
    if (automationId === undefined) continue;
    const heard = namedArrival(arrival, listen.fieldIds as FieldIdsByType);
    const named = { automationId, automationName: listen.file, listen: listen.triggerId };
    const credential = listen.credentialName !== undefined ? { credentialName: listen.credentialName } : {};
    const hears = listenFires(
      { plan: listen.plan, pipeline: listen.pipeline, ...credential, ...(listen.constructionArgs !== undefined ? { constructionArgs: listen.constructionArgs } : {}) },
      heard,
      { adapterType, ...credential },
      now.getTime(),
    );
    if (hears === null) {
      listens.push({ ...named, verdict: 'not_heard', reason: `it listens for another kind of event than the one on ${arrival.edge}`, hostAnswers: { used: false } });
      continue;
    }
    const judged = await explained({ listen, heard, nowMs: now.getTime() });
    let { verdict, reason } = verdictLine(judged.verdict);
    if (verdict === 'fires' && listen.landing !== undefined) {
      if ('unread' in listen.landing) {
        verdict = 'does_not_fire';
        reason = `it cannot be checked against the node its listen states (${listen.landing.unread})`;
      } else {
        const fit = landingMisfits({ ...(listen.landing as DeclaredNode), landing: heard.landing.fields });
        if (fit.misfits.length > 0) {
          verdict = 'does_not_fire';
          reason = `it is not a ${fit.node} (${fit.misfits.join('; ')})`;
        }
      }
    }
    listens.push({
      ...named,
      verdict,
      ...(judged.firstFailed !== undefined ? { firstFailed: judged.firstFailed } : {}),
      ...(reason !== undefined ? { reason } : {}),
      hostAnswers: judged.asked ? { used: true, asOf: now.toISOString(), note: AS_OF_NOW } : { used: false },
    });
  }
  return { ok: true, deliveryId: row.id, arrivalIndex: input.arrivalIndex, edge: arrival.edge, listens };
}
