-- Rollback for 0164. Puts the two-value reason check back. Rows that carry task_ready would fail
-- it, so they are deleted first: they are the sweep's decision log only, and the sweep writes
-- them again if the object is still due.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DELETE FROM "next_step_sweep_claims" WHERE "reason" = 'task_ready';
--> statement-breakpoint
ALTER TABLE "next_step_sweep_claims" DROP CONSTRAINT IF EXISTS "next_step_sweep_claims_reason_check";
--> statement-breakpoint
ALTER TABLE "next_step_sweep_claims" ADD CONSTRAINT "next_step_sweep_claims_reason_check" CHECK ("reason" IN ('step_overdue', 'no_next_step'));
