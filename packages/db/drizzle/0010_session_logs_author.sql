-- Multiplayer session theater: record the human/agent who posted a user_message row.
-- Previously we string-prefixed the content with "[from <uuid>] …", which was both
-- spoofable (arbitrary user input could impersonate another actor in the UI) and awkward
-- to parse. Promote it to a proper FK column. NULL for stdout/stderr/system rows.

ALTER TABLE "session_logs"
	ADD COLUMN IF NOT EXISTS "author_actor_id" uuid REFERENCES "actors"("id") ON DELETE SET NULL;
