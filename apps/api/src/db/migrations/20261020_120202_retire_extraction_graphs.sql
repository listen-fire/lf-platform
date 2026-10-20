-- Extraction graphs go: movements are the only automation into the knowledge
-- graph, and nothing has run an extraction graph since the legacy pipelines
-- went. With them go the extraction plugins (only an extraction graph node
-- could call one) and the join from resources to inbound payloads (only the
-- retired payload ingestion wrote it).

DROP TABLE IF EXISTS "public".resource_payload;

-- One statement: the graph and its nodes reference each other.
DROP TABLE IF EXISTS knowledge.extraction_graph_edge, knowledge.extraction_graph_node, knowledge.extraction_graph;

DROP TABLE IF EXISTS knowledge.plugin;
