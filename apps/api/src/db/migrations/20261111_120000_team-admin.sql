-- A team level above write: an admin manages the team's members and may change
-- any access list on it. Every member who could manage the team before (every
-- level but read, as the platform read them) is an admin now, so nobody loses
-- what they could do; an admin may demote them afterwards. The public identity's
-- membership on the team that holds nothing stays write, as a new install makes it:
-- an anonymous sender has no team to manage. A service mailbox (a user with a
-- service address, such as a shared inbox) stays write too: it is no person,
-- and an admin is who the team's last admin guard and a departing holder's
-- lists count on.

SET search_path = core, pg_catalog;

UPDATE team_membership m SET access = 'admin'
WHERE m.access <> 'read' AND m.team_id <> '3c556453-82b3-4314-ab78-67d843aaa7da'
  AND NOT EXISTS (SELECT 1 FROM user_email e WHERE e.user_id = m.user_id AND e.is_service_email);

ALTER TABLE team_membership
	ADD CONSTRAINT team_membership_access_check CHECK ((access = ANY (ARRAY['read'::text, 'write'::text, 'admin'::text])));
