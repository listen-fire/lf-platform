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
//     cell a list of event types) is never renewed: no version this build
//     carries listens through one, so it is removed in its own form (callback
//     URL, external id, scope). Operator-created rows (`provisioned_by` NULL)
//     are never touched;
//   - a registration the source refused keeps its row `pending` (no secret
//     anything verifies against), and the periodic retry asks again
//     (`retryListenSubscriptions`);
//   - a key renamed by a release or an upgrade (a carried version's narrowed
//     key names it; the current version's does not) takes over the row of its
//     earlier name when nothing wants that name any more, so the webhook the
//     source already posts to serves it (`takeOverEarlierRows`). Each release's
//     deploy check queues one sync of every team, which does it without a save
//     (`syncListenSubscriptionsAfterRelease`); an upgrade does it in its own
//     transaction (`takeOverEarlierSubscriptions`);
//   - a team whose engine is lf wants no subscription at all: a cloud lf
//     registers its own, so every one is removed, and a switch back to the
//     platform registers them afresh (lf_engine/switch.ts runs this sync);
//   - one sync of a team runs at a time (`withTeamSyncedAlone`). It looks at
//     the team twice under the team's doors, held shared (`withDoorsHeld`):
//     first for what its listens want and the rows, renaming each wanted one
//     onto the row it takes over, then, once registered, again for what nothing
//     wants now, which it retires. An upgrade holds the doors alone while it
//     moves listens and renames rows (`takeOverEarlierSubscriptions`), so its
//     commit falls wholly before or after each look. A provider is called only
//     between the looks and after them, with the doors let go: the team's sync
//     lock, which nothing but another sync of the team waits for, is all that
//     is held then. Nothing that holds the doors (a door, a poll's keep, an
//     upgrade) ever waits for that lock, and a sync takes it before the doors,
//     so neither waits on the other in turn.
//
// Called after a save or delete has reconciled the trigger rows, so the trigger
// table IS the desired state; the sync is per team and idempotent. Failures
// never block a save: they come back as notes, and each subscription left
// unregistered comes back by its digest, for whoever owes one (./listens_up.ts).

import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import Pg from 'pg';
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookSubscriptionId } from '../../../generated/kysely/automations/WebhookSubscription';
import type { AdapterManifest } from 'movement-engine/public/adapter';
import type { WorkHandler } from '../../work/kinds';

import { getAutomationsQb } from '../../../lib/kysely';
import { getDatabaseUrl } from '../../../prisma';
import { logger } from 'movement-engine/public/log';
import { buildWebhookTargetUrl, webhookProviderKey } from '../../webhook_sync/urls';
import { UNREGISTERED_SECRET } from 'movement-engine/public/inbound';
import { hasAdapter, resolveAdapterSlug } from '../adapters/registry';
import { resolveAdapter } from '../adapters/resolve';
import { builtinInboundSecretIssuedByProvider } from '../adapters/builtin_modules';
import { teamAdapterManifestSet } from '../adapters/team_manifests';
import { readTeamEngine } from '../../lf_engine/team_engine';
import { carriedVersions, type CarriedVersion, type ListeningLane, type ModulePlatform } from '@listen-fire/language-versions';

import { savedListens, type SavedListen } from '../../inbound/listen_door';
import { carriedEdgeKeysOf, carriedListensContained, kindsOf, kindsPinnedTo } from '../../inbound/carried_listens';
import { neverAsAny } from 'movement-engine/public/types';
import { earlierNamesOf, isPushed, listenEdgeDigest, listenEdgeKeysOf, namesReadBesides, placeFrom012, type ListenEdgeKey, type PlaceNames } from '../../inbound/listen_edge';
import { withDoorsHeld } from '../../movement_engine/run_host_deliveries';
import { WorkDeferred } from '../../work/deferred';
import { WorkGivesUp, registerWorkHandler } from '../../work/drain';
import { enqueueWork } from '../../work/store';
import { teamIdSchema } from '../../../lib/team_id';

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
  /** The carried version that registered it, and removes it, through its own
   *  module; absent for the current version's. A narrowed subscription is read
   *  by that version's listens alone; one to a whole connection's edge, by every
   *  version's listens sharing it (listen_edge.ts, `unnarrowed`). */
  version: z.string().optional(),
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
  /** A carried version's listens want it: its own module registers it. */
  lane?: ListeningLane;
}

/** What registers and removes a subscription: the module of the version whose
 *  listens share it. */
interface Subscriber {
  ensureEventSubscription?(input: { edge: string; filter?: unknown; scope?: string; callbackUrl: string; current?: { externalId: string } }): Promise<{ externalId?: string; secret?: string } | undefined>;
  removeEventSubscription?(input: ReturnType<typeof removalOf>): Promise<void>;
}

/** The platform's hosting of a carried version's modules. Loaded when a carried
 *  listen is subscribed for: the carried run host reaches the catalog, which
 *  reaches this sync. */
async function carriedModules(): Promise<ModulePlatform> {
  const { modulePlatform } = await import('./carried_run');
  return modulePlatform();
}

/** A carried version's module, as a subscriber of one install's edges. */
function carriedSubscriber(lane: ListeningLane, install: { teamId: TeamId; adapterType: string; credentialsId: string | null; constructionArgs?: Record<string, string> }): Required<Subscriber> {
  return {
    async ensureEventSubscription(input) {
      const outcome = await lane.subscribeEdge({ ...install, ...input }, await carriedModules());
      switch (outcome.kind) {
        case 'unanswered':
          throw new Error(`${install.adapterType}: its module under the listen's version does not answer ensureEventSubscription, so ${input.edge} receives nothing`);
        case 'registered':
          return {
            ...(outcome.externalId !== undefined ? { externalId: outcome.externalId } : {}),
            ...(outcome.secret !== undefined ? { secret: outcome.secret } : {}),
          };
        default:
          return neverAsAny(outcome);
      }
    },
    async removeEventSubscription(input) {
      if (!('edge' in input)) throw new Error(`a carried version's subscription is removed by its edge`);
      await lane.unsubscribeEdge({ ...install, ...input }, await carriedModules());
    },
  };
}

export interface SubscriptionRow {
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

/** The team's desired subscriptions, off its saved listens, paused or not (a
 *  paused listen keeps its subscription). Only a module that answers
 *  `ensureEventSubscription` is subscribed for. `carriedUnread`: the carried
 *  versions whose listens could not be read, left out so the current version's
 *  subscriptions are synced whatever a carried version does. */
async function desiredSubscriptions(input: {
  teamId: TeamId;
  manifestBySlug: ReadonlyMap<string, AdapterManifest>;
  remoteDegraded: boolean;
  account: SyncAccount;
}): Promise<{ desired: DesiredSubscription[]; carriedUnread: ReadonlySet<string> }> {
  const { teamId, manifestBySlug, remoteDegraded, account } = input;
  const desired = new Map<string, DesiredSubscription>();
  const current = (await savedListens({ teamId })).map((listen) => ({ listen, label: `${listen.file}:${listen.plan.movement}`, keys: listenEdgeKeysOf(listen, ['connection', 'scope']), lane: undefined, version: undefined }));
  const read = await carriedListensContained({ teamId });
  for (const version of read.unread) account.notes.push(`the listens pinned to ${version} could not be read, so their subscriptions are left as they are`);
  const carried = read.listens.map((listen) => ({
    listen,
    label: `${listen.file}:${listen.watch.movement}`,
    keys: carriedEdgeKeysOf(listen, ['connection', 'scope']),
    lane: listen.lane,
    version: listen.version.key,
  }));
  // The current version's first: a subscription to a whole connection's edge
  // that both versions' listens share is registered by this release's module.
  for (const { label, keys, lane, version } of [...current, ...carried]) {
    for (const { key, digest } of keys) {
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
        noteUnregistered(account, digest, `${slug}: ${label} has no credential, so ${key.edge} cannot be subscribed for`);
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
          ...(version !== undefined ? { version } : {}),
        },
        ...(lane !== undefined ? { lane } : {}),
      });
    }
  }
  return { desired: [...desired.values()], carriedUnread: read.unread };
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

/** The newer release first: `0.15.3` before `0.12.4`. */
function newerReleaseFirst(a: CarriedVersion, b: CarriedVersion): number {
  const parts = (version: CarriedVersion) => version.release.split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let at = 0; at < Math.max(x.length, y.length); at++) {
    const by = (y[at] ?? 0) - (x[at] ?? 0);
    if (by !== 0) return by;
  }
  return 0;
}

/** The names a narrowed subscription's listens were subscribed under before
 *  the version reading them changed, most recent first, each unlike its own:
 *  a carried key's, from while its version was current (`earlierNamesOf`); a
 *  current key's, under each carried version, newest first, from before its
 *  listens were upgraded off it, with that version. One to a whole
 *  connection's edge is named alike by every version, so it has none. */
function earlierSubscriptionNamesOf(key: ListenEdgeKey): Array<{ digest: string; version?: string }> {
  if (key.version !== undefined) return earlierNamesOf(key).map((digest) => ({ digest }));
  if (key.taken === undefined && key.scope === undefined) return [];
  return carriedVersions()
    .filter((version) => version.provides.listen.kind === 'carried')
    .sort(newerReleaseFirst)
    .map((version) => ({ digest: listenEdgeDigest({ ...key, version: version.key }), version: version.key }));
}

/**
 * The row a wanted subscription with no row of its own takes over, by the one
 * rule for a place kept under an earlier name (`namesReadBesides`): of its
 * earlier names, newest first, the first a row on its provider holds is the
 * place. That row is taken (moved) when no other key reads its name, as its own
 * or as an earlier one, and no version whose listens could not be read was
 * subscribed under it (it is not known unwanted). Otherwise none is: the row
 * stays (copied), and this key is registered on a row of its own. An older name
 * is never tried past the first row found.
 */
export function earlierRowToTake(input: {
  subscription: Pick<DesiredSubscription, 'key' | 'providerKey'>;
  rows: readonly SubscriptionRow[];
  readBesides: ReadonlySet<string>;
  carriedUnread: ReadonlySet<string>;
}): { row: SubscriptionRow; earlier: string } | undefined {
  for (const { digest, version } of earlierSubscriptionNamesOf(input.subscription.key)) {
    const row = input.rows.find((candidate) => candidate.held?.digest === digest && candidate.provider === input.subscription.providerKey);
    if (row === undefined) continue;
    const readElsewhere = input.readBesides.has(digest) || (version !== undefined && input.carriedUnread.has(version));
    return readElsewhere ? undefined : { row, earlier: digest };
  }
  return undefined;
}

/**
 * Each wanted subscription with no row of its own takes over the row its
 * listens were subscribed under by an earlier name (a release that versioned
 * its key, or an upgrade that unversioned it), as `earlierRowToTake` says: the
 * row is renamed, so the webhook the source already posts to is this key's,
 * its registration unchanged. Answers the rows as they now stand.
 *
 * Called under the team's doors, held shared by a sync (which also holds the
 * team's sync lock) or alone by an upgrade, so nothing else renames or retires
 * a row between the read and the rename.
 */
async function takeOverEarlierRows(input: {
  desired: readonly DesiredSubscription[];
  existing: readonly SubscriptionRow[];
  carriedUnread: ReadonlySet<string>;
}): Promise<SubscriptionRow[]> {
  const named = input.desired.map((subscription): PlaceNames => ({ own: subscription.held.digest, earlier: earlierSubscriptionNamesOf(subscription.key).map(({ digest }) => digest) }));
  const rows = [...input.existing];
  for (const subscription of input.desired) {
    if (rowOf(rows, subscription) !== undefined) continue;
    const readBesides = namesReadBesides({ taker: subscription.held.digest, keys: named });
    const taken = earlierRowToTake({ subscription, rows, readBesides, carriedUnread: input.carriedUnread });
    if (taken === undefined) continue;
    const renamed = await getAutomationsQb(['webhook_subscription'])
      .updateTable('webhook_subscription')
      .set({ subscriptions: JSON.stringify(subscription.held), updated_at: new Date() })
      .where('id', '=', taken.row.id as WebhookSubscriptionId)
      .where('deleted_at', 'is', null)
      .where(sql<string>`subscriptions->>'digest'`, '=', taken.earlier)
      .executeTakeFirst();
    // The locks above leave no way for the row to have changed since it was
    // read: carrying on from a stale read is how two webhooks came to post one event.
    if (renamed.numUpdatedRows === BigInt(0)) {
      throw new Error(`the subscription row ${taken.row.id} no longer holds ${taken.earlier}, though nothing else may change it while the team's doors are held`);
    }
    logger.info('[ListenSubscriptions] a subscription took over the row of its earlier name', { teamId: subscription.key.teamId, row: taken.row.id, from: taken.earlier, to: subscription.held.digest });
    rows[rows.indexOf(taken.row)] = { ...taken.row, held: subscription.held };
  }
  return rows;
}

/** The row holding `subscription`, if any. */
function rowOf(rows: readonly SubscriptionRow[], subscription: Pick<DesiredSubscription, 'held' | 'providerKey'>): SubscriptionRow | undefined {
  return rows.find((row) => row.held?.digest === subscription.held.digest && row.provider === subscription.providerKey);
}

/** The team as one look under its doors sees it: what its listens want, and its
 *  rows, each wanted subscription renamed onto the row it takes over. */
interface TeamLook {
  desired: DesiredSubscription[];
  carriedUnread: ReadonlySet<string>;
  rows: SubscriptionRow[];
}

/** One look at the team. Its caller holds the team's doors. */
async function lookAtTeam(input: {
  teamId: TeamId;
  manifestBySlug: ReadonlyMap<string, AdapterManifest>;
  remoteDegraded: boolean;
  lfEngined: boolean;
  account: SyncAccount;
}): Promise<TeamLook> {
  const { desired, carriedUnread } = input.lfEngined ? { desired: [], carriedUnread: new Set<string>() } : await desiredSubscriptions(input);
  const rows = await takeOverEarlierRows({ desired, existing: await provisionedRows(input.teamId), carriedUnread });
  return { desired, carriedUnread, rows };
}

/** The live row holding `subscription`, else one minted for it, pending. Its
 *  caller holds the team's doors: an upgrade that committed since the sync
 *  looked may have renamed a row onto this name, and a second row for it would
 *  be a second webhook posting each event. */
async function rowFoundOrMinted(input: { teamId: TeamId; subscription: DesiredSubscription }): Promise<SubscriptionRow> {
  const { providerKey, key, held } = input.subscription;
  const found = rowOf(await provisionedRows(input.teamId), input.subscription);
  if (found !== undefined) return found;
  // The row is minted first: its id is the stable URL the source posts to.
  const id = randomUUID();
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      id: id as WebhookSubscriptionId,
      team_id: input.teamId,
      provider: providerKey,
      credentials_id: key.credentialsId as ExternalServiceCredentialsId | null,
      webhook_secret: UNREGISTERED_SECRET,
      subscriptions: JSON.stringify(held),
      status: 'pending',
      provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
    })
    .execute();
  return { id, provider: providerKey, credentialsId: key.credentialsId, externalWebhookId: null, secret: UNREGISTERED_SECRET, held, legacyScope: {}, status: 'pending' };
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

async function withdraw(adapter: Subscriber, removal: ReturnType<typeof removalOf>, callbackUrl: string): Promise<void> {
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
  // A remote is asked again on every sync even when nothing changed here: its
  // subscription lives in somebody else's system, which may have lost it. A
  // built-in's registration is trusted until it changes.
  if (input.row?.status === 'active' && !remote) return;
  const adapter: Subscriber =
    subscription.lane !== undefined
      ? carriedSubscriber(subscription.lane, { teamId, adapterType: slug, credentialsId: key.credentialsId, ...(key.constructionArgs !== undefined ? { constructionArgs: key.constructionArgs } : {}) })
      : await resolveAdapter({
          adapterType: slug,
          teamId,
          ...(key.credentialsId !== null ? { credentialsId: key.credentialsId } : {}),
          ...(key.constructionArgs !== undefined ? { constructionArgs: key.constructionArgs } : {}),
        });
  if (typeof adapter.ensureEventSubscription !== 'function') {
    noteUnregistered(account, held.digest, `${slug}: its manifest declares ensureEventSubscription but the adapter does not answer it, so ${key.edge} receives nothing`);
    return;
  }
  const row = input.row ?? (await withDoorsHeld(teamId, () => rowFoundOrMinted({ teamId, subscription })));
  const settled = row.status === 'active';
  if (settled && !remote) return;
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
 * Which 0.12 webhooks a listen whose place came from 0.12 still hears through:
 * its own subscription is not registered yet (the source refused, or the listen
 * has not been resolved to its scope). A delivery at such a webhook is judged by
 * every current listen on the module, so withdrawing it would lose what arrives
 * until the retry succeeds. Keeping it costs nothing: a listen hears an arrival
 * once. A listen upgraded off a later version never heard through one, so it
 * keeps none (`placeFrom012`).
 */
async function webhooksStillCarryingMoved(input: { teamId: TeamId; manifestBySlug: ReadonlyMap<string, AdapterManifest> }): Promise<(row: SubscriptionRow) => boolean> {
  const moved = (await savedListens({ teamId: input.teamId })).filter((listen) => placeFrom012(listen.carriedFrom));
  if (moved.length === 0) return () => false;
  const up = new Set((await provisionedRows(input.teamId)).flatMap((row) => (row.held !== null && row.status === 'active' ? [row.held.digest] : [])));
  const waiting: Array<{ provider: string; credentialsId: string | null }> = [];
  for (const listen of moved) {
    const manifest = input.manifestBySlug.get(resolveAdapterSlug(listen.plan.adapter));
    if (manifest === undefined || !manifest.methods.includes('ensureEventSubscription')) continue;
    if (!isPushed(listen)) continue;
    const keys = listenEdgeKeysOf(listen, ['connection', 'scope']);
    if (keys.length === 0 || keys.some(({ digest }) => !up.has(digest))) waiting.push({ provider: webhookProviderKey(manifest), credentialsId: listen.credentialsId });
  }
  return (row) => row.held === null && waiting.some((listen) => listen.provider === row.provider && listen.credentialsId === row.credentialsId);
}

/** What removes a row's subscription: the module of the version it names (a
 *  carried version's own, through its lane; it removes one of its own while it
 *  still carries the version), else this release's. */
async function subscriberOfRow(input: { teamId: TeamId; slug: string; row: SubscriptionRow }): Promise<Subscriber> {
  const { row } = input;
  const install = {
    teamId: input.teamId,
    adapterType: input.slug,
    credentialsId: row.credentialsId,
    ...(row.held?.constructionArgs !== undefined ? { constructionArgs: row.held.constructionArgs } : {}),
  };
  const version = row.held?.version !== undefined ? carriedVersions().find((candidate) => candidate.key === row.held?.version) : undefined;
  if (version?.listenRows !== undefined) return carriedSubscriber(await version.listenRows(), install);
  return resolveAdapter({
    adapterType: input.slug,
    teamId: input.teamId,
    ...(row.credentialsId !== null ? { credentialsId: row.credentialsId } : {}),
    ...(install.constructionArgs !== undefined ? { constructionArgs: install.constructionArgs } : {}),
  });
}

/**
 * An upgrade's share of the sync, in its own transaction once its automations
 * are moved: each subscription the team's listens want now takes over the row
 * of its earlier name (`takeOverEarlierRows`), so the webhook the source posts
 * to is the upgraded listen's from the moment the upgrade commits, not from
 * when the sync it queued runs. That sync then finds the row its. Nothing is
 * registered or removed: no provider is called while the transaction is open.
 * A delivery kept on the row before the move stays its earlier version's: the
 * upgrade marks each pushed listen with the move (`carriedFrom.at`).
 */
export async function takeOverEarlierSubscriptions(input: { teamId: TeamId }): Promise<void> {
  if ((await readTeamEngine(input.teamId)).engine === 'lf') return;
  const account: SyncAccount = { notes: [], unregistered: [] };
  const { manifests, remoteDegraded } = await teamAdapterManifestSet(input.teamId, account.notes);
  const manifestBySlug = new Map(manifests.map((m) => [m.adapterType, m]));
  // The upgrade holds the team's doors alone, so this look needs no hold of its own.
  await lookAtTeam({ teamId: input.teamId, manifestBySlug, remoteDegraded, lfEngined: false, account });
}

/** How long a sync waits for the sync of the team before it. A sync takes
 *  seconds, so a longer wait is one stuck at a provider: this one is deferred,
 *  and its caller's work row tries again later. */
const SYNC_WAIT_MS = 60_000;

const LOCK_NOT_AVAILABLE = '55P03';

/** A sync that could not have its turn on the team: it did nothing. Deferred
 *  in a work row, which spends no attempt on it. */
export class TeamSyncBusy extends WorkDeferred {
  constructor(teamId: TeamId, options: { cause: unknown }) {
    super(`another sync of team ${teamId}'s subscriptions ran for over ${SYNC_WAIT_MS / 1000} s, so this one did nothing; it is tried again`);
    this.name = 'TeamSyncBusy';
    this.cause = options.cause;
  }
}

/**
 * `body` as the team's only sync: two at once would each read the rows before
 * the other renamed them, register a second webhook, and remove the one in use.
 * The team's sync lock is held across the provider calls on a connection of its
 * own, outside any transaction and every pool, and only another sync of the
 * team ever waits for it (header). The connection ending lets it go.
 */
async function withTeamSyncedAlone<T>(teamId: TeamId, body: () => Promise<T>): Promise<T> {
  const lock = new Pg.Client({ connectionString: getDatabaseUrl(false).url, application_name: 'lf-subscription-sync-lock' });
  // An unheard `error` ends the process. A lost connection lets the lock go
  // with it; the next sync's wait is all that notices.
  lock.on('error', (error) => logger.warn("[ListenSubscriptions] the connection holding a team's sync lock failed", { teamId, cause: error.message }));
  await lock.connect();
  try {
    await lock.query("select set_config('lock_timeout', $1, false)", [`${SYNC_WAIT_MS}ms`]);
    try {
      await lock.query('select pg_advisory_lock(hashtextextended($1::text, 0))', [`listen-subscriptions:${teamId}`]);
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === LOCK_NOT_AVAILABLE) throw new TeamSyncBusy(teamId, { cause });
      throw cause;
    }
    return await body();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

/**
 * Bring the team's subscriptions in line with its listens. Idempotent; every
 * failure is contained per subscription and surfaced as a note. One sync of a
 * team at a time (`withTeamSyncedAlone`).
 */
export async function syncListenSubscriptions(input: { teamId: TeamId }): Promise<SyncAccount> {
  return withTeamSyncedAlone(input.teamId, () => syncAlone(input.teamId));
}

async function syncAlone(teamId: TeamId): Promise<SyncAccount> {
  const account: SyncAccount = { notes: [], unregistered: [] };
  const { manifests, remoteSlugs, remoteDegraded } = await teamAdapterManifestSet(teamId, account.notes);
  const manifestBySlug = new Map(manifests.map((m) => [m.adapterType, m]));
  // Read fresh, not through dispatch's copy: this runs right after a switch.
  const lfEngined = (await readTeamEngine(teamId)).engine === 'lf';
  const looking = { teamId, manifestBySlug, remoteDegraded, lfEngined };

  const wanted = await withDoorsHeld(teamId, () => lookAtTeam({ ...looking, account }));
  for (const subscription of wanted.desired) {
    try {
      await ensureSubscription({ teamId, subscription, row: rowOf(wanted.rows, subscription), remote: remoteSlugs.has(subscription.slug), account });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[ListenSubscriptions] ensure failed', { teamId, adapter: subscription.slug, edge: subscription.key.edge, error: message });
      noteUnregistered(account, subscription.held.digest, `${subscription.slug}: subscribing for ${subscription.key.edge} failed (${message})`);
    }
  }

  // Looked at again: registering took a while, and an upgrade may have moved
  // listens and renamed rows since. A row is retired before it is removed at the
  // source, so no upgrade can take over a row this sync is removing.
  const retired = await withDoorsHeld(teamId, () => retireUnwanted({ ...looking, manifests, account }));
  for (const { row, slug } of retired) {
    try {
      const adapter = await subscriberOfRow({ teamId, slug, row });
      await adapter.removeEventSubscription?.(removalOf(row, buildWebhookTargetUrl(row.provider, row.id)));
    } catch (err) {
      // A source-side webhook left behind posts at a row that no longer
      // verifies, and is removable by hand.
      account.notes.push(`${slug}: removing its subscription at the source failed (${err instanceof Error ? err.message : String(err)}); retired here`);
    }
  }
  return account;
}

/** Retires each row nothing wants now, and answers them with the module that
 *  removes each at the source. Its caller holds the team's doors. */
async function retireUnwanted(input: {
  teamId: TeamId;
  manifests: readonly AdapterManifest[];
  manifestBySlug: ReadonlyMap<string, AdapterManifest>;
  remoteDegraded: boolean;
  lfEngined: boolean;
  account: SyncAccount;
}): Promise<Array<{ row: SubscriptionRow; slug: string }>> {
  const { teamId } = input;
  const { notes } = input.account;
  // What this look would note, the first said already.
  const now = await lookAtTeam({ ...input, account: { notes: [], unregistered: [] } });
  // A remote install's provider key is not a registry alias, so teardown maps
  // a row's key back to its slug through the same rule that minted it.
  const slugByProviderKey = new Map(input.manifests.map((m) => [webhookProviderKey(m), m.adapterType]));
  const stillCarrying = input.lfEngined ? () => false : await webhooksStillCarryingMoved({ teamId, manifestBySlug: input.manifestBySlug });
  const unreadKinds = await kindsPinnedTo({ teamId, versions: now.carriedUnread });

  const retired: Array<{ row: SubscriptionRow; slug: string }> = [];
  for (const row of now.rows) {
    if (now.desired.some((subscription) => rowOf(now.rows, subscription) === row)) continue;
    const slug = slugByProviderKey.get(row.provider) ?? resolveAdapterSlug(row.provider);
    // Nor is one of a version whose listens could not be read: it is not known unwanted.
    if (row.held?.version !== undefined && now.carriedUnread.has(row.held.version)) continue;
    // Nor is one no version is recorded on (this release registered it, or it
    // is a 0.12 webhook) on a module such a version has listens on: it may be
    // the one subscription both versions share.
    if (row.held?.version === undefined && kindsOf({ adapterType: slug, providerKey: row.provider }).some((kind) => unreadKinds.has(kind))) {
      notes.push(`${row.provider}: its subscription stays while the listens of ${[...now.carriedUnread].join(', ')} on it cannot be read`);
      continue;
    }
    // Nor is the one a moved listen still hears through, until its own is up.
    if (stillCarrying(row)) {
      notes.push(`${row.provider}: its 0.12 webhook stays until the upgraded listen's own subscription is up`);
      continue;
    }
    // With the remote installs only partly read, a row no built-in owns may be
    // a live remote subscription whose manifest simply went unread: keep it.
    if (input.remoteDegraded && !hasAdapter(resolveAdapterSlug(row.provider))) {
      notes.push(`${row.provider}: remote installs could not all be read, so its subscription is left in place`);
      continue;
    }
    await getAutomationsQb(['webhook_subscription'])
      .updateTable('webhook_subscription')
      .set({ deleted_at: new Date(), status: 'disabled', updated_at: new Date() })
      .where('id', '=', row.id as WebhookSubscriptionId)
      .execute();
    retired.push({ row, slug });
  }
  return retired;
}

/** Each team with a provisioned row still pending, or holding a 0.12 webhook,
 *  synced again: the platform's own retry of what a source refused and of what
 *  an upgrade left registered. */
export async function retryListenSubscriptions(): Promise<{ teams: number }> {
  const rows = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['team_id', 'status', 'subscriptions'])
    .execute();
  const teams = new Set(rows.filter((row) => row.status === 'pending' || edgeSubscriptionOf(row.subscriptions) === null).map((row) => row.team_id as TeamId));
  for (const teamId of teams) {
    try {
      const { notes } = await syncListenSubscriptions({ teamId });
      if (notes.length > 0) logger.warn('[ListenSubscriptions] a retry left notes', { teamId, notes });
    } catch (err) {
      // The next period's retry asks again; the other teams go on.
      logger.warn("[ListenSubscriptions] a retry of a team's subscriptions failed", { teamId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { teams: teams.size };
}

export const listenSubscriptionRetryHandler: WorkHandler = {
  async run() {
    await retryListenSubscriptions();
  },
};

const RELEASE_SYNC = 'listen_subscription_release_sync';

/** The attempts the release's sync gets before it is given up on and an
 *  operator is told; each syncs every team again, which changes nothing for
 *  one already synced. */
export const RELEASE_SYNC_ATTEMPTS = 10;

const releaseSyncSchema = z.object({ release: z.string() });

/** The release's sync, queued by the deploy check, which runs once per
 *  release: a release that versions a narrowed key renames its subscription
 *  (`takeOverEarlierRows`), and nothing else syncs a team until someone saves.
 *  The api's drain runs it once it is up; the release before never claims it. */
export async function queueListenSubscriptionSyncAfterRelease(input: { release: string }): Promise<void> {
  await enqueueWork({ kind: RELEASE_SYNC, key: `${RELEASE_SYNC}:${input.release}`, payload: { release: input.release } });
}

/** Every team the platform listens for synced once: each with a listen, and
 *  each with a subscription its listens may no longer want. Answers the teams
 *  whose sync failed. */
export async function syncListenSubscriptionsAfterRelease(input: { heartbeat?: () => Promise<void> } = {}): Promise<{ teams: number; failed: TeamId[] }> {
  const listening = await getAutomationsQb(['trigger']).selectFrom('trigger').select('team_id').distinct().execute();
  const subscribed = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select('team_id')
    .distinct()
    .execute();
  const teams = new Set([...listening, ...subscribed].map((row) => teamIdSchema.parse(row.team_id)));
  const failed: TeamId[] = [];
  for (const teamId of teams) {
    try {
      const { notes } = await syncListenSubscriptions({ teamId });
      if (notes.length > 0) logger.warn("[ListenSubscriptions] the release's sync left notes", { teamId, notes });
    } catch (err) {
      failed.push(teamId);
      logger.error("[ListenSubscriptions] the release's sync of a team failed", { teamId, error: err instanceof Error ? err.message : String(err) });
    }
    await input.heartbeat?.();
  }
  return { teams: teams.size, failed };
}

export const listenSubscriptionReleaseSyncHandler: WorkHandler = {
  async run(payload, ctx) {
    const { release } = releaseSyncSchema.parse(payload);
    const { failed } = await syncListenSubscriptionsAfterRelease({ heartbeat: ctx.heartbeat });
    if (failed.length === 0) return;
    const reason = `${release}: the subscriptions of ${failed.length === 1 ? 'one team' : `${failed.length} teams`} could not be synced (${failed.join(', ')})`;
    if (ctx.attempts < RELEASE_SYNC_ATTEMPTS) throw new Error(reason);
    logger.error(`[ListenSubscriptions] ${reason} after ${ctx.attempts} attempts: they sync again on their next save`);
    throw new WorkGivesUp(reason);
  },
};

export function registerListenSubscriptionWork(): void {
  registerWorkHandler('listen_subscription_retry', listenSubscriptionRetryHandler);
  registerWorkHandler(RELEASE_SYNC, listenSubscriptionReleaseSyncHandler);
}
