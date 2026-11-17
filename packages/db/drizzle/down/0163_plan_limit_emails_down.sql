-- Rollback for 0163. Drops the record of which plan-limit mails were sent. Nothing else depends on
-- the table. If it is dropped while the plan-limit-email flag is on, a workspace that already got
-- its mail for the period could get it once more on its next refusal, so switch the flag off first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "plan_limit_emails";
