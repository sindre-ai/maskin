-- Readings: numbers only server code can write (registrations, payments), each with the time it
-- was read and where it came from.
--
-- The target "actual" is one number with no time that an agent can write, and an object field
-- such as attendee_count is agent-written too. A run cannot check its own number against either.
-- This table is the one place a number counts as checked: rows come from webhook handlers and
-- scheduled jobs through apps/dev/src/lib/readings.ts, and there is no REST or MCP write path.
--
-- Append-only. The newest row per subject and measure is the current reading. A trigger refuses
-- UPDATE so a row cannot be edited after the fact; deletes are left open so deleting the subject
-- object or the workspace still cascades. source_ref is the source's own id for the reading (an
-- invoice id, a poll slot), and the unique index on it makes a repeated write add no second row.
--
-- New, empty table, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is
-- fine and there is nothing to backfill. Row-level security is switched on because
-- 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0150_readings_down.sql.

CREATE TABLE IF NOT EXISTS "readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"subject_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"measure" text NOT NULL,
	"value" double precision NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "readings_measure_check" CHECK ("measure" ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
	CONSTRAINT "readings_value_check" CHECK ("value" <> 'NaN'::double precision)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "readings_dedupe_idx"
	ON "readings" USING btree ("subject_id", "measure", "source", "source_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "readings_latest_idx"
	ON "readings" USING btree ("subject_id", "measure", "read_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "readings_workspace_idx"
	ON "readings" USING btree ("workspace_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION readings_refuse_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'readings are append-only: a reading cannot be edited';
END $$;
--> statement-breakpoint
CREATE TRIGGER "readings_no_update"
	BEFORE UPDATE ON "readings"
	FOR EACH ROW EXECUTE FUNCTION readings_refuse_update();
--> statement-breakpoint
ALTER TABLE "readings" ENABLE ROW LEVEL SECURITY;
