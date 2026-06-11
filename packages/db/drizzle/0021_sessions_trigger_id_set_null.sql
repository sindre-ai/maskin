-- Switch sessions.trigger_id FK to ON DELETE SET NULL so triggers can be deleted
-- even when sessions reference them. Sessions are the audit trail of past trigger
-- runs and should outlive the trigger itself; nulling the link preserves history.
--
-- Without this, DELETE /api/triggers/:id 500s with a FK violation
-- (`sessions_trigger_id_*_fk`) for any trigger that has ever fired.
--
-- The constraint name varies by install: drizzle-generated DBs have
-- `sessions_trigger_id_triggers_id_fk`, while DBs created via the manual
-- 0002_sessions.sql migration got Postgres's auto-name `sessions_trigger_id_fkey`.
-- We look it up from pg_constraint and rewrite whichever exists.

DO $$
DECLARE
	con_name text;
BEGIN
	SELECT conname INTO con_name
	FROM pg_constraint
	WHERE conrelid = 'public.sessions'::regclass
		AND contype = 'f'
		AND conkey = ARRAY[(
			SELECT attnum FROM pg_attribute
			WHERE attrelid = 'public.sessions'::regclass AND attname = 'trigger_id'
		)]::int2[];

	IF con_name IS NOT NULL THEN
		EXECUTE format('ALTER TABLE public.sessions DROP CONSTRAINT %I', con_name);
	END IF;

	ALTER TABLE public.sessions
		ADD CONSTRAINT sessions_trigger_id_triggers_id_fk
		FOREIGN KEY (trigger_id) REFERENCES public.triggers(id) ON DELETE SET NULL;
END $$;
