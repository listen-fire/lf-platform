import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { currentPrincipal } from 'principal';

import { getKnowledgeQb } from '../../../../lib/kysely';
import { mq } from '../../../../lib/message_queue';
import { currentContext } from '../../../../services/context';
import { trpc } from '../../trpc';
import { userProcedure as sharedUserProcedure } from '../../procedures';
import { TeamId } from '../../../../generated/kysely/core/Team';
import { NodeTypeId } from '../../../../generated/kysely/knowledge/NodeType';
import { EdgeTypeId } from '../../../../generated/kysely/knowledge/EdgeType';
import { PropertyTypeId } from '../../../../generated/kysely/knowledge/PropertyType';
import NodeTypeCategory from '../../../../generated/kysely/knowledge/NodeTypeCategory';
import PropertyValueType from '../../../../generated/kysely/knowledge/PropertyValueType';
import PropertyIdentity from '../../../../generated/kysely/knowledge/PropertyIdentity';
import EvaluationStrategy from '../../../../generated/kysely/knowledge/EvaluationStrategy';
import PropertyCardinality from '../../../../generated/kysely/knowledge/PropertyCardinality';
import EvidenceType from '../../../../generated/kysely/knowledge/EvidenceType';
import { templates } from '../../../../lib/knowledge/templates';
import { materializeTemplate } from '../../../../lib/knowledge/templates/materialize';
import { generateIconSvg } from '../../../../lib/knowledge/generate_icon';
import { parseEnumArray } from '../../../../lib/knowledge/writable_by';

const edgeFilterSchema = z.object({
  side: z.enum(['source', 'target']),
  property: z.string(),
  value: z.string(),
});

const nodeTypeInput = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.nativeEnum(NodeTypeCategory),
});

const edgeTypeInput = z.object({
  outboundName: z.string().min(1),
  inboundName: z.string().min(1),
  description: z.string().default(''),
  sourceNodeTypeId: z.string(),
  targetNodeTypeId: z.string(),
  required: z.boolean().default(false),
  scopes: z.boolean().default(false),
  filters: z.array(edgeFilterSchema).default([]),
  edgeGroup: z.string().nullable().optional(),
});

const propertyTypeInput = z.object({
  nodeTypeId: z.string().optional(),
  edgeTypeId: z.string().optional(),
  name: z.string().min(1),
  description: z.string().default(''),
  valueType: z.nativeEnum(PropertyValueType),
  // Legacy — superseded by node-type uniqueness constraints and ignored
  // by every current consumer. Accepted for wire-compat, defaulted dead.
  identity: z.nativeEnum(PropertyIdentity).default(PropertyIdentity.none),
  evaluationStrategy: z.nativeEnum(EvaluationStrategy),
  cardinality: z.nativeEnum(PropertyCardinality).default(PropertyCardinality.single),
  enumValues: z.array(z.string()).nullable().default(null),
  writableBy: z.array(z.nativeEnum(EvidenceType)).nullable().default(null),
});

/**
 * The tenant this call acts in, read off the Principal rather than through
 * `Context.user`. `user` is user-SHAPED and throws when there is no user, and a
 * machine principal — an api key minted for a service, or the static
 * single-tenant stub a knowledge-only deployment boots with — has none by
 * design (D2). Every read and write in this router wants a TEAM and never a
 * person, so asking for a user turned the whole ontology surface into a
 * "Missing user" 500 in exactly the standalone boot this product exists to
 * prove.
 *
 * Safe inside these procedures because `userProcedure` installs the ambient
 * Principal around the resolver. The subscription below is the one caller that
 * runs outside it (it authorises itself over the websocket, where identity is
 * parked on the Context rather than made ambient), so it still reads the
 * Context.
 */
function actingTeamId(): TeamId {
  return currentPrincipal().teamId as TeamId;
}

const ontologyRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure)
    // Any MUTATION through this router IS an ontology edit — emit a
    // resource-change hint (source: user) so open /model pages refresh.
    // Queries pass through untouched. The agent's ontology edits emit
    // separately (its tools have no shared service with this router).
    .use(async ({ next, type }) => {
      const result = await next();
      if (type === 'mutation' && result.ok) {
        const ctx = currentContext();
        const originId = ctx.originId;
        mq.resourceChanges.changed
          .publish({
            kind: 'ontology',
            teamId: actingTeamId(),
            source: 'user',
            action: 'ontology-edit',
            ...(originId ? { originId } : {}),
          })
          .catch(() => {});
      }
      return result;
    });

  return trpc.router({
    /**
     * Live "something changed" hint — pages subscribe and refresh.
     * Source-agnostic (agent / user / api / pipeline); team-scoped (the
     * direct exchange routes by teamId, re-checked on receipt). `kinds`
     * lets a page hear only what it cares about.
     */
    onResourceChange: procedure
      .input(z.object({ kinds: z.array(z.enum(['ontology', 'movement', 'kg-data'])).optional() }))
      .subscription(async ({ ctx: { authorise }, input }) => {
        await authorise();
        const teamId = currentContext().user.teamId as unknown as string;
        const queue = mq.resourceChanges
          .node({ name: `resourceChange.changed.teamId.${teamId}`, type: 'queue' })
          .attachTo(mq.resourceChanges.changedByTeamId);
        const kinds = input.kinds ? new Set(input.kinds) : null;
        // Inlined rather than imported from the queue module: pulling a
        // type out of message_queue/queues into a router file drags the
        // native MQ (→ node:stream) into the tRPC dts bundle, which the
        // dts-resolve build can't handle. Shape mirrors ResourceChangeEvent.
        type ChangeEvt = {
          kind: 'ontology' | 'movement' | 'kg-data';
          teamId: string;
          source: 'agent' | 'user' | 'api' | 'pipeline';
          action: string;
          resourceId?: string;
          originId?: string;
        };
        return observable<ChangeEvt>((emit) => {
          const onMessage = (evt: ChangeEvt) => {
            if (evt.teamId !== teamId) return;
            if (kinds && !kinds.has(evt.kind)) return;
            emit.next(evt);
          };
          queue.on('message', onMessage);
          return () => queue.off('message', onMessage);
        });
      }),

    getNodeTypes: userProcedure.query(async () => {
      const nodeTypes = await getKnowledgeQb(['node_type'])
        .selectFrom('node_type')
        .where('team_id', '=', actingTeamId())
        .select([
          'id',
          'name',
          'description',
          'category',
          'sort_order',
          'display_name_template',
          'display_name_expression',
          'created_at',
          'updated_at',
        ])
        .orderBy('sort_order asc')
        .orderBy('name asc')
        .execute();

      return nodeTypes;
    }),

    getNodeType: userProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const nodeType = await getKnowledgeQb(['node_type'])
          .selectFrom('node_type')
          .where('id', '=', input.id as NodeTypeId)
          .where('team_id', '=', actingTeamId())
          .select([
            'id',
            'name',
            'description',
            'category',
            'display_name_template',
            'display_name_expression',
            'created_at',
            'updated_at',
          ])
          .executeTakeFirst();

        if (!nodeType) throw new Error('Node type not found');
        return nodeType;
      }),

    createNodeType: userProcedure
      .input(nodeTypeInput)
      .mutation(async ({ input }) => {
        const nodeType = await getKnowledgeQb(['node_type'])
          .insertInto('node_type')
          .values({
            team_id: actingTeamId(),
            name: input.name,
            description: input.description,
            category: input.category,
          })
          .returning(['id', 'name', 'category'])
          .executeTakeFirstOrThrow();

        return nodeType;
      }),

    updateNodeType: userProcedure
      .input(
        z.object({ id: z.string() })
          .merge(nodeTypeInput.partial())
          .extend({
            displayNameTemplate: z.string().nullable().optional(),
            displayNameExpression: z.any().nullable().optional(),
            uniquenessConstraints: z.any().nullable().optional(),
          }),
      )
      .mutation(async ({ input }) => {
        const { id, displayNameTemplate, displayNameExpression, uniquenessConstraints, ...updates } = input;

        const values: Record<string, unknown> = { updated_at: new Date() };
        if (updates.name !== undefined) values.name = updates.name;
        if (updates.description !== undefined) values.description = updates.description;
        if (updates.category !== undefined) values.category = updates.category;
        if (displayNameTemplate !== undefined) values.display_name_template = displayNameTemplate;
        if (displayNameExpression !== undefined) values.display_name_expression = displayNameExpression === null ? null : JSON.stringify(displayNameExpression);
        if (uniquenessConstraints !== undefined) values.uniqueness_constraints = uniquenessConstraints === null ? null : JSON.stringify(uniquenessConstraints);

        const nodeType = await getKnowledgeQb(['node_type'])
          .updateTable('node_type')
          .set(values)
          .where('id', '=', id as NodeTypeId)
          .where('team_id', '=', actingTeamId())
          .returning(['id', 'name', 'category'])
          .executeTakeFirst();

        if (!nodeType) throw new Error('Node type not found');
        return nodeType;
      }),

    deleteNodeType: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const result = await getKnowledgeQb(['node_type'])
          .deleteFrom('node_type')
          .where('id', '=', input.id as NodeTypeId)
          .where('team_id', '=', actingTeamId())
          .returning('id')
          .executeTakeFirst();

        if (!result) throw new Error('Node type not found');
        return result;
      }),

    // -- Property types --

    getPropertyTypes: userProcedure
      .input(z.object({ nodeTypeId: z.string().optional(), edgeTypeId: z.string().optional() }))
      .query(async ({ input }) => {
        let query = getKnowledgeQb(['property_type'])
          .selectFrom('property_type')
          .where('team_id', '=', actingTeamId())
          .select([
            'id',
            'node_type_id',
            'edge_type_id',
            'name',
            'description',
            'value_type',
            'identity',
            'evaluation_strategy',
            'enum_values',
            'cardinality',
            'writable_by',
            'sort_order',
            'created_at',
            'updated_at',
          ])
          .orderBy('sort_order asc')
          .orderBy('name asc');

        if (input.edgeTypeId) {
          query = query.where('edge_type_id', '=', input.edgeTypeId as EdgeTypeId);
        } else if (input.nodeTypeId) {
          query = query.where('node_type_id', '=', input.nodeTypeId as NodeTypeId);
        }

        const rows = await query.execute();
        return rows.map((pt) => ({ ...pt, writable_by: parseEnumArray(pt.writable_by) }));
      }),

    createPropertyType: userProcedure
      .input(propertyTypeInput)
      .mutation(async ({ input }) => {
        const qb = getKnowledgeQb(['property_type']);

        // Append to end: find current max sort_order for the parent
        let maxQuery = qb
          .selectFrom('property_type')
          .select(({ fn }) => fn.max('sort_order').as('max_order'))
          .where('team_id', '=', actingTeamId());
        if (input.nodeTypeId) {
          maxQuery = maxQuery.where('node_type_id', '=', input.nodeTypeId as NodeTypeId);
        } else if (input.edgeTypeId) {
          maxQuery = maxQuery.where('edge_type_id', '=', input.edgeTypeId as EdgeTypeId);
        }
        const maxResult = await maxQuery.executeTakeFirst();
        const nextOrder = ((maxResult?.max_order as number | null) ?? -1) + 1;

        return getKnowledgeQb(['property_type'])
          .insertInto('property_type')
          .values({
            team_id: actingTeamId(),
            node_type_id: input.nodeTypeId ? input.nodeTypeId as NodeTypeId : undefined,
            edge_type_id: input.edgeTypeId ? input.edgeTypeId as EdgeTypeId : undefined,
            name: input.name,
            description: input.description,
            value_type: input.valueType,
            identity: input.identity,
            evaluation_strategy: input.evaluationStrategy,
            cardinality: input.cardinality,
            enum_values: input.enumValues,
            writable_by: input.writableBy,
            sort_order: nextOrder,
          })
          .returning(['id', 'name', 'node_type_id', 'edge_type_id'])
          .executeTakeFirstOrThrow();
      }),

    updatePropertyType: userProcedure
      .input(z.object({ id: z.string() }).merge(propertyTypeInput.partial()))
      .mutation(async ({ input }) => {
        const { id, ...updates } = input;

        const values: Record<string, unknown> = { updated_at: new Date() };
        if (updates.name !== undefined) values.name = updates.name;
        if (updates.description !== undefined) values.description = updates.description;
        if (updates.valueType !== undefined) values.value_type = updates.valueType;
        if (updates.identity !== undefined) values.identity = updates.identity;
        if (updates.evaluationStrategy !== undefined) values.evaluation_strategy = updates.evaluationStrategy;
        if (updates.cardinality !== undefined) values.cardinality = updates.cardinality;
        if (updates.enumValues !== undefined) values.enum_values = updates.enumValues;
        if (updates.writableBy !== undefined) values.writable_by = updates.writableBy;

        return getKnowledgeQb(['property_type'])
          .updateTable('property_type')
          .set(values)
          .where('id', '=', id as PropertyTypeId)
          .where('team_id', '=', actingTeamId())
          .returning(['id', 'name', 'node_type_id'])
          .executeTakeFirstOrThrow();
      }),

    deletePropertyType: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        return getKnowledgeQb(['property_type'])
          .deleteFrom('property_type')
          .where('id', '=', input.id as PropertyTypeId)
          .where('team_id', '=', actingTeamId())
          .returning('id')
          .executeTakeFirstOrThrow();
      }),

    reorderPropertyTypes: userProcedure
      .input(z.object({ ids: z.array(z.string()) }))
      .mutation(async ({ input }) => {
        const qb = getKnowledgeQb(['property_type']);
        await Promise.all(
          input.ids.map((id, index) =>
            qb
              .updateTable('property_type')
              .set({ sort_order: index, updated_at: new Date() })
              .where('id', '=', id as PropertyTypeId)
              .where('team_id', '=', actingTeamId())
              .execute(),
          ),
        );
        return { success: true };
      }),

    // -- Edge types --

    getEdgeTypes: userProcedure.query(async () => {
      const edgeTypes = await getKnowledgeQb(['edge_type', 'node_type'])
        .selectFrom('edge_type as et')
        .leftJoin('node_type as snt', 'snt.id', 'et.source_node_type_id')
        .leftJoin('node_type as tnt', 'tnt.id', 'et.target_node_type_id')
        .where('et.team_id', '=', actingTeamId())
        .select([
          'et.id',
          'et.outbound_name',
          'et.inbound_name',
          'et.description',
          'et.source_node_type_id',
          'et.target_node_type_id',
          'et.required',
          'et.scopes',
          'et.filters',
          'et.edge_group',
          'et.sort_order',
          'snt.name as source_node_type_name',
          'tnt.name as target_node_type_name',
          'et.created_at',
          'et.updated_at',
        ])
        .orderBy('et.sort_order asc')
        .orderBy('et.outbound_name asc')
        .execute();

      return edgeTypes;
    }),

    getEdgeType: userProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const edgeType = await getKnowledgeQb(['edge_type', 'node_type'])
          .selectFrom('edge_type as et')
          .leftJoin('node_type as snt', 'snt.id', 'et.source_node_type_id')
          .leftJoin('node_type as tnt', 'tnt.id', 'et.target_node_type_id')
          .where('et.id', '=', input.id as EdgeTypeId)
          .where('et.team_id', '=', actingTeamId())
          .select([
            'et.id',
            'et.outbound_name',
            'et.inbound_name',
            'et.description',
            'et.source_node_type_id',
            'et.target_node_type_id',
            'et.required',
            'et.scopes',
            'et.filters',
            'et.edge_group',
            'snt.name as source_node_type_name',
            'tnt.name as target_node_type_name',
            'et.created_at',
            'et.updated_at',
          ])
          .executeTakeFirst();

        if (!edgeType) throw new Error('Edge type not found');
        return edgeType;
      }),

    createEdgeType: userProcedure
      .input(edgeTypeInput)
      .mutation(async ({ input }) => {
        const edgeType = await getKnowledgeQb(['edge_type'])
          .insertInto('edge_type')
          .values({
            team_id: actingTeamId(),
            outbound_name: input.outboundName,
            inbound_name: input.inboundName,
            description: input.description,
            source_node_type_id: input.sourceNodeTypeId as NodeTypeId,
            target_node_type_id: input.targetNodeTypeId as NodeTypeId,
            required: input.required,
            scopes: input.scopes,
            filters: JSON.stringify(input.filters),
            edge_group: input.edgeGroup ?? null,
          })
          .returning(['id', 'outbound_name', 'inbound_name'])
          .executeTakeFirstOrThrow();

        return edgeType;
      }),

    updateEdgeType: userProcedure
      .input(z.object({ id: z.string() }).merge(edgeTypeInput.partial()))
      .mutation(async ({ input }) => {
        const { id, ...updates } = input;

        const values: Record<string, unknown> = { updated_at: new Date() };
        if (updates.outboundName !== undefined) values.outbound_name = updates.outboundName;
        if (updates.inboundName !== undefined) values.inbound_name = updates.inboundName;
        if (updates.description !== undefined) values.description = updates.description;
        if (updates.sourceNodeTypeId !== undefined)
          values.source_node_type_id = updates.sourceNodeTypeId;
        if (updates.targetNodeTypeId !== undefined)
          values.target_node_type_id = updates.targetNodeTypeId;
        if (updates.required !== undefined) values.required = updates.required;
        if (updates.scopes !== undefined) values.scopes = updates.scopes;
        if (updates.filters !== undefined) values.filters = JSON.stringify(updates.filters);
        if (updates.edgeGroup !== undefined) values.edge_group = updates.edgeGroup;

        const edgeType = await getKnowledgeQb(['edge_type'])
          .updateTable('edge_type')
          .set(values)
          .where('id', '=', id as EdgeTypeId)
          .where('team_id', '=', actingTeamId())
          .returning(['id', 'outbound_name', 'inbound_name'])
          .executeTakeFirst();

        if (!edgeType) throw new Error('Edge type not found');
        return edgeType;
      }),

    deleteEdgeType: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const result = await getKnowledgeQb(['edge_type'])
          .deleteFrom('edge_type')
          .where('id', '=', input.id as EdgeTypeId)
          .where('team_id', '=', actingTeamId())
          .returning('id')
          .executeTakeFirst();

        if (!result) throw new Error('Edge type not found');
        return result;
      }),

    // -- Edge groups (multi-target relationships) --

    createEdgeGroup: userProcedure
      .input(z.object({
        name: z.string().min(1),
        description: z.string().default(''),
        sourceNodeTypeId: z.string(),
        targetNodeTypeIds: z.array(z.string()).min(1),
        required: z.boolean().default(false),
        scopes: z.boolean().default(false),
      }))
      .mutation(async ({ input }) => {
        const teamId = actingTeamId();

        const targetNodeTypes = await getKnowledgeQb(['node_type'])
          .selectFrom('node_type')
          .where('id', 'in', input.targetNodeTypeIds.map((id) => id as NodeTypeId))
          .where('team_id', '=', teamId)
          .select(['id', 'name'])
          .execute();

        const created = [];
        for (const tnt of targetNodeTypes) {
          const suffix = tnt.name.toLowerCase().replace(/ /g, '_');
          const row = await getKnowledgeQb(['edge_type'])
            .insertInto('edge_type')
            .values({
              team_id: teamId,
              outbound_name: `${input.name}_${suffix}`,
              inbound_name: `${input.name}_${suffix}`,
              description: input.description,
              source_node_type_id: input.sourceNodeTypeId as NodeTypeId,
              target_node_type_id: tnt.id,
              required: input.required,
              scopes: input.scopes,
              filters: JSON.stringify([]),
              edge_group: input.name,
            })
            .returning(['id', 'outbound_name', 'inbound_name'])
            .executeTakeFirstOrThrow();
          created.push(row);
        }

        return created;
      }),

    updateEdgeGroup: userProcedure
      .input(z.object({
        edgeGroup: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        required: z.boolean().optional(),
        scopes: z.boolean().optional(),
        targetNodeTypeIds: z.array(z.string()).optional(),
      }))
      .mutation(async ({ input }) => {
        const teamId = actingTeamId();

        const members = await getKnowledgeQb(['edge_type'])
          .selectFrom('edge_type')
          .where('edge_group', '=', input.edgeGroup)
          .where('team_id', '=', teamId)
          .select(['id', 'outbound_name', 'target_node_type_id', 'source_node_type_id'])
          .execute();

        if (members.length === 0) throw new Error('Edge group not found');

        const sourceNodeTypeId = members[0].source_node_type_id;

        // Update shared fields on all members
        const sharedValues: Record<string, unknown> = { updated_at: new Date() };
        if (input.description !== undefined) sharedValues.description = input.description;
        if (input.required !== undefined) sharedValues.required = input.required;
        if (input.scopes !== undefined) sharedValues.scopes = input.scopes;

        const newGroupName = input.name ?? input.edgeGroup;
        if (input.name !== undefined) sharedValues.edge_group = input.name;

        if (Object.keys(sharedValues).length > 1) {
          await getKnowledgeQb(['edge_type'])
            .updateTable('edge_type')
            .set(sharedValues)
            .where('edge_group', '=', input.edgeGroup)
            .where('team_id', '=', teamId)
            .execute();
        }

        // Handle target changes
        if (input.targetNodeTypeIds !== undefined) {
          const currentTargetIds = new Set(members.map((m) => m.target_node_type_id));
          const desiredTargetIds = new Set(input.targetNodeTypeIds);

          // Delete removed targets
          for (const member of members) {
            if (!desiredTargetIds.has(member.target_node_type_id)) {
              await getKnowledgeQb(['edge_type'])
                .deleteFrom('edge_type')
                .where('id', '=', member.id)
                .where('team_id', '=', teamId)
                .execute();
            }
          }

          // Add new targets
          const toAdd = input.targetNodeTypeIds.filter((id) => !currentTargetIds.has(id as NodeTypeId));
          if (toAdd.length > 0) {
            const targetNodeTypes = await getKnowledgeQb(['node_type'])
              .selectFrom('node_type')
              .where('id', 'in', toAdd.map((id) => id as NodeTypeId))
              .where('team_id', '=', teamId)
              .select(['id', 'name'])
              .execute();

            const firstMember = members[0];
            for (const tnt of targetNodeTypes) {
              const suffix = tnt.name.toLowerCase().replace(/ /g, '_');
              await getKnowledgeQb(['edge_type'])
                .insertInto('edge_type')
                .values({
                  team_id: teamId,
                  outbound_name: `${newGroupName}_${suffix}`,
                  inbound_name: `${newGroupName}_${suffix}`,
                  description: input.description ?? firstMember.outbound_name,
                  source_node_type_id: sourceNodeTypeId,
                  target_node_type_id: tnt.id,
                  required: input.required ?? false,
                  scopes: input.scopes ?? false,
                  filters: JSON.stringify([]),
                  edge_group: newGroupName,
                })
                .execute();
            }
          }
        }

        // Rename individual edge names if group name changed
        if (input.name !== undefined && input.name !== input.edgeGroup) {
          const updatedMembers = await getKnowledgeQb(['edge_type', 'node_type'])
            .selectFrom('edge_type as et')
            .leftJoin('node_type as tnt', 'tnt.id', 'et.target_node_type_id')
            .where('et.edge_group', '=', input.name)
            .where('et.team_id', '=', teamId)
            .select(['et.id', 'tnt.name as target_name'])
            .execute();

          for (const m of updatedMembers) {
            const suffix = (m.target_name ?? '').toLowerCase().replace(/ /g, '_');
            await getKnowledgeQb(['edge_type'])
              .updateTable('edge_type')
              .set({ outbound_name: `${input.name}_${suffix}`, inbound_name: `${input.name}_${suffix}` })
              .where('id', '=', m.id)
              .execute();
          }
        }

        return { ok: true };
      }),

    deleteEdgeGroup: userProcedure
      .input(z.object({ edgeGroup: z.string() }))
      .mutation(async ({ input }) => {
        const result = await getKnowledgeQb(['edge_type'])
          .deleteFrom('edge_type')
          .where('edge_group', '=', input.edgeGroup)
          .where('team_id', '=', actingTeamId())
          .execute();

        return { deleted: Number(result[0]?.numDeletedRows ?? 0) };
      }),

    getOntologySummary: userProcedure.query(async () => {
      const teamId = actingTeamId();

      const [nodeTypes, edgeTypes, propertyTypes] = await Promise.all([
        getKnowledgeQb(['node_type'])
          .selectFrom('node_type')
          .where('team_id', '=', teamId)
          .select([
            'id',
            'name',
            'description',
            'category',
            'icon_svg',
            'display_name_template',
            'display_name_expression',
            'uniqueness_constraints',
            'sort_order',
          ])
          .orderBy('sort_order asc')
          .orderBy('name asc')
          .execute(),
        getKnowledgeQb(['edge_type'])
          .selectFrom('edge_type')
          .where('team_id', '=', teamId)
          .select([
            'id',
            'outbound_name',
            'inbound_name',
            'description',
            'source_node_type_id',
            'target_node_type_id',
            'required',
            'scopes',
            'filters',
            'edge_group',
            'sort_order',
          ])
          .orderBy('sort_order asc')
          .orderBy('outbound_name asc')
          .execute(),
        getKnowledgeQb(['property_type'])
          .selectFrom('property_type')
          .where('team_id', '=', teamId)
          .select([
            'id',
            'node_type_id',
            'edge_type_id',
            'name',
            'description',
            'value_type',
            'identity',
            'evaluation_strategy',
            'enum_values',
            'cardinality',
            'writable_by',
            'sort_order',
          ])
          .orderBy('sort_order asc')
          .orderBy('name asc')
          .execute(),
      ]);

      return {
        nodeTypes,
        edgeTypes,
        propertyTypes: propertyTypes.map((pt) => ({
          ...pt,
          writable_by: parseEnumArray(pt.writable_by),
        })),
      };
    }),

    getTemplates: userProcedure.query(() => {
      return templates.map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        preview: t.preview,
      }));
    }),

    materializeTemplate: userProcedure
      .input(z.object({ templateKey: z.string() }))
      .mutation(async ({ input }) => {
        const teamId = actingTeamId();

        const qb = getKnowledgeQb(['node_type', 'property_type', 'edge_type']);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await qb.transaction().execute((trx: any) =>
          materializeTemplate(trx, teamId, input.templateKey),
        );

        return result;
      }),

    generateNodeIcon: userProcedure
      .input(z.object({ nodeTypeId: z.string() }))
      .mutation(async ({ input }) => {
        const teamId = actingTeamId();

        const nodeType = await getKnowledgeQb(['node_type'])
          .selectFrom('node_type')
          .where('id', '=', input.nodeTypeId as NodeTypeId)
          .where('team_id', '=', teamId)
          .select(['id', 'name', 'description', 'category', 'icon_svg'])
          .executeTakeFirst();

        if (!nodeType) throw new Error('Node type not found');

        // Return cached if already generated
        if (nodeType.icon_svg) return { svg: nodeType.icon_svg };

        // Fetch existing icons for dedup
        const existingIcons = await getKnowledgeQb(['node_type'])
          .selectFrom('node_type')
          .where('team_id', '=', teamId)
          .where('icon_svg', 'is not', null)
          .where('icon_metaphor', 'is not', null)
          .select(['name', 'icon_metaphor'])
          .execute();

        const { svg, metaphor } = await generateIconSvg({
          name: nodeType.name,
          description: nodeType.description,
          existingIcons: existingIcons.map((i) => ({ name: i.name, metaphor: i.icon_metaphor! })),
        });

        await getKnowledgeQb(['node_type'])
          .updateTable('node_type')
          .set({ icon_svg: svg, icon_metaphor: metaphor, updated_at: new Date() })
          .where('id', '=', nodeType.id)
          .where('team_id', '=', teamId)
          .execute();

        return { svg };
      }),
  });
};

export { ontologyRouter };
