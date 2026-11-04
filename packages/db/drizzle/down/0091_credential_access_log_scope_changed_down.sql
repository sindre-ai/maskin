-- Rollback for 0091_credential_access_log_scope_changed.sql.
--
-- PRECONDITION: no scope_changed rows. The log is insert-only and hash-chained, so
-- they cannot be deleted; with one present, re-adding the old CHECK fails and the
-- constraint stays as 0091 left it.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "credential_access_log" DROP CONSTRAINT IF EXISTS "credential_access_log_action_enum";
--> statement-breakpoint
ALTER TABLE "credential_access_log"
	ADD CONSTRAINT "credential_access_log_action_enum" CHECK ("action" IN ('read', 'create', 'undone', 'rotated', 'sweeper_activated'));
