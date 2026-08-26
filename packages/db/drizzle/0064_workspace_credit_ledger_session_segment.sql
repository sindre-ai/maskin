-- Fixes a MISSED charge in lib/credit-billing.ts.
--
-- Migration 0060 made a debit idempotent with a partial unique index on
-- `session_id` alone: one debit row per session, ever. That is correct for
-- the case it was written for (the same completion firing twice after a
-- crash/retry), but a session is not billed once — `debitCreditIfApplicable`
-- runs on PAUSE as well as on completion (services/session-manager.ts), and
-- an interactive session pauses routinely between turns.
--
-- So: a session pauses at $30 of overage and writes its debit row. It
-- resumes, burns another $200, and completes — the completion's insert
-- conflicts on `session_id`, returns no row, and `debitCreditForSession`
-- returns before touching the balance. The $200 is never charged. The
-- sessions that pause are exactly the long interactive ones most likely to
-- run up overage, so this is the common path, not an edge case.
--
-- The key has to separate the two *segments* while still collapsing a retry
-- of the same segment. A counter can't: a re-fired completion would take the
-- next counter value and double-charge, which is the bug 0060 prevented.
-- The session's own cumulative cost at debit time does both jobs —
--   * retry of one segment  -> cumulative cost unchanged -> same key -> no-op
--   * completion after a resume that spent more -> higher key -> bills the increment
--   * resume that spent nothing -> same key -> no-op, and nothing is owed anyway
-- — because it is monotonic in exactly the quantity being billed.
--
-- Additive-only, on a table introduced (empty) by 0060 in this same unmerged
-- PR, so there are no live rows to backfill and no rewrite. Nullable rather
-- than DEFAULT 0: a NULL is distinct from every other value in a Postgres
-- unique index, so any row predating this migration keeps its old
-- one-per-session behaviour instead of colliding with a real 0-cent debit.
-- A separate file, not an edit to 0060 — src/migrate.ts tracks migrations by
-- filename with no content hash, so an in-place edit would never run on a
-- database that already applied 0060.

ALTER TABLE "workspace_credit_ledger"
	ADD COLUMN IF NOT EXISTS "session_usage_cents" integer;

COMMENT ON COLUMN "workspace_credit_ledger"."session_usage_cents" IS
	'Debit rows: the session''s own cumulative cost in USD cents at the moment this debit was written. Segments the idempotency key so a paused-then-resumed session bills each segment once. NULL on topup rows and on debits predating migration 0064.';

DROP INDEX IF EXISTS "workspace_credit_ledger_debit_session_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_credit_ledger_debit_session_segment_uniq"
	ON "workspace_credit_ledger" ("session_id", "session_usage_cents")
	WHERE "type" = 'debit' AND "session_id" IS NOT NULL;
