-- Migration: notification_preferences — per-actor push policy settings
-- One row per actor (PK actor_id). A missing row means "all defaults"; the API
-- returns defaults and the push policy treats it the same way.
-- quiet_hours_* are minutes from local midnight (0-1439) in `timezone` (IANA;
-- null => UTC). A window with start > end wraps past midnight.
-- New table, not hot-listed: plain statements are fine.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"actor_id" uuid PRIMARY KEY NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"timezone" text,
	"quiet_hours_start" smallint,
	"quiet_hours_end" smallint,
	"categories" jsonb DEFAULT '{"needs_you":true,"conversation":true,"digest":true,"tips":true}'::jsonb NOT NULL,
	"briefing_enabled" boolean DEFAULT true NOT NULL,
	"briefing_time" smallint DEFAULT 510 NOT NULL,
	"muted_workspace_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_quiet_start_chk" CHECK ("quiet_hours_start" IS NULL OR ("quiet_hours_start" >= 0 AND "quiet_hours_start" <= 1439)),
	CONSTRAINT "notification_preferences_quiet_end_chk" CHECK ("quiet_hours_end" IS NULL OR ("quiet_hours_end" >= 0 AND "quiet_hours_end" <= 1439)),
	CONSTRAINT "notification_preferences_briefing_time_chk" CHECK ("briefing_time" >= 0 AND "briefing_time" <= 1439)
);
