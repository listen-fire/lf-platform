import { trpc } from '../../trpc';
import { ontologyRouter } from './ontology';
import { graphRouter } from './graph';
import { recipeRouter } from './recipe';
import { cypherAgentRouter } from './cypherAgent';
import { decidesEach, type Decision } from '../../../access_route';

const knowledgeRouter = (procedure: typeof trpc.procedure) =>
  trpc.router({
    ontology: ontologyRouter(procedure),
    graph: graphRouter(procedure),
    recipe: recipeRouter(procedure),
    cypherAgent: cypherAgentRouter(procedure),
  });

const EXEMPTION: Decision = { exempt: 'the knowledge graph, no automation' };

decidesEach('knowledge.ontology', {
  onResourceChange: EXEMPTION,
  getNodeTypes: EXEMPTION,
  getNodeType: EXEMPTION,
  createNodeType: EXEMPTION,
  updateNodeType: EXEMPTION,
  deleteNodeType: EXEMPTION,
  getPropertyTypes: EXEMPTION,
  createPropertyType: EXEMPTION,
  updatePropertyType: EXEMPTION,
  deletePropertyType: EXEMPTION,
  reorderPropertyTypes: EXEMPTION,
  getEdgeTypes: EXEMPTION,
  getEdgeType: EXEMPTION,
  createEdgeType: EXEMPTION,
  updateEdgeType: EXEMPTION,
  deleteEdgeType: EXEMPTION,
  createEdgeGroup: EXEMPTION,
  updateEdgeGroup: EXEMPTION,
  deleteEdgeGroup: EXEMPTION,
  getOntologySummary: EXEMPTION,
  getTemplates: EXEMPTION,
  materializeTemplate: EXEMPTION,
  generateNodeIcon: EXEMPTION,
});
decidesEach('knowledge.graph', {
  getNodes: EXEMPTION,
  getNodesTable: EXEMPTION,
  parseNaturalLanguageFilter: EXEMPTION,
  saveFilter: EXEMPTION,
  getFilter: EXEMPTION,
  getNode: EXEMPTION,
  getPropertyEvidence: EXEMPTION,
  getNodeEvidence: EXEMPTION,
  getEdgeEvidence: EXEMPTION,
  getEvidenceSource: EXEMPTION,
  getNodeChanges: EXEMPTION,
  getEdgeChanges: EXEMPTION,
  getPropertyTimeline: EXEMPTION,
  createUserEdit: EXEMPTION,
  regeneratePropertyValue: EXEMPTION,
  createProperty: EXEMPTION,
  createNode: EXEMPTION,
  deleteNode: EXEMPTION,
  createEdge: EXEMPTION,
  deleteEdge: EXEMPTION,
  bulkDeleteNodes: EXEMPTION,
  bulkUpdateProperty: EXEMPTION,
  getEdgeTypesForNode: EXEMPTION,
  searchNodes: EXEMPTION,
  mergeNodes: EXEMPTION,
  getLinkedObjects: EXEMPTION,
  createManualLinkedObject: EXEMPTION,
  deleteLinkedObject: EXEMPTION,
  getLinkedResources: EXEMPTION,
  getEdge: EXEMPTION,
  createEdgeProperty: EXEMPTION,
  updateEdgeTarget: EXEMPTION,
  mergeEdge: EXEMPTION,
  getNodeDisplayNames: EXEMPTION,
  globalSearch: EXEMPTION,
});
decidesEach('knowledge.recipe', {
  list: EXEMPTION,
  get: EXEMPTION,
  create: EXEMPTION,
  update: EXEMPTION,
  delete: EXEMPTION,
});
decidesEach('knowledge.cypherAgent', {
  generate: EXEMPTION,
  getSchemaForDisplay: EXEMPTION,
  execute: EXEMPTION,
});

export { knowledgeRouter };
