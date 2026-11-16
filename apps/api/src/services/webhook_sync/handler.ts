// The platform's store under the webhook door. The door itself — verify,
// preprocess, capture, queue, ack — is the shared inbound core
// (movement-engine/public/inbound, `receiveDelivery` / `answerDelivery`); this
// file is what it stands on here: subscription rows in Postgres, the built-in
// providers' frozen signature table, remote installs, the trigger table, the
// receipt store and the work table.
import { sql } from 'kysely';

import type { WebhookSubscriptionId } from '../../generated/kysely/automations/WebhookSubscription';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { Arrival } from 'engine-contracts';
import type { Adapter } from 'movement-engine/public/adapter';
import type { HarnessDelivery, SettleReport } from '../work/harness';
import type {
  EventError,
  InboundHeaders,
  InboundSource,
  InboundStore,
  InboundSubscription,
  OpenedSource,
  QueuedDelivery,
} from 'movement-engine/public/inbound';

import { getAutomationsQb } from '../../lib/kysely';
import { getWebhookProvider } from './providers';
import { logger } from 'movement-engine/public/log';
import { deliverArrivals } from '../inbound/listen_door';
import { listensOfSubscription } from '../translation_graph/movement/listen_subscriptions';
import { TELEGRAM_ADAPTER_TYPE, TelegramAdapter } from '../translation_graph/adapters/telegram';
import { handleTelegramCallbackQuery, ownsCallbackQuery } from './telegram_callback_door';
import {
  enqueueLinkedObjectRefresh,
  hasBridgedLinkedObjects,
  type LinkedObjectRefresh,
} from './linked_object_refresh';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { isTestHarnessTeam } from '../../lib/recording';
import { CHECKED_BY_MODULE, receiveDelivery } from 'movement-engine/public/inbound';
import { parseStoredManifest } from '../translation_graph/adapters/remote/store';
import { builtInAdapterOfProvider, remoteInstallOfProvider } from './provider_adapter';
import { LEGACY_INTERCEPTS, builtInVerifierFor } from '../inbound/legacy_signature_headers';
import { builtinModuleInboundVerifier, builtinModuleRequestKeeping } from '../translation_graph/adapters/builtin_modules';
import { capturedRequest, type RequestKeeping } from '../inbound/captured_request';
import { answerTappedCallbacks } from '../whatsapp/inbound_message';
import { judgedEmpty, keepForEveryVersion, waitingKeyOf } from '../inbound/carried_delivery';

const WHATSAPP_ADAPTER_TYPE = 'whatsapp';

/** What capture keeps of one event: nothing. Every listen is judged on the
 *  delivery's arrivals as it is kept (`keepDelivery`), so no event is matched
 *  to a listen on its own. */
export type CapturedReceipts = never[];

/**
 * Outcome of a delivery once its team's work rows have drained: the events it
 * carried, unless those rows did not settle in time. Only a test-harness
 * caller ever sees it (it drains before acking); a production sender is acked
 * before its rows run.
 */
export interface DeferredOutcome {
  eventsProcessed: number;
  /** Per-event errors the door continued past, for the dev loop to read. */
  perEventErrors: EventError[];
}

/** Queue a delivery's rows and say how to read them once drained — the shape
 *  the work harness (`runHarnessDelivery`) drains. */
export async function queueForHarness(
  queue: () => Promise<QueuedDelivery<CapturedReceipts>>,
): Promise<HarnessDelivery<DeferredOutcome>> {
  const queued = await queue();
  return { teamIds: [queued.teamId], readOutcome: (settle) => readDeliveryOutcome({ queued, settle }) };
}

async function readDeliveryOutcome(input: {
  queued: QueuedDelivery<CapturedReceipts>;
  settle: SettleReport;
}): Promise<DeferredOutcome> {
  const { queued, settle } = input;
  const unsettled = settle.unsettledTeamIds.has(queued.teamId);
  return {
    eventsProcessed: unsettled ? 0 : queued.enqueued.length,
    perEventErrors: [
      ...queued.captureErrors,
      ...(unsettled ? queued.enqueued.map((entry) => ({ event: entry.event, error: settle.unsettledError })) : []),
    ],
  };
}

/** Meta signs every WhatsApp delivery with the Meta app's secret, not with a
 *  secret minted per subscription — and the platform's one WhatsApp app is the
 *  only one there is (WhatsApp takes no credential). Empty means "no secret to
 *  verify against", which the `hmac_sha256_hex` scheme refuses: an HMAC keyed
 *  with '' is one anybody can compute. */
function signingSecretFor(subscription: InboundSubscription): string {
  return subscription.providerKey === 'INBOUND_WHATSAPP'
    ? (process.env.WHATSAPP_WEBHOOK_SECRET ?? '')
    : subscription.secret;
}

/** What a door does with a verified delivery before any version reads it. */
type KeepFirst = (source: { adapterType: string; credentialsId: string; keeping?: RequestKeeping }) => Promise<void>;

/** A module that checks its own inbound is the only thing that can verify a
 *  request, so the delivery is kept the moment it accepts, before anything of
 *  what it read is used: an unverified request is never kept. */
function keepingOnceAccepted(adapter: Adapter, keep: () => Promise<void>): Adapter {
  const check = adapter.checkInbound;
  if (check === undefined) return adapter;
  const keeping: Adapter = Object.create(adapter);
  keeping.checkInbound = async (input) => {
    const answer = await check.call(adapter, input);
    if (answer.outcome === 'accepted') await keep();
    return answer;
  };
  return keeping;
}

/** A built-in provider's subscription: verified by the frozen table, read by
 *  the adapter its provider key aliases. */
function builtInSource(subscription: InboundSubscription, keepFirst?: KeepFirst): InboundSource | null {
  // A built-in on a module line that declares its inbound is held to the
  // host's one rule for a declared signed inbound; the rest keep their door's.
  const verifier = builtInVerifierFor({
    providerKey: subscription.providerKey,
    secret: signingSecretFor(subscription),
    grandfatheredUnsigned: subscription.grandfatheredUnsigned,
    declared: builtinModuleInboundVerifier(subscription.providerKey),
  });
  if (!verifier) return null;
  return {
    verifier,
    secret: signingSecretFor(subscription),
    async open() {
      const credentialsId = requireSubscriptionCredentials(subscription);
      const adapterType = builtInAdapterOfProvider(subscription.providerKey);
      if (adapterType === null) return null;
      const checkedByModule = 'checkedBy' in verifier;
      const { intercept } = builtInIntercept({ adapterType, subscription, credentialsId });
      // A delivery the door's own handling ends is never kept: a button tap
      // carries an ask's answer token. What it passes on is kept before either
      // version reads it.
      if (!checkedByModule && intercept === undefined) await keepFirst?.({ adapterType, credentialsId });
      const adapter = await resolveAdapter({
        adapterType,
        teamId: subscription.teamId as TeamId,
        credentialsId,
      });
      return {
        adapterType,
        credentialsId,
        adapter: checkedByModule && keepFirst !== undefined ? keepingOnceAccepted(adapter, () => keepFirst({ adapterType, credentialsId })) : adapter,
        ...(intercept !== undefined
          ? {
              intercept: async (body: unknown) => {
                const answer = await intercept(body);
                if (answer === 'continue' && !checkedByModule) await keepFirst?.({ adapterType, credentialsId });
                return answer;
              },
            }
          : {}),
      };
    },
  };
}

/** The button taps a built-in channel answers before its events. */
function builtInIntercept(input: {
  adapterType: string;
  subscription: InboundSubscription;
  credentialsId: string;
}): Pick<OpenedSource, 'intercept'> {
  // A Telegram button tap arrives on the same webhook as every message, as a
  // `callback_query`. A tap on an ask's answer button answers the ask and acks
  // Telegram; there is no movement event in it, so the delivery ends there.
  if (input.adapterType === TELEGRAM_ADAPTER_TYPE) {
    return {
      async intercept(body) {
        if (!ownsCallbackQuery(body)) return 'continue';
        const { handled } = await handleTelegramCallbackQuery({
          raw: body,
          responder: new TelegramAdapter(input.subscription.teamId as TeamId, input.credentialsId),
        });
        return handled ? 'handled' : 'continue';
      },
    };
  }
  // A subscription an operator made for a WhatsApp number of their own posts here
  // (`webhookSubscriptions.create` takes any provider; the platform's own number
  // posts at its own door). A tap on a 0.12 button is an ordinary message, and a
  // delivery can batch several, so it is fired here and the delivery carries on:
  // a module drops an interactive message as unclassified, so it is not fired twice.
  if (input.adapterType === WHATSAPP_ADAPTER_TYPE) {
    return {
      async intercept(body) {
        await answerTappedCallbacks(body as Parameters<typeof answerTappedCallbacks>[0]);
        return 'continue';
      },
    };
  }
  return {};
}

/**
 * A subscription a team's remote install provisioned, recognised by its
 * provider key being the one that install mints (`remoteInstallOfProvider`). It
 * signs in the protocol's own header, and only that header. The row carries no
 * credential of its own; the install's credential is the channel's.
 */
async function remoteSource(subscription: InboundSubscription, keepFirst?: KeepFirst): Promise<InboundSource | null> {
  const install = await remoteInstallOfProvider({ teamId: subscription.teamId as TeamId, providerKey: subscription.providerKey });
  if (!install) return null;
  const credentialsId = install.credentials_id;
  if (credentialsId === null) {
    logger.error(`[webhook] remote adapter ${install.adapter_type} has no credential — delivery dropped`);
    return { verifier: REMOTE_VERIFIER, secret: subscription.secret, open: async () => null };
  }
  // Whether the server checks its own inbound is remembered with the install:
  // its stored manifest lists `checkInbound` exactly when it declares
  // `inbound.scheme: module` (what the resolved adapter exposes, too). So a
  // delivery the host verifies is turned away unsigned before the adapter is
  // resolved, and the adapter is resolved once, when the delivery is read.
  const stored = parseStoredManifest(install);
  const checksItsOwn = stored.ok && stored.manifest.methods.includes('checkInbound');
  // What the remote declares of its requests binds its kept ones as a built in's does.
  const declared = stored.ok ? stored.manifest.inbound : undefined;
  const keeping: RequestKeeping = {
    ...(declared?.captureHeaders !== undefined ? { captureHeaders: declared.captureHeaders } : {}),
    ...(declared?.redactFields !== undefined ? { redactFields: declared.redactFields } : {}),
  };
  let opened: Promise<OpenedSource> | undefined;
  return {
    verifier: checksItsOwn ? CHECKED_BY_MODULE : REMOTE_VERIFIER,
    secret: subscription.secret,
    open: () =>
      (opened ??= (async () => {
        const kept = { adapterType: install.adapter_type, credentialsId, keeping };
        if (!checksItsOwn) await keepFirst?.(kept);
        const adapter = await resolveAdapter({ adapterType: install.adapter_type, teamId: subscription.teamId as TeamId });
        return {
          adapterType: kept.adapterType,
          credentialsId,
          adapter: checksItsOwn && keepFirst !== undefined ? keepingOnceAccepted(adapter, () => keepFirst(kept)) : adapter,
        };
      })()),
  };
}

const REMOTE_VERIFIER = { scheme: 'remote', signatureHeaders: ['x-listen-fire-signature'] } as const;

/** Inbound deliveries only exist for credentialed channels — a
 *  credential-free subscription row (the cron adapter's platform-internal
 *  registration) has no inbound URL traffic; reject loudly if one shows up. */
function requireSubscriptionCredentials(subscription: InboundSubscription): string {
  if (subscription.credentialsId === null) {
    throw new Error(
      `webhook subscription for provider '${subscription.providerKey}' carries no credential — inbound deliveries are not expected on credential-free channels`,
    );
  }
  return subscription.credentialsId;
}

/** A current version's reading that found nothing is told, once it has. */
function judgingEmpty<T extends Pick<Adapter, 'preprocessInbound' | 'checkInbound'>>(adapter: T, judged: () => Promise<void>): T {
  const { preprocessInbound: read, checkInbound: check } = adapter;
  const wrapped: T = Object.create(adapter);
  if (read !== undefined) {
    wrapped.preprocessInbound = async (input) => {
      const answer = await read.call(adapter, input);
      if (answer.events.length === 0 && (answer.arrivals ?? []).length === 0) await judged();
      return answer;
    };
  }
  if (check !== undefined) {
    wrapped.checkInbound = async (input) => {
      const answer = await check.call(adapter, input);
      if (answer.outcome === 'accepted' && (answer.events ?? []).length === 0 && (answer.arrivals ?? []).length === 0) await judged();
      return answer;
    };
  }
  return wrapped;
}

/** The trigger matcher's view of a subscription, with the channel's credential. */
function subscriptionRow(subscription: InboundSubscription, source: OpenedSource) {
  return { team_id: subscription.teamId, credentials_id: source.credentialsId, provider: subscription.providerKey };
}

/** What a subscription row holds subscribed (an edge's subscription since
 *  0.13; see listen_subscriptions.ts). */
async function subscriptionsCellOf(id: string): Promise<unknown> {
  const row = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('id', '=', id as WebhookSubscriptionId)
    .select('subscriptions')
    .executeTakeFirst();
  return row?.subscriptions ?? null;
}

export const platformInboundStore: InboundStore<CapturedReceipts> = {
  async findSubscription(id) {
    const row = await getAutomationsQb(['webhook_subscription'])
      .selectFrom('webhook_subscription')
      .where('webhook_subscription.id', '=', id as WebhookSubscriptionId)
      .where('webhook_subscription.deleted_at', 'is', null)
      .where('webhook_subscription.status', '!=', 'disabled')
      .select([
        'webhook_subscription.id',
        'webhook_subscription.team_id',
        'webhook_subscription.provider',
        'webhook_subscription.credentials_id',
        'webhook_subscription.webhook_secret',
        'webhook_subscription.grandfathered_unsigned',
        'webhook_subscription.external_webhook_id',
        'webhook_subscription.inbound_checkpoint',
      ])
      .executeTakeFirst();
    if (!row) return null;
    // The cursor a delivery's write keeps (keepDelivery), else one a door kept
    // on the subscription before this release.
    const { rows: cursors } = await sql<{ checkpoint: unknown }>`
      select checkpoint from automations.inbound_checkpoint
      where team_id = ${row.team_id}::uuid and subscription_id = ${row.id}::text`.execute(getAutomationsQb(['inbound_checkpoint']));
    const kept = cursors[0];
    return {
      id: row.id,
      teamId: row.team_id,
      providerKey: row.provider,
      credentialsId: row.credentials_id,
      secret: row.webhook_secret,
      grandfatheredUnsigned: row.grandfathered_unsigned,
      checkpoint: kept !== undefined ? kept.checkpoint : row.inbound_checkpoint,
    };
  },

  knowsProvider: (providerKey) => getWebhookProvider(providerKey) !== null,

  intercepts: (providerKey) => LEGACY_INTERCEPTS[providerKey] ?? [],

  sourceFor: async (subscription) =>
    getWebhookProvider(subscription.providerKey) ? builtInSource(subscription) : remoteSource(subscription),

  // The dev-loop CLI fires synthetic webhooks at the pinned test team without a
  // real source signing them.
  verifiesSignature: (subscription) => !isTestHarnessTeam(subscription.teamId),

  // A module's events are no listen's: every listen is judged on the
  // delivery's arrivals, as it is kept (listen_door.ts), and a bridged
  // knowledge graph node is refreshed from them too.
  capture: async () => [],

  keepDelivery: (input) => keepWebhookDelivery(input, null),
};

/** A request as the door received it, before anything read it. */
export interface ReceivedRequest {
  rawBody: Buffer;
  headers: InboundHeaders;
  method?: string;
  path?: string;
  query?: string;
}

/** The platform's store for one received request. The verified request is kept
 *  (redacted) before any version reads it: each version reads that, and a listen
 *  can be put through it again. */
export function platformInboundStoreFor(received: ReceivedRequest): InboundStore<CapturedReceipts> {
  let rawKept: { id: string; keptAt: Date; keeping: RequestKeeping | undefined } | undefined;
  const keepFirstFor =
    (subscription: InboundSubscription): KeepFirst =>
    async ({ adapterType, credentialsId, keeping: declared }) => {
      if (rawKept !== undefined) return;
      const keeping = declared ?? builtinModuleRequestKeeping(adapterType);
      const kept = await keepForEveryVersion({
        origin: { teamId: subscription.teamId as TeamId, adapterType, providerKey: subscription.providerKey, credentialsId },
        subscriptionId: subscription.id,
        externalId: waitingKeyOf({ rawBody: received.rawBody, ...(received.query !== undefined ? { query: received.query } : {}) }),
        source: 'webhook',
        request: requestAsKept({ received, keeping, subscription, arrivals: [] }),
      });
      if (kept.kind === 'read') rawKept = { id: kept.deliveryId, keptAt: kept.keptAt, keeping };
    };
  // The current version read it and found nothing: it is judged, and an identical
  // delivery after this is a new one.
  const openedJudged = (subscription: InboundSubscription, source: InboundSource | null): InboundSource | null =>
    source === null
      ? null
      : {
          ...source,
          open: async (...args) => {
            const opened = await source.open(...args);
            return opened === null ? null : { ...opened, adapter: judgingEmpty(opened.adapter, async () => {
              if (rawKept !== undefined) await judgedEmpty({ teamId: subscription.teamId, id: rawKept.id });
            }) };
          },
        };
  return {
    ...platformInboundStore,
    sourceFor: async (subscription) =>
      openedJudged(subscription, getWebhookProvider(subscription.providerKey) ? builtInSource(subscription, keepFirstFor(subscription)) : await remoteSource(subscription, keepFirstFor(subscription))),
    keepDelivery: (input) => keepWebhookDelivery(input, received, rawKept),
  };
}

function requestAsKept(input: { received: ReceivedRequest; keeping: RequestKeeping | undefined; subscription: InboundSubscription; arrivals: readonly Arrival[] }) {
  const { received, subscription } = input;
  return capturedRequest({
    keeping: input.keeping,
    headers: received.headers,
    rawBody: received.rawBody,
    ...(received.method !== undefined ? { method: received.method } : {}),
    ...(received.path !== undefined ? { path: received.path } : {}),
    ...(received.query !== undefined ? { query: received.query } : {}),
    // The cursor it was read against, so another reading reads it the same way.
    ...(subscription.checkpoint !== undefined && subscription.checkpoint !== null ? { checkpoint: subscription.checkpoint } : {}),
    arrivals: input.arrivals,
  });
}

/** A webhook delivery's one write, with the request it came as when the door
 *  has it. */
async function keepWebhookDelivery(
  { subscription, source, arrivals, checkpoint }: Parameters<InboundStore<CapturedReceipts>['keepDelivery']>[0],
  received: ReceivedRequest | null,
  rawKept?: { id: string; keptAt: Date; keeping: RequestKeeping | undefined },
): Promise<{ kept: boolean; arrivalMark?: number }> {
  const listens = await listensOfSubscription({
    teamId: subscription.teamId as TeamId,
    adapterType: source.adapterType,
    subscriptions: await subscriptionsCellOf(subscription.id),
  });
  const { kept } = await deliverArrivals({
    teamId: subscription.teamId as TeamId,
    delivered: { adapterType: source.adapterType, credentialsId: source.credentialsId },
    subscriptionId: subscription.id,
    externalId: null,
    source: 'webhook',
    arrivals,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(listens !== undefined ? { listens } : {}),
    ...(received !== null
      ? { request: requestAsKept({ received, keeping: rawKept !== undefined ? rawKept.keeping : builtinModuleRequestKeeping(source.adapterType), subscription, arrivals }) }
      : {}),
    ...(rawKept !== undefined ? { rawKeptId: rawKept.id, keptAt: rawKept.keptAt } : {}),
  });
  if (!kept.kept) return { kept: false };
  await refreshBridgedLinkedObjects({ arrivals, subscription: subscriptionRow(subscription, source) });
  return { kept: true, arrivalMark: kept.arrivalMark };
}

interface HandleResult {
  ok: boolean;
  /** Events CAPTURED — durably receipted and ready to dispatch. */
  eventsProcessed: number;
  error?: string;
  /** Queue the delivery's work rows; awaited BEFORE the ack. Rejects when any
   *  receipt or wake could not be queued, so the door answers 500. */
  enqueueDeferred?: () => Promise<HarnessDelivery<DeferredOutcome>>;
  /** Test-harness subscriptions drain the rows before acking. */
  awaitDeferred?: boolean;
}

/** One delivery through the core over the platform store, without the HTTP
 *  answer (the door's route sends that; tests and scripts read this). */
async function handleInboundWebhook(options: {
  provider: string;
  subscriptionId: string;
  rawBody: Buffer;
  headers: InboundHeaders;
}): Promise<HandleResult> {
  const result = await receiveDelivery(platformInboundStoreFor({ rawBody: options.rawBody, headers: options.headers }), {
    providerKey: options.provider,
    subscriptionId: options.subscriptionId,
    rawBody: options.rawBody,
    headers: options.headers,
  });
  if (!result.ok) return { ok: false, eventsProcessed: 0, error: result.error };
  // A module's reply (a handshake) ran nothing.
  if ('reply' in result) return { ok: true, eventsProcessed: 0 };
  const { queue } = result;
  return {
    ok: true,
    eventsProcessed: result.eventsProcessed,
    ...(queue ? { enqueueDeferred: () => queueForHarness(queue) } : {}),
    ...(result.drainFirst ? { awaitDeferred: true } : {}),
  };
}

/** Queue a linked_object refresh for each record a delivery's arrivals are
 *  about (`about`) that a knowledge graph node is bridged to, once per record.
 *  Its own row; no provider read in the request. */
async function refreshBridgedLinkedObjects(input: {
  arrivals: readonly Arrival[];
  subscription: { team_id: string; credentials_id: string; provider: string };
}): Promise<void> {
  const { subscription } = input;
  const owed = new Map<string, { refresh: LinkedObjectRefresh; eventKey: string }>();
  for (const arrival of input.arrivals) {
    if ('gone' in arrival || arrival.about === undefined) continue;
    const { recordType, externalId } = arrival.about;
    const refresh: LinkedObjectRefresh = {
      teamId: subscription.team_id as TeamId,
      provider: subscription.provider,
      credentialsId: subscription.credentials_id,
      externalId,
      recordType,
    };
    owed.set(JSON.stringify([recordType, externalId]), { refresh, eventKey: arrival.identity });
  }
  for (const { refresh, eventKey } of owed.values()) {
    if (await hasBridgedLinkedObjects(refresh)) await enqueueLinkedObjectRefresh({ refresh, eventKey });
  }
}

export { handleInboundWebhook };
