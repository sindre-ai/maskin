-- Widen the five cumulative usage counters on sessions from int4 to bigint.
-- Long-lived sessions overflow int4 (cache_read_input_tokens reached
-- 2,119,114,728 of 2,147,483,647), after which every usage write for the
-- session fails (Sentry MASKIN-DEV-17 / MASKIN-DEV-18).
--
-- int4 -> bigint is a full table rewrite under ACCESS EXCLUSIVE, so all five
-- columns go in ONE statement (one rewrite, not five). sessions is ~120k rows /
-- ~458 MB with indexes, so the rewrite is expected to take seconds. Session
-- start and usage writes block while it runs; apply off-peak.
--
-- SET LOCAL lock_timeout makes the migration fail fast instead of queueing
-- behind a long-running transaction (and stalling every writer queued behind
-- it). It shares one statement chunk (no breakpoint) with the ALTER on purpose:
-- the runner sends a chunk as one simple-query message, i.e. one implicit
-- transaction, so the SET LOCAL is guaranteed to apply to the ALTER even though
-- the runner's connection pool may hand each chunk a different connection.
-- A timed-out migration is not recorded in _migrations and is simply re-run.
--
-- Type widening only: nothing is dropped, renamed or backfilled, every int4
-- value fits bigint, and code written for int4 keeps working. mcp_telemetry has
-- the same int4 columns but nothing near overflow, so it is left alone.

SET LOCAL lock_timeout = '5s';
ALTER TABLE "sessions"
	ALTER COLUMN "input_tokens" SET DATA TYPE bigint,
	ALTER COLUMN "output_tokens" SET DATA TYPE bigint,
	ALTER COLUMN "cache_creation_input_tokens" SET DATA TYPE bigint,
	ALTER COLUMN "cache_read_input_tokens" SET DATA TYPE bigint,
	ALTER COLUMN "duration_ms" SET DATA TYPE bigint;
