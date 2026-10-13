-- Rollback for 0091_access_requests.sql.
--
-- PRECONDITION: DESTRUCTIVE for two things.
--   1. access_requests is dropped with all its rows.
--   2. Restoring the five-action CHECK FAILS while credential_access_log holds a
--      row with tier_changed or a grant_* action. That table is the tamper-evident
--      audit chain and its rows are never deleted or edited, so there is no
--      automatic answer: leave the wider CHECK in place (skip the last two
--      statements) rather than touch the chain.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "access_requests";
--> statement-breakpoint
ALTER TABLE "integrations"
	DROP CONSTRAINT IF EXISTS "integrations_tier_range",
	DROP CONSTRAINT IF EXISTS "integrations_second_approvers_is_array";
--> statement-breakpoint
ALTER TABLE "integrations"
	DROP COLUMN IF EXISTS "tier",
	DROP COLUMN IF EXISTS "approver_actor_id",
	DROP COLUMN IF EXISTS "second_approver_actor_ids";
--> statement-breakpoint
ALTER TABLE "credential_access_log" DROP CONSTRAINT IF EXISTS "credential_access_log_action_enum";
--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_action_enum" CHECK ("action" IN ('read', 'create', 'undone', 'rotated', 'sweeper_activated'));
