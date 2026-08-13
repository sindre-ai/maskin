-- Extend `notifications` with the four columns the `request_decision` schema
-- and deferred-wake reaper need:
--
--   expires_at TIMESTAMPTZ                     — deadline for the expiry sweep;
--                                                NULL means "never expires"
--   default_action TEXT                        — option key the sweep resolves
--                                                to when the deadline elapses;
--                                                NULL when the notification
--                                                should keep waiting instead
--   dispatch_at TIMESTAMPTZ                    — wall-clock time at which the
--                                                lifecycle reaper should wake
--                                                the paused source session
--   wake_dispatched BOOLEAN NOT NULL DEFAULT   — set true once the reaper has
--     false                                      claimed and dispatched the
--                                                wake; keeps the partial index
--                                                on `dispatch_at` small and
--                                                prevents double-dispatch
--
-- All four are either nullable or have a constant DEFAULT, so PG only takes a
-- brief `ACCESS EXCLUSIVE` lock for the metadata change (PG11+ metadata-only
-- ALTER — no table rewrite). `notifications` isn't on the hot-tables list in
-- packages/db/MIGRATIONS.md (only `webhook_deliveries` is), so plain ALTER
-- TABLE is the right shape here.
--
-- All ADDs are `IF NOT EXISTS` so this migration is safe to re-run and safe
-- to co-land with the T2/T3 PRs that immediately start reading the columns.
--
-- The two partial indexes on the new columns are split into their own files
-- (0054 for `dispatch_at`, 0055 for `expires_at`) per packages/db/MIGRATIONS.md
-- Rule 1 — CONCURRENTLY builds are kept alone in their file so a future edit
-- cannot wrap them in a BEGIN and silently leave an INVALID index behind.

ALTER TABLE "notifications"
	ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

ALTER TABLE "notifications"
	ADD COLUMN IF NOT EXISTS "default_action" text;

ALTER TABLE "notifications"
	ADD COLUMN IF NOT EXISTS "dispatch_at" timestamp with time zone;

ALTER TABLE "notifications"
	ADD COLUMN IF NOT EXISTS "wake_dispatched" boolean NOT NULL DEFAULT false;
