import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type { ExtractionGraphId } from '../../generated/kysely/knowledge/ExtractionGraph';
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { PropertyId } from '../../generated/kysely/knowledge/Property';
import type { ResourceId } from '../../generated/kysely/knowledge/Resource';
import type NodeTypeCategory from '../../generated/kysely/knowledge/NodeTypeCategory';
import type PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';
import type PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';
import type EvaluationStrategy from '../../generated/kysely/knowledge/EvaluationStrategy';
import type EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import type { EdgeFilter } from '../../lib/knowledge/templates/types';
import type * as db from '@prisma/client';
import { z } from 'zod';

// -- Default property mappings: how an extraction graph node fills a property
// without extraction (a fixed value, an LLM prompt, or a field of the input) --

const inputPropertyMappingSchema = z.object({
  source: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('property'), fieldKey: z.string() }),
    z.object({ mode: z.literal('static'), value: z.string() }),
    z.object({ mode: z.literal('llm'), prompt: z.string() }),
  ]),
  traversal: z.array(z.object({ edgeTypeId: z.string() })).default([]),
  targetPropertyTypeId: z.string(),
});

type InputPropertyMapping = z.infer<typeof inputPropertyMappingSchema>;

// -- Segments (extraction input) --

type TextClassification =
  | 'CHAT_MESSAGE'
  | 'DOCUMENT'
  | 'EMAIL'
  | 'FRAGMENT'
  | 'LINKEDIN'
  | 'PITCH_DECK_URL'
  | 'WEBSITE'
  | 'WHATSAPP';

type Segment = db.Resource & {
  isFromTheInputPayloads: boolean;
  classification: TextClassification;
  content?: string;
};

// -- Extraction Tree (built from ontology) --

interface ExtractionTreePropertyDef {
  propertyTypeId: PropertyTypeId;
  name: string;
  description: string;
  valueType: PropertyValueType;
  identity: PropertyIdentity;
  evaluationStrategy: EvaluationStrategy;
  enumValues: string[] | null;
  extractionInstructions?: string | null;
}

interface ExtractionTreeNodeType {
  id: NodeTypeId;
  name: string;
  description: string;
  category: NodeTypeCategory;
}

interface ExtractionTreeEdgeType {
  id: EdgeTypeId;
  sourceNodeTypeId: NodeTypeId;
  targetNodeTypeId: NodeTypeId;
  outboundName: string;
  inboundName: string;
  description: string;
  required: boolean;
  scopes: boolean;
  filters: EdgeFilter[];
  propertyDefs: ExtractionTreePropertyDef[];
}

interface ExtractionTreeNode {
  nodeType: ExtractionTreeNodeType;
  edgeType: ExtractionTreeEdgeType;
  instructions: string | null;
  expand: boolean;
  propertyDefs: ExtractionTreePropertyDef[];
  defaultPropertyMappings: InputPropertyMapping[];
  children: ExtractionTreeNode[];
}

interface ExtractionTree {
  extractionGraphId: ExtractionGraphId;
  messageType: ExtractionTreeNodeType;
  messagePropertyDefs: ExtractionTreePropertyDef[];
  messageDefaultPropertyMappings: InputPropertyMapping[];
  children: ExtractionTreeNode[];
  // All property defs per node type (unfiltered by overrides), for input mapping resolution
  allPropertyDefsByNodeType: Map<string, ExtractionTreePropertyDef[]>;
}

// -- Extracted Subgraph (output of extraction, input to consolidation) --

interface ExtractedNode {
  tempId: string;
  nodeType: NodeTypeId;
  lineRefs?: [number, number][];
}

interface ExtractedProperty {
  tempId: string;
  propertyTypeId: PropertyTypeId;
  parentTempId: string;
  value: string | number | boolean | Date | unknown | null;
  evidenceDescription?: string | null;
  ownerEdgeKey?: string;
}

interface ExtractedEdge {
  sourceTempId: string;
  targetTempId: string;
  edgeType: EdgeTypeId;
}

interface ExtractedEvidence {
  targetPropertyTempId: string;
  resourceId: ResourceId | null;
  type: EvidenceType;
  description: string;
}

interface ExtractedEdgeEvidence {
  sourceTempId: string;
  targetTempId: string;
  edgeType: EdgeTypeId;
  resourceId: ResourceId | null;
  type: EvidenceType;
  description: string;
}

interface ExtractedNodeResource {
  targetTempId: string;
  resourceId: ResourceId;
  startOffset: number | null;
  endOffset: number | null;
}

interface ExtractedSubgraph {
  messageNode: ExtractedNode;
  nodes: ExtractedNode[];
  properties: ExtractedProperty[];
  edges: ExtractedEdge[];
  evidence: ExtractedEvidence[];
  edgeEvidence: ExtractedEdgeEvidence[];
  nodeResources: ExtractedNodeResource[];
}

// -- Consolidation (resolution decisions) --

type ResolutionDecision =
  | { action: 'create' }
  | { action: 'match'; existingNodeId: NodeId; confidence: number };

interface ChangesetNode extends ExtractedNode {
  resolution: ResolutionDecision;
}

interface ChangesetProperty extends ExtractedProperty {
  resolution: ResolutionDecision;
}

interface Changeset {
  messageNode: { tempId: string; nodeType: NodeTypeId };
  nodes: ChangesetNode[];
  properties: ChangesetProperty[];
  edges: ExtractedEdge[];
  evidence: ExtractedEvidence[];
  edgeEvidence: ExtractedEdgeEvidence[];
  nodeResources: ExtractedNodeResource[];
}

// -- Application Result --

interface ApplyResult {
  nodesCreated: NodeId[];
  nodesUpdated: NodeId[];
  propertiesUpdated: Map<NodeId, Set<PropertyTypeId>>;
  tempToRealId: Map<string, NodeId>;
}

// -- Pipeline context --

interface KnowledgePipelineInput {
  extractionGraphId: ExtractionGraphId;
  messageNodeTypeId: NodeTypeId;
  segments: Segment[];
}

export { inputPropertyMappingSchema };
export type {
  InputPropertyMapping,
  Segment,
  TextClassification,
  ExtractionTree,
  ExtractionTreeNode,
  ExtractionTreeNodeType,
  ExtractionTreeEdgeType,
  ExtractionTreePropertyDef,
  ExtractedNode,
  ExtractedProperty,
  ExtractedEdge,
  ExtractedEvidence,
  ExtractedEdgeEvidence,
  ExtractedNodeResource,
  ExtractedSubgraph,
  ResolutionDecision,
  ChangesetNode,
  ChangesetProperty,
  Changeset,
  ApplyResult,
  KnowledgePipelineInput,
};
