-- The legacy pipelines go: the v3 output tree (pipeline_output and its run log
-- knowledge.output_run), the pipeline inputs and their message types, the
-- per-team pipeline_configuration, and the dealflow pipeline run table. Data
-- movement runs as movements; nothing executes, reads or writes these rows.
-- The columns that pointed at them go too, as does the "pipeline runs" usage
-- limit, which nothing recorded. Replaces an unreleased migration that only
-- switched v3 outputs off.


SET search_path = automations, pg_catalog;

ALTER TABLE "trigger"
	DROP COLUMN IF EXISTS pipeline_configuration_id;

SET search_path = core, pg_catalog;

DROP INDEX api_key_pipeline_input_id_idx;

DROP INDEX team_active_pipeline_configuration_id_key;

ALTER TABLE api_key
	DROP COLUMN IF EXISTS pipeline_input_id;

ALTER TABLE team
	DROP COLUMN IF EXISTS active_pipeline_configuration_id;

SET search_path = knowledge, pg_catalog;

DROP INDEX linked_object_retrieval_source_id_idx;

ALTER TABLE linked_object
	DROP COLUMN IF EXISTS retrieval_source_id,
	DROP COLUMN IF EXISTS output_id;

SET search_path = public, pg_catalog;

ALTER TABLE inbound_payload
	DROP CONSTRAINT inbound_payload_pipeline_input_id_fkey;

ALTER TABLE llm_usage
	DROP CONSTRAINT llm_usage_pipeline_id_fkey;

DROP INDEX llm_usage_pipeline_id_idx;

ALTER TABLE inbound_payload
	DROP COLUMN IF EXISTS pipeline_input_id;

ALTER TABLE llm_usage
	DROP COLUMN IF EXISTS pipeline_id;

ALTER TABLE team_usage_config
	DROP COLUMN IF EXISTS max_weekly_pipeline_runs,
	DROP COLUMN IF EXISTS additional_pipeline_runs;

-- Children before parents: pipeline_input_message_type and pipeline_output
-- hold foreign keys into pipeline_input and pipeline_configuration.
DROP TABLE IF EXISTS "public".dealflow_pipeline;
DROP TABLE IF EXISTS "public".pipeline_input_message_type;
DROP TABLE IF EXISTS "public".pipeline_output;
DROP TABLE IF EXISTS "public".pipeline_input;
DROP TABLE IF EXISTS "public".pipeline_configuration;
DROP SEQUENCE IF EXISTS "public".dealflow_pipeline_numeric_id_seq;
DROP TYPE IF EXISTS "public"."DealflowPipelineStatus";
DROP TYPE IF EXISTS "public"."PipelineInputContentType";
DROP TYPE IF EXISTS "public"."PipelineOutputMode";
DROP TYPE IF EXISTS "public"."PipelineOutputType";
DROP TABLE IF EXISTS knowledge.output_run;
