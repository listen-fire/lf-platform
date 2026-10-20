import { sql } from 'kysely';

import type { NodeId } from '../generated/kysely/knowledge/Node';
import type { TeamId } from '../generated/kysely/core/Team';
import type LinkedObjectSource from '../generated/kysely/knowledge/LinkedObjectSource';

import { getKnowledgeQb } from '../lib/kysely';
import { normalizeAdapterType } from 'movement-engine/public/adapter';

// unified linked object model

/**
 * Canonical form for `linked_object.adapter_type` — lowercase. Two
 * conventions used to coexist (the legacy refresh path stored
 * `ExternalServiceType` enum values in uppercase like `ATTIO`, the TG
 * dispatch path stored adapter ids in lowercase like `attio`); Postgres
 * is case-sensitive, so a node bridged via one path didn't match
 * queries from the other.
 *
 * All linked_object reads and writes funnel adapter_type through this
 * helper so the column is always lowercase. Rows written before this
 * normalisation landed are migrated by the
 * `*_lowercase_linked_object_adapter_type` migration.
 */
export { normalizeAdapterType };

interface LinkedObjectRow {
  id: string;
  node_id: string;
  source: LinkedObjectSource;
  adapter_type: string;
  external_id: string;
  external_object_type: string | null;
  data: unknown;
  action_node_id: string | null;
  fetched_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

async function storeLinkedObject(options: {
  nodeId: NodeId;
  teamId: TeamId;
  source: LinkedObjectSource;
  adapterType: string;
  externalId: string;
  externalObjectType?: string;
  data?: Record<string, unknown>;
  actionNodeId?: string;
}): Promise<void> {
  const qb = getKnowledgeQb([]);

  const adapterType = normalizeAdapterType(options.adapterType);
  await sql`
    INSERT INTO knowledge.linked_object
      (team_id, node_id, source, adapter_type, external_id, external_object_type, data, action_node_id)
    VALUES (
      ${options.teamId}, ${options.nodeId}, ${options.source},
      ${adapterType}, ${options.externalId}, ${options.externalObjectType ?? null},
      ${JSON.stringify(options.data ?? {})}::jsonb,
      ${options.actionNodeId ?? null}
    )
    ON CONFLICT (node_id, adapter_type, external_id)
    DO UPDATE SET
      data = EXCLUDED.data,
      external_object_type = COALESCE(EXCLUDED.external_object_type, knowledge.linked_object.external_object_type),
      source = EXCLUDED.source,
      action_node_id = COALESCE(EXCLUDED.action_node_id, knowledge.linked_object.action_node_id),
      updated_at = CURRENT_TIMESTAMP
  `.execute(qb);
}

async function loadLinkedObjects(
  nodeId: NodeId,
  teamId: TeamId,
  filter?: { adapterType?: string; source?: LinkedObjectSource },
): Promise<LinkedObjectRow[]> {
  const qb = getKnowledgeQb([]);

  let query = sql<LinkedObjectRow>`
    SELECT id, node_id, source, adapter_type, external_id, external_object_type, data,
           action_node_id,
           fetched_at, created_at, updated_at
    FROM knowledge.linked_object
    WHERE node_id = ${nodeId} AND team_id = ${teamId}`;

  if (filter?.adapterType) {
    query = sql<LinkedObjectRow>`${query} AND adapter_type = ${normalizeAdapterType(filter.adapterType)}`;
  }
  if (filter?.source) {
    query = sql<LinkedObjectRow>`${query} AND source = ${filter.source}`;
  }

  const result = await query.execute(qb);
  return result.rows;
}

async function deleteLinkedObject(id: string, teamId: TeamId): Promise<void> {
  const qb = getKnowledgeQb([]);

  await sql`
    DELETE FROM knowledge.linked_object
    WHERE id = ${id} AND team_id = ${teamId}
  `.execute(qb);
}

async function updateLinkedObjectExternalId(
  id: string,
  teamId: TeamId,
  newExternalId: string,
): Promise<void> {
  const qb = getKnowledgeQb([]);

  // If another linked object already points to the new external_id (same node + adapter),
  // just delete the stale one — the existing row is already correct.
  const existing = await sql<{ id: string }>`
    SELECT lo2.id FROM knowledge.linked_object lo2
    JOIN knowledge.linked_object lo1 ON lo1.node_id = lo2.node_id AND lo1.adapter_type = lo2.adapter_type
    WHERE lo1.id = ${id} AND lo2.external_id = ${newExternalId} AND lo2.team_id = ${teamId}
  `.execute(qb);

  if (existing.rows.length > 0) {
    await sql`
      DELETE FROM knowledge.linked_object WHERE id = ${id} AND team_id = ${teamId}
    `.execute(qb);
    return;
  }

  await sql`
    UPDATE knowledge.linked_object
    SET external_id = ${newExternalId}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id} AND team_id = ${teamId}
  `.execute(qb);
}

export { storeLinkedObject, loadLinkedObjects, deleteLinkedObject, updateLinkedObjectExternalId };
export type { LinkedObjectRow };
