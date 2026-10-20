// The webhook door: one pipeline for every provider's deliveries to
// `/api/public/webhook-sync/<provider>/<subscription>`, over whatever store the
// host keeps its subscriptions, receipts and work rows in (InboundStore).
//
//   intercepts → subscription → provider check → signature → preprocessInbound
//   → capture a receipt per matching trigger → advance the pull cursor
//   → queue a work row per receipt and per await wake → ack
//
// A module that checks its own inbound (`inbound.scheme: module`) replaces
// the signature, `preprocessInbound` and `wakeKeys` with one `checkInbound`
// of the raw request; its answer may also be a reply to send as it is (a
// provider's handshake), and only such a module's door takes a GET.
//
// Capture, queue, then ack: the sender's 200 means every receipt and every wake
// has its work row, so nothing it delivered can be lost after the ack, and the
// movements run off the request so a slow run never reads as a failed
// delivery. Anything that cannot be queued answers 500, so the sender's retry
// replays the stored receipts idempotently.

import type { WireInboundIntercept } from 'engine-contracts';
import type { z } from 'zod';
import type { Adapter, DiscriminableEvent, EventType, InboundCheck } from '../translation_graph/adapter';

import { logger } from '../logger';
import { CHECKED_BY_MODULE, isUsableInboundSecret, verifyInbound, type InboundHeaders, type InboundVerifier } from './verify';

export type InboundIntercept = z.infer<typeof WireInboundIntercept>;

/** The adapter surface a delivery is read through. */
export type InboundAdapter = Pick<Adapter, 'adapterType' | 'preprocessInbound' | 'wakeKeys' | 'listEventTypes' | 'checkInbound'>;


/** The row a door URL names. */
export interface InboundSubscription {
  id: string;
  teamId: string;
  /** The key the subscription was minted for; the URL's provider segment, upper-cased, must equal it. */
  providerKey: string;
  credentialsId: string | null;
  secret: string;
  /** Existed before signed inbound became the rule for its provider: while it
   *  holds no usable secret it is verified as its provider's door always did. */
  grandfatheredUnsigned: boolean;
  checkpoint: unknown;
}

/** How a subscription's deliveries are checked and read. */
export interface InboundSource {
  verifier: InboundVerifier | typeof CHECKED_BY_MODULE;
  /** The key its deliveries are signed with: usually the subscription's own,
   *  a host-wide one for a provider with one app (WhatsApp). */
  secret: string;
  /** The adapter that reads the delivery, or null when none can. */
  open(): Promise<OpenedSource | null>;
}

export interface OpenedSource {
  adapterType: string;
  credentialsId: string;
  adapter: InboundAdapter;
  /** Reads a verified delivery before its events. 'handled' ends the delivery
   *  with nothing to run (a Telegram button tap); 'continue' carries on. */
  intercept?(body: unknown): Promise<'handled' | 'continue'>;
}

/** What a door needs from its host. `Captured` is the host's own receipt
 *  handle: the core only carries it from capture to queue. */
export interface InboundStore<Captured> {
  findSubscription(id: string): Promise<InboundSubscription | null>;
  /** Whether a provider key is one this host serves itself (so a missing row
   *  is `subscription_not_found` rather than `unknown_provider`). */
  knowsProvider(providerKey: string): boolean;
  /** The requests a provider's door answers before anything is looked up. */
  intercepts(providerKey: string): readonly InboundIntercept[];
  sourceFor(subscription: InboundSubscription): Promise<InboundSource | null>;
  /** False only for deliveries the host fabricates itself (the dev loop's test team). */
  verifiesSignature(subscription: InboundSubscription): boolean;
  capture(input: {
    event: DiscriminableEvent;
    subscription: InboundSubscription;
    source: OpenedSource;
    eventTypes: readonly EventType[];
  }): Promise<Captured>;
  saveCheckpoint(input: { subscriptionId: string; checkpoint: unknown }): Promise<void>;
  enqueue(input: {
    captured: Captured;
    event: DiscriminableEvent;
    subscription: InboundSubscription;
    source: OpenedSource;
  }): Promise<void>;
  enqueueWakes(input: { adapterType: string; teamId: string; keys: readonly string[] }): Promise<void>;
}

export interface InboundDelivery {
  /** The URL's provider segment, as sent. */
  provider: string;
  subscriptionId: string;
  rawBody: Buffer;
  headers: InboundHeaders;
  /** POST when absent; any other is answered only by a module that checks
   *  its own inbound. */
  method?: string;
  /** The path as it arrived (percent-encoded, no query), for a module's check. */
  path?: string;
  /** What followed the `?`, or empty. */
  query?: string;
}

export type DeliveryRefusal =
  | 'unknown_provider'
  | 'subscription_not_found'
  | 'provider_mismatch'
  | 'signature_invalid'
  | 'method_not_allowed'
  | 'adapter cannot preprocess inbound';

export interface EventError {
  event: DiscriminableEvent;
  error: string;
}

/** What `queue` put in the work table. */
export interface QueuedDelivery<Captured> {
  teamId: string;
  enqueued: { event: DiscriminableEvent; captured: Captured }[];
  /** Events whose receipt could not be stored: dropped from the count, logged. */
  captureErrors: EventError[];
}

export type ReceivedDelivery<Captured> =
  | {
      ok: false;
      error: DeliveryRefusal;
      eventsProcessed: 0;
      /** The status a module asked its refusal be answered with. */
      status?: number;
    }
  /** The module's reply (a handshake), to send as it is; nothing ran. */
  | { ok: true; eventsProcessed: 0; reply: InboundAnswer }
  | {
      ok: true;
      /** Events CAPTURED — receipted and ready to run. */
      eventsProcessed: number;
      /** The work rows, to queue before the ack. Absent when the delivery
       *  carried nothing to run. Rejects when anything could not be queued. */
      queue?: () => Promise<QueuedDelivery<Captured>>;
      /** The host drains the rows before acking (the dev loop's test team). */
      drainFirst?: boolean;
    };

/** One or more receipts or wakes have no work row; the sender must retry. */
export class InboundQueueFailed extends Error {
  constructor(readonly failures: readonly EventError[]) {
    super(`${failures.length} receipt(s) of the delivery could not be queued: ${failures.map((f) => f.error).join('; ')}`);
    this.name = 'InboundQueueFailed';
  }
}

const refused = (error: DeliveryRefusal, status?: number) => ({
  ok: false as const,
  error,
  eventsProcessed: 0 as const,
  ...(status !== undefined ? { status } : {}),
});

/** What a door hands a module's `checkInbound`: the request as it arrived. */
function wireRequest(delivery: Omit<InboundDelivery, 'provider'>): {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
} {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(delivery.headers)) {
    const first = typeof value === 'string' ? value : value?.[0];
    if (first !== undefined) headers[name.toLowerCase()] = first;
  }
  return {
    method: delivery.method ?? 'POST',
    path: delivery.path ?? '',
    query: delivery.query ?? '',
    headers,
    body: delivery.rawBody.toString('base64'),
  };
}

/** A module's reply as the door sends it. */
function replyAnswer(reply: Extract<InboundCheck, { outcome: 'reply' }>): InboundAnswer {
  if (reply.text !== undefined) return { status: reply.status, body: reply.text, contentType: 'text/plain' };
  if (reply.json !== undefined) return { status: reply.status, body: reply.json };
  return { status: reply.status, body: '', contentType: 'text/plain' };
}

/** Verify and capture one delivery; the work rows wait in `queue`. */
export async function receiveDelivery<Captured>(
  store: InboundStore<Captured>,
  delivery: Omit<InboundDelivery, 'provider'> & { providerKey: string },
): Promise<ReceivedDelivery<Captured>> {
  const { providerKey, subscriptionId } = delivery;

  const subscription = await store.findSubscription(subscriptionId);
  if (!subscription) {
    return refused(store.knowsProvider(providerKey) ? 'subscription_not_found' : 'unknown_provider');
  }
  if (subscription.providerKey !== providerKey) return refused('provider_mismatch');

  const source = await store.sourceFor(subscription);
  if (!source) return refused('unknown_provider');

  const read =
    'checkedBy' in source.verifier
      ? await readCheckedByModule<Captured>(source, subscription, delivery)
      : await readSigned(store, source, subscription, delivery);
  if ('result' in read) return read.result;
  const { opened, extraction } = read;
  const { adapter } = opened;
  const events = extraction.events;

  // Capture: the durable receipts, one per matching trigger. Nothing here runs
  // a movement; the receipt is what makes the queued half safe to replay.
  const eventTypes = events.length > 0 && adapter.listEventTypes ? await adapter.listEventTypes() : [];
  const captured: { event: DiscriminableEvent; captured: Captured }[] = [];
  const captureErrors: EventError[] = [];
  for (const event of events) {
    try {
      captured.push({ event, captured: await store.capture({ event, subscription, source: opened, eventTypes }) });
    } catch (err) {
      logger.error(`Webhook event capture failed:`, { event, err });
      captureErrors.push({ event, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // The wake door is independent of the events — a delivery may resolve a
  // parked await whether or not a trigger listens for it — and read after the
  // capture, so a failing wake door never costs the delivery its receipts.
  const wakes = await read.wakes();
  if (!events.length && wakes.ok && !wakes.keys.length) return { ok: true, eventsProcessed: 0 };

  // The pull cursor rides on "receipted", not "run": a crash before the queue
  // replays receipts rather than re-pulling.
  if (extraction.checkpoint !== undefined) {
    await store.saveCheckpoint({ subscriptionId, checkpoint: extraction.checkpoint });
  }

  const queue = async (): Promise<QueuedDelivery<Captured>> => {
    const enqueued: { event: DiscriminableEvent; captured: Captured }[] = [];
    const failures: EventError[] = [];
    // One event's failure never stops the next; the wakes still go in.
    for (const entry of captured) {
      try {
        await store.enqueue({ captured: entry.captured, event: entry.event, subscription, source: opened });
        enqueued.push(entry);
      } catch (err) {
        logger.error(`Webhook event processing failed:`, { event: entry.event, err });
        failures.push({ event: entry.event, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!wakes.ok) throw wakes.error;
    await store.enqueueWakes({ adapterType: adapter.adapterType, teamId: subscription.teamId, keys: wakes.keys });
    if (failures.length > 0) throw new InboundQueueFailed(failures);
    return { teamId: subscription.teamId, enqueued, captureErrors };
  };

  return {
    ok: true,
    eventsProcessed: captured.length,
    queue,
    ...(store.verifiesSignature(subscription) ? {} : { drainFirst: true }),
  };
}

type WakeRead = { ok: true; keys: string[] } | { ok: false; error: unknown };

/** A delivery read: its adapter, its events and cursor, and its wakes (read
 *  after the capture); or the answer that ends it first. */
type DeliveryRead<Captured> =
  | { result: ReceivedDelivery<Captured> }
  | {
      opened: OpenedSource;
      extraction: { events: DiscriminableEvent[]; checkpoint?: unknown };
      wakes(): Promise<WakeRead>;
    };

/** A provider the host verifies: the scheme, then `preprocessInbound`. */
async function readSigned<Captured>(
  store: InboundStore<Captured>,
  source: InboundSource,
  subscription: InboundSubscription,
  delivery: Omit<InboundDelivery, 'provider'>,
): Promise<DeliveryRead<Captured>> {
  const { rawBody, headers } = delivery;
  if ((delivery.method ?? 'POST') !== 'POST') return { result: refused('method_not_allowed') };
  if (!store.verifiesSignature(subscription)) {
    logger.info(`[webhook] test-harness team — skipping signature verification`);
  } else if ('checkedBy' in source.verifier || !verifyInbound(source.verifier, { rawBody, headers, secret: source.secret })) {
    logger.warn(`Webhook signature verification failed for subscription ${subscription.id}`);
    return { result: refused('signature_invalid') };
  }

  const body: unknown = JSON.parse(rawBody.toString('utf-8'));
  const opened = await source.open();
  // `preprocessInbound` is THE raw→events seam every inbound adapter
  // implements; a delivery whose adapter lacks it is a wiring bug, refused
  // loudly rather than dropped.
  const preprocess = opened?.adapter.preprocessInbound;
  if (!opened || !preprocess) {
    logger.error(
      `[webhook] adapter for provider ${subscription.providerKey} has no preprocessInbound — delivery dropped`,
    );
    return { result: refused('adapter cannot preprocess inbound') };
  }
  if (opened.intercept && (await opened.intercept(body)) === 'handled') return { result: { ok: true, eventsProcessed: 0 } };

  const extraction = await preprocess.call(opened.adapter, {
    raw: body,
    checkpoint: subscription.checkpoint ?? undefined,
  });
  return { opened, extraction, wakes: () => readWakeKeys(opened.adapter, body) };
}

/** A module that checks its own inbound: the raw request to `checkInbound`. */
async function readCheckedByModule<Captured>(
  source: InboundSource,
  subscription: InboundSubscription,
  delivery: Omit<InboundDelivery, 'provider'>,
): Promise<DeliveryRead<Captured>> {
  const opened = await source.open();
  const checkInbound = opened?.adapter.checkInbound;
  if (!opened || !checkInbound) {
    logger.error(
      `[webhook] adapter for provider ${subscription.providerKey} declares that it checks its inbound but has no checkInbound — delivery dropped`,
    );
    return { result: refused('adapter cannot preprocess inbound') };
  }
  const answer = await checkInbound.call(opened.adapter, {
    request: wireRequest(delivery),
    ...(isUsableInboundSecret(source.secret) ? { secret: source.secret } : {}),
    ...(subscription.checkpoint !== null && subscription.checkpoint !== undefined ? { checkpoint: subscription.checkpoint } : {}),
  });
  switch (answer.outcome) {
    case 'reply':
      return { result: { ok: true, eventsProcessed: 0, reply: replyAnswer(answer) } };
    case 'refused':
      logger.warn(`Webhook refused by its module for subscription ${subscription.id}`);
      return { result: refused('signature_invalid', answer.status) };
    case 'accepted':
      return {
        opened,
        extraction: { events: answer.events, ...(answer.checkpoint !== undefined ? { checkpoint: answer.checkpoint } : {}) },
        wakes: async () => ({ ok: true, keys: answer.wakeKeys ?? [] }),
      };
    default: {
      const unknown: never = answer;
      throw new Error(`unknown inbound check outcome ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * The correlation keys an adapter's `wakeKeys` names for one delivery. A throw
 * comes back as the error, for `queue` to refuse the delivery with once its
 * events are queued.
 */
async function readWakeKeys(
  adapter: InboundAdapter,
  raw: unknown,
): Promise<WakeRead> {
  if (!adapter.wakeKeys) return { ok: true, keys: [] };
  try {
    return { ok: true, keys: await adapter.wakeKeys({ raw }) };
  } catch (error) {
    logger.error(`[webhook] wakeKeys failed for adapter ${adapter.adapterType}; the delivery will be refused for a retry`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error };
  }
}

/** An HTTP answer, framework-free: every host's door sends exactly this. */
export interface InboundAnswer {
  status: number;
  /** JSON, unless `contentType` says text (then a string, sent as it is). */
  body: unknown;
  contentType?: 'text/plain';
  /** Run once the answer is sent (poke the work drain). */
  afterAnswer?: () => void;
}

/** A body over the door's limit, answered in the doors' own error shape. */
export const PAYLOAD_TOO_LARGE: InboundAnswer = { status: 413, body: { error: 'payload_too_large' } };

const REFUSAL_STATUS: Record<DeliveryRefusal, number> = {
  unknown_provider: 404,
  subscription_not_found: 404,
  provider_mismatch: 400,
  signature_invalid: 401,
  // A GET to a door that takes only POST answers as it did before the handshake
  // existed, when the route was not there at all.
  method_not_allowed: 404,
  'adapter cannot preprocess inbound': 500,
};

/** The requests a door answers before it looks anything up (null: none of them). */
export function answerIntercepts(intercepts: readonly InboundIntercept[], rawBody: Buffer): InboundAnswer | null {
  for (const intercept of intercepts) {
    switch (intercept) {
      case 'slack_url_verification': {
        // Slack's one-shot setup check: echo the challenge, unsigned, within 3s.
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawBody.toString('utf-8'));
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'url_verification') continue;
        const challenge = (parsed as { challenge?: unknown }).challenge;
        return typeof challenge === 'string'
          ? { status: 200, body: { challenge } }
          : { status: 400, body: { error: 'missing_challenge' } };
      }
      default: {
        const unknown: never = intercept;
        throw new Error(`unknown inbound intercept ${String(unknown)}`);
      }
    }
  }
  return null;
}

export interface DeliveryHost<Captured> {
  /** Poke whatever drains the work rows. */
  notify(): void;
  /** Queue and drain the rows before acking (a delivery with `drainFirst`),
   *  reporting what ran. */
  drainBeforeAck?(queue: () => Promise<QueuedDelivery<Captured>>): Promise<{
    eventsProcessed: number;
    perEventErrors: EventError[];
  }>;
}

/** The whole webhook door: one delivery in, the HTTP answer out. */
export async function answerDelivery<Captured>(
  store: InboundStore<Captured>,
  host: DeliveryHost<Captured>,
  delivery: InboundDelivery,
): Promise<InboundAnswer> {
  const providerKey = delivery.provider.toUpperCase();
  const intercepted =
    (delivery.method ?? 'POST') === 'POST' ? answerIntercepts(store.intercepts(providerKey), delivery.rawBody) : null;
  if (intercepted) return intercepted;
  try {
    const result = await receiveDelivery(store, { ...delivery, providerKey });
    if (!result.ok) return { status: result.status ?? REFUSAL_STATUS[result.error], body: { error: result.error } };
    if ('reply' in result) return result.reply;

    if (result.queue && result.drainFirst && host.drainBeforeAck) {
      const drained = await host.drainBeforeAck(result.queue);
      return {
        status: 200,
        body: {
          ok: true,
          eventsProcessed: drained.eventsProcessed,
          ...(drained.perEventErrors.length > 0 ? { perEventErrors: drained.perEventErrors } : {}),
        },
      };
    }
    if (result.queue) await result.queue();
    return { status: 200, body: { ok: true, eventsProcessed: result.eventsProcessed }, afterAnswer: () => host.notify() };
  } catch (err) {
    logger.error('Webhook sync endpoint error:', err);
    return { status: 500, body: { error: 'internal' } };
  }
}
