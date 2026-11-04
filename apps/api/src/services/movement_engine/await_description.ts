// P22 — "the awaited edge is the park's public identity". Every run surface that
// shows a parked run answers "what is this waiting on?" the SAME way: in plain
// language, derived from the park + the awaitable adapter's correlation, never
// from engine internals. No jargon reaches a person here — no "adapter",
// "correlation", "park", "address", "edge id".
//
// Two park shapes carry an author-chosen wait:
//   • an AWAIT park (`await x-[:E]->`) — described from its wait (the record
//       and edge it waits on):
//       an ask → the question it is waiting to be answered
//       slack → a reply it is waiting for in a thread
//   • a TIMER park — a recurring `until` condition ("checking on a schedule")
//       or a one-shot `sleep` ("waiting for a scheduled time").

import { ASK_ADAPTER_TYPE } from '@listen-fire/ask';

import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';

import { getAsksQb, getAutomationsQb } from '../../lib/kysely';
import { askIdSchema } from '../asks/store';

/** One plain-language line describing something a run is waiting on. */
export type AwaitDescription = string;

/**
 * Everything a run is currently waiting on, in plain language — one line per
 * live parked leaf. Empty when the run has no author-chosen waits (running, or
 * parked only on an engine hold like a spending limit, which these surfaces
 * describe elsewhere).
 */
export async function describeRunAwaits(runId: TriggerRunId): Promise<AwaitDescription[]> {
  const parked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('status', '=', 'parked')
    .where('park_reason', 'in', ['await', 'timer'])
    .select(['address', 'park_reason', 'state'])
    .execute();
  if (parked.length === 0) return [];

  const awaitAddresses = parked.filter((p) => p.park_reason === 'await').map((p) => p.address);
  const correlations = awaitAddresses.length > 0 ? await loadCorrelations(runId, awaitAddresses) : new Map();

  // What each record-backed await is waiting on, from the adapter that keeps
  // it, one read per adapter.
  const described = await describeKept([...correlations.values()]);

  const out: AwaitDescription[] = [];
  for (const park of parked) {
    if (park.park_reason === 'timer') {
      out.push(describeTimer(park.state));
      continue;
    }
    const corr = correlations.get(park.address);
    if (!corr) {
      // A parked await with no correlation row is a transient inconsistency
      // (mid-drain); describe it honestly rather than inventing an edge.
      out.push('waiting on a response');
      continue;
    }
    out.push(described.get(keyOf(corr)) ?? describeAwait(corr));
  }
  return out;
}

interface Correlation {
  adapterType: string;
  correlationKey: string;
}

/** The wait each parked await address holds: the record it waits on, by
 *  its module's key. A run a carried version parked holds its key on the
 *  correlation map, not on a wait. */
async function loadCorrelations(
  runId: TriggerRunId,
  addresses: string[],
): Promise<Map<string, Correlation>> {
  const rows = await getAutomationsQb(['wait_row'])
    .selectFrom('wait_row')
    .where('run_id', '=', runId)
    .where('address', 'in', addresses)
    .select(['address', 'adapter_type', 'key'])
    .execute();
  const map = new Map<string, Correlation>();
  for (const r of rows) {
    if (r.address === null || r.key === null) continue;
    map.set(r.address, { adapterType: r.adapter_type, correlationKey: r.key });
  }
  const carried = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('run_id', '=', runId)
    .where('address', 'in', addresses)
    .select(['address', 'adapter_type', 'correlation_key'])
    .execute();
  for (const r of carried) map.set(r.address, { adapterType: r.adapter_type, correlationKey: r.correlation_key });
  return map;
}

function keyOf(corr: Correlation): string {
  return `${corr.adapterType}\u0000${corr.correlationKey}`;
}

/** An ask await is described by the question it asked, read once for all. */
async function describeKept(correlations: Correlation[]): Promise<Map<string, string>> {
  const askIds = correlations.flatMap(({ adapterType, correlationKey }) => {
    if (adapterType !== ASK_ADAPTER_TYPE) return [];
    const parsed = askIdSchema.safeParse(correlationKey);
    return parsed.success ? [parsed.data] : [];
  });
  if (askIds.length === 0) return new Map();
  const rows = await getAsksQb(['ask']).selectFrom('ask').where('id', 'in', askIds).select(['id', 'prompt']).execute();
  return new Map(
    rows.map((row) => [
      keyOf({ adapterType: ASK_ADAPTER_TYPE, correlationKey: row.id }),
      row.prompt.trim() !== '' ? `waiting for an answer to: ${row.prompt}` : 'waiting for an answer to a question',
    ]),
  );
}

function describeAwait(corr: Correlation): AwaitDescription {
  if (corr.adapterType === 'slack') {
    // The correlation key is "<channelId>:<threadTs>" — the channel id is not a
    // name a person recognises, so keep it plain.
    return 'waiting for a reply in a Slack thread';
  }
  if (corr.adapterType === 'callback') return 'waiting for someone to use the link or button it sent';
  return 'waiting for a response';
}

function describeTimer(state: unknown): AwaitDescription {
  const isUntil =
    state !== null &&
    typeof state === 'object' &&
    (state as Record<string, unknown>).until === true;
  return isUntil
    ? 'checking on a schedule for a condition to become true'
    : 'waiting until a scheduled time';
}
