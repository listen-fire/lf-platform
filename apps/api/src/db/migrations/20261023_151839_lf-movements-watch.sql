
SET search_path = automations, pg_catalog;

CREATE TABLE lf_movements_listing (
	team_id uuid NOT NULL,
	"cursor" text NOT NULL,
	listing jsonb NOT NULL,
	seen_at timestamp with time zone DEFAULT now() NOT NULL
);


CREATE OR REPLACE FUNCTION lf_movements_notify() RETURNS pg_catalog.trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM pg_notify('lf_movements_' || replace(OLD.team_id::text, '-', ''), '');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pg_notify('lf_movements_' || replace(NEW.team_id::text, '-', ''), '');
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE lf_movements_listing
	ADD CONSTRAINT lf_movements_listing_pkey PRIMARY KEY (team_id, cursor);

CREATE INDEX lf_movements_listing_seen_at_idx ON lf_movements_listing USING btree (team_id, seen_at);

CREATE TRIGGER external_service_credentials_lf_movements_delete
	AFTER DELETE ON external_service_credentials
	FOR EACH ROW
	WHEN ((old.credentials IS NOT NULL))
	EXECUTE PROCEDURE automations.lf_movements_notify();

CREATE TRIGGER external_service_credentials_lf_movements_insert
	AFTER INSERT ON external_service_credentials
	FOR EACH ROW
	WHEN ((new.credentials IS NOT NULL))
	EXECUTE PROCEDURE automations.lf_movements_notify();

CREATE TRIGGER external_service_credentials_lf_movements_update
	AFTER UPDATE ON external_service_credentials
	FOR EACH ROW
	WHEN ((((old.credentials IS NULL) <> (new.credentials IS NULL)) OR (old.name IS DISTINCT FROM new.name) OR (old.type IS DISTINCT FROM new.type) OR (old.app_id IS DISTINCT FROM new.app_id) OR (old.declared_credential IS DISTINCT FROM new.declared_credential) OR (old.wire_binding IS DISTINCT FROM new.wire_binding) OR (old.team_id IS DISTINCT FROM new.team_id)))
	EXECUTE PROCEDURE automations.lf_movements_notify();

CREATE TRIGGER movement_lf_movements_delete
	AFTER DELETE ON movement
	FOR EACH ROW
	WHEN ((old.current_version_id IS NOT NULL))
	EXECUTE PROCEDURE automations.lf_movements_notify();

CREATE TRIGGER movement_lf_movements_insert
	AFTER INSERT ON movement
	FOR EACH ROW
	WHEN ((new.current_version_id IS NOT NULL))
	EXECUTE PROCEDURE automations.lf_movements_notify();

CREATE TRIGGER movement_lf_movements_update
	AFTER UPDATE ON movement
	FOR EACH ROW
	WHEN (((old.current_version_id IS DISTINCT FROM new.current_version_id) OR (old.name IS DISTINCT FROM new.name) OR (old.team_id IS DISTINCT FROM new.team_id)))
	EXECUTE PROCEDURE automations.lf_movements_notify();

CREATE TRIGGER trigger_lf_movements_delete
	AFTER DELETE ON "trigger"
	FOR EACH ROW
	WHEN (((old.run_mode = 'off'::text) OR (old.guard_paused_at IS NOT NULL)))
	EXECUTE PROCEDURE automations.lf_movements_notify();

CREATE TRIGGER trigger_lf_movements_insert
	AFTER INSERT ON "trigger"
	FOR EACH ROW
	WHEN (((new.run_mode = 'off'::text) OR (new.guard_paused_at IS NOT NULL)))
	EXECUTE PROCEDURE automations.lf_movements_notify();

CREATE TRIGGER trigger_lf_movements_update
	AFTER UPDATE ON "trigger"
	FOR EACH ROW
	WHEN (((old.run_mode IS DISTINCT FROM new.run_mode) OR ((old.guard_paused_at IS NULL) <> (new.guard_paused_at IS NULL)) OR (old.movement_id IS DISTINCT FROM new.movement_id) OR (old.team_id IS DISTINCT FROM new.team_id)))
	EXECUTE PROCEDURE automations.lf_movements_notify();
