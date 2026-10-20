import { sql } from 'kysely';

import type { TeamId } from '../../generated/kysely/core/Team';

import { getKnowledgeQb } from '../kysely';
import { embedTexts } from '../../services/embedding';

/** The team's stored (subject, predicate, object) facts nearest a free-text query. */
async function searchFacts(options: { query: string; teamId: TeamId; limit?: number }) {
  const { query, teamId, limit = 50 } = options;

  const [queryEmbedding] = await embedTexts({
    texts: [query],
    destination: 'extraction_fact',
    label: 'knowledge_fact_embedding',
  });
  const embeddingVector = JSON.stringify(queryEmbedding);

  return getKnowledgeQb(['extraction_fact'])
    .selectFrom('extraction_fact')
    .select([
      'extraction_fact.id',
      'extraction_fact.subject',
      'extraction_fact.predicate',
      'extraction_fact.object',
      'extraction_fact.message_node_id',
      'extraction_fact.resource_id',
      sql<number>`1 - (extraction_fact.embedding <=> ${embeddingVector}::vector)`.as('similarity'),
    ])
    .where('extraction_fact.team_id', '=', teamId)
    .where('extraction_fact.embedding', 'is not', null)
    .orderBy(sql`extraction_fact.embedding <=> ${embeddingVector}::vector`, 'asc')
    .limit(limit)
    .execute();
}

export { searchFacts };
