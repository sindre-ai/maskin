-- Google Meet — create_space idempotency ledger. Task 4 of the "Google Meet
-- MCP" bet — Meet's spaces.create endpoint does NOT accept a client-side
-- idempotency key (unlike calendar.events.insert, which does via
-- conferenceData.createRequest.requestId — the create_meet_backed_event path
-- uses Google-native replay and does NOT touch this table).
--
-- Default key derives to sha256(actor_id + purpose_normalised + YYYY-MM-DD)
-- so an agent that retries within a day gets the cached space back; callers
-- that need tighter or looser dedupe pass their own key. The composite unique
-- index (workspace_id, idempotency_key) is what makes the replay contract
-- hold — a second insert with the same key races, loses on the constraint,
-- and the tool reads back the winner's space_name.

CREATE TABLE IF NOT EXISTS "google_meet_space_idempotency" (
	"id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"space_name" text NOT NULL,
	"meeting_code" text NOT NULL,
	"meeting_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_meet_space_idempotency_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_meet_space_idempotency_workspace_key_uniq"
	ON "google_meet_space_idempotency" ("workspace_id", "idempotency_key");

CREATE INDEX IF NOT EXISTS "google_meet_space_idempotency_created_at_idx"
	ON "google_meet_space_idempotency" ("created_at");
