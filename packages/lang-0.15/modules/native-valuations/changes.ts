// A record's `Changes`: what Valuations' webhook says happened to one of an
// entity's rows (created, updated, deleted), as an arrival on that record's
// `Changes` edge. Each entity's changes land on a record type of their own
// (`Legal Entity Change`), so a listen on a legal entity's changes is never
// fired by an asset's.
//
// The platform's Valuations outbox sends one delivery per changed row, `{
// event, timestamp, actor, data: { id, before, after } }`, signed like
// Attio's. One webhook serves every listen on a connection's `Changes`: it
// takes every entity's events, and the host judges each arrival by the record
// type it landed on. Each change names the row it is about by the entity name
// a write names it by, and its id, so a run's own write that comes back is
// matched by the host's loop breaker.

import { z } from 'zod';

import type { Arrival } from '@listen-fire/engine-contracts';
import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
} from '@listen-fire/engine/public/catalog';

/** The edge every record hangs its changes off. */
export const VALUATIONS_CHANGES_EDGE = 'Changes';
/** Its reference id: no column takes it. */
export const VALUATIONS_CHANGES_REFERENCE = 'native-valuations:changes';
/** A change's edge to the record as it is now. */
export const VALUATIONS_CHANGE_RECORD_EDGE = 'Record';

export const VALUATIONS_CHANGE_KINDS = ['created', 'updated', 'deleted'] as const;
export type ValuationsChangeKind = (typeof VALUATIONS_CHANGE_KINDS)[number];

/** The outbox's operation, as each event type spells it. */
const KIND_OF_OPERATION: Record<string, ValuationsChangeKind> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

/** An entity whose rows change: the table its events name, and the name its
 *  record type and writes go by. */
export interface ChangedEntity {
  table: string;
  displayName: string;
  /** Reached from the connection's root by an edge of its own name. */
  rooted: boolean;
}

/** The webhook events a subscription for an entity's `Changes` takes: the
 *  outbox's `valuations:<table>:<create|update|delete>`. */
export function changeEventsOf(entity: Pick<ChangedEntity, 'table'>): string[] {
  return Object.keys(KIND_OF_OPERATION).map((operation) => `valuations:${entity.table}:${operation}`);
}

/** An arrival on a record's `Changes`: a change, never a record gone (a
 *  deleted row's change is one). */
export type ValuationsChangeArrival = Exclude<Arrival, { gone: true }>;

/** The record type an entity's changes land on (`Legal Entity Change`). */
export function changeTypeName(entity: Pick<ChangedEntity, 'displayName'>): string {
  return `${entity.displayName} Change`;
}

/** A change type's entry: named so the resolver knows it, listed by nothing. */
export function changeEntryPoint(entity: ChangedEntity): SchemaEntryPoint {
  return { typeId: changeTypeName(entity), displayName: changeTypeName(entity), writable: false, readable: false };
}

/** A record's `Changes`: pushed to the connection's webhook, each change once. */
export function changesReference(entity: ChangedEntity): SchemaReferenceDescriptor {
  const noun = entity.displayName.toLowerCase();
  return {
    fieldId: VALUATIONS_CHANGES_REFERENCE,
    name: VALUATIONS_CHANGES_EDGE,
    targetTypeId: changeTypeName(entity),
    cardinality: 'many',
    direction: 'outgoing',
    // You are told of a change; you cannot list the ones that happened.
    readable: false,
    writable: false,
    listenable: true,
    delivery: 'connection',
    identity: 'Id',
    attributes: true,
    ...(entity.rooted ? { carries: [entity.displayName] } : {}),
    backingFields: [],
    description: `What happens to a ${noun} in Valuations, each change once: created, updated (\`Changed Fields\` names what moved), deleted.`,
  };
}

/** An entity's change type: what happened, what moved, the row before and
 *  after, and the record as it is now (`Record`, a read). */
export function describeChange(entity: ChangedEntity, descriptor: SchemaTypeDescriptor): SchemaTypeDescriptor {
  const noun = entity.displayName.toLowerCase();
  const names = descriptor.fields.map((field) => field.displayName);
  const field = (fieldId: string, kind: SchemaFieldDescriptor['kind'], more: Partial<SchemaFieldDescriptor>): SchemaFieldDescriptor => ({
    fieldId,
    displayName: fieldId,
    kind,
    writable: false,
    required: false,
    ...more,
  });
  const row = (fieldId: string, description: string): SchemaFieldDescriptor =>
    field(fieldId, 'record', { record: { typeId: entity.displayName }, mayBeAbsent: true, description });
  return {
    typeId: changeTypeName(entity),
    displayName: changeTypeName(entity),
    description:
      `A change to a ${noun} in Valuations: what happened (\`Kind\`), which fields moved (\`Changed Fields\`), and the row as ` +
      `it was (\`Previous\`) and as the change left it (\`Current\`). Test a row present before reading through it ` +
      `(\`exists(c.Current) AND c.Current.Name == "Acme"\`); walk \`Record\` for the ${noun} as it is now.`,
    fields: [
      field('Id', 'string', { required: true, description: 'Names the change: the same each time Valuations sends it.' }),
      field('Kind', 'enum', { required: true, enumValues: [...VALUATIONS_CHANGE_KINDS], description: `What happened to the ${noun}.` }),
      field('Changed Fields', 'enum', {
        cardinality: 'many',
        enumValues: names,
        description: 'The fields the change moved, by name: every one a created row was given, none for a deleted one.',
      }),
      field('Record Id', 'string', { required: true, description: `Valuations' id for the ${noun}, a deleted one's too.` }),
      row('Current', 'The row as the change left it, every field by name. Absent when it was deleted.'),
      row('Previous', 'The row as it was before the change, every field by name. Absent when it was created.'),
    ],
    references: [
      {
        fieldId: VALUATIONS_CHANGE_RECORD_EDGE,
        name: VALUATIONS_CHANGE_RECORD_EDGE,
        targetTypeId: entity.displayName,
        cardinality: 'one',
        direction: 'outgoing',
        readable: true,
        writable: false,
        requiresLiveRecord: true,
        backingFields: [],
        description: `The ${noun} as it is now, read from Valuations: none once it is deleted.`,
      },
    ],
  };
}

/** One delivery. Parsed rather than trusted: a body is somebody else's claim
 *  until it typechecks. */
const deliverySchema = z.object({
  event: z.string(),
  timestamp: z.string(),
  data: z.object({
    id: z.string(),
    before: z.record(z.string(), z.unknown()).nullable().optional(),
    after: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
});

/** The entities a delivery may be about, and the record type of each. */
export interface ChangeCatalog {
  entityOfTable(table: string): ChangedEntity | undefined;
  descriptorOf(entity: ChangedEntity): SchemaTypeDescriptor;
}

/**
 * A delivery as the arrival on its row's `Changes`. A body that is not a
 * delivery, or an event about no entity this module describes, runs nothing.
 * Its parent is the row as the change left it (as it was, for a deletion), by
 * the columns the module reads a row by.
 */
export function changeArrivals(raw: unknown, catalog: ChangeCatalog): ValuationsChangeArrival[] {
  const parsed = deliverySchema.safeParse(raw);
  if (!parsed.success) return [];
  const { event, timestamp, data } = parsed.data;
  const [, table, operation] = event.split(':');
  const entity = table === undefined ? undefined : catalog.entityOfTable(table);
  const kind = operation === undefined ? undefined : KIND_OF_OPERATION[operation];
  if (entity === undefined || kind === undefined) return [];
  const fields = catalog.descriptorOf(entity).fields;
  const named = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(fields.flatMap((field) => (field.fieldId in row ? [[field.displayName, row[field.fieldId]]] : [])));
  const before = kind === 'created' ? null : (data.before ?? null);
  const after = kind === 'deleted' ? null : (data.after ?? null);
  const moved = (fieldId: string): boolean => {
    if (after === null) return false;
    const now = after[fieldId];
    if (before === null) return now !== null && now !== undefined;
    return JSON.stringify(before[fieldId]) !== JSON.stringify(now);
  };
  const changed = fields.filter((field) => moved(field.fieldId)).map((field) => field.displayName);
  const identity = [entity.table, data.id, kind, timestamp].join(':');
  const row = after ?? before;
  return [
    {
      edge: VALUATIONS_CHANGES_EDGE,
      key: data.id,
      identity,
      landing: {
        recordId: identity,
        recordType: changeTypeName(entity),
        fields: {
          Id: identity,
          Kind: kind,
          'Changed Fields': changed,
          'Record Id': data.id,
          ...(after !== null ? { Current: named(after) } : {}),
          ...(before !== null ? { Previous: named(before) } : {}),
        },
      },
      parents: [row === null ? null : { recordId: data.id, recordType: entity.displayName, fields: row }],
      about: { recordType: entity.displayName, externalId: data.id },
      occurredAt: timestamp,
    },
  ];
}
