-- T7 of bet/loop-lifecycle-status-ladder: supervised-loop output approval
-- queue. A loop at `objects.status = 'supervised'` must hold each run's
-- output for human sign-off before delivery — without this table, supervised
-- and live behave identically from the recipient's perspective.
--
-- One row per held output. `payload` carries the delivery-shaped blob the
-- caller wanted to hand off; `edited_payload` is populated when the human
-- edits before approving (a labelled correction). `driver_actor_id` is the
-- agent that produced the output — captured so the reject/correction event
-- can be routed back as a training signal without another lookup.
--
-- Task 4 owns the "when to enqueue" gate off `objects.status = 'supervised'`
-- in the delivery path. Task 8 renders the queue and the pending count.
-- Neither concern lives here.
--
-- `status` is a CHECK-constrained text field (`pending` | `approved` |
-- `rejected`) rather than a Postgres enum — every other status field in this
-- schema uses text + a check/allowlist for the same reason: enum ALTER
-- statements need exclusive locks that break hot-path writes, and text is
-- how the ORM already round-trips.
--
-- Indexes:
--   - (workspace_id, loop_id, status) — hot path for the pending-count
--     aggregation the loops list endpoint reads on every render.
--   - (workspace_id, status, created_at DESC) — queue listing sorted newest
--     first, filtered to pending by default.
--
-- FKs:
--   - workspace_id → workspaces cascades on delete (workspace deletion
--     already cascades every dependent row across the schema).
--   - loop_id → objects cascades so archiving/deleting a loop clears its
--     pending queue instead of leaving orphaned rows.
--   - session_id → sessions set null so a session cleanup doesn't drop the
--     historical record of what the human decided.
--   - driver_actor_id → actors set null for the same reason — the row's
--     audit value survives an agent deletion.
--   - decided_by → actors set null for the same reason.

CREATE TABLE IF NOT EXISTS "loop_output_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"loop_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
	"driver_actor_id" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"payload" jsonb NOT NULL,
	"edited_payload" jsonb,
	"correction_note" text,
	"decided_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "loop_output_approvals_status_check"
		CHECK ("status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "loop_output_approvals_ws_loop_status_idx"
	ON "loop_output_approvals" ("workspace_id", "loop_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "loop_output_approvals_ws_status_created_idx"
	ON "loop_output_approvals" ("workspace_id", "status", "created_at" DESC);
--> statement-breakpoint

-- Idempotency guard: a session can produce at most one pending approval row
-- per loop. The partial index (WHERE session_id IS NOT NULL) avoids false
-- uniqueness collisions for manually-enqueued rows that carry no session.
CREATE UNIQUE INDEX IF NOT EXISTS "loop_output_approvals_loop_session_uniq"
	ON "loop_output_approvals" ("loop_id", "session_id")
	WHERE "session_id" IS NOT NULL;
