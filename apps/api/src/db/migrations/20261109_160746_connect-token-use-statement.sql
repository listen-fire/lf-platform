-- A connect link carries who may use the connection it creates, chosen and
-- decided when the link was minted, so the landing page never asks again.
-- A link minted before this has none, and cannot create a connection.

SET search_path = automations, pg_catalog;

ALTER TABLE connect_token
	ADD COLUMN use_statement jsonb;
