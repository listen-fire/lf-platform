SET search_path = public, pg_catalog;

-- The legacy v3 output pipeline (config_version = 3: a stored action tree run
-- on extraction and mutation events) no longer exists in the platform; data
-- movement runs as movements. Nothing executes these rows or reads their
-- config, so mark any that were still enabled as off. The config is kept as
-- written, so an operator can still read what the row used to do.
UPDATE pipeline_output
   SET run_mode = 'off'
 WHERE config_version = 3
   AND run_mode <> 'off';
