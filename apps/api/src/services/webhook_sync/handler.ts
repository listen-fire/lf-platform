// The platform's store under the webhook door. The door itself — verify,
// preprocess, capture, queue, ack — is the shared inbound core
// (movement-engine/public/inbound, `receiveDelivery` / `answerDelivery`); this
// file is what it stands on here: subscription rows in Postgres, the built-in
// providers' frozen signature table, remote installs, the trigger table, the
// receipt store and the work table.
import { sql } from 'kysely';

import type { WebhookSubscriptionId } from '../../generated/kysely/automations/WebhookSubscription';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { DiscriminableEvent } from 'movement-engine/public/adapter';
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
import { hasAdapter, resolveAdapterSlug } from '../translation_graph/adapters/registry';
import { resolveAdapter } from '../translation_graph/adapters/resolve';
import { isTestHarnessTeam } from '../../lib/recording';
import { CHECKED_BY_MODULE, receiveDelivery } from 'movement-engine/public/inbound';
import { webhookProviderKey } from './urls';
import { listRemoteAdapters, parseStoredManifest } from '../translation_graph/adapters/remote/store';
import { mayBeRemoteSlug } from '../translation_graph/adapters/remote/slugs';
import { LEGACY_INTERCEPTS, builtInVerifierFor } from '../inbound/legacy_signature_headers';
import { builtinModuleInboundVerifier, builtinModuleRequestKeeping } from '../translation_graph/adapters/builtin_modules';
import { capturedRequest } from '../inbound/captured_request';

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

/** A built-in provider's subscription: verified by the frozen table, read by
 *  the adapter its provider key aliases. */
function builtInSource(subscription: InboundSubscription): InboundSource | null {
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
      // Provider keys are trigger-kind aliases (every provider key appears in its
      // adapter's manifest `triggerKinds`), so the registry's own alias map is the
      // resolver — NOT a naming convention (INBOUND_WHATSAPP is no slug).
      const adapterType = resolveAdapterSlug(subscription.providerKey);
      if (!hasAdapter(adapterType)) return null;
      const adapter = await resolveAdapter({
        adapterType,
        teamId: subscription.teamId as TeamId,
        credentialsId,
      });
      return { adapterType, credentialsId, adapter, ...builtInIntercept({ adapterType, subscription, credentialsId }) };
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
  return {};
}

/**
 * A subscription a team's remote install provisioned, recognised by its
 * provider key being the one that install mints (`webhookProviderKey`). An
 * install whose slug a built-in answers to is never recognised (the shared
 * rule in `remote/slugs`): the built-in wins, as it does at resolution. It
 * signs in the protocol's own header, and only that header. The row carries no
 * credential of its own; the install's credential is the channel's.
 */
async function remoteSource(subscription: InboundSubscription): Promise<InboundSource | null> {
  const installs = await listRemoteAdapters({ teamId: subscription.teamId as TeamId });
  const install = installs.find(
    (row) =>
      mayBeRemoteSlug(row.adapter_type) &&
      webhookProviderKey({ adapterType: row.adapter_type }) === subscription.providerKey,
  );
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
  let opened: Promise<OpenedSource> | undefined;
  return {
    verifier: checksItsOwn ? CHECKED_BY_MODULE : REMOTE_VERIFIER,
    secret: subscription.secret,
    open: () =>
      (opened ??= resolveAdapter({ adapterType: install.adapter_type, teamId: subscription.teamId as TeamId }).then((adapter) => ({
        adapterType: install.adapter_type,
        credentialsId,
        adapter,
      }))),
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
  // delivery's arrivals, as it is kept (listen_door.ts). An event still
  // refreshes the knowledge graph node bridged to the record it names.
  capture: async ({ event, subscription, source }) => {
    await refreshBridgedLinkedObject({ event, subscription: subscriptionRow(subscription, source) });
    return [];
  },

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

/** The platform's store for one received request: its delivery keeps the
 *  request (redacted), so a listen can be put through it again. */
export function platformInboundStoreFor(received: ReceivedRequest): InboundStore<CapturedReceipts> {
  return { ...platformInboundStore, keepDelivery: (input) => keepWebhookDelivery(input, received) };
}

/** A webhook delivery's one write, with the request it came as when the door
 *  has it. */
async function keepWebhookDelivery(
  { subscription, source, arrivals, checkpoint }: Parameters<InboundStore<CapturedReceipts>['keepDelivery']>[0],
  received: ReceivedRequest | null,
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
      ? {
          request: capturedRequest({
            keeping: builtinModuleRequestKeeping(source.adapterType),
            headers: received.headers,
            rawBody: received.rawBody,
            ...(received.method !== undefined ? { method: received.method } : {}),
            ...(received.path !== undefined ? { path: received.path } : {}),
            ...(received.query !== undefined ? { query: received.query } : {}),
            // The cursor it was read against, so a replay reads it the same way.
            ...(subscription.checkpoint !== undefined && subscription.checkpoint !== null ? { checkpoint: subscription.checkpoint } : {}),
            arrivals,
          }),
        }
      : {}),
  });
  return kept.kept ? { kept: true, arrivalMark: kept.arrivalMark } : { kept: false };
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

/** Queue a linked_object refresh when a knowledge graph node is bridged to
 *  the record an event names. Its own row; no provider read in the request. */
async function refreshBridgedLinkedObject(input: {
  event: DiscriminableEvent;
  subscription: { team_id: string; credentials_id: string; provider: string };
}): Promise<void> {
  const { event, subscription } = input;
  const { externalId, recordType, idempotencyKey } = event;
  if (externalId === undefined) return;
  const refresh: LinkedObjectRefresh = {
    teamId: subscription.team_id as TeamId,
    provider: subscription.provider,
    credentialsId: subscription.credentials_id,
    externalId,
    ...(recordType !== undefined ? { recordType } : {}),
  };
  if (await hasBridgedLinkedObjects(refresh)) {
    await enqueueLinkedObjectRefresh({ refresh, eventKey: idempotencyKey ?? externalId });
  }
}

export { handleInboundWebhook };
