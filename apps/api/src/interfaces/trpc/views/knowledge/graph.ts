import { z } from 'zod';
import { sql } from 'kysely';

import { getCoreQb, getKnowledgeQb, getQb } from '../../../../lib/kysely';
import { currentContext } from '../../../../services/context';
import { trpc } from '../../trpc';
import { TeamId } from '../../../../generated/kysely/core/Team';
import { NodeTypeId } from '../../../../generated/kysely/knowledge/NodeType';
import { NodeId } from '../../../../generated/kysely/knowledge/Node';
import { EdgeId } from '../../../../generated/kysely/knowledge/Edge';
import { EdgeTypeId } from '../../../../generated/kysely/knowledge/EdgeType';
import { PropertyId } from '../../../../generated/kysely/knowledge/Property';
import { PropertyTypeId } from '../../../../generated/kysely/knowledge/PropertyType';
import EvidenceType from '../../../../generated/kysely/knowledge/EvidenceType';
import PropertyIdentity from '../../../../generated/kysely/knowledge/PropertyIdentity';
import PropertyValueType from '../../../../generated/kysely/knowledge/PropertyValueType';
import { resolveDisplayNames } from '../../../../lib/knowledge/resolve_display_name';
import { collectEdgeTypeIds, isEdgeToEntry, type StoredUniquenessConstraints } from '../../../../services/knowledge_pipeline/uniqueness_constraints';
import { mergeEdges, mergeNodes, reEvaluateProperty } from '../../../../lib/knowledge/merge';
import {
  createNode as createStoreNode,
  deleteEdge as deleteStoreEdge,
  deleteNode as deleteStoreNode,
  deleteNodes as deleteStoreNodes,
  link as linkStoreNodes,
  openKnowledgeStore,
  retargetEdge,
  setProperties,
  type PropertyWrite,
  type WriteContext,
} from '../../../../lib/knowledge/store';
import LinkedObjectSource from '../../../../generated/kysely/knowledge/LinkedObjectSource';
import { storeLinkedObject, deleteLinkedObject } from '../../../../services/linked_objects';
import { propertyToChangeValue, changeValuesEqual, ChangeSource } from '../../../../lib/knowledge/changes';
import { SavedFilterId } from '../../../../generated/kysely/knowledge/SavedFilter';
import { ResourceId } from '../../../../generated/kysely/knowledge/Resource';
import { RawTextId } from '../../../../generated/kysely/knowledge/RawText';
import { Prompt } from '../../../../lib/prompts';
import { UserId } from '../../../../generated/kysely/core/User';
import { userProcedure as sharedUserProcedure } from '../../procedures';

/**
 * Evidence points at its source through an opaque `{kind, id, …}` ref since the
 * carve (K-7) — the store can record where a value came from without knowing
 * what sources exist. This UI only knows how to open one kind, so it unwraps
 * that one and leaves every other kind unresolved rather than guessing.
 */
const evidenceResourceId = sql<string | null>`
  case when evidence.source_ref ->> 'kind' = 'resource'
       then evidence.source_ref ->> 'id' end
`.as('resource_id');

async function resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const users = await getCoreQb(['user'])
    .selectFrom('user')
    .where('id', 'in', userIds as UserId[])
    .select(['id', 'username'])
    .execute();
  return new Map(users.map((u) => [u.id, u.username]));
}

const baseFilterSchema = z.object({
  columnId: z.string(),
  operator: z.enum([
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'contains', 'not_contains', 'starts_with', 'ends_with',
    'is_empty', 'is_not_empty', 'in',
  ]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  values: z.array(z.string()).optional(),
  negated: z.boolean().optional(),
});

const tableFilterSchema: z.ZodType<TableFilter> = baseFilterSchema.extend({
  group: z.object({
    conjunction: z.enum(['and', 'or']),
    filters: z.lazy(() => z.array(tableFilterSchema)),
  }).optional(),
});

type TableFilter = z.infer<typeof baseFilterSchema> & {
  group?: { conjunction: 'and' | 'or'; filters: TableFilter[] };
};

function applyPropertyFilter(
  eb: any,
  filter: TableFilter,
  columns: { id: string; value_type: string }[],
) {
  const col = columns.find((c) => c.id === filter.columnId);
  if (!col) return undefined;

  const valueColumn =
    col.value_type === 'number' ? 'property.value_number'
    : col.value_type === 'date' ? 'property.value_date'
    : col.value_type === 'boolean' ? 'property.value_boolean'
    : 'property.value_text';

  if (filter.operator === 'is_empty') {
    return eb.not(
      eb.exists(
        eb.selectFrom('property')
          .whereRef('property.node_id', '=', 'node.id')
          .where('property.property_type_id', '=', filter.columnId as PropertyTypeId)
          .where(valueColumn, 'is not', null),
      ),
    );
  }

  if (filter.operator === 'is_not_empty') {
    return eb.exists(
      eb.selectFrom('property')
        .whereRef('property.node_id', '=', 'node.id')
        .where('property.property_type_id', '=', filter.columnId as PropertyTypeId)
        .where(valueColumn, 'is not', null),
    );
  }

  const opMap: Record<string, string> = {
    eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
  };

  if (filter.operator === 'in' && filter.values) {
    return eb.exists(
      eb.selectFrom('property')
        .whereRef('property.node_id', '=', 'node.id')
        .where('property.property_type_id', '=', filter.columnId as PropertyTypeId)
        .where(valueColumn, 'in', filter.values),
    );
  }

  if (filter.operator === 'contains' || filter.operator === 'not_contains' || filter.operator === 'starts_with' || filter.operator === 'ends_with') {
    const pattern =
      filter.operator === 'contains' ? `%${filter.value}%`
      : filter.operator === 'not_contains' ? `%${filter.value}%`
      : filter.operator === 'starts_with' ? `${filter.value}%`
      : `%${filter.value}`;
    const sub = eb.selectFrom('property')
      .whereRef('property.node_id', '=', 'node.id')
      .where('property.property_type_id', '=', filter.columnId as PropertyTypeId)
      .where('property.value_text', filter.operator === 'not_contains' ? 'not ilike' : 'ilike', pattern);
    return filter.operator === 'not_contains'
      ? eb.or([
          eb.not(eb.exists(
            eb.selectFrom('property')
              .whereRef('property.node_id', '=', 'node.id')
              .where('property.property_type_id', '=', filter.columnId as PropertyTypeId)
              .where('property.value_text', 'is not', null),
          )),
          eb.exists(sub),
        ])
      : eb.exists(sub);
  }

  const sqlOp = opMap[filter.operator];
  if (!sqlOp) return undefined;

  return eb.exists(
    eb.selectFrom('property')
      .whereRef('property.node_id', '=', 'node.id')
      .where('property.property_type_id', '=', filter.columnId as PropertyTypeId)
      .where(valueColumn, sqlOp, filter.value),
  );
}

/** The editor writes as the person driving it: `user_edit`, both currencies. */
function editorContext(description: string): WriteContext {
  const ctx = currentContext();
  return {
    teamId: ctx.user.teamId as TeamId,
    evidenceType: EvidenceType.user_edit,
    changeSource: ChangeSource.user_edit,
    description,
    createdBy: ctx.user.id,
  };
}

/**
 * The editor's inputs arrive pre-split by column, because the client knows the
 * property's type. The door's currency is one raw value coerced by the
 * ontology, so the split collapses here: whichever column the client filled in
 * IS the value, and an explicit `null` is a clear.
 */
function editorValue(input: {
  valueText?: string | null;
  valueNumber?: string | null;
  valueDate?: string | null;
  valueBoolean?: boolean | null;
  valueJson?: unknown;
}): unknown {
  if (input.valueText !== undefined) return input.valueText;
  if (input.valueNumber !== undefined) return input.valueNumber;
  if (input.valueDate !== undefined) return input.valueDate;
  if (input.valueBoolean !== undefined) return input.valueBoolean;
  if (input.valueJson !== undefined) return input.valueJson;
  return undefined;
}

const graphRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    getNodes: userProcedure
      .input(
        z.object({
          nodeTypeId: z.string(),
          search: z.string().optional(),
          limit: z.number().min(1).max(200).default(50),
          offset: z.number().min(0).default(0),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        const qb = getKnowledgeQb(['node', 'node_type', 'property', 'property_type']);

        let query = qb
          .selectFrom('node as n')
          .leftJoin('node_type as nt', 'nt.id', 'n.node_type_id')
          .where('n.team_id', '=', ctx.user.teamId as TeamId)
          .where('n.node_type_id', '=', input.nodeTypeId as NodeTypeId)
          .select([
            'n.id',
            'n.node_type_id',
            'nt.name as node_type_name',
            'n.created_at',
            'n.updated_at',
          ])
          .orderBy('n.updated_at desc')
          .limit(input.limit)
          .offset(input.offset);

        if (input.search) {
          query = query.where((eb) =>
            eb.exists(
              eb
                .selectFrom('property')
                .whereRef('property.node_id', '=', 'n.id')
                .where(sql<boolean>`property.value_text_search @@ plainto_tsquery('english', ${input.search})`),
            ),
          );
        }

        const rawNodes = await query.execute();

        const displayNames = await resolveDisplayNames({
          nodeIds: rawNodes.map((n) => n.id),
          teamId: ctx.user.teamId as string,
        });

        const nodes = rawNodes.map((n) => ({
          ...n,
          display_value: displayNames.get(n.id) ?? null,
        }));

        const total = await getKnowledgeQb(['node'])
          .selectFrom('node')
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .where('node_type_id', '=', input.nodeTypeId as NodeTypeId)
          .select(($) => $.fn.count('id').as('count'))
          .executeTakeFirstOrThrow();

        return { nodes, total: Number(total.count) };
      }),

    getNodesTable: userProcedure
      .input(
        z.object({
          nodeTypeId: z.string(),
          search: z.string().optional(),
          filters: z.array(tableFilterSchema).optional(),
          filterConjunction: z.enum(['and', 'or']).default('and'),
          limit: z.number().min(1).max(200).default(50),
          offset: z.number().min(0).default(0),
          sortBy: z.string().optional(),
          sortDirection: z.enum(['asc', 'desc']).default('desc'),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const nodeTypeId = input.nodeTypeId as NodeTypeId;

        // 1. Get property types (columns) for this node type
        const columns = await getKnowledgeQb(['property_type'])
          .selectFrom('property_type')
          .where('property_type.team_id', '=', teamId)
          .where('property_type.node_type_id', '=', nodeTypeId)
          .select([
            'property_type.id',
            'property_type.name',
            'property_type.value_type',
            'property_type.identity',
            'property_type.enum_values',
          ])
          .orderBy('property_type.sort_order asc')
          .orderBy('property_type.name asc')
          .execute();

        // 2. Fetch paginated node IDs
        const qb = getKnowledgeQb(['node', 'property', 'property_type']);

        let nodeQuery = qb
          .selectFrom('node')
          .where('node.team_id', '=', teamId)
          .where('node.node_type_id', '=', nodeTypeId);

        if (input.search) {
          nodeQuery = nodeQuery.where((eb) =>
            eb.exists(
              eb
                .selectFrom('property')
                .whereRef('property.node_id', '=', 'node.id')
                .where(sql<boolean>`property.value_text_search @@ plainto_tsquery('english', ${input.search})`),
            ),
          );
        }

        // Apply filters with conjunction (AND/OR) and per-filter negation
        const filters = input.filters ?? [];
        const conj = input.filterConjunction;

        function buildFilterCondition(eb: any, filter: TableFilter): any {
          // Handle filter groups: { group: { conjunction, filters } }
          if (filter.group) {
            const groupConditions = filter.group.filters.map((f) => buildFilterCondition(eb, f));
            if (groupConditions.length === 0) return eb.val(true);
            if (groupConditions.length === 1) return groupConditions[0];
            return filter.group.conjunction === 'or' ? eb.or(groupConditions) : eb.and(groupConditions);
          }

          let condition: any;
          if (filter.columnId === '_created' || filter.columnId === '_updated') {
            const field = filter.columnId === '_created' ? 'node.created_at' : 'node.updated_at';
            const opMap: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
            const op = opMap[filter.operator];
            if (op && filter.value != null) {
              condition = eb(field, op, new Date(String(filter.value)));
            }
          } else {
            condition = applyPropertyFilter(eb, filter, columns);
          }
          if (!condition) return eb.val(true);
          return filter.negated ? eb.not(condition) : condition;
        }

        if (filters.length > 0) {
          nodeQuery = nodeQuery.where((eb: any) => {
            const conditions = filters.map((f) => buildFilterCondition(eb, f));
            if (conditions.length === 1) return conditions[0];
            return conj === 'or' ? eb.or(conditions) : eb.and(conditions);
          });
        }

        // Sort: by property value, scope relationship, or node timestamp
        const sortDir = input.sortDirection === 'asc' ? 'asc' : 'desc';
        const sortByScope = input.sortBy?.startsWith('scope:');
        const sortByProperty = input.sortBy && !sortByScope && input.sortBy !== '_updated' && input.sortBy !== '_created';

        let nodes: { id: NodeId; created_at: Date; updated_at: Date }[];

        if (sortByScope) {
          const sortEdgeTypeId = input.sortBy!.slice('scope:'.length) as EdgeTypeId;

          // Find the identity property type for the target node type of this edge
          const edgeType = await getKnowledgeQb(['edge_type'])
            .selectFrom('edge_type')
            .where('edge_type.id', '=', sortEdgeTypeId)
            .where('edge_type.team_id', '=', teamId)
            .select('edge_type.target_node_type_id')
            .executeTakeFirst();

          let identityPropTypeId: PropertyTypeId | null = null;
          if (edgeType) {
            // Use the first property (by sort_order) of the target node type as the sort key
            const firstPt = await getKnowledgeQb(['property_type'])
              .selectFrom('property_type')
              .where('property_type.node_type_id', '=', edgeType.target_node_type_id)
              .orderBy('property_type.sort_order asc')
              .orderBy('property_type.name asc')
              .select('property_type.id')
              .executeTakeFirst();
            if (firstPt) identityPropTypeId = firstPt.id;
          }

          if (identityPropTypeId) {
            // Build a fresh query with edge in the schema to satisfy Kysely types
            let scopeQuery = getKnowledgeQb(['node', 'edge', 'property'])
              .selectFrom('node')
              .where('node.team_id', '=', teamId)
              .where('node.node_type_id', '=', nodeTypeId);

            if (input.search) {
              scopeQuery = scopeQuery.where((eb) =>
                eb.exists(
                  eb
                    .selectFrom('property')
                    .whereRef('property.node_id', '=', 'node.id')
                    .where(sql<boolean>`property.value_text_search @@ plainto_tsquery('english', ${input.search})`),
                ),
              );
            }

            if (filters.length > 0) {
              scopeQuery = scopeQuery.where((eb: any) => {
                const conditions = filters.map((f) => buildFilterCondition(eb, f));
                if (conditions.length === 1) return conditions[0];
                return conj === 'or' ? eb.or(conditions) : eb.and(conditions);
              });
            }

            nodes = await scopeQuery
              .leftJoin('edge as sort_edge', (join) =>
                join
                  .onRef('sort_edge.source_node_id', '=', 'node.id')
                  .on('sort_edge.edge_type_id', '=', sortEdgeTypeId),
              )
              .leftJoin('property as sort_scope_prop', (join) =>
                join
                  .onRef('sort_scope_prop.node_id', '=', 'sort_edge.target_node_id')
                  .on('sort_scope_prop.property_type_id', '=', identityPropTypeId),
              )
              .select(['node.id', 'node.created_at', 'node.updated_at'])
              .orderBy(sql`sort_scope_prop.value_text ${sql.raw(sortDir)} nulls last`)
              .limit(input.limit)
              .offset(input.offset)
              .execute();
          } else {
            // Fallback: no identity property found, sort by updated_at
            nodes = await nodeQuery
              .select(['node.id', 'node.created_at', 'node.updated_at'])
              .orderBy('node.updated_at', sortDir)
              .limit(input.limit)
              .offset(input.offset)
              .execute();
          }
        } else if (sortByProperty) {
          const sortCol = columns.find((c) => c.id === input.sortBy);
          const valueCol =
            sortCol?.value_type === 'number' ? 'sort_prop.value_number'
            : sortCol?.value_type === 'date' ? 'sort_prop.value_date'
            : sortCol?.value_type === 'boolean' ? 'sort_prop.value_boolean'
            : 'sort_prop.value_text';

          nodes = await nodeQuery
            .leftJoin('property as sort_prop', (join) =>
              join
                .onRef('sort_prop.node_id', '=', 'node.id')
                .on('sort_prop.property_type_id', '=', input.sortBy as PropertyTypeId),
            )
            .select(['node.id', 'node.created_at', 'node.updated_at'])
            .orderBy(sql`${sql.ref(valueCol)} ${sql.raw(sortDir)} nulls last`)
            .limit(input.limit)
            .offset(input.offset)
            .execute();
        } else {
          const sortField = input.sortBy === '_created' ? 'node.created_at' as const : 'node.updated_at' as const;
          nodes = await nodeQuery
            .select(['node.id', 'node.created_at', 'node.updated_at'])
            .orderBy(sortField, sortDir)
            .limit(input.limit)
            .offset(input.offset)
            .execute();
        }

        // 3. Count total
        let countQuery = getKnowledgeQb(['node', 'property'])
          .selectFrom('node')
          .where('node.team_id', '=', teamId)
          .where('node.node_type_id', '=', nodeTypeId);

        if (input.search) {
          countQuery = countQuery.where((eb) =>
            eb.exists(
              eb
                .selectFrom('property')
                .whereRef('property.node_id', '=', 'node.id')
                .where(sql<boolean>`property.value_text_search @@ plainto_tsquery('english', ${input.search})`),
            ),
          );
        }

        if (filters.length > 0) {
          countQuery = countQuery.where((eb: any) => {
            const conditions = filters.map((f) => buildFilterCondition(eb, f));
            if (conditions.length === 1) return conditions[0];
            return conj === 'or' ? eb.or(conditions) : eb.and(conditions);
          });
        }

        const total = await countQuery
          .select(($) => $.fn.count('node.id').as('count'))
          .executeTakeFirstOrThrow();

        if (!nodes.length) {
          return { columns, rows: [], total: Number(total.count), scopingColumns: [], propertyIds: {}, hasDisplayName: false };
        }

        // 4. Batch-fetch all properties for these nodes
        const nodeIds = nodes.map((n) => n.id);
        const properties = await getKnowledgeQb(['property'])
          .selectFrom('property')
          .where('property.node_id', 'in', nodeIds)
          .select([
            'property.id',
            'property.node_id',
            'property.property_type_id',
            'property.value_text',
            'property.value_number',
            'property.value_date',
            'property.value_boolean',
            'property.value_json',
          ])
          .execute();

        // 5. Build a lookup: nodeId → { propertyTypeId → value }
        const propsByNode = new Map<string, Map<string, typeof properties[number]>>();
        for (const p of properties) {
          const nid = p.node_id!;
          let nodeMap = propsByNode.get(nid);
          if (!nodeMap) {
            nodeMap = new Map();
            propsByNode.set(nid, nodeMap);
          }
          nodeMap.set(p.property_type_id, p);
        }

        // 6. Derive relationship columns from uniqueness constraints
        // Read the node type's uniqueness_constraints JSONB and extract referenced edge types
        const nodeTypeInfo = await getKnowledgeQb(['node_type'])
          .selectFrom('node_type')
          .where('node_type.id', '=', nodeTypeId)
          .select(['node_type.uniqueness_constraints', 'node_type.display_name_template', 'node_type.display_name_expression'])
          .executeTakeFirst();

        const constraints = nodeTypeInfo?.uniqueness_constraints as StoredUniquenessConstraints | null;
        const hasDisplayName = !!nodeTypeInfo?.display_name_expression || !!nodeTypeInfo?.display_name_template;

        // Track edge type IDs and their direction from constraints
        const constraintEdgeDirections = new Map<string, 'outgoing' | 'incoming'>();
        if (constraints) {
          for (const constraint of constraints) {
            for (const entry of constraint) {
              // `edge_to` entries reference TG ancestors, not edge types;
              // they don't contribute to scoping edge type collection here.
              if (isEdgeToEntry(entry)) continue;
              const expr = entry.expr as { type: string; steps?: Array<{ edgeTypeId?: string; direction?: string }> };
              if (expr.type === 'traverse' && expr.steps?.[0]?.edgeTypeId) {
                const step = expr.steps[0];
                constraintEdgeDirections.set(
                  step.edgeTypeId!,
                  (step.direction as 'outgoing' | 'incoming') ?? 'outgoing',
                );
              }
            }
          }
        }

        let scopingEdgeTypes: Array<{ id: EdgeTypeId; source_node_type_id: NodeTypeId; target_node_type_id: NodeTypeId; outbound_name: string; inbound_name: string }> = [];
        if (constraintEdgeDirections.size > 0) {
          scopingEdgeTypes = await getKnowledgeQb(['edge_type'])
            .selectFrom('edge_type as et')
            .where('et.id', 'in', [...constraintEdgeDirections.keys()] as EdgeTypeId[])
            .select(['et.id', 'et.source_node_type_id', 'et.target_node_type_id', 'et.outbound_name', 'et.inbound_name'])
            .execute();
        }

        // For each edge type, determine the "other" node type based on constraint direction
        const otherNodeTypeIds = new Set<string>();
        for (const et of scopingEdgeTypes) {
          const dir = constraintEdgeDirections.get(et.id as string) ?? 'outgoing';
          otherNodeTypeIds.add(dir === 'outgoing' ? (et.target_node_type_id as string) : (et.source_node_type_id as string));
        }

        const otherNodeTypeNames = new Map<string, string>();
        if (otherNodeTypeIds.size > 0) {
          const nts = await getKnowledgeQb(['node_type'])
            .selectFrom('node_type')
            .where('node_type.id', 'in', [...otherNodeTypeIds] as NodeTypeId[])
            .select(['node_type.id', 'node_type.name'])
            .execute();
          for (const nt of nts) otherNodeTypeNames.set(nt.id as string, nt.name);
        }

        const scopingColumns = scopingEdgeTypes.map((et) => {
          const dir = constraintEdgeDirections.get(et.id as string) ?? 'outgoing';
          const otherNtId = dir === 'outgoing' ? et.target_node_type_id : et.source_node_type_id;
          return {
            edgeTypeId: et.id,
            edgeTypeName: dir === 'outgoing' ? et.outbound_name : et.inbound_name,
            targetNodeTypeName: otherNodeTypeNames.get(otherNtId as string) ?? et.outbound_name,
          };
        });

        // nodeId → { edgeTypeId → { parentName, parentNodeId } }
        const scopingValuesByNode = new Map<string, Record<string, { parentName: string; parentNodeId: string }>>();

        if (scopingEdgeTypes.length > 0) {
          const scopingEdgeTypeIds = scopingEdgeTypes.map((et) => et.id);

          // Fetch edges in both directions — some constraints reference incoming edges
          const scopingEdges = await getKnowledgeQb(['edge'])
            .selectFrom('edge')
            .where('edge.edge_type_id', 'in', scopingEdgeTypeIds)
            .where((eb) =>
              eb.or([
                eb('edge.source_node_id', 'in', nodeIds),
                eb('edge.target_node_id', 'in', nodeIds),
              ]),
            )
            .select(['edge.source_node_id', 'edge.target_node_id', 'edge.edge_type_id'])
            .execute();

          if (scopingEdges.length > 0) {
            // Collect all "other" node IDs that need display name resolution
            const linkedNodeIds = new Set<string>();
            for (const edge of scopingEdges) {
              const dir = constraintEdgeDirections.get(edge.edge_type_id as string) ?? 'outgoing';
              const ourNodeId = dir === 'outgoing' ? edge.source_node_id : edge.target_node_id;
              const otherNodeId = dir === 'outgoing' ? edge.target_node_id : edge.source_node_id;
              if ((nodeIds as string[]).includes(ourNodeId as string)) {
                linkedNodeIds.add(otherNodeId as string);
              }
            }

            const parentNames = await resolveDisplayNames({
              nodeIds: [...linkedNodeIds],
              teamId: ctx.user.teamId as string,
            });

            for (const edge of scopingEdges) {
              const dir = constraintEdgeDirections.get(edge.edge_type_id as string) ?? 'outgoing';
              const ourNodeId = dir === 'outgoing' ? edge.source_node_id : edge.target_node_id;
              const otherNodeId = dir === 'outgoing' ? edge.target_node_id : edge.source_node_id;
              if (!(nodeIds as string[]).includes(ourNodeId as string)) continue;

              const existing = scopingValuesByNode.get(ourNodeId as string) ?? {};
              existing[edge.edge_type_id as string] = {
                parentName: parentNames.get(otherNodeId as string) ?? (otherNodeId as string).slice(0, 8),
                parentNodeId: otherNodeId as string,
              };
              scopingValuesByNode.set(ourNodeId as string, existing);
            }
          }
        }

        // 7. Build propertyIds lookup: nodeId → { propertyTypeId → propertyId }
        const propertyIds: Record<string, Record<string, string>> = {};
        for (const p of properties) {
          const nid = p.node_id!;
          if (!propertyIds[nid]) propertyIds[nid] = {};
          propertyIds[nid][p.property_type_id] = p.id;
        }

        // 8. Resolve display names when display_name_template is configured
        const displayNameMap = hasDisplayName
          ? await resolveDisplayNames({ nodeIds: nodeIds as string[], teamId: teamId as string })
          : new Map<string, string | null>();

        // 9. Assemble rows
        const rows = nodes.map((node) => {
          const nodeProps = propsByNode.get(node.id);
          const values: Record<string, string | number | boolean | null> = {};
          for (const col of columns) {
            const p = nodeProps?.get(col.id);
            if (!p) {
              values[col.id] = null;
            } else if (col.value_type === PropertyValueType.number) {
              values[col.id] = p.value_number;
            } else if (col.value_type === PropertyValueType.boolean) {
              values[col.id] = p.value_boolean;
            } else if (col.value_type === PropertyValueType.date) {
              values[col.id] = p.value_date?.toISOString() ?? null;
            } else {
              values[col.id] = p.value_text;
            }
          }
          return {
            id: node.id,
            createdAt: node.created_at,
            updatedAt: node.updated_at,
            values,
            scopingValues: scopingValuesByNode.get(node.id) ?? {},
            displayName: displayNameMap.get(node.id) ?? null,
          };
        });

        return {
          columns,
          rows,
          total: Number(total.count),
          scopingColumns,
          propertyIds,
          hasDisplayName,
        };
      }),

    parseNaturalLanguageFilter: userProcedure
      .input(
        z.object({
          query: z.string().min(1).max(500),
          columns: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              value_type: z.string(),
              enum_values: z.array(z.string()).nullable().optional(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) => {
        const columnsDescription = input.columns
          .map((c) => {
            let desc = `- ${c.name} (id: ${c.id}, type: ${c.value_type})`;
            if (c.enum_values?.length) desc += ` [values: ${c.enum_values.join(', ')}]`;
            return desc;
          })
          .join('\n');

        const result = await Prompt.parseTableFilters({
          query: input.query,
          columns: columnsDescription,
        });

        console.log('[NL Filter] query:', input.query);
        console.log('[NL Filter] LLM result:', JSON.stringify(result));

        // Validate that returned columnIds actually exist (preserve group wrappers)
        const validIds = new Set(input.columns.map((c) => c.id));
        console.log('[NL Filter] valid column IDs:', [...validIds]);

        function validateFilters(filters: TableFilter[]): TableFilter[] {
          return filters.filter((f) => {
            if (f.group) {
              f.group.filters = validateFilters(f.group.filters as TableFilter[]);
              return f.group.filters.length > 0;
            }
            const valid = validIds.has(f.columnId);
            if (!valid) console.log('[NL Filter] stripped invalid columnId:', f.columnId);
            return valid;
          });
        }
        const validated = validateFilters(result as TableFilter[]);
        console.log('[NL Filter] after validation:', JSON.stringify(validated));
        return validated;
      }),

    saveFilter: userProcedure
      .input(
        z.object({
          nodeTypeId: z.string(),
          filters: z.array(tableFilterSchema),
          conjunction: z.enum(['and', 'or']).default('and'),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const row = await getKnowledgeQb(['saved_filter'])
          .insertInto('saved_filter')
          .values({
            team_id: teamId,
            node_type_id: input.nodeTypeId as NodeTypeId,
            filters: JSON.stringify(input.filters),
            conjunction: input.conjunction,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        return { id: row.id };
      }),

    getFilter: userProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();

        const row = await getKnowledgeQb(['saved_filter'])
          .selectFrom('saved_filter')
          .where('id', '=', input.id as SavedFilterId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .select(['id', 'node_type_id', 'filters', 'conjunction'])
          .executeTakeFirst();

        if (!row) return null;

        return {
          id: row.id,
          nodeTypeId: row.node_type_id,
          filters: row.filters as TableFilter[],
          conjunction: row.conjunction as 'and' | 'or',
        };
      }),

    getNode: userProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();

        const node = await getKnowledgeQb(['node', 'node_type'])
          .selectFrom('node as n')
          .leftJoin('node_type as nt', 'nt.id', 'n.node_type_id')
          .where('n.id', '=', input.id as NodeId)
          .where('n.team_id', '=', ctx.user.teamId as TeamId)
          .select([
            'n.id',
            'n.node_type_id',
            'nt.name as node_type_name',
            'nt.category',
            'n.start_date',
            'n.end_date',
            'n.created_at',
            'n.updated_at',
          ])
          .executeTakeFirst();

        if (!node) throw new Error('Node not found');

        const [properties, rawOutgoingEdges, rawIncomingEdges] = await Promise.all([
          getKnowledgeQb(['property', 'property_type'])
            .selectFrom('property as p')
            .innerJoin('property_type as pt', 'pt.id', 'p.property_type_id')
            .where('p.node_id', '=', input.id as NodeId)
            .select([
              'p.id as property_id',
              'pt.id as property_type_id',
              'pt.name as property_name',
              'pt.value_type',
              'p.value_text',
              'p.value_number',
              'p.value_date',
              'p.value_boolean',
              'p.value_json',
            ])
            .execute(),

          getKnowledgeQb(['edge', 'edge_type', 'node', 'node_type'])
            .selectFrom('edge as e')
            .innerJoin('edge_type as et', 'et.id', 'e.edge_type_id')
            .innerJoin('node as tn', 'tn.id', 'e.target_node_id')
            .innerJoin('node_type as tnt', 'tnt.id', 'tn.node_type_id')
            .where('e.source_node_id', '=', input.id as NodeId)
            .select([
              'e.id as edge_id',
              'e.edge_type_id',
              'et.outbound_name as edge_type_outbound_name',
              'et.inbound_name as edge_type_inbound_name',
              'tn.id as target_node_id',
              'tnt.id as target_node_type_id',
              'tnt.name as target_node_type_name',
            ])
            .execute(),

          getKnowledgeQb(['edge', 'edge_type', 'node', 'node_type'])
            .selectFrom('edge as e')
            .innerJoin('edge_type as et', 'et.id', 'e.edge_type_id')
            .innerJoin('node as sn', 'sn.id', 'e.source_node_id')
            .innerJoin('node_type as snt', 'snt.id', 'sn.node_type_id')
            .where('e.target_node_id', '=', input.id as NodeId)
            .select([
              'e.id as edge_id',
              'e.edge_type_id',
              'et.outbound_name as edge_type_outbound_name',
              'et.inbound_name as edge_type_inbound_name',
              'sn.id as source_node_id',
              'snt.id as source_node_type_id',
              'snt.name as source_node_type_name',
            ])
            .execute(),
        ]);

        // Resolve display names for all edge endpoints
        const relatedNodeIds = [
          ...rawOutgoingEdges.map((e) => e.target_node_id),
          ...rawIncomingEdges.map((e) => e.source_node_id),
        ];
        const relatedNames = relatedNodeIds.length > 0
          ? await resolveDisplayNames({ nodeIds: relatedNodeIds, teamId: ctx.user.teamId as string })
          : new Map<string, string | null>();

        const outgoingEdges = rawOutgoingEdges.map((e) => ({
          ...e,
          target_display_value: relatedNames.get(e.target_node_id) ?? null,
        }));
        const incomingEdges = rawIncomingEdges.map((e) => ({
          ...e,
          source_display_value: relatedNames.get(e.source_node_id) ?? null,
        }));

        // Fetch edge properties for all edges connected to this node
        const allEdgeIds = [
          ...outgoingEdges.map((e) => e.edge_id),
          ...incomingEdges.map((e) => e.edge_id),
        ].filter(Boolean);

        const edgeProperties = allEdgeIds.length > 0
          ? await getKnowledgeQb(['property', 'property_type'])
              .selectFrom('property as p')
              .innerJoin('property_type as pt', 'pt.id', 'p.property_type_id')
              .where('p.edge_id', 'in', allEdgeIds as EdgeId[])
              .select([
                'p.id as property_id',
                'p.edge_id',
                'pt.id as property_type_id',
                'pt.name as property_name',
                'pt.value_type',
                'p.value_text',
                'p.value_number',
                'p.value_date',
                'p.value_boolean',
                'p.value_json',
              ])
              .execute()
          : [];

        const nodeDisplayNames = await resolveDisplayNames({
          nodeIds: [node.id],
          teamId: ctx.user.teamId as string,
        });

        return {
          ...node,
          display_value: nodeDisplayNames.get(node.id) ?? null,
          properties,
          outgoingEdges,
          incomingEdges,
          edgeProperties,
        };
      }),

    getPropertyEvidence: userProcedure
      .input(z.object({ propertyId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();

        const prop = await getKnowledgeQb(['property'])
          .selectFrom('property')
          .where('id', '=', input.propertyId as PropertyId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .select('id')
          .executeTakeFirst();

        if (!prop) throw new Error('Property not found');

        const evidence = await getKnowledgeQb(['evidence'])
          .selectFrom('evidence')
          .where('property_id', '=', input.propertyId as PropertyId)
          .select([
            'id',
            'type',
            'description',
            'excerpt',
            evidenceResourceId,
            'linked_object_id',
            'linked_object_field',
            'created_at',
          ])
          .orderBy('created_at desc')
          .execute();

        return evidence;
      }),

    getNodeEvidence: userProcedure
      .input(z.object({ nodeId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const nodeId = input.nodeId as NodeId;
        const teamId = ctx.user.teamId as TeamId;

        // Get all property IDs for this node
        const properties = await getKnowledgeQb(['property', 'property_type'])
          .selectFrom('property as p')
          .innerJoin('property_type as pt', 'pt.id', 'p.property_type_id')
          .where('p.node_id', '=', nodeId)
          .where('p.team_id', '=', teamId)
          .select(['p.id', 'pt.name as property_name'])
          .execute();

        // Get all edge IDs for this node
        const edges = await getKnowledgeQb(['edge', 'edge_type'])
          .selectFrom('edge as e')
          .innerJoin('edge_type as et', 'et.id', 'e.edge_type_id')
          .where((eb) =>
            eb.or([
              eb('e.source_node_id', '=', nodeId),
              eb('e.target_node_id', '=', nodeId),
            ]),
          )
          .where('e.team_id', '=', teamId)
          .select(['e.id', 'et.outbound_name as edge_type_name'])
          .execute();

        const propertyIds = properties.map((p) => p.id);
        const edgeIds = edges.map((e) => e.id);

        if (propertyIds.length === 0 && edgeIds.length === 0) return [];

        const propertyNameMap = new Map(properties.map((p) => [p.id, p.property_name]));
        const edgeNameMap = new Map(edges.map((e) => [e.id, e.edge_type_name]));

        let query = getKnowledgeQb(['evidence'])
          .selectFrom('evidence')
          .select([
            'id',
            'type',
            'description',
            'excerpt',
            evidenceResourceId,
            'property_id',
            'edge_id',
            'created_at',
          ])
          .orderBy('created_at desc');

        if (propertyIds.length > 0 && edgeIds.length > 0) {
          query = query.where((eb) =>
            eb.or([
              eb('property_id', 'in', propertyIds as PropertyId[]),
              eb('edge_id', 'in', edgeIds as EdgeId[]),
            ]),
          );
        } else if (propertyIds.length > 0) {
          query = query.where('property_id', 'in', propertyIds as PropertyId[]);
        } else {
          query = query.where('edge_id', 'in', edgeIds as EdgeId[]);
        }

        const evidence = await query.execute();

        return evidence.map((e) => ({
          ...e,
          target_name: e.property_id
            ? propertyNameMap.get(e.property_id) ?? null
            : e.edge_id
              ? edgeNameMap.get(e.edge_id) ?? null
              : null,
          target_type: e.property_id ? 'property' as const : 'edge' as const,
        }));
      }),

    getEdgeEvidence: userProcedure
      .input(z.object({ edgeId: z.string() }))
      .query(async ({ input }) => {
        const evidence = await getKnowledgeQb(['evidence'])
          .selectFrom('evidence')
          .where('edge_id', '=', input.edgeId as EdgeId)
          .select([
            'id',
            'type',
            'description',
            'excerpt',
            evidenceResourceId,
            'linked_object_id',
            'linked_object_field',
            'created_at',
          ])
          .orderBy('created_at desc')
          .execute();

        return evidence;
      }),

    getEvidenceSource: userProcedure
      .input(z.object({ resourceId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();

        const resource = await getKnowledgeQb(['resource'])
          .selectFrom('resource')
          .where('id', '=', input.resourceId as ResourceId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .select(['id', 'name', 'type', 'url', 'raw_text_id'])
          .executeTakeFirst();

        if (!resource) throw new Error('Resource not found');

        let content: string | null = null;
        if (resource.raw_text_id) {
          const rawText = await getKnowledgeQb(['raw_text'])
            .selectFrom('raw_text')
            .where('id', '=', resource.raw_text_id as RawTextId)
            .where('team_id', '=', ctx.user.teamId as TeamId)
            .select('content')
            .executeTakeFirst();
          content = rawText?.content ?? null;
        }

        return {
          id: resource.id,
          name: resource.name,
          type: resource.type,
          url: resource.url,
          content,
        };
      }),

    getNodeChanges: userProcedure
      .input(
        z.object({
          nodeId: z.string(),
          limit: z.number().default(20),
          cursor: z.string().optional(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();

        let query = getKnowledgeQb(['change', 'property', 'property_type'])
          .selectFrom('change')
          .leftJoin('property', 'property.id', 'change.property_id')
          .leftJoin('property_type', 'property_type.id', 'property.property_type_id')
          .where('change.node_id', '=', input.nodeId as NodeId)
          .where('change.team_id', '=', ctx.user.teamId as TeamId)
          .select([
            'change.id',
            'change.request_id',
            'change.source',
            'change.kind',
            'change.property_id',
            'change.edge_id',
            'change.evidence_id',
            'change.old_value',
            'change.new_value',
            'change.created_by',
            'change.created_at',
            'property_type.name as property_name',
          ])
          .orderBy('change.created_at desc')
          .limit(input.limit + 1);

        if (input.cursor) {
          const cursorChange = await getKnowledgeQb(['change'])
            .selectFrom('change')
            .where('id', '=', input.cursor as any)
            .select('created_at')
            .executeTakeFirst();
          if (cursorChange) {
            query = query.where('change.created_at', '<', cursorChange.created_at);
          }
        }

        const rows = await query.execute();
        const hasMore = rows.length > input.limit;
        const changes = hasMore ? rows.slice(0, input.limit) : rows;

        const userIds = [...new Set(changes.map((c) => c.created_by).filter(Boolean))] as string[];
        const userMap = await resolveUserNames(userIds);

        return {
          changes: changes.map((c) => ({ ...c, created_by_name: c.created_by ? userMap.get(c.created_by) ?? null : null })),
          nextCursor: hasMore ? changes[changes.length - 1]?.id : null,
        };
      }),

    getEdgeChanges: userProcedure
      .input(
        z.object({
          edgeId: z.string(),
          limit: z.number().default(20),
          cursor: z.string().optional(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();

        let query = getKnowledgeQb(['change', 'property', 'property_type'])
          .selectFrom('change')
          .leftJoin('property', 'property.id', 'change.property_id')
          .leftJoin('property_type', 'property_type.id', 'property.property_type_id')
          .where('change.edge_id', '=', input.edgeId as EdgeId)
          .where('change.team_id', '=', ctx.user.teamId as TeamId)
          .select([
            'change.id',
            'change.request_id',
            'change.source',
            'change.kind',
            'change.property_id',
            'change.edge_id',
            'change.evidence_id',
            'change.old_value',
            'change.new_value',
            'change.created_by',
            'change.created_at',
            'property_type.name as property_name',
          ])
          .orderBy('change.created_at desc')
          .limit(input.limit + 1);

        if (input.cursor) {
          const cursorChange = await getKnowledgeQb(['change'])
            .selectFrom('change')
            .where('id', '=', input.cursor as any)
            .select('created_at')
            .executeTakeFirst();
          if (cursorChange) {
            query = query.where('change.created_at', '<', cursorChange.created_at);
          }
        }

        const rows = await query.execute();
        const hasMore = rows.length > input.limit;
        const changes = hasMore ? rows.slice(0, input.limit) : rows;

        const userIds = [...new Set(changes.map((c) => c.created_by).filter(Boolean))] as string[];
        const userMap = await resolveUserNames(userIds);

        return {
          changes: changes.map((c) => ({ ...c, created_by_name: c.created_by ? userMap.get(c.created_by) ?? null : null })),
          nextCursor: hasMore ? changes[changes.length - 1]?.id : null,
        };
      }),

    getPropertyTimeline: userProcedure
      .input(z.object({ propertyId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const prop = await getKnowledgeQb(['property'])
          .selectFrom('property')
          .where('id', '=', input.propertyId as PropertyId)
          .where('team_id', '=', teamId)
          .select('id')
          .executeTakeFirst();

        if (!prop) throw new Error('Property not found');

        const [evidence, changes] = await Promise.all([
          getKnowledgeQb(['evidence'])
            .selectFrom('evidence')
            .where('property_id', '=', input.propertyId as PropertyId)
            .select(['id', 'type', 'description', 'excerpt', evidenceResourceId, 'mutation_context', 'created_at'])
            .orderBy('created_at desc')
            .execute(),
          getKnowledgeQb(['change'])
            .selectFrom('change')
            .where('property_id', '=', input.propertyId as PropertyId)
            .where('team_id', '=', teamId)
            .select(['id', 'source', 'kind', 'old_value', 'new_value', 'created_by', 'created_at'])
            .orderBy('created_at desc')
            .execute(),
        ]);

        const userIds = [...new Set(changes.map((c) => c.created_by).filter(Boolean))] as string[];
        const userMap = await resolveUserNames(userIds);

        function adapterLabel(adapterType: string | undefined): string | null {
          if (!adapterType) return null;
          const friendly: Record<string, string> = {
            'native-valuations': 'Listen-Fire Valuations',
            kg: 'Knowledge Graph',
            attio: 'Attio',
            affinity: 'Affinity',
          };
          if (friendly[adapterType]) return friendly[adapterType];
          // Fallback: title-case kebab segments.
          return adapterType
            .split('-')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(' ');
        }

        type EvidenceContext = {
          adapterLabel: string | null;
          triggerType: string | null;
        } | null;

        function buildContext(mc: unknown): EvidenceContext {
          const ctx = mc as { source?: { adapterType?: string; triggerType?: string } } | null;
          if (!ctx?.source) return null;
          return {
            adapterLabel: adapterLabel(ctx.source.adapterType),
            triggerType: ctx.source.triggerType ?? null,
          };
        }

        type TimelineEntry =
          | { type: 'evidence'; id: string; evidenceType: string; description: string | null; excerpt: string | null; resourceId: string | null; context: EvidenceContext; createdAt: Date | string }
          | { type: 'change'; id: string; source: string; kind: string; oldValue: unknown; newValue: unknown; createdByName: string | null; createdAt: Date | string };

        const entries: TimelineEntry[] = [
          ...evidence.map((e) => ({
            type: 'evidence' as const,
            id: e.id,
            evidenceType: e.type,
            description: e.description,
            excerpt: e.excerpt,
            resourceId: e.resource_id,
            context: buildContext(e.mutation_context),
            createdAt: e.created_at,
          })),
          ...changes.map((c) => ({
            type: 'change' as const,
            id: c.id,
            source: c.source,
            kind: c.kind,
            oldValue: c.old_value,
            newValue: c.new_value,
            createdByName: c.created_by ? userMap.get(c.created_by) ?? null : null,
            createdAt: c.created_at,
          })),
        ];

        entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return entries;
      }),

    createUserEdit: userProcedure
      .input(
        z.object({
          propertyId: z.string(),
          description: z.string(),
          valueText: z.string().nullable().optional(),
          valueNumber: z.string().nullable().optional(),
          valueDate: z.string().nullable().optional(),
          valueBoolean: z.boolean().nullable().optional(),
          valueJson: z.unknown().nullable().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const prop = await getKnowledgeQb(['property', 'node'])
          .selectFrom('property')
          .leftJoin('node', 'node.id', 'property.node_id')
          .where('property.id', '=', input.propertyId as PropertyId)
          .where('property.team_id', '=', teamId)
          .select([
            'property.id', 'property.node_id', 'property.edge_id',
            'property.property_type_id',
            'property.value_text', 'property.value_number', 'property.value_date',
            'property.value_boolean',
            'node.node_type_id',
          ])
          .executeTakeFirst();

        if (!prop) throw new Error('Property not found');

        const oldValue = propertyToChangeValue(prop);
        const newValue = propertyToChangeValue(input);
        if (changeValuesEqual(oldValue, newValue)) return null;

        const [written] = await setProperties(openKnowledgeStore(), {
          context: editorContext(input.description),
          anchor: prop.node_id
            ? { kind: 'node', nodeId: prop.node_id, nodeTypeId: prop.node_type_id ?? undefined }
            : { kind: 'edge', edgeId: prop.edge_id! },
          properties: [{ propertyTypeId: prop.property_type_id, value: editorValue(input) }],
        });
        return written?.evidence ?? null;
      }),

    regeneratePropertyValue: userProcedure
      .input(z.object({ propertyId: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const prop = await getKnowledgeQb(['property', 'property_type'])
          .selectFrom('property')
          .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
          .where('property.id', '=', input.propertyId as PropertyId)
          .where('property.team_id', '=', teamId)
          .select([
            'property.id', 'property.node_id', 'property.edge_id',
            'property.value_text', 'property.value_number', 'property.value_date', 'property.value_boolean',
            'property_type.value_type',
            'property_type.evaluation_strategy',
            'property_type.name as property_type_name',
            'property_type.description as property_type_description',
          ])
          .executeTakeFirst();

        if (!prop) throw new Error('Property not found');

        await reEvaluateProperty(
          input.propertyId as PropertyId,
          prop.value_type,
          prop.evaluation_strategy,
          teamId,
          {
            propertyName: prop.property_type_name,
            propertyDescription: prop.property_type_description ?? undefined,
            force: true,
          },
        );

        return { success: true };
      }),

    createProperty: userProcedure
      .input(
        z.object({
          nodeId: z.string(),
          propertyTypeId: z.string(),
          valueText: z.string().nullable().optional(),
          valueNumber: z.string().nullable().optional(),
          valueDate: z.string().nullable().optional(),
          valueBoolean: z.boolean().nullable().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const node = await getKnowledgeQb(['node'])
          .selectFrom('node')
          .where('id', '=', input.nodeId as NodeId)
          .where('team_id', '=', teamId)
          .select(['id', 'node_type_id'])
          .executeTakeFirst();

        if (!node) throw new Error('Node not found');

        const [written] = await setProperties(openKnowledgeStore(), {
          context: editorContext('Created from UI'),
          anchor: { kind: 'node', nodeId: node.id, nodeTypeId: node.node_type_id },
          properties: [
            { propertyTypeId: input.propertyTypeId, value: editorValue(input) },
          ],
        });
        return written
          ? { id: written.propertyId, property_type_id: written.propertyTypeId }
          : null;
      }),

    createNode: userProcedure
      .input(
        z.object({
          nodeTypeId: z.string(),
          properties: z.array(
            z.object({
              propertyTypeId: z.string(),
              valueText: z.string().nullable().optional(),
              valueNumber: z.string().nullable().optional(),
              valueDate: z.string().nullable().optional(),
              valueBoolean: z.boolean().nullable().optional(),
              valueJson: z.unknown().nullable().optional(),
            }),
          ).default([]),
        }),
      )
      .mutation(async ({ input }) => {
        const properties: PropertyWrite[] = input.properties.map((p) => ({
          propertyTypeId: p.propertyTypeId,
          value: editorValue(p),
        }));

        const { nodeId } = await createStoreNode(openKnowledgeStore(), {
          context: editorContext('Created manually'),
          nodeTypeId: input.nodeTypeId,
          properties,
        });

        const node = await getKnowledgeQb(['node'])
          .selectFrom('node')
          .where('id', '=', nodeId)
          .select(['id', 'node_type_id', 'created_at', 'updated_at'])
          .executeTakeFirstOrThrow();

        return node;
      }),

    deleteNode: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const nodeId = input.id as NodeId;
        const { removed } = await deleteStoreNode(openKnowledgeStore(), {
          context: editorContext('Deleted from UI'),
          nodeId,
        });
        if (!removed) throw new Error('Node not found');
        return { id: nodeId };
      }),

    createEdge: userProcedure
      .input(
        z.object({
          edgeTypeId: z.string(),
          sourceNodeId: z.string(),
          targetNodeId: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        // Edge identity is (type, source, target), so asserting one that
        // already exists returns it rather than making a second (D37e).
        const { edgeId } = await linkStoreNodes(openKnowledgeStore(), {
          context: editorContext('Created manually'),
          edgeTypeId: input.edgeTypeId,
          sourceNodeId: input.sourceNodeId,
          targetNodeId: input.targetNodeId,
        });
        return {
          id: edgeId,
          edge_type_id: input.edgeTypeId as EdgeTypeId,
          source_node_id: input.sourceNodeId as NodeId,
          target_node_id: input.targetNodeId as NodeId,
        };
      }),

    deleteEdge: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const edgeId = input.id as EdgeId;
        const { removed } = await deleteStoreEdge(openKnowledgeStore(), {
          context: editorContext('Deleted from UI'),
          edgeId,
        });
        if (!removed) throw new Error('Edge not found');
        return { id: edgeId };
      }),

    bulkDeleteNodes: userProcedure
      .input(z.object({ ids: z.array(z.string()).min(1).max(500) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const nodeIds = input.ids.map((id) => id as NodeId);
        const { deleted } = await deleteStoreNodes(openKnowledgeStore(), {
          context: editorContext('Deleted from UI'),
          nodeIds,
        });
        return { deleted };
      }),

    bulkUpdateProperty: userProcedure
      .input(z.object({
        nodeIds: z.array(z.string()).min(1).max(500),
        propertyTypeId: z.string(),
        valueText: z.string().nullable().optional(),
        valueNumber: z.string().nullable().optional(),
        valueDate: z.string().nullable().optional(),
        valueBoolean: z.boolean().nullable().optional(),
      }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const nodeIds = input.nodeIds.map((id) => id as NodeId);
        const propertyTypeId = input.propertyTypeId as PropertyTypeId;

        const nodes = await getKnowledgeQb(['node'])
          .selectFrom('node')
          .where('id', 'in', nodeIds)
          .where('team_id', '=', teamId)
          .select(['id', 'node_type_id'])
          .execute();

        const db = openKnowledgeStore();
        const context = editorContext('Bulk edited from table');
        const value = editorValue(input);
        let updated = 0;
        let created = 0;

        for (const node of nodes) {
          const [written] = await setProperties(db, {
            context,
            anchor: { kind: 'node', nodeId: node.id, nodeTypeId: node.node_type_id },
            properties: [{ propertyTypeId, value }],
          });
          if (!written) continue;
          if (written.created) created++;
          else updated++;
        }

        return { updated, created };
      }),

    getEdgeTypesForNode: userProcedure
      .input(z.object({ nodeTypeId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const nodeTypeId = input.nodeTypeId as NodeTypeId;

        const [outgoing, incoming] = await Promise.all([
          getKnowledgeQb(['edge_type', 'node_type'])
            .selectFrom('edge_type as et')
            .innerJoin('node_type as tnt', 'tnt.id', 'et.target_node_type_id')
            .where('et.source_node_type_id', '=', nodeTypeId)
            .where('et.team_id', '=', teamId)
            .select(['et.id', 'et.outbound_name', 'et.inbound_name', 'et.target_node_type_id', 'tnt.name as target_node_type_name'])
            .execute(),
          getKnowledgeQb(['edge_type', 'node_type'])
            .selectFrom('edge_type as et')
            .innerJoin('node_type as snt', 'snt.id', 'et.source_node_type_id')
            .where('et.target_node_type_id', '=', nodeTypeId)
            .where('et.team_id', '=', teamId)
            .select(['et.id', 'et.outbound_name', 'et.inbound_name', 'et.source_node_type_id', 'snt.name as source_node_type_name'])
            .execute(),
        ]);

        return { outgoing, incoming };
      }),

    searchNodes: userProcedure
      .input(
        z.object({
          nodeTypeId: z.string(),
          search: z.string(),
          limit: z.number().min(1).max(50).default(20),
          excludeIds: z.array(z.string()).default([]),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        let query = getKnowledgeQb(['node', 'property'])
          .selectFrom('node as n')
          .where('n.team_id', '=', teamId)
          .where('n.node_type_id', '=', input.nodeTypeId as NodeTypeId)
          .select(['n.id'])
          .limit(input.limit);

        if (input.search) {
          query = query.where((eb) =>
            eb.exists(
              eb
                .selectFrom('property')
                .whereRef('property.node_id', '=', 'n.id')
                .where(sql<boolean>`property.value_text_search @@ plainto_tsquery('english', ${input.search})`),
            ),
          );
        }

        if (input.excludeIds.length > 0) {
          query = query.where('n.id', 'not in', input.excludeIds.map((id) => id as NodeId));
        }

        const rawNodes = await query.execute();
        const displayNames = await resolveDisplayNames({
          nodeIds: rawNodes.map((n) => n.id),
          teamId: teamId as string,
        });

        return rawNodes.map((n) => ({
          ...n,
          display_value: displayNames.get(n.id) ?? null,
        }));
      }),

    mergeNodes: userProcedure
      .input(z.object({ targetNodeId: z.string(), sourceNodeId: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const targetNode = await getKnowledgeQb(['node'])
          .selectFrom('node')
          .where('id', '=', input.targetNodeId as NodeId)
          .where('team_id', '=', teamId)
          .select(['id', 'node_type_id'])
          .executeTakeFirst();

        if (!targetNode) throw new Error('Target node not found');

        return mergeNodes({
          targetNodeId: input.targetNodeId as NodeId,
          sourceNodeId: input.sourceNodeId as NodeId,
          teamId,
          source: ChangeSource.user_edit,
        });
      }),

    // linked objects API

    getLinkedObjects: userProcedure
      .input(z.object({ nodeId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        return getKnowledgeQb(['linked_object'])
          .selectFrom('linked_object')
          .where('linked_object.node_id', '=', input.nodeId as NodeId)
          .where('linked_object.team_id', '=', ctx.user.teamId as TeamId)
          .select([
            'linked_object.id',
            'linked_object.source',
            'linked_object.adapter_type',
            'linked_object.external_id',
            'linked_object.external_object_type',
            'linked_object.data',
            'linked_object.fetched_at',
            'linked_object.updated_at',
          ])
          .execute();
      }),

    createManualLinkedObject: userProcedure
      .input(z.object({
        nodeId: z.string(),
        adapterType: z.string(),
        externalId: z.string(),
        externalObjectType: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await storeLinkedObject({
          nodeId: input.nodeId as NodeId,
          teamId: ctx.user.teamId as TeamId,
          source: LinkedObjectSource.manual,
          adapterType: input.adapterType,
          externalId: input.externalId,
          externalObjectType: input.externalObjectType,
        });
      }),

    deleteLinkedObject: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await deleteLinkedObject(input.id, ctx.user.teamId as TeamId);
      }),

    getLinkedResources: userProcedure
      .input(z.object({ nodeId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const links = await getKnowledgeQb(['node_resource'])
          .selectFrom('node_resource')
          .where('node_id', '=', input.nodeId as NodeId)
          .where('team_id', '=', teamId)
          .select('resource_id')
          .execute();

        if (links.length === 0) return [];

        const resourceIds = links.map((l) => l.resource_id);

        // Crosses the schema line: `inbound_payload` sits in
        // `public`, so the two knowledge tables are named schema-qualified
        // rather than reached through `getKnowledgeQb` (which would rewrite
        // every table in the statement).
        const resources = await getQb(['knowledge.resource', 'inbound_payload', 'knowledge.raw_text'])
          .selectFrom('knowledge.resource as r')
          .leftJoin('inbound_payload as np', 'np.id', 'r.inbound_payload_id')
          .leftJoin('knowledge.raw_text as rt', 'rt.id', 'r.raw_text_id')
          .where('r.id', 'in', resourceIds)
          .select([
            'r.id',
            'r.type',
            'r.name',
            'r.url',
            'r.document_id',
            'r.created_at',
            'np.data as payload_data',
            'rt.content as raw_text',
          ])
          .orderBy('r.created_at desc')
          .execute();

        return resources;
      }),

    getEdge: userProcedure
      .input(z.object({ edgeId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const edge = await getKnowledgeQb(['edge', 'edge_type', 'node', 'node_type'])
          .selectFrom('edge as e')
          .innerJoin('edge_type as et', 'et.id', 'e.edge_type_id')
          .innerJoin('node as sn', 'sn.id', 'e.source_node_id')
          .innerJoin('node_type as snt', 'snt.id', 'sn.node_type_id')
          .innerJoin('node as tn', 'tn.id', 'e.target_node_id')
          .innerJoin('node_type as tnt', 'tnt.id', 'tn.node_type_id')
          .where('e.id', '=', input.edgeId as EdgeId)
          .where('e.team_id', '=', teamId)
          .select([
            'e.id',
            'e.edge_type_id',
            'et.outbound_name',
            'et.inbound_name',
            'e.source_node_id',
            'snt.id as source_node_type_id',
            'snt.name as source_node_type_name',
            'e.target_node_id',
            'tnt.id as target_node_type_id',
            'tnt.name as target_node_type_name',
            'e.created_at',
          ])
          .executeTakeFirst();

        if (!edge) throw new Error('Edge not found');

        const displayNames = await resolveDisplayNames({
          nodeIds: [edge.source_node_id, edge.target_node_id],
          teamId: teamId as string,
        });

        const [properties, propertyTypes, duplicates] = await Promise.all([
          getKnowledgeQb(['property', 'property_type'])
            .selectFrom('property as p')
            .innerJoin('property_type as pt', 'pt.id', 'p.property_type_id')
            .where('p.edge_id', '=', input.edgeId as EdgeId)
            .select([
              'p.id as property_id',
              'pt.id as property_type_id',
              'pt.name as property_name',
              'pt.value_type',
              'p.value_text',
              'p.value_number',
              'p.value_date',
              'p.value_boolean',
              'p.value_json',
            ])
            .execute(),

          getKnowledgeQb(['property_type'])
            .selectFrom('property_type')
            .where('property_type.edge_type_id', '=', edge.edge_type_id as EdgeTypeId)
            .where('property_type.team_id', '=', teamId)
            .select([
              'property_type.id',
              'property_type.name',
              'property_type.value_type',
              'property_type.identity',
              'property_type.enum_values',
            ])
            .execute(),

          // Find duplicate edges (same type, same endpoints)
          getKnowledgeQb(['edge'])
            .selectFrom('edge')
            .where('edge.edge_type_id', '=', edge.edge_type_id as EdgeTypeId)
            .where('edge.source_node_id', '=', edge.source_node_id)
            .where('edge.target_node_id', '=', edge.target_node_id)
            .where('edge.id', '!=', input.edgeId as EdgeId)
            .where('edge.team_id', '=', teamId)
            .select(['edge.id', 'edge.created_at'])
            .execute(),
        ]);

        return {
          ...edge,
          source_display_value: displayNames.get(edge.source_node_id) ?? null,
          target_display_value: displayNames.get(edge.target_node_id) ?? null,
          properties,
          propertyTypes,
          duplicates,
        };
      }),

    createEdgeProperty: userProcedure
      .input(
        z.object({
          edgeId: z.string(),
          propertyTypeId: z.string(),
          valueText: z.string().nullable().optional(),
          valueNumber: z.string().nullable().optional(),
          valueDate: z.string().nullable().optional(),
          valueBoolean: z.boolean().nullable().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const edge = await getKnowledgeQb(['edge'])
          .selectFrom('edge')
          .where('id', '=', input.edgeId as EdgeId)
          .where('team_id', '=', teamId)
          .select('id')
          .executeTakeFirst();

        if (!edge) throw new Error('Edge not found');

        const [written] = await setProperties(openKnowledgeStore(), {
          context: editorContext('Created from UI'),
          anchor: { kind: 'edge', edgeId: edge.id },
          properties: [{ propertyTypeId: input.propertyTypeId, value: editorValue(input) }],
        });

        return written
          ? { id: written.propertyId, property_type_id: written.propertyTypeId }
          : null;
      }),

    updateEdgeTarget: userProcedure
      .input(
        z.object({
          edgeId: z.string(),
          direction: z.enum(['source', 'target']),
          newNodeId: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const edge = await getKnowledgeQb(['edge', 'edge_type'])
          .selectFrom('edge as e')
          .innerJoin('edge_type as et', 'et.id', 'e.edge_type_id')
          .where('e.id', '=', input.edgeId as EdgeId)
          .where('e.team_id', '=', teamId)
          .select(['e.id', 'et.source_node_type_id', 'et.target_node_type_id'])
          .executeTakeFirst();

        if (!edge) throw new Error('Edge not found');

        // Validate the new node matches the expected node type
        const expectedNodeTypeId = input.direction === 'source'
          ? edge.source_node_type_id
          : edge.target_node_type_id;

        const newNode = await getKnowledgeQb(['node'])
          .selectFrom('node')
          .where('id', '=', input.newNodeId as NodeId)
          .where('team_id', '=', teamId)
          .select(['id', 'node_type_id'])
          .executeTakeFirst();

        if (!newNode) throw new Error('New node not found');
        if ((newNode.node_type_id as string) !== (expectedNodeTypeId as string)) {
          throw new Error('Node type mismatch');
        }

        await retargetEdge(openKnowledgeStore(), {
          context: editorContext('Re-pointed from UI'),
          edgeId: edge.id,
          direction: input.direction,
          newNodeId: input.newNodeId,
        });

        return { id: edge.id };
      }),

    mergeEdge: userProcedure
      .input(z.object({ targetEdgeId: z.string(), sourceEdgeId: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        return mergeEdges({
          targetEdgeId: input.targetEdgeId as EdgeId,
          sourceEdgeId: input.sourceEdgeId as EdgeId,
          teamId,
          source: ChangeSource.user_edit,
        });
      }),

    getNodeDisplayNames: userProcedure
      .input(z.object({ nodeIds: z.array(z.string()).max(100) }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const displayNames = await resolveDisplayNames({
          nodeIds: input.nodeIds,
          teamId: ctx.user.teamId,
        });
        const entries: Array<{ id: string; displayName: string | null }> = [];
        for (const [id, name] of displayNames) {
          entries.push({ id, displayName: name });
        }
        return entries;
      }),

    globalSearch: userProcedure
      .input(
        z.object({
          search: z.string().min(1),
          limit: z.number().min(1).max(50).default(20),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const pattern = `%${input.search}%`;
        const rows = await getKnowledgeQb(['node', 'node_type', 'property', 'property_type'])
          .selectFrom('node as n')
          .innerJoin('node_type', 'node_type.id', 'n.node_type_id')
          .innerJoin('property', 'property.node_id', 'n.id')
          .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
          .where('n.team_id', '=', teamId)
          .where((eb) =>
            eb.or([
              eb('property_type.identity', '=', PropertyIdentity.unique),
              eb('property_type.identity', '=', PropertyIdentity.fuzzy),
            ]),
          )
          .where(sql<boolean>`property.value_text ILIKE ${pattern}`)
          .select([
            'n.id as node_id',
            'n.node_type_id',
            'node_type.name as node_type_name',
            'node_type.category',
            'node_type.icon_svg',
            'property.value_text',
          ])
          .orderBy('property.value_text asc')
          .limit(input.limit)
          .execute();

        // Deduplicate by node_id (a node may match on multiple identity properties)
        const seen = new Set<string>();
        const results: Array<{
          nodeId: string;
          nodeTypeId: string;
          nodeTypeName: string;
          category: string;
          iconSvg: string | null;
          displayValue: string | null;
        }> = [];

        for (const row of rows) {
          if (seen.has(row.node_id)) continue;
          seen.add(row.node_id);
          results.push({
            nodeId: row.node_id,
            nodeTypeId: row.node_type_id,
            nodeTypeName: row.node_type_name,
            category: row.category,
            iconSvg: row.icon_svg,
            displayValue: row.value_text,
          });
        }

        // Resolve proper display names for template-based node types
        const displayNames = await resolveDisplayNames({
          nodeIds: results.map((r) => r.nodeId),
          teamId: teamId as string,
        });
        for (const result of results) {
          const resolved = displayNames.get(result.nodeId);
          if (resolved) result.displayValue = resolved;
        }

        return results;
      }),
  });
};

export { graphRouter };
