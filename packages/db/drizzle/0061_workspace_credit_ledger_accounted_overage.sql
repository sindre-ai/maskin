-- Fixes a double-charge in lib/credit-billing.ts.
--
-- `debitCreditForSession` computed a session's debit as
-- (cumulative period usage - plan cap), which is the *total* overage for the
-- whole period, not the slice this session added. Because each session gets
-- its own ledger row, every session past the cap re-charged the entire
-- running overage: two $20 sessions against a $10 cap debited $10 then $30
-- = $40, for $30 of real overage. The per-session unique index made a
-- *re-fired* completion idempotent, but did nothing about distinct sessions
-- each billing an overlapping range.
--
-- The fix needs to know how much overage prior debits already accounted for.
-- `amount_cents` can't answer that: it records what was actually taken from
-- the balance, which is clamped when a session outspends it (the excess is
-- deliberately written off, not carried). Subtracting clamped amounts would
-- re-bill written-off cents on the next top-up. So record the accounted
-- overage separately from the money moved.
--
-- Additive-only on a table introduced (empty) by migration 0060 in this same
-- unmerged PR, and not in the MIGRATIONS.md hot-tables list. The default is
-- a constant, so PG adds it without a table rewrite — Rule 3's split doesn't
-- apply. A separate file rather than an edit to 0060 because src/migrate.ts
-- tracks migrations by filename with no content hash: an in-place edit would
-- silently never run on any database that already applied 0060.

ALTER TABLE "workspace_credit_ledger"
	ADD COLUMN IF NOT EXISTS "accounted_overage_cents" integer DEFAULT 0 NOT NULL;

COMMENT ON COLUMN "workspace_credit_ledger"."accounted_overage_cents" IS
	'Debit rows: cents of cumulative period overage this row accounts for, BEFORE clamping to the available balance. Sum over a period tells the next debit what has already been billed. Always 0 on topup rows.';
