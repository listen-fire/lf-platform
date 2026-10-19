// The graph as the module reaches it: a store the HOST supplies.
//
// The module is the adapter half — translating a program's natural names
// (node types, properties, edges by display name) into the store's ids and
// back. Where the records live, how a write is made durable and how its
// change events are derived is the store's, and so the host's: the platform
// answers this interface from its own knowledge unit, scoped to one team and
// one connection before the module ever sees it. Nothing here names a team.
//
// The currency is IDS. Names ride along in the model for introspection and
// are never identity: a display name is renameable, and anything routed by
// name would silently stop matching after a rename.

import type { MutationContext, Resource } from 'movement-engine/public/adapter';

// ── The model ──────────────────────────────────────────────────────────────

/** OR-of-AND over field ids — the projected form of a node type's identity. */
export interface WireUniqueness {
  any: { all: { field: string; fuzzy?: boolean }[] }[];
}

export interface WireNodeType {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  displayNameTemplate: string | null;
  displayNameExpression: string | null;
  uniquenessConstraints: WireUniqueness;
}

export interface WirePropertyType {
  id: string;
  name: string;
  description: string | null;
  nodeTypeId: string | null;
  edgeTypeId: string | null;
  /** `text` | `number` | `date` | `boolean` | `json` (the store's value types). */
  valueType: string;
  /** `single` | `multi`. */
  cardinality: string;
  enumValues: string[] | null;
  writableBy: string[] | null;
  evaluationStrategy: string | null;
}

export interface WireEdgeType {
  id: string;
  outboundName: string;
  inboundName: string;
  sourceNodeTypeId: string;
  targetNodeTypeId: string;
  required: boolean | null;
  scopes: boolean | null;
  filters: unknown;
}

export interface WireOntology {
  nodeTypes: WireNodeType[];
  propertyTypes: WirePropertyType[];
  edgeTypes: WireEdgeType[];
}

// ── Reads ──────────────────────────────────────────────────────────────────

export interface KgNode {
  id: string;
  nodeTypeId: string;
  /** Canonical values by property type id. */
  properties: Record<string, unknown>;
}

export interface KgCandidate {
  nodeId: string;
  /** Property values by property type id. */
  data: Record<string, unknown>;
  /** The candidate's neighbours, by natural edge name: what an identity judge
   *  disambiguates on besides properties. */
  relationships: { edgeName: string; targetName: string; edgeProperties?: Record<string, unknown> }[];
}

export interface KgEdgeRow {
  edgeId: string;
  otherNodeId: string;
  otherNodeTypeId: string;
  /** Edge-anchored property values by property type id. */
  properties: Record<string, unknown>;
}

// ── Writes ─────────────────────────────────────────────────────────────────

export interface KgPropertyWrite {
  propertyTypeId: string;
  value: unknown;
  /** The quote that justified the value, kept as its evidence. */
  description?: string;
}

/** Every write carries the program's provenance verbatim: `suppress_self`
 *  answers itself from it when the change comes back as an event. */
export interface KgWriteProvenance {
  mutationContext: MutationContext;
}

// ── The store ──────────────────────────────────────────────────────────────

export interface KgStore {
  /** The team's whole model. Fetched once per adapter instance and projected
   *  for every schema question. */
  ontology(): Promise<WireOntology>;

  /** The node type of each of these nodes that exists. */
  nodeTypesOf(nodeIds: string[]): Promise<{ id: string; nodeTypeId: string }[]>;
  /** Nodes of `nodeTypeId` whose identity the record's values match (the
   *  type's own uniqueness constraints), with their adjacency. */
  matchNodes(input: { nodeTypeId: string; record: Record<string, unknown> }): Promise<KgCandidate[]>;
  /** One node, or null when there is no such node. */
  getNode(nodeId: string): Promise<KgNode | null>;
  /** One page of a type's node ids, newest first (created, then id). */
  listNodeIds(input: { nodeTypeId: string; limit: number; offset: number }): Promise<string[]>;
  /** The edges of one type at one end of a node. */
  edgesOf(input: { nodeId: string; edgeTypeId: string; direction: 'in' | 'out' }): Promise<KgEdgeRow[]>;
  /** The resources attached to a node. */
  resourcesOf(nodeId: string): Promise<Resource[]>;

  /** A node with its properties and edges, in one transaction. `bridge` names
   *  the external record it was created from, so the next event for that
   *  record resolves back to this node. */
  createNode(
    input: KgWriteProvenance & {
      nodeTypeId: string;
      properties: KgPropertyWrite[];
      edges: { edgeTypeId: string; otherNodeId: string; direction: 'in' | 'out' }[];
      bridge?: { adapterType: string; externalId: string; externalObjectType?: string };
    },
  ): Promise<{ nodeId: string }>;
  /** Set properties on a node; null when the node does not exist. */
  updateNode(input: KgWriteProvenance & { nodeId: string; properties: KgPropertyWrite[] }): Promise<{ nodeId: string } | null>;
  /** Assert an edge, idempotently: `created` is false when it was there. */
  assertEdge(
    input: KgWriteProvenance & { edgeTypeId: string; sourceNodeId: string; targetNodeId: string },
  ): Promise<{ edgeId: string; created: boolean }>;
  /** Set properties on an edge. */
  updateEdge(input: KgWriteProvenance & { edgeId: string; properties: KgPropertyWrite[] }): Promise<void>;
  /** Sever an edge, idempotently. */
  removeEdge(
    input: KgWriteProvenance & { edgeTypeId: string; sourceNodeId: string; targetNodeId: string },
  ): Promise<{ removed: boolean }>;
  /** Delete a node and everything hanging off it; false when it was gone. */
  removeNode(input: KgWriteProvenance & { nodeId: string }): Promise<{ removed: boolean }>;
  /** Attach resources to a node (and the facts read from each), idempotently. */
  attachResources(input: { nodeId: string; resources: Resource[] }): Promise<void>;

  /** Have the store POST its change events to `targetUrl` (a deployment
   *  whose events cross a network). Idempotent by URL; the store issues the
   *  secret it signs with. Null when there is no connection to register with
   *  (nothing is registered, and nothing will fire). */
  registerChangeWebhook(input: { targetUrl: string; eventTypes: string[] }): Promise<{ externalId: string; secret: string } | null>;
  removeChangeWebhook(input: { externalId: string }): Promise<void>;
}
