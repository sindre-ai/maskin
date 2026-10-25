-- Voice sessions: running counters written as the call goes.
--
-- Turn count, tool call count and audio milliseconds used to live only in server memory, so a
-- restart or deploy mid-call ended the call with zeroes and its cost fell back to the figure the
-- phone reports. The server now adds to these columns on each completed turn and each tool call.
-- Existing rows get 0, which endVoiceSession treats as "nothing recorded" (it then uses the
-- client report, as before). Constant defaults, so no table rewrite.
-- Down: drizzle/down/0109_voice_sessions_live_counters_down.sql.

ALTER TABLE "voice_sessions"
	ADD COLUMN IF NOT EXISTS "input_audio_ms" integer NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS "output_audio_ms" integer NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS "turn_count" integer NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS "tool_calls_count" integer NOT NULL DEFAULT 0;
