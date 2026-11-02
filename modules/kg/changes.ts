// A record's `Changes`: what the graph's store says happened to one of a
// type's records (created, updated, deleted), as an arrival on that record's
// `Changes` edge. Each node type's changes land on a record type of their own
// (`Company Change`), so a listen on a company's changes is never fired by a
// person's.
//
// The store commits one change per record a write touched, and hands it to
// the host as an envelope — `{ id, event, timestamp, data }` — the same
// envelope whichever way it travels (in process, or a signed POST from a
// store in another process). Each change names the record it is about by the
// node type name a write names it by, and its id, so a run's own write that
// comes back is matched by the host's loop breaker.

import { z } from 'zod';

import type { Arrival, AwaitLanding } from 'engine-contracts';
import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
} from 'movement-engine/public/catalog';
import type { KgNode, WireOntology } from './store';

/** The edge every record hangs its changes off. */
export const KG_CHANGES_EDGE = 'Changes';
/** Its reference id: no ontology edge takes it (theirs are UUIDs). */
export const KG_CHANGES_REFERENCE = 'kg:changes';
/** A change's edge to the record as it is now. */
export const KG_CHANGE_RECORD_EDGE = 'Record';

export const KG_CHANGE_KINDS = ['created', 'updated', 'deleted'] as const;
export type KgChangeKind = (typeof KG_CHANGE_KINDS)[number];

/** The store's event names, which its webhook registration takes. */
export const KG_CHANGE_EVENTS: readonly string[] = KG_CHANGE_KINDS.map((kind) => `record.${kind}`);

/** An arrival on a record's `Changes`: a change, never a record gone (a
 *  deleted record's change is one). */
export type KgChangeArrival = Exclude<Arrival, { gone: true }>;

/** The record type a node type's changes land on (`Company Change`). */
export function changeTypeName(nodeTypeName: string): string {
  return `${nodeTypeName} Change`;
}

/** The node type whose change type is `typeName`, if any. A node type of that
 *  name is the node type, never a change type. */
export function nodeTypeOfChangeType(ontology: WireOntology, typeName: string | null): string | undefined {
  if (typeName === null || ontology.nodeTypes.some((nt) => nt.name === typeName)) return undefined;
  return ontology.nodeTypes.find((nt) => changeTypeName(nt.name) === typeName)?.name;
}

/** A change type's entry: named so the resolver knows it, listed by nothing. */
export function changeEntryPoint(nodeTypeName: string): SchemaEntryPoint {
  const typeId = changeTypeName(nodeTypeName);
  return { typeId, displayName: typeId, writable: false, readable: false };
}

/** A record's `Changes`: delivered to the connection, each change once. */
export function changesReference(nodeTypeName: string): SchemaReferenceDescriptor {
  return {
    fieldId: KG_CHANGES_REFERENCE,
    name: KG_CHANGES_EDGE,
    targetTypeId: changeTypeName(nodeTypeName),
    cardinality: 'many',
    direction: 'outgoing',
    // You are told of a change; you cannot list the ones that happened.
    readable: false,
    writable: false,
    listenable: true,
    delivery: 'connection',
    identity: 'Id',
    attributes: true,
    carries: [nodeTypeName],
    description:
      `What happens to a ${nodeTypeName} in the graph, each change once: created, updated (\`Changed Fields\` names what moved), deleted.`,
  };
}

/** The names a record of a type changes under: its properties, and its
 *  edges by the name each reads from this end. */
function changeableNames(ontology: WireOntology, nodeTypeId: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const pt of ontology.propertyTypes) {
    if (pt.nodeTypeId === nodeTypeId) names.set(pt.id, pt.name);
  }
  for (const et of ontology.edgeTypes) {
    if (et.sourceNodeTypeId === nodeTypeId) names.set(et.id, et.outboundName);
    else if (et.targetNodeTypeId === nodeTypeId) names.set(et.id, et.inboundName);
  }
  return names;
}

/** A node type's change type: what happened (`Kind`), what moved (`Changed
 *  Fields`), the record as the change left it (`Current`), and the record as
 *  it is now (`Record`, a read). */
export function describeChange(ontology: WireOntology, nodeTypeName: string): SchemaTypeDescriptor | null {
  const nodeType = ontology.nodeTypes.find((nt) => nt.name === nodeTypeName);
  if (nodeType === undefined) return null;
  const names = [...new Set(changeableNames(ontology, nodeType.id).values())];
  const field = (fieldId: string, kind: SchemaFieldDescriptor['kind'], more: Partial<SchemaFieldDescriptor>): SchemaFieldDescriptor => ({
    fieldId,
    displayName: fieldId,
    kind,
    writable: false,
    required: false,
    ...more,
  });
  return {
    typeId: changeTypeName(nodeTypeName),
    displayName: changeTypeName(nodeTypeName),
    description:
      `A change to a ${nodeTypeName} in the graph: what happened (\`Kind\`), which properties and edges moved (\`Changed Fields\`), ` +
      `and the record as the change left it (\`Current\`, absent once deleted; test it present before reading through it: ` +
      `\`exists(c.Current) AND c.Current.Status == "Open"\`). Walk \`Record\` for the record as it is now.`,
    fields: [
      field('Id', 'string', { required: true, description: 'Names the change: the same each time the graph reports it.' }),
      field('Kind', 'enum', { required: true, enumValues: [...KG_CHANGE_KINDS], description: 'What happened to the record.' }),
      field('Changed Fields', names.length > 0 ? 'enum' : 'string', {
        cardinality: 'many',
        ...(names.length > 0 ? { enumValues: names } : {}),
        description: 'The properties and edges the change moved, by name: every one a created record was given, none for a deleted one.',
      }),
      field('Record Id', 'string', { required: true, description: "The graph's id for the record, a deleted one's too." }),
      field('Current', 'record', {
        record: { typeId: nodeTypeName },
        mayBeAbsent: true,
        description: 'The record as the change left it, every property by name. Absent when it was deleted.',
      }),
    ],
    references: [
      {
        fieldId: KG_CHANGE_RECORD_EDGE,
        name: KG_CHANGE_RECORD_EDGE,
        targetTypeId: nodeTypeName,
        cardinality: 'one',
        direction: 'outgoing',
        readable: true,
        writable: false,
        requiresLiveRecord: true,
        description: 'The record as it is now, read from the graph: none once it is deleted.',
      },
    ],
  };
}

/** One change on its way out of the store. Parsed rather than trusted: a body
 *  is somebody else's claim until it typechecks. */
const changeEnvelopeSchema = z.object({
  /** The store's id for the change; absent on a change it kept before it
   *  named them. */
  id: z.string().optional(),
  event: z.enum(['record.created', 'record.updated', 'record.deleted']),
  timestamp: z.string(),
  data: z.object({
    recordId: z.string(),
    nodeTypeId: z.string(),
    changeKind: z.enum(['create', 'update', 'delete']),
    /** Property type ids whose value moved; edge type ids for links. */
    changedFields: z.array(z.string()),
    context: z.object({ occurredAt: z.string().optional() }).passthrough(),
  }),
});

const KIND_OF_CHANGE: Record<'create' | 'update' | 'delete', KgChangeKind> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
};

/** What turning a change into its arrival reads from the store. */
export interface ChangeSources {
  ontology(): Promise<WireOntology>;
  /** The record now; null when it is gone. */
  node(nodeId: string): Promise<KgNode | null>;
}

/**
 * The store's change as the arrival on its record's `Changes`, carrying the
 * record as the change left it (read when it is delivered, so a later change
 * already made shows too). A body that is not a change, or names a node type
 * the model no longer has, runs nothing.
 */
export async function changeArrivals(raw: unknown, sources: ChangeSources): Promise<KgChangeArrival[]> {
  const parsed = changeEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return [];
  const { id, timestamp, data } = parsed.data;
  const ontology = await sources.ontology();
  const nodeType = ontology.nodeTypes.find((nt) => nt.id === data.nodeTypeId);
  if (nodeType === undefined) return [];
  const kind = KIND_OF_CHANGE[data.changeKind];
  const node = kind === 'deleted' ? null : await sources.node(data.recordId);
  const current = node === null ? null : recordLanding(ontology, nodeType.name, node);
  const names = changeableNames(ontology, nodeType.id);
  const occurredAt = data.context.occurredAt ?? timestamp;
  // A change the store kept before it named them is named by what it says:
  // the record, what happened, when, and what moved.
  const identity = id ?? [data.recordId, kind, occurredAt, ...[...data.changedFields].sort()].join(':');
  const fields: Record<string, unknown> = {
    Id: identity,
    Kind: kind,
    'Changed Fields': data.changedFields.map((fieldId) => names.get(fieldId) ?? fieldId),
    'Record Id': data.recordId,
    ...(current !== null ? { Current: current.fields } : {}),
  };
  return [
    {
      edge: KG_CHANGES_EDGE,
      key: data.recordId,
      identity,
      landing: { recordId: identity, recordType: changeTypeName(nodeType.name), fields },
      parents: [current],
      about: { recordType: nodeType.name, externalId: data.recordId },
      occurredAt,
    },
  ];
}

/** A node as a listen's WHERE on its hop reads it: each property by name. */
function recordLanding(ontology: WireOntology, nodeTypeName: string, node: KgNode): AwaitLanding {
  const fields: Record<string, unknown> = {};
  for (const pt of ontology.propertyTypes) {
    if (pt.nodeTypeId !== node.nodeTypeId) continue;
    const value = node.properties[pt.id];
    if (value !== undefined) fields[pt.name] = value;
  }
  return { recordId: node.id, recordType: nodeTypeName, fields };
}
