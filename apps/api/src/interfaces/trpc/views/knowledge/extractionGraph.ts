import { z } from 'zod';

import { getKnowledgeQb } from '../../../../lib/kysely';
import { currentContext } from '../../../../services/context';
import { trpc } from '../../trpc';
import { TeamId } from '../../../../generated/kysely/core/Team';
import { NodeTypeId } from '../../../../generated/kysely/knowledge/NodeType';
import { EdgeTypeId } from '../../../../generated/kysely/knowledge/EdgeType';
import { ExtractionGraphId } from '../../../../generated/kysely/knowledge/ExtractionGraph';
import { ExtractionGraphNodeId } from '../../../../generated/kysely/knowledge/ExtractionGraphNode';
import { ExtractionGraphEdgeId } from '../../../../generated/kysely/knowledge/ExtractionGraphEdge';
import { PluginId } from '../../../../generated/kysely/knowledge/Plugin';
import { inputPropertyMappingSchema } from '../../../../services/knowledge_pipeline/types';
import { userProcedure as sharedUserProcedure } from '../../procedures';

const pluginAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  z.object({ type: z.literal('api_key'), headerName: z.string(), apiKey: z.string() }),
]);

const extractionGraphRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    getPlugins: userProcedure.query(async () => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;
      const pluginCols = [
        'plugin.id', 'plugin.name', 'plugin.description',
        'plugin.stages', 'plugin.type', 'plugin.endpoint', 'plugin.method',
        'plugin.auth', 'plugin.headers',
      ] as const;
      const teamPlugins = await getKnowledgeQb(['plugin'])
        .selectFrom('plugin')
        .where('plugin.team_id', '=', teamId)
        .select([...pluginCols])
        .execute();
      const bundledPlugins = await getKnowledgeQb(['plugin'])
        .selectFrom('plugin')
        .where('plugin.team_id', 'is', null)
        .select([...pluginCols])
        .execute();
      return [...bundledPlugins, ...teamPlugins].sort((a, b) => a.name.localeCompare(b.name));
    }),

    createPlugin: userProcedure
      .input(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          type: z.enum(['bundled', 'external']).default('external'),
          endpoint: z.string().nullable().optional(),
          method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
          auth: pluginAuthSchema.optional(),
          headers: z.record(z.string(), z.string()).optional(),
          stages: z.array(z.enum(['content', 'entity'])).min(1),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const authValue = input.auth && input.auth.type !== 'none' ? JSON.stringify(input.auth) : null;
        const headersValue = input.headers && Object.keys(input.headers).length > 0 ? JSON.stringify(input.headers) : null;
        const row = await getKnowledgeQb(['plugin'])
          .insertInto('plugin')
          .values({
            team_id: ctx.user.teamId as TeamId,
            name: input.name,
            description: input.description ?? null,
            type: input.type,
            endpoint: input.endpoint ?? null,
            method: input.method,
            auth: authValue,
            headers: headersValue,
            stages: input.stages,
          })
          .returning(['id', 'name'])
          .executeTakeFirstOrThrow();
        return row;
      }),

    updatePlugin: userProcedure
      .input(
        z.object({
          id: z.string(),
          name: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          endpoint: z.string().nullable().optional(),
          method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
          auth: pluginAuthSchema.nullable().optional(),
          headers: z.record(z.string(), z.string()).nullable().optional(),
          stages: z.array(z.enum(['content', 'entity'])).min(1).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const { id, ...fields } = input;
        const values: Record<string, unknown> = {};
        if (fields.name !== undefined) values.name = fields.name;
        if (fields.description !== undefined) values.description = fields.description;
        if (fields.endpoint !== undefined) values.endpoint = fields.endpoint;
        if (fields.method !== undefined) values.method = fields.method;
        if (fields.auth !== undefined) {
          values.auth = fields.auth && fields.auth.type !== 'none' ? JSON.stringify(fields.auth) : null;
        }
        if (fields.headers !== undefined) {
          values.headers = fields.headers && Object.keys(fields.headers).length > 0 ? JSON.stringify(fields.headers) : null;
        }
        if (fields.stages !== undefined) values.stages = fields.stages;

        if (Object.keys(values).length === 0) throw new Error('No fields to update');

        const row = await getKnowledgeQb(['plugin'])
          .updateTable('plugin')
          .set(values)
          .where('id', '=', id as PluginId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .returning(['id', 'name'])
          .executeTakeFirst();

        if (!row) throw new Error('Plugin not found or not owned by team');
        return row;
      }),

    deletePlugin: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const row = await getKnowledgeQb(['plugin'])
          .deleteFrom('plugin')
          .where('id', '=', input.id as PluginId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .returning('id')
          .executeTakeFirst();

        if (!row) throw new Error('Plugin not found or not owned by team');
        return row;
      }),

    getExtractionGraphs: userProcedure.query(async () => {
      const ctx = currentContext();
      const graphs = await getKnowledgeQb([
        'extraction_graph',
        'extraction_graph_node',
        'node_type',
        'extraction_graph_edge',
      ])
        .selectFrom('extraction_graph as eg')
        .innerJoin('extraction_graph_node as rn', 'rn.id', 'eg.root_node_id')
        .leftJoin('node_type as mnt', 'mnt.id', 'rn.node_type_id')
        .where('eg.team_id', '=', ctx.user.teamId as TeamId)
        .select(($) => [
          'eg.id',
          'eg.name',
          'eg.description',
          'eg.root_node_id',
          'rn.node_type_id as message_node_type_id',
          'mnt.name as message_node_type_name',
          $.selectFrom('extraction_graph_edge')
            .whereRef('extraction_graph_id', '=', 'eg.id')
            .select(($) => $.fn.count('id').as('count'))
            .as('edge_count'),
          'eg.created_at',
          'eg.updated_at',
        ])
        .orderBy('eg.name asc')
        .execute();

      return graphs;
    }),

    getExtractionGraphEdgesByMessageType: userProcedure
      .input(z.object({ messageNodeTypeId: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const rows = await getKnowledgeQb([
          'extraction_graph',
          'extraction_graph_node',
          'extraction_graph_edge',
          'edge_type',
          'node_type',
        ])
          .selectFrom('extraction_graph_edge as ege')
          .innerJoin('extraction_graph as eg', 'eg.id', 'ege.extraction_graph_id')
          .innerJoin('extraction_graph_node as sn', 'sn.id', 'ege.source_node_id')
          .innerJoin('extraction_graph_node as tn', 'tn.id', 'ege.target_node_id')
          .innerJoin('extraction_graph_node as rn', 'rn.id', 'eg.root_node_id')
          .innerJoin('edge_type as et', 'et.id', 'ege.edge_type_id')
          .innerJoin('node_type as tnt', 'tnt.id', 'tn.node_type_id')
          .where('eg.team_id', '=', teamId)
          .where('rn.node_type_id', '=', input.messageNodeTypeId as NodeTypeId)
          .select([
            'sn.node_type_id as source_node_type_id',
            'ege.edge_type_id',
            'et.outbound_name as edge_type_name',
            'tn.node_type_id as target_node_type_id',
            'tnt.name as target_node_type_name',
          ])
          .execute();

        return rows;
      }),

    getExtractionGraph: userProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const ctx = currentContext();

        const graph = await getKnowledgeQb(['extraction_graph', 'extraction_graph_node', 'node_type'])
          .selectFrom('extraction_graph as eg')
          .innerJoin('extraction_graph_node as rn', 'rn.id', 'eg.root_node_id')
          .leftJoin('node_type as mnt', 'mnt.id', 'rn.node_type_id')
          .where('eg.id', '=', input.id as ExtractionGraphId)
          .where('eg.team_id', '=', ctx.user.teamId as TeamId)
          .select([
            'eg.id',
            'eg.name',
            'eg.description',
            'eg.root_node_id',
            'rn.node_type_id as message_node_type_id',
            'mnt.name as message_node_type_name',
            'eg.created_at',
            'eg.updated_at',
          ])
          .executeTakeFirst();

        if (!graph) throw new Error('Extraction graph not found');

        const nodes = await getKnowledgeQb(['extraction_graph_node', 'node_type'])
          .selectFrom('extraction_graph_node as egn')
          .leftJoin('node_type as nt', 'nt.id', 'egn.node_type_id')
          .where('egn.extraction_graph_id', '=', input.id as ExtractionGraphId)
          .select([
            'egn.id',
            'egn.node_type_id',
            'nt.name as node_type_name',
            'nt.category as node_type_category',
            'egn.property_overrides',
            'egn.edge_property_overrides',
            'egn.sort_order',
            'egn.instructions',
            'egn.expand',
            'egn.gather',
            'egn.filters',
            'egn.content_plugins',
            'egn.entity_plugins',
            'egn.default_property_mappings',
          ])
          .orderBy('egn.sort_order asc')
          .execute();

        const edges = await getKnowledgeQb(['extraction_graph_edge', 'edge_type'])
          .selectFrom('extraction_graph_edge as ege')
          .leftJoin('edge_type as et', 'et.id', 'ege.edge_type_id')
          .where('ege.extraction_graph_id', '=', input.id as ExtractionGraphId)
          .select([
            'ege.id',
            'ege.source_node_id',
            'ege.edge_type_id',
            'et.outbound_name as edge_type_outbound_name',
            'et.inbound_name as edge_type_inbound_name',
            'ege.target_node_id',
          ])
          .execute();

        // Fetch property types for all node types in the graph so UI can show checklists
        const nodeTypeIds = [...new Set(nodes.map((n) => n.node_type_id).filter(Boolean))];
        const edgeTypeIds = [...new Set(edges.map((e) => e.edge_type_id).filter(Boolean))];

        const propertyTypes =
          nodeTypeIds.length > 0
            ? await getKnowledgeQb(['property_type'])
                .selectFrom('property_type')
                .where('property_type.node_type_id', 'in', nodeTypeIds)
                .select([
                  'property_type.id',
                  'property_type.node_type_id',
                  'property_type.edge_type_id',
                  'property_type.name',
                  'property_type.description',
                  'property_type.value_type',
                  'property_type.identity',
                ])
                .execute()
            : [];

        const edgePropertyTypes =
          edgeTypeIds.length > 0
            ? await getKnowledgeQb(['property_type'])
                .selectFrom('property_type')
                .where('property_type.edge_type_id', 'in', edgeTypeIds)
                .select([
                  'property_type.id',
                  'property_type.node_type_id',
                  'property_type.edge_type_id',
                  'property_type.name',
                  'property_type.description',
                  'property_type.value_type',
                  'property_type.identity',
                ])
                .execute()
            : [];

        return { ...graph, nodes, edges, propertyTypes, edgePropertyTypes };
      }),

    createExtractionGraph: userProcedure
      .input(
        z.object({
          name: z.string().min(1),
          description: z.string().default(''),
          messageNodeTypeId: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        // Create graph with dummy root_node_id (FK is DEFERRABLE INITIALLY DEFERRED)
        const graph = await getKnowledgeQb(['extraction_graph'])
          .insertInto('extraction_graph')
          .values({
            team_id: teamId,
            name: input.name,
            description: input.description,
            root_node_id: '00000000-0000-0000-0000-000000000000' as ExtractionGraphNodeId,
          })
          .returning(['id', 'name'])
          .executeTakeFirstOrThrow();

        // Create root extraction node
        const rootNode = await getKnowledgeQb(['extraction_graph_node'])
          .insertInto('extraction_graph_node')
          .values({
            team_id: teamId,
            extraction_graph_id: graph.id,
            node_type_id: input.messageNodeTypeId as NodeTypeId,
            sort_order: 0,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        // Update graph with real root_node_id
        await getKnowledgeQb(['extraction_graph'])
          .updateTable('extraction_graph')
          .set({ root_node_id: rootNode.id })
          .where('id', '=', graph.id)
          .execute();

        return graph;
      }),

    updateExtractionGraph: userProcedure
      .input(
        z.object({
          id: z.string(),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const { id, ...updates } = input;

        const values: Record<string, unknown> = { updated_at: new Date() };
        if (updates.name !== undefined) values.name = updates.name;
        if (updates.description !== undefined) values.description = updates.description;

        const graph = await getKnowledgeQb(['extraction_graph'])
          .updateTable('extraction_graph')
          .set(values)
          .where('id', '=', id as ExtractionGraphId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .returning(['id', 'name'])
          .executeTakeFirst();

        if (!graph) throw new Error('Extraction graph not found');
        return graph;
      }),

    deleteExtractionGraph: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const result = await getKnowledgeQb(['extraction_graph'])
          .deleteFrom('extraction_graph')
          .where('id', '=', input.id as ExtractionGraphId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .returning('id')
          .executeTakeFirst();

        if (!result) throw new Error('Extraction graph not found');
        return result;
      }),

    addExtractionGraphEdge: userProcedure
      .input(
        z.object({
          extractionGraphId: z.string(),
          sourceExtractionNodeId: z.string(),
          edgeTypeId: z.string(),
          targetNodeTypeId: z.string(),
          instructions: z.string().nullable().optional(),
          gather: z.boolean().optional(),
          filters: z
            .array(z.object({ side: z.enum(['source', 'target']), property: z.string(), value: z.string() }))
            .optional(),
          edgePropertyOverrides: z
            .array(z.object({ property_type_id: z.string(), instructions: z.string().optional() }))
            .nullable()
            .optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;

        const graph = await getKnowledgeQb(['extraction_graph'])
          .selectFrom('extraction_graph')
          .where('id', '=', input.extractionGraphId as ExtractionGraphId)
          .where('team_id', '=', teamId)
          .select('id')
          .executeTakeFirst();

        if (!graph) throw new Error('Extraction graph not found');

        // Auto-create target extraction node with config fields
        const targetNode = await getKnowledgeQb(['extraction_graph_node'])
          .insertInto('extraction_graph_node')
          .values({
            team_id: teamId,
            extraction_graph_id: input.extractionGraphId as ExtractionGraphId,
            node_type_id: input.targetNodeTypeId as NodeTypeId,
            instructions: input.instructions ?? null,
            expand: false,
            gather: input.gather ?? false,
            filters: JSON.stringify(input.filters ?? []),
            edge_property_overrides:
              input.edgePropertyOverrides != null ? JSON.stringify(input.edgePropertyOverrides) : null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        const edge = await getKnowledgeQb(['extraction_graph_edge'])
          .insertInto('extraction_graph_edge')
          .values({
            team_id: teamId,
            extraction_graph_id: input.extractionGraphId as ExtractionGraphId,
            source_node_id: input.sourceExtractionNodeId as ExtractionGraphNodeId,
            edge_type_id: input.edgeTypeId as EdgeTypeId,
            target_node_id: targetNode.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        return edge;
      }),

    updateExtractionGraphNode: userProcedure
      .input(
        z.object({
          id: z.string(),
          propertyOverrides: z
            .array(z.object({ property_type_id: z.string(), instructions: z.string().optional() }))
            .nullable()
            .optional(),
          edgePropertyOverrides: z
            .array(z.object({ property_type_id: z.string(), instructions: z.string().optional() }))
            .nullable()
            .optional(),
          instructions: z.string().nullable().optional(),
          gather: z.boolean().optional(),
          filters: z
            .array(z.object({ side: z.enum(['source', 'target']), property: z.string(), value: z.string() }))
            .optional(),
          contentPlugins: z
            .array(z.object({ pluginId: z.string(), config: z.record(z.string(), z.unknown()).optional() }))
            .nullable()
            .optional(),
          entityPlugins: z
            .array(z.object({ pluginId: z.string(), config: z.record(z.string(), z.unknown()).optional() }))
            .nullable()
            .optional(),
          defaultPropertyMappings: z
            .array(inputPropertyMappingSchema)
            .optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const values: Record<string, unknown> = {};
        if (input.propertyOverrides !== undefined) {
          values.property_overrides =
            input.propertyOverrides != null ? JSON.stringify(input.propertyOverrides) : null;
        }
        if (input.edgePropertyOverrides !== undefined) {
          values.edge_property_overrides =
            input.edgePropertyOverrides != null ? JSON.stringify(input.edgePropertyOverrides) : null;
        }
        if (input.instructions !== undefined) values.instructions = input.instructions;
        if (input.gather !== undefined) values.gather = input.gather;
        if (input.filters !== undefined) values.filters = JSON.stringify(input.filters);
        if (input.contentPlugins !== undefined) {
          values.content_plugins = input.contentPlugins != null ? JSON.stringify(input.contentPlugins) : null;
        }
        if (input.entityPlugins !== undefined) {
          values.entity_plugins = input.entityPlugins != null ? JSON.stringify(input.entityPlugins) : null;
        }
        if (input.defaultPropertyMappings !== undefined) {
          values.default_property_mappings = JSON.stringify(input.defaultPropertyMappings);
        }

        if (Object.keys(values).length === 0) throw new Error('No fields to update');

        const node = await getKnowledgeQb(['extraction_graph_node', 'extraction_graph'])
          .updateTable('extraction_graph_node')
          .set(values)
          .where('id', '=', input.id as ExtractionGraphNodeId)
          .where('extraction_graph_id', 'in', ($) =>
            $.selectFrom('extraction_graph as eg')
              .select('eg.id')
              .where('eg.team_id', '=', ctx.user.teamId as TeamId),
          )
          .returning(['id'])
          .executeTakeFirst();

        if (!node) throw new Error('Extraction graph node not found');
        return node;
      }),

    removeExtractionGraphEdge: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        // Get the edge to find the target node
        const edgeRow = await getKnowledgeQb(['extraction_graph_edge'])
          .selectFrom('extraction_graph_edge')
          .where('id', '=', input.id as ExtractionGraphEdgeId)
          .select(['id', 'target_node_id'])
          .executeTakeFirst();

        if (!edgeRow) throw new Error('Extraction graph edge not found');

        const result = await getKnowledgeQb(['extraction_graph_edge', 'extraction_graph'])
          .deleteFrom('extraction_graph_edge')
          .where('id', '=', input.id as ExtractionGraphEdgeId)
          .where('extraction_graph_id', 'in', ($) =>
            $.selectFrom('extraction_graph as eg')
              .select('eg.id')
              .where('eg.team_id', '=', ctx.user.teamId as TeamId),
          )
          .returning('id')
          .executeTakeFirst();

        if (!result) throw new Error('Extraction graph edge not found');

        // Clean up orphaned target node — only if not referenced by any other edge
        // (as target OR source) and not the root node
        const otherTargetRef = await getKnowledgeQb(['extraction_graph_edge'])
          .selectFrom('extraction_graph_edge')
          .where('target_node_id', '=', edgeRow.target_node_id)
          .select('id')
          .executeTakeFirst();

        const otherSourceRef = !otherTargetRef
          ? await getKnowledgeQb(['extraction_graph_edge'])
              .selectFrom('extraction_graph_edge')
              .where('source_node_id', '=', edgeRow.target_node_id)
              .select('id')
              .executeTakeFirst()
          : true; // skip check if already referenced

        if (!otherTargetRef && !otherSourceRef) {
          const isRoot = await getKnowledgeQb(['extraction_graph'])
            .selectFrom('extraction_graph')
            .where('root_node_id', '=', edgeRow.target_node_id)
            .select('id')
            .executeTakeFirst();

          if (!isRoot) {
            await getKnowledgeQb(['extraction_graph_node'])
              .deleteFrom('extraction_graph_node')
              .where('id', '=', edgeRow.target_node_id)
              .execute();
          }
        }

        return result;
      }),
  });
};

export { extractionGraphRouter };
