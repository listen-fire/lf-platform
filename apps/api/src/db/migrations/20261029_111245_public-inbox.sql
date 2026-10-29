-- Public inboxes: a team's claim that one inbound routing key takes mail from
-- anyone, plus the claims a fork's saved automations already imply.
--
-- A fork of this platform (a single-team deployment) opened an address from
-- the program instead: `listen to inbox { key: "nemo", from: "anyone" }`. Its
-- saved automations keep that text, which is never rewritten automatically,
-- so the backfill below gives each such key the claim that now carries the
-- openness, and the mail keeps arriving with no manual step. The trigger row
-- is where a listen's config is kept, so that is what is read: a live email
-- listener (one a saved movement derives) whose config says `from: "anyone"`.
--
-- The claimant is who a run acts as for a sender outside the team: the
-- movement's author while still on the team, else the last person still on
-- the team whose save the audit trail records (an api key's save counts as
-- its creator's). A key two teams opened is claimed for neither: the fork
-- refused that mail as ambiguous, and it stays refused. A key with nobody to
-- act as is left unclaimed, as the fork left an authorless listener closed.
-- Both are counted in the NOTICE. Idempotent: a key already claimed is skipped.


SET search_path = automations, pg_catalog;

CREATE TABLE public_inbox (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	"key" public.citext NOT NULL,
	team_id uuid NOT NULL,
	claimed_by_user_id uuid NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public_inbox
	ADD CONSTRAINT public_inbox_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX public_inbox_key_key ON public_inbox USING btree (key);

CREATE INDEX public_inbox_team_id_idx ON public_inbox USING btree (team_id);

CREATE TRIGGER public_inbox_audit
	AFTER INSERT OR UPDATE OR DELETE ON public_inbox
	FOR EACH ROW
	EXECUTE PROCEDURE automations.audit();

SET search_path = pg_catalog;

DO $$
DECLARE
    claimed bigint;
    shared bigint;
    unattributed bigint;
BEGIN
    CREATE TEMP TABLE open_listen ON COMMIT DROP AS
    SELECT t.config->>'key' AS key,
           t.team_id,
           m.updated_at,
           COALESCE(author.user_id, saver.user_id) AS claimant
    FROM automations.trigger t
    JOIN automations.movement m ON m.id = t.movement_id
    LEFT JOIN LATERAL (
        SELECT tm.user_id
        FROM core.team_membership tm
        WHERE tm.team_id = m.team_id AND tm.user_id = m.created_by_user_id
    ) author ON true
    LEFT JOIN LATERAL (
        SELECT tm.user_id
        FROM automations.audit_log a
        LEFT JOIN core.api_key k ON k.id::text = a.created_by
        JOIN core.team_membership tm
          ON tm.team_id = m.team_id
         AND tm.user_id::text = COALESCE(k.created_by::text, a.created_by)
        WHERE a.table_name = 'movement'
          AND a.model_id = m.id
          AND a.op IN ('INSERT', 'UPDATE')
        ORDER BY a.version DESC
        LIMIT 1
    ) saver ON true
    WHERE t.kind IN ('email', 'mailgun', 'resend', 'CUSTOM_EMAIL', 'MAILGUN', 'INBOUND_EMAIL', 'GMAIL')
      AND t.config->>'from' = 'anyone'
      AND COALESCE(t.config->>'key', '') <> '';

    WITH single_team AS (
        SELECT lower(key) AS folded
        FROM open_listen
        GROUP BY lower(key)
        HAVING count(DISTINCT team_id) = 1
    ),
    chosen AS (
        SELECT DISTINCT ON (lower(o.key)) o.key, o.team_id, o.claimant
        FROM open_listen o
        JOIN single_team s ON s.folded = lower(o.key)
        WHERE o.claimant IS NOT NULL
        ORDER BY lower(o.key), o.updated_at DESC
    ),
    inserted AS (
        INSERT INTO automations.public_inbox (key, team_id, claimed_by_user_id)
        SELECT key, team_id, claimant FROM chosen
        ON CONFLICT (key) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO claimed FROM inserted;

    SELECT count(*) INTO shared FROM (
        SELECT 1 FROM open_listen GROUP BY lower(key) HAVING count(DISTINCT team_id) > 1
    ) clash;

    SELECT count(*) INTO unattributed FROM (
        SELECT 1 FROM open_listen
        GROUP BY lower(key)
        HAVING count(DISTINCT team_id) = 1 AND bool_and(claimant IS NULL)
    ) nobody;

    RAISE NOTICE 'public inbox backfill: % key(s) claimed from listens that said from: "anyone"; % opened by more than one team and % with nobody on the team to act as, left unclaimed',
        claimed, shared, unattributed;
END
$$;
