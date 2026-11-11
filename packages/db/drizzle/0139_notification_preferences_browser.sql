-- Migration: Browser switch per kind of notification on notification_preferences
--   browser_categories   { needs_you, conversation, digest, tips } -> true/false, only for kinds the
--                        person was asked about. NULL (every row that exists today) and a missing
--                        kind mean "not asked": the kind follows its push switch, so nobody's
--                        browser notifications change.
-- Additive nullable column on a small, non-hot table: a plain statement is fine, no backfill, no flag.
-- Idempotent, safe to re-run. Down: drizzle/down/0139_notification_preferences_browser_down.sql.

ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "browser_categories" jsonb;
