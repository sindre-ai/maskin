-- notifications.session_id had ON DELETE no action, so deleting a session
-- (e.g. cascading from an actor delete) fails with a 23503 FK violation
-- whenever any notification still points at it. Match the objectId column
-- on this same table, which already uses ON DELETE SET NULL for the same
-- reason: a notification should outlive the session it references.
--
-- The constraint name varies by install: drizzle-generated DBs have
-- `notifications_session_id_sessions_id_fk`, while DBs created via the manual
-- 0004_notifications.sql migration got Postgres's auto-name
-- `notifications_session_id_fkey`. We look it up from pg_constraint and
-- rewrite whichever exists (see 0021_sessions_trigger_id_set_null.sql for
-- the same pattern applied to sessions.trigger_id).

DO $$
DECLARE
	con_name text;
BEGIN
	SELECT conname INTO con_name
	FROM pg_constraint
	WHERE conrelid = 'public.notifications'::regclass
		AND contype = 'f'
		AND conkey = ARRAY[(
			SELECT attnum FROM pg_attribute
			WHERE attrelid = 'public.notifications'::regclass AND attname = 'session_id'
		)]::int2[];

	IF con_name IS NOT NULL THEN
		EXECUTE format('ALTER TABLE public.notifications DROP CONSTRAINT %I', con_name);
	END IF;

	ALTER TABLE public.notifications
		ADD CONSTRAINT notifications_session_id_sessions_id_fk
		FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;
END $$;
