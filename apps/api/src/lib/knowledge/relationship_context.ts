import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { EdgeTypeId } from '../../generated/kysely/knowledge/EdgeType';
import type { TeamId } from '../../generated/kysely/core/Team';

import { resolveDisplayNames } from './resolve_display_name';
import { getKnowledgeQb } from '../kysely';

// -- Types --

interface EdgeTypeMeta {
  outboundName: string;
  inboundName: string;
  sourceNodeTypeId: NodeTypeId;
  targetNodeTypeId: NodeTypeId;
}

type EdgeTypeMetaMap = Map<string, EdgeTypeMeta>;

interface RelationshipEntry {
  edgeName: string;
  targetName: string;
  edgeProperties?: Record<string, unknown>;
}

interface EntityContext {
  properties: Record<string, unknown>;
  relationships: RelationshipEntry[];
}

const CAP_PER_EDGE_TYPE = 5;

// -- Metadata loaders --

async function loadEdgeTypeMeta(options: {
  edgeTypeIds: string[];
  teamId: TeamId;
}): Promise<EdgeTypeMetaMap> {
  const { edgeTypeIds, teamId } = options;
  if (!edgeTypeIds.length) return new Map();

  const rows = await getKnowledgeQb(['edge_type'])
    .selectFrom('edge_type')
    .where('edge_type.id', 'in', edgeTypeIds as EdgeTypeId[])
    .where('edge_type.team_id', '=', teamId)
    .select([
      'edge_type.id',
      'edge_type.outbound_name',
      'edge_type.inbound_name',
      'edge_type.source_node_type_id',
      'edge_type.target_node_type_id',
    ])
    .execute();

  const map: EdgeTypeMetaMap = new Map();
  for (const row of rows) {
    map.set(row.id as string, {
      outboundName: row.outbound_name,
      inboundName: row.inbound_name,
      sourceNodeTypeId: row.source_node_type_id as NodeTypeId,
      targetNodeTypeId: row.target_node_type_id as NodeTypeId,
    });
  }
  return map;
}

// -- Direction helper --

function orientEdgeName(
  edgeTypeMeta: EdgeTypeMeta,
  entityIsSource: boolean,
): string {
  const name = entityIsSource ? edgeTypeMeta.outboundName : edgeTypeMeta.inboundName;
  return name.replace(/_/g, ' ');
}

// -- Build from DB --

async function buildRelationshipContextFromDb(options: {
  nodeId: NodeId;
  teamId: TeamId;
  edgeTypeMeta?: EdgeTypeMetaMap;
}): Promise<RelationshipEntry[]> {
  const { nodeId, teamId } = options;
  const qb = getKnowledgeQb(['edge', 'property', 'property_type']);

  // Fetch all edges involving this node
  const edges = await qb
    .selectFrom('edge')
    .where((eb) =>
      eb.or([
        eb('edge.source_node_id', '=', nodeId),
        eb('edge.target_node_id', '=', nodeId),
      ]),
    )
    .select(['edge.id', 'edge.source_node_id', 'edge.target_node_id', 'edge.edge_type_id'])
    .execute();

  if (!edges.length) return [];

  // Load edge type meta if not provided
  const edgeTypeIds = [...new Set(edges.map((e) => e.edge_type_id as string))];
  const meta = options.edgeTypeMeta ?? await loadEdgeTypeMeta({ edgeTypeIds, teamId });

  // Group by edge type and cap
  const byEdgeType = new Map<string, typeof edges>();
  for (const edge of edges) {
    const key = edge.edge_type_id as string;
    const arr = byEdgeType.get(key) ?? [];
    arr.push(edge);
    byEdgeType.set(key, arr);
  }

  // Collect neighbor IDs and track overflow counts
  const selectedEdges: typeof edges = [];
  const overflowByEdgeType = new Map<string, number>();

  for (const [etId, edgesOfType] of byEdgeType) {
    if (edgesOfType.length > CAP_PER_EDGE_TYPE) {
      selectedEdges.push(...edgesOfType.slice(0, CAP_PER_EDGE_TYPE));
      overflowByEdgeType.set(etId, edgesOfType.length - CAP_PER_EDGE_TYPE);
    } else {
      selectedEdges.push(...edgesOfType);
    }
  }

  // Resolve neighbor display names
  const neighborIds = selectedEdges.map((e) =>
    e.source_node_id === nodeId ? e.target_node_id : e.source_node_id,
  );
  const uniqueNeighborIds = [...new Set(neighborIds.map((id) => id as string))];
  const displayNames = await resolveDisplayNames({ nodeIds: uniqueNeighborIds, teamId: teamId as string });

  // Fetch edge properties
  const edgeIds = selectedEdges.map((e) => e.id);
  const edgeProps = edgeIds.length > 0
    ? await qb
        .selectFrom('property')
        .innerJoin('property_type', 'property_type.id', 'property.property_type_id')
        .where('property.edge_id', 'in', edgeIds)
        .select([
          'property.edge_id',
          'property_type.name',
          'property.value_text',
          'property.value_number',
          'property.value_boolean',
        ])
        .execute()
    : [];

  const propsByEdge = new Map<string, Record<string, unknown>>();
  for (const p of edgeProps) {
    if (!p.edge_id) continue;
    const edgeId = p.edge_id as string;
    const propMap = propsByEdge.get(edgeId) ?? {};
    propMap[p.name] = p.value_text ?? p.value_number ?? p.value_boolean;
    propsByEdge.set(edgeId, propMap);
  }

  // Build entries
  const entries: RelationshipEntry[] = [];
  for (const edge of selectedEdges) {
    const etMeta = meta.get(edge.edge_type_id as string);
    if (!etMeta) continue;

    const entityIsSource = edge.source_node_id === nodeId;
    const neighborId = entityIsSource ? edge.target_node_id : edge.source_node_id;
    const neighborName = displayNames.get(neighborId as string) ?? '(unknown)';
    const edgeName = orientEdgeName(etMeta, entityIsSource);
    const props = propsByEdge.get(edge.id as string);

    entries.push({
      edgeName,
      targetName: neighborName,
      ...(props && Object.keys(props).length > 0 ? { edgeProperties: props } : {}),
    });
  }

  // Add overflow markers
  for (const [etId, count] of overflowByEdgeType) {
    const etMeta = meta.get(etId);
    if (!etMeta) continue;
    // Use outbound name as default for the overflow marker
    const edgeName = etMeta.outboundName.replace(/_/g, ' ');
    entries.push({
      edgeName,
      targetName: `(+${count} more)`,
    });
  }

  return entries;
}

// -- Format to plain text --

function formatEntityContext(context: EntityContext): string {
  const lines: string[] = [];

  // Properties
  for (const [key, value] of Object.entries(context.properties)) {
    if (value != null) {
      lines.push(`${key}: ${value}`);
    }
  }

  // Separator
  if (lines.length > 0 && context.relationships.length > 0) {
    lines.push('');
  }

  // Relationships
  for (const rel of context.relationships) {
    let line = `${titleCase(rel.edgeName)} → ${rel.targetName}`;
    if (rel.edgeProperties && Object.keys(rel.edgeProperties).length > 0) {
      const propsStr = Object.entries(rel.edgeProperties)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      line += ` (${propsStr})`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

function titleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

export { buildRelationshipContextFromDb, formatEntityContext };
export type { EdgeTypeMeta, EdgeTypeMetaMap, RelationshipEntry, EntityContext };
