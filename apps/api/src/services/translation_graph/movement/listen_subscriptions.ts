// Subscriptions per listenable edge (adapter protocol 2.6), kept in lockstep
// with the team's listens.
//
//   - every listen whose last edge its module delivers by subscription
//     (`delivery: connection` or `scope`, on a module that answers
//     `ensureEventSubscription`) shares one subscription with the listens of
//     the same key (inbound/listen_edge.ts): connection, edge and the filter
//     the module takes. Each is one `webhook_subscription` row marked
//     `provisioned_by = 'movement-listen'`, whose `subscriptions` cell holds the
//     key; the row id keys its stable callback URL, and the webhook door judges
//     what arrives there only by the listens sharing it;
//   - the module registers it (`ensureEventSubscription({ edge, filter,
//     callbackUrl, current })`), and the row keeps what the source issued (its
//     external id and the secret deliveries are verified with);
//   - a subscription no listen shares any more is removed at the source
//     (`removeEventSubscription({ edge, filter, callbackUrl, externalId })`)
//     and its row retired. A webhook a 0.12 settings listen registered (its
//     cell a list of event types) is never renewed: it is removed in its own
//     form (callback URL, external id, scope). Operator-created rows
//     (`provisioned_by` NULL) are never touched;
//   - a registration the source refused keeps its row `pending` (no secret
//     anything verifies against), and the periodic retry asks again
//     (`retryListenSubscriptions`);
//   - a team whose engine is lf wants no subscription at all: a cloud lf
//     registers its own, so every one is removed, and a switch back to the
//     platform registers them afresh (lf_engine/switch.ts runs this sync).
//
// Called after a save or delete has reconciled the trigger rows, so the trigger
// table IS the desired state; the sync is per team and idempotent. Failures
// never block a save: they come back as notes, and each subscription left
// unregistered comes back by its digest, for whoever owes one (./listens_up.ts).

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookSubscriptionId } from '../../../generated/kysely/automations/WebhookSubscription';
import type { Adapter, AdapterManifest } from 'movement-engine/public/adapter';
import type { WorkHandler } from '../../work/kinds';

import { getAutomationsQb } from '../../../lib/kysely';
import { logger } from 'movement-engine/public/log';
import { buildWebhookTargetUrl, webhookProviderKey } from '../../webhook_sync/urls';
import { UNREGISTERED_SECRET } from 'movement-engine/public/inbound';
import { hasAdapter, resolveAdapterSlug } from '../adapters/registry';
import { resolveAdapter } from '../adapters/resolve';
import { builtinInboundSecretIssuedByProvider } from '../adapters/builtin_modules';
import { teamAdapterManifestSet } from '../adapters/team_manifests';
import { readTeamEngine } from '../../lf_engine/team_engine';
import { savedListens, type SavedListen } from '../../inbound/listen_door';
import { listenEdgeKeysOf, type ListenEdgeKey } from '../../inbound/listen_edge';
import { registerWorkHandler } from '../../work/drain';

export const MOVEMENT_LISTEN_PROVISIONER = 'movement-listen';

/** What a provisioned row's `subscriptions` cell keeps for an edge's
 *  subscription: its key, and the digest it is found by. An edge pushed per
 *  scope (Airtable's `Changes`, one webhook per base) keeps the record that
 *  scope is, so the module is told which base to register, remove or refresh. */
const edgeSubscriptionSchema = z.object({
  digest: z.string(),
  edge: z.string(),
  filter: z.unknown().optional(),
  scope: z.string().optional(),
  constructionArgs: z.record(z.string(), z.string()).optional(),
});
type EdgeSubscription = z.infer<typeof edgeSubscriptionSchema>;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The edge subscription a row holds; null for a 0.12 webhook's list of
 *  event types, or an operator-created row's. */
export function edgeSubscriptionOf(cell: unknown): EdgeSubscription | null {
  const parsed = edgeSubscriptionSchema.safeParse(typeof cell === 'string' ? safeJson(cell) : cell);
  return parsed.success ? parsed.data : null;
}

/** The listens sharing the subscription a provisioned row holds: the only
 *  listens that judge what arrives at its URL. Undefined for a row that
 *  holds no edge's subscription (every listen of the team on the module). */
export async function listensOfSubscription(input: {
  teamId: TeamId;
  adapterType: string;
  subscriptions: unknown;
}): Promise<SavedListen[] | undefined> {
  const held = edgeSubscriptionOf(input.subscriptions);
  if (held === null) return undefined;
  const listens = await savedListens({ teamId: input.teamId, adapterType: input.adapterType });
  return listens.filter((listen) => listenEdgeKeysOf(listen, ['connection', 'scope']).some(({ digest }) => digest === held.digest));
}

/** A subscription a sync wanted and could not register, by the digest its
 *  listens name it by, with the note that says why. */
export interface UnregisteredSubscription {
  digest: string;
  note: string;
}

/** A sync's running account of what it could not do. */
interface SyncAccount {
  notes: string[];
  unregistered: UnregisteredSubscription[];
}

function noteUnregistered(account: SyncAccount, digest: string, note: string): void {
  account.notes.push(note);
  account.unregistered.push({ digest, note });
}

/** One subscription the team's listens want. */
interface DesiredSubscription {
  slug: string;
  /** The webhook_subscription `provider` key (the inbound route segment). */
  providerKey: string;
  key: ListenEdgeKey;
  held: EdgeSubscription;
}

interface SubscriptionRow {
  id: string;
  provider: string;
  credentialsId: string | null;
  externalWebhookId: string | null;
  /** The secret deliveries are verified with (`UNREGISTERED_SECRET` until registered). */
  secret: string;
  /** The edge subscription it holds; null for a 0.12 webhook. */
  held: EdgeSubscription | null;
  /** A 0.12 webhook's adapter-declared scope (Airtable's `{ base, table }`). */
  legacyScope: Record<string, string>;
  /** 'active' once registered; 'pending' while it still needs registering. */
  status: string;
}

function legacyScopeOf(rawValue: unknown): Record<string, string> {
  const raw = typeof rawValue === 'string' ? safeJson(rawValue) : rawValue;
  if (raw === null || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** The team's desired subscriptions, off its saved listens. Only a module
 *  that answers `ensureEventSubscription` is subscribed for. */
async function desiredSubscriptions(input: {
  teamId: TeamId;
  manifestBySlug: ReadonlyMap<string, AdapterManifest>;
  remoteDegraded: boolean;
  account: SyncAccount;
}): Promise<DesiredSubscription[]> {
  const { teamId, manifestBySlug, remoteDegraded, account } = input;
  const desired = new Map<string, DesiredSubscription>();
  for (const listen of await savedListens({ teamId })) {
    for (const { key, digest } of listenEdgeKeysOf(listen, ['connection', 'scope'])) {
      const slug = resolveAdapterSlug(key.adapterType);
      const manifest = manifestBySlug.get(slug);
      // With the remote installs only partly read, an unknown module may be a
      // remote one that wants this subscription: not known to be fine.
      if (manifest === undefined && remoteDegraded) {
        account.unregistered.push({ digest, note: `${slug}: its manifest could not be read, so ${key.edge} cannot be subscribed for yet` });
        continue;
      }
      if (manifest === undefined || !manifest.methods.includes('ensureEventSubscription')) continue;
      if (key.credentialsId === null && manifest.requiredCredentialType !== undefined) {
        noteUnregistered(account, digest, `${slug}: ${listen.file}:${listen.plan.movement} has no credential, so ${key.edge} cannot be subscribed for`);
        continue;
      }
      if (desired.has(digest)) continue;
      desired.set(digest, {
        slug,
        providerKey: webhookProviderKey(manifest),
        key,
        held: {
          digest,
          edge: key.edge,
          ...(key.taken !== undefined ? { filter: key.taken } : {}),
          ...(key.scope !== undefined ? { scope: key.scope } : {}),
          ...(key.constructionArgs !== undefined ? { constructionArgs: key.constructionArgs } : {}),
        },
      });
    }
  }
  return [...desired.values()];
}

async function provisionedRows(teamId: TeamId): Promise<SubscriptionRow[]> {
  const rows = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'provider', 'credentials_id', 'external_webhook_id', 'webhook_secret', 'subscriptions', 'scope', 'status'])
    .execute();
  return rows.map((r) => ({
    id: r.id as string,
    provider: r.provider,
    credentialsId: (r.credentials_id as string | null) ?? null,
    externalWebhookId: r.external_webhook_id,
    secret: r.webhook_secret,
    held: edgeSubscriptionOf(r.subscriptions),
    legacyScope: legacyScopeOf(r.scope),
    status: r.status,
  }));
}

const NO_SECRET_REFUSAL = 'remote adapter returned no secret; deliveries cannot be verified';
const NO_ISSUED_SECRET_REFUSAL = 'the provider issues the webhook secret but its registration returned none; deliveries cannot be verified';

/** A secret a delivery can be verified against (not the placeholder). */
function usableSecret(secret: string | null): boolean {
  return secret !== null && secret.trim() !== '' && secret !== UNREGISTERED_SECRET;
}

/** What `removeEventSubscription` is asked: an edge's subscription by its
 *  edge and filter, a 0.12 webhook in its own form. */
function removalOf(row: Pick<SubscriptionRow, 'held' | 'externalWebhookId' | 'legacyScope'>, callbackUrl: string) {
  const externalId = row.externalWebhookId !== null ? { externalId: row.externalWebhookId } : {};
  if (row.held !== null) {
    return {
      edge: row.held.edge,
      ...(row.held.filter !== undefined ? { filter: row.held.filter } : {}),
      ...(row.held.scope !== undefined ? { scope: row.held.scope } : {}),
      callbackUrl,
      ...externalId,
    };
  }
  return { callbackUrl, ...externalId, ...(Object.keys(row.legacyScope).length > 0 ? { scope: row.legacyScope } : {}) };
}

async function setRow(id: string, set: { status: string; secret?: string; externalId?: string | null }): Promise<void> {
  await getAutomationsQb(['webhook_subscription'])
    .updateTable('webhook_subscription')
    .set({
      status: set.status,
      ...(set.secret !== undefined ? { webhook_secret: set.secret } : {}),
      ...(set.externalId !== undefined ? { external_webhook_id: set.externalId } : {}),
      updated_at: new Date(),
    })
    .where('id', '=', id as WebhookSubscriptionId)
    .execute();
}

async function withdraw(adapter: Adapter, removal: ReturnType<typeof removalOf>, callbackUrl: string): Promise<void> {
  try {
    await adapter.removeEventSubscription?.(removal);
  } catch (err) {
    logger.warn('[ListenSubscriptions] withdrawing a subscription without a usable secret failed', {
      callbackUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Register one desired subscription on its row (minted if new). A refusal
 *  leaves the row pending, so the next sync or retry asks again. */
async function ensureSubscription(input: {
  teamId: TeamId;
  subscription: DesiredSubscription;
  row: SubscriptionRow | undefined;
  remote: boolean;
  account: SyncAccount;
}): Promise<void> {
  const { teamId, subscription, remote, account } = input;
  const { slug, providerKey, key, held } = subscription;
  const settled = input.row !== undefined && input.row.status === 'active';
  // A remote is asked again on every sync even when nothing changed here: its
  // subscription lives in somebody else's system, which may have lost it. A
  // built-in's registration is trusted until it changes.
  if (settled && !remote) return;
  const adapter = await resolveAdapter({
    adapterType: slug,
    teamId,
    ...(key.credentialsId !== null ? { credentialsId: key.credentialsId } : {}),
    ...(key.constructionArgs !== undefined ? { constructionArgs: key.constructionArgs } : {}),
  });
  if (typeof adapter.ensureEventSubscription !== 'function') {
    noteUnregistered(account, held.digest, `${slug}: its manifest declares ensureEventSubscription but the adapter does not answer it, so ${key.edge} receives nothing`);
    return;
  }
  let row = input.row;
  if (row === undefined) {
    // The row is minted first: its id is the stable URL the source posts to.
    const id = randomUUID();
    await getAutomationsQb(['webhook_subscription'])
      .insertInto('webhook_subscription')
      .values({
        id: id as WebhookSubscriptionId,
        team_id: teamId,
        provider: providerKey,
        credentials_id: key.credentialsId as ExternalServiceCredentialsId | null,
        webhook_secret: UNREGISTERED_SECRET,
        subscriptions: JSON.stringify(held),
        status: 'pending',
        provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
      })
      .execute();
    row = { id, provider: providerKey, credentialsId: key.credentialsId, externalWebhookId: null, secret: UNREGISTERED_SECRET, held, legacyScope: {}, status: 'pending' };
  }
  const callbackUrl = buildWebhookTargetUrl(providerKey, row.id);
  const registration = await adapter.ensureEventSubscription({
    edge: held.edge,
    ...(held.filter !== undefined ? { filter: held.filter } : {}),
    ...(held.scope !== undefined ? { scope: held.scope } : {}),
    callbackUrl,
    ...(row.externalWebhookId !== null ? { current: { externalId: row.externalWebhookId } } : {}),
  });
  // A remote's deliveries are verified only by the secret its registration
  // returns, and a built-in whose provider issues the secret must return one
  // unless the row already holds it: a registration without one is withdrawn
  // and refused, so no unverifiable subscription is left at the source.
  const issuedByProvider = !remote && builtinInboundSecretIssuedByProvider(providerKey);
  const needsSecret = remote || (issuedByProvider && !usableSecret(row.secret));
  if (needsSecret && (registration?.secret === undefined || registration.secret.length === 0)) {
    const externalWebhookId = registration?.externalId ?? row.externalWebhookId;
    await withdraw(adapter, removalOf({ ...row, externalWebhookId }, callbackUrl), callbackUrl);
    await setRow(row.id, { status: 'pending', secret: UNREGISTERED_SECRET, externalId: null });
    noteUnregistered(account, held.digest, `${slug}: subscribing for ${key.edge} failed (${remote ? NO_SECRET_REFUSAL : NO_ISSUED_SECRET_REFUSAL})`);
    return;
  }
  // The source kept what this side already holds: nothing to write.
  if (settled && registration?.secret === row.secret && (registration.externalId === undefined || registration.externalId === row.externalWebhookId)) return;
  await setRow(row.id, {
    status: 'active',
    ...(registration?.secret !== undefined ? { secret: registration.secret } : {}),
    ...(registration?.externalId !== undefined ? { externalId: registration.externalId } : {}),
  });
}

/**
 * Bring the team's subscriptions in line with its listens. Idempotent; every
 * failure is contained per subscription and surfaced as a note.
 */
export async function syncListenSubscriptions(input: { teamId: TeamId }): Promise<SyncAccount> {
  const account: SyncAccount = { notes: [], unregistered: [] };
  const { notes } = account;
  const { manifests, remoteSlugs, remoteDegraded } = await teamAdapterManifestSet(input.teamId, notes);
  const manifestBySlug = new Map(manifests.map((m) => [m.adapterType, m]));
  // A remote install's provider key is not a registry alias, so teardown maps
  // a row's key back to its slug through the same rule that minted it.
  const slugByProviderKey = new Map(manifests.map((m) => [webhookProviderKey(m), m.adapterType]));
  // Read fresh, not through dispatch's copy: this runs right after a switch.
  const lfEngined = (await readTeamEngine(input.teamId)).engine === 'lf';
  const desired = lfEngined ? [] : await desiredSubscriptions({ teamId: input.teamId, manifestBySlug, remoteDegraded, account });
  const existing = await provisionedRows(input.teamId);
  const rowOf = (subscription: DesiredSubscription) =>
    existing.find((row) => row.held?.digest === subscription.held.digest && row.provider === subscription.providerKey);

  for (const subscription of desired) {
    try {
      await ensureSubscription({ teamId: input.teamId, subscription, row: rowOf(subscription), remote: remoteSlugs.has(subscription.slug), account });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[ListenSubscriptions] ensure failed', { teamId: input.teamId, adapter: subscription.slug, edge: subscription.key.edge, error: message });
      noteUnregistered(account, subscription.held.digest, `${subscription.slug}: subscribing for ${subscription.key.edge} failed (${message})`);
    }
  }

  for (const row of existing) {
    if (desired.some((subscription) => rowOf(subscription) === row)) continue;
    // With the remote installs only partly read, a row no built-in owns may be
    // a live remote subscription whose manifest simply went unread: keep it.
    if (remoteDegraded && !hasAdapter(resolveAdapterSlug(row.provider))) {
      notes.push(`${row.provider}: remote installs could not all be read, so its subscription is left in place`);
      continue;
    }
    const slug = slugByProviderKey.get(row.provider) ?? resolveAdapterSlug(row.provider);
    try {
      const adapter = await resolveAdapter({
        adapterType: slug,
        teamId: input.teamId,
        ...(row.credentialsId !== null ? { credentialsId: row.credentialsId } : {}),
        ...(row.held?.constructionArgs !== undefined ? { constructionArgs: row.held.constructionArgs } : {}),
      });
      await adapter.removeEventSubscription?.(removalOf(row, buildWebhookTargetUrl(row.provider, row.id)));
    } catch (err) {
      // Retired here regardless: a source-side webhook left behind posts at a
      // row that no longer verifies, and is removable by hand.
      notes.push(`${slug}: removing its subscription at the source failed (${err instanceof Error ? err.message : String(err)}); retired here`);
    }
    await getAutomationsQb(['webhook_subscription'])
      .updateTable('webhook_subscription')
      .set({ deleted_at: new Date(), status: 'disabled', updated_at: new Date() })
      .where('id', '=', row.id as WebhookSubscriptionId)
      .execute();
  }

  return account;
}

/** Each team with a provisioned row still pending, or still holding a 0.12
 *  webhook, synced again: the platform's own retry of what a source refused
 *  or what the 0.13 deploy left registered. */
export async function retryListenSubscriptions(): Promise<{ teams: number }> {
  const rows = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['team_id', 'status', 'subscriptions'])
    .execute();
  const teams = new Set(rows.filter((row) => row.status === 'pending' || edgeSubscriptionOf(row.subscriptions) === null).map((row) => row.team_id as TeamId));
  for (const teamId of teams) {
    const { notes } = await syncListenSubscriptions({ teamId });
    if (notes.length > 0) logger.warn('[ListenSubscriptions] a retry left notes', { teamId, notes });
  }
  return { teams: teams.size };
}

export const listenSubscriptionRetryHandler: WorkHandler = {
  async run() {
    await retryListenSubscriptions();
  },
};

export function registerListenSubscriptionWork(): void {
  registerWorkHandler('listen_subscription_retry', listenSubscriptionRetryHandler);
}
