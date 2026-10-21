// The knowledge model's editing operations, addressed by NAME (entity type,
// field, relationship) rather than id. The MCP model tools and their REST
// routes call these; internal ids never appear in their arguments or results.

import type { StoredUniquenessConstraints, ConstraintEntry } from './uniqueness_constraints';
import type { Expression, EdgeStep } from 'movement-lang/expression/types';

import { getKnowledgeQb } from '../kysely';
import { TeamId } from '../../generated/kysely/core/Team';
import { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import NodeTypeCategory from '../../generated/kysely/knowledge/NodeTypeCategory';
import PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';
import PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';
import EvaluationStrategy from '../../generated/kysely/knowledge/EvaluationStrategy';
import { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import { parseConstraintText, serializeConstraintEntries } from './uniqueness_constraints';
import { unsupportedCategoryReason } from './node_type_category_policy';

// Tool: Get current ontology
async function getOntology(teamId: string) {
  const [nodeTypes, propertyTypes, edgeTypes] = await Promise.all([
    getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name', 'description', 'category', 'uniqueness_constraints'])
      .orderBy('name asc')
      .execute(),
    getKnowledgeQb(['property_type', 'node_type', 'edge_type'])
      .selectFrom('property_type as pt')
      .leftJoin('node_type as nt', 'nt.id', 'pt.node_type_id')
      .leftJoin('edge_type as et', 'et.id', 'pt.edge_type_id')
      .where('pt.team_id', '=', teamId as TeamId)
      .select([
        'pt.id',
        'pt.name',
        'pt.description',
        'pt.node_type_id',
        'nt.name as node_type_name',
        'pt.edge_type_id',
        'et.outbound_name as edge_type_name',
        'pt.value_type',
        'pt.evaluation_strategy',
        'pt.enum_values',
      ])
      .orderBy('nt.name asc')
      .execute(),
    getKnowledgeQb(['edge_type', 'node_type'])
      .selectFrom('edge_type as et')
      .leftJoin('node_type as snt', 'snt.id', 'et.source_node_type_id')
      .leftJoin('node_type as tnt', 'tnt.id', 'et.target_node_type_id')
      .where('et.team_id', '=', teamId as TeamId)
      .select([
        'et.id',
        'et.outbound_name',
        'et.inbound_name',
        'et.description',
        'snt.name as source_name',
        'tnt.name as target_name',
        'et.required',
        'et.scopes',
        'et.filters',
      ])
      .orderBy('et.outbound_name asc')
      .execute(),
  ]);

  if (nodeTypes.length === 0) {
    return 'No ontology defined yet. You can start from scratch or use a template.';
  }

  // Build lookup maps for serializing constraints to human-readable text
  const propIdToName = new Map<string, string>();
  for (const pt of propertyTypes) propIdToName.set(pt.id as string, pt.name);

  const edgeIdToTargetName = new Map<string, string>();
  for (const et of edgeTypes) {
    edgeIdToTargetName.set(et.id as string, et.target_name ?? '?');
    // Also store source name for incoming edges
  }
  const edgeIdToSourceName = new Map<string, string>();
  for (const et of edgeTypes) edgeIdToSourceName.set(et.id as string, et.source_name ?? '?');

  const enrichedNodeTypes = nodeTypes.map((nt) => {
    const raw = nt.uniqueness_constraints as StoredUniquenessConstraints | null;
    if (!raw?.length) return { ...nt, uniqueness_constraints: undefined, uniquenessConstraintExpressions: null };

    const expressions = raw.map((constraint) =>
      serializeConstraintEntries(constraint, propIdToName, edgeIdToTargetName, edgeIdToSourceName),
    );
    return { ...nt, uniqueness_constraints: undefined, uniquenessConstraintExpressions: expressions };
  });

  return { nodeTypes: enrichedNodeTypes, propertyTypes, edgeTypes };
}

// Tool: Create a node type
async function createNodeType(
  args: {
    name: string;
    description: string;
    category: string;
  },
  teamId: string,
) {
  const reason = unsupportedCategoryReason(args.category);
  if (reason) throw new Error(reason);

  const nodeType = await getKnowledgeQb(['node_type'])
    .insertInto('node_type')
    .values({
      team_id: teamId as TeamId,
      name: args.name,
      description: args.description || '',
      category: args.category as NodeTypeCategory,
    })
    .returning(['id', 'name', 'category'])
    .executeTakeFirstOrThrow();

  return nodeType;
}

// Tool: Create a property type on a node type or edge type
async function createPropertyType(
  args: {
    nodeTypeId?: string;
    edgeTypeId?: string;
    name: string;
    description: string;
    valueType: string;
    evaluationStrategy?: string;
    enumValues?: string[];
  },
  teamId: string,
) {
  if (!args.nodeTypeId && !args.edgeTypeId) {
    throw new Error('Either nodeTypeId or edgeTypeId must be provided');
  }

  // Append at the bottom of the owner's property list (max sort_order + 1),
  // mirroring the editor's create path. Without this, inserts here
  // defaulted to sort_order 0 and sorted to the TOP of the list.
  let maxQuery = getKnowledgeQb(['property_type'])
    .selectFrom('property_type')
    .select(({ fn }) => fn.max('sort_order').as('max_order'))
    .where('team_id', '=', teamId as TeamId);
  maxQuery = args.nodeTypeId
    ? maxQuery.where('node_type_id', '=', args.nodeTypeId as NodeTypeId)
    : maxQuery.where('edge_type_id', '=', args.edgeTypeId as EdgeTypeId);
  const maxResult = await maxQuery.executeTakeFirst();
  const nextOrder = ((maxResult?.max_order as number | null) ?? -1) + 1;

  const propertyType = await getKnowledgeQb(['property_type'])
    .insertInto('property_type')
    .values({
      team_id: teamId as TeamId,
      sort_order: nextOrder,
      node_type_id: args.nodeTypeId ? (args.nodeTypeId as NodeTypeId) : undefined,
      edge_type_id: args.edgeTypeId ? (args.edgeTypeId as EdgeTypeId) : undefined,
      name: args.name,
      description: args.description || '',
      value_type: (args.valueType as PropertyValueType) ?? PropertyValueType.text,
      // Legacy column (superseded by uniqueness constraints, ignored by
      // every current consumer) — 'none' so nothing downstream can read
      // meaning into it.
      identity: PropertyIdentity.none,
      evaluation_strategy:
        (args.evaluationStrategy as EvaluationStrategy) ?? EvaluationStrategy.latest,
      enum_values: args.enumValues ?? null,
    })
    .returning(['id', 'name', 'node_type_id', 'edge_type_id'])
    .executeTakeFirstOrThrow();

  return propertyType;
}

// Tool: Create an edge type
async function createEdgeType(
  args: {
    outboundName: string;
    inboundName: string;
    description: string;
    sourceNodeTypeId: string;
    targetNodeTypeId: string;
    required?: boolean;
    scopes?: boolean;
    group?: string;
    filters?: { side: string; property: string; value: string }[];
  },
  teamId: string,
) {
  const edgeType = await getKnowledgeQb(['edge_type'])
    .insertInto('edge_type')
    .values({
      team_id: teamId as TeamId,
      outbound_name: args.outboundName,
      inbound_name: args.inboundName,
      description: args.description || '',
      source_node_type_id: args.sourceNodeTypeId as NodeTypeId,
      target_node_type_id: args.targetNodeTypeId as NodeTypeId,
      required: args.required ?? false,
      scopes: args.scopes ?? false,
      filters: JSON.stringify(args.filters ?? []),
      edge_group: args.group ?? null,
    })
    .returning(['id', 'outbound_name', 'inbound_name'])
    .executeTakeFirstOrThrow();

  return edgeType;
}

// Tool: Update a node type
async function updateNodeType(
  args: { id: string; name?: string; description?: string; category?: string },
  teamId: string,
) {
  if (args.category !== undefined) {
    const reason = unsupportedCategoryReason(args.category);
    if (reason) throw new Error(reason);
  }

  const values: Record<string, unknown> = {};
  if (args.name !== undefined) values.name = args.name;
  if (args.description !== undefined) values.description = args.description;
  if (args.category !== undefined) values.category = args.category as NodeTypeCategory;
  if (Object.keys(values).length === 0) throw new Error('No fields to update');

  const result = await getKnowledgeQb(['node_type'])
    .updateTable('node_type')
    .set(values)
    .where('id', '=', args.id as NodeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .returning(['id', 'name', 'category'])
    .executeTakeFirstOrThrow();
  return result;
}

// Tool: Update a property type
async function updatePropertyType(
  args: {
    id: string;
    name?: string;
    description?: string;
    valueType?: string;
    evaluationStrategy?: string;
    enumValues?: string[] | null;
  },
  teamId: string,
) {
  const values: Record<string, unknown> = {};
  if (args.name !== undefined) values.name = args.name;
  if (args.description !== undefined) values.description = args.description;
  if (args.valueType !== undefined) values.value_type = args.valueType as PropertyValueType;
  if (args.evaluationStrategy !== undefined)
    values.evaluation_strategy = args.evaluationStrategy as EvaluationStrategy;
  if (args.enumValues !== undefined) values.enum_values = args.enumValues;
  if (Object.keys(values).length === 0) throw new Error('No fields to update');

  const result = await getKnowledgeQb(['property_type'])
    .updateTable('property_type')
    .set(values)
    .where('id', '=', args.id as PropertyTypeId)
    .where('team_id', '=', teamId as TeamId)
    .returning(['id', 'name', 'node_type_id', 'edge_type_id'])
    .executeTakeFirstOrThrow();
  return result;
}

// Tool: Update an edge type
async function updateEdgeType(
  args: {
    id: string;
    outboundName?: string;
    inboundName?: string;
    description?: string;
    required?: boolean;
    scopes?: boolean;
    group?: string | null;
    filters?: { side: string; property: string; value: string }[];
  },
  teamId: string,
) {
  const values: Record<string, unknown> = {};
  if (args.outboundName !== undefined) values.outbound_name = args.outboundName;
  if (args.inboundName !== undefined) values.inbound_name = args.inboundName;
  if (args.description !== undefined) values.description = args.description;
  if (args.required !== undefined) values.required = args.required;
  if (args.scopes !== undefined) values.scopes = args.scopes;
  if (args.group !== undefined) values.edge_group = args.group;
  if (args.filters !== undefined) values.filters = JSON.stringify(args.filters);
  if (Object.keys(values).length === 0) throw new Error('No fields to update');

  const result = await getKnowledgeQb(['edge_type'])
    .updateTable('edge_type')
    .set(values)
    .where('id', '=', args.id as EdgeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .returning(['id', 'outbound_name', 'inbound_name'])
    .executeTakeFirstOrThrow();
  return result;
}

// Tool: Delete a node type (cascades to properties and edges)
async function deleteNodeType(args: { id: string }, teamId: string) {
  await getKnowledgeQb(['node_type'])
    .deleteFrom('node_type')
    .where('id', '=', args.id as NodeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .executeTakeFirstOrThrow();
  return { deleted: true, id: args.id };
}

// Tool: Delete a property type
async function deletePropertyType(args: { id: string }, teamId: string) {
  await getKnowledgeQb(['property_type'])
    .deleteFrom('property_type')
    .where('id', '=', args.id as PropertyTypeId)
    .where('team_id', '=', teamId as TeamId)
    .executeTakeFirstOrThrow();
  return { deleted: true, id: args.id };
}

// Tool: Delete an edge type (cascades to edge properties)
async function deleteEdgeType(args: { id: string }, teamId: string) {
  await getKnowledgeQb(['edge_type'])
    .deleteFrom('edge_type')
    .where('id', '=', args.id as EdgeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .executeTakeFirstOrThrow();
  return { deleted: true, id: args.id };
}

// Tool: Set uniqueness constraints on a node type
async function setUniquenessConstraints(
  args: { nodeTypeId: string; constraints: string[] },
  teamId: string,
) {
  // Load context: properties for this node type, edges touching it, all node type names
  const [properties, edges, allNodeTypes] = await Promise.all([
    getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('node_type_id', '=', args.nodeTypeId as NodeTypeId)
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name'])
      .execute(),
    getKnowledgeQb(['edge_type'])
      .selectFrom('edge_type')
      .where('team_id', '=', teamId as TeamId)
      .where((eb: any) =>
        eb.or([
          eb('source_node_type_id', '=', args.nodeTypeId as NodeTypeId),
          eb('target_node_type_id', '=', args.nodeTypeId as NodeTypeId),
        ]),
      )
      .select(['id', 'source_node_type_id', 'target_node_type_id'])
      .execute(),
    getKnowledgeQb(['node_type'])
      .selectFrom('node_type')
      .where('team_id', '=', teamId as TeamId)
      .select(['id', 'name'])
      .execute(),
  ]);

  const propertyByName = new Map<string, string>();
  for (const p of properties) propertyByName.set(p.name.toLowerCase(), p.id as string);

  const nodeTypeNameById = new Map<string, string>();
  for (const nt of allNodeTypes) nodeTypeNameById.set(nt.id as string, nt.name);

  // Build edge lookup by connected node type name
  const edgeByNodeTypeName = new Map<string, { id: string; direction: 'outgoing' | 'incoming' }>();
  for (const et of edges) {
    if ((et.source_node_type_id as string) === args.nodeTypeId) {
      const name = nodeTypeNameById.get(et.target_node_type_id as string);
      if (name) edgeByNodeTypeName.set(name.toLowerCase(), { id: et.id as string, direction: 'outgoing' });
    } else {
      const name = nodeTypeNameById.get(et.source_node_type_id as string);
      if (name && !edgeByNodeTypeName.has(name.toLowerCase())) {
        edgeByNodeTypeName.set(name.toLowerCase(), { id: et.id as string, direction: 'incoming' });
      }
    }
  }

  // Parse each constraint expression
  const parsed: ConstraintEntry[][] = [];
  for (const text of args.constraints) {
    if (!text.trim()) continue;
    const result = parseConstraintText(text, propertyByName, edgeByNodeTypeName);
    if (!result.ok) {
      return { error: result.error, constraint: text };
    }
    parsed.push(result.entries!);
  }

  // Store
  const value = parsed.length > 0 ? JSON.stringify(parsed) : null;
  await getKnowledgeQb(['node_type'])
    .updateTable('node_type')
    .set({ uniqueness_constraints: value })
    .where('id', '=', args.nodeTypeId as NodeTypeId)
    .where('team_id', '=', teamId as TeamId)
    .execute();

  return {
    nodeTypeId: args.nodeTypeId,
    constraintCount: parsed.length,
    constraints: args.constraints.filter((t) => t.trim()),
  };
}

async function resolveNodeTypeIdByName(
  name: string,
  teamId: string,
): Promise<string | null> {
  const row = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('team_id', '=', teamId as TeamId)
    .where('name', '=', name)
    .select('id')
    .executeTakeFirst();
  return row ? (row.id as unknown as string) : null;
}

async function resolveEdgeTypeIdByOutboundName(
  outboundName: string,
  teamId: string,
): Promise<string | null> {
  const row = await getKnowledgeQb(['edge_type'])
    .selectFrom('edge_type')
    .where('team_id', '=', teamId as TeamId)
    .where('outbound_name', '=', outboundName)
    .select('id')
    .executeTakeFirst();
  return row ? (row.id as unknown as string) : null;
}

async function resolvePropertyTypeIdByName(args: {
  name: string;
  nodeTypeName?: string;
  edgeTypeOutboundName?: string;
  teamId: string;
}): Promise<string | null> {
  if (args.nodeTypeName) {
    const nodeTypeId = await resolveNodeTypeIdByName(args.nodeTypeName, args.teamId);
    if (!nodeTypeId) return null;
    const row = await getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('team_id', '=', args.teamId as TeamId)
      .where('node_type_id', '=', nodeTypeId as NodeTypeId)
      .where('name', '=', args.name)
      .select('id')
      .executeTakeFirst();
    return row ? (row.id as unknown as string) : null;
  }
  if (args.edgeTypeOutboundName) {
    const edgeTypeId = await resolveEdgeTypeIdByOutboundName(
      args.edgeTypeOutboundName,
      args.teamId,
    );
    if (!edgeTypeId) return null;
    const row = await getKnowledgeQb(['property_type'])
      .selectFrom('property_type')
      .where('team_id', '=', args.teamId as TeamId)
      .where('edge_type_id', '=', edgeTypeId as EdgeTypeId)
      .where('name', '=', args.name)
      .select('id')
      .executeTakeFirst();
    return row ? (row.id as unknown as string) : null;
  }
  return null;
}

/** Strip database id columns from a record before it leaves the server. */
function stripIds<T extends Record<string, unknown>>(row: T): Omit<T, 'id' | 'node_type_id' | 'edge_type_id'> {
  const { id: _id, node_type_id: _ntid, edge_type_id: _etid, ...rest } = row as any;
  return rest;
}

function createOntologyTools(teamId: string) {
  return {
    getOntology: async () => {
      const result = await getOntology(teamId);
      if (typeof result === 'string') return result;
      // Strip all ids — callers operate entirely on names downstream.
      return {
        nodeTypes: result.nodeTypes.map((nt) => stripIds(nt)),
        propertyTypes: result.propertyTypes.map((pt) => stripIds(pt)),
        edgeTypes: result.edgeTypes.map((et) => stripIds(et)),
      };
    },
    createNodeType: async (args: any) => {
      try {
        const result = await createNodeType(args, teamId);
        return { name: result.name, category: result.category };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `createNodeType failed for ${args.name}:`,
          errMsg,
          'args:',
          JSON.stringify(args),
        );
        return { error: errMsg };
      }
    },
    createPropertyType: async (args: any) => {
      try {
        if (!args.nodeTypeName && !args.edgeTypeOutboundName) {
          return {
            error:
              'Provide either `nodeTypeName` (for an entity field) or `edgeTypeOutboundName` (for a relationship field).',
          };
        }
        const nodeTypeId = args.nodeTypeName
          ? await resolveNodeTypeIdByName(args.nodeTypeName, teamId)
          : undefined;
        if (args.nodeTypeName && !nodeTypeId) {
          return { error: `No entity type named '${args.nodeTypeName}' was found.` };
        }
        const edgeTypeId = args.edgeTypeOutboundName
          ? await resolveEdgeTypeIdByOutboundName(args.edgeTypeOutboundName, teamId)
          : undefined;
        if (args.edgeTypeOutboundName && !edgeTypeId) {
          return {
            error: `No relationship with outbound name '${args.edgeTypeOutboundName}' was found.`,
          };
        }
        const result = await createPropertyType(
          {
            nodeTypeId: nodeTypeId ?? undefined,
            edgeTypeId: edgeTypeId ?? undefined,
            name: args.name,
            description: args.description,
            valueType: args.valueType,
            evaluationStrategy: args.evaluationStrategy,
            enumValues: args.enumValues,
          },
          teamId,
        );
        return { name: result.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`createPropertyType failed for ${args.name}:`, errMsg);
        return { error: errMsg };
      }
    },
    createEdgeType: async (args: any) => {
      try {
        const sourceNodeTypeId = await resolveNodeTypeIdByName(
          args.sourceNodeTypeName,
          teamId,
        );
        if (!sourceNodeTypeId) {
          return { error: `No entity type named '${args.sourceNodeTypeName}' was found (source).` };
        }
        const targetNodeTypeId = await resolveNodeTypeIdByName(
          args.targetNodeTypeName,
          teamId,
        );
        if (!targetNodeTypeId) {
          return { error: `No entity type named '${args.targetNodeTypeName}' was found (target).` };
        }
        const result = await createEdgeType(
          {
            outboundName: args.outboundName,
            inboundName: args.inboundName,
            description: args.description,
            sourceNodeTypeId,
            targetNodeTypeId,
            required: args.required,
            scopes: args.scopes,
            group: args.group,
            filters: args.filters,
          },
          teamId,
        );
        return { outboundName: result.outbound_name, inboundName: result.inbound_name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`createEdgeType failed for ${args.outboundName}:`, errMsg);
        return { error: errMsg };
      }
    },
    updateNodeType: async (args: any) => {
      try {
        const id = await resolveNodeTypeIdByName(args.name, teamId);
        if (!id) return { error: `No entity type named '${args.name}' was found.` };
        const result = await updateNodeType(
          {
            id,
            ...(args.newName !== undefined ? { name: args.newName } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.category !== undefined ? { category: args.category } : {}),
          },
          teamId,
        );
        return { name: result.name, category: result.category };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`updateNodeType failed:`, errMsg);
        return { error: errMsg };
      }
    },
    updatePropertyType: async (args: any) => {
      try {
        const id = await resolvePropertyTypeIdByName({
          name: args.name,
          nodeTypeName: args.nodeTypeName,
          edgeTypeOutboundName: args.edgeTypeOutboundName,
          teamId,
        });
        if (!id) {
          return {
            error: `No field named '${args.name}' was found on the specified entity / relationship.`,
          };
        }
        const result = await updatePropertyType(
          {
            id,
            ...(args.newName !== undefined ? { name: args.newName } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.valueType !== undefined ? { valueType: args.valueType } : {}),
            ...(args.evaluationStrategy !== undefined
              ? { evaluationStrategy: args.evaluationStrategy }
              : {}),
            ...(args.enumValues !== undefined ? { enumValues: args.enumValues } : {}),
          },
          teamId,
        );
        return { name: result.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`updatePropertyType failed:`, errMsg);
        return { error: errMsg };
      }
    },
    updateEdgeType: async (args: any) => {
      try {
        const id = await resolveEdgeTypeIdByOutboundName(args.outboundName, teamId);
        if (!id) {
          return {
            error: `No relationship with outbound name '${args.outboundName}' was found.`,
          };
        }
        const result = await updateEdgeType(
          {
            id,
            ...(args.newOutboundName !== undefined ? { outboundName: args.newOutboundName } : {}),
            ...(args.inboundName !== undefined ? { inboundName: args.inboundName } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.required !== undefined ? { required: args.required } : {}),
            ...(args.scopes !== undefined ? { scopes: args.scopes } : {}),
            ...(args.group !== undefined ? { group: args.group } : {}),
            ...(args.filters !== undefined ? { filters: args.filters } : {}),
          },
          teamId,
        );
        return { outboundName: result.outbound_name, inboundName: result.inbound_name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`updateEdgeType failed:`, errMsg);
        return { error: errMsg };
      }
    },
    deleteNodeType: async (args: any) => {
      try {
        const id = await resolveNodeTypeIdByName(args.name, teamId);
        if (!id) return { error: `No entity type named '${args.name}' was found.` };
        await deleteNodeType({ id }, teamId);
        return { deleted: true, name: args.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`deleteNodeType failed:`, errMsg);
        return { error: errMsg };
      }
    },
    deletePropertyType: async (args: any) => {
      try {
        const id = await resolvePropertyTypeIdByName({
          name: args.name,
          nodeTypeName: args.nodeTypeName,
          edgeTypeOutboundName: args.edgeTypeOutboundName,
          teamId,
        });
        if (!id) {
          return {
            error: `No field named '${args.name}' was found on the specified entity / relationship.`,
          };
        }
        await deletePropertyType({ id }, teamId);
        return { deleted: true, name: args.name };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`deletePropertyType failed:`, errMsg);
        return { error: errMsg };
      }
    },
    deleteEdgeType: async (args: any) => {
      try {
        const id = await resolveEdgeTypeIdByOutboundName(args.outboundName, teamId);
        if (!id) {
          return {
            error: `No relationship with outbound name '${args.outboundName}' was found.`,
          };
        }
        await deleteEdgeType({ id }, teamId);
        return { deleted: true, outboundName: args.outboundName };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`deleteEdgeType failed:`, errMsg);
        return { error: errMsg };
      }
    },
    setUniquenessConstraints: async (args: any) => {
      try {
        const nodeTypeId = await resolveNodeTypeIdByName(args.nodeTypeName, teamId);
        if (!nodeTypeId) {
          return { error: `No entity type named '${args.nodeTypeName}' was found.` };
        }
        const result = await setUniquenessConstraints(
          { nodeTypeId, constraints: args.constraints },
          teamId,
        );
        if ('error' in result) {
          return { error: result.error, constraint: (result as any).constraint };
        }
        return {
          nodeTypeName: args.nodeTypeName,
          constraintCount: result.constraintCount,
          constraints: result.constraints,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`setUniquenessConstraints failed:`, errMsg);
        return { error: errMsg };
      }
    },
  };
}

export { createOntologyTools };
