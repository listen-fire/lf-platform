-- The platform runs automations pinned to listen-fire 0.12 beside later
-- releases, so the tables a 0.12 run, parked run, queued event or ask needs
-- stay: `callback`, `adapter_await`, `trigger_event` with each run's link to
-- its receipt, and `platform_owned_token`. Four migrations on the way to 0.15
-- once dropped them; they were never deployed and are gone. Where those tables
-- were never dropped (production) this changes nothing. A development database
-- that ran the four gets the tables back, empty: what they dropped there is
-- not recovered.

SET search_path = automations, pg_catalog;

CREATE TABLE IF NOT EXISTS automations.adapter_await (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    adapter_type text NOT NULL,
    correlation_key text NOT NULL,
    run_id uuid NOT NULL,
    team_id uuid NOT NULL,
    address text NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT adapter_await_pkey PRIMARY KEY (id),
    CONSTRAINT adapter_await_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT adapter_await_run_address_unique UNIQUE (run_id, address)
);
CREATE INDEX IF NOT EXISTS adapter_await_correlation_idx ON automations.adapter_await USING btree (adapter_type, correlation_key, team_id);
CREATE INDEX IF NOT EXISTS adapter_await_run_id_idx ON automations.adapter_await USING btree (run_id);

CREATE TABLE IF NOT EXISTS automations.callback (
    id text NOT NULL,
    team_id uuid NOT NULL,
    run_id uuid NOT NULL,
    address text NOT NULL,
    params jsonb NOT NULL DEFAULT '[]'::jsonb,
    state jsonb NOT NULL,
    calls jsonb NOT NULL DEFAULT '[]'::jsonb,
    single_use boolean NOT NULL DEFAULT true,
    expires_at timestamptz,
    status text NOT NULL DEFAULT 'live',
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    fired_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT callback_pkey PRIMARY KEY (id),
    CONSTRAINT callback_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT callback_status_check CHECK (status IN ('live', 'fired', 'revoked'))
);
CREATE INDEX IF NOT EXISTS callback_run_id_idx ON automations.callback USING btree (run_id);
CREATE INDEX IF NOT EXISTS callback_team_id_idx ON automations.callback USING btree (team_id);

CREATE TABLE IF NOT EXISTS automations.trigger_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    trigger_id text NOT NULL,
    adapter_type text NOT NULL,
    trigger_type text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'received',
    dispatched_at timestamp(3) with time zone,
    failure_reason text,
    dropped_reason text,
    external_event_id text,
    occurred_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT trigger_event_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS trigger_event_team_id_idx ON automations.trigger_event USING btree (team_id);
CREATE INDEX IF NOT EXISTS trigger_event_trigger_id_idx ON automations.trigger_event USING btree (trigger_id);
CREATE INDEX IF NOT EXISTS trigger_event_created_at_idx ON automations.trigger_event USING btree (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS trigger_event_delivery_idempotency_idx ON automations.trigger_event USING btree (trigger_id, external_event_id) WHERE external_event_id IS NOT NULL;

ALTER TABLE automations.trigger_run ADD COLUMN IF NOT EXISTS trigger_event_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trigger_run_trigger_event_id_fkey') THEN
    ALTER TABLE automations.trigger_run
      ADD CONSTRAINT trigger_run_trigger_event_id_fkey FOREIGN KEY (trigger_event_id) REFERENCES automations.trigger_event(id) ON DELETE SET NULL;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS trigger_run_trigger_event_id_idx ON automations.trigger_run USING btree (trigger_event_id);

CREATE TABLE IF NOT EXISTS automations.platform_owned_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    adapter_type text NOT NULL,
    external_token_id text NOT NULL,
    description text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at timestamp(3) without time zone,
    CONSTRAINT platform_owned_token_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_owned_token_unique_idx ON automations.platform_owned_token (team_id, adapter_type, external_token_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS platform_owned_token_team_adapter_idx ON automations.platform_owned_token USING btree (team_id, adapter_type);

GRANT SELECT ON TABLE automations.adapter_await, automations.callback, automations.trigger_event, automations.platform_owned_token TO readonly;
