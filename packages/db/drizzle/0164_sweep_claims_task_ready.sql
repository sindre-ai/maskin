-- The sweep now also finds a backlog task that is due within 24 hours and wakes its owner (bet "Flows
-- that run like development", task "Wake a ready task's owner"), so a claim row can carry the reason
-- task_ready. Only the CHECK list on next_step_sweep_claims.reason widens; no row changes.
--
-- Additive: every existing row (step_overdue, no_next_step) still passes the new check. The table
-- is the sweep's own log, small, and not on the hot-tables list (see MIGRATIONS.md), so plain DDL is
-- fine. Down: drizzle/down/0164_sweep_claims_task_ready_down.sql.

ALTER TABLE "next_step_sweep_claims" DROP CONSTRAINT IF EXISTS "next_step_sweep_claims_reason_check";
--> statement-breakpoint
ALTER TABLE "next_step_sweep_claims" ADD CONSTRAINT "next_step_sweep_claims_reason_check" CHECK ("reason" IN ('step_overdue', 'no_next_step', 'task_ready'));
