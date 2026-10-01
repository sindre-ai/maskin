-- Idempotency table — S2 of the trigger-engine fix bet (bet/f46b18f7-trigger-engine).
--
-- Ships UNCONDITIONAL — NOT gated by trigger_engine_v2. Load-bearing during
-- kill-switch (tech spec §3.4 + §7.3): if this table sat behind the flag,
-- flipping FF_WORKSPACE_FEATURES to empty at any rollback step would re-open
-- the blue-green double-fire window this table exists to prevent. Ships in
-- slice S2 before any v2 surface goes behind the gate.
--
-- Every dispatch INSERTs (trigger_id, event_id) with ON CONFLICT DO NOTHING
-- before calling sessionManager.createSession(). If two trigger-runner
-- instances (blue+green during a rolling deploy, or future horizontal scale)
-- race on the same (trigger, event), exactly one INSERT claims — the other's
-- returning() comes back empty and skips the dispatch.
--
-- Not on the hot-table list: writes are one per fired dispatch (order of
-- hundreds/hour per workspace), not per external request. session_id is
-- diagnostic only — see tech spec §6.4 for the edge where the follow-up
-- UPDATE fails; the row's presence is the guarantee, not session_id.

CREATE TABLE IF NOT EXISTS "trigger_dispatches" (
	"trigger_id" uuid NOT NULL,
	"event_id" bigint NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid,
	CONSTRAINT "trigger_dispatches_trigger_id_event_id_pk"
		PRIMARY KEY ("trigger_id", "event_id"),
	CONSTRAINT "trigger_dispatches_trigger_id_triggers_id_fk"
		FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trigger_dispatches_dispatched_at_idx"
	ON "trigger_dispatches" ("dispatched_at");
