-- notifications.session_id had ON DELETE no action, so deleting a session
-- (e.g. cascading from an actor delete) fails with a 23503 FK violation
-- whenever any notification still points at it. Match the objectId column
-- on this same table, which already uses ON DELETE SET NULL for the same
-- reason: a notification should outlive the session it references.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_session_id_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
