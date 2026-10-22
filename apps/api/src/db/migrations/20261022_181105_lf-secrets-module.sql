
SET search_path = automations, pg_catalog;

CREATE TABLE lf_secrets_lease (
	team_id uuid NOT NULL,
	"ref" text NOT NULL,
	token text NOT NULL,
	expires_at timestamp with time zone NOT NULL
);


ALTER TABLE external_service_credentials
	ADD COLUMN wire_binding text;

ALTER TABLE lf_secrets_lease
	ADD CONSTRAINT lf_secrets_lease_pkey PRIMARY KEY (team_id, ref);

ALTER TABLE external_service_credentials
	ADD CONSTRAINT external_service_credentials_wire_binding_check CHECK ((wire_binding = ANY (ARRAY['install'::text, 'legacy'::text])));
