-- Idempotency ledger for the `orphan_thread_detected` analytics signal
-- fired by apps/dev/src/services/orphan-thread-detector.ts. The detector
-- scans root @-mention comments on an interval; the UNIQUE constraint on
-- `root_comment_event_id` is the primitive that keeps overlapping ticks
-- from double-firing the PostHog event for the same thread. The ledger
-- row is written even when the PostHog capture is skipped/failing so a
-- decided thread is never re-scanned. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "orphan_thread_detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"object_id" uuid NOT NULL,
	"root_comment_event_id" bigint NOT NULL,
	"expected_reply_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"hours_without_reply" numeric(10, 2) NOT NULL,
	"thread_kind" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "orphan_thread_detections_root_comment_event_id_uniq"
		UNIQUE ("root_comment_event_id"),
	CONSTRAINT "orphan_thread_detections_thread_kind_check"
		CHECK ("thread_kind" IN ('decision_required', 'question', 'flag'))
);

CREATE INDEX IF NOT EXISTS "orphan_thread_detections_detected_at_idx"
	ON "orphan_thread_detections" ("detected_at");
