-- Add FK session_dispatch_attempts.session_id → sessions.id ON DELETE CASCADE.
-- Keeps the dispatch queue clean when a session is hard-deleted: without this
-- the orphaned queue row would spin forever as the dispatcher tries to look up
-- a session that no longer exists.

ALTER TABLE "session_dispatch_attempts"
	ADD CONSTRAINT "session_dispatch_attempts_session_id_fk"
	FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE;
