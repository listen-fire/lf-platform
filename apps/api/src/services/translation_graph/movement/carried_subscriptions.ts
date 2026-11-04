// The webhooks a carried version's listens want, kept beside the current
// version's (./listen_subscriptions.ts): production's channel sync at 0.12.13.
// A channel is one `webhook_subscription` row per (module, credential, scope),
// its `subscriptions` cell a list of event types as production wrote it, so a
// 0.12.13 service beside this one reads the row as its own, and each registration
// goes through the version's own module.
//
// A row only such a listen needs is never withdrawn, so a provider's deliveries
// keep arriving for it. Once none does, the current version's sync removes it.

import { randomUUID } from 'node:crypto';

import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { WebhookSubscriptionId } from '../../../generated/kysely/automations/WebhookSubscription';
import type { AdapterManifest } from 'movement-engine/public/adapter';
import type { Channel, ChannelRegistration, ListeningLane } from '@listen-fire/language-versions';

import { isLegacyLanguageVersion } from 'legacy-lang';
import { carriedVersions, versionOf, versionOfLegacyId, type CarriedVersion } from '@listen-fire/language-versions';
import { UNREGISTERED_SECRET } from 'movement-engine/public/inbound';
import { logger } from 'movement-engine/public/log';

import { getAutomationsQb } from '../../../lib/kysely';
import { buildWebhookTargetUrl } from '../../webhook_sync/urls';
import { builtinInboundSecretIssuedByProvider } from '../adapters/builtin_modules';
import { resolveAdapterSlug } from '../adapters/registry';
import { modulePlatform } from './carried_run';

export const MOVEMENT_LISTEN_PROVISIONER = 'movement-listen';

/** The version a kept row's pin reads under. */
function versionOfPin(pin: string): CarriedVersion | undefined {
  return isLegacyLanguageVersion(pin) ? versionOfLegacyId(pin) : versionOf(pin);
}

/** A row in the form production keeps a channel. */
export interface ChannelRowHeld {
  id: string;
  provider: string;
  credentialsId: string | null;
  externalWebhookId: string | null;
  secret: string;
  events: string[];
  scope: Record<string, string>;
  status: string;
}

export function sameScope(a: Record<string, string>, b: Record<string, string>): boolean {
  const left = Object.entries(a);
  return left.length === Object.keys(b).length && left.every(([key, value]) => b[key] === value);
}

function sameEvents(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((event) => b.includes(event));
}

/** The channels of one carried version a team's rows want. */
export interface WantedChannels {
  lane: ListeningLane;
  channels: Channel[];
}

/**
 * What each carried version's rows on `teamId` want, off rows no current listen
 * plan owns. A row a run keeps as a leftover is no listen. A team with none reads
 * no version's package.
 */
export async function carriedChannelsOf(input: {
  teamId: TeamId;
  manifests: readonly AdapterManifest[];
  notes: string[];
}): Promise<WantedChannels[]> {
  const rows = await getAutomationsQb(['trigger', 'movement'])
    .selectFrom('trigger')
    .innerJoin('movement', 'movement.id', 'trigger.movement_id')
    .where('trigger.team_id', '=', input.teamId)
    .select(['trigger.name as name', 'trigger.kind as kind', 'trigger.credentials_id as credentialsId', 'trigger.config as config', 'trigger.resolved_address as resolvedAddress', 'movement.language_version as pin', 'movement.id as movementId'])
    .execute();
  const kept = rows.filter((row) => {
    const config = (row.config ?? {}) as Record<string, unknown>;
    return !('listen' in config) && config.leftoverForUnfinishedRuns !== true;
  });
  if (kept.length === 0) return [];
  const wanted: WantedChannels[] = [];
  for (const version of carriedVersions()) {
    if (version.listenRows === undefined) continue;
    const theirs = kept.filter((row) => versionOfPin(row.pin)?.key === version.key);
    if (theirs.length === 0) continue;
    const lane = await version.listenRows();
    const { channels, notes } = lane.channelsOf(
      {
        rows: theirs.map((row) => ({ name: row.name, kind: row.kind, credentialsId: (row.credentialsId as string | null) ?? null, config: row.config, resolvedAddress: row.resolvedAddress })),
        slugOf: resolveAdapterSlug,
        remote: input.manifests.map((manifest) => ({
          adapterType: manifest.adapterType,
          methods: manifest.methods,
          ...(manifest.requiredCredentialType !== undefined ? { requiredCredentialType: manifest.requiredCredentialType } : {}),
        })),
      },
      modulePlatform(),
    );
    input.notes.push(...notes);
    wanted.push({ lane, channels });
  }
  return wanted;
}

function usable(secret: string | null): boolean {
  return secret !== null && secret.trim() !== '' && secret !== UNREGISTERED_SECRET;
}

const NO_SECRET = 'remote adapter returned no secret; deliveries cannot be verified';
const NO_ISSUED_SECRET = 'the provider issues the webhook secret but its registration returned none; deliveries cannot be verified';

async function writeRow(id: string, set: Partial<{ subscriptions: string; externalId: string | null; secret: string; status: string }>): Promise<void> {
  await getAutomationsQb(['webhook_subscription'])
    .updateTable('webhook_subscription')
    .set({
      ...(set.subscriptions !== undefined ? { subscriptions: set.subscriptions } : {}),
      ...(set.externalId !== undefined ? { external_webhook_id: set.externalId } : {}),
      ...(set.secret !== undefined ? { webhook_secret: set.secret } : {}),
      ...(set.status !== undefined ? { status: set.status } : {}),
      updated_at: new Date(),
    })
    .where('id', '=', id as WebhookSubscriptionId)
    .execute();
}

/** One channel registered, or asked again when its events changed. A remote is
 *  asked on every sync: it may have lost it. A registration that leaves nothing
 *  to verify a delivery with is withdrawn and refused. */
export async function ensureCarriedChannel(input: {
  teamId: TeamId;
  lane: ListeningLane;
  channel: Channel;
  row: ChannelRowHeld | undefined;
  remote: boolean;
  notes: string[];
}): Promise<void> {
  const { teamId, lane, channel, row, remote, notes } = input;
  const modules = modulePlatform();
  const settled = row !== undefined && row.status === 'active' && sameEvents(row.events, channel.events);
  if (settled && !remote) return;
  const issuedByProvider = !remote && builtinInboundSecretIssuedByProvider(channel.providerKey);
  const cell = JSON.stringify(channel.events.map((event) => ({ event_type: event })));
  const common = { teamId, slug: channel.slug, credentialsId: channel.credentialsId, events: channel.events, scope: channel.scope };
  const withdraw = async (callbackUrl: string, registration: ChannelRegistration): Promise<void> => {
    await lane
      .removeChannel({ teamId, slug: channel.slug, credentialsId: channel.credentialsId, callbackUrl, externalId: registration.externalId ?? null, scope: channel.scope }, modules)
      .catch((err: unknown) => logger.warn('[ListenSubscriptions] withdrawing a channel without a usable secret failed', { callbackUrl, error: err instanceof Error ? err.message : String(err) }));
  };
  const noSecret = (registration: ChannelRegistration | null): boolean => registration?.secret === undefined || registration.secret.length === 0;
  if (row !== undefined) {
    const callbackUrl = buildWebhookTargetUrl(channel.providerKey, row.id);
    const registration = await lane.ensureChannel(
      { ...common, callbackUrl, current: { ...(row.externalWebhookId !== null ? { externalId: row.externalWebhookId } : {}), events: row.events } },
      modules,
    );
    if (registration === null) {
      notes.push(`${channel.slug}: its manifest declares ensureEventSubscription but the adapter does not answer it, so events will not arrive`);
      return;
    }
    if ((remote || (issuedByProvider && !usable(row.secret))) && noSecret(registration)) {
      await withdraw(callbackUrl, registration);
      await writeRow(row.id, { status: 'pending', secret: UNREGISTERED_SECRET, externalId: null });
      notes.push(`${channel.slug}: event-subscription provisioning failed (${remote ? NO_SECRET : NO_ISSUED_SECRET})`);
      return;
    }
    if (settled && registration.secret === row.secret && (registration.externalId === undefined || registration.externalId === row.externalWebhookId)) return;
    await writeRow(row.id, {
      subscriptions: cell,
      ...(registration.externalId !== undefined ? { externalId: registration.externalId } : {}),
      ...(registration.secret !== undefined ? { secret: registration.secret } : {}),
      status: 'active',
    });
    return;
  }
  // The row first: its id is the stable URL. A failed registration removes it,
  // so the next sync asks cleanly.
  const id = randomUUID();
  await getAutomationsQb(['webhook_subscription'])
    .insertInto('webhook_subscription')
    .values({
      id: id as WebhookSubscriptionId,
      team_id: teamId,
      provider: channel.providerKey,
      credentials_id: channel.credentialsId as ExternalServiceCredentialsId | null,
      webhook_secret: UNREGISTERED_SECRET,
      subscriptions: cell,
      ...(Object.keys(channel.scope).length > 0 ? { scope: JSON.stringify(channel.scope) as never } : {}),
      status: 'pending',
      provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
    })
    .execute();
  try {
    const callbackUrl = buildWebhookTargetUrl(channel.providerKey, id);
    const registration = await lane.ensureChannel({ ...common, callbackUrl }, modules);
    if (registration === null) throw new Error('its manifest declares ensureEventSubscription but the adapter does not answer it');
    if ((remote || issuedByProvider) && noSecret(registration)) {
      await withdraw(callbackUrl, registration);
      throw new Error(remote ? NO_SECRET : NO_ISSUED_SECRET);
    }
    await writeRow(id, {
      externalId: registration.externalId ?? null,
      ...(registration.secret !== undefined ? { secret: registration.secret } : {}),
      status: 'active',
    });
  } catch (err) {
    await getAutomationsQb(['webhook_subscription']).deleteFrom('webhook_subscription').where('id', '=', id as WebhookSubscriptionId).execute();
    throw err;
  }
}

