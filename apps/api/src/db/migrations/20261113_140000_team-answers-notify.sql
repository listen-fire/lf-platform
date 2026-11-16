-- A host function (`team.isMember`) answers from who is on a team, and a host
-- keeps its answers. Whatever changes who a claim names, in any process, says
-- so on one channel (`lf_team_answers`), with a payload that names a team
-- (`team:<id>`, its membership changed) or a user (`user:<id>`, their email,
-- phone or granted access changed; a listener resolves the teams they are in).
-- The functions only notify: they read nothing from the other unit's tables.

CREATE FUNCTION core.team_answers_notify() RETURNS pg_catalog.trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM pg_notify('lf_team_answers', TG_ARGV[0] || ':' || (to_jsonb(OLD) ->> TG_ARGV[1]));
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pg_notify('lf_team_answers', TG_ARGV[0] || ':' || (to_jsonb(NEW) ->> TG_ARGV[1]));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER team_membership_team_answers_insert AFTER INSERT ON core.team_membership FOR EACH ROW EXECUTE FUNCTION core.team_answers_notify('team', 'team_id');

CREATE TRIGGER team_membership_team_answers_delete AFTER DELETE ON core.team_membership FOR EACH ROW EXECUTE FUNCTION core.team_answers_notify('team', 'team_id');

CREATE TRIGGER team_membership_team_answers_update AFTER UPDATE ON core.team_membership FOR EACH ROW WHEN (((old.access IS DISTINCT FROM new.access) OR (old.user_id IS DISTINCT FROM new.user_id) OR (old.team_id IS DISTINCT FROM new.team_id))) EXECUTE FUNCTION core.team_answers_notify('team', 'team_id');

CREATE TRIGGER user_email_team_answers_insert AFTER INSERT ON core.user_email FOR EACH ROW EXECUTE FUNCTION core.team_answers_notify('user', 'user_id');

CREATE TRIGGER user_email_team_answers_delete AFTER DELETE ON core.user_email FOR EACH ROW EXECUTE FUNCTION core.team_answers_notify('user', 'user_id');

CREATE TRIGGER user_email_team_answers_update AFTER UPDATE ON core.user_email FOR EACH ROW WHEN (((old.email IS DISTINCT FROM new.email) OR (old.user_id IS DISTINCT FROM new.user_id) OR (old.is_primary IS DISTINCT FROM new.is_primary) OR (old.is_service_email IS DISTINCT FROM new.is_service_email) OR (old.accepts_plus_addressing IS DISTINCT FROM new.accepts_plus_addressing))) EXECUTE FUNCTION core.team_answers_notify('user', 'user_id');

CREATE TRIGGER user_team_answers_update AFTER UPDATE ON core."user" FOR EACH ROW WHEN (((old.granted_access_at IS NULL) <> (new.granted_access_at IS NULL) OR (old.username IS DISTINCT FROM new.username) OR (old.name IS DISTINCT FROM new.name))) EXECUTE FUNCTION core.team_answers_notify('user', 'id');

CREATE FUNCTION automations.team_answers_notify() RETURNS pg_catalog.trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.user_id IS NOT NULL THEN
    PERFORM pg_notify('lf_team_answers', 'user:' || OLD.user_id::text);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.user_id IS NOT NULL THEN
    PERFORM pg_notify('lf_team_answers', 'user:' || NEW.user_id::text);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER phone_number_team_answers_insert AFTER INSERT ON automations.phone_number FOR EACH ROW EXECUTE FUNCTION automations.team_answers_notify();

CREATE TRIGGER phone_number_team_answers_delete AFTER DELETE ON automations.phone_number FOR EACH ROW EXECUTE FUNCTION automations.team_answers_notify();

CREATE TRIGGER phone_number_team_answers_update AFTER UPDATE ON automations.phone_number FOR EACH ROW WHEN (((old.user_id IS DISTINCT FROM new.user_id) OR (old.phone_number IS DISTINCT FROM new.phone_number) OR ((old.verified_at IS NULL) <> (new.verified_at IS NULL)))) EXECUTE FUNCTION automations.team_answers_notify();
