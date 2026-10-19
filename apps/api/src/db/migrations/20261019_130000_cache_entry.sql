SET search_path = automations, pg_catalog;

CREATE TABLE "cache_entry" (
	"key" text NOT NULL,
	value bytea DEFAULT ''::bytea NOT NULL,
	counter bigint DEFAULT 0 NOT NULL,
	expires_at timestamp with time zone NOT NULL
);

ALTER TABLE "cache_entry"
	ADD CONSTRAINT cache_entry_pkey PRIMARY KEY ("key");

CREATE INDEX cache_entry_expires_idx ON "cache_entry" USING btree (expires_at);
