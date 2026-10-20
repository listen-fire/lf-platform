import { getTemplate } from './index';

import { Kysely } from 'kysely';

import type { Expression } from '#shared/expression/types';

import KnowledgeSchema from '../../../generated/kysely/knowledge/KnowledgeSchema';
import { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import { TeamId } from '../../../generated/kysely/core/Team';
import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import PropertyIdentity from '../../../generated/kysely/knowledge/PropertyIdentity';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import NodeTypeCategory from '../../../generated/kysely/knowledge/NodeTypeCategory';
import { OntologyTemplate, TemplateUniquenessConstraint } from './types';
import { getTemplateIcon } from './icons';


function resolveExpressionKeys(
  expr: Expression,
  propertyTypeIdMap: Map<string, PropertyTypeId>,
  edgeTypeIdMap: Map<string, EdgeTypeId>,
): Expression {
  if (expr.type === 'property') {
    const resolved = propertyTypeIdMap.get(expr.propertyTypeId);
    if (!resolved) throw new Error(`Uniqueness constraint references unknown property key: "${expr.propertyTypeId}"`);
    return { ...expr, propertyTypeId: resolved as string };
  }
  if (expr.type === 'traverse') {
    return {
      ...expr,
      steps: expr.steps.map((step) => {
        if (step.type === 'edge') {
          const resolved = edgeTypeIdMap.get(step.edgeTypeId);
          if (!resolved) throw new Error(`Uniqueness constraint references unknown edge key: "${step.edgeTypeId}"`);
          return { ...step, edgeTypeId: resolved as string };
        }
        return step;
      }),
      expression: resolveExpressionKeys(expr.expression, propertyTypeIdMap, edgeTypeIdMap),
    };
  }
  if (expr.type === 'function') {
    return { ...expr, args: expr.args.map((a) => resolveExpressionKeys(a, propertyTypeIdMap, edgeTypeIdMap)) };
  }
  if (expr.type === 'arithmetic') {
    return {
      ...expr,
      left: resolveExpressionKeys(expr.left, propertyTypeIdMap, edgeTypeIdMap),
      right: resolveExpressionKeys(expr.right, propertyTypeIdMap, edgeTypeIdMap),
    };
  }
  if (expr.type === 'concat') {
    return { ...expr, parts: expr.parts.map((p) => resolveExpressionKeys(p, propertyTypeIdMap, edgeTypeIdMap)) };
  }
  return expr;
}

function resolveConstraintKeys(
  constraints: TemplateUniquenessConstraint[],
  propertyTypeIdMap: Map<string, PropertyTypeId>,
  edgeTypeIdMap: Map<string, EdgeTypeId>,
): TemplateUniquenessConstraint[] {
  return constraints.map((constraint) =>
    constraint.map((entry) => ({
      ...entry,
      expr: resolveExpressionKeys(entry.expr, propertyTypeIdMap, edgeTypeIdMap),
    })),
  );
}

type MaterializeDb = Pick<KnowledgeSchema, 'node_type' | 'property_type' | 'edge_type'>;

type MaterializeResult = {
  nodeTypesCreated: number;
  propertyTypesCreated: number;
  edgeTypesCreated: number;
};

async function materializeTemplate(
  trx: Kysely<MaterializeDb>,
  teamId: TeamId,
  templateKey: string,
): Promise<MaterializeResult> {
  const template = getTemplate(templateKey);
  if (!template) {
    throw new Error(`Unknown template: ${templateKey}`);
  }

  return materialize(trx, teamId, template);
}

async function materialize(
  trx: Kysely<MaterializeDb>,
  teamId: TeamId,
  template: OntologyTemplate,
): Promise<MaterializeResult> {
  // 1. Insert all node types, build key → id map
  const nodeTypeIdMap = new Map<string, NodeTypeId>();
  const categoryMap: Record<string, NodeTypeCategory> = {
    message: NodeTypeCategory.message,
    object: NodeTypeCategory.object,
  };

  for (let i = 0; i < template.nodeTypes.length; i++) {
    const nt = template.nodeTypes[i];
    const row = await trx
      .insertInto('node_type')
      .values({
        team_id: teamId,
        name: nt.name,
        description: nt.description,
        category: categoryMap[nt.category],
        icon_svg: nt.iconSvg ?? getTemplateIcon(nt.key) ?? null,
        display_name_template: nt.displayNameTemplate ?? null,
        sort_order: i,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    nodeTypeIdMap.set(nt.key, row.id);
  }

  // 2. Insert property types per node type from inline definitions
  const propertyTypeIdMap = new Map<string, PropertyTypeId>();
  let propertyTypesCreated = 0;

  for (const nt of template.nodeTypes) {
    const nodeTypeId = nodeTypeIdMap.get(nt.key)!;

    for (let pi = 0; pi < nt.properties.length; pi++) {
      const p = nt.properties[pi];
      const row = await trx
        .insertInto('property_type')
        .values({
          team_id: teamId,
          node_type_id: nodeTypeId,
          name: p.name,
          description: p.description,
          value_type: p.valueType,
          identity: PropertyIdentity.none,
          evaluation_strategy: p.evaluationStrategy,
          cardinality: p.cardinality,
          enum_values: p.enumValues ?? null,
          sort_order: pi,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      propertyTypeIdMap.set(p.key, row.id);
      propertyTypesCreated++;
    }
  }

  // 3. Auto-create Role property type for node types referenced by edges with Role filters
  // Collect distinct Role values per node type from filters
  const roleValuesByNodeType = new Map<string, Set<string>>();
  for (const et of template.edgeTypes) {
    for (const f of et.filters ?? []) {
      if (f.property === 'Role') {
        const ntKey = f.side === 'source' ? et.source : et.target;
        const vals = roleValuesByNodeType.get(ntKey) ?? new Set();
        vals.add(f.value);
        roleValuesByNodeType.set(ntKey, vals);
      }
    }
  }

  for (const ntKey of roleValuesByNodeType.keys()) {
    const roleKey = `${ntKey}__role`;
    if (propertyTypeIdMap.has(roleKey)) continue;

    const nodeTypeId = nodeTypeIdMap.get(ntKey);
    if (!nodeTypeId) continue;

    const roleEnumValues = [...(roleValuesByNodeType.get(ntKey) ?? [])];
    // Find how many explicit properties this node type already has, so Role sorts after them
    const existingPropCount = template.nodeTypes.find((n) => n.key === ntKey)?.properties.length ?? 0;
    const row = await trx
      .insertInto('property_type')
      .values({
        team_id: teamId,
        node_type_id: nodeTypeId,
        name: 'Role',
        description: `The role this ${ntKey} plays in the current context`,
        value_type: PropertyValueType.text,
        identity: PropertyIdentity.none,
        evaluation_strategy: EvaluationStrategy.latest,
        enum_values: roleEnumValues.length > 0 ? roleEnumValues : null,
        sort_order: existingPropCount,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    propertyTypeIdMap.set(roleKey, row.id);
    propertyTypesCreated++;
  }

  // 4. Insert all edge types with filters JSON
  const edgeTypeIdMap = new Map<string, EdgeTypeId>();

  for (let ei = 0; ei < template.edgeTypes.length; ei++) {
    const et = template.edgeTypes[ei];
    const sourceId = nodeTypeIdMap.get(et.source);
    const targetId = nodeTypeIdMap.get(et.target);
    if (!sourceId || !targetId) {
      throw new Error(
        `Edge type "${et.key}" references unknown node types: source="${et.source}", target="${et.target}"`,
      );
    }

    const row = await trx
      .insertInto('edge_type')
      .values({
        team_id: teamId,
        outbound_name: et.outboundName,
        inbound_name: et.inboundName,
        description: et.description,
        source_node_type_id: sourceId,
        target_node_type_id: targetId,
        required: et.required,
        scopes: false,
        filters: JSON.stringify(et.filters ?? []),
        edge_group: et.group ?? null,
        sort_order: ei,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    edgeTypeIdMap.set(et.key, row.id);
  }

  // 4b. Insert property types for edge types
  for (const et of template.edgeTypes) {
    if (!et.properties?.length) continue;
    const edgeTypeId = edgeTypeIdMap.get(et.key)!;

    for (let pi = 0; pi < et.properties.length; pi++) {
      const p = et.properties[pi];
      const row = await trx
        .insertInto('property_type')
        .values({
          team_id: teamId,
          edge_type_id: edgeTypeId,
          name: p.name,
          description: p.description,
          value_type: p.valueType,
          identity: PropertyIdentity.none,
          evaluation_strategy: p.evaluationStrategy,
          cardinality: p.cardinality,
          enum_values: p.enumValues ?? null,
          sort_order: pi,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      propertyTypeIdMap.set(`${et.key}.${p.key}`, row.id);
      propertyTypesCreated++;
    }
  }

  // 4c. Resolve uniqueness constraints: replace template keys with real UUIDs and write to node_type
  for (const nt of template.nodeTypes) {
    if (!nt.unique?.length) continue;
    const nodeTypeId = nodeTypeIdMap.get(nt.key)!;
    const resolved = resolveConstraintKeys(nt.unique, propertyTypeIdMap, edgeTypeIdMap);
    await trx
      .updateTable('node_type')
      .set({ uniqueness_constraints: JSON.stringify(resolved) })
      .where('id', '=', nodeTypeId)
      .execute();
  }

  // 4d. Resolve display name expressions: replace template keys with real UUIDs and write to node_type
  for (const nt of template.nodeTypes) {
    if (!nt.displayNameExpression) continue;
    const nodeTypeId = nodeTypeIdMap.get(nt.key)!;
    const resolved = resolveExpressionKeys(nt.displayNameExpression, propertyTypeIdMap, edgeTypeIdMap);
    await trx
      .updateTable('node_type')
      .set({ display_name_expression: JSON.stringify(resolved) })
      .where('id', '=', nodeTypeId)
      .execute();
  }

  return {
    nodeTypesCreated: template.nodeTypes.length,
    propertyTypesCreated,
    edgeTypesCreated: template.edgeTypes.length,
  };
}

export { materializeTemplate };
export type { MaterializeResult };
