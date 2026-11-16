-- The connection a delivery was kept for, written when it is kept. A delivery
-- outlives the subscription it arrived through, so who may see or run it is
-- decided by use of this connection, not by a lookup that can no longer be made.
-- No foreign key: a deleted connection leaves its id, which then matches nobody's use.

SET search_path = automations, pg_catalog;

ALTER TABLE delivery
	ADD COLUMN credentials_id uuid;
