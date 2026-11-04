// 0.12's half of a delivery: its own modules read what the door kept, and its
// own rules judge the events against the listens pinned to it. Production's
// `captureProviderTriggerEvents` at 0.12.13, without the writes: the platform
// hands in its rows as plain data and keeps the receipts this answers.
//
// The door already verified the delivery. What it kept has no signature, so a
// module that checks its own requests is asked nothing here: it could only
// refuse.

import type { Adapter, DiscriminableEvent, EventType } from '@listen-fire/engine/public/adapter';
import { channelScopeMatches, collectFileListeners, eventConfigList, eventMatchesTriggerScope, triggerEventOf } from '@listen-fire/engine/public/inbound';
import { triggerEventSchema } from '@listen-fire/engine-contracts';
import { MovementParseError, parseProgram } from '@listen-fire/movement-lang';

import { manifestsOf } from './manifests';
import { moduleTable } from './modules';
import { filterByRecordScope } from './record_scope';
import type { ModulePlatform } from './run_types';

/** A trigger row as the platform keeps it, with the text its automation shipped. */
export interface ListenRow {
  id: string;
  kind: string;
  credentialsId: string | null;
  config: unknown;
  firedMovementName: string | null;
  source: string;
  pin: string;
}

export interface KeptDelivery {
  /** The request's body as base64, as the door kept it. */
  body: string;
  /** The cursor the door read it against: every version reads from there. */
  checkpoint?: unknown;
}

export interface ReadDeliveryRequest {
  teamId: string;
  adapterType: string;
  credentialsId: string | null;
  /** A shared bot hears every team's messages: a listen's own credential is
   *  what it sends with, not a gate on what it hears. */
  matchAnyCredential?: boolean;
  delivery: KeptDelivery;
  listens: readonly ListenRow[];
  now: string;
}

export interface ReadDeliveryOutcome {
  /** One per listen an event matched: the event in 0.12's shape, as JSON. */
  receipts: { triggerId: string; event: Record<string, unknown> }[];
  /** The correlation keys the delivery answers. */
  wakeKeys: string[];
  /** What read nothing, for the log. */
  lines: string[];
}

/** Whether a kept row is a listen under 0.12: an object 0.12's listener wrote
 *  (a current listen plan is another version's), firing a movement the text it
 *  shipped still listens with. A row kept only for a run that names it fires
 *  nothing once its listen has gone. */
export function isListenRow(row: Pick<ListenRow, 'config' | 'firedMovementName' | 'source' | 'pin'>): boolean {
  const { config, firedMovementName } = row;
  if (typeof config !== 'object' || config === null || Array.isArray(config) || 'listen' in config) return false;
  try {
    const listeners = collectFileListeners(parseProgram(row.source, { languageVersion: row.pin }), { languageVersion: row.pin });
    return listeners.some((listener) => listener.movementName === firedMovementName);
  } catch (error) {
    if (error instanceof MovementParseError) return false;
    throw error;
  }
}

function bodyOf(delivery: KeptDelivery): unknown {
  return JSON.parse(Buffer.from(delivery.body, 'base64').toString('utf-8'));
}

async function channelNameOf(adapter: Adapter, event: DiscriminableEvent): Promise<string | null> {
  const payload = event.payload as { channel?: unknown; item?: { channel?: unknown } } | undefined;
  const channelId =
    (typeof payload?.channel === 'string' && payload.channel) || (typeof payload?.item?.channel === 'string' && payload.item.channel) || undefined;
  if (!channelId) return null;
  const maybe = adapter as { resolveChannelName?: (id: string) => Promise<string | null> };
  return typeof maybe.resolveChannelName === 'function' ? maybe.resolveChannelName(channelId) : null;
}

/** Reads what the door kept with 0.12's own module and judges it against the
 *  rows handed in. A module's failure throws: the platform's row retries. */
export async function readDelivery(request: ReadDeliveryRequest, modules: ModulePlatform): Promise<ReadDeliveryOutcome> {
  const table = moduleTable(modules);
  const { teamId, adapterType, delivery } = request;
  const install = { teamId, ...(request.credentialsId !== null ? { credentialsId: request.credentialsId } : {}) };
  const lines: string[] = [];
  const adapter = await table.resolve(adapterType, install);
  if (adapter.preprocessInbound === undefined) {
    lines.push(`${adapterType} under 0.12 checks its own requests, and a kept request has no signature: this delivery is not read under 0.12`);
    return { receipts: [], wakeKeys: [], lines };
  }
  const raw = bodyOf(delivery);
  const { events } = await adapter.preprocessInbound({ raw, ...(delivery.checkpoint !== undefined ? { checkpoint: delivery.checkpoint } : {}) });
  const wakeKeys = adapter.wakeKeys !== undefined ? await adapter.wakeKeys({ raw }) : [];
  const listens = request.listens.filter(isListenRow);
  const receipts: ReadDeliveryOutcome['receipts'] = [];
  if (events.length === 0 || listens.length === 0) return { receipts, wakeKeys, lines };
  const eventTypes: readonly EventType[] = adapter.listEventTypes !== undefined ? await adapter.listEventTypes() : [];
  const mutation = isMutationSource(adapterType, modules);
  const now = new Date(request.now);
  for (const event of events) {
    const candidates = listens.filter((row) => {
      if (request.matchAnyCredential !== true && row.credentialsId !== null && row.credentialsId !== request.credentialsId) return false;
      return eventMatchesTriggerScope(event, row.config);
    });
    if (candidates.length === 0) continue;
    const channels = candidates.some((row) => eventConfigList((row.config as { channels?: unknown } | null)?.channels).length > 0);
    const channelName = channels ? await channelNameOf(adapter, event) : null;
    const channelScoped = channels ? candidates.filter((row) => channelScopeMatches(row.config, channelName)) : candidates;
    const scoped = mutation
      ? await filterByRecordScope({
          candidates: channelScoped,
          event,
          adapterType,
          resolve: (credentialsId) => table.resolve(adapterType, { teamId, ...(credentialsId !== null ? { credentialsId } : {}) }),
        })
      : channelScoped;
    for (const row of scoped) {
      const { triggerEvent } = triggerEventOf({
        pipelineInputId: `trigger:${row.id}`,
        adapterType,
        triggerType: mutation ? 'mutation' : 'webhook',
        event,
        eventTypes,
        now,
      });
      receipts.push({ triggerId: row.id, event: JSON.parse(JSON.stringify(triggerEvent)) as Record<string, unknown> });
    }
  }
  return { receipts, wakeKeys, lines };
}

function manifestOf(adapterType: string, modules: ModulePlatform) {
  const { kgChangeWebhooks, whatsappNumber } = modules.parts;
  return manifestsOf({ kgChangeWebhooks, whatsappNumber, mcpEnabled: true }).find((manifest) => manifest.adapterType === adapterType);
}

/** A source whose events are changes to records the host keeps. */
function isMutationSource(adapterType: string, modules: ModulePlatform): boolean {
  const triggers = manifestOf(adapterType, modules)?.supportedTriggers ?? [];
  return triggers.length > 0 && triggers.every((trigger) => trigger === 'mutation');
}

export interface GateRequest {
  teamId: string;
  adapterType: string;
  credentialsId: string | null;
  config: unknown;
  event: Readonly<Record<string, unknown>>;
}

/** What a firing's source module says of it, before it runs: production's echo
 *  suppression and the question its ownership gate asks. */
export type GateAnswer =
  | { kind: 'suppress'; reason: string }
  | { kind: 'proceed' }
  /** The module's manifest says a sender must be a registered user: these are
   *  who the event says sent it. */
  | { kind: 'needs-actor'; candidates: unknown };

export async function gateFiring(request: GateRequest, modules: ModulePlatform): Promise<GateAnswer> {
  const event = triggerEventSchema.parse(request.event);
  const adapter = await moduleTable(modules).resolve(request.adapterType, {
    teamId: request.teamId,
    ...(request.credentialsId !== null ? { credentialsId: request.credentialsId } : {}),
  });
  const config = request.config;
  // Default off; a module that cannot answer fires as normal, loudly.
  if (typeof config === 'object' && config !== null && (config as Record<string, unknown>).suppress_self === true) {
    if (adapter.didWeAuthor === undefined) {
      modules.log.warn(`[EchoSuppression] ${request.adapterType}: suppress_self is on, but this source cannot tell its own writes from external ones: firing as normal`, {});
    } else {
      const authored = await adapter.didWeAuthor({ event }).catch((err: unknown) => {
        modules.log.warn(`[EchoSuppression] ${request.adapterType}: the check failed, firing as normal`, { error: String(err) });
        return null;
      });
      if (authored === true) return { kind: 'suppress', reason: `${request.adapterType}: this change was authored by our own write (suppress_self)` };
    }
  }
  if (manifestOf(request.adapterType, modules)?.inboundRequiresRegisteredActor !== true) return { kind: 'proceed' };
  if (adapter.getActorCandidates === undefined) return { kind: 'needs-actor', candidates: [] };
  return { kind: 'needs-actor', candidates: await adapter.getActorCandidates({ event }) };
}

/** The listens a 0.12 text states, as trigger rows keep them. */
export function listenersOf(request: { source: string; pin: string }) {
  return collectFileListeners(parseProgram(request.source, { languageVersion: request.pin }), { languageVersion: request.pin });
}
