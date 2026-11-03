-- Event queue with hold-and-replay — S3 of the trigger-engine fix bet
-- (bet/f46b18f7-trigger-engine). Fixes bet #6 (events dropped instead of
-- queued): an event whose trigger is cooling down, or whose workspace is
-- suppressed, is parked here and replayed when the window lifts.
--
-- Expand-only: one new table, nothing else touched, nothing reads it until the
-- trigger-runner enqueues — and enqueue/replay sit behind trigger_engine_v2.
-- Safe for every user with the flag off: the table just stays empty.
--
-- trigger_id is nullable — a workspace-suppression drop is one row per
-- (workspace, event), fanned out per trigger when the drain re-runs the
-- matcher. event_snapshot carries the PgEvent so replay needs nothing else.
--
-- Not on the hot-table list: writes happen only when an event is DROPPED today
-- (a cooling trigger or a suppressed workspace), not per external request, and
-- the table is new so the plain CREATE INDEX below locks nothing.

CREATE TABLE IF NOT EXISTS "trigger_event_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"trigger_id" uuid,
	"event_id" bigint NOT NULL,
	"event_snapshot" jsonb NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replay_after" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"replayed_at" timestamp with time zone,
	CONSTRAINT "trigger_event_queue_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
	CONSTRAINT "trigger_event_queue_trigger_id_triggers_id_fk"
		FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queue_pending_by_replay_after_idx"
	ON "trigger_event_queue" ("replay_after")
	WHERE "replayed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queue_pending_by_trigger_idx"
	ON "trigger_event_queue" ("trigger_id", "event_id")
	WHERE "replayed_at" IS NULL AND "trigger_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queue_pending_by_workspace_idx"
	ON "trigger_event_queue" ("workspace_id", "event_id")
	WHERE "replayed_at" IS NULL;
