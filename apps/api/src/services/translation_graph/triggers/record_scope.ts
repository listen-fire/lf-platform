// Which listens a change to a store's own record wakes: the scope a listen
// writes against a MUTATION source (`listen to graph { type: "Company",
// events: [...], fields: [...] }`), applied to the event before a receipt is
// stored.
//
// A listen names the watched type and its properties by NAME — the identity
// the adapter publishes — while the event carries the store's internal ids.
// THE ADAPTER owns that mapping, out of its own introspection (`listEntryPoints`
// names each type with its store id as `externalId`; `describe` names each
// field), so nothing here knows what a knowledge graph is. Both lookups are
// lazy and memoised per connection for one event: a listen with no name-shaped
// filter never pays for either, and ten listens on one event pay once.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { DiscriminableEvent } from 'movement-engine/public/adapter';

import { logger } from 'movement-engine/public/log';
import { resolveAdapter } from '../adapters/resolve';

/** The event's type and changed fields in the currency a listen is written in. */
export interface EventSurface {
  typeName(): Promise<string | undefined>;
  fieldNames(): Promise<string[]>;
}

/** The engine's change-kind axis → the uniform `record.*` event vocabulary a
 *  listen's `events:` names (D40). */
const CHANGE_KIND_TO_EVENT: Record<string, string> = {
  create: 'record.created',
  update: 'record.updated',
  delete: 'record.deleted',
};

/** Rows provisioned before D40 spoke participles in `change_kinds`. */
const CHANGE_KIND_TO_PARTICIPLE: Record<string, string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

/**
 * The listens whose scope accepts the event, each judged through its OWN
 * connection: an adapter that reaches its store over the network cannot
 * introspect without one, and two listens on one event may name different
 * connections, so one shared surface would answer the second from the first's
 * model.
 */
export async function filterByRecordScope<T extends { config: unknown; credentialsId: string | null }>(input: {
  candidates: T[];
  event: DiscriminableEvent;
  adapterType: string;
  teamId: TeamId;
}): Promise<T[]> {
  const surfaces = new Map<string, EventSurface>();
  const surfaceFor = (credentialsId: string | null): EventSurface => {
    const key = credentialsId ?? '';
    let surface = surfaces.get(key);
    if (surface === undefined) {
      surface = eventSurface({
        adapterType: input.adapterType,
        teamId: input.teamId,
        ...(credentialsId !== null ? { credentialsId } : {}),
        event: input.event,
      });
      surfaces.set(key, surface);
    }
    return surface;
  };
  const accepted: T[] = [];
  for (const candidate of input.candidates) {
    if (await recordScopeMatches(candidate.config, input.event, surfaceFor(candidate.credentialsId))) {
      accepted.push(candidate);
    }
  }
  return accepted;
}

/**
 * The event's surface names, through the adapter. A failure must not fail the
 * delivery — a listen with no name-shaped filter never asked for this lookup —
 * but it must not be SILENT either: an unanswerable name makes every
 * name-shaped listen stop matching, and the only symptom is a listener that
 * never fires. Loud, then degraded.
 */
export function eventSurface(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  event: DiscriminableEvent;
}): EventSurface {
  const adapter = () =>
    resolveAdapter({
      adapterType: input.adapterType,
      teamId: input.teamId,
      ...(input.credentialsId !== undefined ? { credentialsId: input.credentialsId } : {}),
    });
  let type: Promise<string | undefined> | undefined;
  let fields: Promise<string[]> | undefined;
  const typeName = () =>
    (type ??= (async () => {
      const entries = await (await adapter()).listEntryPoints();
      return entries.find((e) => e.externalId === input.event.recordType)?.typeId;
    })().catch((err) => {
      logger.error('[RecordScope] could not name the changed record’s type — name-shaped listens on this event cannot match', {
        adapterType: input.adapterType,
        teamId: input.teamId,
        recordType: input.event.recordType,
        hasConnection: input.credentialsId !== undefined,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }));
  return {
    typeName,
    fieldNames: () =>
      (fields ??= (async () => {
        const name = await typeName();
        if (name === undefined) return [];
        const descriptor = await (await adapter()).describe(name);
        const byId = new Map((descriptor?.fields ?? []).map((f) => [f.fieldId, f.displayName]));
        return (input.event.changedFields ?? []).flatMap((id) => {
          const displayName = byId.get(id);
          return displayName !== undefined ? [displayName] : [];
        });
      })().catch((err) => {
        logger.error('[RecordScope] could not name the changed fields — `fields:` filters on this event cannot match', {
          adapterType: input.adapterType,
          teamId: input.teamId,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      })),
  };
}

/**
 * Does this listen's scope accept the event?
 *
 * Two spellings are read, and that is a transition rather than a hedge: a row
 * provisioned before D40 persists the store's own currency (`node_type_id`,
 * participle `change_kinds`, `changed_fields` by id), and a row provisioned
 * after it persists the listen VERBATIM (`type`, `events`, `fields` by name).
 * Old rows keep filtering exactly as they did until their movement is re-saved.
 */
export async function recordScopeMatches(
  rawConfig: unknown,
  event: DiscriminableEvent,
  surface: EventSurface,
): Promise<boolean> {
  if (!rawConfig || typeof rawConfig !== 'object') return true;
  const config = rawConfig as {
    type?: unknown;
    events?: unknown;
    fields?: unknown;
    node_type_id?: unknown;
    change_kinds?: unknown;
    changed_fields?: unknown;
  };
  const changeKind = event.changeType;

  if (typeof config.node_type_id === 'string') {
    if (config.node_type_id !== event.recordType) return false;
  } else if (typeof config.type === 'string') {
    if (config.type !== (await surface.typeName())) return false;
  }

  if (Array.isArray(config.events) && config.events.length > 0) {
    const named = changeKind !== undefined ? (CHANGE_KIND_TO_EVENT[changeKind] ?? changeKind) : event.eventType;
    if (named === undefined || !config.events.includes(named)) return false;
  } else if (Array.isArray(config.change_kinds) && config.change_kinds.length > 0) {
    const named = changeKind !== undefined ? (CHANGE_KIND_TO_PARTICIPLE[changeKind] ?? changeKind) : undefined;
    if (named === undefined || !config.change_kinds.includes(named)) return false;
  }

  // Changed-attribute routing (`fields: [domains]`): fire only when the change
  // touched at least one watched property. Deletes carry no changed fields and
  // pass — the watched record disappearing IS a change to its fields.
  if (changeKind !== 'delete') {
    const changedFields = event.changedFields ?? [];
    const watchedIds = Array.isArray(config.changed_fields)
      ? config.changed_fields.filter((f): f is string => typeof f === 'string')
      : [];
    if (watchedIds.length > 0) {
      if (!watchedIds.some((f) => changedFields.includes(f))) return false;
    } else {
      const watchedNames = Array.isArray(config.fields)
        ? config.fields.filter((f): f is string => typeof f === 'string')
        : [];
      if (watchedNames.length > 0) {
        const touched = await surface.fieldNames();
        if (!watchedNames.some((f) => touched.includes(f))) return false;
      }
    }
  }
  return true;
}
