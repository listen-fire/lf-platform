// What keeps a 0.12 listen hearing: its webhook channel at the source, its poll,
// and the one-off carrying of how far it heard to the current version. Production
// at 0.12.13 (`listen_subscriptions.ts`, `poll_source/worker.ts`), over 0.12's own
// modules; the platform keeps the rows, the leases and the cursors, and only ever
// holds what crosses here as data.

import type { AdapterManifest, EventType } from '@listen-fire/engine/public/adapter';
import { eventConfigList, triggerEventOf } from '@listen-fire/engine/public/inbound';

import { manifestOf } from './listen_manifests';
import { manifestsOf } from './manifests';
import { moduleTable, pollerOf } from './modules';
import type { ModulePlatform } from './run_types';

// ── Channels ────────────────────────────────────────────────────────────────

/** A trigger row as a channel reads it. */
export interface ChannelRow {
  name: string;
  kind: string;
  credentialsId: string | null;
  config: unknown;
  resolvedAddress: unknown;
}

/** What the platform read of a team's remote installs: their manifests carry no
 *  event vocabulary, so a listen's selection passes through as written. */
export interface RemoteChannelFacts {
  adapterType: string;
  methods: readonly string[];
  requiredCredentialType?: string;
}

/** One webhook 0.12's listens want: one per (module, credential, scope). */
export interface Channel {
  slug: string;
  providerKey: string;
  credentialsId: string | null;
  events: string[];
  scope: Record<string, string>;
}

function resolvedAddressOf(raw: unknown): Record<string, string> {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function canonicalAddress(address: Record<string, string>): string {
  return Object.entries(address)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** The channels `rows` want, with a note for each that cannot be provisioned.
 *  Production's `desiredChannels`. Only a module that answers the subscription
 *  seam has channels. */
export function channelsOf(
  request: { rows: readonly ChannelRow[]; slugOf: (kind: string) => string; remote: readonly RemoteChannelFacts[] },
  modules: ModulePlatform,
): { channels: Channel[]; notes: string[] } {
  const notes: string[] = [];
  const channels = new Map<string, Channel>();
  for (const row of request.rows) {
    const slug = request.slugOf(row.kind);
    const manifest: Pick<AdapterManifest, 'adapterType' | 'methods' | 'requiredCredentialType' | 'subscribableEvents' | 'subscriptionScopeKeys' | 'triggerKinds'> | undefined =
      manifestOf(slug, modules) ?? request.remote.find((remote) => remote.adapterType === slug);
    if (manifest === undefined || !manifest.methods.includes('ensureEventSubscription')) continue;
    const vocabulary = manifest.subscribableEvents;
    if (vocabulary !== undefined && vocabulary.length === 0) continue;
    if (row.credentialsId === null && manifest.requiredCredentialType !== undefined) {
      notes.push(`${slug}: a listener has no credential, so its event subscription cannot be provisioned`);
      continue;
    }
    const config = (row.config ?? {}) as Record<string, unknown>;
    const authored = eventConfigList(config.events);
    const requested = vocabulary === undefined ? authored : authored.filter((event) => vocabulary.includes(event));
    const events = requested.length > 0 || vocabulary === undefined ? requested : [...vocabulary];
    const resolved = resolvedAddressOf(row.resolvedAddress);
    const scope: Record<string, string> = {};
    const missing: string[] = [];
    for (const key of manifest.subscriptionScopeKeys ?? []) {
      const value = resolved[key] ?? config[key];
      if (typeof value === 'string' && value.length > 0) scope[key] = value;
      else missing.push(key);
    }
    if (missing.length > 0) {
      notes.push(`${slug}: listener '${row.name}' has no resolved '${missing.join("', '")}' for its event subscription, so no channel was provisioned; re-save its automation to resolve the address`);
      continue;
    }
    const key = `${slug}::${row.credentialsId ?? ''}::${canonicalAddress(scope)}`;
    const existing = channels.get(key);
    if (existing !== undefined) {
      for (const event of events) if (!existing.events.includes(event)) existing.events.push(event);
    } else {
      channels.set(key, { slug, providerKey: manifest.triggerKinds?.[0] ?? manifest.adapterType.toUpperCase(), credentialsId: row.credentialsId, events, scope });
    }
  }
  return { channels: [...channels.values()], notes };
}

function installOf(request: { teamId: string; credentialsId: string | null }) {
  return { teamId: request.teamId, ...(request.credentialsId !== null ? { credentialsId: request.credentialsId } : {}) };
}

/** What a channel's source answered: undefined fields are what it kept. */
export interface ChannelRegistration {
  externalId?: string;
  secret?: string;
}

/** A channel registered with 0.12's own module. `null` when the module does not
 *  answer the seam its manifest declares. */
export async function ensureChannel(
  request: {
    teamId: string;
    slug: string;
    credentialsId: string | null;
    events: readonly string[];
    callbackUrl: string;
    current?: { externalId?: string; events: readonly string[] };
    scope: Record<string, string>;
  },
  modules: ModulePlatform,
): Promise<ChannelRegistration | null> {
  const adapter = await moduleTable(modules).resolve(request.slug, installOf(request));
  if (typeof adapter.ensureEventSubscription !== 'function') return null;
  const registration = await adapter.ensureEventSubscription({
    events: [...request.events],
    callbackUrl: request.callbackUrl,
    ...(request.current !== undefined ? { current: { ...request.current, events: [...request.current.events] } } : {}),
    ...(Object.keys(request.scope).length > 0 ? { scope: request.scope } : {}),
  });
  return {
    ...(registration?.externalId !== undefined ? { externalId: registration.externalId } : {}),
    ...(registration?.secret !== undefined ? { secret: registration.secret } : {}),
  };
}

export async function removeChannel(
  request: { teamId: string; slug: string; credentialsId: string | null; callbackUrl: string; externalId: string | null; scope: Record<string, string> },
  modules: ModulePlatform,
): Promise<void> {
  const adapter = await moduleTable(modules).resolve(request.slug, installOf(request));
  await adapter.removeEventSubscription?.({
    callbackUrl: request.callbackUrl,
    ...(request.externalId !== null ? { externalId: request.externalId } : {}),
    ...(Object.keys(request.scope).length > 0 ? { scope: request.scope } : {}),
  });
}

/** A channel's window kept open at its source (Airtable's seven days). */
export async function refreshChannel(
  request: { teamId: string; slug: string; credentialsId: string | null; externalId: string; scope: Record<string, string> },
  modules: ModulePlatform,
): Promise<void> {
  const adapter = await moduleTable(modules).resolve(request.slug, installOf(request));
  if (adapter.refreshEventSubscription === undefined) throw new Error(`${request.slug} under 0.12 cannot refresh a webhook subscription`);
  await adapter.refreshEventSubscription({
    externalId: request.externalId,
    ...(Object.keys(request.scope).length > 0 ? { scope: request.scope } : {}),
  });
}

// ── Polls ───────────────────────────────────────────────────────────────────

/** The modules whose events are polled under 0.12. */
export function polledKinds(modules: ModulePlatform): string[] {
  const { kgChangeWebhooks, whatsappNumber } = modules.parts;
  return manifestsOf({ kgChangeWebhooks, whatsappNumber, mcpEnabled: true }).flatMap((manifest) =>
    manifest.supportedTriggers.includes('poll') ? [manifest.adapterType] : [],
  );
}

/** A polled module's own cadence. */
export function pollSecondsOf(adapterType: string, modules: ModulePlatform): number | undefined {
  return pollerOf(modules).intervalSeconds(adapterType);
}

export interface PollListenRequest {
  teamId: string;
  triggerId: string;
  adapterType: string;
  credentialsId: string | null;
  movementId: string;
  config: unknown;
  checkpoint: unknown;
  now: string;
}

/** One pull of a 0.12 listen from its own cursor: the events, each in 0.12's
 *  shape as JSON, and the next cursor. Nothing is kept here: the platform keeps
 *  the page and the cursor in one write. */
export async function pollListen(request: PollListenRequest, modules: ModulePlatform): Promise<{ events: Record<string, unknown>[]; checkpoint: unknown }> {
  const install = installOf(request);
  const result = await pollerOf(modules).poll(request.adapterType, install, {
    config: request.config,
    ...(request.checkpoint !== null && request.checkpoint !== undefined ? { checkpoint: request.checkpoint } : {}),
    movementId: request.movementId,
  });
  const adapter = await moduleTable(modules).resolve(request.adapterType, install);
  const eventTypes: readonly EventType[] = adapter.listEventTypes !== undefined ? await adapter.listEventTypes() : [];
  const now = new Date(request.now);
  const events = result.events.map((event) => {
    const { triggerEvent } = triggerEventOf({ pipelineInputId: `trigger:${request.triggerId}`, adapterType: request.adapterType, triggerType: 'poll', event, eventTypes, now });
    return JSON.parse(JSON.stringify(triggerEvent)) as Record<string, unknown>;
  });
  return { events, checkpoint: result.checkpoint ?? null };
}

/** One tick of a 0.12 schedule, in 0.12's shape. Production's `fire_cron`. */
export function tickEvent(request: { triggerId: string; due: string; schedule: string }): Record<string, unknown> {
  return {
    pipelineInputId: `trigger:${request.triggerId}`,
    adapterType: 'cron',
    triggerType: 'webhook',
    payload: { firedAt: request.due, schedule: request.schedule },
    occurredAt: request.due,
  };
}

// ── How far a listen heard, carried to the current version ──────────────────

/** Where a 0.12 listen stood, as its row keeps it. */
export interface HeardSoFar {
  adapterType: string;
  /** The current version's listened edge the cursor is asked for. */
  edge: string;
  pollCheckpoint: unknown;
  cronLastFiredAt: string | null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const NIL_ID = '00000000-0000-0000-0000-000000000000';

/** The system module's marks: a 0.12 cursor keeps one for failed runs and one
 *  across the stored kinds, and the current one keeps one per source. The current
 *  mark orders a stored kind's rows by another field than 0.12's row id, and no
 *  value of that field says which rows of one instant 0.12 had heard (a deploy
 *  check stamps a whole sweep with one), so the 0.12 row id goes with it. A listen
 *  that had read no stored event yet carries the lowest id, which 0.12 armed with. */
function systemCursor(checkpoint: Record<string, unknown>): Record<string, unknown> | undefined {
  const failed = recordOf(checkpoint.runFailed);
  const stored = recordOf(checkpoint.stored);
  const cursor: Record<string, unknown> = {};
  if (typeof failed.failedAt === 'string' && typeof failed.runId === 'string') cursor.failed = { at: failed.failedAt, runId: failed.runId };
  if (typeof stored.occurredAt === 'string' && typeof stored.id === 'string') {
    const place = { at: stored.occurredAt, heardThrough: stored.id };
    cursor.paused = { ...place, runId: NIL_ID };
    cursor.releases = { ...place, version: '' };
    cursor.validation = { ...place, automationId: '' };
    cursor.deprecated = { ...place, automationId: '' };
  }
  return Object.keys(cursor).length > 0 ? cursor : undefined;
}

/**
 * The one-off map from a 0.12 listen's cursor to the cursor the current version's
 * module reads, per module. Undefined when the listen had not heard anything yet:
 * its first poll arms, as it would have under 0.12. A module 0.12 did not poll, or
 * one whose cursor this does not know, is never guessed at.
 */
export function cursorOnCurrent(heard: HeardSoFar): { cursor: unknown } | undefined {
  if (heard.adapterType === 'cron') return heard.cronLastFiredAt === null ? undefined : { cursor: heard.cronLastFiredAt };
  const checkpoint = recordOf(heard.pollCheckpoint);
  switch (heard.adapterType) {
    case 'dealroom':
      return typeof checkpoint.createdAfter === 'number' ? { cursor: { createdAfter: checkpoint.createdAfter } } : undefined;
    case 'granola':
      return typeof checkpoint.updatedAfter === 'string' ? { cursor: { updatedAfter: checkpoint.updatedAfter } } : undefined;
    case 'gmail':
      // History ids are one sequence for both of its edges.
      return typeof checkpoint.historyId === 'string' ? { cursor: checkpoint } : undefined;
    case 'evertrace': {
      const mark = heard.edge === 'Signals' ? checkpoint.createdAfter : checkpoint.entriesCreatedAfter;
      return typeof mark === 'number' ? { cursor: { createdAfter: mark } } : undefined;
    }
    case 'system': {
      const cursor = systemCursor(checkpoint);
      return cursor === undefined ? undefined : { cursor };
    }
    default:
      return undefined;
  }
}
