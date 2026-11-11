-- A team level above write: an admin manages the team's members and may change
-- any access list on it. Every member who could manage the team before (every
-- level but read, as the platform read them) is an admin now, so nobody loses
-- what they could do; an admin may demote them afterwards. The public identity's
-- membership on the team that holds nothing stays write, as a new install makes it:
-- an anonymous sender has no team to manage.

SET search_path = core, pg_catalog;

UPDATE team_membership SET access = 'admin'
WHERE access <> 'read' AND team_id <> '3c556453-82b3-4314-ab78-67d843aaa7da';

ALTER TABLE team_membership
	ADD CONSTRAINT team_membership_access_check CHECK ((access = ANY (ARRAY['read'::text, 'write'::text, 'admin'::text])));
