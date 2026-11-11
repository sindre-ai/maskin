-- Migration: Flow activity email on notification_preferences
--   email_categories   { flow_activity } -> true/false, the Email switch for a kind other than the
--                      summary. NULL (every row that exists today) and a missing kind mean off.
--   flow_email_sent    { <flow id> } -> ISO time of the last Flow activity email to this person for
--                      that flow. The sender claims an hour with one conditional UPDATE on it, so
--                      one person gets at most one email per flow per hour across restarts and replicas.
-- Additive nullable columns on a small, non-hot table: plain statements are fine, no backfill, no flag.
-- Idempotent, safe to re-run. Down: drizzle/down/0147_notification_preferences_flow_activity_email_down.sql.

ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "email_categories" jsonb,
	ADD COLUMN IF NOT EXISTS "flow_email_sent" jsonb;
