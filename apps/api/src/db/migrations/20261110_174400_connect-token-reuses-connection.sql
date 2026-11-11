-- A Telegram link minted to reuse the team's connection says so, so a link
-- minted before links carried who may use what they connect is told apart
-- from one whose connection was removed after it was made.


SET search_path = automations, pg_catalog;

ALTER TABLE connect_token
	ADD COLUMN reuses_connection boolean DEFAULT false NOT NULL;
