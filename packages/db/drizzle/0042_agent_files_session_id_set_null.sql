-- agent_files.session_id had ON DELETE no action, so deleting a session
-- (e.g. cascading from an actor delete) fails with a 23503 FK violation
-- whenever an agent_files row still points at it — most commonly the same
-- agent's own record for a session that pushed learnings/skills back to
-- storage. Match notifications.session_id (migration 0041), which uses
-- ON DELETE SET NULL for the same reason: the file record should outlive
-- the session it references.
--
-- The constraint name varies by install: drizzle-generated DBs have
-- `agent_files_session_id_sessions_id_fk`, while DBs created via the manual
-- 0002_sessions.sql migration got Postgres's auto-name
-- `agent_files_session_id_fkey`. We look it up from pg_constraint and
-- rewrite whichever exists (see 0021_sessions_trigger_id_set_null.sql for
-- the same pattern applied to sessions.trigger_id).

DO $$
DECLARE
	con_name text;
BEGIN
	SELECT conname INTO con_name
	FROM pg_constraint
	WHERE conrelid = 'public.agent_files'::regclass
		AND contype = 'f'
		AND conkey = ARRAY[(
			SELECT attnum FROM pg_attribute
			WHERE attrelid = 'public.agent_files'::regclass AND attname = 'session_id'
		)]::int2[];

	IF con_name IS NOT NULL THEN
		EXECUTE format('ALTER TABLE public.agent_files DROP CONSTRAINT %I', con_name);
	END IF;

	ALTER TABLE public.agent_files
		ADD CONSTRAINT agent_files_session_id_sessions_id_fk
		FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;
END $$;
