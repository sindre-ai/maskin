-- Migration: briefing + lifecycle push bookkeeping on notification_preferences
--   briefing_last_sent_on  the actor's LOCAL date (in notification_preferences.timezone) of the
--                          last daily briefing push. The scheduler claims a day with one
--                          conditional UPDATE ... RETURNING, so two replicas cannot both send.
--   lifecycle_sent         jsonb map of one-time lifecycle pushes already sent to the actor
--                          (e.g. {"first_task": "<iso>", "activation": "<iso>",
--                          "reminded:<notification id>": "<iso>", "reminder_at": "<iso>"}).
-- Nullable / defaulted additive columns on a small, non-hot table: plain statements are fine.
-- Idempotent — safe to re-run.

ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "briefing_last_sent_on" date;
ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "lifecycle_sent" jsonb DEFAULT '{}'::jsonb NOT NULL;
