-- agent_files.session_id had ON DELETE no action, so deleting a session
-- (e.g. cascading from an actor delete) fails with a 23503 FK violation
-- whenever an agent_files row still points at it — most commonly the same
-- agent's own record for a session that pushed learnings/skills back to
-- storage. Match notifications.session_id (migration 0041), which uses
-- ON DELETE SET NULL for the same reason: the file record should outlive
-- the session it references.
ALTER TABLE "agent_files" DROP CONSTRAINT "agent_files_session_id_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
