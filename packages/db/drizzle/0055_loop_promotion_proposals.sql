-- T5 of bet/loop-lifecycle-status-ladder: rung-graduation proposals surface.
-- When a loop's performance score climbs past the current rung's threshold, the
-- driver agent creates a row here — auto-applied for `promotion_mode = 'auto'`
-- (transient, resolved in the same transaction the row is inserted) and held
-- pending for `promotion_mode = 'human_approved'` until a human decides
-- inline. The demotion path does NOT enqueue proposals — demotion is automatic
-- and lands directly on `objects.status`; only PROMOTION needs a human
-- surface, per the bet's "demotion is automatic, no approval needed".
--
-- Fields:
--   payload — the {score, threshold, mode} snapshot the driver used to
--     propose. Kept so the human sees WHY the proposal exists at approve
--     time, even if the score has since drifted.
--   decidedBy / decidedAt — audit stamp of who resolved the row and when.
--   reason — free-text note captured on reject (why we should not advance).
--
-- Indexes:
--   (workspace_id, loop_id, status) — hot path for "does this loop have an
--     open proposal?" reads on the loop detail page.
--   (workspace_id, status, created_at DESC) — pending-queue listing, newest
--     first, so the promotion card in the For You feed renders in one query.
--   Partial UNIQUE on (loop_id) WHERE status = 'pending' — the concurrency
--     guarantee: two runs of the evaluator racing to enqueue a proposal for
--     the same loop can't stack duplicate pending rows; the loser gets a
--     unique-violation the service layer can catch and re-read.
--
-- FKs (mirror T7's approvals table — same reasoning per column):
--   workspace_id → workspaces ON DELETE CASCADE (workspace deletion sweeps
--     dependent rows across the schema).
--   loop_id → objects ON DELETE CASCADE (dropping a loop clears its queue).
--   decided_by → actors ON DELETE SET NULL (row's audit value survives an
--     actor deletion).
--   proposed_by → actors ON DELETE SET NULL (same reason).

CREATE TABLE IF NOT EXISTS "loop_promotion_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"loop_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"payload" jsonb NOT NULL,
	"reason" text,
	"proposed_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"decided_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "loop_promotion_proposals_status_check"
		CHECK ("status" IN ('pending', 'approved', 'rejected', 'deferred'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "loop_promotion_proposals_ws_loop_status_idx"
	ON "loop_promotion_proposals" ("workspace_id", "loop_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "loop_promotion_proposals_ws_status_created_idx"
	ON "loop_promotion_proposals" ("workspace_id", "status", "created_at" DESC);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "loop_promotion_proposals_loop_pending_uniq"
	ON "loop_promotion_proposals" ("loop_id")
	WHERE "status" = 'pending';
